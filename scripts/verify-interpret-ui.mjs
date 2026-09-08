/**
 * Verifica UI: interpret (demo o OpenRouter) + Esegui in SolidWorks.
 * Non stampa la chiave.
 */
import { chromium } from "playwright"
import fs from "node:fs"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
})
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

const interpretCalls = []
page.on("response", async (res) => {
  if (!res.url().includes("/api/interpret") || res.request().method() !== "POST") return
  try {
    const data = await res.json()
    interpretCalls.push({
      status: res.status(),
      source: data.source,
      hasKey: data.hasKey,
      keySource: data.keySource,
      model: data.model,
      warning: data.warning
        ? String(data.warning).replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-<redacted>").slice(0, 220)
        : null,
      opCount: Array.isArray(data.operations) ? data.operations.length : 0,
      types: Array.isArray(data.operations) ? data.operations.map((o) => o.type) : [],
      summary: data.summary,
    })
  } catch {
    interpretCalls.push({ status: res.status(), error: "json" })
  }
})

try {
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.waitForTimeout(1200)

  const stored = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("solidworks-ia-settings")
      if (!raw) return { keyOn: false, model: null }
      const s = JSON.parse(raw)
      const k = typeof s.openRouterKey === "string" ? s.openRouterKey.trim() : ""
      return { keyOn: k.length > 8, model: s.model || null, keyPrefix: k ? k.slice(0, 8) : "" }
    } catch {
      return { keyOn: false, model: null }
    }
  })

  const badge = (await page.locator("header").innerText()).replace(/\s+/g, " ")

  const chip = page.getByRole("button", { name: /Crea pezzo|Staffa a L/i }).first()
  await chip.click()
  await page.getByText(/Proposta:|Estrusione|kit /i).first().waitFor({ timeout: 60000 })
  await page.waitForTimeout(800)

  const treeText = await page.locator("aside").innerText().catch(() => "")
  const send = page.getByRole("button", { name: /Esegui in SolidWorks/i }).first()
  const sendEnabled = await send.isEnabled()
  if (sendEnabled) {
    await send.click()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor({ timeout: 15000 })
    await dialog
      .getByText(/ForceRebuild3|FeatureExtrusion3|InsertSketch|SketchManager|Invio fallito|Bridge irraggiungibile/i)
      .first()
      .waitFor({ timeout: 180000 })
    await page.waitForTimeout(1500)
  }

  fs.mkdirSync("sw-out", { recursive: true })
  await page.screenshot({ path: "sw-out/verify-interpret.png", fullPage: true })

  const dialogText = sendEnabled
    ? (await page.getByRole("dialog").innerText().catch(() => "")).slice(0, 1200)
    : ""

  console.log(
    JSON.stringify(
      {
        stored,
        badge: badge.slice(0, 240),
        interpretCalls,
        sendEnabled,
        treeHasExtrude: /estrusion|extrude|schizzo/i.test(treeText),
        dialogOk: /ForceRebuild3|FeatureExtrusion3|InsertSketch/i.test(dialogText) && !/Invio fallito/i.test(dialogText),
        dialogFail: /FAIL|Invio fallito/i.test(dialogText),
        dialogSlice: dialogText.replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-<redacted>").slice(0, 500),
      },
      null,
      2,
    ),
  )
} catch (err) {
  console.error("VERIFY_FAIL", err)
  await page.screenshot({ path: "sw-out/verify-interpret-fail.png", fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
