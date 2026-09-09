/**
 * COM execute only from the existing telaio-U interpret job (no second Playwright).
 */
import fs from "node:fs"
import path from "node:path"

const BRIDGE = process.env.SOLIDWORKS_BRIDGE_URL || "http://127.0.0.1:47821"
const GAP_MS = Number(process.env.COM_EXECUTE_GAP_MS || 5000)
const ROOT = process.cwd()
const OUT = path.join(ROOT, "sw-out", "chat-telaio-u")
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

function summarize(json) {
  const steps = json.steps || []
  const failed = steps.filter((s) => s.ok === false)
  const verify = steps.filter((s) => s.op === "verify")
  const mates = steps.filter((s) => /AddMate5|selectFace/i.test(s.op || ""))
  const bbox = steps.filter((s) => s.op === "bbox").slice(-6)
  return {
    ok: json.ok,
    doc: json.document,
    saved: json.savedPath,
    failed: failed.map((s) => `${s.op}: ${s.detail}`),
    verify: verify.map((s) => s.detail),
    mates: mates.filter((s) => s.op === "AddMate5").map((s) => `${s.ok} ${s.detail}`),
    bbox: bbox.map((s) => s.detail),
  }
}

function seedUprights(payload) {
  const clone = JSON.parse(JSON.stringify(payload))
  let n = 0
  for (const op of clone.operations || []) {
    if (op.type === "component" && /MontanteU/i.test(String(op.path || ""))) {
      op.x = n === 0 ? -46 : 46
      op.y = 10
      op.z = 0
      n++
    }
    if (op.type === "mate") {
      const kind = String(op.mateType || op.subtype || op.kind || "").toLowerCase()
      const e1 = String(op.entity1 || "").toLowerCase()
      const e2 = String(op.entity2 || "").toLowerCase()
      if (kind === "coincident" && (e1 === "front" || e2 === "front" || e1 === "xmin" || e2 === "xmin")) {
        op._drop = true
      }
    }
  }
  clone.operations = (clone.operations || []).filter((op) => !op._drop)
  for (const op of clone.operations) delete op._drop
  return clone
}

const files = [
  path.join(CAD, "CAD", "AssiemeTelaioU.SLDASM"),
  path.join(CAD, "Disegni", "TavolaTelaioU.SLDDRW"),
]

const job = (interpret.job || []).map((d, i) => (i === 2 ? seedUprights(d) : d))
if (job.length !== 4) throw new Error(`job length ${job.length}`)

console.log("cleanup…")
const cleanup = await post("/cleanup", { keep: "" }, 60000)
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
for (const i of [2, 3]) {
  const name = job[i].document?.name
  console.log(`\n=== execute ${name} ===`)
  const started = Date.now()
  const { status, json } = await post("/execute", job[i], name?.startsWith("Tavola") ? 240000 : 180000)
  const sum = summarize(json)
  console.log(JSON.stringify({ status, ms: Date.now() - started, ...sum }, null, 2))
  fs.writeFileSync(path.join(OUT, `result-fix-${name}.json`), JSON.stringify(json, null, 2))
  results.push({ name, ...sum })
  const fatal = sum.failed.some((d) => /verify|NewDocument|OpenDocument/i.test(d))
  if (json.ok === false && fatal) {
    process.exitCode = 2
    break
  }
  await sleep(GAP_MS)
}

fs.writeFileSync(path.join(OUT, "com-execute-summary.json"), JSON.stringify(results, null, 2))
const verifyLine = (results.find((r) => /Assieme/i.test(r.name || ""))?.verify || []).join(" | ")
console.log("\nVERIFY", verifyLine)
if (!/seated=True/i.test(verifyLine) || !/coincident\+perpendicular\+seated/i.test(verifyLine) || /shortEndWalls=0|shortEndWalls=1\b/.test(verifyLine)) {
  process.exitCode = 2
  console.error("telaio U non seduto sui lati corti")
}
