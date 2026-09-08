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
  cutextrude: "cut",
  "cut-extrude": "cut",
  cutthrough: "cut",
  revolution: "revolve",
  revolve2: "revolve",
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

  let payloadPair =
    (job && job[0]) ||
    coerceDocument(root.payload) ||
    coerceDocument(root) ||
    null

  if (!payloadPair || payloadPair.doc.operations.length === 0) {
    throw new Error("JSON LLM senza operations schema v2")
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
  const aliased = TYPE_ALIAS[String(rec.type ?? "").trim().toLowerCase()] || String(rec.type ?? "").trim()
  if (!OP_TYPES.has(aliased)) return null
  const id = typeof rec.id === "string" && rec.id.trim() ? rec.id : `op${index + 1}`
  const next: Record<string, unknown> = { ...rec, id, type: aliased }
  if (aliased === "sketch" && typeof next.plane === "string") {
    const p = PLANE_ALIAS[next.plane.trim().toLowerCase()]
    if (p) next.plane = p
  }
  if (aliased === "sketch" && Array.isArray(next.contours)) {
    next.contours = next.contours.map(normalizeContour).filter(Boolean)
  }
  return next as CadOperation
}

function normalizeContour(raw: unknown): unknown {
  const rec = asRecord(raw)
  if (!rec) return null
  const kind = String(rec.kind ?? rec.type ?? "").toLowerCase()
  if (kind === "rect" || kind === "rectangle") return { ...rec, kind: "rectangle" }
  if (kind === "circ" || kind === "circle" || kind === "arc") return { ...rec, kind: "circle" }
  if (kind === "line" || kind === "linea") return { ...rec, kind: "line" }
  if (rec.kind === "rectangle" || rec.kind === "circle" || rec.kind === "line") return rec
  return null
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
