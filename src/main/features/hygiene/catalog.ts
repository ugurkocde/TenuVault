import { buildSettingsCatalog } from "../../../shared/intune/settings-catalog"
import { GraphReadError, listAll } from "../change-sets/graph"
import type { FeatureDeps } from "../deps"
import type { SettingsCatalog } from "./rules"

/** The catalog read of one scan, as stored on the scan record and shown in the scan summary. */
export interface CatalogCheck {
  state: "checked" | "unavailable"
  checkedAt: string | null
  /** Definitions the catalog returned; null while unavailable. */
  total: number | null
  /** Why the catalog could not be read; null once checked. */
  reason: string | null
  /** The classified catalog for detection; present only when checked. Not stored. */
  catalog?: SettingsCatalog
}

/**
 * Reads the current Settings Catalog (GET deviceManagement/configurationSettings, read only)
 * and classifies each definition by its name and description wording.
 *
 * Verified shapes (docs/roadmap/lokka-verification-deprecated-settings.md): without `$top`
 * the service returns every definition in one response (18,620 in the lab) with no
 * `@odata.nextLink`; with `$top` it truncates silently, so `$top` is never sent. listAll still
 * follows a nextLink if Graph sends one. `$select` keeps the response to the three fields the
 * rule needs. An empty answer is treated as a failed read: the catalog is never empty, and a
 * failed read must leave the rule unknown instead of flagging every setting as removed.
 * Duplicate definition IDs keep the marked entry, so an unmarked duplicate cannot hide a mark.
 * Every failure leaves the check unavailable with the reason; nothing here fails the scan.
 */
export async function fetchSettingsCatalog(deps: FeatureDeps, tenantId: string): Promise<CatalogCheck> {
  let graph: Awaited<ReturnType<FeatureDeps["graph"]>>
  try {
    graph = await deps.graph(tenantId)
  } catch {
    return { state: "unavailable", checkedAt: null, total: null, reason: "Microsoft Graph is unavailable (sign in to this tenant), so deprecated settings could not be checked." }
  }
  try {
    const definitions = await listAll(graph, "deviceManagement/configurationSettings?$select=id,displayName,description")
    if (!definitions.length) {
      return { state: "unavailable", checkedAt: null, total: null, reason: "Microsoft Graph returned an empty Settings Catalog, so deprecated settings could not be checked." }
    }
    const settings = buildSettingsCatalog(definitions)
    const checkedAt = deps.now().toISOString()
    return {
      state: "checked",
      checkedAt,
      total: definitions.length,
      reason: null,
      catalog: { checkedAt, total: definitions.length, settings },
    }
  } catch (error) {
    if (error instanceof GraphReadError && (error.status === 401 || error.status === 403)) {
      return { state: "unavailable", checkedAt: null, total: null, reason: "The Settings Catalog cannot be read with this app's permissions (DeviceManagementConfiguration.Read.All is required), so deprecated settings could not be checked." }
    }
    const detail = error instanceof Error ? error.message : "unknown error"
    return { state: "unavailable", checkedAt: null, total: null, reason: `The Settings Catalog could not be read (${detail.slice(0, 200)}), so deprecated settings could not be checked.` }
  }
}
