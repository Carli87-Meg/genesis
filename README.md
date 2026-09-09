# Solidworks_IA

Copilot per SolidWorks: una conversazione in italiano (o inglese) propone operazioni parametriche, poi **Esegui in SolidWorks** le manda al CAD aperto.

Architettura: **app web esterna** (Next.js) + **processo Windows C#/.NET** in ascolto HTTP locale che esegue `SolidWorksDocumentPayload` schema v2 via COM. Non è un add-in in-process. UI ispirata al flusso MecAgent (chat + esegui), non al branding.

## Requisiti

- Windows con SolidWorks già avviato (consigliato)
- .NET 8 SDK (`net8.0-windows`)
- Node.js 20+

## Avvio locale

SolidWorks deve essere **già aperto**. Da PowerShell, nella cartella del progetto:

```powershell
.\start-local.ps1
```

Questo avvia il bridge e poi `npm run dev`.

- App chat: [http://127.0.0.1:4317](http://127.0.0.1:4317)
- Bridge HTTP→COM: [http://127.0.0.1:47821/health](http://127.0.0.1:47821/health)

Oppure in due terminali (AppLocker/Smart App Control: non usare l’`.exe` apphost; l’assembly attuale è `swiax1uj.dll`):

```powershell
dotnet build bridge\SolidWorksBridge.csproj -c Release
dotnet bridge\bin\Release\net8.0-windows\swiax1uj.dll
```

```powershell
copy .env.example .env.local
npm install
npm run dev
```

### Chat UI (Proponi + Esegui)

1. Apri [http://127.0.0.1:4317](http://127.0.0.1:4317) — header **OpenRouter**, non demo.
2. **Nuova chat**, scrivi il pezzo in italiano, **Proponi**.
3. Controlla i nomi (`Assieme*`, mai `Assemie*`) e **Esegui in SolidWorks**.
4. L’UI fa `POST /api/solidworks` con `{ payload: doc }` per documento. Non usare `curl` sul bridge per questo flusso.

### Output CAD

I file del bridge finiscono in  
`C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\`  
(`CAD/`, `Disegni/`, `Export/`). Non in ProgramData. Override: `$env:SOLIDWORKS_OUT_DIR`.

### Cartiglio_CM

Le tavole A3 usano **Cartiglio_CM** da CADTM File Locations:  
`...\03_Risorse_CAD\Cartigli_Template\Cartiglio_CM\PARTE_A3_CM.slddrt`  
(`PARTE_A2_CM.slddrt` per A2). Il bridge lo antepone alle Sheet Format locations. **Mai copiare il `.slddrt` in ProgramData.**

Prima di ogni tavola/snapshot il bridge esce da «Modifica schizzo» e fa `EditRebuild3` + `ForceRebuild3`. Il cartiglio **PESO Kg** usa `SW-Mass` in chilogrammi.

### Limiti noti

- L’interpret OpenRouter **sbaglia spesso** la geometria (vite/revolve al posto del perno, cubo, due PRT al posto di un merge, schizzo a due cerchi pieni invece di un’asola). I sanitizer in `src/lib/llm-payload.ts` coprono alcuni casi; non coprono tutti.
- Piastra + boss cilindrico + perno: sanitizer e selezione faccia `top` = corona (T massimo, DLL `swiax1uj`) sono nel repo; la **posa coincidente sulla corona del boss non è chiusa** (estrusione merge nello stesso verso della piastra: corona e faccia piastra risultano coplanari). Prova a mano in SolidWorks.

Esempio più complesso in chat: *Staffa a L 80×50×8 mm, parete 40 mm, boss Ø16, 4 fori Ø6.5, boccola e tavola A3 CM*. L’app manda in sequenza parte, boccola, assieme e tavola. Le tavole usano il formato foglio **Cartiglio_CM** (`PARTE_A3_CM.slddrt` / `PARTE_A2_CM.slddrt`), non un `.drwdot` inesistente. FeatureFillet è saltato di proposito.

Piastra di prova senza UI:

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\plate.json"
```

Assieme (3 parti + mates) e tavola:

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-base.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\perno.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\rondella.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\assieme.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\tavola.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\tavola-piastra.json"
```

Telaio (8 parti, mate facce, tavola A3 Cartiglio_CM con vista isometrica extra). Pausa 4–5 s tra un `execute` e il successivo:

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\longherone-sx.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\longherone-dx.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\pioli-1.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\pioli-2.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\pioli-3.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\piede-sx.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\piede-dx.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\flangia.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\save-open.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\assieme.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\telaio\tavola.json"
```

Piastra di supporto (non kit staffa/scala): 120×80×10, tasca 50×30×5, nervatura 80×8×18, 4×Ø8 inset 12, tavola A3 Cartiglio_CM. Pausa 5 s tra gli execute:

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-supporto\part.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-supporto\tavola.json"
```

Assieme EN (base 100×60×8 + boccola Ø16/Ø10 h20, tavola A3 CM). Pausa 5 s:

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\base-boccola\base.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\base-boccola\boccola.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\base-boccola\assieme.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\base-boccola\tavola.json"
```

Assieme IT (piastra 90×50×6 + perno Ø8×40, tavola A3 CM):

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-perno\piastra.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-perno\perno.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-perno\assieme.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-perno\tavola.json"
```

Base 120×80×10 + 2 distanziali Ø16×h20 (tavola A3 CM):

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\base-distanziali\base.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\base-distanziali\distanziale.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\base-distanziali\assieme.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\base-distanziali\tavola.json"
```

Staffa a L a due piastre (80×40×5 + 50×40×5, tavola A3 CM):

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-l\orizzontale.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-l\verticale.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-l\assieme.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-l\tavola.json"
```

Boccola flangiata Ø16 L25 (revolve) + piastra 70×50×5 foro Ø16. Percorso chat UI (Proponi + Esegui):

```powershell
node scripts\chat-boccola-flangia-ui.mjs
```

Replay (pausa 5 s):

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\boccola-flangia16\boccola.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\boccola-flangia16\piastra.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\boccola-flangia16\assieme.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\boccola-flangia16\tavola.json"
```

Piastra 80×50×6 + cilindro Ø20 h30. Percorso chat UI (Proponi + Esegui):

```powershell
node scripts\chat-cilindro-piastra-ui.mjs
```

Replay (pausa 5 s):

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-cilindro\plate.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-cilindro\cylinder.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-cilindro\assieme.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-cilindro\tavola.json"
```

Piastra 100×60×8 + cubo 20 mm. Percorso chat UI (Proponi + Esegui, non solo curl interpret):

```powershell
node scripts\chat-plate-cube-ui.mjs
```

Replay dei payload prodotti dalla chat (pausa 5 s tra gli execute):

```powershell
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-cubo\plate.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-cubo\cube.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-cubo\assieme.json"
curl.exe -s -X POST http://127.0.0.1:47821/execute -H "Content-Type: application/json" --data-binary "@bridge\samples\piastra-cubo\tavola.json"
```

FeatureFillet è saltato di proposito (raccordi non eseguiti dal bridge).

## OpenRouter

Chiave in **Impostazioni** (resta in `localStorage`; una copia locale `.openrouter-local` è gitignorata). L’app manda la chiave al server in header e nel body di `/api/interpret`. Senza chiave: interprete demo locale. **Con chiave, se OpenRouter risponde 401/errore, non parte la demo**: in chat compare l’errore e l’albero resta vuoto, così non viene creato il pezzo sbagliato. La chiave non va nel git.

Modello predefinito: **Claude Sonnet 4.6** (`anthropic/claude-sonnet-4.6`) — CAD / codice, JSON schema v2, solo chiave OpenRouter. In Impostazioni: Veloce (GPT-4.1 mini o Gemini 2.5 Flash), Massima qualità (GPT-4.1 o **GPT-6 Astra**, costoso, effort medium). Astra non è il default. Parità MecAgent (solo flusso UI, non branding): [mecagent-parity](docs/mecagent-parity.md). Elenco: [modelli-openrouter](docs/modelli-openrouter.md).

## Bridge COM

- STA, `HttpListener` su `127.0.0.1`
- `GetObject("SldWorks.Application")` se SolidWorks è già aperto, altrimenti `CreateObject`
- `NewDocument` / `NewAssembly` / `NewDrawing`, SketchManager, FeatureManager, `AddComponent5`, `AddMate5`, configurazioni, viste tavola
- Traversata feature: `FeatureByPositionReverse` + `GetTypeName2` (mai `SelectByID2`)
