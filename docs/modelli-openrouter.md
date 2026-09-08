# Modelli OpenRouter per CADTM

Elenco al **9 settembre 2026**. Per Solidworks_IA serve un modello che **scrive codice / JSON strutturato** (schema v2, COM, poi VBA), non un mini da chat.

## Default

**Claude Sonnet 4.6** (`anthropic/claude-sonnet-4.6`) — CAD / codice (consigliato).

Perché: tool-use + structured output, contesto 1M, niente seconda chiave (solo OpenRouter). GPT-4o mini ha già fallito la forma JSON della staffa a L (`{sketch:{…}}` senza `type`). I mini restano in «Veloce», non come default.

**GPT-6 Astra non è il default.** Flagship OpenAI (lancio 3–4 set 2026), adatto a lavoro lungo e computer-use, ma costa ~10 / 50 USD per milione di token e l’API omette `reasoning.effort` → **low**. L’interprete, se lo scegli, forza **medium**. `none` risponde 400.

Prezzi ≈ USD / milione token (in / out).

## Impostazioni

| Etichetta | Slug | Perché | Costo | Contesto |
| --- | --- | --- | --- | --- |
| **CAD / codice (consigliato)** | `anthropic/claude-sonnet-4.6` | Default. Schema v2, kit 4 documenti, allineato al codice | 3,00 / 15,00 | 1,0M |
| **Veloce** | `openai/gpt-4.1-mini` | Più economico, JSON migliore di 4o-mini | 0,40 / 1,60 | 1,0M |
| **Massima qualità** | `openai/gpt-4.1` | Stessa classe GPT-4.1, più fedele alle quote | 2,00 / 8,00 | 1,0M |
| **Flagship (costoso)** | `openai/gpt-6-astra` | Reasoning + computer-use. Effort **medium** one-shot JSON. Non default. | 10,00 / 50,00 | 1,05M |
| **Veloce** | `google/gemini-2.5-flash` | Bassa latenza, structured output | 0,30 / 2,50 | 1,0M |

GPT-4o mini non è più nel menu (troppo debole per questo compito). Se era salvato in Impostazioni, l’app passa a Sonnet 4.6.

Astra: input testo+immagine, output solo testo. Effort `low` / `medium` / `high` / `xhigh` / `max`. Soglia long-context 272k (tariffe più alte). Fast = 2× prezzo. Cache input 1,00 / write 12,50. Non è un backend Cursor ufficiale.

Cosa abbiamo preso dal suo modo di lavorare (vale per ogni modello):

1. Step COM `ok` non basta: dopo i mate il compilatore inserisce `verify` se manca.
2. Tavola: `includeIso` e 1° angolo di default; cartiglio **Cartiglio_CM**, non B-size.
3. Effort alto solo su geometria/posa lunga; JSON one-shot = medium.
4. Prova visiva (PrintWindow) quando SaveBMP non mostra il foglio.

Niente `:batch`, `:free`, alias `~…-latest`, né BYOK. Chiave mai in git. Con chiave, errore OpenRouter ≠ demo.
