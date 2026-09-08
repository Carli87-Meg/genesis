import { interpretDemo } from "@/lib/demo-interpreter"
import { interpretFromLlmText } from "@/lib/llm-payload"
import { DEFAULT_OPENROUTER_MODEL } from "@/lib/openrouter-models"
import { redactSecrets, resolveOpenRouterKey } from "@/lib/or-key"
import { runDfm } from "@/lib/dfm"
import type { InterpretResult, SolidWorksDocumentPayload } from "@/lib/payload"

export const maxDuration = 120

const SYSTEM = `You are a SolidWorks CAD compiler for Solidworks_IA.
Understand Italian and English. Output ONLY valid JSON. No markdown, no commentary.

Emit a SolidWorksDocumentPayload schema v2 object (not a {summary,payload} wrapper):
{
  "schemaVersion": 2,
  "units": "mm",
  "document": {
    "type": "part"|"assembly"|"drawing",
    "name": "PascalCaseName",
    "attachToActive": false,
    "savePath": "CAD/Name.SLDPRT"|"CAD/Name.SLDASM"|"Disegni/Name.SLDDRW",
    "snapshotPath": "Export/Name.jpg",
    "sheetFormat": "A3"
  },
  "variables": [],
  "configurations": [],
  "operations": [ { "id": "s1", "type": "sketch", ... } ],
  "job": [ /* optional extra documents, same shape */ ]
}
schemaVersion is the number 2. units is always "mm".
Every operation MUST have a string field "type". Never { "sketch": { ... } } as the only key.
Sketch origin = plate center. rectangle/circle use cx,cy (not centerX, not position).
Planes: Front|Top|Right. ISO Italian: Piano superiore = XZ, extrude along +Y.
Ops: sketch (plane, contours rectangle|circle|line), extrude (sketch id, depth mm, merge),
cut (sketch id, throughAll true for holes), revolve, hole, fillet, chamfer, shell, pattern,
component (path, x,y,z, fix), mate (coincident|concentric, component1/2, entity1/2 inner|outer|top|bottom|pad, diameter mm),
sheetFormat (format A3|A2), standardViews (model: assembly or part savePath, firstAngle true, includeIso true),
modelDimensions, annotation (text, x, y).
Every feature sketch MUST be fully quoted (width, height, hole Ø, offsets from origin/edges).
The bridge adds visible SolidWorks sketch dimensions (FullyDefineSketch / AddDimension2) on every ProfileFeature, including hole/cut sketches. Keep holes on a separate sketch+cut when they are not on the boss profile.
No fillet unless the user asks: FeatureFillet is unreliable.

Single part: omit "job".
If the user asks for bushing/boccola AND drawing/tavola/A3 (kit): root document is the main part,
"job" is an array of 4 payloads in order: part, bushing, assembly, drawing.
- Part: L-bracket 80×50×8 on Top, wall 80×8 extruded 40 mm on +Z edge, boss Ø16 height 14, 4 holes Ø6.5 at corners, guide bore Ø10.2 at center, cut throughAll. Names StaffaFissaggio, CAD/StaffaFissaggio.SLDPRT.
- Bushing: circles Ø16 and Ø10.2, extrude 12 mm. BoccolaGuida, CAD/BoccolaGuida.SLDPRT.
- Assembly: component staffa (fix) + boccola; concentric inner-inner diameter 10.2; coincident bottom bushing / top pad. AssiemeStaffa, CAD/AssiemeStaffa.SLDASM.
- Drawing: document.sheetFormat "A3" (Cartiglio_CM / PARTE_A3_CM.slddrt), sheetFormat op format "A3",
  standardViews model "CAD/AssiemeStaffa.SLDASM", modelDimensions, annotation. TavolaStaffa, Disegni/TavolaStaffa.SLDDRW.
When the user says tavola A3 CM / Cartiglio CM: always sheetFormat A3, never a missing .drwdot.

If the user asks for scala / telaio / fiancate / scalini / modulo scala (not the L-bracket):
Do NOT emit the staffa kit.
job = each unique prismatic part, then one assembly, then drawing if tavola/A3 is asked.
Typical module (keep under 8 documents): FiancataSx, FiancataDx (plate 40×8, length along X, 2 holes Ø8), Scalino1, Scalino2 (width × 220 × 6, 2 holes Ø8), optional Piede 80×80×8.
Assembly: one stringer fixed; coincident face mates and concentric on Ø8 holes. Paths CAD/Name.SLDPRT.
Drawing: A3 Cartiglio_CM, standardViews.model = assembly savePath.
Unique operation ids across the whole job. No sheet metal, weldments, or imported geometry.`

type InterpretBody = {
  prompt?: string
  followUp?: boolean
  previous?: SolidWorksDocumentPayload
  openRouterKey?: string
  apiKey?: string
  token?: string
  model?: string
  useStoredKey?: boolean
}

export async function POST(req: Request) {
  const started = Date.now()
  let body: InterpretBody
  try {
    body = (await req.json()) as InterpretBody
  } catch {
    return Response.json({ error: "JSON non valido" }, { status: 400 })
  }

  const prompt = (body.prompt ?? "").trim()
  if (!prompt) {
    return Response.json({ error: "Prompt vuoto" }, { status: 400 })
  }

  const { key, keySource } = await resolveOpenRouterKey({
    headerKey: req.headers.get("x-openrouter-key"),
    authHeader: req.headers.get("authorization"),
    bodyKey: body.openRouterKey || body.apiKey || body.token,
    envKey: process.env.OPENROUTER_API_KEY,
    allowFile: body.useStoredKey === true,
  })
  const model =
    (req.headers.get("x-openrouter-model")?.trim() ||
      body.model?.trim() ||
      process.env.OPENROUTER_MODEL ||
      DEFAULT_OPENROUTER_MODEL).trim()

  if (!key) {
    const demo = interpretDemo(prompt)
    demo.hasKey = false
    demo.keySource = "none"
    console.info(
      `[interpret] demo keySource=none model=${model} promptLen=${prompt.length} ops=${demo.operations.length} ms=${Date.now() - started}`,
    )
    return Response.json(demo)
  }

  try {
    const llm = await callOpenRouter(key, model, prompt, body.followUp ? body.previous : undefined)
    llm.hasKey = true
    llm.keySource = keySource
    llm.model = model
    console.info(
      `[interpret] openrouter keySource=${keySource} model=${model} ops=${llm.operations.length} ms=${Date.now() - started}`,
    )
    return Response.json(llm)
  } catch (err) {
    const raw = redactSecrets(err instanceof Error ? err.message : String(err))
    const error = openRouterUserMessage(raw)
    console.info(
      `[interpret] FAIL keySource=${keySource} model=${model} ms=${Date.now() - started} ${raw.slice(0, 160)}`,
    )
    return Response.json(
      {
        error,
        summary: error,
        source: "openrouter",
        warning: raw,
        hasKey: true,
        keySource,
        model,
        operations: [],
        dfm: [],
      } satisfies Partial<InterpretResult> & { error: string },
      { status: 502 },
    )
  }
}

function openRouterUserMessage(raw: string): string {
  if (/HTTP 401|user not found|invalid api key|unauthorized/i.test(raw)) {
    return "OpenRouter ha rifiutato la chiave (401). Incolla una chiave valida in Impostazioni. Non creo un pezzo demo al posto di quello richiesto."
  }
  if (/HTTP 402|credits|payment/i.test(raw)) {
    return "Credito OpenRouter esaurito. Non creo un pezzo demo al posto di quello richiesto."
  }
  if (/HTTP 429/i.test(raw)) {
    return "OpenRouter: troppe richieste. Riprova tra poco. Non creo un pezzo demo al posto di quello richiesto."
  }
  return `OpenRouter non ha prodotto un pezzo. ${raw} Non uso la demo: con una chiave impostata il pezzo sbagliato non viene creato.`
}

async function callOpenRouter(
  key: string,
  model: string,
  prompt: string,
  previous?: SolidWorksDocumentPayload,
): Promise<InterpretResult> {
  const user = previous
    ? `Documento corrente:\n${JSON.stringify(previous)}\n\nModifica richiesta:\n${prompt}`
    : prompt

  const payload = {
    model,
    temperature: 0.1,
    max_tokens: 16384,
    response_format: { type: "json_object" as const },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
  }

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://127.0.0.1:4317",
    "X-Title": "Solidworks_IA",
  }

  let res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    cache: "no-store",
    headers,
    body: JSON.stringify(payload),
  })

  if (!res.ok && (res.status === 400 || res.status === 422)) {
    const { response_format: _, ...withoutFmt } = payload
    void _
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify(withoutFmt),
    })
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[]
    error?: { message?: string }
  }
  if (data.error?.message) {
    throw new Error(data.error.message)
  }
  const choice = data.choices?.[0]
  const content = choice?.message?.content ?? ""
  if (choice?.finish_reason === "length") {
    throw new Error("risposta LLM troncata (max tokens); riprova con un pezzo più semplice")
  }
  if (!content.trim()) {
    throw new Error(`risposta LLM vuota (finish=${choice?.finish_reason || "-"})`)
  }

  const { result, meta } = interpretFromLlmText(content, model)
  if (meta.parse === "repaired" && meta.droppedOps > 0) {
    result.warning = `JSON LLM riparato: ${meta.droppedOps} operazioni non riconosciute ignorate.`
  }
  result.dfm = runDfm(result.payload)
  return result
}
