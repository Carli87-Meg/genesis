/**
 * UI: chiave finta → errore, albero vuoto. Senza chiave → demo.
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

try {
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.evaluate(() => {
    localStorage.setItem(
      "solidworks-ia-settings",
      JSON.stringify({
        openRouterKey: "sk-or-v1-TESTKEY_deadbeefdeadbeefdeadbeefdeadbeef",
        model: "openai/gpt-4o-mini",
        bridgeUrl: "http://127.0.0.1:47821",
      }),
    )
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /Impostazioni/i }).waitFor({ timeout: 15000 })

  const badgeFake = (await page.locator("header").innerText()).replace(/\s+/g, " ")
  await page.getByRole("button", { name: /Piastra 80/i }).first().click()
  await page.getByText(/rifiutato la chiave|Errore interpretazione/i).first().waitFor({
    timeout: 30000,
  })
  const chatFake = await page.locator("section").first().innerText()
  const treeFake = await page.locator("section").nth(2).innerText()
  const sendEnabledFake = await page.getByRole("button", { name: /Invia a SolidWorks/i }).isEnabled()
  fs.mkdirSync("sw-out", { recursive: true })
  await page.screenshot({ path: "sw-out/verify-or-ui-401.png", fullPage: true })

  await page.evaluate(() => localStorage.removeItem("solidworks-ia-settings"))
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /Impostazioni/i }).waitFor({ timeout: 15000 })
  await page.getByRole("button", { name: /Piastra 80/i }).first().click()
  await page.getByText(/Fonte: demo locale|Estrusione/i).first().waitFor({ timeout: 20000 })
  const treeDemo = await page.locator("section").nth(2).innerText()
  const sendEnabledDemo = await page.getByRole("button", { name: /Invia a SolidWorks/i }).isEnabled()
  await page.screenshot({ path: "sw-out/verify-or-ui-demo.png", fullPage: true })

  const result = {
    badgeFake: badgeFake.slice(0, 180),
    chatHas401: /rifiutato la chiave|401/i.test(chatFake),
    sendEnabledFake,
    treeFakeEmpty: /Nessuna operazione/i.test(treeFake),
    sendEnabledDemo,
    treeDemoHasExtrude: /estrusion|extrude|schizzo/i.test(treeDemo),
  }
  result.ok =
    /OpenRouter/i.test(badgeFake) &&
    result.chatHas401 &&
    result.sendEnabledFake === false &&
    result.treeFakeEmpty &&
    result.sendEnabledDemo &&
    result.treeDemoHasExtrude
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
} catch (err) {
  console.error("VERIFY_OR_UI_FAIL", err)
  await page.screenshot({ path: "sw-out/verify-or-ui-fail.png", fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
