/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: piastra 80×40×6 + boss Ø18×10 stesso PRT + perno Ø8×25.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Piastra 80 × 40 × 6 con un boss cilindrico Ø18 altezza 10 al centro della faccia superiore e foro passante Ø8 attraverso boss e piastra. Perno Ø8 lunghezza 25 nel foro, coincidente sulla faccia del boss. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-piastra-boss-perno")

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
  const compPaths = []
  for (const d of job) {
    if (d.document?.type === "part") partDocs.push(d.document.name)
    for (const op of d.operations || []) {
      types.push(op.type)
      if (op.type === "mate") mateTypes.push(String(op.mateType || op.subtype || op.kind || "").toLowerCase())
      if (op.type === "component" && op.path) compPaths.push(String(op.path))
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
    "comps",
    compPaths.join(","),
  )
  await page.getByText(/OpenRouter/i).nth(1).waitFor({ timeout: 15000 }).catch(() => {})
  await page.screenshot({ path: path.join(OUT, "ui-proposta.jpg"), type: "jpeg", quality: 85 })

  if (interpretBody.source === "demo") throw new Error("source=demo, serve OpenRouter")
  if (!/boss cilindrico/i.test(PROMPT) || !/Cartiglio_CM/i.test(PROMPT)) {
    throw new Error("prompt IT non rispettato")
  }
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa\b|Piastra90\b|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16$|AlberoSpallamento10|PiastraForo10$|Piastra50Foro10|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80\b|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8\b|Piastra70x50Foro8|AssiemeBarraT|Flangia80Pcd50|Albero12x50|DadoEsagono17|AlberoGola16|AlberoCava20|StaffaZ|Piastra60Smusso|Distanziale16x12|PiastraNervatura80|Perno8x30|Piastra50Raccordo|Boccola14x10|Piastra50Svasata|ViteSvasata6x16|Piastra70Sede12|ViteCilindrica6x16|AssiemePiastraSede|Base80x60|Colonna20x40|PiastraSuperiore50|AssiemeTrePezzi|TavolaTrePezzi|Piastra70Finestra|Coperchio70x50|AssiemePiastraFinestra|TavolaPiastraFinestra|PiastraGriglia6|Boccola12x10|AssiemePiastraGriglia|TavolaPiastraGriglia|Orecchio30|Perno8x50|AssiemeCerniera|Piastra50Foro16$|Albero16x80|PiastraForo16x50|AssiemeAlbero16Piastra|PiastraAsola100|Perno10x20|AssiemePiastraAsola|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`piastra+boss stesso PRT + perno = 2 PRT, parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("concentric") || !mateTypes.includes("coincident")) {
    throw new Error(`servono concentric+coincident, got ${mateTypes.join(",")}`)
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
  const hasCircle = (d, dia) => circlesOf(d).some((c) => Math.abs(Number(c.diameter) - dia) < 0.2)

  const plate = parts.find((d) => hasRect(d, 80, 40) && extOf(d, 6))
  const pin = parts.find((d) => d !== plate)
  if (!plate) throw new Error("manca piastra 80×40×6")
  if (!pin) throw new Error("manca perno")
  if (hasRect(pin, 80, 40) || hasRect(pin, 20, 20)) throw new Error("il perno non deve essere un cubo/piastra")
  if ((pin.operations || []).some((op) => op.type === "revolve")) throw new Error("perno è una vite/revolve, serve cilindro Ø8×25")
  if (!hasCircle(pin, 8) || !extOf(pin, 25)) throw new Error("perno atteso Ø8×25")
  if (extOf(pin, 30) && !extOf(pin, 25)) throw new Error("Perno8x30 della nervatura, serve L25")
  if (!hasCircle(plate, 18)) throw new Error("manca boss Ø18 sulla piastra")
  if (!extOf(plate, 10)) throw new Error("manca estrusione boss altezza 10")
  if (!hasCircle(plate, 8)) throw new Error("manca foro Ø8 through boss+piastra")
  const bossExt = (plate.operations || []).find(
    (op) => op.type === "extrude" && Math.abs(Number(op.depth) - 10) < 0.2,
  )
  if (bossExt && bossExt.merge === false) throw new Error("boss deve essere merge true sullo stesso PRT")

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
