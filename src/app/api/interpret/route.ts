import { interpretDemo } from "@/lib/demo-interpreter"
import { runDfm } from "@/lib/dfm"
import type { InterpretResult, SolidWorksDocumentPayload } from "@/lib/payload"

const SYSTEM = `Sei un interprete CAD per Solidworks_IA.
Rispondi SOLO con JSON valido, senza markdown, schema SolidWorksDocumentPayload versione 2.
Unità sempre mm.
Forma:
{
  "summary": "stringa italiana breve",
  "payload": {
    "schemaVersion": 2,
    "units": "mm",
    "document": { "type": "part"|"assembly"|"drawing", "name": "string", "attachToActive": false },
    "variables": [{ "name": "L", "value": 80 }],
    "configurations": [],
    "operations": []
  }
}
Operazioni ammesse: sketch (plane Front|Top|Right, contours rectangle|circle|line),
extrude, cut (throughAll true per fori passanti), revolve, hole, fillet, chamfer, shell,
pattern, component, mate, drawingView, annotation.
Per una piastra forata: schizzo rettangolo, estrusione, schizzo cerchi, cut throughAll, fillet opzionale.`

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
    return Response.json(llm)
  } catch (err) {
    const demo = interpretDemo(prompt)
    demo.warning = `OpenRouter non disponibile, uso demo. ${err instanceof Error ? err.message : String(err)}`
    return Response.json(demo)
  }
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
  }

  const payload = parsed.payload
  if (!payload || payload.schemaVersion !== 2 || !Array.isArray(payload.operations)) {
    throw new Error("JSON LLM senza payload schemaVersion 2")
  }

  payload.units = "mm"
  payload.schemaVersion = 2
  payload.variables ??= []
  payload.configurations ??= []

  return {
    summary: parsed.summary || `Modello con ${payload.operations.length} operazioni.`,
    source: "openrouter",
    operations: payload.operations,
    payload,
    dfm: runDfm(payload),
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fence ? fence[1] : trimmed
  return JSON.parse(raw)
}
