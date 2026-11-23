import { isGuid } from "../security"
import type { Item } from "./registry"

export type GroupState = { state: "found" | "missing" | "unknown"; name: string | null }
type GroupGraph = (method: "GET" | "POST", path: string, body?: Item) => Promise<{ status: number; body: Item }>

const unknown: GroupState = { state: "unknown", name: null }
const groupPath = (id: string) => `groups/${id}?$select=id,displayName`

function groupState(id: string, status: unknown, body?: Item): GroupState {
  if (status === 404) return { state: "missing", name: null }
  if (status !== 200 || typeof body?.id !== "string" || body.id.toLowerCase() !== id) return unknown
  return { state: "found", name: typeof body.displayName === "string" ? body.displayName : null }
}

/** Read only the referenced groups. Batch subrequests are GETs and may return in any order. */
export async function readGroupStates(graph: GroupGraph, ids: Iterable<string>): Promise<Map<string, GroupState>> {
  const keys = [...new Set([...ids].filter(isGuid).map((id) => id.toLowerCase()))]
  const states = new Map<string, GroupState>()
  if (keys.length <= 4) {
    await Promise.all(keys.map(async (id) => {
      const response = await graph("GET", groupPath(id)).catch(() => undefined)
      states.set(id, groupState(id, response?.status, response?.body))
    }))
    return states
  }
  for (let start = 0; start < keys.length; start += 20) {
    const chunk = keys.slice(start, start + 20)
    const response = await graph("POST", "$batch", {
      requests: chunk.map((id, index) => ({ id: String(index), method: "GET", url: `/${groupPath(id)}` })),
    }).catch(() => undefined)
    const responses = response?.status === 200 && Array.isArray(response.body.responses) ? response.body.responses as Item[] : []
    const byId = new Map(responses.flatMap((entry) => typeof entry?.id === "string" ? [[entry.id, entry]] as const : []))
    for (const [index, id] of chunk.entries()) {
      const entry = byId.get(String(index))
      states.set(id, groupState(id, entry?.status, entry?.body as Item | undefined))
    }
    if (response?.status === 403) {
      for (const id of keys.slice(start + chunk.length)) states.set(id, unknown)
      break
    }
  }
  return states
}

/** Filter by name only when suggesting a replacement. Escape the name as an OData string literal. */
export function groupNamePath(name: string): string {
  return `groups?$select=id,displayName&$filter=${encodeURIComponent(`displayName eq '${name.trim().replaceAll("'", "''")}'`)}`
}
