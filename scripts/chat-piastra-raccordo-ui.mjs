/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: piastra con raccordo feature R3 + boccola, non rettangolo già arrotondato.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Piastra 50 × 40 × 8, raccordi R3 su tutti gli spigoli dello spessore. Foro Ø8 al centro. Boccola Ø14 × 10 con foro Ø8. Boccola concentrica, faccia coincidente. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-piastra-raccordo")

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
  if (!/raccordi R3/i.test(PROMPT) || !/Cartiglio_CM/i.test(PROMPT)) {
    throw new Error("prompt IT non rispettato")
  }
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa\b|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|Piastra50Foro10|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8\b|AssiemeBarraT|Flangia80Pcd50|Albero12x50|AssiemeFlangiaAlbero|DadoEsagono17|AssiemeDadoPiastra|AlberoGola16|Piastra50Foro16|AssiemeAlberoGola|AlberoCava20|Piastra60Foro20|AssiemeAlberoCava|StaffaZ|Piastra70x50Foro8|AssiemeStaffaZ|Piastra60Smusso|Distanziale16x12|AssiemePiastraSmusso|PiastraNervatura80|Perno8x30|AssiemePiastraNervatura|Assemie|demo/i
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
    throw new Error(`estrusioni attese 8 (piastra) e 10 (boccola), got ${extrudes.join(",")}`)
  }

  const parts = job.filter((d) => d.document?.type === "part")
  const plate =
    parts.find((d) => (d.operations || []).some((op) => op.type === "extrude" && Number(op.depth) === 8)) ||
    parts.find((d) => /piastra|plate|raccordo|fillet/i.test(d.document?.name || ""))
  if (!plate) throw new Error("manca piastra 50×40×8")
  const plateRects = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const plate50 = plateRects.some(
    (r) =>
      (Math.abs(Number(r.width) - 50) < 0.2 && Math.abs(Number(r.height) - 40) < 0.2) ||
      (Math.abs(Number(r.width) - 40) < 0.2 && Math.abs(Number(r.height) - 50) < 0.2),
  )
  if (!plate50) throw new Error("manca rettangolo piastra 50×40")
  const plateArcs = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "arc" || c.type === "arc"))
  if (plateArcs.length >= 2) {
    throw new Error("piastra come rettangolo arrotondato in schizzo: serve feature fillet")
  }
  const fillets = (plate.operations || []).filter((op) => op.type === "fillet")
  if (fillets.length < 1) throw new Error("manca feature fillet sulla piastra")
  const r3 = fillets.some((op) => Math.abs(Number(op.radius) - 3) < 0.2)
  if (!r3) throw new Error(`raccordo atteso R3, got ${fillets.map((f) => f.radius).join(",")}`)
  const ext8 = (plate.operations || []).findIndex((op) => op.type === "extrude" && Number(op.depth) === 8)
  const fIdx = (plate.operations || []).findIndex((op) => op.type === "fillet")
  const cutIdx = (plate.operations || []).findIndex((op) => op.type === "cut")
  if (fIdx < ext8) throw new Error("fillet prima dell’estrusione")
  if (cutIdx >= 0 && fIdx > cutIdx) throw new Error("fillet dopo il foro: raccorderebbe il Ø8")
  const plateD8 = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
    .some((c) => Number(c.diameter) === 8)
  if (!plateD8) throw new Error("manca foro piastra Ø8")
  if ((plate.operations || []).some((op) => op.type === "chamfer")) {
    throw new Error("serve fillet, non chamfer")
  }

  const bush = parts.find((d) => d !== plate)
  if (!bush) throw new Error("manca boccola")
  if ((bush.operations || []).some((op) => op.type === "revolve")) {
    throw new Error("boccola deve essere estrusione+taglio, non revolve")
  }
  const b10 = (bush.operations || []).some((op) => op.type === "extrude" && Number(op.depth) === 10)
  if (!b10) throw new Error("manca estrusione 10 della boccola")
  const bCircles = (bush.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  if (!bCircles.some((c) => Number(c.diameter) === 14)) throw new Error("manca Ø14 boccola")
  if (!bCircles.some((c) => Number(c.diameter) === 8)) throw new Error("manca foro Ø8 boccola")

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
