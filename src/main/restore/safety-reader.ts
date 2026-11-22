import { graphContinuation } from "../../shared/graph-continuation"
import { type Item } from "../../shared/intune/registry"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import type { GraphReader } from "../../shared/intune/read"

/** No sign-in or write capability. Every collection must finish under the backup continuation rule. */
export function safetyReader(token: string, fetchImpl: typeof fetch = fetch, version = "v1.0", headers: Readonly<Record<string, string>> = {}): GraphReader {
  const root = `https://graph.microsoft.com/${version}/`
  const get = async (path: string): Promise<Item> => {
    const url = path.startsWith(root) ? path : root + path
    if (!url.startsWith(root) || new URL(url).hash) throw new RestoreSafetyError("Invalid safety read path.")
    const response = await fetchImpl(url, { method: "GET", headers: { "Accept-Language": "en-US", ...headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) })
    if (response.status !== 200) throw new RestoreSafetyError(`A required safety read did not complete (${response.status}). Nothing was written.`)
    const body = await response.json() as Item
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RestoreSafetyError("Invalid safety read response.")
    return body
  }
  return { get, list: async path => {
    const start = path.startsWith(root) ? path : root + path
    let next: string | undefined = start
    const seen = new Set<string>()
    const entries: Item[] = []
    while (next) {
      if (seen.size >= 10_000) throw new RestoreSafetyError("A required safety collection did not finish.")
      const page = await get(graphContinuation(start, next, seen, new URL(start).searchParams.get("$filter") ?? undefined))
      if (!Array.isArray(page.value) || page.value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new RestoreSafetyError("Invalid safety collection.")
      entries.push(...page.value as Item[])
      if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new RestoreSafetyError("Invalid safety continuation.")
      next = page["@odata.nextLink"] as string | undefined
    }
    return entries
  } }
}
