/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: base 80×60×8 + colonna Ø20×40 + piastra 50×40×6, tre PRT distinti.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Base 80 × 60 × 8 con foro Ø8 al centro. Colonna Ø20 altezza 40 con foro passante Ø8. Piastra superiore 50 × 40 × 6 con foro Ø8. Colonna in piedi sulla base, piastra sopra la colonna, fori allineati. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-assieme-tre-pezzi")

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
  const extrudes = []
  for (const d of job) {
    if (d.document?.type === "part") partDocs.push(d.document.name)
    for (const op of d.operations || []) {
      types.push(op.type)
      if (op.type === "mate") mateTypes.push(String(op.mateType || op.subtype || op.kind || "").toLowerCase())
      if (op.type === "component" && op.path) compPaths.push(String(op.path))
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
    "comps",
    compPaths.join(","),
  )
  if (interpretBody.source === "demo") throw new Error("source=demo, serve OpenRouter")
  if (!/Colonna/i.test(PROMPT) || !/Cartiglio_CM/i.test(PROMPT)) {
    throw new Error("prompt IT non rispettato")
  }
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa\b|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|Piastra50Foro10|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8\b|Piastra70x50Foro8|AssiemeBarraT|Flangia80Pcd50|Albero12x50|DadoEsagono17|AssiemeDadoPiastra|AlberoGola16|Piastra50Foro16|AlberoCava20|Piastra60Foro20|StaffaZ|Piastra60Smusso|Distanziale16x12|PiastraNervatura80|Perno8x30|Piastra50Raccordo|Boccola14x10|Piastra50Svasata|ViteSvasata6x16|AssiemePiastraSvasata|Piastra70Sede12|ViteCilindrica6x16|AssiemePiastraSede|TavolaPiastraSede|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 3) {
    throw new Error(`tre PRT attesi (base+colonna+piastra), parti=${partDocs.join(",")}`)
  }
  const uniqueComps = [...new Set(compPaths.map((p) => p.replace(/\\/g, "/").toLowerCase()))]
  if (compPaths.length !== 3 || uniqueComps.length !== 3) {
    throw new Error(`3 insert / 3 path attesi, got ${compPaths.length}/${uniqueComps.length} ${compPaths.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric")) {
    throw new Error(`servono coincident+concentric, got ${mateTypes.join(",")}`)
  }
  if (!mateTypes.includes("perpendicular")) {
    throw new Error(`manca perpendicular colonna/base, got ${mateTypes.join(",")}`)
  }
  const coincCount = mateTypes.filter((m) => m === "coincident").length
  if (coincCount < 2) {
    throw new Error(`servono ≥2 coincident (entrambe le facce), got ${coincCount}`)
  }
  if (!extrudes.includes(8) || !extrudes.includes(40) || !extrudes.includes(6)) {
    throw new Error(`estrusione 8+40+6 attesa, got ${extrudes.join(",")}`)
  }

  const parts = job.filter((d) => d.document?.type === "part")
  const rectsOf = (d) =>
    (d.operations || [])
      .filter((op) => op.type === "sketch")
      .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const circlesOf = (d) =>
    (d.operations || [])
      .filter((op) => op.type === "sketch")
      .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  const hasRect = (d, a, b) =>
    rectsOf(d).some(
      (r) =>
        (Math.abs(Number(r.width) - a) < 0.2 && Math.abs(Number(r.height) - b) < 0.2) ||
        (Math.abs(Number(r.width) - b) < 0.2 && Math.abs(Number(r.height) - a) < 0.2),
    )
  const hasDia = (d, dia) => circlesOf(d).some((c) => Number(c.diameter) === dia)
  const extOf = (d, depth) =>
    (d.operations || []).some((op) => op.type === "extrude" && Math.abs(Number(op.depth) - depth) < 0.2)

  const base = parts.find((d) => hasRect(d, 80, 60) && extOf(d, 8))
  const top = parts.find((d) => d !== base && hasRect(d, 50, 40) && extOf(d, 6))
  const column = parts.find((d) => d !== base && d !== top)
  if (!base) throw new Error("manca base 80×60×8")
  if (!top) throw new Error("manca piastra superiore 50×40×6")
  if (!column) throw new Error("manca colonna")
  if (hasRect(column, 80, 60) || hasRect(column, 50, 40) || hasRect(column, 60, 40)) {
    throw new Error("la colonna è una piastra, serve Ø20 estruso 40")
  }
  if (!hasDia(column, 20)) throw new Error("colonna senza Ø20")
  if (!extOf(column, 40)) throw new Error("colonna senza estrusione 40")
  if ((column.operations || []).some((op) => op.type === "revolve")) {
    throw new Error("colonna deve essere estrusione+taglio, non rivoluzione")
  }
  for (const p of [base, column, top]) {
    if (!hasDia(p, 8)) throw new Error(`manca foro Ø8 su ${p.document?.name}`)
    const thru = (p.operations || []).some((op) => op.type === "cut" && op.throughAll === true)
    if (!thru) throw new Error(`manca throughAll Ø8 su ${p.document?.name}`)
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
