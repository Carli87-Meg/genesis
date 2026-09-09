/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: piastra con smusso feature + distanziale, non profilo già smussato.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Piastra 60 × 40 × 8, smusso 2 × 45° su tutti gli spigoli dello spessore. Foro Ø10 al centro. Distanziale Ø16 × 12 con foro Ø10. Distanziale concentrico, faccia coincidente. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-piastra-smusso")

fs.mkdirSync(OUT, { recursive: true })

const cleanup = await fetch(`${APP}/api/solidworks`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "cleanup", keep: "" }),
})
const cleanupJson = await cleanup.json()
console.log("cleanup", cleanupJson.ok, cleanupJson.steps?.[0]?.detail)

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
  if (!/smusso 2/i.test(PROMPT) || !/Cartiglio_CM/i.test(PROMPT)) {
    throw new Error("prompt IT non rispettato")
  }
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa\b|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8\b|AssiemeBarraT|Flangia80Pcd50|Albero12x50|AssiemeFlangiaAlbero|DadoEsagono17|Piastra50Foro10|AssiemeDadoPiastra|AlberoGola16|Piastra50Foro16|AssiemeAlberoGola|AlberoCava20|Piastra60Foro20|AssiemeAlberoCava|StaffaZ|Piastra70x50Foro8|AssiemeStaffaZ|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`piastra+distanziale = 2 PRT, non sandwich a 3, parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric")) {
    throw new Error(`servono coincident+concentric, got ${mateTypes.join(",")}`)
  }
  if (!extrudes.includes(8) || !extrudes.includes(12)) {
    throw new Error(`estrusioni attese 8 (piastra) e 12 (distanziale), got ${extrudes.join(",")}`)
  }

  const parts = job.filter((d) => d.document?.type === "part")
  const plate =
    parts.find((d) => (d.operations || []).some((op) => op.type === "extrude" && Number(op.depth) === 8)) ||
    parts.find((d) => /piastra|plate|smusso/i.test(d.document?.name || ""))
  if (!plate) throw new Error("manca piastra 60×40×8")
  const plateRects = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const plate60 = plateRects.some(
    (r) =>
      (Math.abs(Number(r.width) - 60) < 0.2 && Math.abs(Number(r.height) - 40) < 0.2) ||
      (Math.abs(Number(r.width) - 40) < 0.2 && Math.abs(Number(r.height) - 60) < 0.2),
  )
  if (!plate60) throw new Error("manca rettangolo piastra 60×40")
  const plateLines = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => (c.kind === "line" || c.type === "line") && !c.construction))
  if (plateLines.length >= 8) {
    throw new Error("piastra come polilinea smussata: serve rettangolo + feature chamfer")
  }
  const chamfers = (plate.operations || []).filter((op) => op.type === "chamfer")
  if (chamfers.length < 1) throw new Error("manca feature chamfer sulla piastra")
  const ch2 = chamfers.some((op) => Math.abs(Number(op.distance) - 2) < 0.2)
  if (!ch2) throw new Error(`smusso atteso 2 mm, got ${chamfers.map((c) => c.distance).join(",")}`)
  const ext8 = (plate.operations || []).findIndex((op) => op.type === "extrude" && Number(op.depth) === 8)
  const chIdx = (plate.operations || []).findIndex((op) => op.type === "chamfer")
  const cutIdx = (plate.operations || []).findIndex((op) => op.type === "cut")
  if (chIdx < ext8) throw new Error("chamfer prima dell’estrusione")
  if (cutIdx >= 0 && chIdx > cutIdx) throw new Error("chamfer dopo il foro: smusserebbe il Ø10")
  const plateD10 = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
    .some((c) => Number(c.diameter) === 10)
  if (!plateD10) throw new Error("manca foro piastra Ø10")

  const spacer = parts.find((d) => d !== plate)
  if (!spacer) throw new Error("manca distanziale")
  if ((spacer.operations || []).some((op) => op.type === "revolve")) {
    throw new Error("distanziale deve essere estrusione+taglio, non revolve")
  }
  const sp12 = (spacer.operations || []).some((op) => op.type === "extrude" && Number(op.depth) === 12)
  if (!sp12) throw new Error("manca estrusione 12 del distanziale")
  const spCircles = (spacer.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  if (!spCircles.some((c) => Number(c.diameter) === 16)) throw new Error("manca Ø16 distanziale")
  if (!spCircles.some((c) => Number(c.diameter) === 10)) throw new Error("manca foro Ø10 distanziale")

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
