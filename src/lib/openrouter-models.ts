/** Modelli OpenRouter per CADTM: JSON schema v2 + codice CAD. Solo slug senza BYOK. */

export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.6"

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
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash — Veloce",
    tag: "veloce",
  },
]

export function resolveStoredModel(id: string | undefined, rev = 0): string {
  const raw = (id ?? "").trim()
  if (rev >= SETTINGS_MODEL_REV) return raw || DEFAULT_OPENROUTER_MODEL
  if (!raw || LEGACY_DEFAULT_MODELS.has(raw)) return DEFAULT_OPENROUTER_MODEL
  return raw
}
