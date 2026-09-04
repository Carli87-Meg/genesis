# Solidworks_IA

Chat in linguaggio naturale → albero feature parametrico (mm) → anteprima 3D → DFM → invio a SolidWorks.

Architettura: **app web esterna** (Next.js) + **processo Windows C#/.NET** in ascolto HTTP locale che esegue `SolidWorksDocumentPayload` schema v2 via COM. Non è un add-in in-process.

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
dotnet run --project bridge\SolidWorksBridge.csproj -c Release
```

```powershell
copy .env.example .env.local
npm install
npm run dev
```

- App: [http://127.0.0.1:4317](http://127.0.0.1:4317)
- Bridge: [http://127.0.0.1:47821/health](http://127.0.0.1:47821/health)

«Invia a SolidWorks» chiama `POST /api/solidworks`, che inoltra al bridge su `SOLIDWORKS_BRIDGE_URL` (o l’URL in Impostazioni).

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

I file CAD finiscono in `sw-out/` (non versionato). FeatureFillet è saltato di proposito.

## OpenRouter

Chiave in **Impostazioni** (resta in `localStorage`) oppure `OPENROUTER_API_KEY` in `.env.local`. Senza chiave: interprete demo locale. La chiave non va nel git.

## Bridge COM

- STA, `HttpListener` su `127.0.0.1`
- `GetObject("SldWorks.Application")` se SolidWorks è già aperto, altrimenti `CreateObject`
- `NewDocument` / `NewAssembly` / `NewDrawing`, SketchManager, FeatureManager, `AddComponent5`, `AddMate5`, configurazioni, viste tavola
- Traversata feature: `FeatureByPositionReverse` + `GetTypeName2` (mai `SelectByID2`)
