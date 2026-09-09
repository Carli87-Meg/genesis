/**
 * Execute COM only from the existing interpret job (no chat / Playwright).
 * Injects align=anti on pad/top coincident so the annulus sits on the plate.
 */
import fs from "node:fs"
import path from "node:path"

const BRIDGE = process.env.SOLIDWORKS_BRIDGE_URL || "http://127.0.0.1:47821"
const GAP_MS = Number(process.env.COM_EXECUTE_GAP_MS || 5000)
const ROOT = process.cwd()
const OUT = path.join(ROOT, "sw-out", "chat-albero-spalla")
const CAD = process.env.SOLIDWORKS_OUT_DIR ||
  "C:\\Users\\Carli\\.ARCHIVIO\\CADTM_BUSINESS\\00_PROGETTI_3D\\01_Progetti_Attivi\\SolidworksIA"
const interpret = JSON.parse(fs.readFileSync(path.join(OUT, "interpret.json"), "utf8"))

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function post(urlPath, body, timeoutMs = 180000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${BRIDGE}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = { ok: false, error: text.slice(0, 800) }
    }
    return { status: res.status, json }
  } finally {
    clearTimeout(t)
  }
}

function injectAlign(payload) {
  const clone = JSON.parse(JSON.stringify(payload))
  for (const op of clone.operations || []) {
    const kind = String(op.mateType || op.subtype || op.kind || "").toLowerCase()
    const e1 = String(op.entity1 || "").toLowerCase()
    const e2 = String(op.entity2 || "").toLowerCase()
    if (kind === "coincident" && (e1 === "pad" || e1 === "boss" || e2 === "pad" || e2 === "boss")) {
      op.align = "anti"
    }
  }
  return clone
}

function summarize(json) {
  const steps = json.steps || []
  const failed = steps.filter((s) => s.ok === false)
  const verify = steps.filter((s) => s.op === "verify")
  const mates = steps.filter((s) => /AddMate5|selectFace|selectCyl/i.test(s.op || ""))
  return {
    ok: json.ok,
    doc: json.document,
    saved: json.savedPath,
    failed: failed.map((s) => `${s.op}: ${s.detail}`),
    verify: verify.map((s) => s.detail),
    mates: mates.map((s) => `${s.op} ${s.ok} ${s.detail}`),
    closeExtra: steps.filter((s) => /documenti extra/i.test(s.detail || "")).map((s) => s.detail),
    editSketch: steps.filter((s) => /schizzo ancora attivo/i.test(s.detail || "")).map((s) => s.detail),
  }
}

const files = [
  path.join(CAD, "CAD", "AlberoSpallamento10.SLDPRT"),
  path.join(CAD, "CAD", "PiastraForo10.SLDPRT"),
  path.join(CAD, "CAD", "AssiemeAlberoPiastra.SLDASM"),
  path.join(CAD, "Disegni", "TavolaAlberoPiastra.SLDDRW"),
]

const job = (interpret.job || []).map(injectAlign)
if (job.length !== 4) {
  throw new Error(`job length ${job.length}, attesi 4 documenti`)
}

console.log("cleanup…")
const cleanup = await post("/cleanup", { keep: "" }, 60000)
fs.writeFileSync(path.join(OUT, "cleanup.json"), JSON.stringify(cleanup.json, null, 2))
console.log("cleanup", cleanup.status, cleanup.json?.ok, cleanup.json?.steps?.[0]?.detail)
await sleep(1500)

for (const f of files) {
  try {
    fs.unlinkSync(f)
    console.log("deleted", f)
  } catch (e) {
    if (e.code !== "ENOENT") console.log("keep", f, e.message)
  }
}

const results = []
for (let i = 0; i < job.length; i++) {
  const name = job[i].document?.name
  const payload = job[i]
  fs.writeFileSync(path.join(OUT, `exec-${i + 1}-${name}.json`), JSON.stringify(payload, null, 2))
  console.log(`\n=== execute ${i + 1}/4 ${name} ===`)
  const started = Date.now()
  const { status, json } = await post("/execute", payload, name?.startsWith("Tavola") ? 240000 : 180000)
  const ms = Date.now() - started
  const sum = summarize(json)
  console.log(JSON.stringify({ status, ms, ...sum }, null, 2))
  fs.writeFileSync(path.join(OUT, `result-${i + 1}-${name}.json`), JSON.stringify(json, null, 2))
  results.push({ name, status, ms, ...sum, rawOk: json.ok })
  const fatal = sum.failed.some((d) => /AddMate5|verify|NewDocument|OpenDocument|Selezione fallita/i.test(d))
  if (json.ok === false && fatal) {
    console.error("STOP: step fatale")
    break
  }
  if (i < job.length - 1) {
    console.log(`gap ${GAP_MS} ms`)
    await sleep(GAP_MS)
  }
}

fs.writeFileSync(path.join(OUT, "com-execute-summary.json"), JSON.stringify(results, null, 2))
const assy = results.find((r) => /Assieme/i.test(r.name || ""))
const verifyLine = (assy?.verify || []).join(" | ")
console.log("\nVERIFY", verifyLine)
if (!/seated=True/i.test(verifyLine) || !/concentric\+seated/i.test(verifyLine)) {
  process.exitCode = 2
  console.error("mate non seduto sullo spallamento")
}
