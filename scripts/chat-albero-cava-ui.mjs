/**
 * Percorso chat UI: Proponi + Esegui (non POST diretto al bridge).
 * Prompt italiano: albero Ø20 con cava linguetta + piastra, non due pezzi mate-ati.
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
const PROMPT =
  "Albero Ø20 lunghezza 50, cava linguetta 6 × 3.5 lunghezza 40 aperta su un estremo. Piastra 60 × 50 × 8 con foro Ø20. Albero nel foro, faccia coincidente all’estremo senza cava. Quote vere su ogni schizzo. Tavola A3 Cartiglio_CM."
const OUT = path.join("sw-out", "chat-albero-cava")

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
    /StaffaFissaggio|BoccolaGuida|AssiemeStaffa|Piastra90|PiastraBase$|PiastraSupporto|BasePiastra100|Piastra100x60|Cubo20|Piastra80x50|Cilindro20x30|BoccolaFlangia16|PiastraForo16|AlberoSpallamento10|PiastraForo10$|PiastraForo10x60|PiastraBaseU|MontanteU|AssiemeTelaioU|PiastraTasca80|Coperchio80|AssiemePiastraCoperchio|Distanziale16x20|AssiemeSandwich|BarraT60|Piastra70Foro8|AssiemeBarraT|Flangia80Pcd50|Albero12x50|AssiemeFlangiaAlbero|DadoEsagono17|Piastra50Foro10|AssiemeDadoPiastra|AlberoGola16|Piastra50Foro16|AssiemeAlberoGola|Assemie|demo/i
  if (names.some((n) => banned.test(n))) throw new Error(`nomi kit/demo/typo: ${names.join(",")}`)
  if (names.some((n) => /Assemie/i.test(n))) throw new Error(`typo Assemie: ${names.join(",")}`)
  if (!names.some((n) => /^Assieme/i.test(n))) throw new Error(`manca Assieme*: ${names.join(",")}`)
  if (partDocs.length !== 2) {
    throw new Error(`albero+piastra = 2 PRT (cava sul PRT, non linguetta mate-ata), parti=${partDocs.join(",")}`)
  }
  if (!mateTypes.includes("coincident") || !mateTypes.includes("concentric")) {
    throw new Error(`servono coincident+concentric, got ${mateTypes.join(",")}`)
  }

  const parts = job.filter((d) => d.document?.type === "part")
  const shaft =
    parts.find((d) =>
      (d.operations || []).some(
        (op) =>
          (op.type === "extrude" && Number(op.depth) === 50) ||
          (op.type === "sketch" &&
            (op.contours || []).some((c) => (c.kind === "circle" || c.type === "circle") && Number(c.diameter) === 20)),
      ),
    ) || parts.find((d) => /albero|shaft|cava/i.test(d.document?.name || ""))
  if (!shaft) throw new Error("manca parte albero Ø20")
  const cuts = (shaft.operations || []).filter((op) => op.type === "cut")
  if (cuts.length < 1) throw new Error("manca taglio prismatico della cava sull’albero")
  const blind40 = cuts.some((op) => op.throughAll !== true && Math.abs(Number(op.depth) - 40) < 0.6)
  if (!blind40) {
    throw new Error(
      `cava deve essere cut cieco 40 mm (aperta su un estremo), got ${cuts
        .map((c) => `throughAll=${c.throughAll} depth=${c.depth}`)
        .join(",")}`,
    )
  }
  const shaftRects = (shaft.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const keyRect = shaftRects.find((r) => {
    const w = Number(r.width)
    const h = Number(r.height)
    return Math.abs(w - 6) < 0.4 || Math.abs(h - 6) < 0.4
  })
  if (!keyRect) throw new Error("manca rettangolo cava larghezza 6 sullo schizzo albero")
  const plate = parts.find((d) => d !== shaft)
  if (!plate) throw new Error("manca piastra")
  const plateRects = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "rectangle" || c.type === "rectangle"))
  const plate60 = plateRects.some(
    (r) =>
      (Math.abs(Number(r.width) - 60) < 0.2 && Math.abs(Number(r.height) - 50) < 0.2) ||
      (Math.abs(Number(r.width) - 50) < 0.2 && Math.abs(Number(r.height) - 60) < 0.2),
  )
  if (!plate60) throw new Error("manca piastra 60×50")
  const plateCircles = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .flatMap((op) => (op.contours || []).filter((c) => c.kind === "circle" || c.type === "circle"))
  if (!plateCircles.some((c) => Number(c.diameter) === 20)) throw new Error("manca foro piastra Ø20")
  const plateCuts = (plate.operations || []).filter((op) => op.type === "cut")
  const plateHasKeyway = (plate.operations || [])
    .filter((op) => op.type === "sketch")
    .some((op) =>
      (op.contours || []).some(
        (c) =>
          (c.kind === "rectangle" || c.type === "rectangle") &&
          (Math.abs(Number(c.width) - 6) < 0.4 || Math.abs(Number(c.height) - 6) < 0.4) &&
          plateCuts.length > 1,
      ),
    )
  if (plateHasKeyway) throw new Error("cava copiata sulla piastra: deve stare solo sull’albero")

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
