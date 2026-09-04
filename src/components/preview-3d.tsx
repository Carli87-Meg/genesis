"use client"

import { useEffect, useRef } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import type { CadOperation } from "@/lib/payload"

type Props = { operations: CadOperation[] }

export function Preview3D({ operations }: Props) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x141414)

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 4000)
    camera.up.set(0, 0, 1)
    camera.position.set(140, -160, 110)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 1.1)
    key.position.set(80, -40, 160)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x9ecbff, 0.35)
    fill.position.set(-120, 80, 40)
    scene.add(fill)

    const grid = new THREE.GridHelper(200, 20, 0x3a3a3a, 0x262626)
    grid.rotation.x = Math.PI / 2
    scene.add(grid)
    scene.add(new THREE.AxesHelper(40))

    const group = buildSolid(operations)
    scene.add(group)

    const box = new THREE.Box3().setFromObject(group)
    if (!box.isEmpty()) {
      const c = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3()).length()
      controls.target.copy(c)
      camera.position.copy(c).add(new THREE.Vector3(size * 0.9, -size * 1.05, size * 0.7))
    }

    const fit = () => {
      const w = el.clientWidth || 1
      const h = el.clientHeight || 1
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)

    let raf = 0
    const loop = () => {
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(loop)
    }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [operations])

  if (operations.length === 0) {
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Nessuna feature da mostrare</p>
        <p>Genera un pezzo dalla chat: l&apos;anteprima usa schizzi, estrusioni e fori in millimetri.</p>
      </div>
    )
  }

  return <div ref={host} className="h-full min-h-[240px] w-full" />
}

function buildSolid(operations: CadOperation[]): THREE.Group {
  const group = new THREE.Group()
  const sketches = new Map<string, CadOperation>()
  const mat = new THREE.MeshStandardMaterial({
    color: 0xc4ccd4,
    metalness: 0.35,
    roughness: 0.38,
  })

  for (const op of operations) {
    if (op.type === "sketch") sketches.set(op.id, op)
  }

  for (const op of operations) {
    if (op.type !== "extrude") continue
    const sketch = sketches.get(op.sketch)
    if (!sketch || sketch.type !== "sketch") continue
    const shape = contoursToShape(sketch.contours, [])
    if (!shape) continue
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: op.depth,
      bevelEnabled: false,
      curveSegments: 24,
    })
    geom.translate(0, 0, 0)
    const mesh = new THREE.Mesh(geom, mat)
    group.add(mesh)
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom), new THREE.LineBasicMaterial({ color: 0x222222 })))
  }

  const holeSketches = operations.filter(
    (o) => o.type === "cut" && sketches.get(o.sketch)?.type === "sketch",
  )
  for (const cut of holeSketches) {
    if (cut.type !== "cut") continue
    const sketch = sketches.get(cut.sketch)
    if (!sketch || sketch.type !== "sketch") continue
    const depth =
      cut.throughAll
        ? operations.find((o) => o.type === "extrude" && o.type === "extrude") &&
          operations.find((o) => o.type === "extrude")!.type === "extrude"
          ? (operations.find((o) => o.type === "extrude") as Extract<CadOperation, { type: "extrude" }>).depth + 2
          : 12
        : (cut.depth ?? 10) + 2
    for (const c of sketch.contours) {
      if (c.kind !== "circle") continue
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(c.diameter / 2, c.diameter / 2, depth, 28),
        new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.1, roughness: 0.8 }),
      )
      cyl.rotation.x = Math.PI / 2
      cyl.position.set(c.cx, c.cy, depth / 2 - 1)
      group.add(cyl)
    }
  }

  for (const op of operations) {
    if (op.type !== "hole") continue
    const depth = op.throughAll === false ? op.depth ?? 8 : 12
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(op.diameter / 2, op.diameter / 2, depth, 28),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a }),
    )
    cyl.rotation.x = Math.PI / 2
    cyl.position.set(op.cx, op.cy, depth / 2)
    group.add(cyl)
  }

  if (group.children.length === 0) {
    const fallback = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 10), mat)
    fallback.position.z = 5
    group.add(fallback)
  }

  return group
}

function contoursToShape(
  contours: Extract<CadOperation, { type: "sketch" }>["contours"],
  holes: { cx: number; cy: number; diameter: number }[],
): THREE.Shape | null {
  const rect = contours.find((c) => c.kind === "rectangle")
  if (!rect || rect.kind !== "rectangle") return null
  const shape = new THREE.Shape()
  const x1 = rect.cx - rect.width / 2
  const y1 = rect.cy - rect.height / 2
  shape.moveTo(x1, y1)
  shape.lineTo(x1 + rect.width, y1)
  shape.lineTo(x1 + rect.width, y1 + rect.height)
  shape.lineTo(x1, y1 + rect.height)
  shape.closePath()
  for (const h of holes) {
    const path = new THREE.Path()
    path.absarc(h.cx, h.cy, h.diameter / 2, 0, Math.PI * 2, true)
    shape.holes.push(path)
  }
  for (const c of contours) {
    if (c.kind === "circle") {
      const path = new THREE.Path()
      path.absarc(c.cx, c.cy, c.diameter / 2, 0, Math.PI * 2, true)
      shape.holes.push(path)
    }
  }
  return shape
}
