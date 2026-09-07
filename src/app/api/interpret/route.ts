import { interpretDemo, isFixtureKitPrompt } from "@/lib/demo-interpreter"
import { runDfm } from "@/lib/dfm"
import type { InterpretResult, SolidWorksDocumentPayload } from "@/lib/payload"

const SYSTEM = `Sei un interprete CAD per Solidworks_IA.
Rispondi SOLO con JSON valido, senza markdown, schema SolidWorksDocumentPayload versione 2.
Unità sempre mm.
Forma:
{
  "summary": "stringa italiana breve",
  "payload": { ... primo documento ... },
  "job": [ payloadParte, payloadBoccola, payloadAssieme, payloadTavola ]
}
Se il prompt è un pezzo unico, ometti "job" e metti tutto in payload.
Campi document: type, name, attachToActive false, savePath relativo (CAD/Nome.SLDPRT | CAD/Nome.SLDASM | Disegni/Nome.SLDDRW), snapshotPath Export/Nome.jpg, sheetFormat "A3" sulle tavole.
Operazioni ammesse: sketch (plane Front|Top|Right, contours rectangle|circle|line),
extrude (depth mm, merge), cut (throughAll true per fori passanti), revolve, hole, fillet, chamfer, shell,
pattern, component (path, x,y,z, fix), mate (coincident|concentric, entity1/entity2: inner|outer|top|bottom|pad, diameter mm per il foro giusto),
drawingView, standardViews (model path, includeIso, firstAngle), modelDimensions, annotation, sheetFormat (format A3|A2).
Niente fillet se non richiesto: FeatureFillet è inaffidabile.
ISO italiano: Piano superiore = XZ, estrusione lungo +Y.
Staffa a L: piastra 80x50x8 su Top, parete 80x8 estrusa 40 mm sul bordo +Z, boss Ø16 alto 14 mm, poi 4 fori Ø6.5 agli angoli e foro guida Ø10.2 al centro (cut throughAll).
Boccola: due cerchi Ø16 e Ø10.2 + estrusione 12 mm.
Assieme: component staffa (fix) + boccola; mate concentrico inner-inner diameter 10.2; coincidente bottom boccola / pad staffa.
Tavola: sheetFormat A3 (Cartiglio_CM PARTE_A3_CM), standardViews dell'assieme, modelDimensions, annotation.
Piastra semplice: rettangolo + estrusione + cerchi + cut throughAll.
Perno: cerchio su Top + estrusione.
Rondella: due cerchi + estrusione.`

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    prompt?: string
    followUp?: boolean
    previous?: SolidWorksDocumentPayload
  }
  const prompt = (body.prompt ?? "").trim()
  if (!prompt) {
    return Response.json({ error: "Prompt vuoto" }, { status: 400 })
  }

  const headerKey = req.headers.get("x-openrouter-key")?.trim() ?? ""
  const envKey = process.env.OPENROUTER_API_KEY?.trim() ?? ""
  const key = headerKey || envKey
  const model =
    req.headers.get("x-openrouter-model")?.trim() ||
    process.env.OPENROUTER_MODEL ||
    "openai/gpt-4o-mini"

  if (!key) {
    const demo = interpretDemo(prompt)
    return Response.json(demo)
  }

  try {
    const llm = await callOpenRouter(key, model, prompt, body.previous)
    if (isFixtureKitPrompt(prompt) && !isRichKit(llm)) {
      const demo = interpretDemo(prompt)
      demo.warning =
        "OpenRouter non ha prodotto il kit (parte+boccola+assieme+tavola); uso demo locale."
      return Response.json(demo)
    }
    return Response.json(llm)
  } catch (err) {
    const demo = interpretDemo(prompt)
    demo.warning = `OpenRouter non disponibile, uso demo. ${err instanceof Error ? err.message : String(err)}`
    return Response.json(demo)
  }
}

function isRichKit(r: InterpretResult): boolean {
  if ((r.job?.length ?? 0) >= 3) return true
  const ops = r.job?.flatMap((d) => d.operations) ?? r.payload.operations
  const hasAssy = (r.job ?? [r.payload]).some((d) => d.document.type === "assembly")
  const hasDraw = (r.job ?? [r.payload]).some((d) => d.document.type === "drawing")
  const hasWall = ops.some((o) => o.type === "extrude" && o.depth >= 30)
  return hasAssy && hasDraw && hasWall
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

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://127.0.0.1:4317",
      "X-Title": "Solidworks_IA",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content ?? ""
  const parsed = extractJson(content) as {
    summary?: string
    payload?: SolidWorksDocumentPayload
    job?: SolidWorksDocumentPayload[]
  }

  const job = Array.isArray(parsed.job)
    ? parsed.job.filter((d) => d && d.schemaVersion === 2 && Array.isArray(d.operations))
    : undefined
  const payload = (job && job[0]) || parsed.payload
  if (!payload || payload.schemaVersion !== 2 || !Array.isArray(payload.operations)) {
    throw new Error("JSON LLM senza payload schemaVersion 2")
  }

  payload.units = "mm"
  payload.schemaVersion = 2
  payload.variables ??= []
  payload.configurations ??= []
  if (job) {
    for (const d of job) {
      d.units = "mm"
      d.schemaVersion = 2
      d.variables ??= []
      d.configurations ??= []
    }
  }

  return {
    summary: parsed.summary || `Modello con ${payload.operations.length} operazioni.`,
    source: "openrouter",
    operations: job ? job.flatMap((d) => d.operations) : payload.operations,
    payload,
    job: job && job.length > 1 ? job : undefined,
    dfm: runDfm(payload),
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fence ? fence[1] : trimmed
  return JSON.parse(raw)
}
