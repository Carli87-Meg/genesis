import type { DfmIssue, SolidWorksDocumentPayload } from "./payload"

export function runDfm(payload: SolidWorksDocumentPayload): DfmIssue[] {
  const issues: DfmIssue[] = []
  const ops = payload.operations

  const extrude = ops.find((o) => o.type === "extrude")
  const thickness = extrude && extrude.type === "extrude" ? extrude.depth : undefined

  if (thickness !== undefined && thickness < 1.5) {
    issues.push({
      severity: "error",
      code: "thin-wall",
      message: `Spessore ${thickness} mm sotto 1,5 mm.`,
      operationId: extrude?.id,
    })
  }

  for (const op of ops) {
    if (op.type === "fillet" && thickness !== undefined && op.radius > thickness / 2) {
      issues.push({
        severity: "warning",
        code: "fillet-vs-thickness",
        message: `Raccordo R${op.radius} è grande rispetto allo spessore ${thickness} mm.`,
        operationId: op.id,
      })
    }
    if (op.type === "chamfer" && thickness !== undefined && op.distance > thickness / 2) {
      issues.push({
        severity: "warning",
        code: "chamfer-vs-thickness",
        message: `Smusso ${op.distance} mm è grande rispetto allo spessore ${thickness} mm.`,
        operationId: op.id,
      })
    }
    if (op.type === "sketch") {
      const rect = op.contours.find((c) => c.kind === "rectangle")
      const circles = op.contours.filter((c) => c.kind === "circle")
      if (rect && rect.kind === "rectangle") {
        for (const c of circles) {
          if (c.kind !== "circle") continue
          const edgeX = rect.width / 2 - Math.abs(c.cx) - c.diameter / 2
          const edgeY = rect.height / 2 - Math.abs(c.cy) - c.diameter / 2
          const edge = Math.min(edgeX, edgeY)
          if (edge < c.diameter) {
            issues.push({
              severity: "warning",
              code: "hole-to-edge",
              message: `Foro Ø${c.diameter} a ${edge.toFixed(1)} mm dal bordo (consigliato ≥ Ø).`,
              operationId: op.id,
            })
          }
        }
      }
    }
    if (op.type === "hole" && thickness !== undefined) {
      const edgeHint = Math.min(
        Math.abs(op.cx),
        Math.abs(op.cy),
      )
      if (edgeHint < op.diameter) {
        issues.push({
          severity: "warning",
          code: "hole-to-edge",
          message: `Foro Ø${op.diameter} vicino al bordo.`,
          operationId: op.id,
        })
      }
    }
  }

  return unique(issues)
}

/** Una parte riusata in più insert si controlla una sola volta. */
export function runDfmJob(docs: SolidWorksDocumentPayload[]): DfmIssue[] {
  const seen = new Set<string>()
  const issues: DfmIssue[] = []
  for (const d of docs) {
    const key = (d.document.savePath || d.document.name).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    for (const issue of runDfm(d)) {
      issues.push({
        ...issue,
        message: docs.length > 1 ? `${d.document.name}: ${issue.message}` : issue.message,
      })
    }
  }
  return unique(issues)
}

function unique(issues: DfmIssue[]): DfmIssue[] {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const k = `${i.code}:${i.message}:${i.operationId ?? ""}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
