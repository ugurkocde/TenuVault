import { createPublicKey, randomBytes, verify } from "node:crypto"

const POLICY_URL = "https://www.tenuvault.com/api/app-backup/capture-policy"
const PURPOSE = "tenuvault-app-backup-capture-v1"
const LIMIT = 16 * 1024
const UNAVAILABLE = "Installer capture is temporarily unavailable. Try again later. Existing backups are still available to export."
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-nightly\.(0|[1-9]\d{0,13}))?$/

function versionParts(value: unknown): number[] {
  if (typeof value !== "string") throw new Error(UNAVAILABLE)
  const match = VERSION.exec(value)
  if (!match) throw new Error(UNAVAILABLE)
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : 0, Number(match[4] ?? 0)]
}

/** This token is separate from entitlements. Only its public verification keys are shared. */
export function verifyCapturePolicy(token: unknown, keys: readonly string[], nonce: string, appVersion: string, now: number): void {
  if (typeof token !== "string" || token.length > LIMIT || !/^[0-9a-f]{64}$/.test(nonce)) throw new Error(UNAVAILABLE)
  const parts = token.split(".")
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error(UNAVAILABLE)
  const [body, signature] = parts as [string, string]
  const bytes = Buffer.from(signature, "base64url")
  if (bytes.length !== 64 || bytes.toString("base64url") !== signature || !keys.some(pem => {
    try {
      const key = createPublicKey(pem)
      return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(`${PURPOSE}.${body}`), key, bytes)
    } catch { return false }
  })) throw new Error(UNAVAILABLE)
  let policy: Record<string, unknown>
  try { policy = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) } catch { throw new Error(UNAVAILABLE) }
  if (!policy || policy.v !== 1 || policy.purpose !== PURPOSE || policy.nonce !== nonce || policy.platform !== "win32" ||
    typeof policy.enabled !== "boolean" || !Number.isSafeInteger(policy.iat) || !Number.isSafeInteger(policy.exp) ||
    !Number.isSafeInteger(now)) throw new Error(UNAVAILABLE)
  const issued = policy.iat as number, expires = policy.exp as number
  if (issued > now + 30 || issued < now - 300 || expires <= now || expires <= issued || expires - issued > 300) throw new Error(UNAVAILABLE)
  const current = versionParts(appVersion), minimum = versionParts(policy.minimumVersion)
  if (!policy.enabled) throw new Error("Installer capture has been paused. Existing backups are still available to export.")
  for (let index = 0; index < current.length; index++) {
    if (current[index]! > minimum[index]!) return
    if (current[index]! < minimum[index]!) throw new Error("Update TenuVault before starting a new app backup. Existing backups are still available to export.")
  }
}

export async function requireCaptureEnabled(options: {
  keys: readonly string[]; appVersion: string; signal: AbortSignal; fetch?: typeof fetch
}): Promise<void> {
  options.signal.throwIfAborted()
  const nonce = randomBytes(32).toString("hex")
  let token: unknown
  try {
    // Every job needs a fresh response. No entitlement, Microsoft token, tenant ID or
    // persisted enable cache is sent. The nonce prevents replay of an earlier response.
    const response = await (options.fetch ?? fetch)(`${POLICY_URL}?nonce=${nonce}`, {
      method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
    })
    if (!response.ok || !response.body) throw new Error(UNAVAILABLE)
    const reader = response.body.getReader(), chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > LIMIT) throw new Error(UNAVAILABLE)
        chunks.push(Buffer.from(value))
      }
      token = JSON.parse(Buffer.concat(chunks).toString("utf8")).token
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  } catch {
    options.signal.throwIfAborted()
    throw new Error(UNAVAILABLE)
  }
  options.signal.throwIfAborted()
  verifyCapturePolicy(token, options.keys, nonce, options.appVersion, Math.floor(Date.now() / 1000))
}
