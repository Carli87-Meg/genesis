/** Modelli OpenRouter per CADTM (JSON schema v2). Solo slug senza BYOK extra. */

export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4.1-mini"

export type OpenRouterModelOption = {
  id: string
  label: string
  tag: "consigliato" | "veloce" | "qualita" | "economico"
}

export const OPENROUTER_MODEL_OPTIONS: OpenRouterModelOption[] = [
  {
    id: "openai/gpt-4.1-mini",
    label: "GPT-4.1 mini — consigliato",
    tag: "consigliato",
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash — veloce",
    tag: "veloce",
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6 — qualità",
    tag: "qualita",
  },
  {
    id: "openai/gpt-4o-mini",
    label: "GPT-4o mini — economico (provato)",
    tag: "economico",
  },
  {
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash — economico",
    tag: "economico",
  },
]
