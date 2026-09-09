# Solidworks_IA

Copilot per SolidWorks: una conversazione in italiano (o inglese) propone operazioni parametriche, poi **Esegui in SolidWorks** le manda al CAD aperto.

Architettura: **app web esterna** (Next.js) + **processo Windows C#/.NET** in ascolto HTTP locale che esegue `SolidWorksDocumentPayload` schema v2 via COM. Non è un add-in in-process. UI ispirata al flusso MecAgent (chat + esegui), non al branding.

## Requisiti

- Windows con SolidWorks già avviato (consigliato)
- .NET 8 SDK (`net8.0-windows`)
- Node.js 20+

## Avvio locale

Da PowerShell, nella cartella del progetto:

```powershell
.\start-local.ps1
```

Oppure in due terminali:

```powershell
dotnet build bridge\SolidWorksBridge.csproj -c Release
dotnet bridge\bin\Release\net8.0-windows\verkghost.dll
```

Su questo PC AppLocker può bloccare l’`.exe` apphost e Smart App Control può bloccare un hash già visto di un DLL. L’assembly attuale è `verkghost.dll`; `dotnet …\verkghost.dll` è il modo supportato. `.\start-local.ps1` fa lo stesso.

Il cartiglio **PESO Kg** usa `SW-Mass` in chilogrammi (non grammi MMGS). Il bridge imposta le unità di massa a kg e scrive le proprietà `PESO` / `Peso` / `Massa` prima del SaveAs.

```powershell
copy .env.example .env.local
npm install
npm run dev
```

- App: [http://127.0.0.1:4317](http://127.0.0.1:4317)
- Bridge: [http://127.0.0.1:47821/health](http://127.0.0.1:47821/health)

«Esegui in SolidWorks» chiama `POST /api/solidworks`, che inoltra al bridge su `SOLIDWORKS_BRIDGE_URL` (o l’URL in Impostazioni).

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

I file CAD del bridge finiscono in
`C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\`
(`CAD/`, `Disegni/`, `Export/`). Non in ProgramData. Override: `$env:SOLIDWORKS_OUT_DIR`.
FeatureFillet è saltato di proposito.

## OpenRouter

Chiave in **Impostazioni** (resta in `localStorage`; una copia locale `.openrouter-local` è gitignorata). L’app manda la chiave al server in header e nel body di `/api/interpret`. Senza chiave: interprete demo locale. **Con chiave, se OpenRouter risponde 401/errore, non parte la demo**: in chat compare l’errore e l’albero resta vuoto, così non viene creato il pezzo sbagliato. La chiave non va nel git.

Modello predefinito: **Claude Sonnet 4.6** (`anthropic/claude-sonnet-4.6`) — CAD / codice, JSON schema v2, solo chiave OpenRouter. In Impostazioni: Veloce (GPT-4.1 mini o Gemini 2.5 Flash), Massima qualità (GPT-4.1 o **GPT-6 Astra**, costoso, effort medium). Astra non è il default. Parità MecAgent (solo flusso UI, non branding): [mecagent-parity](docs/mecagent-parity.md). Elenco: [modelli-openrouter](docs/modelli-openrouter.md).

## Bridge COM

- STA, `HttpListener` su `127.0.0.1`
- `GetObject("SldWorks.Application")` se SolidWorks è già aperto, altrimenti `CreateObject`
- `NewDocument` / `NewAssembly` / `NewDrawing`, SketchManager, FeatureManager, `AddComponent5`, `AddMate5`, configurazioni, viste tavola
- Traversata feature: `FeatureByPositionReverse` + `GetTypeName2` (mai `SelectByID2`)
