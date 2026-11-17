const BASE = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps"
export type RestoreGraph = (method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>

/** Main-only, target-token-bound Graph transport. Error bodies may contain secrets and are never surfaced. */
export function restoreGraph(token: () => Promise<string>, fetchImpl: typeof fetch, signal: AbortSignal): RestoreGraph {
  return async (method, path, body) => {
    const url = new URL(path, BASE)
    if (url.origin !== "https://graph.microsoft.com" || !(url.pathname === "/beta/deviceAppManagement/mobileApps" || url.pathname.startsWith("/beta/deviceAppManagement/mobileApps/")) || url.username || url.password || url.hash) throw new Error("Invalid restore metadata request.")
    // Intune's void actions can return 200 with an empty body as well as 204.
    // Their result is verified by subsequent file/app reads in the restore engine.
    const voidResponse = method === "PATCH" || (method === "POST" && /\/contentVersions\/\d+\/files\/[a-f0-9-]{36}\/(?:renewUpload|commit)$/.test(url.pathname))
    signal.throwIfAborted()
    let response: Response
    try {
      response = await fetchImpl(url.href, { method, redirect: "error", credentials: "omit", headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) })
    } catch { signal.throwIfAborted(); throw new Error("The destination request was interrupted. Retry to reconcile the existing restore; a second app will not be created automatically.") }
    if (![200, 201, 204].includes(response.status)) { await response.body?.cancel(); throw new Error(`The destination tenant refused the restore request (HTTP ${response.status}). Check Microsoft sign-in, Intune permissions and service availability.`) }
    if (response.status === 204) { await response.body?.cancel(); if (voidResponse) return {}; throw new Error("The destination returned no metadata.") }
    const reader = response.body?.getReader()
    if (!reader) { if (voidResponse) return {}; throw new Error("The destination returned no metadata.") }
    const chunks: Uint8Array[] = []; let size = 0
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break
        size += part.value.byteLength
        if (size > 16 * 1024 ** 2) { await reader.cancel(); throw new Error("The destination metadata response is too large.") }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    if (!size) { if (voidResponse) return {}; throw new Error("The destination returned no metadata.") }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")) }
    catch { throw new Error("The destination returned invalid metadata. Retry to reconcile the existing restore.") }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid destination metadata.")
    return value as Record<string, unknown>
  }
}
/** SAS comes only from authenticated Graph. Never send Microsoft tokens to storage. */
export async function putRestoreBlock(sas: string, query: Record<string, string>, body: Buffer | string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<void> {
  const url = new URL(sas)
  if (url.protocol !== "https:" || !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname) || url.port || url.username || url.password || url.hash || !url.searchParams.has("sig")) throw new Error("Intune returned an unsupported upload location.")
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  let response: Response
  try { response = await fetchImpl(url.href, { method: "PUT", redirect: "error", credentials: "omit", headers: { "content-type": typeof body === "string" ? "application/xml" : "application/octet-stream", "x-ms-version": "2021-12-02" }, body: typeof body === "string" ? body : new Uint8Array(body), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) }) }
  catch { signal.throwIfAborted(); throw new Error("The installer upload was interrupted. Retry this restore to resume the same destination app.") }
  await response.body?.cancel()
  if (response.status !== 201) throw new Error(`The installer upload failed (HTTP ${response.status}). Retry this restore.`)
}
