const GUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
const allowed = new RegExp(`^/beta/(?:deviceAppManagement/mobileApps/${GUID}/assignments|devices\\(deviceId='${GUID}'\\)/transitiveMemberOf|groups/${GUID}|deviceManagement/assignmentFilters/${GUID})$`)

export class AssignmentReadError extends Error {
  constructor(readonly status: number | null) { super(status === null ? "Assignment information could not be read completely. Retry when Microsoft is reachable." : `Microsoft refused the assignment check (HTTP ${status}). Check the tenant's Microsoft session and read permissions.`) }
}

/** Read-only, bounded metadata requests. Continuations cannot redirect credentials or change resources. */
export function assignmentReader(token: string, fetchImpl: typeof fetch = fetch) {
  const deadline = AbortSignal.timeout(45_000)
  async function get(path: string): Promise<Record<string, unknown>> {
    const url = new URL(path, "https://graph.microsoft.com")
    if (url.origin !== "https://graph.microsoft.com" || !allowed.test(url.pathname) || url.username || url.password || url.hash) throw new AssignmentReadError(null)
    let response: Response
    try { response = await fetchImpl(url.href, { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" }, signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]) }) }
    catch { throw new AssignmentReadError(null) }
    if (response.status !== 200) { await response.body?.cancel(); throw new AssignmentReadError(response.status) }
    const reader = response.body?.getReader()
    if (!reader) throw new AssignmentReadError(null)
    const chunks: Uint8Array[] = []; let bytes = 0
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 2 * 1024 ** 2) { await reader.cancel(); throw new AssignmentReadError(null) }
        chunks.push(next.value)
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AssignmentReadError(null)
      return body as Record<string, unknown>
    } catch { throw new AssignmentReadError(null) }
    finally { reader.releaseLock() }
  }
  async function list(path: string, limit: number): Promise<Record<string, unknown>[]> {
    const resource = new URL(path, "https://graph.microsoft.com").pathname, seen = new Set<string>(), rows: Record<string, unknown>[] = []
    let next = new URL(path, "https://graph.microsoft.com").href
    while (next) {
      if (seen.has(next) || seen.size >= 100 || new URL(next).pathname !== resource) throw new AssignmentReadError(null)
      seen.add(next)
      const body = await get(next)
      if (!Array.isArray(body.value) || body.value.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new AssignmentReadError(null)
      rows.push(...body.value as Record<string, unknown>[])
      if (rows.length > limit) throw new AssignmentReadError(null)
      if (body["@odata.nextLink"] !== undefined && typeof body["@odata.nextLink"] !== "string") throw new AssignmentReadError(null)
      next = body["@odata.nextLink"] as string | undefined ?? ""
    }
    return rows
  }
  return { get, list }
}
