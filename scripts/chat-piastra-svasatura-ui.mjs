/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: piastra foro svasato 90° + vite testa svasata, non un Ø6 cilindrico.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Piastra 50 × 40 × 6, foro Ø6 svasato 90° Ø12 da una faccia. Vite testa svasata Ø6 lunghezza 16. Vite nel foro, testa a filo della svasatura. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-piastra-svasatura")

fs.mkdirSync(OUT, { recursive: true })

const cleanup = await fetch(`${APP}/api/solidworks`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "cleanup", keep: "" }),
})
const cleanupJson = await cleanup.json()
console.log("cleanup", cleanupJson.ok, cleanupJson.steps?.[0]?.detail)
await new Promise((r) => setTimeout(r, 8000))

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } })
page.setDefaultTimeout(180000)

try {
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.getByRole("button", { name: /Impostazioni/i }).waitFor({ timeout: 20000 })
  const header = (await page.locator("header").innerText()).replace(/\s+/g, " ")
  console.log("header", header.slice(0, 220))
  if (!/OpenRouter/i.test(header)) {
    throw new Error(`UI in demo, non OpenRouter: ${header}`)
  }

  const nuova = page.getByRole("button", { name: /Nuova chat/i })
  if (await nuova.isVisible().catch(() => false)) await nuova.click()

  const interpretWait = page.waitForResponse(
    (r) => r.url().includes("/api/interpret") && r.request().method() === "POST",
    { timeout: 120000 },
  )
  await page.locator("textarea").fill(PROMPT)
  await page.getByRole("button", { name: /^Proponi$/ }).click()
  const interpretRes = await interpretWait
  const interpretBody = await interpretRes.json()
  fs.writeFileSync(path.join(OUT, "interpret.json"), JSON.stringify(interpretBody, null, 2))
  const job = interpretBody.job || []
  const names = job.map((d) => d.document?.name || "")
  const types = []
  const mateTypes = []
  const partDocs = []
  const extrudes = []
  for (const d of job) {
    if (d.document?.type === "part") partDocs.push(d.document.name)
    for (const op of d.operations || []) {
      types.push(op.type)
      if (op.type === "mate") mateTypes.push(String(op.mateType || op.subtype || op.kind || "").toLowerCase())
      if (op.type === "extrude") extrudes.push(Number(op.depth))
    }
  }
  console.log(
    "interpret",
    interpretRes.status(),
    interpretBody.source,
    interpretBody.summary,
    names,
    "ops",
    types.join(","),
    "mates",
    mateTypes.join(","),
    "parts",
    partDocs.join(","),
  )
  if (interpretBody.source === "demo") throw new Error("source=demo, serve OpenRouter")
  if (!/svasato 90°/i.test(PROMPT) || !/Cartiglio_CM/i.test(PROMPT)) {
    throw new Error("prompt IT non rispettato")
  }
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa\b|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|Piastra50Foro10|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8\b|AssiemeBarraT|Flangia80Pcd50|Albero12x50|AssiemeFlangiaAlbero|DadoEsagono17|AssiemeDadoPiastra|AlberoGola16|Piastra50Foro16|AssiemeAlberoGola|AlberoCava20|Piastra60Foro20|AssiemeAlberoCava|StaffaZ|Piastra70x50Foro8|AssiemeStaffaZ|Piastra60Smusso|Distanziale16x12|AssiemePiastraSmusso|PiastraNervatura80|Perno8x30|AssiemePiastraNervatura|Piastra50Raccordo|Boccola14x10|AssiemePiastraRaccordo|TavolaPiastraRaccordo|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`piastra+vite = 2 PRT, parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric")) {
    throw new Error(`servono coincident+concentric, got ${mateTypes.join(",")}`)
  }

  const parts = job.filter((d) => d.document?.type === "part")
  const plate =
    parts.find((d) => (d.operations || []).some((op) => op.type === "extrude" && Number(op.depth) === 6)) ||
    parts.find((d) => /piastra|plate|svasat/i.test(d.document?.name || ""))
  if (!plate) throw new Error("manca piastra 50×40×6")
  const plateRects = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const plate50 = plateRects.some(
    (r) =>
      (Math.abs(Number(r.width) - 50) < 0.2 && Math.abs(Number(r.height) - 40) < 0.2) ||
      (Math.abs(Number(r.width) - 40) < 0.2 && Math.abs(Number(r.height) - 50) < 0.2),
  )
  if (!plate50) throw new Error("manca rettangolo piastra 50×40")
  if (!extrudes.includes(6)) throw new Error(`estrusione piastra 6 attesa, got ${extrudes.join(",")}`)
  const plateD6 = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
    .some((c) => Number(c.diameter) === 6)
  if (!plateD6) throw new Error("manca foro piastra Ø6")
  const plateD12Through = (plate.operations || []).some((op) => {
    if (op.type !== "cut" || !op.throughAll) return false
    const sk = (plate.operations || []).find((s) => s.type === "sketch" && s.id === op.sketch)
    const circles = (sk?.contours || []).filter((c) => c.kind === "circle" || c.type === "circle")
    return circles.length > 0 && circles.every((c) => Number(c.diameter) === 12)
  })
  if (plateD12Through) throw new Error("svasatura come foro cilindrico Ø12 throughAll")
  const plateRev = (plate.operations || []).filter((op) => op.type === "revolve")
  if (!plateRev.some((op) => op.cut === true)) {
    throw new Error("manca revolve cut della svasatura (cono, non solo Ø6)")
  }
  const cskSketch = (plate.operations || []).find(
    (op) =>
      op.type === "sketch" &&
      /front/i.test(String(op.plane || "")) &&
      (op.contours || []).some((c) => c.kind === "line" || c.type === "line"),
  )
  if (!cskSketch) throw new Error("manca schizzo Front triangolo svasatura")
  const cskXs = (cskSketch.contours || [])
    .filter((c) => c.kind === "line" || c.type === "line")
    .flatMap((c) => [Number(c.x1), Number(c.x2)])
  if (!cskXs.some((x) => Math.abs(x - 6) < 0.3)) throw new Error("svasatura senza raggio Ø12 (x=6)")
  if ((plate.operations || []).some((op) => op.type === "fillet" || op.type === "chamfer")) {
    throw new Error("svasatura deve essere revolve cut, non fillet/chamfer")
  }

  const screw = parts.find((d) => d !== plate)
  if (!screw) throw new Error("manca vite")
  const screwRev = (screw.operations || []).filter((op) => op.type === "revolve")
  if (screwRev.length < 1) throw new Error("vite deve essere un PRT in rivoluzione, non un cilindro")
  if (screwRev.some((op) => op.cut === true)) throw new Error("vite: rivoluzione boss, non cut")
  const screwExt6 = (screw.operations || []).some((op) => op.type === "extrude" && Number(op.depth) === 16)
  const screwOnlyD6 = (screw.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
    .every((c) => Number(c.diameter) === 6)
  const screwCircles = (screw.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  if (screwExt6 && screwCircles.length > 0 && screwOnlyD6) {
    throw new Error("vite è un cilindro Ø6, serve testa svasata nello stesso PRT")
  }
  const screwLines = (screw.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "line" || c.type === "line"))
  const screwMaxX = Math.max(0, ...screwLines.flatMap((c) => [Number(c.x1), Number(c.x2)]))
  if (screwMaxX < 5.5) throw new Error(`vite senza testa Ø12 (max x=${screwMaxX})`)
  const asm = job.find((d) => d.document?.type === "assembly")
  const conc = (asm?.operations || []).find((op) => op.type === "mate" && op.mateType === "concentric")
  if (conc && conc.diameter != null && Number(conc.diameter) !== 6) {
    throw new Error(`concentric Ø atteso 6, got ${conc.diameter}`)
  }

  await page.getByText(/OpenRouter/i).nth(1).waitFor({ timeout: 15000 }).catch(() => {})
  await page.screenshot({ path: path.join(OUT, "ui-proposta.jpg"), type: "jpeg", quality: 85 })

  const swResponses = []
  page.on("response", async (r) => {
    if (r.url().includes("/api/solidworks") && r.request().method() === "POST") {
      try {
        swResponses.push(await r.json())
      } catch {
        /* ignore */
      }
    }
  })

  const execBtn = page.getByRole("button", { name: /Esegui in SolidWorks/i }).first()
  await execBtn.waitFor({ state: "visible", timeout: 20000 })
  await execBtn.click()
  await page.getByText(/Eseguito in SolidWorks|Esecuzione interrotta|Bridge irraggiungibile/i).waitFor({
    timeout: 300000,
  })
  const chat = await page.locator("main").innerText()
  fs.writeFileSync(path.join(OUT, "chat.txt"), chat)
  fs.writeFileSync(path.join(OUT, "solidworks.json"), JSON.stringify(swResponses, null, 2))
  await page.screenshot({ path: path.join(OUT, "ui-eseguito.jpg"), type: "jpeg", quality: 85 })
  const ok = /Eseguito in SolidWorks/i.test(chat) && !/Esecuzione interrotta/i.test(chat)
  const verifyFail = /verify FAIL/i.test(chat)
  console.log("execute_ok", ok, "verify_fail", verifyFail)
  if (!ok) {
    console.log(chat.slice(-1200))
    process.exitCode = 1
  }
  if (verifyFail) {
    console.error("VERIFY_FAIL_IN_CHAT")
    process.exitCode = 1
  }
} catch (err) {
  console.error("CHAT_UI_FAIL", err)
  await page.screenshot({ path: path.join(OUT, "ui-fail.jpg"), type: "jpeg", quality: 80 }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
