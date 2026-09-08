/**
 * Con chiave (anche finta) /api/interpret non deve restituire geometria demo.
 * Senza chiave la demo resta attiva.
 */
const APP = process.env.DEMO_URL || "http://127.0.0.1:4317"

async function post(prompt, key) {
  const t0 = Date.now()
  const res = await fetch(`${APP}/api/interpret`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "x-openrouter-key": key, Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      prompt,
      followUp: false,
      openRouterKey: key || undefined,
      model: "openai/gpt-4o-mini",
    }),
  })
  const data = await res.json()
  return {
    status: res.status,
    ms: Date.now() - t0,
    source: data.source,
    hasKey: data.hasKey,
    keySource: data.keySource,
    opCount: Array.isArray(data.operations) ? data.operations.length : 0,
    types: Array.isArray(data.operations) ? data.operations.map((o) => o.type) : [],
    summary: data.summary,
    error: data.error
      ? String(data.error).replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-<redacted>").slice(0, 220)
      : null,
    warning: data.warning
      ? String(data.warning).replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-<redacted>").slice(0, 180)
      : null,
  }
}

const prompt = "Piastra 80 x 50 x 8 mm con 4 fori diametro 6.5 mm agli angoli"
const demo = await post(prompt, "")
const fake = await post(prompt, "sk-or-v1-TESTKEY_deadbeefdeadbeefdeadbeefdeadbeef")

const demoOk = demo.status === 200 && demo.source === "demo" && demo.hasKey === false && demo.opCount > 0
const fakeOk =
  fake.status >= 400 &&
  fake.source === "openrouter" &&
  fake.hasKey === true &&
  fake.opCount === 0 &&
  /rifiutato|401|chiave/i.test(String(fake.error || ""))

console.log(JSON.stringify({ demo, fake, demoOk, fakeOk }, null, 2))
if (!demoOk || !fakeOk) process.exitCode = 1
