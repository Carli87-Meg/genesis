/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: piastra con tasca + coperchio, non kit staffa a L.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Piastra 80 × 50 × 8 con quattro fori Ø6 a 8 mm dagli angoli e una tasca rettangolare 30 × 12 profonda 3 al centro. Coperchio 80 × 50 × 4 coincidente sulla faccia superiore, fori allineati. Quote vere su ogni schizzo feature (estrusione, fori, tasca). Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-piastra-coperchio")

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

function circlesOf(doc) {
  const out = []
  for (const op of doc.operations || []) {
    if (op.type !== "sketch") continue
    for (const c of op.contours || []) {
      if (c.kind === "circle" || c.type === "circle") out.push(c)
    }
  }
  return out
}

function rectsOf(doc) {
  const out = []
  for (const op of doc.operations || []) {
    if (op.type !== "sketch") continue
    for (const c of op.contours || []) {
      if (c.kind === "rectangle" || c.type === "rectangle") out.push(c)
    }
  }
  return out
}

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
  const cuts = []
  const extrudes = []
  for (const d of job) {
    if (d.document?.type === "part") partDocs.push(d.document.name)
    for (const op of d.operations || []) {
      types.push(op.type)
      if (op.type === "mate") mateTypes.push(String(op.mateType || op.subtype || op.kind || "").toLowerCase())
      if (op.type === "cut") cuts.push(op)
      if (op.type === "extrude") extrudes.push(op)
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
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10|PiastraBaseU|MontanteU|AssiemeTelaioU|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`attese 2 parti (piastra+coperchio), parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("coincident")) {
    throw new Error(`serve mate coincident, got ${mateTypes.join(",")}`)
  }

  const parts = job.filter((d) => d.document?.type === "part")
  const pocketCuts = cuts.filter((op) => op.throughAll !== true && Number(op.depth) === 3)
  if (pocketCuts.length < 1) {
    throw new Error(`manca tasca cut depth 3 (non throughAll): ${JSON.stringify(cuts)}`)
  }
  const depths = extrudes.map((op) => Number(op.depth)).sort((a, b) => a - b)
  if (!depths.includes(8) || !depths.includes(4)) {
    throw new Error(`estrusioni attese 8 e 4 mm, got ${depths.join(",")}`)
  }

  let holeOk = false
  let pocketRectOk = false
  for (const d of parts) {
    const circ = circlesOf(d)
    const d6 = circ.filter((c) => Number(c.diameter) === 6)
    if (d6.length === 4) {
      const xs = d6.map((c) => Math.abs(Number(c.cx)))
      const ys = d6.map((c) => Math.abs(Number(c.cy)))
      const near32 = xs.every((v) => Math.abs(v - 32) < 0.6)
      const near17 = ys.every((v) => Math.abs(v - 17) < 0.6)
      if (near32 && near17) holeOk = true
    }
    const rects = rectsOf(d)
    if (
      rects.some(
        (r) =>
          (Number(r.width) === 30 && Number(r.height) === 12) ||
          (Number(r.width) === 12 && Number(r.height) === 30),
      )
    ) {
      pocketRectOk = true
    }
  }
  if (!holeOk) throw new Error("quattro fori Ø6 a (±32, ±17) mancanti")
  if (!pocketRectOk) throw new Error("tasca 30×12 mancante")

  const summary = String(interpretBody.summary || "")
  if (/parete 40|boss Ø16|boccola/i.test(summary) && /Staffa/i.test(summary)) {
    throw new Error(`interpret ha preso il kit L: ${summary}`)
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
