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

Any other request (coperchio, maniglia, asola, new plate, bushing, pin, shaft, cylinder, assembly, drawing, telaio a U): compile the user's geometry with NEW PascalCase names. Never reuse StaffaFissaggio, BoccolaGuida, AssiemeStaffa, PiastraSupporto, BasePiastra100, BoccolaCentrale, Piastra90, FiancataSx, LongheroneSx, Piastra100x60, Cubo20, AssemblePiastraCubo, PiastraOrizzontale, PiastraVerticale, Piastra80x50, Cilindro20x30, AssemblePiastraCilindro, BoccolaFlangia16, PiastraForo16, AssemieBoccolaPiastra, AlberoSpallamento10, PiastraForo10, AssiemeAlberoPiastra, PiastraBaseU, MontanteU, AssiemeTelaioU, TavolaTelaioU, PiastraTasca80, Coperchio80, AssiemePiastraCoperchio, TavolaPiastraCoperchio, BaseRettangolare, DistanzialeRound, AssiemeBaseDistanziali, PiastraForo10x60, Distanziale16x20, AssiemeSandwichPiastre, TavolaSandwichPiastre, BarraT60, Piastra70Foro8, AssiemeBarraT, TavolaBarraT, Flangia80Pcd50, Albero12x50, AssiemeFlangiaAlbero, TavolaFlangiaAlbero, DadoEsagono17, Piastra50Foro10, AssiemeDadoPiastra, TavolaDadoPiastra, AlberoGola16, Piastra50Foro16, AssiemeAlberoGola, TavolaAlberoGola, AlberoCava20, Piastra60Foro20, AssiemeAlberoCava, TavolaAlberoCava.
Solid cylinder ØD height H with no inner hole: circle ØD on Top, extrude H (not revolve, not the L-bracket kit). A part sitting on a plate (coincidente sulla faccia superiore): TWO SLDPRT; coincident top of plate / bottom of the part; inner X and Z to center. Holes stay on the plate part.
Welded / saldata = same part, merge true, not a second component.
U-handle height h on a lid: sketch on Front two legs + one top bar (section 3–4 mm in the sketch). Extrude DEPTH = grip width 18–25 mm, NEVER 3 mm — depth 3 makes a vertical wall, not a U you can see. Legs and bar must not overlap in the same sketch (three sketches+extrude merge, edges touching). Opening in the middle must stay empty.
C-profile / profilo a C / C-channel H×B×t, length L: NOT a flat rectangle. Do NOT sketch a thin t×H rectangle on Front (FullyDefineSketch result=6, 0 dimensions, extrude FAIL). Web: Right plane rectangle L×H, extrude depth=t. Flanges: Front (B-t)×t at both ends of the web (inner edge flush with web inner face), extrude depth=L merge true. Holes on the dorso/web: sketch on Right, throughAll. Never emit an 80×40 rectangle extruded L.
Telaio a U / U-frame of plates (not C-profile, not a U-handle on a lid): TWO unique SLDPRT then assembly. Base L×W×t on Top (example 100×40×8). Two holes Ød throughAll on the base, centers along L at ±(L/2 − offset from end) (example two Ø8 at 15 mm from the extremities → cx=±35, cy=0). Do not invent extra holes, offsets, or upright sizes. Two identical uprights on the SHORT sides (W): W×H×t (example 40×40×8) = ONE SLDPRT inserted twice. Sketch the 40×40 on Right, extrude 8. Never two different montante files. Assembly: base fix. Insert the two uprights at x=±(L/2 − t/2) (example ±46). Each upright: coincident bottom to base top (seated); coincident xmax of the right upright to base xmax; do NOT coincident Front planes (that slides the wall off the end) — lock width with zmin/zmax faces if needed; perpendicular (mateType perpendicular) upright right to base top so the wall is 90°. Then verify. Names like PiastraBaseU, MontanteU, AssiemeTelaioU, TavolaTelaioU.
Piastra + coperchio / plate with rectangular pocket and a matching cover (NOT the L-bracket kit even if the plate is 80×50×8 — no wall 40, no boss Ø16, no boccola): TWO unique SLDPRT then assembly then drawing. Plate: 80×50 on Top at origin, extrude 8. Separate sketch: four circles Ø6 throughAll, centers 8 mm from the corners → (±32, ±17) because 40−8 and 25−8. Separate sketch: rectangle 30×12 at origin, type "cut" depth 3 (blind; throughAll false — pocket 3 mm, not a through hole). Cover: 80×50 on Top, extrude 4; same four Ø6 throughAll at (±32, ±17); NO pocket. Assembly: plate fix; insert cover at x=0,y=8,z=0; coincident cover bottom / plate top; coincident xmax and zmax so the 80×50 outlines and holes line up; optional one concentric Ø6 with holeX=32 holeY=17. Then verify. Names like PiastraTasca80, Coperchio80, AssiemePiastraCoperchio, TavolaPiastraCoperchio. Do not invent extra sizes.
Sandwich / due piastre identiche + distanziale cilindrico in mezzo (not L-kit, not cover, not shaft shoulder, not flanged bushing): TWO unique SLDPRT then assembly then drawing. Identical plates 60×40×6 with Ø10 at the center = ONE SLDPRT inserted twice (never two plate files). Plate: 60×40 on Top at origin, extrude 6; separate sketch circle Ø10 cx=0 cy=0 throughAll. Distanziale: circle Ø16 on Top, extrude 20; separate sketch Ø10 throughAll. NOT revolve, NOT a flange — do not invent flange Ø or extra holes. Assembly: plate-1 fix at origin; insert distanziale at y=6; insert plate-2 at y=26. Coincident distanziale bottom / plate-1 top AND plate-2 bottom / distanziale top (both faces of the spacer). Concentric Ø10 inner-inner (diameter 10) so the holes line up. Then verify. Names like PiastraForo10x60, Distanziale16x20, AssiemeSandwichPiastre, TavolaSandwichPiastre. Never DistanzialeRound / BaseRettangolare.
Barra a T / T-bar / T-profile (NOT three mated plates, NOT L-kit, NOT C-profile, NOT U-frame): TWO unique SLDPRT. NEVER two rectangles in the SAME sketch (they overlap → FeatureExtrusion FAIL, empty body 0 kg). NEVER Front. The T is a CLOSED polyline of lines on Top, then extrude 60: testa 50×8 at y[20,28] and anima 8×40 at y[-20,20], joining at y=20. Lines: (-4,-20)-(4,-20)-(4,20)-(25,20)-(25,28)-(-25,28)-(-25,20)-(-4,20)-(-4,-20). Extrude 60 along +Y. Alternative allowed: TWO sketches (one rectangle each) then two extrude 60 merge true — still ONE SLDPRT. Separate Top sketch: circle Ø8 at the anima center (0,0), cut throughAll. Do not invent a round shank. Plate: 70×50×6 on Top, Ø8 at origin throughAll. Assembly: plate fix; insert T at y=6; coincident T bottom / plate top; concentric Ø8 inner-inner diameter 8; perpendicular T right to plate top. Then verify. Names like BarraT60, Piastra70Foro8, AssiemeBarraT, TavolaBarraT.
Circular flange disc + plain shaft / flangia circolare Ø80 spessore 8 + albero Ø12 L50 (NOT a rectangular plate, NOT a cube, NOT three plates, NOT the L-kit, NOT BoccolaFlangia16, NOT a flanged bushing with a shank/neck): TWO unique SLDPRT then assembly then drawing. Flange = ONE circular PRT: Top circle Ø80 at origin, extrude 8. Separate Top sketch: circle Ø12 at (0,0), cut throughAll. Separate Top sketch: four circles Ø8 on PCD 50 (radius 25) at (25,0), (0,25), (-25,0), (0,-25), cut throughAll. Do NOT invent 45° positions, a 50×50 square, extra holes, or a rectangular 80×80 boss. Plain shaft without shoulder: Top circle Ø12, extrude 50 (not revolve, do not invent a shoulder Ø). Assembly: flange fix; insert shaft at y=0; coincident shaft bottom / flange bottom (albero nel foro, una faccia della flangia allineata a un’estremità); concentric shaft outer / flange inner diameter 12. Then verify. Names like Flangia80Pcd50, Albero12x50, AssiemeFlangiaAlbero, TavolaFlangiaAlbero.
Hex nut / dado esagonale / hexagonal nut chiave 17 (NOT a cube, NOT a circle Ø17, NOT a 17×17 square, NOT the L-kit): TWO unique SLDPRT then assembly then drawing. Chiave 17 = across-flats 17 mm (distance between parallel faces), NOT across-corners. Nut = ONE PRT: closed hexagon of 6 lines on Top, then extrude 8. Pointy-top vertices (vertical flats at x=±8.5): (8.5,4.907)-(0,9.815)-(-8.5,4.907)-(-8.5,-4.907)-(0,-9.815)-(8.5,-4.907)-(8.5,4.907). Circumradius 17/√3 ≈ 9.815. Do NOT invent chamfer or thread. Separate Top sketch: circle Ø10 at (0,0), cut throughAll. Plate: 50×40 on Top at origin, extrude 6; separate sketch Ø10 at origin throughAll. Assembly: plate fix; insert nut at y=6; coincident nut bottom / plate top; concentric inner-inner diameter 10. Then verify. Names like DadoEsagono17, Piastra50Foro10, AssiemeDadoPiastra, TavolaDadoPiastra.
Shaft with annular groove / albero con gola (NOT three mated cylinders, NOT AlberoSpallamento10, NOT a plain extrude without the groove): TWO unique SLDPRT then assembly then drawing. ONE PRT: a single Front revolve of a closed half-section that INCLUDES the groove as a notch (FeatureRevolve2 is boss-only here — do NOT emit a second revolve, it would add material). Axis construction line (0,0)-(0,60). Half-section, y=0 is the end WITHOUT the groove (seated on the plate), y=60 is the groove end: (0,0)-(8,0)-(8,47)-(6,47)-(6,50)-(8,50)-(8,60)-(0,60)-(0,0). Groove Ø12×3 at 10 mm from the free end (y=50..60 remains Ø16). Do not invent chamfer, thread, or a second groove. Plate: 50×40 on Top, extrude 6; Ø16 at origin throughAll. Assembly: plate fix; insert shaft at y=6; coincident shaft bottom (y=0, no groove) / plate top; concentric shaft outer / plate inner diameter 16. Then verify. Names like AlberoGola16, Piastra50Foro16, AssiemeAlberoGola, TavolaAlberoGola.
Shaft with keyway / albero con cava linguetta 6×3.5 L40 (NOT a second mated key part, NOT an asola in the plate, NOT AlberoGola16, NOT AlberoSpallamento10): TWO unique SLDPRT then assembly then drawing. ONE PRT: Top circle Ø20, extrude 50 (plain cylinder; not revolve). Separate Top sketch for the prismatic keyway cut: rectangle width 6 (X ±3) and height 5.5 at (cx=0, cy=9.25) so Z runs 6.5→12 (depth 3.5 from Ø20 r=10, plus overshoot past the OD). Cut BLIND depth 40, throughAll FALSE — throughAll would eat the 10 mm closed end. The keyway is open on the sketch end (y=0); the opposite end y=40..50 is full Ø20. Do not invent a separate linguetta PRT, chamfer, or extra slots. Plate: 60×50 on Top, extrude 8; Ø20 at origin throughAll. Assembly: plate fix; insert shaft at y=0; coincident shaft TOP (y=50, no keyway) / plate top; concentric shaft outer / plate inner diameter 20. Then verify. Names like AlberoCava20, Piastra60Foro20, AssiemeAlberoCava, TavolaAlberoCava.
Z-bracket / staffa a Z / staffa Z / English "Z-bracket" (NOT three mated plates, NOT L-kit StaffaFissaggio, NOT T-bar, NOT C-profile, NOT U-frame): TWO unique SLDPRT then assembly then drawing. The Z is ONE PRT from ONE closed polyline of 8 lines, then extrude 30 (the 30 mm width). NEVER three 4 mm plates mated. NEVER two/three rectangles in the same sketch. NEVER Front (FeatureExtrusion2/sketch plane FAIL — same as T-bar/C-profile). Right plane in this bridge: sketch x = flange Z, sketch y = height Y. Inner rise 20 (overall height 28 = 4+20+4 from the given thicknesses); top 40; base 50; opposite flanges (true Z, not a C). Polyline with the 40 mm top at sketch y=28 so it lands at ymin: (-20,28)-(20,28)-(20,4)-(66,4)-(66,0)-(16,0)-(16,24)-(-20,24)-(-20,28). Extrude 30 along X (first feature is midplane X[-15,15]). Separate Top sketch: circle Ø8 at (0, 0) — mid of midplane width and mid of the 40 mm top that sits at Y=0. NEVER (15,46). Cut throughAll TRUE (at Z=0 the ray hits only the 4 mm top; the base is offset in Z). Do not invent fillet, chamfer, extra holes, or a third plate. Plate: 70×50 on Top, extrude 6; Ø8 at origin throughAll. NEVER reuse Piastra70Foro8 (that is the T-bar plate). Assembly: plate fix; insert Z at y=6; coincident Z BOTTOM (40×30 holed flange at ymin) / plate top; concentric Ø8 inner-inner diameter 8; perpendicular (mateType perpendicular) Z right to plate top. Then verify. Names like StaffaZ, Piastra70x50Foro8, AssiemeStaffaZ, TavolaStaffaZ.
Turned / rivoluzione / boccola / bushing / flanged bushing / albero / shaft (except the L-bracket kit BoccolaGuida, which stays two circles extruded 12 mm; except a plain cylindrical spacer/distanziale, which is extrude+cut; except a plain shaft ØD×L with no shoulder and no groove = circle+extrude; except a circular flange DISC = circle+extrude+holes; except a grooved shaft / albero con gola = ONE notched revolve; except a shaft with keyway / cava linguetta = circle+extrude then rectangular cut): MUST emit type "revolve" (FeatureRevolve2). NEVER stacked extrudes of concentric circles (that is not a revolve). Sketch on Front: (1) construction centerline on the Y axis {"kind":"line","x1":0,"y1":0,"x2":0,"y2":L,"construction":true}; (2) closed half-section on +X as connected lines — radii = Ø/2. Solid shaft/shoulder: start at x=0 (on the axis). Hollow: start at ri>0, do not cross the axis, no circles for the body. Then {"type":"revolve","sketch":"s1","angle":360}.
Solid shaft ØD length L with a shoulder ØDs × ts on one end (no bore unless asked): overall length = L including the shoulder. Half-section: (0,0)-(Ds/2,0)-(Ds/2,ts)-(D/2,ts)-(D/2,L)-(0,L). Example Ø10 L80 shoulder Ø16×6 → (0,0)-(8,0)-(8,6)-(5,6)-(5,80)-(0,80). Name like AlberoSpallamento10. Plate with ØD hole: throughAll, concentric diameter D, coincident entity pad (the ØDs→ØD step) to plate top so the shoulder sits on the face and the shank is in the hole.
Flanged bushing Øext D, Øint d, length L (overall, flange included), flange ØDf thick tf: only if the user asked for a boccola/bushing with a cylindrical shank AND a flange (not a standalone circular flange disc) and gave Øint d. ri=d/2, rb=D/2, rf=Df/2. Closed loop: (ri,0)-(rf,0)-(rf,tf)-(rb,tf)-(rb,L)-(ri,L) back to (ri,0). Example D=30 d=12 L=40 Df=50 tf=5 → (6,0)-(25,0)-(25,5)-(15,5)-(15,40)-(6,40). If Øint is omitted, do not invent d — solid flange (start at x=0) and say so in summary. New PascalCase name, never BoccolaGuida. Flange holes only if the user asked; NEW sketch on Top after the revolve, cut throughAll. Plate with matching hole: concentric shank/hole diameter D, coincident flange/shoulder (pad) to plate top.
Tube / tubo / pipe / percorso / sweep / piegato (not the L-bracket kit): MUST emit type "sweep" (InsertProtrusionSwept / FeatureSweep). NEVER three extruded cylinders or three revolves joined. Two sketches then sweep: (1) path on Front — U width W height H opening down as connected lines (-W/2,0)-(-W/2,H)-(W/2,H)-(W/2,0), or a 3-point arc (-W/2,0)-(0,H)-(W/2,0); (2) profile on Top at the path start: concentric circles Øext and Øint=Øext-2*t, cx=-W/2, cy=0. Then {"type":"sweep","profile":"s2","path":"s1"}. Example: tubo Ø20 spessore 2, U 80×40 → path Front (-40,0)-(-40,40)-(40,40)-(40,0); profile Top Ø20 and Ø16 at (-40,0). Name TuboU.
Asola/slot W×H on a FLAT plate: cut a rectangle W×H (optionally two ØH circles at the ends). M4 clearance Ø4.5, M6 Ø6.6 unless specified. A cava linguetta on a shaft is NOT an asola.
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
