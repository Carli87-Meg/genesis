/**
 * Guida l'UI Next.js (http://127.0.0.1:4317) per la demo staffa a L.
 * Non apre Impostazioni (niente chiave in chiaro).
 */
import { chromium } from "playwright"

const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"
const PROMPT =
  process.env.DEMO_PROMPT ||
  "Staffa a L 80×50×8 mm, parete 40 mm, boss Ø16, 4 fori Ø6.5, boccola e tavola A3 CM"

const chromePath =
  process.env.PLAYWRIGHT_CHROME ||
  "C:\\Users\\Carli\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"

const browser = await chromium.launch({
  headless: false,
  executablePath: chromePath,
  args: ["--start-maximized", "--window-position=0,0", "--window-size=1280,1080", "--disable-gpu-sandbox"],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
await page.setViewportSize({ width: 1280, height: 1000 })

try {
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.waitForTimeout(1500)

  const keyOn = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("solidworks-ia-settings")
      if (!raw) return false
      const s = JSON.parse(raw)
      return typeof s.openRouterKey === "string" && s.openRouterKey.length > 8
    } catch {
      return false
    }
  })
  console.log(JSON.stringify({ keyOn, prompt: PROMPT, url: APP }))

  const chip = page.getByRole("button", { name: /Staffa a L/i }).first()
  if (await chip.count()) {
    await chip.click()
  } else {
    await page.getByPlaceholder(/Staffa a L|Piastra/i).fill(PROMPT)
    await page.getByRole("button", { name: /^Proponi$/ }).click()
  }

  await page.getByText(/Proposta:|kit 4 documenti|Esegui in SolidWorks|Staffa a L 80/i).first().waitFor({
    timeout: 180000,
  })
  await page.waitForTimeout(2500)

  const send = page.getByRole("button", { name: /Esegui in SolidWorks/i }).first()
  await send.click()

  const dialog = page.getByRole("dialog")
  await dialog.waitFor({ timeout: 15000 })

  await page.getByText(/Documento 4\/4|SetupSheet5|TavolaStaffa|Ricostruzione completata/i).first().waitFor({
    timeout: 360000,
  })
  await page.waitForTimeout(6000)

  const fail = await page.locator(".text-destructive, pre").count()
  console.log(JSON.stringify({ done: true, failHints: fail }))
  await page.waitForTimeout(8000)
} catch (err) {
  console.error("DEMO_UI_FAIL", err)
  process.exitCode = 1
} finally {
  await page.screenshot({ path: "sw-out/demo-ui-last.png", fullPage: true }).catch(() => {})
  await browser.close()
}
