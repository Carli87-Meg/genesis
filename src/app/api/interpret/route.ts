import { interpretDemo } from "@/lib/demo-interpreter"
import { interpretFromLlmText } from "@/lib/llm-payload"
import {
  buildOpenRouterChatPayload,
  DEFAULT_OPENROUTER_MODEL,
  stripReasoning,
  stripResponseFormat,
} from "@/lib/openrouter-models"
import { redactSecrets, resolveOpenRouterKey } from "@/lib/or-key"
import { runDfmJob } from "@/lib/dfm"
import type { InterpretResult, SolidWorksDocumentPayload } from "@/lib/payload"

export const maxDuration = 180

const SYSTEM = `You are a SolidWorks CAD compiler for Solidworks_IA.
Understand Italian and English. Output ONLY valid JSON. No markdown, no commentary.

Emit a SolidWorksDocumentPayload schema v2 object (not a {summary,payload} wrapper):
{
  "schemaVersion": 2,
  "units": "mm",
  "document": {
    "type": "part"|"assembly"|"drawing",
    "name": "PascalCaseName",
    "attachToActive": false,
    "savePath": "CAD/Name.SLDPRT"|"CAD/Name.SLDASM"|"Disegni/Name.SLDDRW",
    "snapshotPath": "Export/Name.jpg",
    "sheetFormat": "A3"
  },
  "variables": [],
  "configurations": [],
  "operations": [ { "id": "s1", "type": "sketch", ... } ],
  "job": [ /* optional extra documents, same shape */ ]
}
schemaVersion is the number 2. units is always "mm".
Every operation MUST have a string field "type". Never { "sketch": { ... } } as the only key.
Sketch origin = plate center. rectangle/circle use cx,cy (not centerX, not position).
Planes: Front|Top|Right. ISO Italian: Piano superiore = XZ, extrude along +Y.
Ops: sketch (plane, contours rectangle|circle|line|arc), extrude (sketch id, depth mm, merge),
cut (sketch id, throughAll true for holes), revolve, sweep (profile sketch id, path sketch id), hole, fillet, chamfer, shell, pattern,
component (path, x,y,z, fix), mate (mateType coincident|concentric|perpendicular|parallel — never "subtype", component1/2, entity1/2 inner|outer|top|bottom|pad|xmin|xmax|front|right|side, diameter mm; to pick one of several holes set holeX/holeY in sketch mm — never holeIndex),
After mates in an assembly always append {"id":"v1","type":"verify"} — COM step ok is not proof of pose.
sheetFormat (format A3|A2), standardViews (model: assembly or part savePath, firstAngle true, includeIso true),
modelDimensions, annotation (text, x, y in sheet metres: A3 ≈ 0.420×0.297, typical note 0.02, 0.27; values >2 mean millimetres and the compiler converts).
Every feature sketch MUST be fully quoted (width, height, hole Ø, offsets from origin/edges).
The bridge adds visible SolidWorks sketch dimensions (FullyDefineSketch / AddDimension2) on every ProfileFeature, including hole/cut sketches. Keep holes on a separate sketch+cut when they are not on the boss profile.
No fillet unless the user asks: FeatureFillet is unreliable.
Document names: PascalCase, spelled correctly. Assembly names start with Assieme (never Assemie, Assemblee, or other typos). Summary string MUST list the exact document names.
Do NOT invent sizes missing from the prompt (no extra inner Ø, no extra length, no extra holes). A "boccola"/"bushing" without Øint stays solid — say so in summary ("nessun Øinterno nel prompt: piena"). A plate "hole" for a shaft/pin is cut throughAll; say "foro passante" / "through hole" in summary so the user sees it. Never silently add geometry.

Single part: omit "job". Unique operation ids across the whole job. No sheet metal, weldments, or imported geometry. When the user says tavola A3 CM / Cartiglio CM: always sheetFormat A3, never a missing .drwdot.

TEMPLATES — use at most one, and only if the user request matches. Never mix them. Never emit a template the user did not ask for.

Staffa a L / L-bracket / kit fissaggio a L:
Use ONLY if the user asks for the kit 80×50×8 with wall 40, boss Ø16 and boccola. The word "staffa" or "staffa a L" alone is NOT enough.
TWO plates that form an L (piastra orizzontale + piastra verticale, e.g. 80×40×5 and 50×40×5): TWO distinct SLDPRT, new names, coincident on the shared 40 mm edge (entity xmin|xmax|ymin|ymax|zmin|zmax plus one face to lock the 40 mm width). Never StaffaFissaggio / BoccolaGuida / AssiemeStaffa.
Do NOT use this template for: two-plate L brackets, a flat staffa, a staffa with asola/slot, a staffa whose sizes are not 80×50×8, a coperchio/cover, a maniglia, or any other bracket. Example that is NOT the kit: "staffa 40×25×3 con asola 12×4" → compile a flat 40×25×3 plate with a 12×4 slot cut, new names.
root is the main part; job = part, bushing, assembly, drawing.
- Part: L-bracket 80×50×8 on Top, wall 80×8 extruded 40 mm on +Z edge, boss Ø16 height 14, 4 holes Ø6.5 at corners, guide bore Ø10.2 at center, cut throughAll. Names StaffaFissaggio, CAD/StaffaFissaggio.SLDPRT.
- Bushing: circles Ø16 and Ø10.2, extrude 12 mm. BoccolaGuida, CAD/BoccolaGuida.SLDPRT.
- Assembly: staffa (fix) + boccola; concentric inner-inner diameter 10.2; coincident bottom bushing / top pad. AssiemeStaffa, CAD/AssiemeStaffa.SLDASM.
- Drawing: sheetFormat A3 (Cartiglio_CM / PARTE_A3_CM.slddrt), standardViews model CAD/AssiemeStaffa.SLDASM, modelDimensions, annotation. TavolaStaffa, Disegni/TavolaStaffa.SLDDRW.

Scala / telaio / fiancate / scalini / modulo scala (not the L-bracket):
job = unique prismatic parts, then one assembly, then drawing if tavola/A3 is asked.
Identical geometry = one SLDPRT inserted twice (two scalini → un solo Scalino.SLDPRT).
Typical module (keep under 8 documents): FiancataSx, FiancataDx (Front 600×40, thickness 8 along Z, 2 holes Ø8 at X=±220 through Z), Scalino (Front 220×40, 1 hole Ø8, extrude 724 along Z — same hole axis as the stringers, filling the inner gap), optional Piede 80×80×8.
Assembly: Sx fixed; concentric Ø8 with holeX ±220; coincident zmin/zmax so treads sit in the gap; parallel xmax to lock rotation; piede ymax to stringer ymin. Paths CAD/Name.SLDPRT.
Drawing: A3 Cartiglio_CM, standardViews.model = assembly savePath.

Any other request (coperchio, maniglia, asola, new plate, bushing, pin, shaft, cylinder, assembly, drawing, telaio a U): compile the user's geometry with NEW PascalCase names. Never reuse StaffaFissaggio, BoccolaGuida, AssiemeStaffa, PiastraSupporto, BasePiastra100, BoccolaCentrale, Piastra90, FiancataSx, LongheroneSx, Piastra100x60, Cubo20, AssemblePiastraCubo, PiastraOrizzontale, PiastraVerticale, Piastra80x50, Cilindro20x30, AssemblePiastraCilindro, BoccolaFlangia16, PiastraForo16, AssemieBoccolaPiastra, AlberoSpallamento10, PiastraForo10, AssiemeAlberoPiastra, PiastraBaseU, MontanteU, AssiemeTelaioU, TavolaTelaioU.
Solid cylinder ØD height H with no inner hole: circle ØD on Top, extrude H (not revolve, not the L-bracket kit). A part sitting on a plate (coincidente sulla faccia superiore): TWO SLDPRT; coincident top of plate / bottom of the part; inner X and Z to center. Holes stay on the plate part.
Welded / saldata = same part, merge true, not a second component.
U-handle height h on a lid: sketch on Front two legs + one top bar (section 3–4 mm in the sketch). Extrude DEPTH = grip width 18–25 mm, NEVER 3 mm — depth 3 makes a vertical wall, not a U you can see. Legs and bar must not overlap in the same sketch (three sketches+extrude merge, edges touching). Opening in the middle must stay empty.
C-profile / profilo a C / C-channel H×B×t, length L: NOT a flat rectangle. Do NOT sketch a thin t×H rectangle on Front (FullyDefineSketch result=6, 0 dimensions, extrude FAIL). Web: Right plane rectangle L×H, extrude depth=t. Flanges: Front (B-t)×t at both ends of the web (inner edge flush with web inner face), extrude depth=L merge true. Holes on the dorso/web: sketch on Right, throughAll. Never emit an 80×40 rectangle extruded L.
Telaio a U / U-frame of plates (not C-profile, not a U-handle on a lid): TWO unique SLDPRT then assembly. Base L×W×t on Top (example 100×40×8). Two holes Ød throughAll on the base, centers along L at ±(L/2 − offset from end) (example two Ø8 at 15 mm from the extremities → cx=±35, cy=0). Do not invent extra holes, offsets, or upright sizes. Two identical uprights on the SHORT sides (W): W×H×t (example 40×40×8) = ONE SLDPRT inserted twice. Sketch the 40×40 on Right, extrude 8. Never two different montante files. Assembly: base fix. Insert the two uprights at x=±(L/2 − t/2) (example ±46). Each upright: coincident bottom to base top (seated); coincident xmax of the right upright to base xmax; do NOT coincident Front planes (that slides the wall off the end) — lock width with zmin/zmax faces if needed; perpendicular (mateType perpendicular) upright right to base top so the wall is 90°. Then verify. Names like PiastraBaseU, MontanteU, AssiemeTelaioU, TavolaTelaioU.
Piastra + coperchio / plate with rectangular pocket and a matching cover (NOT the L-bracket kit even if the plate is 80×50×8 — no wall 40, no boss Ø16, no boccola): TWO unique SLDPRT then assembly then drawing. Plate: 80×50 on Top at origin, extrude 8. Separate sketch: four circles Ø6 throughAll, centers 8 mm from the corners → (±32, ±17) because 40−8 and 25−8. Separate sketch: rectangle 30×12 at origin, type "cut" depth 3 (blind; throughAll false — pocket 3 mm, not a through hole). Cover: 80×50 on Top, extrude 4; same four Ø6 throughAll at (±32, ±17); NO pocket. Assembly: plate fix; insert cover at x=0,y=8,z=0; coincident cover bottom / plate top; coincident xmax and zmax so the 80×50 outlines and holes line up; optional one concentric Ø6 with holeX=32 holeY=17. Then verify. Names like PiastraTasca80, Coperchio80, AssiemePiastraCoperchio, TavolaPiastraCoperchio. Do not invent extra sizes.
Turned / rivoluzione / boccola / bushing / flanged bushing / albero / shaft (except the L-bracket kit BoccolaGuida, which stays two circles extruded 12 mm): MUST emit type "revolve" (FeatureRevolve2). NEVER stacked extrudes of concentric circles (that is not a revolve). Sketch on Front: (1) construction centerline on the Y axis {"kind":"line","x1":0,"y1":0,"x2":0,"y2":L,"construction":true}; (2) closed half-section on +X as connected lines — radii = Ø/2. Solid shaft/shoulder: start at x=0 (on the axis). Hollow: start at ri>0, do not cross the axis, no circles for the body. Then {"type":"revolve","sketch":"s1","angle":360}.
Solid shaft ØD length L with a shoulder ØDs × ts on one end (no bore unless asked): overall length = L including the shoulder. Half-section: (0,0)-(Ds/2,0)-(Ds/2,ts)-(D/2,ts)-(D/2,L)-(0,L). Example Ø10 L80 shoulder Ø16×6 → (0,0)-(8,0)-(8,6)-(5,6)-(5,80)-(0,80). Name like AlberoSpallamento10. Plate with ØD hole: throughAll, concentric diameter D, coincident entity pad (the ØDs→ØD step) to plate top so the shoulder sits on the face and the shank is in the hole.
Flanged bushing Øext D, Øint d, length L (overall, flange included), flange ØDf thick tf: only if the user gave Øint d. ri=d/2, rb=D/2, rf=Df/2. Closed loop: (ri,0)-(rf,0)-(rf,tf)-(rb,tf)-(rb,L)-(ri,L) back to (ri,0). Example D=30 d=12 L=40 Df=50 tf=5 → (6,0)-(25,0)-(25,5)-(15,5)-(15,40)-(6,40). If Øint is omitted, do not invent d — solid flange (start at x=0) and say so in summary. New PascalCase name, never BoccolaGuida. Flange holes only if the user asked; NEW sketch on Top after the revolve, cut throughAll. Plate with matching hole: concentric shank/hole diameter D, coincident flange/shoulder (pad) to plate top.
Tube / tubo / pipe / percorso / sweep / piegato (not the L-bracket kit): MUST emit type "sweep" (InsertProtrusionSwept / FeatureSweep). NEVER three extruded cylinders or three revolves joined. Two sketches then sweep: (1) path on Front — U width W height H opening down as connected lines (-W/2,0)-(-W/2,H)-(W/2,H)-(W/2,0), or a 3-point arc (-W/2,0)-(0,H)-(W/2,0); (2) profile on Top at the path start: concentric circles Øext and Øint=Øext-2*t, cx=-W/2, cy=0. Then {"type":"sweep","profile":"s2","path":"s1"}. Example: tubo Ø20 spessore 2, U 80×40 → path Front (-40,0)-(-40,40)-(40,40)-(40,0); profile Top Ø20 and Ø16 at (-40,0). Name TuboU.
Asola/slot W×H: cut a rectangle W×H (optionally two ØH circles at the ends). M4 clearance Ø4.5, M6 Ø6.6 unless specified.
job = each unique part, then assembly if 2+ parts, then drawing if tavola/A3/Cartiglio_CM is asked. After mates, verify. Drawing: sheetFormat A3 Cartiglio_CM, standardViews.model = the assembly (or part) savePath.`

type InterpretBody = {
  prompt?: string
  followUp?: boolean
  previous?: SolidWorksDocumentPayload
  previousJob?: SolidWorksDocumentPayload[]
  openRouterKey?: string
  apiKey?: string
  token?: string
  model?: string
  useStoredKey?: boolean
}

export async function POST(req: Request) {
  const started = Date.now()
  let body: InterpretBody
  try {
    body = (await req.json()) as InterpretBody
  } catch {
    return Response.json({ error: "JSON non valido" }, { status: 400 })
  }

  const prompt = (body.prompt ?? "").trim()
  if (!prompt) {
    return Response.json({ error: "Prompt vuoto" }, { status: 400 })
  }

  const { key, keySource } = await resolveOpenRouterKey({
    headerKey: req.headers.get("x-openrouter-key"),
    authHeader: req.headers.get("authorization"),
    bodyKey: body.openRouterKey || body.apiKey || body.token,
    envKey: process.env.OPENROUTER_API_KEY,
    allowFile: body.useStoredKey === true,
  })
  const model =
    (req.headers.get("x-openrouter-model")?.trim() ||
      body.model?.trim() ||
      process.env.OPENROUTER_MODEL ||
      DEFAULT_OPENROUTER_MODEL).trim()

  if (!key) {
    const demo = interpretDemo(prompt)
    demo.hasKey = false
    demo.keySource = "none"
    console.info(
      `[interpret] demo keySource=none model=${model} promptLen=${prompt.length} ops=${demo.operations.length} ms=${Date.now() - started}`,
    )
    return Response.json(demo)
  }

  try {
    const llm = await callOpenRouter(
      key,
      model,
      prompt,
      body.followUp ? body.previousJob ?? body.previous : undefined,
    )
    llm.hasKey = true
    llm.keySource = keySource
    llm.model = model
    console.info(
      `[interpret] openrouter keySource=${keySource} model=${model} ops=${llm.operations.length} ms=${Date.now() - started}`,
    )
    return Response.json(llm)
  } catch (err) {
    const raw = redactSecrets(err instanceof Error ? err.message : String(err))
    const error = openRouterUserMessage(raw)
    console.info(
      `[interpret] FAIL keySource=${keySource} model=${model} ms=${Date.now() - started} ${raw.slice(0, 160)}`,
    )
    return Response.json(
      {
        error,
        summary: error,
        source: "openrouter",
        warning: raw,
        hasKey: true,
        keySource,
        model,
        operations: [],
        dfm: [],
      } satisfies Partial<InterpretResult> & { error: string },
      { status: 502 },
    )
  }
}

function openRouterUserMessage(raw: string): string {
  if (/HTTP 401|user not found|invalid api key|unauthorized/i.test(raw)) {
    return "OpenRouter ha rifiutato la chiave (401). Incolla una chiave valida in Impostazioni. Non creo un pezzo demo al posto di quello richiesto."
  }
  if (/HTTP 402|credits|payment/i.test(raw)) {
    return "Credito OpenRouter esaurito. Non creo un pezzo demo al posto di quello richiesto."
  }
  if (/HTTP 429/i.test(raw)) {
    return "OpenRouter: troppe richieste. Riprova tra poco. Non creo un pezzo demo al posto di quello richiesto."
  }
  return `OpenRouter non ha prodotto un pezzo. ${raw} Non uso la demo: con una chiave impostata il pezzo sbagliato non viene creato.`
}

async function callOpenRouter(
  key: string,
  model: string,
  prompt: string,
  previous?: SolidWorksDocumentPayload | SolidWorksDocumentPayload[],
): Promise<InterpretResult> {
  const user = previous
    ? `Job corrente (schema v2, tutti i documenti; non perdere pezzi riusati):\n${JSON.stringify(previous)}\n\nModifica richiesta:\n${prompt}`
    : prompt

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ]
  let payload = buildOpenRouterChatPayload(model, messages)

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://127.0.0.1:4317",
    "X-Title": "Solidworks_IA",
  }

  let res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    cache: "no-store",
    headers,
    body: JSON.stringify(payload),
  })

  if (!res.ok && (res.status === 400 || res.status === 422)) {
    payload = stripResponseFormat(payload)
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify(payload),
    })
  }

  if (!res.ok && (res.status === 400 || res.status === 422) && payload.reasoning) {
    payload = stripReasoning(payload)
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify(payload),
    })
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[]
    error?: { message?: string }
  }
  if (data.error?.message) {
    throw new Error(data.error.message)
  }
  const choice = data.choices?.[0]
  const content = choice?.message?.content ?? ""
  if (choice?.finish_reason === "length") {
    throw new Error("risposta LLM troncata (max tokens); riprova con un pezzo più semplice")
  }
  if (!content.trim()) {
    throw new Error(`risposta LLM vuota (finish=${choice?.finish_reason || "-"})`)
  }

  const { result, meta } = interpretFromLlmText(content, model)
  if (meta.parse === "repaired" && meta.droppedOps > 0) {
    result.warning = `JSON LLM riparato: ${meta.droppedOps} operazioni non riconosciute ignorate.`
  }
  result.dfm = runDfmJob(result.job ?? [result.payload])
  return result
}
