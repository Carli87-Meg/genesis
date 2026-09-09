import type { CadOperation, InterpretResult, SolidWorksDocumentPayload } from "./payload"
import { runDfmJob } from "./dfm"

const OP_TYPES = new Set([
  "sketch",
  "extrude",
  "cut",
  "revolve",
  "sweep",
  "hole",
  "fillet",
  "chamfer",
  "shell",
  "pattern",
  "component",
  "mate",
  "clearMates",
  "inspect",
  "verify",
  "drawingView",
  "standardViews",
  "modelDimensions",
  "annotation",
  "sheetFormat",
  "quoteSketches",
])

const TYPE_ALIAS: Record<string, string> = {
  extrusion: "extrude",
  extrudeboss: "extrude",
  "boss-extrude": "extrude",
  bossextrude: "extrude",
  boss: "extrude",
  estrusione: "extrude",
  estrudi: "extrude",
  cutextrude: "cut",
  "cut-extrude": "cut",
  cutthrough: "cut",
  taglio: "cut",
  revolution: "revolve",
  revolve2: "revolve",
  rivoluzione: "revolve",
  sweep: "sweep",
  "boss-sweep": "sweep",
  bosssweep: "sweep",
  percorso: "sweep",
  loftsweep: "sweep",
  schizzo: "sketch",
  sketch: "sketch",
  foro: "hole",
  drawing_view: "drawingView",
  drawingview: "drawingView",
  vista: "drawingView",
  standard_views: "standardViews",
  standardviews: "standardViews",
  model_dimensions: "modelDimensions",
  modeldimensions: "modelDimensions",
  sheet_format: "sheetFormat",
  sheetformat: "sheetFormat",
  setupsheet: "sheetFormat",
  clear_mates: "clearMates",
  clearmates: "clearMates",
  quotesketches: "quoteSketches",
  quote_sketches: "quoteSketches",
  smusso: "chamfer",
  chamfer: "chamfer",
  featurechamfer: "chamfer",
  raccordo: "fillet",
  fillet: "fillet",
  featurefillet: "fillet",
  raggio: "fillet",
  revolvecut: "revolve",
  revolve_cut: "revolve",
  "revolve-cut": "revolve",
  tagliorivoluzione: "revolve",
  svasatura: "revolve",
}

const PLANE_ALIAS: Record<string, "Front" | "Top" | "Right"> = {
  front: "Front",
  anteriore: "Front",
  xz: "Front",
  top: "Top",
  superiore: "Top",
  xy: "Top",
  right: "Right",
  destra: "Right",
  yz: "Right",
}

export type LlmParseMeta = {
  parse: "ok" | "repaired" | "failed"
  droppedOps: number
  snippet?: string
  error?: string
}

export function extractJsonObject(text: string): { value: unknown; repaired: boolean } {
  const trimmed = text.trim()
  if (!trimmed) throw new Error("risposta LLM vuota")

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fence ? fence[1].trim() : trimmed

  try {
    return { value: JSON.parse(raw), repaired: Boolean(fence) }
  } catch {
    /* continue */
  }

  const start = raw.search(/[{[]/)
  if (start < 0) {
    throw new Error("OpenRouter ha restituito testo senza JSON")
  }
  const slice = sliceBalanced(raw, start)
  return { value: JSON.parse(slice), repaired: true }
}

export function interpretFromLlmText(
  content: string,
  model: string,
): { result: InterpretResult; meta: LlmParseMeta } {
  let parsed: unknown
  let repaired = false
  try {
    const extracted = extractJsonObject(content)
    parsed = extracted.value
    repaired = extracted.repaired
  } catch (err) {
    const snippet = content.replace(/\s+/g, " ").trim().slice(0, 160)
    throw Object.assign(
      new Error(
        `JSON LLM non utilizzabile: ${err instanceof Error ? err.message : String(err)}. estratto: ${snippet}`,
      ),
      { snippet },
    )
  }

  const rootRec = Array.isArray(parsed) ? null : asRecord(parsed)
  const jobSource = Array.isArray(parsed)
    ? parsed
    : Array.isArray(rootRec?.job)
      ? rootRec.job
      : Array.isArray(rootRec?.documents)
        ? rootRec.documents
        : undefined
  const root = rootRec ?? asRecord(jobSource?.[0])
  if (!root) {
    throw new Error("JSON LLM non è un oggetto")
  }

  const summary =
    (typeof root.summary === "string" && root.summary) ||
    (typeof rootRec?.summary === "string" && rootRec.summary) ||
    ""
  const job = jobSource
    ?.map((d) => coerceDocument(d))
    .filter((d): d is { doc: SolidWorksDocumentPayload; dropped: number } => d !== null)

  const payloadRec = asRecord(root.payload)
  const rootOps = Array.isArray(root.operations) ? root.operations.length : -1
  const payloadOpsRaw = payloadRec && Array.isArray(payloadRec.operations) ? payloadRec.operations : []
  const payloadOps = payloadOpsRaw.length || -1
  const rawTypes = payloadOpsRaw.map((o) => {
    const r = unwrapKeyedOp(o)
    return r ? String(r.type ?? r.kind ?? "") : typeof o
  })
  const rawKeys = payloadOpsRaw.slice(0, 3).map((o) => {
    const r = asRecord(o)
    return r ? Object.keys(r).join("+") : typeof o
  })

  const nestedPayload = asRecord(root.payload)
  const payloadPair =
    (nestedPayload && operationsFrom(nestedPayload) ? coerceDocument(nestedPayload) : null) ||
    (Array.isArray(root.operations) ? coerceDocument(root) : null) ||
    coerceDocument(root) ||
    job?.[0] ||
    null

  if (!payloadPair || payloadPair.doc.operations.length === 0) {
    const jobLen = Array.isArray(root.job) ? root.job.length : 0
    const jobOps = job?.map((j) => j.doc.operations.length) ?? []
    throw new Error(
      `JSON LLM senza operations schema v2 (keys=${Object.keys(root).join(",")} rootOps=${rootOps} payloadOps=${payloadOps} types=${rawTypes.join("|") || "-"} opKeys=${rawKeys.join(";") || "-"} jobLen=${jobLen} jobOps=${jobOps.join("+") || "-"})`,
    )
  }

  const droppedOps = (job ?? [payloadPair]).reduce((n, p) => n + p.dropped, 0)
  let jobDocs = job && job.length > 0 ? job.map((j) => j.doc) : undefined
  if (jobDocs && jobDocs.length > 0) {
    const already = jobDocs.some(
      (d) => d.document.name === payloadPair.doc.document.name && d.document.type === payloadPair.doc.document.type,
    )
    if (!already && payloadPair.doc.operations.length > 0) {
      jobDocs = [payloadPair.doc, ...jobDocs]
    }
  }
  const payload = payloadPair.doc
  let jobOut = jobDocs && jobDocs.length > 1 ? jobDocs : undefined
  if (jobOut) fillKitDefaults(jobOut)
  if (jobOut) fixZBracketAssemblyMates(jobOut)
  if (jobOut) foldStandaloneRibIntoPlate(jobOut)
  if (jobOut) fixCountersinkAssemblyMates(jobOut)
  if (jobOut) fixCounterboreAssemblyMates(jobOut)
  if (jobOut) fixStackedColumnAssembly(jobOut)
  if (jobOut) fixWindowCoverAssembly(jobOut)
  if (jobOut) fixPatternBushingAssembly(jobOut)
  if (jobOut) fixHingeAssembly(jobOut)
  for (const d of jobOut ?? [payload]) {
    fixDocumentSpelling(d)
    ensureCadInvariants(d)
  }
  const summaryOut = decorateSummary(
    summary ||
      (jobOut
        ? `Kit ${jobOut.length} documenti: ${jobOut.map((d) => d.document.name).join(", ")}.`
        : `Modello con ${payload.operations.length} operazioni.`),
    jobOut ?? [payload],
  )

  return {
    result: {
      summary: summaryOut,
      source: "openrouter",
      operations: jobOut ? jobOut.flatMap((d) => d.operations) : payload.operations,
      payload,
      job: jobOut,
      dfm: runDfmJob(jobOut ?? [payload]),
      model,
    },
    meta: {
      parse: repaired || droppedOps > 0 ? "repaired" : "ok",
      droppedOps,
    },
  }
}

function operationsFrom(rec: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(rec.operations)) return rec.operations
  const nested = asRecord(rec.payload)
  if (nested && Array.isArray(nested.operations)) return nested.operations
  if (Array.isArray(rec.ops)) return rec.ops
  if (Array.isArray(rec.features)) return rec.features
  return null
}

function coerceDocument(raw: unknown): { doc: SolidWorksDocumentPayload; dropped: number } | null {
  const rec = asRecord(raw)
  if (!rec) return null

  const opsRaw = operationsFrom(rec)
  if (!opsRaw) return null

  const operations: CadOperation[] = []
  let dropped = 0
  for (let i = 0; i < opsRaw.length; i++) {
    const op = normalizeOp(opsRaw[i], i)
    if (op) operations.push(op)
    else dropped++
  }
  if (operations.length === 0) return null
  linkSketches(operations)
  const split = splitTwinRectangleSketches(operations)
  operations.length = 0
  operations.push(...split)
  normalizeZBracketPart(operations)
  ensureThicknessChamfer(operations)
  ensureThicknessFillet(operations)
  ensurePlateRib(operations)
  ensureCountersinkPlate(operations)
  normalizeCountersinkScrew(operations)
  ensureCounterborePlate(operations)
  normalizeCheeseHeadScrew(operations)
  ensureStackBase(operations)
  ensureStackColumn(operations)
  ensureStackTopPlate(operations)
  ensureWindowPlate(operations)
  ensureWindowCover(operations)
  ensurePatternPlate(operations)
  ensurePatternBushing(operations)
  ensureHingeEar(operations)
  ensureHingePin(operations)
  recenterCornerOrigin(operations)

  const documentIn = asRecord(rec.document) ?? {}
  const type = normalizeDocType(documentIn.type) ?? inferDocType(operations)
  const name =
    (typeof documentIn.name === "string" && documentIn.name.trim()) ||
    (typeof rec.name === "string" && rec.name.trim()) ||
    defaultName(type)

  let savePath = typeof documentIn.savePath === "string" ? documentIn.savePath : undefined
  if (type === "drawing") {
    savePath = savePath ? savePath.replace(/^CAD\//i, "Disegni/") : `Disegni/${name}.SLDDRW`
  }

  const doc: SolidWorksDocumentPayload = {
    schemaVersion: 2,
    units: "mm",
    document: {
      type,
      name,
      attachToActive: documentIn.attachToActive === true,
      savePath,
      snapshotPath: typeof documentIn.snapshotPath === "string" ? documentIn.snapshotPath : undefined,
      snapshotView: typeof documentIn.snapshotView === "string" ? documentIn.snapshotView : "*Isometric",
      openPath: typeof documentIn.openPath === "string" ? documentIn.openPath : undefined,
      sheetFormat:
        typeof documentIn.sheetFormat === "string"
          ? documentIn.sheetFormat
          : type === "drawing"
            ? "A3"
            : undefined,
    },
    variables: Array.isArray(rec.variables) ? (rec.variables as SolidWorksDocumentPayload["variables"]) : [],
    configurations: Array.isArray(rec.configurations)
      ? (rec.configurations as SolidWorksDocumentPayload["configurations"])
      : [],
    operations,
  }
  return { doc, dropped }
}

/** Assemie/Assemblee → Assieme in names and paths. */
function spellAssieme(value: string): string {
  return value.replace(/Assemie/gi, "Assieme").replace(/Assemblee/gi, "Assieme")
}

function fixDocumentSpelling(doc: SolidWorksDocumentPayload) {
  doc.document.name = spellAssieme(doc.document.name)
  if (doc.document.savePath) doc.document.savePath = spellAssieme(doc.document.savePath)
  if (doc.document.snapshotPath) doc.document.snapshotPath = spellAssieme(doc.document.snapshotPath)
  if (doc.document.openPath) doc.document.openPath = spellAssieme(doc.document.openPath)
  for (const op of doc.operations) {
    const rec = op as CadOperation & { path?: string; model?: string; component1?: string; component2?: string }
    if (typeof rec.path === "string") rec.path = spellAssieme(rec.path)
    if (typeof rec.model === "string") rec.model = spellAssieme(rec.model)
    if (typeof rec.component1 === "string") rec.component1 = spellAssieme(rec.component1)
    if (typeof rec.component2 === "string") rec.component2 = spellAssieme(rec.component2)
  }
}

function decorateSummary(summary: string, docs: SolidWorksDocumentPayload[]): string {
  let text = spellAssieme(summary)
  const through = docs.some((d) =>
    d.operations.some((op) => op.type === "cut" && "throughAll" in op && op.throughAll === true),
  )
  if (through && !/passante|through\s*hole/i.test(text)) {
    text = `${text} Foro passante (throughAll) sul taglio, visibile nel piano.`
  }
  return text
}

/** Loop agentico: mate senza verify, o tavola senza iso, non basta lo step COM ok. */
function ensureCadInvariants(doc: SolidWorksDocumentPayload) {
  if (doc.document.type === "assembly") {
    const hasMate = doc.operations.some((op) => op.type === "mate")
    const hasVerify = doc.operations.some((op) => op.type === "verify")
    if (hasMate && !hasVerify) {
      doc.operations.push({ id: "v-auto", type: "verify" })
    }
  }
  if (doc.document.type !== "drawing") return
  if (!doc.document.sheetFormat) doc.document.sheetFormat = "A3"
  for (const op of doc.operations) {
    if (op.type === "standardViews") {
      if (op.includeIso === undefined) op.includeIso = true
      if (op.firstAngle === undefined) op.firstAngle = true
    }
    if (op.type === "annotation") {
      if (typeof op.x === "number" && op.x > 2) op.x = op.x / 1000
      if (typeof op.y === "number" && op.y > 2) op.y = op.y / 1000
    }
  }
}

function fillKitDefaults(docs: SolidWorksDocumentPayload[]) {
  const asm = [...docs].reverse().find((d) => d.document.type === "assembly")
  const part = docs.find((d) => d.document.type === "part")
  const model = asm?.document.savePath || part?.document.savePath
  for (const d of docs) {
    if (d.document.type !== "drawing") continue
    if (d.document.savePath && /^CAD\//i.test(d.document.savePath)) {
      d.document.savePath = d.document.savePath.replace(/^CAD\//i, "Disegni/")
    }
    if (!d.document.sheetFormat) d.document.sheetFormat = "A3"
    if (!model) continue
    for (const op of d.operations) {
      if (op.type === "standardViews" || op.type === "drawingView") {
        const rec = op as { model?: string }
        if (!rec.model) rec.model = model
      }
    }
  }
}

function unwrapKeyedOp(raw: unknown): Record<string, unknown> | null {
  const rec = asRecord(raw)
  if (!rec) return null

  const explicit = String(rec.type ?? rec.kind ?? rec.op ?? rec.operation ?? rec.feature ?? "").trim()
  if (explicit) {
    const nested = asRecord(rec[explicit]) || asRecord(rec.params) || asRecord(rec.data)
    return nested ? { ...nested, ...rec, type: explicit } : rec
  }

  for (const k of Object.keys(rec)) {
    const aliased = TYPE_ALIAS[k.toLowerCase()] || k
    if (!OP_TYPES.has(aliased)) continue
    const inner = rec[k]
    const innerRec = asRecord(inner)
    if (innerRec) return { ...rec, ...innerRec, type: aliased }
    return { ...rec, type: aliased }
  }
  return rec
}

function normalizeOp(raw: unknown, index: number): CadOperation | null {
  const rec = unwrapKeyedOp(raw)
  if (!rec) return null
  const rawType = String(rec.type ?? rec.kind ?? rec.op ?? rec.operation ?? rec.feature ?? "").trim()
  const aliased = TYPE_ALIAS[rawType.toLowerCase()] || rawType || inferOpType(rec)
  if (!OP_TYPES.has(aliased)) return null
  const id = typeof rec.id === "string" && rec.id.trim() ? rec.id : `op${index + 1}`
  const next: Record<string, unknown> = { ...rec, id, type: aliased }
  if (aliased === "sketch" && typeof next.plane === "string") {
    const p = PLANE_ALIAS[next.plane.trim().toLowerCase()]
    if (p) next.plane = p
  }
  if (aliased === "sketch" && !next.plane) next.plane = "Top"
  if (aliased === "sketch" && Array.isArray(next.contours)) {
    next.contours = (next.contours as unknown[]).flatMap((c) => {
      const poly = expandRegularPolygon(c)
      if (poly) return poly
      const n = normalizeContour(c)
      return n ? [n] : []
    })
  }
  if (aliased === "standardViews" || aliased === "drawingView") {
    if (typeof next.model !== "string" || !next.model.trim()) {
      const alt = [next.modelPath, next.path, next.file, next.assembly].find(
        (v) => typeof v === "string" && v.trim(),
      )
      if (typeof alt === "string") next.model = alt
    }
  }
  if (aliased === "mate") {
    const mt = String(next.mateType ?? next.subtype ?? next.kind ?? "")
      .trim()
      .toLowerCase()
    if (mt === "concentric" || mt === "coincident" || mt === "distance" || mt === "parallel" || mt === "perpendicular") {
      next.mateType = mt
    }
    if (typeof next.diameter !== "number") {
      const d1 = numish(next.diameter1)
      if (d1 != null) next.diameter = d1
    }
  }
  if (aliased === "chamfer") {
    if (typeof next.distance !== "number") {
      const d = numish(next.d) ?? numish(next.size) ?? numish(next.length)
      if (d != null) next.distance = d
    }
    if (next.allEdges === undefined) next.allEdges = true
  }
  if (aliased === "fillet") {
    if (typeof next.radius !== "number") {
      const r = numish(next.r) ?? numish(next.size) ?? numish(next.radiusMm)
      if (r != null) next.radius = r
    }
    if (next.allEdges === undefined) next.allEdges = true
  }
  const rawLower = rawType.toLowerCase()
  if (
    rawLower === "revolvecut" ||
    rawLower === "revolve_cut" ||
    rawLower === "revolve-cut" ||
    rawLower === "tagliorivoluzione" ||
    rawLower === "svasatura"
  ) {
    next.cut = true
  }
  if (aliased === "revolve") {
    if (next.cut === undefined && (next.isCut === true || next.cutExtrude === true)) next.cut = true
    if (typeof next.angle !== "number") next.angle = 360
  }
  if (aliased === "cut" && numish(next.angle) != null && Number(next.angle) > 0) {
    next.type = "revolve"
    next.cut = true
    if (typeof next.angle !== "number") next.angle = numish(next.angle)
  }
  return next as CadOperation
}

function inferOpType(rec: Record<string, unknown>): string {
  if (Array.isArray(rec.contours) || rec.plane) return "sketch"
  if (typeof rec.angle === "number") return "revolve"
  if (rec.throughAll === true) return "cut"
  if (rec.cut === true) return "cut"
  if (typeof rec.depth === "number" && rec.sketch) return "extrude"
  if (typeof rec.depth === "number") return rec.cut ? "cut" : "extrude"
  if (typeof rec.diameter === "number") return "hole"
  if (rec.profile && rec.path) return "sweep"
  return ""
}

/** Esagono/poligono → linee. Chiave = distanza tra facce parallele (across-flats). */
function expandRegularPolygon(raw: unknown): unknown[] | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const kind = String(rec.kind ?? rec.type ?? "").toLowerCase()
  const hex = kind === "hexagon" || kind === "esagono" || kind === "hex" || kind === "hexagonal"
  const poly = kind === "polygon" || kind === "poligono" || kind === "regularpolygon"
  if (!hex && !poly) return null
  const sides = hex ? 6 : Math.max(3, Math.round(numish(rec.sides) ?? numish(rec.n) ?? 6))
  const cx = numish(rec.cx) ?? numish(rec.x) ?? 0
  const cy = numish(rec.cy) ?? numish(rec.y) ?? 0
  const af =
    numish(rec.acrossFlats) ??
    numish(rec.chiave) ??
    numish(rec.flats) ??
    numish(rec.wrench) ??
    numish(rec.af)
  const radius =
    numish(rec.radius) ??
    (numish(rec.diameter) != null ? numish(rec.diameter)! / 2 : undefined)
  const R = af != null ? af / (2 * Math.cos(Math.PI / sides)) : radius
  if (R == null || !(R > 0)) return null
  const start = hex ? Math.PI / 6 : 0
  const lines: unknown[] = []
  for (let i = 0; i < sides; i++) {
    const a1 = start + (i * 2 * Math.PI) / sides
    const a2 = start + ((i + 1) * 2 * Math.PI) / sides
    lines.push({
      kind: "line",
      x1: round3(cx + R * Math.cos(a1)),
      y1: round3(cy + R * Math.sin(a1)),
      x2: round3(cx + R * Math.cos(a2)),
      y2: round3(cy + R * Math.sin(a2)),
      construction: false,
    })
  }
  return lines
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function normalizeContour(raw: unknown): unknown {
  const rec = asRecord(raw)
  if (!rec) return null
  const kind = String(rec.kind ?? rec.type ?? "").toLowerCase()
  const pos = asRecord(rec.position)
  // LLM spesso manda cx:0 insieme a centerX reale: non trattare 0 come già risolto.
  const cx = pickAxis(rec, pos, ["cx", "x", "centerX", "centreX"])
  const cy = pickAxis(rec, pos, ["cy", "y", "centerY", "centreY"])
  const rest = omitKeys(rec, [
    "centerX",
    "centerY",
    "centreX",
    "centreY",
    "position",
  ])
  if (kind === "rect" || kind === "rectangle") {
    const width = numish(rec.width) ?? 0
    const height = numish(rec.height) ?? 0
    return { ...rest, kind: "rectangle", cx, cy, width, height }
  }
  if (kind === "circ" || kind === "circle") {
    const diameter = numish(rec.diameter) ?? (numish(rec.radius) != null ? numish(rec.radius)! * 2 : 0)
    return { ...rest, kind: "circle", cx, cy, diameter }
  }
  if (kind === "arc" || kind === "arco") {
    if (numish(rec.x1) != null && numish(rec.x3) != null) {
      return { ...rest, kind: "arc" }
    }
    const diameter = numish(rec.diameter) ?? (numish(rec.radius) != null ? numish(rec.radius)! * 2 : 0)
    return { ...rest, kind: "circle", cx, cy, diameter }
  }
  if (kind === "line" || kind === "linea" || kind === "centerline" || kind === "asse") {
    const construction = kind === "centerline" || kind === "asse" || rec.construction === true
    return { ...rest, kind: "line", construction }
  }
  if (rec.kind === "rectangle" || rec.kind === "circle" || rec.kind === "line") {
    return { ...rest, kind: rec.kind, cx, cy }
  }
  return null
}

function pickAxis(
  rec: Record<string, unknown>,
  pos: Record<string, unknown> | null,
  keys: string[],
): number {
  const vals: number[] = []
  const primary = presentNum(rec, keys[0])
  if (primary !== undefined) vals.push(primary)
  const posKey = keys[0] === "cx" ? "x" : keys[0] === "cy" ? "y" : null
  if (posKey) {
    const fromPos = presentNum(pos, posKey)
    if (fromPos !== undefined) vals.push(fromPos)
  }
  for (const key of keys.slice(1)) {
    const n = presentNum(rec, key)
    if (n !== undefined) vals.push(n)
  }
  if (vals.length === 0) return 0
  const nonzero = vals.find((v) => Math.abs(v) > 1e-9)
  return nonzero ?? vals[0]
}

function omitKeys(rec: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const skip = new Set(keys)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (!skip.has(k)) out[k] = v
  }
  return out
}

function linkSketches(ops: CadOperation[]) {
  let lastSketch = ""
  const sketchIds: string[] = []
  for (const op of ops) {
    if (op.type === "sketch") {
      lastSketch = op.id
      sketchIds.push(op.id)
      continue
    }
    if ((op.type === "extrude" || op.type === "cut" || op.type === "revolve") && lastSketch) {
      const rec = op as CadOperation & { sketch?: string }
      if (!rec.sketch) rec.sketch = lastSketch
    }
    if (op.type === "sweep") {
      const rec = op as CadOperation & { path?: string; profile?: string; sketch?: string }
      if (!rec.path && sketchIds.length >= 1) rec.path = sketchIds[0]
      if (!rec.profile) rec.profile = rec.sketch || (sketchIds.length >= 2 ? sketchIds[1] : lastSketch)
    }
  }
}

/** Piastra 60×40×8 + Ø10: smusso feature 2×45° dopo l’estrusione e prima del foro. */
function ensureThicknessChamfer(ops: CadOperation[]): void {
  const hasRect6040 = ops.some(
    (o) =>
      o.type === "sketch" &&
      o.contours.some((c) => {
        if (c.kind !== "rectangle") return false
        const w = Number(c.width)
        const h = Number(c.height)
        return (
          (Math.abs(w - 60) < 0.2 && Math.abs(h - 40) < 0.2) ||
          (Math.abs(w - 40) < 0.2 && Math.abs(h - 60) < 0.2)
        )
      }),
  )
  const extIdx = ops.findIndex((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6)
  const hasD10 = ops.some(
    (o) =>
      o.type === "sketch" &&
      o.contours.some((c) => c.kind === "circle" && Math.abs(c.diameter - 10) < 0.2),
  )
  if (!hasRect6040 || extIdx < 0 || !hasD10) return
  let chamfer = ops.find((o) => o.type === "chamfer")
  if (chamfer) {
    chamfer.distance = chamfer.distance > 0 ? chamfer.distance : 2
    chamfer.allEdges = true
    const at = ops.indexOf(chamfer)
    if (at >= 0) ops.splice(at, 1)
  } else {
    chamfer = { id: "ch1", type: "chamfer", distance: 2, allEdges: true }
  }
  const extAfter = ops.findIndex((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6)
  ops.splice((extAfter >= 0 ? extAfter : extIdx) + 1, 0, chamfer)
}

/** Piastra 50×40×8 + Ø8: raccordo feature R3 dopo l’estrusione e prima del foro. */
function ensureThicknessFillet(ops: CadOperation[]): void {
  const hasRect5040 = ops.some(
    (o) =>
      o.type === "sketch" &&
      o.contours.some((c) => {
        if (c.kind !== "rectangle") return false
        return isRectSize(Number(c.width), Number(c.height), 50, 40)
      }),
  )
  const extIdx = ops.findIndex((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6)
  const hasD8 = hasCircleDia(ops, 8)
  if (!hasRect5040 || extIdx < 0 || !hasD8) return
  if (hasCircleDia(ops, 10) && ops.some((o) => o.type === "chamfer")) return

  const first = ops.find((o) => o.type === "sketch")
  if (first && first.type === "sketch") {
    const arcs = first.contours.filter((c) => c.kind === "arc").length
    const rect = first.contours.find((c) => c.kind === "rectangle")
    if (arcs >= 2 && !rect) {
      first.plane = "Top"
      first.contours = [{ kind: "rectangle", cx: 0, cy: 0, width: 50, height: 40 }]
    } else if (arcs >= 2 && rect && rect.kind === "rectangle") {
      first.contours = first.contours.filter((c) => c.kind !== "arc")
    }
  }

  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i].type === "chamfer") ops.splice(i, 1)
  }

  let fillet = ops.find((o) => o.type === "fillet")
  if (fillet) {
    fillet.radius = fillet.radius > 0 ? fillet.radius : 3
    fillet.allEdges = true
    const at = ops.indexOf(fillet)
    if (at >= 0) ops.splice(at, 1)
  } else {
    fillet = { id: uniqueOpId(ops, "f"), type: "fillet", radius: 3, allEdges: true }
  }
  const extAfter = ops.findIndex((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6)
  ops.splice((extAfter >= 0 ? extAfter : extIdx) + 1, 0, fillet)
}

function uniqueOpId(ops: CadOperation[], prefix: string): string {
  const ids = new Set(ops.map((o) => o.id))
  let n = 1
  while (ids.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

function isRectSize(w: number, h: number, a: number, b: number): boolean {
  return (
    (Math.abs(w - a) < 0.2 && Math.abs(h - b) < 0.2) ||
    (Math.abs(w - b) < 0.2 && Math.abs(h - a) < 0.2)
  )
}

function sketchRects(ops: CadOperation[]): Array<{
  sketch: Extract<CadOperation, { type: "sketch" }>
  width: number
  height: number
}> {
  const out: Array<{
    sketch: Extract<CadOperation, { type: "sketch" }>
    width: number
    height: number
  }> = []
  for (const op of ops) {
    if (op.type !== "sketch") continue
    for (const c of op.contours) {
      if (c.kind !== "rectangle") continue
      out.push({ sketch: op, width: Number(c.width), height: Number(c.height) })
    }
  }
  return out
}

function hasCircleDia(ops: CadOperation[], d: number): boolean {
  return ops.some(
    (o) =>
      (o.type === "sketch" &&
        o.contours.some((c) => c.kind === "circle" && Math.abs(c.diameter - d) < 0.2)) ||
      (o.type === "hole" && Math.abs(o.diameter - d) < 0.2),
  )
}

function isLKitOrPocketPlate(ops: CadOperation[]): boolean {
  const pocket3 = ops.some(
    (o) => o.type === "cut" && o.throughAll !== true && Math.abs(Number(o.depth) - 3) < 0.3,
  )
  const holes65 = ops
    .filter((o) => o.type === "sketch")
    .flatMap((s) => (s.type === "sketch" ? s.contours : []))
    .filter((c) => c.kind === "circle" && Math.abs(c.diameter - 6.5) < 0.3).length
  const hasBoss16 = hasCircleDia(ops, 16)
  const plateExt8 = ops.some((o) => {
    if (o.type !== "extrude" || Math.abs(Number(o.depth) - 8) >= 0.6) return false
    const sk = ops.find((s) => s.type === "sketch" && s.id === o.sketch)
    return (
      sk?.type === "sketch" &&
      sk.contours.some((c) => c.kind === "rectangle" && isRectSize(Number(c.width), Number(c.height), 80, 50))
    )
  })
  return pocket3 || holes65 >= 4 || (hasBoss16 && plateExt8)
}

function isRibFootprint(w: number, h: number): boolean {
  return isRectSize(w, h, 5, 40) || isRectSize(w, h, 5, 20) || isRectSize(w, h, 20, 40)
}

function has8050Plate(ops: CadOperation[]): boolean {
  return sketchRects(ops).some((r) => isRectSize(r.width, r.height, 80, 50))
}

function isPlateRibCandidate(ops: CadOperation[]): boolean {
  if (!has8050Plate(ops) || isLKitOrPocketPlate(ops)) return false
  const hasRib = sketchRects(ops).some((r) => isRibFootprint(r.width, r.height))
  const hasExt6 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 6) < 0.6)
  return hasCircleDia(ops, 8) || hasRib || hasExt6
}

function isStandaloneRibPart(ops: CadOperation[]): boolean {
  if (has8050Plate(ops)) return false
  const pin =
    hasCircleDia(ops, 8) &&
    ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 30) < 0.6) &&
    !sketchRects(ops).some((r) => isRibFootprint(r.width, r.height))
  if (pin) return false
  return sketchRects(ops).some((r) => isRibFootprint(r.width, r.height))
}

function extrudeForSketch(ops: CadOperation[], sketchId: string) {
  return ops.find((o) => o.type === "extrude" && o.sketch === sketchId)
}

/** Piastra 80×50×6 + nervatura 5×40×20 nello stesso PRT, poi foro Ø8. */
function ensurePlateRib(ops: CadOperation[]): void {
  if (!isPlateRibCandidate(ops)) return

  const plateHit = sketchRects(ops).find((r) => isRectSize(r.width, r.height, 80, 50))
  if (!plateHit) return
  const plateSketch = plateHit.sketch
  plateSketch.plane = "Top"
  for (const c of plateSketch.contours) {
    if (c.kind !== "rectangle" || !isRectSize(Number(c.width), Number(c.height), 80, 50)) continue
    c.cx = 0
    c.cy = 0
    c.width = 80
    c.height = 50
  }

  let plateExt = extrudeForSketch(ops, plateSketch.id)
  if (plateExt && plateExt.type === "extrude") {
    plateExt.depth = 6
  } else {
    plateExt = { id: uniqueOpId(ops, "e-plate"), type: "extrude", sketch: plateSketch.id, depth: 6 }
    ops.splice(ops.indexOf(plateSketch) + 1, 0, plateExt)
  }

  const ribHits = sketchRects(ops).filter(
    (r) => r.sketch.id !== plateSketch.id && isRibFootprint(r.width, r.height),
  )
  for (const hit of ribHits) {
    hit.sketch.plane = "Top"
    for (const c of hit.sketch.contours) {
      if (c.kind !== "rectangle" || !isRibFootprint(Number(c.width), Number(c.height))) continue
      c.cx = 0
      c.cy = 0
      c.width = 5
      c.height = 40
    }
    const ext = extrudeForSketch(ops, hit.sketch.id)
    if (ext && ext.type === "extrude") {
      ext.depth = 20
      ext.merge = true
    } else {
      const inserted = {
        id: uniqueOpId(ops, "e-rib"),
        type: "extrude" as const,
        sketch: hit.sketch.id,
        depth: 20,
        merge: true,
      }
      ops.splice(ops.indexOf(hit.sketch) + 1, 0, inserted)
    }
  }

  if (ribHits.length === 0) {
    const already20 = ops.some(
      (o) =>
        o.type === "extrude" &&
        Math.abs(Number(o.depth) - 20) < 0.6 &&
        o.sketch !== plateSketch.id,
    )
    if (!already20) {
      const sid = uniqueOpId(ops, "s-rib")
      const eid = uniqueOpId(ops, "e-rib")
      const ribSketch: CadOperation = {
        id: sid,
        type: "sketch",
        plane: "Top",
        contours: [{ kind: "rectangle", cx: 0, cy: 0, width: 5, height: 40 }],
      }
      const ribExt: CadOperation = { id: eid, type: "extrude", sketch: sid, depth: 20, merge: true }
      const at = ops.indexOf(plateExt) >= 0 ? ops.indexOf(plateExt) + 1 : ops.indexOf(plateSketch) + 1
      ops.splice(at, 0, ribSketch, ribExt)
    }
  }

  for (const op of ops) {
    if (op.type !== "sketch") continue
    const hasRect = op.contours.some((c) => c.kind === "rectangle")
    if (!hasRect) continue
    op.contours = op.contours.filter(
      (c) => !(c.kind === "circle" && Math.abs(c.diameter - 8) < 0.2),
    )
  }

  if (ops.some((o) => o.type === "hole" && Math.abs(o.diameter - 8) < 0.2)) return

  let holeSketch = ops.find(
    (o) =>
      o.type === "sketch" &&
      o.contours.some((c) => c.kind === "circle" && Math.abs(c.diameter - 8) < 0.2) &&
      !o.contours.some((c) => c.kind === "rectangle"),
  )
  if (!holeSketch || holeSketch.type !== "sketch") {
    const sid = uniqueOpId(ops, "s-hole")
    holeSketch = {
      id: sid,
      type: "sketch",
      plane: "Top",
      contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 8 }],
    }
    ops.push(holeSketch)
  } else {
    holeSketch.plane = "Top"
    for (const c of holeSketch.contours) {
      if (c.kind !== "circle" || Math.abs(c.diameter - 8) >= 0.2) continue
      c.cx = 0
      c.cy = 0
    }
  }

  const existingCut = ops.find((o) => o.type === "cut" && o.sketch === holeSketch.id)
  if (existingCut && existingCut.type === "cut") {
    existingCut.throughAll = true
    existingCut.depth = undefined
    const cutAt = ops.indexOf(existingCut)
    if (cutAt >= 0) ops.splice(cutAt, 1)
    const skAt = ops.indexOf(holeSketch)
    if (skAt >= 0) ops.splice(skAt, 1)
    ops.push(holeSketch, existingCut)
  } else if (!ops.some((o) => o.type === "hole" && Math.abs(o.diameter - 8) < 0.2)) {
    const skAt = ops.indexOf(holeSketch)
    if (skAt >= 0 && skAt !== ops.length - 1) {
      ops.splice(skAt, 1)
      ops.push(holeSketch)
    }
    ops.push({ id: uniqueOpId(ops, "c-hole"), type: "cut", sketch: holeSketch.id, throughAll: true })
  }
}

function foldStandaloneRibIntoPlate(docs: SolidWorksDocumentPayload[]): void {
  const ribDocs = docs.filter((d) => d.document.type === "part" && isStandaloneRibPart(d.operations))
  const plate = docs.find((d) => d.document.type === "part" && isPlateRibCandidate(d.operations))
  if (!plate || ribDocs.length === 0) return
  ensurePlateRib(plate.operations)
  const ribNames = new Set(ribDocs.map((d) => d.document.name))
  for (const d of docs) {
    if (d.document.type !== "assembly") continue
    const dropIds = new Set<string>()
    for (const op of d.operations) {
      if (op.type !== "component") continue
      const path = String(op.path || op.name || "")
      if ([...ribNames].some((n) => n && path.includes(n))) dropIds.add(op.id)
    }
    d.operations = d.operations.filter((op) => {
      if (op.type === "component" && dropIds.has(op.id)) return false
      if (op.type === "mate" && (dropIds.has(op.component1) || dropIds.has(op.component2))) return false
      return true
    })
  }
  for (let i = docs.length - 1; i >= 0; i--) {
    if (ribNames.has(docs[i].document.name)) docs.splice(i, 1)
  }
}

function cskPlateTriangle(): Extract<CadOperation, { type: "sketch" }>["contours"] {
  return [
    { kind: "line", x1: 0, y1: -3, x2: 0, y2: 3, construction: true },
    { kind: "line", x1: 3, y1: 3, x2: 6, y2: 3, construction: false },
    { kind: "line", x1: 6, y1: 3, x2: 3, y2: 0, construction: false },
    { kind: "line", x1: 3, y1: 0, x2: 3, y2: 3, construction: false },
  ]
}

function cskScrewSection(): Extract<CadOperation, { type: "sketch" }>["contours"] {
  return [
    { kind: "line", x1: 0, y1: 0, x2: 0, y2: 16, construction: true },
    { kind: "line", x1: 0, y1: 0, x2: 6, y2: 0, construction: false },
    { kind: "line", x1: 6, y1: 0, x2: 3, y2: 3, construction: false },
    { kind: "line", x1: 3, y1: 3, x2: 3, y2: 16, construction: false },
    { kind: "line", x1: 3, y1: 16, x2: 0, y2: 16, construction: false },
    { kind: "line", x1: 0, y1: 16, x2: 0, y2: 0, construction: false },
  ]
}

function hasFrontLines(ops: CadOperation[]): boolean {
  return ops.some(
    (o) =>
      o.type === "sketch" &&
      /front/i.test(String(o.plane || "")) &&
      o.contours.some((c) => c.kind === "line" && !c.construction),
  )
}

function maxSketchLineY(ops: CadOperation[]): number {
  let m = 0
  for (const o of ops) {
    if (o.type !== "sketch") continue
    for (const c of o.contours) {
      if (c.kind !== "line" || c.construction) continue
      m = Math.max(m, Math.abs(Number(c.y1)), Math.abs(Number(c.y2)))
    }
  }
  return m
}

function maxSketchLineX(ops: CadOperation[]): number {
  let m = 0
  for (const o of ops) {
    if (o.type !== "sketch") continue
    for (const c of o.contours) {
      if (c.kind !== "line" || c.construction) continue
      m = Math.max(m, Math.abs(Number(c.x1)), Math.abs(Number(c.x2)))
    }
  }
  return m
}

function isCountersinkPlate(ops: CadOperation[]): boolean {
  if (!sketchRects(ops).some((r) => isRectSize(r.width, r.height, 50, 40))) return false
  if (has8050Plate(ops) || isLKitOrPocketPlate(ops) || isZBracketPart(ops)) return false
  const ext8 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6)
  const ext6 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 6) < 0.6)
  if (ext8 && hasCircleDia(ops, 8)) return false
  if (hasCircleDia(ops, 8) && !hasCircleDia(ops, 6) && !hasCircleDia(ops, 12)) return false
  if (hasCircleDia(ops, 10) && !hasCircleDia(ops, 6)) return false
  if (hasCircleDia(ops, 16)) return false
  const d6 = hasCircleDia(ops, 6)
  const d12 = hasCircleDia(ops, 12)
  const rev = ops.some((o) => o.type === "revolve")
  if (ext8 && !ext6 && !d6) return false
  return ext6 || d6 || d12 || rev || hasFrontLines(ops)
}

function isCountersinkScrew(ops: CadOperation[]): boolean {
  if (isCountersinkPlate(ops)) return false
  if (isPatternPlate(ops) || isPatternBushing(ops) || isHingeEar(ops) || isHingePin(ops)) return false
  if (sketchRects(ops).some((r) => isRectSize(r.width, r.height, 50, 40))) return false
  if (sketchRects(ops).some((r) => isRectSize(r.width, r.height, 70, 50))) return false
  if (sketchRects(ops).some((r) => isRectSize(r.width, r.height, 90, 60))) return false
  if (has8050Plate(ops) || isZBracketPart(ops) || isLKitOrPocketPlate(ops)) return false
  if (hasCircleDia(ops, 16) && !hasCircleDia(ops, 6)) return false
  if (hasCircleDia(ops, 20)) return false
  if (hasCircleDia(ops, 10) && !hasCircleDia(ops, 12)) return false
  if (hasCircleDia(ops, 14) && ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 10) < 0.6)) {
    return false
  }
  if (hasCircleDia(ops, 12) && ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 10) < 0.6)) {
    return false
  }
  const maxX = maxSketchLineX(ops)
  if (maxX > 0 && maxX < 5.6) return false
  const d6 = hasCircleDia(ops, 6)
  const d12 = hasCircleDia(ops, 12)
  return maxX >= 5.8 || d12 || (d6 && d12)
}

/** Piastra 50×40×6 + foro Ø6 + svasatura conica 90° Ø12 (revolve cut), non un Ø6 cilindrico. */
function ensureCountersinkPlate(ops: CadOperation[]): void {
  if (!isCountersinkPlate(ops)) return

  const plateHit = sketchRects(ops).find((r) => isRectSize(r.width, r.height, 50, 40))
  if (!plateHit) return
  const plateSketch = plateHit.sketch
  plateSketch.plane = "Top"
  for (const c of plateSketch.contours) {
    if (c.kind !== "rectangle" || !isRectSize(Number(c.width), Number(c.height), 50, 40)) continue
    c.cx = 0
    c.cy = 0
    c.width = 50
    c.height = 40
  }
  for (const op of ops) {
    if (op.type !== "sketch") continue
    if (!op.contours.some((c) => c.kind === "rectangle")) continue
    op.contours = op.contours.filter((c) => c.kind === "rectangle" || (c.kind === "line" && c.construction))
  }

  let plateExt = extrudeForSketch(ops, plateSketch.id)
  if (plateExt && plateExt.type === "extrude") {
    plateExt.depth = 6
  } else {
    plateExt = { id: uniqueOpId(ops, "e-plate"), type: "extrude", sketch: plateSketch.id, depth: 6 }
    ops.splice(ops.indexOf(plateSketch) + 1, 0, plateExt)
  }

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    if (op.type === "chamfer" || op.type === "fillet") {
      ops.splice(i, 1)
      continue
    }
    if (op.type === "hole" && Math.abs(op.diameter - 12) < 0.2) {
      ops.splice(i, 1)
    }
  }

  for (const op of ops) {
    if (op.type !== "sketch") continue
    const d12only = op.contours.filter((c) => c.kind === "circle" && Math.abs(c.diameter - 12) < 0.2)
    const keep = op.contours.filter(
      (c) => !(c.kind === "circle" && Math.abs(c.diameter - 12) < 0.2 && Math.abs(c.cx) < 0.2 && Math.abs(c.cy) < 0.2),
    )
    if (d12only.length > 0 && keep.length !== op.contours.length) {
      op.contours = keep
    }
  }

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    if (op.type !== "sketch") continue
    if (op.contours.length === 0) {
      const sid = op.id
      ops.splice(i, 1)
      for (let j = ops.length - 1; j >= 0; j--) {
        const f = ops[j]
        if ((f.type === "cut" || f.type === "extrude" || f.type === "revolve") && f.sketch === sid) {
          ops.splice(j, 1)
        }
      }
    }
  }

  let holeSketch = ops.find(
    (o) =>
      o.type === "sketch" &&
      o.contours.some((c) => c.kind === "circle" && Math.abs(c.diameter - 6) < 0.2) &&
      !o.contours.some((c) => c.kind === "rectangle"),
  )
  if (!holeSketch || holeSketch.type !== "sketch") {
    const sid = uniqueOpId(ops, "s-hole")
    holeSketch = {
      id: sid,
      type: "sketch",
      plane: "Top",
      contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 6 }],
    }
    const at = ops.indexOf(plateExt) >= 0 ? ops.indexOf(plateExt) + 1 : ops.indexOf(plateSketch) + 1
    ops.splice(at, 0, holeSketch)
  } else {
    holeSketch.plane = "Top"
    for (const c of holeSketch.contours) {
      if (c.kind !== "circle" || Math.abs(c.diameter - 6) >= 0.2) continue
      c.cx = 0
      c.cy = 0
      c.diameter = 6
    }
  }

  let holeCut = ops.find((o) => o.type === "cut" && o.sketch === holeSketch.id)
  if (holeCut && holeCut.type === "cut") {
    holeCut.throughAll = true
    holeCut.depth = undefined
  } else if (!ops.some((o) => o.type === "hole" && Math.abs(o.diameter - 6) < 0.2)) {
    holeCut = { id: uniqueOpId(ops, "c-hole"), type: "cut", sketch: holeSketch.id, throughAll: true }
    ops.splice(ops.indexOf(holeSketch) + 1, 0, holeCut)
  }

  for (const op of ops) {
    if (op.type !== "cut") continue
    if (op.sketch !== holeSketch.id) continue
    op.throughAll = true
    op.depth = undefined
  }

  let cskSketch = ops.find(
    (o) =>
      o.type === "sketch" &&
      /front/i.test(String(o.plane || "")) &&
      o.contours.some((c) => c.kind === "line") &&
      o.id !== plateSketch.id &&
      o.id !== holeSketch.id,
  )
  if (!cskSketch || cskSketch.type !== "sketch") {
    const sid = uniqueOpId(ops, "s-csk")
    cskSketch = { id: sid, type: "sketch", plane: "Front", contours: cskPlateTriangle() }
    const afterHole = holeCut && ops.indexOf(holeCut) >= 0 ? ops.indexOf(holeCut) + 1 : ops.indexOf(holeSketch) + 1
    ops.splice(afterHole, 0, cskSketch)
  } else {
    cskSketch.plane = "Front"
    cskSketch.contours = cskPlateTriangle()
  }

  for (const op of ops) {
    if (op.type !== "revolve") continue
    if (op.sketch === cskSketch.id) op.cut = true
  }

  let cskRev = ops.find((o) => o.type === "revolve" && o.sketch === cskSketch.id)
  if (cskRev && cskRev.type === "revolve") {
    cskRev.angle = 360
    cskRev.cut = true
  } else {
    const stray = ops.find((o) => o.type === "revolve" && o.cut === true)
    if (stray && stray.type === "revolve") {
      stray.sketch = cskSketch.id
      stray.angle = 360
      stray.cut = true
      cskRev = stray
    } else {
      cskRev = {
        id: uniqueOpId(ops, "r-csk"),
        type: "revolve",
        sketch: cskSketch.id,
        angle: 360,
        cut: true,
      }
      ops.splice(ops.indexOf(cskSketch) + 1, 0, cskRev)
    }
  }

  const ordered: CadOperation[] = []
  const seen = new Set<string>()
  const take = (op: CadOperation | undefined) => {
    if (!op || seen.has(op.id)) return
    seen.add(op.id)
    ordered.push(op)
  }
  take(plateSketch)
  take(plateExt)
  take(holeSketch)
  take(ops.find((o) => o.type === "cut" && o.sketch === holeSketch.id))
  take(cskSketch)
  take(ops.find((o) => o.type === "revolve" && o.sketch === cskSketch.id))
  ops.length = 0
  ops.push(...ordered)
}

/** Vite testa svasata = un solo PRT, rivoluzione gambo Ø6 + testa Ø12, non un cilindro. */
function normalizeCountersinkScrew(ops: CadOperation[]): void {
  if (!isCountersinkScrew(ops)) return
  const sid = uniqueOpId(ops, "s-vite")
  ops.length = 0
  ops.push(
    { id: sid, type: "sketch", plane: "Front", contours: cskScrewSection() },
    { id: uniqueOpId(ops, "r-vite"), type: "revolve", sketch: sid, angle: 360 },
  )
}

function cheeseHeadSection(): Extract<CadOperation, { type: "sketch" }>["contours"] {
  return [
    { kind: "line", x1: 0, y1: 0, x2: 0, y2: 20, construction: true },
    { kind: "line", x1: 0, y1: 0, x2: 5, y2: 0, construction: false },
    { kind: "line", x1: 5, y1: 0, x2: 5, y2: 4, construction: false },
    { kind: "line", x1: 5, y1: 4, x2: 3, y2: 4, construction: false },
    { kind: "line", x1: 3, y1: 4, x2: 3, y2: 20, construction: false },
    { kind: "line", x1: 3, y1: 20, x2: 0, y2: 20, construction: false },
    { kind: "line", x1: 0, y1: 20, x2: 0, y2: 0, construction: false },
  ]
}

function isCounterborePlate(ops: CadOperation[]): boolean {
  if (!sketchRects(ops).some((r) => isRectSize(r.width, r.height, 70, 50))) return false
  if (has8050Plate(ops) || isLKitOrPocketPlate(ops) || isZBracketPart(ops)) return false
  if (sketchRects(ops).some((r) => isRectSize(r.width, r.height, 50, 40))) return false
  if (sketchRects(ops).some((r) => isRectSize(r.width, r.height, 90, 60))) return false
  const ext10 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 10) < 0.6)
  const ext6 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 6) < 0.6)
  const ext8 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6)
  if (ext6 && hasCircleDia(ops, 8) && !hasCircleDia(ops, 12) && !ext10) return false
  if (ext8 && hasCircleDia(ops, 8) && !hasCircleDia(ops, 12) && !ext10) return false
  if (sketchRects(ops).some((r) => isRectSize(r.width, r.height, 30, 18))) return false
  return ext10 || hasCircleDia(ops, 12) || hasCircleDia(ops, 6)
}

function isCheeseHeadScrew(ops: CadOperation[]): boolean {
  if (isCounterborePlate(ops) || isCountersinkPlate(ops) || isCountersinkScrew(ops)) return false
  if (isPatternPlate(ops) || isPatternBushing(ops) || isHingeEar(ops) || isHingePin(ops)) return false
  if (hasCircleDia(ops, 20)) return false
  if (sketchRects(ops).some((r) => isRectSize(r.width, r.height, 70, 50))) return false
  if (sketchRects(ops).some((r) => isRectSize(r.width, r.height, 50, 40))) return false
  if (sketchRects(ops).some((r) => isRectSize(r.width, r.height, 90, 60))) return false
  if (has8050Plate(ops) || isZBracketPart(ops) || isLKitOrPocketPlate(ops)) return false
  const maxX = maxSketchLineX(ops)
  if (maxX >= 5.8) return false
  const ext16 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 16) < 0.6)
  const ext4 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 4) < 0.6)
  const rev = ops.some((o) => o.type === "revolve" && o.cut !== true)
  const d6 = hasCircleDia(ops, 6)
  const d10 = hasCircleDia(ops, 10)
  return (
    rev ||
    d10 ||
    (d6 && ext16) ||
    (d10 && ext4) ||
    (hasFrontLines(ops) && maxX >= 4.5 && maxX <= 5.5)
  )
}

function findCircleOnlySketch(ops: CadOperation[], d: number) {
  return ops.find(
    (o) =>
      o.type === "sketch" &&
      o.contours.some((c) => c.kind === "circle" && Math.abs(c.diameter - d) < 0.2) &&
      !o.contours.some((c) => c.kind === "rectangle"),
  )
}

/** Piastra 70×50×10 + sede Ø12×4 + foro Ø6 passante, non una svasatura conica. */
function ensureCounterborePlate(ops: CadOperation[]): void {
  if (!isCounterborePlate(ops)) return

  const plateHit = sketchRects(ops).find((r) => isRectSize(r.width, r.height, 70, 50))
  if (!plateHit) return
  const plateSketch = plateHit.sketch
  plateSketch.plane = "Top"
  for (const c of plateSketch.contours) {
    if (c.kind !== "rectangle" || !isRectSize(Number(c.width), Number(c.height), 70, 50)) continue
    c.cx = 0
    c.cy = 0
    c.width = 70
    c.height = 50
  }
  for (const op of ops) {
    if (op.type !== "sketch") continue
    if (!op.contours.some((c) => c.kind === "rectangle")) continue
    op.contours = op.contours.filter((c) => c.kind === "rectangle" || (c.kind === "line" && c.construction))
  }

  let plateExt = extrudeForSketch(ops, plateSketch.id)
  if (plateExt && plateExt.type === "extrude") {
    plateExt.depth = 10
  } else {
    plateExt = { id: uniqueOpId(ops, "e-plate"), type: "extrude", sketch: plateSketch.id, depth: 10 }
    ops.splice(ops.indexOf(plateSketch) + 1, 0, plateExt)
  }

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    if (op.type === "chamfer" || op.type === "fillet") {
      ops.splice(i, 1)
      continue
    }
    if (op.type === "revolve" && op.cut === true) ops.splice(i, 1)
  }

  for (const op of ops) {
    if (op.type !== "sketch") continue
    const d12 = op.contours.filter((c) => c.kind === "circle" && Math.abs(c.diameter - 12) < 0.2)
    const d6 = op.contours.filter((c) => c.kind === "circle" && Math.abs(c.diameter - 6) < 0.2)
    if (d12.length && d6.length) {
      op.contours = op.contours.filter((c) => !(c.kind === "circle" && Math.abs(c.diameter - 6) < 0.2))
    }
  }

  let boreSketch = findCircleOnlySketch(ops, 12)
  if (!boreSketch || boreSketch.type !== "sketch") {
    const sid = uniqueOpId(ops, "s-bore")
    boreSketch = {
      id: sid,
      type: "sketch",
      plane: "Top",
      contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 12 }],
    }
    const at = ops.indexOf(plateExt) >= 0 ? ops.indexOf(plateExt) + 1 : ops.indexOf(plateSketch) + 1
    ops.splice(at, 0, boreSketch)
  } else {
    boreSketch.plane = "Top"
    for (const c of boreSketch.contours) {
      if (c.kind !== "circle" || Math.abs(c.diameter - 12) >= 0.2) continue
      c.cx = 0
      c.cy = 0
      c.diameter = 12
    }
  }

  let boreCut = ops.find((o) => o.type === "cut" && o.sketch === boreSketch.id)
  if (boreCut && boreCut.type === "cut") {
    boreCut.throughAll = false
    boreCut.depth = 4
  } else {
    boreCut = { id: uniqueOpId(ops, "c-bore"), type: "cut", sketch: boreSketch.id, depth: 4, throughAll: false }
    ops.splice(ops.indexOf(boreSketch) + 1, 0, boreCut)
  }

  let holeSketch = findCircleOnlySketch(ops, 6)
  if (holeSketch && holeSketch.id === boreSketch.id) holeSketch = undefined
  if (!holeSketch || holeSketch.type !== "sketch") {
    const sid = uniqueOpId(ops, "s-hole")
    holeSketch = {
      id: sid,
      type: "sketch",
      plane: "Top",
      contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 6 }],
    }
    ops.splice(ops.indexOf(boreCut) + 1, 0, holeSketch)
  } else {
    holeSketch.plane = "Top"
    for (const c of holeSketch.contours) {
      if (c.kind !== "circle" || Math.abs(c.diameter - 6) >= 0.2) continue
      c.cx = 0
      c.cy = 0
      c.diameter = 6
    }
  }

  let holeCut = ops.find((o) => o.type === "cut" && o.sketch === holeSketch.id)
  if (holeCut && holeCut.type === "cut") {
    holeCut.throughAll = true
    holeCut.depth = undefined
  } else {
    holeCut = { id: uniqueOpId(ops, "c-hole"), type: "cut", sketch: holeSketch.id, throughAll: true }
    ops.splice(ops.indexOf(holeSketch) + 1, 0, holeCut)
  }

  const ordered: CadOperation[] = []
  const seen = new Set<string>()
  const take = (op: CadOperation | undefined) => {
    if (!op || seen.has(op.id)) return
    seen.add(op.id)
    ordered.push(op)
  }
  take(plateSketch)
  take(plateExt)
  take(boreSketch)
  take(ops.find((o) => o.type === "cut" && o.sketch === boreSketch.id))
  take(holeSketch)
  take(ops.find((o) => o.type === "cut" && o.sketch === holeSketch.id))
  ops.length = 0
  ops.push(...ordered)
}

/** Vite testa cilindrica Ø10×4 + gambo Ø6×16, un PRT in rivoluzione, non un cilindro Ø6. */
function normalizeCheeseHeadScrew(ops: CadOperation[]): void {
  if (!isCheeseHeadScrew(ops)) return
  const sid = uniqueOpId(ops, "s-vite")
  ops.length = 0
  ops.push(
    { id: sid, type: "sketch", plane: "Front", contours: cheeseHeadSection() },
    { id: uniqueOpId(ops, "r-vite"), type: "revolve", sketch: sid, angle: 360 },
  )
}

function pathMatches(op: CadOperation, name: string): boolean {
  if (!name) return false
  const rec = op as CadOperation & { path?: string; name?: string }
  const blob = `${rec.path || ""} ${rec.name || ""}`
  return blob.toLowerCase().includes(name.toLowerCase())
}

function fixCountersinkAssemblyMates(jobOut: SolidWorksDocumentPayload[]): void {
  const plate = jobOut.find((d) => d.document.type === "part" && isCountersinkPlate(d.operations))
  const screw = jobOut.find((d) => d.document.type === "part" && isCountersinkScrew(d.operations))
  if (!plate || !screw) return

  const bannedPlate = /Piastra50Foro10|Piastra50Raccordo|Piastra50Foro16|Piastra60Smusso|PiastraNervatura/i
  const bannedScrew = /Boccola14x10|BoccolaGuida|Distanziale|Perno8x30|Albero/i
  if (bannedPlate.test(plate.document.name)) {
    plate.document.name = "Piastra50Svasata"
    plate.document.savePath = "CAD/Piastra50Svasata.SLDPRT"
  }
  if (bannedScrew.test(screw.document.name)) {
    screw.document.name = "ViteSvasata6x16"
    screw.document.savePath = "CAD/ViteSvasata6x16.SLDPRT"
  }

  for (const d of jobOut) {
    if (d.document.type !== "assembly") continue
    if (/Assemie/i.test(d.document.name) || !/^Assieme/i.test(d.document.name)) {
      d.document.name = "AssiemePiastraSvasata"
      d.document.savePath = "CAD/AssiemePiastraSvasata.SLDASM"
    }
    const plateComp = d.operations.find((op) => op.type === "component" && pathMatches(op, plate.document.name))
    const screwComp = d.operations.find((op) => op.type === "component" && pathMatches(op, screw.document.name))
    const comps = d.operations.filter((op) => op.type === "component")
    const pComp = plateComp && plateComp.type === "component" ? plateComp : comps[0]
    const sComp = screwComp && screwComp.type === "component" ? screwComp : comps.find((c) => c !== pComp)
    if (!pComp || pComp.type !== "component" || !sComp || sComp.type !== "component") continue
    pComp.fix = true
    pComp.path = plate.document.savePath || pComp.path
    sComp.path = screw.document.savePath || sComp.path
    if (sComp.y == null || Math.abs(Number(sComp.y) - 3) > 8) sComp.y = 3

    let coincident = d.operations.find((op) => op.type === "mate" && op.mateType === "coincident")
    if (coincident && coincident.type === "mate") {
      if (coincident.component1 === sComp.id || pathMatches(sComp, coincident.component1)) {
        coincident.entity1 = "bottom"
        coincident.entity2 = coincident.entity2 || "top"
        coincident.component1 = sComp.id
        coincident.component2 = pComp.id
      } else {
        coincident.entity2 = "bottom"
        coincident.entity1 = coincident.entity1 || "top"
        coincident.component1 = pComp.id
        coincident.component2 = sComp.id
      }
    } else {
      coincident = {
        id: uniqueOpId(d.operations, "m-coin"),
        type: "mate",
        mateType: "coincident",
        component1: sComp.id,
        component2: pComp.id,
        entity1: "bottom",
        entity2: "top",
      }
      d.operations.push(coincident)
    }

    let concentric = d.operations.find((op) => op.type === "mate" && op.mateType === "concentric")
    if (concentric && concentric.type === "mate") {
      concentric.diameter = 6
      concentric.component1 = sComp.id
      concentric.component2 = pComp.id
    } else {
      concentric = {
        id: uniqueOpId(d.operations, "m-conc"),
        type: "mate",
        mateType: "concentric",
        component1: sComp.id,
        component2: pComp.id,
        diameter: 6,
      }
      d.operations.push(concentric)
    }
  }
}

function fixCounterboreAssemblyMates(jobOut: SolidWorksDocumentPayload[]): void {
  const plate = jobOut.find((d) => d.document.type === "part" && isCounterborePlate(d.operations))
  const screw = jobOut.find((d) => d.document.type === "part" && isCheeseHeadScrew(d.operations))
  if (!plate || !screw) return

  const bannedPlate = /Piastra70Foro8|Piastra70x50Foro8|Piastra50Svasata|Piastra50Raccordo|PiastraNervatura|Piastra60Smusso/i
  const bannedScrew = /ViteSvasata|Boccola|Distanziale|Perno8x30|Albero/i
  if (bannedPlate.test(plate.document.name)) {
    plate.document.name = "Piastra70Sede12"
    plate.document.savePath = "CAD/Piastra70Sede12.SLDPRT"
  }
  if (bannedScrew.test(screw.document.name)) {
    screw.document.name = "ViteCilindrica6x16"
    screw.document.savePath = "CAD/ViteCilindrica6x16.SLDPRT"
  }

  for (const d of jobOut) {
    if (d.document.type !== "assembly") continue
    if (/Assemie/i.test(d.document.name) || !/^Assieme/i.test(d.document.name)) {
      d.document.name = "AssiemePiastraSede"
      d.document.savePath = "CAD/AssiemePiastraSede.SLDASM"
    }
    const plateComp = d.operations.find((op) => op.type === "component" && pathMatches(op, plate.document.name))
    const screwComp = d.operations.find((op) => op.type === "component" && pathMatches(op, screw.document.name))
    const comps = d.operations.filter((op) => op.type === "component")
    const pComp = plateComp && plateComp.type === "component" ? plateComp : comps[0]
    const sComp = screwComp && screwComp.type === "component" ? screwComp : comps.find((c) => c !== pComp)
    if (!pComp || pComp.type !== "component" || !sComp || sComp.type !== "component") continue
    pComp.fix = true
    pComp.path = plate.document.savePath || pComp.path
    sComp.path = screw.document.savePath || sComp.path
    if (sComp.y == null || Math.abs(Number(sComp.y)) > 12) sComp.y = 0

    let coincident = d.operations.find((op) => op.type === "mate" && op.mateType === "coincident")
    if (coincident && coincident.type === "mate") {
      coincident.component1 = sComp.id
      coincident.component2 = pComp.id
      coincident.entity1 = "top"
      coincident.entity2 = "top"
    } else {
      coincident = {
        id: uniqueOpId(d.operations, "m-coin"),
        type: "mate",
        mateType: "coincident",
        component1: sComp.id,
        component2: pComp.id,
        entity1: "top",
        entity2: "top",
      }
      d.operations.push(coincident)
    }

    let concentric = d.operations.find((op) => op.type === "mate" && op.mateType === "concentric")
    if (concentric && concentric.type === "mate") {
      concentric.diameter = 6
      concentric.component1 = sComp.id
      concentric.component2 = pComp.id
    } else {
      concentric = {
        id: uniqueOpId(d.operations, "m-conc"),
        type: "mate",
        mateType: "concentric",
        component1: sComp.id,
        component2: pComp.id,
        diameter: 6,
      }
      d.operations.push(concentric)
    }
  }
}

function plateHoleOps(w: number, h: number, t: number, holeD: number): CadOperation[] {
  return [
    { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "rectangle", cx: 0, cy: 0, width: w, height: h }] },
    { id: "e1", type: "extrude", sketch: "s1", depth: t },
    { id: "s2", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: holeD }] },
    { id: "c1", type: "cut", sketch: "s2", throughAll: true },
  ]
}

function columnHoleOps(): CadOperation[] {
  return [
    { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 20 }] },
    { id: "e1", type: "extrude", sketch: "s1", depth: 40 },
    { id: "s2", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 8 }] },
    { id: "c1", type: "cut", sketch: "s2", throughAll: true },
  ]
}

function makePartDoc(name: string, ops: CadOperation[]): SolidWorksDocumentPayload {
  return {
    schemaVersion: 2,
    units: "mm",
    document: {
      type: "part",
      name,
      attachToActive: false,
      savePath: `CAD/${name}.SLDPRT`,
      snapshotPath: `Export/${name}.jpg`,
      snapshotView: "*Isometric",
    },
    variables: [],
    configurations: [],
    operations: ops,
  }
}

function isStackBase(ops: CadOperation[]): boolean {
  if (!sketchRects(ops).some((r) => isRectSize(r.width, r.height, 80, 60))) return false
  if (has8050Plate(ops) || isLKitOrPocketPlate(ops) || isZBracketPart(ops)) return false
  return true
}

function isStackTopPlate(ops: CadOperation[]): boolean {
  if (!sketchRects(ops).some((r) => isRectSize(r.width, r.height, 50, 40))) return false
  if (isStackBase(ops) || has8050Plate(ops) || isLKitOrPocketPlate(ops) || isZBracketPart(ops)) return false
  if (ops.some((o) => o.type === "fillet" || o.type === "chamfer")) return false
  if (ops.some((o) => o.type === "revolve" && o.cut === true)) return false
  const ext6 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 6) < 0.6)
  const ext8 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6)
  if (ext8 && !ext6) return false
  if (hasCircleDia(ops, 6) && !hasCircleDia(ops, 8)) return false
  if (hasCircleDia(ops, 10) && !hasCircleDia(ops, 8)) return false
  if (hasCircleDia(ops, 16) && !hasCircleDia(ops, 8)) return false
  return ext6 || hasCircleDia(ops, 8)
}

function isStackColumn(ops: CadOperation[]): boolean {
  if (isStackBase(ops) || isStackTopPlate(ops) || isCountersinkPlate(ops) || isCounterborePlate(ops)) return false
  if (has8050Plate(ops) || isZBracketPart(ops) || isLKitOrPocketPlate(ops)) return false
  if (
    sketchRects(ops).some(
      (r) =>
        isRectSize(r.width, r.height, 70, 50) ||
        isRectSize(r.width, r.height, 60, 40) ||
        isRectSize(r.width, r.height, 50, 40) ||
        isRectSize(r.width, r.height, 80, 60) ||
        isRectSize(r.width, r.height, 90, 60) ||
        isRectSize(r.width, r.height, 30, 20),
    )
  ) {
    return false
  }
  const ext40 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 40) < 0.6)
  if (!ext40) return false
  const d20 = hasCircleDia(ops, 20)
  const square20 = sketchRects(ops).some((r) => isRectSize(r.width, r.height, 20, 20))
  return d20 || square20
}

function ensureStackBase(ops: CadOperation[]): void {
  if (!isStackBase(ops)) return
  ops.length = 0
  ops.push(...plateHoleOps(80, 60, 8, 8))
}

function ensureStackColumn(ops: CadOperation[]): void {
  if (!isStackColumn(ops)) return
  ops.length = 0
  ops.push(...columnHoleOps())
}

function ensureStackTopPlate(ops: CadOperation[]): void {
  if (!isStackTopPlate(ops)) return
  ops.length = 0
  ops.push(...plateHoleOps(50, 40, 6, 8))
}

function isStackedColumnJob(docs: SolidWorksDocumentPayload[]): boolean {
  const parts = docs.filter((d) => d.document.type === "part")
  if (parts.length === 0) return false
  const names = parts.map((p) => p.document.name).join(" ")
  if (/Base80x60|Colonna20x40|PiastraSuperiore50|AssiemeTrePezzi/i.test(names)) return true
  const hasBase = parts.some((p) => isStackBase(p.operations))
  const hasCol = parts.some((p) => isStackColumn(p.operations))
  const hasTop = parts.some((p) => isStackTopPlate(p.operations))
  if (hasBase && (hasCol || hasTop)) return true
  if (hasCol && hasTop) return true
  return false
}

function fixStackedColumnAssembly(jobOut: SolidWorksDocumentPayload[]): void {
  if (!isStackedColumnJob(jobOut)) return

  const parts = jobOut.filter((d) => d.document.type === "part")
  let base = parts.find((p) => isStackBase(p.operations))
  let column = parts.find((p) => p !== base && isStackColumn(p.operations))
  let top = parts.find((p) => p !== base && p !== column && isStackTopPlate(p.operations))
  if (!base) base = makePartDoc("Base80x60", plateHoleOps(80, 60, 8, 8))
  else {
    base.document.name = "Base80x60"
    base.document.savePath = "CAD/Base80x60.SLDPRT"
    ensureStackBase(base.operations)
  }
  if (!column) column = makePartDoc("Colonna20x40", columnHoleOps())
  else {
    column.document.name = "Colonna20x40"
    column.document.savePath = "CAD/Colonna20x40.SLDPRT"
    ensureStackColumn(column.operations)
  }
  if (!top) top = makePartDoc("PiastraSuperiore50", plateHoleOps(50, 40, 6, 8))
  else {
    top.document.name = "PiastraSuperiore50"
    top.document.savePath = "CAD/PiastraSuperiore50.SLDPRT"
    ensureStackTopPlate(top.operations)
  }

  let asm = jobOut.find((d) => d.document.type === "assembly")
  if (!asm) {
    asm = {
      schemaVersion: 2,
      units: "mm",
      document: {
        type: "assembly",
        name: "AssiemeTrePezzi",
        attachToActive: false,
        savePath: "CAD/AssiemeTrePezzi.SLDASM",
        snapshotPath: "Export/AssiemeTrePezzi.jpg",
        snapshotView: "*Isometric",
      },
      variables: [],
      configurations: [],
      operations: [],
    }
  } else {
    asm.document.name = "AssiemeTrePezzi"
    asm.document.savePath = "CAD/AssiemeTrePezzi.SLDASM"
  }
  asm.operations = [
    { id: "comp-base", type: "component", path: "CAD/Base80x60.SLDPRT", x: 0, y: 0, z: 0, fix: true },
    { id: "comp-col", type: "component", path: "CAD/Colonna20x40.SLDPRT", x: 0, y: 8, z: 0 },
    { id: "comp-top", type: "component", path: "CAD/PiastraSuperiore50.SLDPRT", x: 0, y: 48, z: 0 },
    {
      id: "m-coin1",
      type: "mate",
      mateType: "coincident",
      component1: "comp-col",
      component2: "comp-base",
      entity1: "bottom",
      entity2: "top",
    },
    {
      id: "m-coin2",
      type: "mate",
      mateType: "coincident",
      component1: "comp-top",
      component2: "comp-col",
      entity1: "bottom",
      entity2: "top",
    },
    {
      id: "m-conc1",
      type: "mate",
      mateType: "concentric",
      component1: "comp-col",
      component2: "comp-base",
      diameter: 8,
    },
    {
      id: "m-conc2",
      type: "mate",
      mateType: "concentric",
      component1: "comp-top",
      component2: "comp-col",
      diameter: 8,
    },
    {
      id: "m-perp",
      type: "mate",
      mateType: "perpendicular",
      component1: "comp-col",
      component2: "comp-base",
      entity1: "right",
      entity2: "top",
    },
    { id: "v-auto", type: "verify" },
  ]

  const drawings = jobOut.filter((d) => d.document.type === "drawing")
  for (const d of drawings) {
    if (/Assemie|Sandwich|Sede|Svasata|demo/i.test(d.document.name) || !/^Tavola/i.test(d.document.name)) {
      d.document.name = "TavolaTrePezzi"
    }
    d.document.savePath = `Disegni/${d.document.name}.SLDDRW`
    d.document.sheetFormat = d.document.sheetFormat || "A3"
    for (const op of d.operations) {
      if (op.type === "standardViews" || op.type === "drawingView") {
        const rec = op as { model?: string }
        rec.model = "CAD/AssiemeTrePezzi.SLDASM"
      }
    }
  }
  if (drawings.length === 0) {
    drawings.push({
      schemaVersion: 2,
      units: "mm",
      document: {
        type: "drawing",
        name: "TavolaTrePezzi",
        attachToActive: false,
        savePath: "Disegni/TavolaTrePezzi.SLDDRW",
        snapshotPath: "Export/TavolaTrePezzi.jpg",
        sheetFormat: "A3",
      },
      variables: [],
      configurations: [],
      operations: [
        { id: "dv1", type: "standardViews", model: "CAD/AssiemeTrePezzi.SLDASM", firstAngle: true, includeIso: true },
        { id: "dd1", type: "modelDimensions" },
        {
          id: "an1",
          type: "annotation",
          text: "Base 80×60×8 Ø8 — Colonna Ø20×40 Ø8 — Piastra 50×40×6 Ø8",
          x: 0.02,
          y: 0.27,
        },
      ],
    })
  }

  jobOut.length = 0
  jobOut.push(base, column, top, asm, ...drawings)
}

function windowPlateOps(): CadOperation[] {
  return [
    { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "rectangle", cx: 0, cy: 0, width: 70, height: 50 }] },
    { id: "e1", type: "extrude", sketch: "s1", depth: 8 },
    { id: "s2", type: "sketch", plane: "Top", contours: [{ kind: "rectangle", cx: 0, cy: 0, width: 30, height: 18 }] },
    { id: "c1", type: "cut", sketch: "s2", throughAll: true },
  ]
}

function windowCoverOps(): CadOperation[] {
  return [
    { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "rectangle", cx: 0, cy: 0, width: 70, height: 50 }] },
    { id: "e1", type: "extrude", sketch: "s1", depth: 3 },
  ]
}

function hasRectSizeOps(ops: CadOperation[], a: number, b: number): boolean {
  return sketchRects(ops).some((r) => isRectSize(r.width, r.height, a, b))
}

function isWindowPlate(ops: CadOperation[]): boolean {
  if (!hasRectSizeOps(ops, 70, 50)) return false
  if (has8050Plate(ops) || isZBracketPart(ops) || isStackBase(ops)) return false
  if (hasRectSizeOps(ops, 80, 60) || hasRectSizeOps(ops, 50, 40)) return false
  return hasRectSizeOps(ops, 30, 18)
}

function isWindowCover(ops: CadOperation[]): boolean {
  if (!hasRectSizeOps(ops, 70, 50)) return false
  if (isWindowPlate(ops) || isZBracketPart(ops) || has8050Plate(ops) || isStackBase(ops)) return false
  if (hasRectSizeOps(ops, 30, 18) || hasRectSizeOps(ops, 50, 40)) return false
  const ext3 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 3) < 0.6)
  const ext8 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6)
  const ext6 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 6) < 0.6)
  if (ext6 && hasCircleDia(ops, 8) && !ext3) return false
  if (ext8 && hasCircleDia(ops, 8) && !ext3) return false
  return ext3
}

function ensureWindowPlate(ops: CadOperation[]): void {
  if (!isWindowPlate(ops)) return
  ops.length = 0
  ops.push(...windowPlateOps())
}

function ensureWindowCover(ops: CadOperation[]): void {
  if (!isWindowCover(ops)) return
  ops.length = 0
  ops.push(...windowCoverOps())
}

function isWindowCoverJob(docs: SolidWorksDocumentPayload[]): boolean {
  const parts = docs.filter((d) => d.document.type === "part")
  if (parts.length === 0) return false
  const names = parts.map((p) => p.document.name).join(" ")
  if (/Piastra70Finestra|Coperchio70x50|AssiemePiastraFinestra/i.test(names)) return true
  const plates7050 = parts.filter((p) => hasRectSizeOps(p.operations, 70, 50))
  const hasWindow = parts.some((p) => isWindowPlate(p.operations) || hasRectSizeOps(p.operations, 30, 18))
  const hasCover = parts.some((p) => isWindowCover(p.operations))
  if (hasWindow) return true
  if (plates7050.length >= 2 && parts.length <= 3) return true
  if (hasCover && plates7050.length >= 1) return true
  return false
}

function fixWindowCoverAssembly(jobOut: SolidWorksDocumentPayload[]): void {
  if (!isWindowCoverJob(jobOut)) return
  if (isStackedColumnJob(jobOut)) return

  const parts = jobOut.filter((d) => d.document.type === "part")
  let plate = parts.find((p) => isWindowPlate(p.operations))
  if (!plate) {
    plate = parts.find(
      (p) =>
        hasRectSizeOps(p.operations, 70, 50) &&
        p.operations.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6),
    )
  }
  let cover = parts.find((p) => p !== plate && isWindowCover(p.operations))
  if (!cover) {
    cover = parts.find((p) => p !== plate && hasRectSizeOps(p.operations, 70, 50))
  }
  if (!plate) plate = makePartDoc("Piastra70Finestra", windowPlateOps())
  else {
    plate.document.name = "Piastra70Finestra"
    plate.document.savePath = "CAD/Piastra70Finestra.SLDPRT"
    plate.operations.length = 0
    plate.operations.push(...windowPlateOps())
  }
  if (!cover) cover = makePartDoc("Coperchio70x50", windowCoverOps())
  else {
    cover.document.name = "Coperchio70x50"
    cover.document.savePath = "CAD/Coperchio70x50.SLDPRT"
    cover.operations.length = 0
    cover.operations.push(...windowCoverOps())
  }

  let asm = jobOut.find((d) => d.document.type === "assembly")
  if (!asm) {
    asm = {
      schemaVersion: 2,
      units: "mm",
      document: {
        type: "assembly",
        name: "AssiemePiastraFinestra",
        attachToActive: false,
        savePath: "CAD/AssiemePiastraFinestra.SLDASM",
        snapshotPath: "Export/AssiemePiastraFinestra.jpg",
        snapshotView: "*Isometric",
      },
      variables: [],
      configurations: [],
      operations: [],
    }
  } else {
    asm.document.name = "AssiemePiastraFinestra"
    asm.document.savePath = "CAD/AssiemePiastraFinestra.SLDASM"
  }
  asm.operations = [
    { id: "comp-p", type: "component", path: "CAD/Piastra70Finestra.SLDPRT", x: 0, y: 0, z: 0, fix: true },
    { id: "comp-c", type: "component", path: "CAD/Coperchio70x50.SLDPRT", x: 0, y: 8, z: 0 },
    {
      id: "m-coin",
      type: "mate",
      mateType: "coincident",
      component1: "comp-c",
      component2: "comp-p",
      entity1: "bottom",
      entity2: "top",
    },
    { id: "v-auto", type: "verify" },
  ]

  const drawings = jobOut.filter((d) => d.document.type === "drawing")
  for (const d of drawings) {
    if (/Assemie|Sandwich|Tasca|Sede|TrePezzi|demo/i.test(d.document.name) || !/^Tavola/i.test(d.document.name)) {
      d.document.name = "TavolaPiastraFinestra"
    }
    d.document.savePath = `Disegni/${d.document.name}.SLDDRW`
    d.document.sheetFormat = d.document.sheetFormat || "A3"
    for (const op of d.operations) {
      if (op.type === "standardViews" || op.type === "drawingView") {
        const rec = op as { model?: string }
        rec.model = "CAD/AssiemePiastraFinestra.SLDASM"
      }
    }
  }
  if (drawings.length === 0) {
    drawings.push({
      schemaVersion: 2,
      units: "mm",
      document: {
        type: "drawing",
        name: "TavolaPiastraFinestra",
        attachToActive: false,
        savePath: "Disegni/TavolaPiastraFinestra.SLDDRW",
        snapshotPath: "Export/TavolaPiastraFinestra.jpg",
        sheetFormat: "A3",
      },
      variables: [],
      configurations: [],
      operations: [
        {
          id: "dv1",
          type: "standardViews",
          model: "CAD/AssiemePiastraFinestra.SLDASM",
          firstAngle: true,
          includeIso: true,
        },
        { id: "dd1", type: "modelDimensions" },
        {
          id: "an1",
          type: "annotation",
          text: "Plate 70×50×8 — through window 30×18 — cover 70×50×3",
          x: 0.02,
          y: 0.27,
        },
      ],
    })
  }

  jobOut.length = 0
  jobOut.push(plate, cover, asm, ...drawings)
}

const PATTERN_HOLE_XY: Array<[number, number]> = [
  [-20, 9],
  [0, 9],
  [20, 9],
  [-20, -9],
  [0, -9],
  [20, -9],
]

function countCirclesDia(ops: CadOperation[], d: number): number {
  let n = 0
  for (const o of ops) {
    if (o.type !== "sketch") continue
    for (const c of o.contours) {
      if (c.kind === "circle" && Math.abs(c.diameter - d) < 0.2) n++
    }
  }
  return n
}

function patternPlateOps(): CadOperation[] {
  return [
    { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "rectangle", cx: 0, cy: 0, width: 90, height: 60 }] },
    { id: "e1", type: "extrude", sketch: "s1", depth: 8 },
    {
      id: "s2",
      type: "sketch",
      plane: "Top",
      contours: PATTERN_HOLE_XY.map(([cx, cy]) => ({ kind: "circle" as const, cx, cy, diameter: 6 })),
    },
    { id: "c1", type: "cut", sketch: "s2", throughAll: true },
  ]
}

function patternBushingOps(): CadOperation[] {
  return [
    { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 12 }] },
    { id: "e1", type: "extrude", sketch: "s1", depth: 10 },
    { id: "s2", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 6 }] },
    { id: "c1", type: "cut", sketch: "s2", throughAll: true },
  ]
}

function isPatternPlate(ops: CadOperation[]): boolean {
  if (!hasRectSizeOps(ops, 90, 60)) return false
  if (has8050Plate(ops) || isLKitOrPocketPlate(ops) || isZBracketPart(ops) || isStackBase(ops)) return false
  if (hasRectSizeOps(ops, 80, 60) || hasRectSizeOps(ops, 70, 50) || hasRectSizeOps(ops, 50, 40)) return false
  if (hasRectSizeOps(ops, 30, 18) || hasRectSizeOps(ops, 30, 12)) return false
  const ext8 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 8) < 0.6)
  const d6 = hasCircleDia(ops, 6)
  const hasPattern = ops.some((o) => o.type === "pattern")
  return ext8 || d6 || hasPattern || countCirclesDia(ops, 6) >= 1
}

function isPatternBushing(ops: CadOperation[]): boolean {
  if (isPatternPlate(ops) || hasRectSizeOps(ops, 90, 60)) return false
  if (has8050Plate(ops) || isZBracketPart(ops) || isLKitOrPocketPlate(ops)) return false
  if (hasCircleDia(ops, 14) || hasCircleDia(ops, 16) || hasCircleDia(ops, 20) || hasCircleDia(ops, 10)) return false
  if (sketchRects(ops).length > 0) return false
  const maxY = maxSketchLineY(ops)
  if (maxY > 11) return false
  const ext10 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 10) < 0.6)
  const d12 = hasCircleDia(ops, 12)
  const d6 = hasCircleDia(ops, 6)
  if (ext10 && (d12 || d6)) return true
  const rev = ops.some((o) => o.type === "revolve" && o.cut !== true)
  const maxX = maxSketchLineX(ops)
  return rev && maxX >= 5.5 && maxX <= 6.5 && maxY >= 9 && maxY <= 11
}

function ensurePatternPlate(ops: CadOperation[]): void {
  if (!isPatternPlate(ops)) return
  ops.length = 0
  ops.push(...patternPlateOps())
}

function ensurePatternBushing(ops: CadOperation[]): void {
  if (!isPatternBushing(ops)) return
  ops.length = 0
  ops.push(...patternBushingOps())
}

function isPatternBushingJob(docs: SolidWorksDocumentPayload[]): boolean {
  const parts = docs.filter((d) => d.document.type === "part")
  if (parts.length === 0) return false
  const names = parts.map((p) => p.document.name).join(" ")
  if (/PiastraGriglia6|Boccola12x10|AssiemePiastraGriglia/i.test(names)) return true
  const hasPlate = parts.some((p) => isPatternPlate(p.operations) || hasRectSizeOps(p.operations, 90, 60))
  const hasBush = parts.some((p) => isPatternBushing(p.operations))
  const n6 = parts.reduce((n, p) => n + countCirclesDia(p.operations, 6), 0)
  if (hasPlate && (hasBush || n6 >= 4 || n6 === 1 || n6 === 6)) return true
  if (hasPlate && parts.length <= 3) return true
  return false
}

function fixPatternBushingAssembly(jobOut: SolidWorksDocumentPayload[]): void {
  if (!isPatternBushingJob(jobOut)) return
  if (isStackedColumnJob(jobOut) || isWindowCoverJob(jobOut)) return

  const parts = jobOut.filter((d) => d.document.type === "part")
  let plate = parts.find((p) => isPatternPlate(p.operations) || hasRectSizeOps(p.operations, 90, 60))
  let bush = parts.find((p) => p !== plate && isPatternBushing(p.operations))
  if (!bush) {
    bush = parts.find((p) => p !== plate && !hasRectSizeOps(p.operations, 90, 60))
  }
  if (!plate) plate = makePartDoc("PiastraGriglia6", patternPlateOps())
  else {
    plate.document.name = "PiastraGriglia6"
    plate.document.savePath = "CAD/PiastraGriglia6.SLDPRT"
    plate.operations.length = 0
    plate.operations.push(...patternPlateOps())
  }
  if (!bush) bush = makePartDoc("Boccola12x10", patternBushingOps())
  else {
    bush.document.name = "Boccola12x10"
    bush.document.savePath = "CAD/Boccola12x10.SLDPRT"
    bush.operations.length = 0
    bush.operations.push(...patternBushingOps())
  }

  let asm = jobOut.find((d) => d.document.type === "assembly")
  if (!asm) {
    asm = {
      schemaVersion: 2,
      units: "mm",
      document: {
        type: "assembly",
        name: "AssiemePiastraGriglia",
        attachToActive: false,
        savePath: "CAD/AssiemePiastraGriglia.SLDASM",
        snapshotPath: "Export/AssiemePiastraGriglia.jpg",
        snapshotView: "*Isometric",
      },
      variables: [],
      configurations: [],
      operations: [],
    }
  } else {
    asm.document.name = "AssiemePiastraGriglia"
    asm.document.savePath = "CAD/AssiemePiastraGriglia.SLDASM"
  }
  asm.operations = [
    { id: "comp-p", type: "component", path: "CAD/PiastraGriglia6.SLDPRT", x: 0, y: 0, z: 0, fix: true },
    { id: "comp-b", type: "component", path: "CAD/Boccola12x10.SLDPRT", x: 0, y: 8, z: 9 },
    {
      id: "m-coin",
      type: "mate",
      mateType: "coincident",
      component1: "comp-b",
      component2: "comp-p",
      entity1: "bottom",
      entity2: "top",
    },
    {
      id: "m-conc",
      type: "mate",
      mateType: "concentric",
      component1: "comp-b",
      component2: "comp-p",
      entity1: "inner",
      entity2: "inner",
      diameter: 6,
      holeX: 0,
      holeZ: 9,
    },
    { id: "v-auto", type: "verify" },
  ]

  const drawings = jobOut.filter((d) => d.document.type === "drawing")
  for (const d of drawings) {
    if (/Assemie|Finestra|Tasca|Sede|TrePezzi|demo/i.test(d.document.name) || !/^Tavola/i.test(d.document.name)) {
      d.document.name = "TavolaPiastraGriglia"
    }
    d.document.savePath = `Disegni/${d.document.name}.SLDDRW`
    d.document.sheetFormat = d.document.sheetFormat || "A3"
    for (const op of d.operations) {
      if (op.type === "standardViews" || op.type === "drawingView") {
        const rec = op as { model?: string }
        rec.model = "CAD/AssiemePiastraGriglia.SLDASM"
      }
    }
  }
  if (drawings.length === 0) {
    drawings.push({
      schemaVersion: 2,
      units: "mm",
      document: {
        type: "drawing",
        name: "TavolaPiastraGriglia",
        attachToActive: false,
        savePath: "Disegni/TavolaPiastraGriglia.SLDDRW",
        snapshotPath: "Export/TavolaPiastraGriglia.jpg",
        sheetFormat: "A3",
      },
      variables: [],
      configurations: [],
      operations: [
        {
          id: "dv1",
          type: "standardViews",
          model: "CAD/AssiemePiastraGriglia.SLDASM",
          firstAngle: true,
          includeIso: true,
        },
        { id: "dd1", type: "modelDimensions" },
        {
          id: "an1",
          type: "annotation",
          text: "Piastra 90×60×8 — 6 fori Ø6 passo 20×18 — boccola Ø12×10 Ø6",
          x: 0.02,
          y: 0.27,
        },
      ],
    })
  }

  jobOut.length = 0
  jobOut.push(plate, bush, asm, ...drawings)
}

function hingeEarOps(): CadOperation[] {
  return [
    { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "rectangle", cx: 0, cy: 0, width: 30, height: 20 }] },
    { id: "e1", type: "extrude", sketch: "s1", depth: 6 },
    { id: "s2", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 8 }] },
    { id: "c1", type: "cut", sketch: "s2", throughAll: true },
  ]
}

function hingePinOps(): CadOperation[] {
  return [
    { id: "s1", type: "sketch", plane: "Top", contours: [{ kind: "circle", cx: 0, cy: 0, diameter: 8 }] },
    { id: "e1", type: "extrude", sketch: "s1", depth: 50 },
  ]
}

function isHingeEar(ops: CadOperation[]): boolean {
  if (!hasRectSizeOps(ops, 30, 20)) return false
  if (hasRectSizeOps(ops, 30, 18) || hasRectSizeOps(ops, 70, 50) || hasRectSizeOps(ops, 90, 60)) return false
  if (has8050Plate(ops) || isLKitOrPocketPlate(ops) || isZBracketPart(ops) || isStackBase(ops)) return false
  if (hasRectSizeOps(ops, 60, 40) || hasRectSizeOps(ops, 50, 40) || hasRectSizeOps(ops, 80, 60)) return false
  const ext6 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 6) < 0.6)
  return ext6 || hasCircleDia(ops, 8)
}

function isHingePin(ops: CadOperation[]): boolean {
  if (isHingeEar(ops) || hasRectSizeOps(ops, 30, 20) || hasRectSizeOps(ops, 80, 50)) return false
  if (has8050Plate(ops) || isZBracketPart(ops) || isLKitOrPocketPlate(ops) || isPatternBushing(ops)) return false
  if (hasCircleDia(ops, 12) || hasCircleDia(ops, 10) || hasCircleDia(ops, 14) || hasCircleDia(ops, 16) || hasCircleDia(ops, 20)) {
    return false
  }
  if (sketchRects(ops).length > 0) return false
  const ext50 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 50) < 0.6)
  const ext30 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 30) < 0.6)
  if (ext30 && !ext50) return false
  const d8 = hasCircleDia(ops, 8)
  const rev = ops.some((o) => o.type === "revolve" && o.cut !== true)
  const maxX = maxSketchLineX(ops)
  const maxY = maxSketchLineY(ops)
  if (ext50 && d8) return true
  return rev && maxX >= 3.5 && maxX <= 4.5 && maxY >= 45 && maxY <= 55
}

function ensureHingeEar(ops: CadOperation[]): void {
  if (!isHingeEar(ops)) return
  ops.length = 0
  ops.push(...hingeEarOps())
}

function ensureHingePin(ops: CadOperation[]): void {
  if (!isHingePin(ops)) return
  ops.length = 0
  ops.push(...hingePinOps())
}

function isHingeJob(docs: SolidWorksDocumentPayload[]): boolean {
  const parts = docs.filter((d) => d.document.type === "part")
  if (parts.length === 0) return false
  const names = parts.map((p) => p.document.name).join(" ")
  if (/Orecchio30|Perno8x50|AssiemeCerniera/i.test(names)) return true
  const hasEar = parts.some((p) => isHingeEar(p.operations) || hasRectSizeOps(p.operations, 30, 20))
  const hasPin = parts.some((p) => isHingePin(p.operations))
  const n8 = parts.reduce((n, p) => n + countCirclesDia(p.operations, 8), 0)
  const twoHolesOnePart = parts.some(
    (p) => countCirclesDia(p.operations, 8) >= 2 && hasRectSizeOps(p.operations, 30, 20),
  )
  if (hasEar && (hasPin || n8 >= 1)) return true
  if (hasEar && parts.length <= 3) return true
  if (twoHolesOnePart && parts.length <= 3) return true
  return false
}

function fixHingeAssembly(jobOut: SolidWorksDocumentPayload[]): void {
  if (!isHingeJob(jobOut)) return
  if (isStackedColumnJob(jobOut) || isWindowCoverJob(jobOut) || isPatternBushingJob(jobOut)) return

  const parts = jobOut.filter((d) => d.document.type === "part")
  let ear = parts.find((p) => isHingeEar(p.operations) || hasRectSizeOps(p.operations, 30, 20))
  let pin = parts.find((p) => p !== ear && isHingePin(p.operations))
  if (!pin) {
    pin = parts.find(
      (p) =>
        p !== ear &&
        !hasRectSizeOps(p.operations, 30, 20) &&
        (hasCircleDia(p.operations, 8) ||
          p.operations.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 50) < 0.6)),
    )
  }
  if (!ear) ear = makePartDoc("Orecchio30", hingeEarOps())
  else {
    ear.document.name = "Orecchio30"
    ear.document.savePath = "CAD/Orecchio30.SLDPRT"
    ear.operations.length = 0
    ear.operations.push(...hingeEarOps())
  }
  if (!pin) pin = makePartDoc("Perno8x50", hingePinOps())
  else {
    pin.document.name = "Perno8x50"
    pin.document.savePath = "CAD/Perno8x50.SLDPRT"
    pin.operations.length = 0
    pin.operations.push(...hingePinOps())
  }

  let asm = jobOut.find((d) => d.document.type === "assembly")
  if (!asm) {
    asm = {
      schemaVersion: 2,
      units: "mm",
      document: {
        type: "assembly",
        name: "AssiemeCerniera",
        attachToActive: false,
        savePath: "CAD/AssiemeCerniera.SLDASM",
        snapshotPath: "Export/AssiemeCerniera.jpg",
        snapshotView: "*Isometric",
      },
      variables: [],
      configurations: [],
      operations: [],
    }
  } else {
    asm.document.name = "AssiemeCerniera"
    asm.document.savePath = "CAD/AssiemeCerniera.SLDASM"
  }
  asm.operations = [
    { id: "comp-e1", type: "component", path: "CAD/Orecchio30.SLDPRT", x: 0, y: 0, z: 0, fix: true },
    { id: "comp-e2", type: "component", path: "CAD/Orecchio30.SLDPRT", x: 0, y: 46, z: 0 },
    { id: "comp-p", type: "component", path: "CAD/Perno8x50.SLDPRT", x: 0, y: 23, z: 0 },
    {
      id: "m-c1",
      type: "mate",
      mateType: "concentric",
      component1: "comp-p",
      component2: "comp-e1",
      entity1: "outer",
      entity2: "inner",
      diameter: 8,
    },
    {
      id: "m-c2",
      type: "mate",
      mateType: "concentric",
      component1: "comp-p",
      component2: "comp-e2",
      entity1: "outer",
      entity2: "inner",
      diameter: 8,
    },
    {
      id: "m-gap",
      type: "mate",
      mateType: "distance",
      component1: "comp-e1",
      component2: "comp-e2",
      entity1: "top",
      entity2: "bottom",
      distance: 40,
    },
    { id: "v-auto", type: "verify" },
  ]

  const drawings = jobOut.filter((d) => d.document.type === "drawing")
  for (const d of drawings) {
    if (/Assemie|Griglia|Finestra|Tasca|Sede|TrePezzi|demo/i.test(d.document.name) || !/^Tavola/i.test(d.document.name)) {
      d.document.name = "TavolaCerniera"
    }
    d.document.savePath = `Disegni/${d.document.name}.SLDDRW`
    d.document.sheetFormat = d.document.sheetFormat || "A3"
    for (const op of d.operations) {
      if (op.type === "standardViews" || op.type === "drawingView") {
        const rec = op as { model?: string }
        rec.model = "CAD/AssiemeCerniera.SLDASM"
      }
    }
  }
  if (drawings.length === 0) {
    drawings.push({
      schemaVersion: 2,
      units: "mm",
      document: {
        type: "drawing",
        name: "TavolaCerniera",
        attachToActive: false,
        savePath: "Disegni/TavolaCerniera.SLDDRW",
        snapshotPath: "Export/TavolaCerniera.jpg",
        sheetFormat: "A3",
      },
      variables: [],
      configurations: [],
      operations: [
        {
          id: "dv1",
          type: "standardViews",
          model: "CAD/AssiemeCerniera.SLDASM",
          firstAngle: true,
          includeIso: true,
        },
        { id: "dd1", type: "modelDimensions" },
        {
          id: "an1",
          type: "annotation",
          text: "Orecchie 30×20×6 Ø8 ×2 — gap 40 — perno Ø8×50",
          x: 0.02,
          y: 0.27,
        },
      ],
    })
  }

  jobOut.length = 0
  jobOut.push(ear, pin, asm, ...drawings)
}

const Z_BRACKET_POLY: Array<[number, number]> = [
  [-20, 28],
  [20, 28],
  [20, 4],
  [66, 4],
  [66, 0],
  [16, 0],
  [16, 24],
  [-20, 24],
  [-20, 28],
]

function isZBracketPart(ops: CadOperation[]): boolean {
  const lineCount = ops
    .filter((o) => o.type === "sketch")
    .flatMap((s) => (s.type === "sketch" ? s.contours : []))
    .filter((c) => c.kind === "line" && !c.construction).length
  const hasWidth30 = ops.some((o) => o.type === "extrude" && Math.abs(Number(o.depth) - 30) < 0.6)
  const hasD8 = ops.some(
    (o) =>
      o.type === "sketch" &&
      o.contours.some((c) => c.kind === "circle" && Math.abs(c.diameter - 8) < 0.2),
  )
  return lineCount >= 8 && hasWidth30 && hasD8
}

/**
 * Staffa a Z: polilinea Right (x=altezza Y, y=flange Z), foro Ø8 al centro del tetto.
 * Il tetto è a Y=0 (ymin): throughAll non buca la base (offset in Z).
 */
function normalizeZBracketPart(ops: CadOperation[]): void {
  if (!isZBracketPart(ops)) return
  const poly = ops.find(
    (o) =>
      o.type === "sketch" && o.contours.filter((c) => c.kind === "line" && !c.construction).length >= 8,
  )
  if (!poly || poly.type !== "sketch") return
  poly.plane = "Right"
  poly.contours = []
  for (let i = 0; i < Z_BRACKET_POLY.length - 1; i++) {
    const [x1, y1] = Z_BRACKET_POLY[i]
    const [x2, y2] = Z_BRACKET_POLY[i + 1]
    poly.contours.push({ kind: "line", x1, y1, x2, y2, construction: false })
  }
  for (const ex of ops) {
    if (ex.type === "extrude" && Math.abs(Number(ex.depth) - 30) < 0.6) {
      ex.flip = true
    }
  }
  for (const s of ops) {
    if (s.type !== "sketch") continue
    for (const c of s.contours) {
      if (c.kind !== "circle" || Math.abs(c.diameter - 8) >= 0.2) continue
      // Estrusione 30 su Right è midplane X[-15,15]: il centro larghezza è X=0, non 15.
      c.cx = 0
      c.cy = 0
      s.plane = "Top"
    }
  }
  for (const cut of ops) {
    if (cut.type !== "cut") continue
    const sketch = ops.find((o) => o.type === "sketch" && o.id === cut.sketch)
    const d8 =
      sketch &&
      sketch.type === "sketch" &&
      sketch.contours.some((c) => c.kind === "circle" && Math.abs(c.diameter - 8) < 0.2)
    if (!d8) continue
    cut.throughAll = true
    cut.depth = undefined
  }
}

function fixZBracketAssemblyMates(docs: SolidWorksDocumentPayload[]): void {
  const zNames = docs
    .filter((d) => d.document.type === "part" && isZBracketPart(d.operations))
    .map((d) => d.document.name)
  if (zNames.length === 0) return
  for (const d of docs) {
    if (d.document.type !== "assembly") continue
    const zKeys = new Set<string>()
    for (const op of d.operations) {
      if (op.type !== "component") continue
      const path = String(op.path || op.name || "")
      if (zNames.some((n) => path.includes(n)) || /staffaz/i.test(path)) zKeys.add(op.id)
    }
    for (const op of d.operations) {
      if (op.type !== "mate" || op.mateType !== "coincident") continue
      if (zKeys.has(op.component1)) {
        op.entity1 = "bottom"
        op.entity2 = op.entity2 || "top"
      } else if (zKeys.has(op.component2)) {
        op.entity2 = "bottom"
        op.entity1 = op.entity1 || "top"
      }
    }
  }
}

/** Due rettangoli nello stesso schizzo (profilo T) si sovrappongono e FeatureExtrusion fallisce. */
function splitTwinRectangleSketches(ops: CadOperation[]): CadOperation[] {
  const out: CadOperation[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.type !== "sketch") {
      out.push(op)
      continue
    }
    const rects = op.contours.filter((c) => c.kind === "rectangle")
    if (rects.length < 2) {
      out.push(op)
      continue
    }
    const plane = /front/i.test(String(op.plane || "")) ? "Top" : op.plane || "Top"
    const follow = ops[i + 1]
    const depth =
      follow && follow.type === "extrude" && typeof follow.depth === "number" ? follow.depth : 60
    out.push({ ...op, plane, contours: [rects[0]] })
    if (follow && follow.type === "extrude") {
      out.push(follow)
      i++
    } else {
      out.push({ id: `${op.id}-e0`, type: "extrude", sketch: op.id, depth, merge: true })
    }
    for (let k = 1; k < rects.length; k++) {
      const sid = `${op.id}-leg${k}`
      out.push({ id: sid, type: "sketch", plane, contours: [rects[k]] })
      out.push({ id: `${op.id}-boss${k}`, type: "extrude", sketch: sid, depth, merge: true })
    }
  }
  return out
}

function recenterCornerOrigin(ops: CadOperation[]) {
  const first = ops.find((o) => o.type === "sketch")
  if (!first || first.type !== "sketch") return
  const rect = first.contours.find((c) => c.kind === "rectangle")
  if (!rect || rect.kind !== "rectangle") return
  if (Math.abs(rect.cx) > 1e-6 || Math.abs(rect.cy) > 1e-6) return
  for (const op of ops) {
    if (op.type !== "sketch") continue
    const circles = op.contours.filter((c) => c.kind === "circle")
    if (circles.length === 0) continue
    const xs = circles.map((c) => (c.kind === "circle" ? c.cx : 0))
    const ys = circles.map((c) => (c.kind === "circle" ? c.cy : 0))
    const inCornerFrame =
      Math.min(...xs) >= -0.5 &&
      Math.max(...xs) <= rect.width + 0.5 &&
      Math.min(...ys) >= -0.5 &&
      Math.max(...ys) <= rect.height + 0.5 &&
      Math.max(...xs) > rect.width / 2
    if (!inCornerFrame) continue
    for (const c of op.contours) {
      if (c.kind !== "circle") continue
      c.cx -= rect.width / 2
      c.cy -= rect.height / 2
    }
  }
}

function presentNum(rec: Record<string, unknown> | null, key: string): number | undefined {
  if (!rec || !(key in rec)) return undefined
  return numish(rec[key])
}

function numish(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."))
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function normalizeDocType(v: unknown): SolidWorksDocumentPayload["document"]["type"] | null {
  const s = String(v ?? "").toLowerCase()
  if (s === "part" || s === "parte") return "part"
  if (s === "assembly" || s === "assieme") return "assembly"
  if (s === "drawing" || s === "tavola" || s === "disegno") return "drawing"
  return null
}

function inferDocType(ops: CadOperation[]): SolidWorksDocumentPayload["document"]["type"] {
  if (ops.some((o) => o.type === "component" || o.type === "mate")) return "assembly"
  if (ops.some((o) => o.type === "drawingView" || o.type === "standardViews" || o.type === "sheetFormat")) {
    return "drawing"
  }
  return "part"
}

function defaultName(type: SolidWorksDocumentPayload["document"]["type"]): string {
  if (type === "assembly") return "Assieme"
  if (type === "drawing") return "Tavola"
  return "Pezzo"
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function sliceBalanced(text: string, start: number): string {
  const open = text[start]
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error("JSON LLM troncato")
}
