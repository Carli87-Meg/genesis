import type { CadOperation, InterpretResult, SolidWorksDocumentPayload } from "./payload"
import { runDfm } from "./dfm"

const OP_TYPES = new Set([
  "sketch",
  "extrude",
  "cut",
  "revolve",
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

  const root = asRecord(parsed)
  if (!root) {
    throw new Error("JSON LLM non è un oggetto")
  }

  const summary = typeof root.summary === "string" ? root.summary : ""
  const jobRaw = Array.isArray(root.job) ? root.job : undefined
  const job = jobRaw
    ?.map((d) => coerceDocument(d))
    .filter((d): d is { doc: SolidWorksDocumentPayload; dropped: number } => d !== null)

  const payloadRec = asRecord(root.payload)
  const rootOps = Array.isArray(root.operations) ? root.operations.length : -1
  const payloadOpsRaw = payloadRec && Array.isArray(payloadRec.operations) ? payloadRec.operations : []
  const payloadOps = payloadOpsRaw.length || -1
  const rawTypes = payloadOpsRaw.map((o) => {
    const r = asRecord(o)
    return r ? String(r.type ?? r.kind ?? r.op ?? r.operation ?? r.feature ?? "") : typeof o
  })
  const rawKeys = payloadOpsRaw.slice(0, 3).map((o) => {
    const r = asRecord(o)
    return r ? Object.keys(r).join("+") : typeof o
  })

  let payloadPair =
    (job && job[0]) ||
    coerceDocument(root.payload) ||
    coerceDocument(root) ||
    null

  if (!payloadPair || payloadPair.doc.operations.length === 0) {
    const jobLen = Array.isArray(root.job) ? root.job.length : 0
    const jobOps = job?.map((j) => j.doc.operations.length) ?? []
    throw new Error(
      `JSON LLM senza operations schema v2 (keys=${Object.keys(root).join(",")} rootOps=${rootOps} payloadOps=${payloadOps} types=${rawTypes.join("|") || "-"} opKeys=${rawKeys.join(";") || "-"} jobLen=${jobLen} jobOps=${jobOps.join("+") || "-"})`,
    )
  }

  const droppedOps = (job ?? [payloadPair]).reduce((n, p) => n + p.dropped, 0)
  const payload = payloadPair.doc
  const jobDocs = job && job.length > 1 ? job.map((j) => j.doc) : undefined

  return {
    result: {
      summary: summary || `Modello con ${payload.operations.length} operazioni.`,
      source: "openrouter",
      operations: jobDocs ? jobDocs.flatMap((d) => d.operations) : payload.operations,
      payload,
      job: jobDocs,
      dfm: runDfm(payload),
      model,
    },
    meta: {
      parse: repaired || droppedOps > 0 ? "repaired" : "ok",
      droppedOps,
    },
  }
}

function coerceDocument(raw: unknown): { doc: SolidWorksDocumentPayload; dropped: number } | null {
  const rec = asRecord(raw)
  if (!rec) return null

  const opsRaw = rec.operations
  if (!Array.isArray(opsRaw)) return null

  const operations: CadOperation[] = []
  let dropped = 0
  for (let i = 0; i < opsRaw.length; i++) {
    const op = normalizeOp(opsRaw[i], i)
    if (op) operations.push(op)
    else dropped++
  }
  if (operations.length === 0) return null
  linkSketches(operations)
  recenterCornerOrigin(operations)

  const documentIn = asRecord(rec.document) ?? {}
  const type = normalizeDocType(documentIn.type) ?? inferDocType(operations)
  const name =
    (typeof documentIn.name === "string" && documentIn.name.trim()) ||
    (typeof rec.name === "string" && rec.name.trim()) ||
    defaultName(type)

  const doc: SolidWorksDocumentPayload = {
    schemaVersion: 2,
    units: "mm",
    document: {
      type,
      name,
      attachToActive: documentIn.attachToActive === true,
      savePath: typeof documentIn.savePath === "string" ? documentIn.savePath : undefined,
      snapshotPath: typeof documentIn.snapshotPath === "string" ? documentIn.snapshotPath : undefined,
      snapshotView: typeof documentIn.snapshotView === "string" ? documentIn.snapshotView : "*Isometric",
      openPath: typeof documentIn.openPath === "string" ? documentIn.openPath : undefined,
      sheetFormat: typeof documentIn.sheetFormat === "string" ? documentIn.sheetFormat : type === "drawing" ? "A3" : undefined,
    },
    variables: Array.isArray(rec.variables) ? (rec.variables as SolidWorksDocumentPayload["variables"]) : [],
    configurations: Array.isArray(rec.configurations)
      ? (rec.configurations as SolidWorksDocumentPayload["configurations"])
      : [],
    operations,
  }
  return { doc, dropped }
}

function normalizeOp(raw: unknown, index: number): CadOperation | null {
  const rec = asRecord(raw)
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
    next.contours = next.contours.map(normalizeContour).filter(Boolean)
  }
  return next as CadOperation
}

function inferOpType(rec: Record<string, unknown>): string {
  if (Array.isArray(rec.contours) || rec.plane) return "sketch"
  if (rec.throughAll === true) return "cut"
  if (typeof rec.depth === "number" && rec.sketch) return "extrude"
  if (typeof rec.depth === "number") return rec.cut ? "cut" : "extrude"
  if (typeof rec.diameter === "number") return "hole"
  if (typeof rec.angle === "number") return "revolve"
  return ""
}

function normalizeContour(raw: unknown): unknown {
  const rec = asRecord(raw)
  if (!rec) return null
  const kind = String(rec.kind ?? rec.type ?? "").toLowerCase()
  const pos = asRecord(rec.position)
  const cx = numish(rec.cx) ?? numish(pos?.x) ?? numish(rec.x) ?? 0
  const cy = numish(rec.cy) ?? numish(pos?.y) ?? numish(rec.y) ?? 0
  if (kind === "rect" || kind === "rectangle") {
    const width = numish(rec.width) ?? 0
    const height = numish(rec.height) ?? 0
    return { ...rec, kind: "rectangle", cx, cy, width, height }
  }
  if (kind === "circ" || kind === "circle" || kind === "arc") {
    const diameter = numish(rec.diameter) ?? (numish(rec.radius) != null ? numish(rec.radius)! * 2 : 0)
    return { ...rec, kind: "circle", cx, cy, diameter }
  }
  if (kind === "line" || kind === "linea") return { ...rec, kind: "line" }
  if (rec.kind === "rectangle" || rec.kind === "circle" || rec.kind === "line") {
    return { ...rec, cx: numish((rec as { cx?: unknown }).cx) ?? cx, cy: numish((rec as { cy?: unknown }).cy) ?? cy }
  }
  return null
}

function linkSketches(ops: CadOperation[]) {
  let lastSketch = ""
  for (const op of ops) {
    if (op.type === "sketch") {
      lastSketch = op.id
      continue
    }
    if ((op.type === "extrude" || op.type === "cut" || op.type === "revolve") && lastSketch) {
      const rec = op as CadOperation & { sketch?: string }
      if (!rec.sketch) rec.sketch = lastSketch
    }
  }
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
