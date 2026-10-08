import type { SettingNames } from "../../../shared/intune/drift"
import type { GraphCall } from "~/lib/policies/graph-restore"
import { mapLimit } from "~/lib/map-limit"

type Definition = { name: string; options: Record<string, string> }

/**
 * Setting definitions read so far, by ID; null for IDs Graph does not know. Definitions are
 * Microsoft's public catalog, the same in every tenant, so the cache is shared between tenants.
 */
const definitions = new Map<string, Definition | null>()

/** Definitions read at once. */
const CONCURRENCY = 6

/**
 * Display names of the given Settings Catalog setting definitions and their choice options, from
 * GET beta deviceManagement/configurationSettings/{id}. Unknown IDs (404) are left out; any other
 * failure stops the lookup and returns what was read, since names only make the page easier to read.
 */
export async function readSettingNames(ids: string[], graph: GraphCall, signal?: AbortSignal): Promise<SettingNames> {
  let failed = false
  await mapLimit(ids.filter((id) => !definitions.has(id)), CONCURRENCY, async (id) => {
    if (failed) return
    signal?.throwIfAborted()
    try {
      const response = await graph("GET", `deviceManagement/configurationSettings/${encodeURIComponent(id)}`)
      if (response.status === 404) { definitions.set(id, null); return }
      if (response.status !== 200) { failed = true; return }
      const body = response.body as { displayName?: unknown; options?: unknown }
      const options: Record<string, string> = {}
      if (Array.isArray(body.options)) {
        for (const option of body.options as Array<{ itemId?: unknown; displayName?: unknown }>) {
          if (typeof option?.itemId === "string" && typeof option.displayName === "string" && option.displayName.trim()) options[option.itemId] = option.displayName.trim()
        }
      }
      definitions.set(id, typeof body.displayName === "string" && body.displayName.trim() ? { name: body.displayName.trim(), options } : null)
    } catch (error) {
      if (signal?.aborted) throw error
      failed = true
    }
  })
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
