import { DEFAULT_BRIDGE_URL, type BridgeResponse } from "@/lib/payload"

export async function GET() {
  const url = process.env.SOLIDWORKS_BRIDGE_URL || DEFAULT_BRIDGE_URL
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/status`, {
      cache: "no-store",
    })
    const data = (await res.json()) as BridgeResponse
    return Response.json({ ...data, bridgeUrl: url }, { status: res.status })
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        bridgeUrl: url,
      } satisfies BridgeResponse & { bridgeUrl: string },
      { status: 503 },
    )
  }
}

export async function POST(req: Request) {
  const body = await req.json()
  const override =
    typeof body.bridgeUrl === "string" && body.bridgeUrl.startsWith("http")
      ? body.bridgeUrl
      : null
  const url = (override || process.env.SOLIDWORKS_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(
    /\/$/,
    "",
  )

  const payload = body.payload ?? body
  if (body.action === "cleanup" || payload?.action === "cleanup") {
    try {
      const res = await fetch(`${url}/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep: body.keep ?? payload?.keep ?? null }),
      })
      const data = (await res.json()) as BridgeResponse
      return Response.json({ ...data, bridgeUrl: url }, { status: res.status })
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: `Bridge irraggiungibile (${url}): ${err instanceof Error ? err.message : String(err)}`,
          bridgeUrl: url,
        },
        { status: 503 },
      )
    }
  }

  try {
    const res = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const data = (await res.json()) as BridgeResponse
    return Response.json({ ...data, bridgeUrl: url }, { status: res.status })
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: `Bridge irraggiungibile (${url}): ${err instanceof Error ? err.message : String(err)}`,
        bridgeUrl: url,
      },
      { status: 503 },
    )
  }
}
