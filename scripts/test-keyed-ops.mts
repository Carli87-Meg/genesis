import { interpretFromLlmText } from "../src/lib/llm-payload"

const keyed = {
  summary: "Staffa a L con boccola e tavola",
  payload: {
    schemaVersion: 2,
    units: "mm",
    document: { type: "part", name: "StaffaFissaggio" },
    operations: [
      { sketch: { plane: "Top", contours: [{ kind: "rectangle", width: 80, height: 50 }] } },
      { extrude: { depth: 8, merge: true } },
      { sketch: { plane: "Top", contours: [{ kind: "rectangle", width: 80, height: 8, cy: 21 }] } },
      { extrude: { depth: 40, merge: true } },
      { sketch: { plane: "Top", contours: [{ kind: "circle", diameter: 16 }] } },
      { extrude: { depth: 14, merge: true } },
      {
        sketch: {
          plane: "Top",
          contours: [
            { kind: "circle", diameter: 6.5, cx: 0, cy: 0, centerX: 10, centerY: 10 },
            { kind: "circle", diameter: 6.5, position: { x: 70, y: 10 } },
            { kind: "circle", diameter: 6.5, position: { x: 10, y: 40 } },
            { kind: "circle", diameter: 6.5, position: { x: 70, y: 40 } },
            { kind: "circle", diameter: 10.2 },
          ],
        },
      },
      { cut: { throughAll: true } },
    ],
  },
  job: [
    {
      document: { type: "part", name: "BoccolaGuida" },
      operations: [
        {
          sketch: {
            plane: "Top",
            contours: [
              { kind: "circle", diameter: 16 },
              { kind: "circle", diameter: 10.2 },
            ],
          },
        },
        { extrude: { depth: 12 } },
      ],
    },
    {
      payload: {
        document: { type: "assembly", name: "AssiemeStaffa" },
        operations: [
          { component: { name: "StaffaFissaggio", path: "CAD/StaffaFissaggio.SLDPRT", fix: true } },
          { component: { name: "BoccolaGuida", path: "CAD/BoccolaGuida.SLDPRT" } },
          { mate: { mateType: "concentric", component1: "c2", component2: "c1" } },
        ],
      },
    },
    {
      document: { type: "drawing", name: "TavolaStaffa", sheetFormat: "A3" },
      operations: [
        { sheetFormat: { format: "A3" } },
        { standardViews: { modelPath: "CAD/AssiemeStaffa.SLDASM", includeIso: true, firstAngle: true } },
      ],
    },
  ],
}

const { result, meta } = interpretFromLlmText(JSON.stringify(keyed), "test")
const types = result.operations.map((o) => o.type)
const jobTypes = (result.job ?? []).map((d) => d.document.type)
if (result.source !== "openrouter") throw new Error("source")
if (types[0] !== "sketch" || !types.includes("cut") || !types.includes("component")) {
  throw new Error("types " + types.join(","))
}
if (!result.payload.operations.some((o) => o.type === "extrude" && o.sketch)) {
  throw new Error("missing sketch link")
}
const holes = result.payload.operations
  .filter((o) => o.type === "sketch")
  .flatMap((o) => o.contours)
  .filter((c) => c.kind === "circle" && Math.abs(c.diameter - 6.5) < 1e-6)
const hole = holes[0]
if (!hole || hole.kind !== "circle") throw new Error("missing Ø6.5")
if (Math.abs(hole.cx + 30) > 0.6 || Math.abs(hole.cy + 15) > 0.6) {
  throw new Error(`centerX/reframe atteso -30,-15, got ${hole.cx},${hole.cy}`)
}
  if ((result.job ?? []).length < 3) throw new Error("job " + jobTypes.join(","))
  const views = result.job?.find((d) => d.document.type === "drawing")?.operations.find((o) => o.type === "standardViews")
  if (views && views.type === "standardViews" && !views.model) {
    throw new Error("drawing model missing")
  }
console.log(
  JSON.stringify({
    ok: true,
    parse: meta.parse,
    dropped: meta.droppedOps,
    opCount: result.operations.length,
    types,
    job: jobTypes,
    payloadName: result.payload.document.name,
  }),
)
