/**
 * Re-execute COM dal interpret.json già ottenuto in chat UI.
 * L'albero era una vite in revolve: payload sanificato Ø16×80 + smusso 1 allEdges.
 */
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const OUT = path.join("sw-out", "chat-albero-smussi-estremi")
const GAP = 5000

const shaftOps = [
  { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 16 }] },
  { id: "e1", type: "extrude", sketch: "s1", depth: 80 },
  { id: "ch1", type: "chamfer", distance: 1, allEdges: true },
]
const plateOps = [
  { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "rectangle", cx: 0, cy: 0, width: 50, height: 40 }] },
  { id: "e1", type: "extrude", sketch: "s1", depth: 6 },
  { id: "s2", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 16 }] },
  { id: "c1", type: "cut", sketch: "s2", throughAll: true },
]

const src = JSON.parse(fs.readFileSync(path.join(OUT, "interpret.json"), "utf8"))
const job = src.job
const shaft = job.find((d) => d.document?.type === "part" && /albero/i.test(d.document.name))
const plate = job.find((d) => d.document?.type === "part" && d !== shaft)
const asm = job.find((d) => d.document?.type === "assembly")
const drawing = job.find((d) => d.document?.type === "drawing")
if (!shaft || !plate || !asm || !drawing) throw new Error("job incompleto")

shaft.operations = shaftOps
plate.operations = plateOps
const shaftName = shaft.document.name
const plateName = plate.document.name
const asmName = asm.document.name
shaft.document.savePath = `CAD/${shaftName}.SLDPRT`
shaft.document.snapshotPath = `Export/${shaftName}.jpg`
plate.document.savePath = `CAD/${plateName}.SLDPRT`
plate.document.snapshotPath = `Export/${plateName}.jpg`
asm.document.savePath = `CAD/${asmName}.SLDASM`
asm.operations = [
  { id: "comp-pl", type: "component", path: `CAD/${plateName}.SLDPRT`, x: 0, y: 0, z: 0, fix: true },
  { id: "comp-sh", type: "component", path: `CAD/${shaftName}.SLDPRT`, x: 0, y: 37, z: 0 },
  {
    id: "m-coin",
    type: "mate",
    mateType: "coincident",
    component1: "comp-sh",
    component2: "comp-pl",
    entity1: "bottom",
    entity2: "bottom",
  },
  {
    id: "m-conc",
    type: "mate",
    mateType: "concentric",
    component1: "comp-sh",
    component2: "comp-pl",
    entity1: "outer",
    entity2: "inner",
    diameter: 16,
  },
  { id: "v-auto", type: "verify" },
]
drawing.document.sheetFormat = drawing.document.sheetFormat || "A3"
for (const op of drawing.operations || []) {
  if (op.type === "standardViews" || op.type === "drawingView") op.model = `CAD/${asmName}.SLDASM`
}

const allDocs = [shaft, plate, asm, drawing]
const docs = process.argv.includes("--asm-only") ? [asm, drawing] : allDocs
fs.writeFileSync(path.join(OUT, "interpret-sanitized.json"), JSON.stringify({ ...src, job: allDocs }, null, 2))

const cleanup = await fetch(`${APP}/api/solidworks`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "cleanup", keep: "" }),
})
const cleanupJson = await cleanup.json()
console.log("cleanup", cleanupJson.ok, cleanupJson.steps?.[0]?.detail)
await new Promise((r) => setTimeout(r, 8000))

const results = []
for (let i = 0; i < docs.length; i++) {
  const doc = docs[i]
  console.log(`execute ${i + 1}/${docs.length}`, doc.document.name)
  const res = await fetch(`${APP}/api/solidworks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: doc }),
  })
  const json = await res.json()
  results.push(json)
  const failed = json.steps?.filter((s) => s.ok === false) || []
  console.log("ok", json.ok, "steps", json.steps?.length, "fail", failed.map((s) => s.op).join(",") || "-")
  const verify = json.steps?.find((s) => s.op === "verify")
  if (verify) console.log("verify", verify.ok, verify.detail)
  const chamfer = json.steps?.filter((s) => /chamfer/i.test(s.op || ""))
  for (const s of chamfer) console.log("chamfer", s.ok, s.detail)
  const sheet = json.steps?.find((s) => /SetupSheet/i.test(s.op || ""))
  if (sheet) console.log("sheet", sheet.ok, sheet.detail)
  if (!json.ok) {
    fs.writeFileSync(path.join(OUT, process.argv.includes("--asm-only") ? "execute-asm.json" : "execute.json"), JSON.stringify(results, null, 2))
    throw new Error(`execute fail ${doc.document.name}: ${json.error}`)
  }
  if (i < docs.length - 1) await new Promise((r) => setTimeout(r, GAP))
}

fs.writeFileSync(path.join(OUT, process.argv.includes("--asm-only") ? "execute-asm.json" : "execute.json"), JSON.stringify(results, null, 2))
console.log("EXECUTE_OK")
