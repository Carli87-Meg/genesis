# Modelli OpenRouter per CADTM

Elenco al **8 settembre 2026**. Per Solidworks_IA serve un modello che **scrive codice / JSON strutturato** (schema v2, COM, poi VBA), non un mini da chat.

## Default

**Claude Sonnet 4.6** (`anthropic/claude-sonnet-4.6`) — CAD / codice (consigliato).

Perché: tool-use + structured output, contesto 1M, niente seconda chiave (solo OpenRouter). GPT-4o mini ha già fallito la forma JSON della staffa a L (`{sketch:{…}}` senza `type`). I mini restano in «Veloce», non come default.

Prezzi ≈ USD / milione token (in / out).

## Impostazioni

| Etichetta | Slug | Perché | Costo | Contesto |
| --- | --- | --- | --- | --- |
| **CAD / codice (consigliato)** | `anthropic/claude-sonnet-4.6` | Default. Schema v2, kit 4 documenti, allineato al codice | 3,00 / 15,00 | 1,0M |
| **Veloce** | `openai/gpt-4.1-mini` | Più economico, JSON migliore di 4o-mini | 0,40 / 1,60 | 1,0M |
| **Massima qualità** | `openai/gpt-4.1` | Stessa classe GPT-4.1, più fedele alle quote | 2,00 / 8,00 | 1,0M |
| **Veloce** | `google/gemini-2.5-flash` | Bassa latenza, structured output | 0,30 / 2,50 | 1,0M |

GPT-4o mini non è più nel menu (troppo debole per questo compito). Se era salvato in Impostazioni, l’app passa a Sonnet 4.6.

Niente `:batch`, `:free`, alias `~…-latest`, né BYOK. Chiave mai in git. Con chiave, errore OpenRouter ≠ demo.
