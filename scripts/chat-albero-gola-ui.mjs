/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: albero Ø16 con gola anulare + piastra, non tre cilindri.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Albero Ø16 lunghezza 60, gola Ø12 larghezza 3 a 10 mm da un estremo. Piastra 50 × 40 × 6 con foro Ø16. Albero nel foro, faccia coincidente all’estremo opposto alla gola. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-albero-gola")

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
  for (const d of job) {
    if (d.document?.type === "part") partDocs.push(d.document.name)
    for (const op of d.operations || []) {
      types.push(op.type)
      if (op.type === "mate") mateTypes.push(String(op.mateType || op.subtype || op.kind || "").toLowerCase())
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
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8|AssiemeBarraT|Flangia80Pcd50|Albero12x50|AssiemeFlangiaAlbero|DadoEsagono17|Piastra50Foro10|AssiemeDadoPiastra|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`albero+piastra = 2 PRT (non tre cilindri), parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric")) {
    throw new Error(`servono coincident+concentric, got ${mateTypes.join(",")}`)
  }

  const parts = job.filter((d) => d.document?.type === "part")
  const shaft =
    parts.find((d) => (d.operations || []).some((op) => op.type === "revolve")) ||
    parts.find((d) => /albero|shaft|gola/i.test(d.document?.name || ""))
  if (!shaft) throw new Error("manca parte albero")
  const shaftRevolves = (shaft.operations || []).filter((op) => op.type === "revolve")
  if (shaftRevolves.length > 1) {
    throw new Error("secondo revolve = materiale aggiunto, serve un solo revolve con gola nello schizzo")
  }
  const shaftLines = (shaft.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "line" || c.type === "line"))
  const profile = shaftLines.filter((c) => !c.construction)
  const xs = profile.flatMap((c) => [Number(c.x1), Number(c.x2)]).filter((n) => Number.isFinite(n))
  const ys = profile.flatMap((c) => [Number(c.y1), Number(c.y2)]).filter((n) => Number.isFinite(n))
  if (xs.length < 4) throw new Error("albero senza semisezione a linee")
  const maxR = Math.max(...xs.map(Math.abs))
  const has16 = xs.some((x) => Math.abs(Math.abs(x) - 8) < 0.4)
  const has12 = xs.some((x) => Math.abs(Math.abs(x) - 6) < 0.4)
  if (!has16 || !has12) {
    throw new Error(`gola anulare: servono r=8 (Ø16) e r=6 (Ø12) nello schizzo, xs=${[...new Set(xs.map((x) => x.toFixed(1)))].join(",")}`)
  }
  const ySpan = Math.max(...ys) - Math.min(...ys)
  if (Math.abs(ySpan - 60) > 2 && Math.abs(maxR - 8) < 1) {
    throw new Error(`lunghezza albero attesa 60, got ySpan=${ySpan.toFixed(2)}`)
  }
  const grooveSegs = profile.filter((c) => {
    const x1 = Math.abs(Number(c.x1))
    const x2 = Math.abs(Number(c.x2))
    const dy = Math.abs(Number(c.y2) - Number(c.y1))
    const dx = Math.abs(Number(c.x2) - Number(c.x1))
    return Math.abs(x1 - 6) < 0.4 && Math.abs(x2 - 6) < 0.4 && dy > 2.2 && dy < 3.8 && dx < 0.4
  })
  if (grooveSegs.length < 1) {
    throw new Error("manca tratto gola Ø12 larghezza 3 (linea r=6, Δy=3)")
  }
  const g = grooveSegs[0]
  const gLo = Math.min(Number(g.y1), Number(g.y2))
  const gHi = Math.max(Number(g.y1), Number(g.y2))
  const yLo = Math.min(...ys)
  const yHi = Math.max(...ys)
  const fromLow = gLo - yLo
  const fromHigh = yHi - gHi
  const tenFromEnd = Math.abs(fromLow - 10) < 1.6 || Math.abs(fromHigh - 10) < 1.6
  if (!tenFromEnd) {
    throw new Error(`gola non a 10 mm da un estremo: fromLow=${fromLow.toFixed(2)} fromHigh=${fromHigh.toFixed(2)}`)
  }
  const plate = parts.find((d) => d !== shaft)
  if (!plate) throw new Error("manca piastra")
  const plateRects = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const plate50 = plateRects.some(
    (r) =>
      (Math.abs(Number(r.width) - 50) < 0.2 && Math.abs(Number(r.height) - 40) < 0.2) ||
      (Math.abs(Number(r.width) - 40) < 0.2 && Math.abs(Number(r.height) - 50) < 0.2),
  )
  if (!plate50) throw new Error("manca piastra 50×40")
  const plateCircles = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  if (!plateCircles.some((c) => Number(c.diameter) === 16)) throw new Error("manca foro piastra Ø16")

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
