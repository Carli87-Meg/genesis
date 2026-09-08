import type {
  CadOperation,
  DfmIssue,
  InterpretResult,
  SolidWorksDocumentPayload,
} from "./payload"
import { runDfmJob } from "./dfm"

function num(s: string | undefined, fallback: number): number {
  if (!s) return fallback
  const n = Number(s.replace(",", "."))
  return Number.isFinite(n) ? n : fallback
}

function plate(
  L: number,
  W: number,
  T: number,
  D: number,
  fillet?: number,
  centerHole = false,
): { operations: CadOperation[]; variables: SolidWorksDocumentPayload["variables"]; summary: string } {
  const mx = L / 2 - Math.max(D, 8)
  const my = W / 2 - Math.max(D, 8)
  const holes = centerHole
    ? [{ kind: "circle" as const, cx: 0, cy: 0, diameter: D }]
    : [
        { kind: "circle" as const, cx: mx, cy: my, diameter: D },
        { kind: "circle" as const, cx: -mx, cy: my, diameter: D },
        { kind: "circle" as const, cx: mx, cy: -my, diameter: D },
        { kind: "circle" as const, cx: -mx, cy: -my, diameter: D },
      ]
  const operations: CadOperation[] = [
    {
      id: "s1",
      type: "sketch",
      name: "SchizzoPiastra",
      plane: "Top",
      contours: [{ kind: "rectangle", cx: 0, cy: 0, width: L, height: W }],
    },
    {
      id: "e1",
      type: "extrude",
      name: "EstrusionePiastra",
      sketch: "s1",
      depth: T,
      merge: true,
    },
    {
      id: "s2",
      type: "sketch",
      name: "SchizzoFori",
      plane: "Top",
      contours: holes,
    },
    {
      id: "c1",
      type: "cut",
      name: "TaglioFori",
      sketch: "s2",
      throughAll: true,
    },
  ]
  if (fillet && fillet > 0) {
    operations.push({
      id: "f1",
      type: "fillet",
      name: "Raccordi",
      radius: fillet,
      allEdges: true,
    })
  }
  return {
    operations,
    variables: [
      { name: "L", value: L },
      { name: "W", value: W },
      { name: "T", value: T },
      { name: "D", value: D },
    ],
    summary: centerHole
      ? `Piastra ${L} × ${W} × ${T} mm, foro centrale Ø${D}${fillet ? `, raccordi R${fillet}` : ""}.`
      : `Piastra ${L} × ${W} × ${T} mm, 4 fori Ø${D}${fillet ? `, raccordi R${fillet}` : ""}.`,
  }
}

function pin(D: number, L: number) {
  const operations: CadOperation[] = [
    {
      id: "s1",
      type: "sketch",
      name: "SchizzoPerno",
      plane: "Top",
      contours: [{ kind: "circle", cx: 0, cy: 0, diameter: D }],
    },
    {
      id: "e1",
      type: "extrude",
      name: "EstrusionePerno",
      sketch: "s1",
      depth: L,
      merge: true,
    },
  ]
  return {
    operations,
    variables: [
      { name: "D", value: D },
      { name: "L", value: L },
    ],
    summary: `Perno Ø${D} mm, lunghezza ${L} mm.`,
  }
}

function shaft(D: number, L: number, fillet?: number) {
  const operations: CadOperation[] = [
    {
      id: "s1",
      type: "sketch",
      name: "SchizzoAlbero",
      plane: "Front",
      contours: [
        { kind: "line", x1: 0, y1: 0, x2: 0, y2: D / 2, construction: true },
        { kind: "rectangle", cx: L / 2, cy: D / 4, width: L, height: D / 2 },
      ],
    },
    { id: "r1", type: "revolve", name: "RivoluzioneAlbero", sketch: "s1", angle: 360 },
  ]
  if (fillet && fillet > 0) {
    operations.push({
      id: "f1",
      type: "fillet",
      name: "Raccordi",
      radius: fillet,
      allEdges: true,
    })
  }
  return {
    operations,
    variables: [
      { name: "D", value: D },
      { name: "L", value: L },
    ],
    summary: `Albero Ø${D} mm, lunghezza ${L} mm${fillet ? `, raccordi R${fillet}` : ""}.`,
  }
}

function bushing(outer: number, inner: number, h: number) {
  const operations: CadOperation[] = [
    {
      id: "s1",
      type: "sketch",
      name: "SchizzoBoccola",
      plane: "Top",
      contours: [
        { kind: "circle", cx: 0, cy: 0, diameter: outer },
        { kind: "circle", cx: 0, cy: 0, diameter: inner },
      ],
    },
    {
      id: "e1",
      type: "extrude",
      name: "EstrusioneBoccola",
      sketch: "s1",
      depth: h,
      merge: true,
    },
  ]
  return {
    operations,
    variables: [
      { name: "De", value: outer },
      { name: "Di", value: inner },
      { name: "H", value: h },
    ],
    summary: `Boccola Ø${outer}/${inner} mm, altezza ${h} mm.`,
  }
}

function partDoc(
  name: string,
  savePath: string,
  snapshotPath: string,
  operations: CadOperation[],
  variables: SolidWorksDocumentPayload["variables"],
): SolidWorksDocumentPayload {
  return {
    schemaVersion: 2,
    units: "mm",
    document: {
      type: "part",
      name,
      attachToActive: false,
      savePath,
      snapshotPath,
      snapshotView: "*Isometric",
    },
    variables,
    configurations: [],
    operations,
  }
}

/** Staffa a L: piastra + parete + boss, 4 fori di fissaggio e foro guida. Senza fillet. */
function lBracketStaffa(): {
  operations: CadOperation[]
  variables: SolidWorksDocumentPayload["variables"]
  summary: string
} {
  const L = 80
  const W = 50
  const T = 8
  const wallH = 40
  const wallT = 8
  const holeD = 6.5
  const bossD = 16
  const boreD = 10.2
  const mx = 30
  const my = 12
  const wallCy = W / 2 - wallT / 2
  const operations: CadOperation[] = [
    {
      id: "s1",
      type: "sketch",
      name: "SchizzoPiastra",
      plane: "Top",
      contours: [{ kind: "rectangle", cx: 0, cy: 0, width: L, height: W }],
    },
    {
      id: "e1",
      type: "extrude",
      name: "EstrusionePiastra",
      sketch: "s1",
      depth: T,
      merge: true,
    },
    {
      id: "s2",
      type: "sketch",
      name: "SchizzoParete",
      plane: "Top",
      contours: [{ kind: "rectangle", cx: 0, cy: wallCy, width: L, height: wallT }],
    },
    {
      id: "e2",
      type: "extrude",
      name: "EstrusioneParete",
      sketch: "s2",
      depth: wallH,
      merge: true,
    },
    {
      id: "s4",
      type: "sketch",
      name: "SchizzoFori",
      plane: "Top",
      contours: [
        { kind: "circle", cx: mx, cy: my, diameter: holeD },
        { kind: "circle", cx: -mx, cy: my, diameter: holeD },
        { kind: "circle", cx: mx, cy: -my, diameter: holeD },
        { kind: "circle", cx: -mx, cy: -my, diameter: holeD },
        { kind: "circle", cx: 0, cy: 0, diameter: boreD },
      ],
    },
    {
      id: "c1",
      type: "cut",
      name: "TaglioFori",
      sketch: "s4",
      throughAll: true,
    },
  ]
  return {
    operations,
    variables: [
      { name: "L", value: L },
      { name: "W", value: W },
      { name: "T", value: T },
      { name: "WallH", value: wallH },
      { name: "HoleD", value: holeD },
      { name: "BossD", value: bossD },
      { name: "BoreD", value: boreD },
    ],
    summary:
      `Staffa a L ${L}×${W}×${T} mm, parete ${wallH} mm, 4 fori Ø${holeD} e foro guida Ø${boreD} ` +
      `(sede boccola Ø${bossD}). Senza raccordi (FeatureFillet inaffidabile).`,
  }
}

function fixtureKit(): {
  job: SolidWorksDocumentPayload[]
  summary: string
} {
  const staffa = lBracketStaffa()
  const boccola = bushing(16, 10.2, 12)
  const staffaDoc = partDoc(
    "StaffaFissaggio",
    "CAD/StaffaFissaggio.SLDPRT",
    "Export/staffa-fissaggio.jpg",
    staffa.operations,
    staffa.variables,
  )
  const boccolaDoc = partDoc(
    "BoccolaGuida",
    "CAD/BoccolaGuida.SLDPRT",
    "Export/boccola-guida.jpg",
    boccola.operations,
    boccola.variables,
  )
  const assieme: SolidWorksDocumentPayload = {
    schemaVersion: 2,
    units: "mm",
    document: {
      type: "assembly",
      name: "AssiemeStaffa",
      attachToActive: false,
      savePath: "CAD/AssiemeStaffa.SLDASM",
      snapshotPath: "Export/assieme-staffa.jpg",
      snapshotView: "*Isometric",
    },
    variables: [],
    configurations: [],
    operations: [
      {
        id: "c1",
        type: "component",
        name: "StaffaFissaggio",
        path: "CAD/StaffaFissaggio.SLDPRT",
        x: 0,
        y: 0,
        z: 0,
        fix: true,
      },
      {
        id: "c2",
        type: "component",
        name: "BoccolaGuida",
        path: "CAD/BoccolaGuida.SLDPRT",
        x: 40,
        y: 20,
        z: 20,
      },
      {
        id: "m1",
        type: "mate",
        name: "ConcBoccolaForo",
        mateType: "concentric",
        component1: "c2",
        component2: "c1",
        entity1: "inner",
        entity2: "inner",
        diameter: 10.2,
        align: "aligned",
      },
      {
        id: "m2",
        type: "mate",
        name: "CoincBoccolaPiastra",
        mateType: "coincident",
        component1: "c2",
        component2: "c1",
        entity1: "bottom",
        entity2: "top",
        align: "anti",
      },
      { id: "i1", type: "inspect", name: "Ispeziona" },
      { id: "v1", type: "verify" },
    ],
  }
  const tavola: SolidWorksDocumentPayload = {
    schemaVersion: 2,
    units: "mm",
    document: {
      type: "drawing",
      name: "TavolaStaffa",
      attachToActive: false,
      savePath: "Disegni/TavolaStaffa.SLDDRW",
      snapshotPath: "Export/tavola-staffa.jpg",
      sheetFormat: "A3",
    },
    variables: [],
    configurations: [],
    operations: [
      {
        id: "sf1",
        type: "sheetFormat",
        name: "CartiglioCM",
        format: "A3",
      },
      {
        id: "v1",
        type: "standardViews",
        name: "VisteStandard",
        model: "CAD/AssiemeStaffa.SLDASM",
        firstAngle: true,
        includeIso: true,
      },
      { id: "d1", type: "modelDimensions", name: "Quote" },
      {
        id: "n1",
        type: "annotation",
        name: "Nota",
        text: "Staffa di fissaggio L — piastra 80×50×8, parete 40, foro guida Ø10.2, boccola Ø16/10.2. Cartiglio PARTE_A3_CM.",
        x: 0.02,
        y: 0.27,
      },
    ],
  }
  return {
    job: [staffaDoc, boccolaDoc, assieme, tavola],
    summary:
      `${staffa.summary} Boccola Ø16/10.2×12 mm. Assieme con 2 mate di faccia ` +
      `(concentrico foro Ø10.2, coincidente boccola sulla piastra). Tavola A3 con Cartiglio_CM.`,
  }
}

export function isFixtureKitPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  const staffa = /staffa|bracket|fissaggio|fixture|l-?bracket/.test(lower)
  const kit = /assieme|tavola|disegno|boccola|bushing|kit|complesso|parete|rib|cartiglio/.test(
    lower,
  )
  return (staffa && kit) || /progetto complesso|staffa a l/.test(lower)
}

export function interpretDemo(prompt: string): InterpretResult {
  const text = prompt.trim()
  const lower = text.toLowerCase()

  if (isFixtureKitPrompt(text) || /staffa a l|l-?bracket/.test(lower)) {
    const kit = fixtureKit()
    const payload = kit.job[0]
    const dfm: DfmIssue[] = runDfmJob(kit.job)
    return {
      summary: kit.summary,
      source: "demo",
      operations: kit.job.flatMap((d) => d.operations),
      payload,
      job: kit.job,
      dfm,
    }
  }

  let built: {
    operations: CadOperation[]
    variables: SolidWorksDocumentPayload["variables"]
    summary: string
    name: string
    type: SolidWorksDocumentPayload["document"]["type"]
  } | null = null

  const plateMatch = lower.match(
    /piastr[ae]|plate|lastra/,
  )
  if (/rondella|washer/.test(lower)) {
    const dims = [...text.matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) => num(m[1], 0))
    const hole = text.match(/[Øø]\s*(\d+(?:[.,]\d+)?)/g)
    const outer = dims[0] || 18
    const inner = num(hole?.[1]?.replace(/[Øø]\s*/, ""), 0) || dims[1] || 8.2
    const h = dims[2] || 2
    const b = bushing(outer, inner, h)
    built = { ...b, name: "Rondella", type: "part", summary: `Rondella Ø${outer}/${inner} mm, spessore ${h} mm.` }
  } else if (/\bperno\b|\bpin\b|spine/.test(lower)) {
    const dims = [...text.matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) => num(m[1], 0))
    const hole = text.match(/[Øø]\s*(\d+(?:[.,]\d+)?)/)
    const D = num(hole?.[1], 0) || dims[0] || 8
    const L = dims.find((d) => d !== D) || dims[1] || 24
    const p = pin(D, L)
    built = { ...p, name: "Perno", type: "part" }
  } else if (/staffa|bracket/.test(lower)) {
    const s = lBracketStaffa()
    built = { ...s, name: "StaffaFissaggio", type: "part" }
  } else if (plateMatch) {
    const dims = [...text.matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) => num(m[1], 0))
    const L = dims[0] || 80
    const W = dims[1] || 50
    const T = dims[2] || 8
    const hole = text.match(/[Øø]\s*(\d+(?:[.,]\d+)?)/)
    const D = num(hole?.[1], 0) || (lower.includes("centrale") || lower.includes("center") ? 8 : 6)
    const fil = lower.match(/raccord[io]\s*r?\s*(\d+(?:[.,]\d+)?)|r\s*(\d+(?:[.,]\d+)?)/i)
    const fillet = num(fil?.[1] || fil?.[2], 0)
    const center = /centrale|center|un foro|1 foro|foro unico/.test(lower)
    const p = plate(L, W, T, D, fillet || undefined, center)
    built = { ...p, name: center ? "PiastraBase" : "Piastra", type: "part" }
  } else if (/albero|shaft|cilindr/.test(lower) && !/boccola/.test(lower)) {
    const dims = [...text.matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) => num(m[1], 0))
    const D = dims[0] || 20
    const L = dims[1] || 80
    const fil = lower.match(/raccord[io]\s*r?\s*(\d+(?:[.,]\d+)?)/i)
    const s = shaft(D, L, num(fil?.[1], 0) || undefined)
    built = { ...s, name: "Albero", type: "part" }
  } else if (/boccola|bushing|bush/.test(lower)) {
    const dims = [...text.matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) => num(m[1], 0))
    const b = bushing(dims[0] || 30, dims[1] || 16, dims[2] || 25)
    built = { ...b, name: "Boccola", type: "part" }
  }

  if (!built) {
    const p = plate(80, 50, 8, 6, 1)
    built = {
      ...p,
      name: "Piastra",
      type: "part",
      summary: `Demo: piastra 80 × 50 × 8 mm con 4 fori Ø6 (prompt non riconosciuto).`,
    }
  }

  const ext =
    built.type === "assembly" ? "SLDASM" : built.type === "drawing" ? "SLDDRW" : "SLDPRT"
  const folder = built.type === "drawing" ? "Disegni" : "CAD"
  const payload: SolidWorksDocumentPayload = {
    schemaVersion: 2,
    units: "mm",
    document: {
      type: built.type,
      name: built.name,
      attachToActive: false,
      savePath: `${folder}/${built.name}.${ext}`,
      snapshotPath: `Export/${built.name}.jpg`,
      snapshotView: "*Isometric",
    },
    variables: built.variables,
    configurations: [],
    operations: built.operations,
  }
  const dfm: DfmIssue[] = runDfmJob([payload])

  return {
    summary: built.summary,
    source: "demo",
    operations: built.operations,
    payload,
    dfm,
  }
}
