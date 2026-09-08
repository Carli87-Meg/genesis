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
  const summaryOut =
    summary ||
    (jobOut
      ? `Kit ${jobOut.length} documenti: ${jobOut.map((d) => d.document.name).join(", ")}.`
      : `Modello con ${payload.operations.length} operazioni.`)

  return {
    result: {
      summary: summaryOut,
      source: "openrouter",
      operations: jobOut ? jobOut.flatMap((d) => d.operations) : payload.operations,
      payload,
      job: jobOut,
      dfm: runDfm(payload),
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
    next.contours = next.contours.map(normalizeContour).filter(Boolean)
  }
  if (aliased === "standardViews" || aliased === "drawingView") {
    if (typeof next.model !== "string" || !next.model.trim()) {
      const alt = [next.modelPath, next.path, next.file, next.assembly].find(
        (v) => typeof v === "string" && v.trim(),
      )
      if (typeof alt === "string") next.model = alt
    }
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
  if (kind === "circ" || kind === "circle" || kind === "arc") {
    const diameter = numish(rec.diameter) ?? (numish(rec.radius) != null ? numish(rec.radius)! * 2 : 0)
    return { ...rest, kind: "circle", cx, cy, diameter }
  }
  if (kind === "line" || kind === "linea") return { ...rest, kind: "line" }
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
