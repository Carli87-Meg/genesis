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
dotnet bridge\bin\Release\net8.0-windows\stairhost.dll
```

Su questo PC AppLocker può bloccare l’`.exe` apphost e Smart App Control può bloccare un hash già visto di un DLL. L’assembly attuale è `stairhost.dll`; `dotnet …\stairhost.dll` è il modo supportato. `.\start-local.ps1` fa lo stesso.

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

I file CAD del bridge finiscono in
`C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\`
(`CAD/`, `Disegni/`, `Export/`). Non in ProgramData. Override: `$env:SOLIDWORKS_OUT_DIR`.
FeatureFillet è saltato di proposito.

## OpenRouter

Chiave in **Impostazioni** (resta in `localStorage`; una copia locale `.openrouter-local` è gitignorata). L’app manda la chiave al server in header e nel body di `/api/interpret`. Senza chiave: interprete demo locale. **Con chiave, se OpenRouter risponde 401/errore, non parte la demo**: in chat compare l’errore e l’albero resta vuoto, così non viene creato il pezzo sbagliato. La chiave non va nel git.

Modello predefinito: **Claude Sonnet 4.6** (`anthropic/claude-sonnet-4.6`) — CAD / codice, JSON schema v2, solo chiave OpenRouter. In Impostazioni: Veloce (GPT-4.1 mini o Gemini 2.5 Flash), Massima qualità (GPT-4.1). Parità MecAgent (solo flusso UI, non branding): [mecagent-parity](docs/mecagent-parity.md).

## Bridge COM

- STA, `HttpListener` su `127.0.0.1`
- `GetObject("SldWorks.Application")` se SolidWorks è già aperto, altrimenti `CreateObject`
- `NewDocument` / `NewAssembly` / `NewDrawing`, SketchManager, FeatureManager, `AddComponent5`, `AddMate5`, configurazioni, viste tavola
- Traversata feature: `FeatureByPositionReverse` + `GetTypeName2` (mai `SelectByID2`)
