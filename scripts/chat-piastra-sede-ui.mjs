/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: piastra sede cilindrica Ø12×4 + vite testa cilindrica, non svasatura e non un Ø6 solo.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Piastra 70 × 50 × 10, sede cilindrica Ø12 profondità 4 e foro passante Ø6. Vite testa cilindrica: testa Ø10 altezza 4, gambo Ø6 lunghezza 16. Vite nel foro, testa a fondo della sede. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-piastra-sede")

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
  if (!/sede cilindrica/i.test(PROMPT) || !/Cartiglio_CM/i.test(PROMPT)) {
    throw new Error("prompt IT non rispettato")
  }
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa\b|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|Piastra50Foro10|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8\b|Piastra70x50Foro8|AssiemeBarraT|Flangia80Pcd50|Albero12x50|AssiemeFlangiaAlbero|DadoEsagono17|AssiemeDadoPiastra|AlberoGola16|Piastra50Foro16|AssiemeAlberoGola|AlberoCava20|Piastra60Foro20|AssiemeAlberoCava|StaffaZ|AssiemeStaffaZ|Piastra60Smusso|Distanziale16x12|AssiemePiastraSmusso|PiastraNervatura80|Perno8x30|AssiemePiastraNervatura|Piastra50Raccordo|Boccola14x10|AssiemePiastraRaccordo|Piastra50Svasata|ViteSvasata6x16|AssiemePiastraSvasata|TavolaPiastraSvasata|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`piastra+vite = 2 PRT, parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric")) {
    throw new Error(`servono coincident+concentric, got ${mateTypes.join(",")}`)
  }
  if (!extrudes.includes(10)) throw new Error(`estrusione piastra 10 attesa, got ${extrudes.join(",")}`)

  const parts = job.filter((d) => d.document?.type === "part")
  const plate =
    parts.find((d) => (d.operations || []).some((op) => op.type === "extrude" && Number(op.depth) === 10)) ||
    parts.find((d) => /piastra|plate|sede/i.test(d.document?.name || ""))
  if (!plate) throw new Error("manca piastra 70×50×10")
  const plateRects = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const plate70 = plateRects.some(
    (r) =>
      (Math.abs(Number(r.width) - 70) < 0.2 && Math.abs(Number(r.height) - 50) < 0.2) ||
      (Math.abs(Number(r.width) - 50) < 0.2 && Math.abs(Number(r.height) - 70) < 0.2),
  )
  if (!plate70) throw new Error("manca rettangolo piastra 70×50")
  const plateCircles = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  if (!plateCircles.some((c) => Number(c.diameter) === 12)) throw new Error("manca sede Ø12")
  if (!plateCircles.some((c) => Number(c.diameter) === 6)) throw new Error("manca foro Ø6")
  const boreCut = (plate.operations || []).find((op) => {
    if (op.type !== "cut") return false
    const sk = (plate.operations || []).find((s) => s.type === "sketch" && s.id === op.sketch)
    const d12 = (sk?.contours || []).some(
      (c) => (c.kind === "circle" || c.type === "circle") && Number(c.diameter) === 12,
    )
    return d12
  })
  if (!boreCut) throw new Error("manca taglio della sede Ø12")
  if (boreCut.throughAll === true) throw new Error("sede Ø12 throughAll: serve cieco profondità 4")
  if (Math.abs(Number(boreCut.depth) - 4) > 0.2) throw new Error(`sede profondità 4 attesa, got ${boreCut.depth}`)
  const holeCut = (plate.operations || []).find((op) => {
    if (op.type !== "cut") return false
    const sk = (plate.operations || []).find((s) => s.type === "sketch" && s.id === op.sketch)
    const d6 = (sk?.contours || []).some(
      (c) => (c.kind === "circle" || c.type === "circle") && Number(c.diameter) === 6,
    )
    return d6
  })
  if (!holeCut || holeCut.throughAll !== true) throw new Error("manca foro Ø6 throughAll")
  if ((plate.operations || []).some((op) => op.type === "revolve" && op.cut === true)) {
    throw new Error("sede deve essere taglio cilindrico, non revolve cut conico")
  }

  const screw = parts.find((d) => d !== plate)
  if (!screw) throw new Error("manca vite")
  const screwRev = (screw.operations || []).filter((op) => op.type === "revolve")
  if (screwRev.length < 1) throw new Error("vite deve essere rivoluzione testa+gambo, non un cilindro")
  if (screwRev.some((op) => op.cut === true)) throw new Error("vite: rivoluzione boss, non cut")
  const screwLines = (screw.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "line" || c.type === "line"))
  const screwMaxX = Math.max(0, ...screwLines.flatMap((c) => [Number(c.x1), Number(c.x2)]))
  if (screwMaxX < 4.5 || screwMaxX > 5.6) {
    throw new Error(`vite testa Ø10 attesa (x=5), max x=${screwMaxX}`)
  }
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
