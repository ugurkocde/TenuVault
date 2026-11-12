/** Bounded, fixed-origin beta metadata reads; no redirects may receive the token. */
export async function appMetadataGet(url: string, token: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const target = new URL(url)
  if (target.origin !== "https://graph.microsoft.com" || !target.pathname.startsWith("/beta/deviceAppManagement/mobileApps") || target.username || target.password || target.hash) throw new Error("Invalid Intune metadata request.")
  const response = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" }, redirect: "error", signal: AbortSignal.timeout(15000) })
  if (response.status !== 200) throw new Error(`Intune metadata could not be read (HTTP ${response.status}). Check the tenant's Microsoft session and Intune permissions.`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Intune returned an empty metadata response.")
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break
      size += part.value.byteLength
      if (size > 16 * 1024 ** 2) { await reader.cancel(); throw new Error("Intune metadata exceeded the response limit.") }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Intune returned invalid metadata.")
  return body as Record<string, unknown>
}

export const appText = (value: unknown, limit = 16384): string => typeof value === "string" ? value.slice(0, limit) : ""
export function appIcon(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const icon = value as Record<string, unknown>
  if (!["image/png", "image/jpeg", "image/webp"].includes(String(icon.type)) || typeof icon.value !== "string" || icon.value.length > 180000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(icon.value)) return null
  const bytes = Buffer.from(icon.value, "base64")
  const valid = icon.type === "image/png" ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : icon.type === "image/jpeg" ? bytes.subarray(0,3).equals(Buffer.from([255,216,255]))
      : bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP"
  return valid ? `data:${icon.type};base64,${bytes.toString("base64")}` : null
}
export const appDate = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null
