import type { SettingNames } from "../../../shared/intune/drift"
import type { Item } from "../../../shared/intune/registry"
import type { GraphCall } from "~/lib/policies/graph-restore"

type Definition = { name: string; options: Record<string, string> }

/**
 * Setting definitions read so far, by ID; null for IDs Graph does not know. Definitions are
 * Microsoft's public catalog, the same in every tenant, so the cache is shared between tenants.
 * The cache holds at most MAX_CACHED_DEFINITIONS entries; the oldest entries go first.
 */
const definitions = new Map<string, Definition | null>()

/** Most setting definitions kept in the shared cache. */
export const MAX_CACHED_DEFINITIONS = 500

/** Setting definitions requested per Microsoft Graph $batch call. */
export const BATCH_SIZE = 20

function cacheDefinition(id: string, definition: Definition | null): void {
  definitions.delete(id)
  definitions.set(id, definition)
  while (definitions.size > MAX_CACHED_DEFINITIONS) {
    const oldest = definitions.keys().next().value
    if (oldest === undefined) break
    definitions.delete(oldest)
  }
}

function parseDefinition(body: { displayName?: unknown; options?: unknown }): Definition | null {
  const options: Record<string, string> = {}
  if (Array.isArray(body.options)) {
    for (const option of body.options as Array<{ itemId?: unknown; displayName?: unknown }>) {
      if (typeof option?.itemId === "string" && typeof option.displayName === "string" && option.displayName.trim()) options[option.itemId] = option.displayName.trim()
    }
  }
  return typeof body.displayName === "string" && body.displayName.trim() ? { name: body.displayName.trim(), options } : null
}

interface BatchItem {
  id: string
  status: number
  body?: { displayName?: unknown; options?: unknown }
}

/**
 * Display names of the given Settings Catalog setting definitions and their choice options, from
 * Microsoft Graph $batch reads of beta deviceManagement/configurationSettings/{id}, at most
 * BATCH_SIZE definitions per call. Unknown IDs (404) are left out; any other failure stops the
 * lookup and returns what was read, since names only make the page easier to read.
 */
export async function readSettingNames(ids: string[], graph: GraphCall, signal?: AbortSignal): Promise<SettingNames> {
  const uncached = [...new Set(ids.filter((id) => !definitions.has(id)))]
  let failed = false
  for (let start = 0; start < uncached.length && !failed; start += BATCH_SIZE) {
    signal?.throwIfAborted()
    const chunk = uncached.slice(start, start + BATCH_SIZE)
    const body: Item = {
      requests: chunk.map((id, index) => ({
        id: String(index),
        method: "GET",
        url: `/deviceManagement/configurationSettings/${encodeURIComponent(id)}`,
      })),
    }
    let items: BatchItem[]
    try {
      const response = await graph("POST", "$batch", body)
      if (response.status !== 200) { failed = true; break }
      const responses = (response.body as { responses?: unknown }).responses
      if (!Array.isArray(responses)) { failed = true; break }
      items = responses as BatchItem[]
    } catch (error) {
      if (signal?.aborted) throw error
      failed = true
      break
    }
    // $batch reports each read on its own; a failure in one item does not fail the others.
    const byIndex = new Map(items.map((item) => [item.id, item]))
    for (const [index, id] of chunk.entries()) {
      const item = byIndex.get(String(index))
      if (!item) { failed = true; continue }
      if (item.status === 404) { cacheDefinition(id, null); continue }
      if (item.status !== 200) { failed = true; continue }
      cacheDefinition(id, parseDefinition(item.body ?? {}))
    }
  }
  const names: SettingNames = { settings: {}, options: {} }
  for (const id of ids) {
    const definition = definitions.get(id)
    if (!definition) continue
    names.settings[id] = definition.name
    Object.assign(names.options, definition.options)
  }
  return names
}

/** For tests. */
export function clearSettingNames(): void {
  definitions.clear()
}
