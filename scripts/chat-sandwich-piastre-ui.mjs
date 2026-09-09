/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: due piastre identiche = un PRT ×2 + distanziale sandwich.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Due piastre 60 × 40 × 6 con foro Ø10 al centro, distanziale cilindrico Ø16 × 20 con foro Ø10, in mezzo a contatto su entrambe le facce. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-sandwich-piastre")

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
  const compPaths = []
  const extrudes = []
  const circles = []
  const rects = []
  for (const d of job) {
    if (d.document?.type === "part") partDocs.push(d.document.name)
    for (const op of d.operations || []) {
      types.push(op.type)
      if (op.type === "mate") mateTypes.push(String(op.mateType || op.subtype || op.kind || "").toLowerCase())
      if (op.type === "component" && op.path) compPaths.push(String(op.path))
      if (op.type === "extrude") extrudes.push(Number(op.depth))
      if (op.type === "sketch") {
        for (const c of op.contours || []) {
          if (c.kind === "circle" || c.type === "circle") circles.push(c)
          if (c.kind === "rectangle" || c.type === "rectangle") rects.push(c)
        }
      }
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
  if (interpretBody.source === "demo") throw new Error("source=demo, serve OpenRouter")
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|DistanzialeRound|BaseRettangolare|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`due piastre identiche = un PRT ×2 + distanziale, parti=${partDocs.join(",")}`)
  }
  const uniqueComps = [...new Set(compPaths.map((p) => p.replace(/\\/g, "/").toLowerCase()))]
  if (compPaths.length !== 3 || uniqueComps.length !== 2) {
    throw new Error(`componenti attesi 3 insert / 2 path, got ${compPaths.length}/${uniqueComps.length} ${compPaths.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric")) {
    throw new Error(`servono mate coincident+concentric, got ${mateTypes.join(",")}`)
  }
  const coincCount = mateTypes.filter((m) => m === "coincident").length
  if (coincCount < 2) {
    throw new Error(`servono ≥2 coincident (entrambe le facce), got ${coincCount}`)
  }
  const hasPlate = rects.some(
    (r) =>
      (Number(r.width) === 60 && Number(r.height) === 40) ||
      (Number(r.width) === 40 && Number(r.height) === 60),
  )
  const d10 = circles.filter((c) => Number(c.diameter) === 10)
  const d16 = circles.filter((c) => Number(c.diameter) === 16)
  if (!hasPlate) throw new Error("manca piastra 60×40")
  if (d10.length < 2) throw new Error(`fori Ø10 attesi su piastra e distanziale, got ${d10.length}`)
  if (d16.length < 1) throw new Error("manca Ø16 distanziale")
  if (!extrudes.includes(6) || !extrudes.includes(20)) {
    throw new Error(`estrusioni attese 6 e 20 mm, got ${extrudes.join(",")}`)
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
