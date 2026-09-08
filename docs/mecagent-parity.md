# Solidworks_IA vs MecAgent — cosa copiare, cosa no

Riferimenti (solo studio, niente branding/asset): [features](https://mecagent.com/features), [Text-to-Macro-to-CAD](https://mecagent.com/blog/text-to-macro-to-cad-the-future-of-design), [video copilot](https://youtu.be/ah3Xp5wHFA0). Lettura all’8 settembre 2026.

## Cosa fa MecAgent

Copilot **dentro** la sessione CAD (SOLIDWORKS / Inventor). L’ingegnere scrive in linguaggio naturale; l’IA genera **macro/script** e le **esegue nel documento aperto**.

Dal sito:

| Modulo | Ruolo |
| --- | --- |
| CAD Copilot | Azioni in sessione: text-to-CAD semplice, rinomina, proprietà, materiali, metadata |
| Macro AI | Automazioni (export, sketch, vincoli, standard, salvataggi) |
| AI Drawing | Tavole da modello esistente (viste, tabelle, note; non GD&T complesso) |
| Expert | Risposte da fonti engineering |
| Text-to-STEP/STL | Geometria statica senza albero feature (viti, ingranaggi…) |
| Part finder | Catalogo parti standard da NL |

Il blog insiste sul salto qualitativo: non STEP approssimato, ma **il CAD stesso** costruisce la geometria (solver, quote, feature). Le macro `.swp` restano il mezzo nativo; il copilot toglie la barriera VBA.

UI tipica (features + demo): **una conversazione**, proposte di azione, un tasto esegui nella sessione. Non tre colonne “studio CAD” (chat | 3D | timeline) come eroe.

## Cosa abbiamo già

- NL → operazioni parametriche **schema v2** → bridge HTTP→COM → SolidWorks 2025 (parti, assieme, tavola Cartiglio_CM).
- Chat, DFM, anteprima 3D, kit staffa a L, OpenRouter (default Claude Sonnet 4.6).
- Libreria `Macro_SolidWorks` CADTM (esecuzione/editor, non CommandManager).
- App **esterna**: SolidWorks resta il CAD; il copilot non è un add-in.

## Cosa copiare (interfaccia e flusso)

1. **Conversazione come superficie primaria**, non lo studio a 3 colonne.
2. Tasto unico **Esegui in SolidWorks** (nella sessione / via bridge), con stato loading/errore.
3. Azioni rapide: crea pezzo, tavola A3 CM, assieme, revisione (follow-up).
4. Proposta prima dell’esecuzione: l’albero resta verificabile, ma secondario.
5. Copy da “copilot sul CAD aperto”, non da “editor di feature web”.

## Cosa resta diverso (scelta bloccata)

| | MecAgent | Solidworks_IA |
| --- | --- | --- |
| Dove gira | Add-in / in-process | Next.js esterno + bridge Windows |
| Modeling | Macro VBA/API generate al volo | **JSON schema v2** eseguito in COM |
| Geometria | Native feature SW via macro | Native feature SW via `SketchManager` / `FeatureManager` |
| Macro CADTM | Fine (automazioni) | **Dopo**: IA su `.swp` esistenti, non per modellare il pezzo |
| Catalogo / STEP mesh | Sì (finder, text-to-STL) | Fuori scope |
| Percorsi | Loro cloud | CADTM `01_Progetti_Attivi\SolidworksIA`, mai ProgramData |

Stesso obiettivo di MecAgent (il CAD costruisce, non una mesh): mezzo diverso. JSON+COM è più ispezionabile e versionabile dell’VBA opaco; le macro restano per DistTaglio, qualità immagine, tavole aziendali già in libreria.

## Non copiare

Logo, nome, screenshot, copy marketing MecAgent. Non diventare add-in SOLIDWORKS.

## Esito UI (questa passata)

L’app su `http://127.0.0.1:4317` è un **copilot**: chat + Esegui; albero/kit e 3D in pannello secondario. API `/api/interpret` e `/api/solidworks` invariate.
