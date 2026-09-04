import type {
  CadOperation,
  DfmIssue,
  InterpretResult,
  SolidWorksDocumentPayload,
} from "./payload"
import { runDfm } from "./dfm"

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
): { operations: CadOperation[]; variables: SolidWorksDocumentPayload["variables"]; summary: string } {
  const mx = L / 2 - Math.max(D, 8)
  const my = W / 2 - Math.max(D, 8)
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
      contours: [
        { kind: "circle", cx: mx, cy: my, diameter: D },
        { kind: "circle", cx: -mx, cy: my, diameter: D },
        { kind: "circle", cx: mx, cy: -my, diameter: D },
        { kind: "circle", cx: -mx, cy: -my, diameter: D },
      ],
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
    summary: `Piastra ${L} × ${W} × ${T} mm, 4 fori Ø${D}${fillet ? `, raccordi R${fillet}` : ""}.`,
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

export function interpretDemo(prompt: string): InterpretResult {
  const text = prompt.trim()
  const lower = text.toLowerCase()

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
  if (plateMatch) {
    const dims = [...text.matchAll(/(\d+(?:[.,]\d+)?)/g)].map((m) => num(m[1], 0))
    const L = dims[0] || 80
    const W = dims[1] || 50
    const T = dims[2] || 8
    const hole = text.match(/[Øø]\s*(\d+(?:[.,]\d+)?)/)
    const D = num(hole?.[1], 0) || 6
    const fil = lower.match(/raccord[io]\s*r?\s*(\d+(?:[.,]\d+)?)|r\s*(\d+(?:[.,]\d+)?)/i)
    const fillet = num(fil?.[1] || fil?.[2], 0)
    const p = plate(L, W, T, D, fillet || undefined)
    built = { ...p, name: "Piastra", type: "part" }
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

  const payload: SolidWorksDocumentPayload = {
    schemaVersion: 2,
    units: "mm",
    document: { type: built.type, name: built.name, attachToActive: false },
    variables: built.variables,
    configurations: [],
    operations: built.operations,
  }
  const dfm: DfmIssue[] = runDfm(payload)

  return {
    summary: built.summary,
    source: "demo",
    operations: built.operations,
    payload,
    dfm,
  }
}
