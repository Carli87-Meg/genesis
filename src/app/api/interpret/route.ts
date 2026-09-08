import { interpretDemo } from "@/lib/demo-interpreter"
import { interpretFromLlmText } from "@/lib/llm-payload"
import { DEFAULT_OPENROUTER_MODEL } from "@/lib/openrouter-models"
import { redactSecrets, resolveOpenRouterKey } from "@/lib/or-key"
import { runDfm } from "@/lib/dfm"
import type { InterpretResult, SolidWorksDocumentPayload } from "@/lib/payload"

export const maxDuration = 60

const SYSTEM = `Sei un interprete CAD per Solidworks_IA.
Rispondi SOLO con un oggetto JSON valido, senza markdown e senza testo intorno.
Schema SolidWorksDocumentPayload versione 2, unità mm.
Forma:
{
  "summary": "stringa italiana breve",
  "payload": {
    "schemaVersion": 2,
    "units": "mm",
    "document": { "type": "part", "name": "Nome", "attachToActive": false, "savePath": "CAD/Nome.SLDPRT", "snapshotPath": "Export/Nome.jpg" },
    "variables": [],
    "configurations": [],
    "operations": []
  },
  "job": [ payloadParte, payloadBoccola, payloadAssieme, payloadTavola ]
}
schemaVersion deve essere il numero 2 (non stringa). Includi sempre operations (array, anche di un solo documento).
Ogni operazione è un oggetto con campo "type" (sketch|extrude|cut|...), mai { "sketch": { ... } } come unica chiave.
Se il prompt è un pezzo unico, ometti "job" e metti tutto in payload.
Operazioni ammesse: sketch (plane Front|Top|Right, contours rectangle|circle|line),
extrude (depth mm, merge), cut (throughAll true per fori passanti), revolve, hole, fillet, chamfer, shell,
pattern, component (path, x,y,z, fix), mate (coincident|concentric, entity1/entity2: inner|outer|top|bottom|pad, diameter mm),
drawingView, standardViews (model path, includeIso, firstAngle), modelDimensions, annotation, sheetFormat (format A3|A2).
Niente fillet se non richiesto: FeatureFillet è inaffidabile.
ISO italiano: Piano superiore = XZ, estrusione lungo +Y.
Staffa a L: piastra 80x50x8 su Top, parete 80x8 estrusa 40 mm sul bordo +Z, boss Ø16 alto 14 mm, poi 4 fori Ø6.5 agli angoli e foro guida Ø10.2 al centro (cut throughAll).
Boccola: due cerchi Ø16 e Ø10.2 + estrusione 12 mm.
Assieme: component staffa (fix) + boccola; mate concentrico inner-inner diameter 10.2; coincidente bottom boccola / pad staffa.
Tavola: sheetFormat A3, standardViews dell'assieme, modelDimensions, annotation.
Piastra semplice: rettangolo + estrusione + cerchi + cut throughAll.
Perno: cerchio su Top + estrusione.
Rondella: due cerchi + estrusione.`

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
      `[interpret] openrouter keySource=${keySource} keyLen=${key.length} model=${model} ops=${llm.operations.length} ms=${Date.now() - started}`,
    )
    return Response.json(llm)
  } catch (err) {
    const raw = redactSecrets(err instanceof Error ? err.message : String(err))
    const error = openRouterUserMessage(raw)
    console.info(
      `[interpret] FAIL keySource=${keySource} keyLen=${key.length} model=${model} ms=${Date.now() - started} ${raw.slice(0, 160)}`,
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
