/** Modelli OpenRouter per CADTM: JSON schema v2 + codice CAD. Solo slug senza BYOK. */

export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.6"

/** Flagship OpenAI via OpenRouter. Non è il default: costa ~10/50 USD per M token. */
export const GPT6_ASTRA_MODEL = "openai/gpt-6-astra"

/** Vecchi default troppo deboli per il kit staffa (JSON keyed / schema storto). */
export const LEGACY_DEFAULT_MODELS = new Set(["openai/gpt-4o-mini", "openai/gpt-4.1-mini"])

/** Bump per migrare localStorage dal mini al default CAD/codice. */
export const SETTINGS_MODEL_REV = 2

export type OpenRouterModelOption = {
  id: string
  label: string
  tag: "consigliato" | "veloce" | "qualita" | "economico"
}

export const OPENROUTER_MODEL_OPTIONS: OpenRouterModelOption[] = [
  {
    id: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6 — CAD / codice (consigliato)",
    tag: "consigliato",
  },
  {
    id: "openai/gpt-4.1-mini",
    label: "GPT-4.1 mini — Veloce",
    tag: "veloce",
  },
  {
    id: "openai/gpt-4.1",
    label: "GPT-4.1 — Massima qualità",
    tag: "qualita",
  },
  {
    id: GPT6_ASTRA_MODEL,
    label: "GPT-6 Astra — Flagship (costoso)",
    tag: "qualita",
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash — Veloce",
    tag: "veloce",
  },
]

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max"

export type OpenRouterChatPayload = {
  model: string
  messages: { role: string; content: string }[]
  response_format?: { type: "json_object" }
  temperature?: number
  max_tokens?: number
  max_completion_tokens?: number
  reasoning?: { effort: ReasoningEffort }
}

/** Astra omette effort → low; `none` risponde 400. Medium = JSON one-shot. */
export function isGpt6Astra(model: string): boolean {
  return model.trim().toLowerCase().includes("gpt-6-astra")
}

export function buildOpenRouterChatPayload(
  model: string,
  messages: { role: string; content: string }[],
): OpenRouterChatPayload {
  const payload: OpenRouterChatPayload = {
    model,
    messages,
    response_format: { type: "json_object" },
  }
  if (isGpt6Astra(model)) {
    payload.reasoning = { effort: "medium" }
    payload.max_completion_tokens = 16384
    return payload
  }
  payload.temperature = 0.1
  payload.max_tokens = 16384
  return payload
}

export function stripResponseFormat(payload: OpenRouterChatPayload): OpenRouterChatPayload {
  const next = { ...payload }
  delete next.response_format
  return next
}

export function stripReasoning(payload: OpenRouterChatPayload): OpenRouterChatPayload {
  const next = { ...payload }
  delete next.reasoning
  if (next.max_completion_tokens && !next.max_tokens) {
    next.max_tokens = next.max_completion_tokens
    delete next.max_completion_tokens
  }
  if (next.temperature === undefined) next.temperature = 0.1
  return next
}

export function resolveStoredModel(id: string | undefined, rev = 0): string {
  const raw = (id ?? "").trim()
  if (rev >= SETTINGS_MODEL_REV) return raw || DEFAULT_OPENROUTER_MODEL
  if (!raw || LEGACY_DEFAULT_MODELS.has(raw)) return DEFAULT_OPENROUTER_MODEL
  return raw
}
