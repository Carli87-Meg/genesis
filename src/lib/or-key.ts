import { promises as fs } from "node:fs"
import path from "node:path"

const FILE = path.join(process.cwd(), ".openrouter-local")

export type KeySource = "header" | "body" | "file" | "env" | "none"

export function sanitizeKey(raw: string | null | undefined): string {
  if (!raw) return ""
  return raw
    .replace(/^Bearer\s+/i, "")
    .replace(/[\r\n\t]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
}

export async function readLocalKey(): Promise<string> {
  try {
    return sanitizeKey(await fs.readFile(FILE, "utf8"))
  } catch {
    return ""
  }
}

export async function writeLocalKey(key: string): Promise<void> {
  const clean = sanitizeKey(key)
  if (!clean) {
    await clearLocalKey()
    return
  }
  await fs.writeFile(FILE, clean, { encoding: "utf8", flag: "w" })
}

export async function clearLocalKey(): Promise<void> {
  try {
    await fs.unlink(FILE)
  } catch {
    /* ignore */
  }
}

export async function resolveOpenRouterKey(input: {
  headerKey?: string | null
  authHeader?: string | null
  bodyKey?: string | null
  envKey?: string | null
  allowFile?: boolean
}): Promise<{ key: string; keySource: KeySource }> {
  const headerKey = sanitizeKey(input.headerKey) || sanitizeKey(input.authHeader)
  if (headerKey) return { key: headerKey, keySource: "header" }
  const bodyKey = sanitizeKey(input.bodyKey)
  if (bodyKey) return { key: bodyKey, keySource: "body" }
  if (input.allowFile) {
    const fileKey = await readLocalKey()
    if (fileKey) return { key: fileKey, keySource: "file" }
  }
  const envKey = sanitizeKey(input.envKey)
  if (envKey) return { key: envKey, keySource: "env" }
  return { key: "", keySource: "none" }
}

export function redactSecrets(text: string): string {
  return text
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-<redacted>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
}

export async function verifyOpenRouterKey(
  key: string,
): Promise<{ valid: boolean; status: number; detail: string }> {
  const clean = sanitizeKey(key)
  if (clean.length <= 8) return { valid: false, status: 0, detail: "chiave assente" }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${clean}` },
    })
    const detail = redactSecrets(await res.text()).slice(0, 220)
    return { valid: res.ok, status: res.status, detail }
  } catch (err) {
    return {
      valid: false,
      status: 0,
      detail: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 220),
    }
  }
}
