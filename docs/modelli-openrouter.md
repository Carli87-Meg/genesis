# Modelli OpenRouter per CADTM

Elenco al **8 settembre 2026**, da [lista modelli OpenRouter](https://openrouter.ai/api/v1/models) e [rankings](https://openrouter.ai/rankings) (uso reale fino al 7 set). I volumi (Hy4, GPT-5.6 Luna, DeepSeek V4 Flash, GLM 5.3 Flash) misurano traffico, non la qualità del JSON CAD.

Solidworks_IA chiede **JSON schema v2** (operazioni parametriche, poi kit parte/boccola/assieme/tavola, in seguito VBA). Servono: JSON/tool-use, contesto lungo, **solo chiave OpenRouter** (niente BYOK Azure/Vertex).

Prezzi ≈ USD / milione di token (input / output).

## In Impostazioni

| Etichetta | Slug | Perché | Costo | Contesto |
| --- | --- | --- | --- | --- |
| **Consigliato** (default) | `openai/gpt-4.1-mini` | JSON schema + tool-use, istruzioni più ferme di 4o-mini, 1M di contesto per il kit a 4 documenti | 0,40 / 1,60 | 1,0M |
| **Veloce** | `google/gemini-2.5-flash` | Basso tempo di risposta, structured output, 1M | 0,30 / 2,50 | 1,0M |
| **Qualità** | `anthropic/claude-sonnet-4.6` | Miglior tool-use / schema; usalo se staffa+boccola+assieme+tavola escono incompleti | 3,00 / 15,00 | 1,0M |
| **Economico (provato)** | `openai/gpt-4o-mini` | Già usato su questo PC per piastra e staffa; barato, 128k | 0,15 / 0,60 | 128k |
| **Economico** | `deepseek/deepseek-v4-flash-0731` | Top di volume coding su OpenRouter, structured output, 1,3M; JSON a volte da riparare | 0,07 / 0,18 | 1,3M |

## Raccomandazione CADTM

1. Parti da **GPT-4.1 mini**.
2. Se il kit (4 documenti) è storto o manca la tavola A3: **Claude Sonnet 4.6**.
3. Prove rapide / credito basso: **GPT-4o mini** (già validato) o **DeepSeek V4 Flash**.
4. Gemini 2.5 Flash se 4.1 mini è lento.

Non usare varianti `:batch`, `:free`, alias `~…-latest`, né modelli che chiedono una seconda chiave provider. GPT-4o e Claude Sonnet 4 restano selezionabili se già salvati in Impostazioni.

L’app **non mette la chiave nel git**. Con chiave impostata, un errore OpenRouter non cade sulla demo.
