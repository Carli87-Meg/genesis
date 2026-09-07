export type PlaneName = "Front" | "Top" | "Right"

export type SketchContour =
  | { kind: "rectangle"; cx: number; cy: number; width: number; height: number }
  | { kind: "circle"; cx: number; cy: number; diameter: number }
  | {
      kind: "line"
      x1: number
      y1: number
      x2: number
      y2: number
      construction?: boolean
    }

export type CadOperation =
  | {
      id: string
      type: "sketch"
      name?: string
      plane: PlaneName
      contours: SketchContour[]
    }
  | {
      id: string
      type: "extrude"
      name?: string
      sketch: string
      depth: number
      flip?: boolean
      merge?: boolean
    }
  | {
      id: string
      type: "cut"
      name?: string
      sketch: string
      depth?: number
      throughAll?: boolean
    }
  | {
      id: string
      type: "revolve"
      name?: string
      sketch: string
      angle: number
    }
  | {
      id: string
      type: "hole"
      name?: string
      plane?: PlaneName
      cx: number
      cy: number
      diameter: number
      depth?: number
      throughAll?: boolean
    }
  | {
      id: string
      type: "fillet"
      name?: string
      radius: number
      allEdges?: boolean
    }
  | {
      id: string
      type: "chamfer"
      name?: string
      distance: number
      allEdges?: boolean
    }
  | { id: string; type: "shell"; name?: string; thickness: number }
  | {
      id: string
      type: "pattern"
      name?: string
      kind: "linear" | "circular"
      feature: string
      count: number
      spacing?: number
      angle?: number
    }
  | {
      id: string
      type: "component"
      name?: string
      path: string
      x?: number
      y?: number
      z?: number
      fix?: boolean
    }
  | {
      id: string
      type: "mate"
      name?: string
      mateType: "coincident" | "concentric" | "distance" | "parallel"
      component1: string
      component2: string
      entity1?: string
      entity2?: string
      plane1?: string
      plane2?: string
      distance?: number
      align?: "aligned" | "anti" | "closest"
      flip?: boolean
      /** mm, raggio cilindro da selezionare (foro guida vs fori di fissaggio) */
      diameter?: number
    }
  | {
      id: string
      type: "clearMates"
      name?: string
    }
  | {
      id: string
      type: "inspect"
      name?: string
    }
  | {
      id: string
      type: "verify"
      name?: string
    }
  | {
      id: string
      type: "drawingView"
      name?: string
      view: string
      model?: string
      x: number
      y: number
      scale?: number
    }
  | {
      id: string
      type: "standardViews"
      name?: string
      model: string
      firstAngle?: boolean
      includeIso?: boolean
    }
  | {
      id: string
      type: "modelDimensions"
      name?: string
    }
  | {
      id: string
      type: "annotation"
      name?: string
      text: string
      x: number
      y: number
    }
  | {
      id: string
      type: "sheetFormat"
      name?: string
      /** A2 | A3 | path to PARTE_A3_CM.slddrt */
      format?: string
    }

export type CadVariable = { name: string; value: number; units?: string }

export type CadConfiguration = {
  name: string
  suppress?: string[]
  unsuppress?: string[]
  overrides?: CadVariable[]
}

export type DocumentType = "part" | "assembly" | "drawing"

export type SolidWorksDocumentPayload = {
  schemaVersion: 2
  units: "mm"
  document: {
    type: DocumentType
    name: string
    attachToActive?: boolean
    savePath?: string
    snapshotPath?: string
    snapshotView?: string
    openPath?: string
    /** Cartiglio_CM: A3, A2, or path to .slddrt */
    sheetFormat?: string
  }
  variables: CadVariable[]
  configurations: CadConfiguration[]
  operations: CadOperation[]
}

export type TreeOp = CadOperation & {
  status: "pending" | "accepted" | "discarded"
}

export type DfmIssue = {
  severity: "warning" | "error"
  code: string
  message: string
  operationId?: string
}

export type InterpretResult = {
  summary: string
  source: "demo" | "openrouter"
  warning?: string
  operations: CadOperation[]
  payload: SolidWorksDocumentPayload
  /** Sequenza parte → boccola → assieme → tavola. Invia a SolidWorks li manda in ordine. */
  job?: SolidWorksDocumentPayload[]
  dfm: DfmIssue[]
}

export type BridgeStep = { op: string; ok: boolean; detail: string }
export type BridgeFeature = { index: number; name: string; typeName: string }

export type BridgeResponse = {
  ok: boolean
  error?: string
  attachPath?: string
  version?: string
  document?: string
  documentType?: number
  savedPath?: string
  snapshotPath?: string
  steps?: BridgeStep[]
  features?: BridgeFeature[]
}

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:47821"

export function opLabel(op: CadOperation): string {
  switch (op.type) {
    case "sketch":
      return `Schizzo ${op.plane}`
    case "extrude":
      return `Estrusione ${op.depth} mm`
    case "cut":
      return op.throughAll ? "Taglio passante" : `Taglio ${op.depth ?? ""} mm`
    case "revolve":
      return `Rivoluzione ${op.angle}°`
    case "hole":
      return `Foro Ø${op.diameter}`
    case "fillet":
      return `Raccordo R${op.radius}`
    case "chamfer":
      return `Smusso ${op.distance} mm`
    case "shell":
      return `Guscio ${op.thickness} mm`
    case "pattern":
      return `Pattern ${op.kind} ×${op.count}`
    case "component":
      return `Componente ${op.name ?? op.path}`
    case "mate":
      return `Mate ${op.mateType}`
    case "drawingView":
      return `Vista ${op.view}`
    case "standardViews":
      return "Viste standard"
    case "modelDimensions":
      return "Quote modello"
    case "annotation":
      return `Nota`
    case "sheetFormat":
      return `Formato foglio ${op.format ?? "CM"}`
    case "clearMates":
      return "Elimina mate"
    case "inspect":
      return "Ispeziona assieme"
    case "verify":
      return "Verifica layout"
  }
}
