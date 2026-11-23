import type { GraphCall } from "../../portal/lib/policies/graph-restore"
import { GROUP_COUNT_LIMIT, type GroupCounts } from "../../shared/group-access"
import { isGuid } from "../../shared/security"

const CACHE_MS = 5 * 60_000
const CONCURRENCY = 4
const TYPES = ["user", "device", "group"] as const

/** Shares the cache and request limit across all pickers using this service. */
export function createGroupCounter(now = Date.now) {
  const cache = new Map<string, { expires: number; counts: GroupCounts }>()
  const pending = new Map<string, Promise<GroupCounts | null>>()
  const waiting: Array<() => void> = []
  let active = 0

  async function count(graph: GraphCall, id: string, type: typeof TYPES[number]): Promise<number | null> {
    if (active < CONCURRENCY) active++
    else await new Promise<void>(resolve => waiting.push(resolve))
    try {
      const result = await graph("GET", `groups/${id}/members/microsoft.graph.${type}/$count`, undefined, { consistencyLevel: "eventual" })
      const text = result.rawBody?.trim() ?? ""
      if (result.status !== 200 || !/^\d+$/.test(text)) return null
      const value = Number(text)
      return Number.isSafeInteger(value) ? value : null
    } catch {
      return null
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }

  async function read(graph: GraphCall, tenant: string, id: string) {
    const key = `${tenant}:${id}`
    const cached = cache.get(key)
    if (cached && cached.expires > now()) return cached.counts
    const inflight = pending.get(key)
    if (inflight) return inflight
    const load = Promise.all(TYPES.map(type => count(graph, id, type))).then(([users, devices, groups]) => {
      if (users == null || devices == null || groups == null) return null
      const counts = { users, devices, groups }
      cache.set(key, { expires: now() + CACHE_MS, counts })
      return counts
    }).finally(() => pending.delete(key))
    pending.set(key, load)
    return load
  }

  return async (graph: GraphCall, tenant: string, ids: unknown): Promise<Record<string, GroupCounts>> => {
    for (const [key, entry] of cache) if (entry.expires <= now()) cache.delete(key)
    if (!Array.isArray(ids)) return {}
    const wanted = [...new Set(ids.slice(0, GROUP_COUNT_LIMIT).filter(isGuid).map(id => id.toLowerCase()))]
    const entries = await Promise.all(wanted.map(async id => {
      const counts = await read(graph, tenant, id)
      return counts ? [[id, counts] as const] : []
    }))
    return Object.fromEntries(entries.flat())
  }
}

export const groupCounts = createGroupCounter()
