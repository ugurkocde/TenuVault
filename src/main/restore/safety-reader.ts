import { graphContinuation } from "../../shared/graph-continuation"
import { type Item } from "../../shared/intune/registry"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"

/** No sign-in or write capability. Every collection must finish under the backup continuation rule. */
export function safetyReader(token: string, fetchImpl: typeof fetch = fetch, version = "v1.0", headers: Readonly<Record<string, string>> = {}) {
  const root = `https://graph.microsoft.com/${version}/`
  const read = async (path: string, allowMissing: boolean): Promise<Item | null> => {
    const url = path.startsWith(root) ? path : root + path
    if (!url.startsWith(root) || new URL(url).hash) throw new RestoreSafetyError("Invalid safety read path.")
    const response = await fetchImpl(url, { method: "GET", headers: { "Accept-Language": "en-US", ...headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) })
    if (allowMissing && response.status === 404) return null
    if (response.status !== 200) throw new RestoreSafetyError(`A required safety read did not complete (${response.status}). Nothing was written.`)
    const body = await response.json() as Item
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RestoreSafetyError("Invalid safety read response.")
    return body
  }
  const get = async (path: string) => (await read(path, false))!
  const page = async (path: string, continuation?: string, seen = new Set<string>()) => {
    const start = path.startsWith(root) ? path : root + path
    const result = await get(graphContinuation(start, continuation ?? start, seen, new URL(start).searchParams.get("$filter") ?? undefined))
    if (!Array.isArray(result.value) || result.value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new RestoreSafetyError("Invalid safety collection.")
    const next = result["@odata.nextLink"]
    if (next !== undefined && typeof next !== "string") throw new RestoreSafetyError("Invalid safety continuation.")
    if (typeof next === "string") {
      const pending = graphContinuation(start, next, new Set<string>(), new URL(start).searchParams.get("$filter") ?? undefined)
      if (seen.has(new URL(pending).href) || seen.has(new URL(next).href)) throw new RestoreSafetyError("A required safety collection repeated a page.")
    }
    return { rows: result.value as Item[], next }
  }
  return { get, getOptional: (path: string) => read(path, true), page, list: async (path: string) => {
    let next: string | undefined
    const seen = new Set<string>()
    const entries: Item[] = []
    do {
      if (seen.size >= 10_000) throw new RestoreSafetyError("A required safety collection did not finish.")
      const result = await page(path, next, seen)
      entries.push(...result.rows)
      next = result.next
    } while (next)
    return entries
  } }
}
