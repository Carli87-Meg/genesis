/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: piastra 90×60×8 con 6 fori Ø6 in griglia 2×3 + boccola Ø12×10.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Piastra 90 × 60 × 8 con 6 fori Ø6 in due file da 3, passo 20 mm in lunghezza e 18 mm in larghezza, simmetrici al centro. Boccola Ø12 altezza 10 foro Ø6 nel foro centrale. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-piastra-pattern-fori")

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
  if (!/6 fori Ø6/i.test(PROMPT) || !/Cartiglio_CM/i.test(PROMPT)) {
    throw new Error("prompt IT non rispettato")
  }
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa\b|Piastra90\b|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|Piastra50Foro10|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80\b|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8\b|Piastra70x50Foro8|AssiemeBarraT|Flangia80Pcd50|Albero12x50|DadoEsagono17|AlberoGola16|AlberoCava20|StaffaZ|Piastra60Smusso|Distanziale16x12|PiastraNervatura80|Perno8x30|Piastra50Raccordo|Boccola14x10|Piastra50Svasata|ViteSvasata6x16|Piastra70Sede12|ViteCilindrica6x16|AssiemePiastraSede|Base80x60|Colonna20x40|PiastraSuperiore50|AssiemeTrePezzi|TavolaTrePezzi|Piastra70Finestra|Coperchio70x50|AssiemePiastraFinestra|TavolaPiastraFinestra|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`piastra+boccola = 2 PRT, parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric")) {
    throw new Error(`servono coincident+concentric, got ${mateTypes.join(",")}`)
  }
  if (!extrudes.includes(8) || !extrudes.includes(10)) {
    throw new Error(`estrusione 8 e 10 attese, got ${extrudes.join(",")}`)
  }

  const parts = job.filter((d) => d.document?.type === "part")
  const circlesOf = (d) =>
    (d.operations || [])
      .filter((op) => op.type === "sketch")
      .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  const rectsOf = (d) =>
    (d.operations || [])
      .filter((op) => op.type === "sketch")
      .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const hasRect = (d, a, b) =>
    rectsOf(d).some(
      (r) =>
        (Math.abs(Number(r.width) - a) < 0.2 && Math.abs(Number(r.height) - b) < 0.2) ||
        (Math.abs(Number(r.width) - b) < 0.2 && Math.abs(Number(r.height) - a) < 0.2),
    )
  const extOf = (d, depth) =>
    (d.operations || []).some((op) => op.type === "extrude" && Math.abs(Number(op.depth) - depth) < 0.2)

  const plate = parts.find((d) => hasRect(d, 90, 60) && extOf(d, 8))
  const bush = parts.find((d) => d !== plate)
  if (!plate) throw new Error("manca piastra 90×60×8")
  if (!bush) throw new Error("manca boccola")
  const holes = circlesOf(plate).filter((c) => Math.abs(Number(c.diameter) - 6) < 0.2)
  if (holes.length !== 6) throw new Error(`fori Ø6 sulla piastra: ${holes.length}, attesi 6`)
  const tascaCorners = holes.filter(
    (c) => Math.abs(Math.abs(Number(c.cx)) - 32) < 1 && Math.abs(Math.abs(Number(c.cy)) - 17) < 1,
  )
  if (tascaCorners.length >= 4) throw new Error("4 fori angolo tasca ±32±17 al posto della griglia 2×3")
  const expected = [
    [-20, 9],
    [0, 9],
    [20, 9],
    [-20, -9],
    [0, -9],
    [20, -9],
  ]
  for (const [x, y] of expected) {
    const hit = holes.some((c) => Math.abs(Number(c.cx) - x) < 0.3 && Math.abs(Number(c.cy) - y) < 0.3)
    if (!hit) throw new Error(`manca foro Ø6 a (${x},${y})`)
  }
  const bushCircles = circlesOf(bush)
  const d12 = bushCircles.some((c) => Math.abs(Number(c.diameter) - 12) < 0.2)
  const d6b = bushCircles.some((c) => Math.abs(Number(c.diameter) - 6) < 0.2)
  if (!d12 || !d6b || !extOf(bush, 10)) {
    throw new Error("boccola attesa Ø12×10 con foro Ø6")
  }
  if (hasRect(bush, 90, 60)) throw new Error("la boccola non deve essere una seconda piastra")

  const asm = job.find((d) => d.document?.type === "assembly")
  const conc = (asm?.operations || []).find((op) => op.type === "mate" && String(op.mateType).toLowerCase() === "concentric")
  if (conc && conc.holeZ == null && conc.holeY == null) {
    console.warn("concentric senza holeZ: sanitizer dovrebbe averlo messo")
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
