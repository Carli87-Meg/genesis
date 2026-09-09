/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: flangia circolare PCD + albero, non cubo/piastra/kit.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Flangia circolare Ø80 spessore 8, foro centrale Ø12, quattro fori Ø8 su diametro primitivo 50. Albero Ø12 lunghezza 50. Albero nel foro centrale, flangia coincidente su una faccia. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-flangia-pcd")

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
  const sketches = []
  for (const d of job) {
    if (d.document?.type === "part") partDocs.push(d.document.name)
    for (const op of d.operations || []) {
      types.push(op.type)
      if (op.type === "mate") mateTypes.push(String(op.mateType || op.subtype || op.kind || "").toLowerCase())
      if (op.type === "sketch") sketches.push(op)
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
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8|AssiemeBarraT|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`flangia+albero = 2 PRT, parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric")) {
    throw new Error(`servono coincident+concentric, got ${mateTypes.join(",")}`)
  }

  const parts = job.filter((d) => d.document?.type === "part")
  const flange =
    parts.find((d) =>
      (d.operations || []).some(
        (op) =>
          op.type === "sketch" &&
          (op.contours || []).some((c) => (c.kind === "circle" || c.type === "circle") && Number(c.diameter) === 80),
      ),
    ) || null
  if (!flange) throw new Error("manca flangia circolare Ø80 (non piastra rettangolare)")
  const flangeRects = (flange.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const flangeCircles = (flange.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  if (flangeRects.some((r) => Number(r.width) >= 70 || Number(r.height) >= 70)) {
    throw new Error("flangia è un rettangolo/cubo, serve cerchio Ø80")
  }
  const d80 = flangeCircles.filter((c) => Number(c.diameter) === 80)
  if (d80.length < 1) throw new Error("manca cerchio Ø80 sulla flangia")
  const d12 = flangeCircles.filter((c) => Number(c.diameter) === 12)
  if (d12.length < 1) throw new Error("manca foro centrale Ø12")
  const d8 = flangeCircles.filter((c) => Number(c.diameter) === 8)
  const onPcd = d8.filter((c) => Math.abs(Math.hypot(Number(c.cx) || 0, Number(c.cy) || 0) - 25) < 1.5)
  if (onPcd.length < 4) {
    throw new Error(
      `servono 4 fori Ø8 su PCD 50 (r=25), got ${d8.length} Ø8 di cui ${onPcd.length} su r=25: ${d8
        .map((c) => `${c.cx},${c.cy}`)
        .join(" | ")}`,
    )
  }
  const shaft =
    parts.find((d) => d !== flange) ||
    parts.find((d) => /albero|shaft/i.test(d.document?.name || ""))
  if (!shaft) throw new Error("manca parte albero")
  const shaftCircles = (shaft.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  const shaftHas12 =
    shaftCircles.some((c) => Number(c.diameter) === 12) ||
    (shaft.operations || []).some((op) => op.type === "extrude" && Number(op.depth) === 50) ||
    (shaft.operations || []).some((op) => op.type === "revolve")
  if (!shaftHas12) throw new Error("albero: manca Ø12 o estrusione/revolve 50")
  const inventedShoulder = shaftCircles.some((c) => {
    const d = Number(c.diameter)
    return d > 12.5 && d !== 80
  })
  if (inventedShoulder) throw new Error("albero: spallamento inventato")

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
