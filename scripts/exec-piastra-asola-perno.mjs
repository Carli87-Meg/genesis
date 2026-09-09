/**
 * Re-execute COM dal interpret.json chat UI.
 * Asola era due cerchi pieni; perno era vite: payload sanificato oblungo + Ø10×20.
 */
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const OUT = path.join("sw-out", "chat-piastra-asola-perno")
const GAP = 5000

const plateOps = [
  { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "rectangle", cx: 0, cy: 0, width: 100, height: 50 }] },
  { id: "e1", type: "extrude", sketch: "s1", depth: 8 },
  {
    id: "s2",
    type: "sketch",
    plane: "Top",
    contours: [
      { kind: "line", x1: -15, y1: 5, x2: 15, y2: 5 },
      { kind: "arc", x1: 15, y1: 5, x2: 15, y2: -5, x3: 20, y3: 0 },
      { kind: "line", x1: 15, y1: -5, x2: -15, y2: -5 },
      { kind: "arc", x1: -15, y1: -5, x2: -15, y2: 5, x3: -20, y3: 0 },
    ],
  },
  { id: "c1", type: "cut", sketch: "s2", throughAll: true },
]
const pinOps = [
  { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 10 }] },
  { id: "e1", type: "extrude", sketch: "s1", depth: 20 },
]

const src = JSON.parse(fs.readFileSync(path.join(OUT, "interpret.json"), "utf8"))
const job = src.job
const plate = job.find((d) => d.document?.type === "part" && /piastra|asola/i.test(d.document.name))
const pin = job.find((d) => d.document?.type === "part" && d !== plate)
const asm = job.find((d) => d.document?.type === "assembly")
const drawing = job.find((d) => d.document?.type === "drawing")
if (!plate || !pin || !asm || !drawing) throw new Error("job incompleto")

plate.operations = plateOps
pin.operations = pinOps
const plateName = plate.document.name
const pinName = pin.document.name
const asmName = asm.document.name
plate.document.savePath = `CAD/${plateName}.SLDPRT`
plate.document.snapshotPath = `Export/${plateName}.jpg`
pin.document.savePath = `CAD/${pinName}.SLDPRT`
pin.document.snapshotPath = `Export/${pinName}.jpg`
asm.document.savePath = `CAD/${asmName}.SLDASM`
asm.operations = [
  { id: "comp-pl", type: "component", path: `CAD/${plateName}.SLDPRT`, x: 0, y: 0, z: 0, fix: true },
  { id: "comp-pn", type: "component", path: `CAD/${pinName}.SLDPRT`, x: 0, y: -6, z: 0 },
  {
    id: "m-coin",
    type: "mate",
    mateType: "coincident",
    component1: "comp-pn",
    component2: "comp-pl",
    entity1: "top",
    entity2: "top",
  },
  {
    id: "m-front",
    type: "mate",
    mateType: "coincident",
    component1: "comp-pn",
    component2: "comp-pl",
    entity1: "front",
    entity2: "front",
  },
  {
    id: "m-right",
    type: "mate",
    mateType: "coincident",
    component1: "comp-pn",
    component2: "comp-pl",
    entity1: "right",
    entity2: "right",
  },
  {
    id: "m-conc",
    type: "mate",
    mateType: "concentric",
    component1: "comp-pn",
    component2: "comp-pl",
    entity1: "outer",
    entity2: "inner",
    diameter: 10,
  },
  { id: "v-auto", type: "verify" },
]
drawing.document.sheetFormat = drawing.document.sheetFormat || "A3"
for (const op of drawing.operations || []) {
  if (op.type === "standardViews" || op.type === "drawingView") op.model = `CAD/${asmName}.SLDASM`
}

const allDocs = [plate, pin, asm, drawing]
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

const outName = process.argv.includes("--asm-only") ? "execute-asm.json" : "execute.json"
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
  console.log("ok", json.ok, "steps", json.steps?.length, "fail", failed.map((s) => `${s.op}:${s.detail}`).join(" | ") || "-")
  const verify = json.steps?.find((s) => s.op === "verify")
  if (verify) console.log("verify", verify.ok, verify.detail)
  const sheet = json.steps?.find((s) => /SetupSheet/i.test(s.op || ""))
  if (sheet) console.log("sheet", sheet.ok, sheet.detail)
  if (!json.ok) {
    fs.writeFileSync(path.join(OUT, outName), JSON.stringify(results, null, 2))
    throw new Error(`execute fail ${doc.document.name}: ${json.error}`)
  }
  if (i < docs.length - 1) await new Promise((r) => setTimeout(r, GAP))
}

fs.writeFileSync(path.join(OUT, outName), JSON.stringify(results, null, 2))
console.log("EXECUTE_OK")
