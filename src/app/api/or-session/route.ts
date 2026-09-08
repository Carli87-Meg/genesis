import { clearLocalKey, readLocalKey, sanitizeKey, verifyOpenRouterKey, writeLocalKey } from "@/lib/or-key"

export async function POST(req: Request) {
  let body: { openRouterKey?: string; apiKey?: string; token?: string; verify?: boolean } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    return Response.json({ error: "JSON non valido" }, { status: 400 })
  }
  const key = sanitizeKey(body.openRouterKey || body.apiKey || body.token)
  if (key.length <= 8) {
    await clearLocalKey()
    return Response.json({ ok: true, stored: false, valid: false })
  }
  await writeLocalKey(key)
  const check = body.verify === false ? { valid: true, status: 0, detail: "" } : await verifyOpenRouterKey(key)
  return Response.json({
    ok: true,
    stored: true,
    keyLen: key.length,
    valid: check.valid,
    status: check.status,
    detail: check.detail,
  })
}

export async function DELETE() {
  await clearLocalKey()
  return Response.json({ ok: true, stored: false, valid: false })
}

export async function GET() {
  const key = await readLocalKey()
  return Response.json({ stored: key.length > 8, keyLen: key.length })
}
