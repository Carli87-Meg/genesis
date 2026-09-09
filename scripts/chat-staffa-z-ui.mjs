/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt inglese: staffa a Z da uno schizzo, non tre piastre mate-ate.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Z-bracket: base 50 × 30 × 4, rise 20, top 40 × 30 × 4, Ø8 hole in the top center. Plate 70 × 50 × 6 with Ø8 hole. Bracket perpendicular to the plate, top face coincident, holes aligned. True dimensions on every sketch. A3 drawing Cartiglio_CM."
const OUT = path.join("sw-out", "chat-staffa-z")

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
  const sketches = []
  for (const d of job) {
    if (d.document?.type === "part") partDocs.push(d.document.name)
    for (const op of d.operations || []) {
      types.push(op.type)
      if (op.type === "mate") mateTypes.push(String(op.mateType || op.subtype || op.kind || "").toLowerCase())
      if (op.type === "extrude") extrudes.push(Number(op.depth))
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
  const typed = (await page.locator("textarea").inputValue().catch(() => "")) || PROMPT
  if (!/Z-bracket/i.test(typed) || !/Cartiglio_CM/i.test(PROMPT)) {
    throw new Error("prompt EN non rispettato (manca Z-bracket / Cartiglio_CM)")
  }
  const banned =
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa\b|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8\b|AssiemeBarraT|Flangia80Pcd50|Albero12x50|AssiemeFlangiaAlbero|DadoEsagono17|Piastra50Foro10|AssiemeDadoPiastra|AlberoGola16|Piastra50Foro16|AssiemeAlberoGola|AlberoCava20|Piastra60Foro20|AssiemeAlberoCava|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`Z da schizzo = 2 PRT (staffa+piastra), non tre piastre, parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric") || !mateTypes.includes("perpendicular")) {
    throw new Error(`servono coincident+concentric+perpendicular, got ${mateTypes.join(",")}`)
  }
  if (!extrudes.includes(30) || !extrudes.includes(6)) {
    throw new Error(`estrusioni attese 30 (Z) e 6 (piastra), got ${extrudes.join(",")}`)
  }
  const zPart =
    job.find(
      (d) =>
        d.document?.type === "part" &&
        (d.operations || []).some((op) => op.type === "extrude" && Number(op.depth) === 30),
    ) || job.find((d) => d.document?.type === "part" && /staffa|bracket|zed|\bZ\b/i.test(d.document?.name || ""))
  if (!zPart) throw new Error("manca parte staffa Z (estrusione 30)")
  const zSketches = (zPart.operations || []).filter((op) => op.type === "sketch")
  const zPoly = zSketches.find((s) => {
    const lines = (s.contours || []).filter((c) => (c.kind === "line" || c.type === "line") && !c.construction)
    return lines.length >= 8
  })
  if (!zPoly) throw new Error("manca schizzo Z (polilinea chiusa, un solo schizzo, non tre piastre)")
  const zPlane = String(zPoly.plane || "")
  if (/front/i.test(zPlane)) {
    throw new Error(`Z su Front estrude FAIL: piano=${zPlane}, serve Right`)
  }
  const zRects = zSketches.flatMap((s) =>
    (s.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"),
  )
  if (zRects.length >= 3) throw new Error("Z come tre rettangoli: serve una polilinea")
  const zCuts = (zPart.operations || []).filter((op) => op.type === "cut")
  if (zCuts.length < 1) throw new Error("manca foro Ø8 sul tetto della Z")
  const zHole = zSketches
    .flatMap((s) => (s.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
    .find((c) => Number(c.diameter) === 8)
  if (zHole && (Math.abs(Number(zHole.cx)) > 1 || Math.abs(Number(zHole.cy)) > 1)) {
    throw new Error(`foro Z non al centro tetto (0,0) midplane, got (${zHole.cx},${zHole.cy})`)
  }
  const d8 = sketches.some((s) =>
    (s.contours || []).some((c) => (c.kind === "circle" || c.type === "circle") && Number(c.diameter) === 8),
  )
  if (!d8) throw new Error("manca foro Ø8")
  const plate = job.find((d) => d.document?.type === "part" && d !== zPart)
  if (!plate) throw new Error("manca piastra")
  const plateRects = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const plate70 = plateRects.some(
    (r) =>
      (Math.abs(Number(r.width) - 70) < 0.2 && Math.abs(Number(r.height) - 50) < 0.2) ||
      (Math.abs(Number(r.width) - 50) < 0.2 && Math.abs(Number(r.height) - 70) < 0.2),
  )
  if (!plate70) throw new Error("manca piastra 70×50")

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
