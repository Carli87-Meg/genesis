/**
 * Percorso chat UI: Proponi + Esegui in SolidWorks (non POST diretto al bridge).
 * Prompt italiano nuovo: boccola flangiata (revolve) + piastra, niente kit/demo.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "boccola Ø16 L25 con flangia Ø28 spessore 4 e 4 fori Ø4.2, piastra 70×50×5 con foro centrale Ø16, assieme concentrico nel foro, quote sugli schizzi, tavola A3"
const OUT = path.join("sw-out", "chat-boccola-flangia")

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
  const names = (interpretBody.job || []).map((d) => d.document?.name || "")
  const types = []
  for (const d of interpretBody.job || []) {
    for (const op of d.operations || []) types.push(op.type)
  }
  console.log(
    "interpret",
    interpretRes.status(),
    interpretBody.source,
    interpretBody.summary,
    names,
    "ops",
    types.join(","),
  )
  if (interpretBody.source === "demo") throw new Error("source=demo, serve OpenRouter")
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa|Piastra90|PiastraBase|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|AssemblePiastraCilindro|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo: ${names.join(",")}`)
  if (!types.includes("revolve")) {
    throw new Error(`boccola senza revolve: ${types.join(",")}`)
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
    timeout: 240000,
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
