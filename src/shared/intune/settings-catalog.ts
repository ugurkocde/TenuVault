/**
 * Reading Settings Catalog deprecation from catalog wording, shared by the hygiene scan
 * (main process) and the restore catalog check (portal route and wizard).
 *
 * Microsoft Graph has no deprecation flag on a setting definition; deprecation is written in
 * the definition's display name and description. The patterns below were verified against the
 * live catalog (docs/roadmap/lokka-verification-deprecated-settings.md). Anything else, in
 * particular a description that mentions a deprecated technology rather than the setting
 * itself, is not a mark.
 */

/** How the Settings Catalog marks one setting definition. */
export type CatalogMark = "deprecated" | "to-be-deprecated"

export interface CatalogSetting {
  displayName: string | null
  /** Null when the catalog wording does not mark the setting itself deprecated. */
  mark: CatalogMark | null
  markedBy: "name" | "description" | null
}

/**
 * Whether one catalog definition is marked deprecated. Only these count: the name says
 * deprecated or obsolete ("[Deprecated] X", "X (deprecated)", "X (obsolete)"), the description
 * says this policy or setting is deprecated, or it starts with "[to be deprecated]".
 */
export function catalogSetting(definition: { displayName?: unknown; description?: unknown }): CatalogSetting {
  const displayName = typeof definition.displayName === "string" && definition.displayName ? definition.displayName : null
  const description = typeof definition.description === "string" ? definition.description : ""
  if (displayName && /deprecat|obsolete/i.test(displayName)) return { displayName, mark: "deprecated", markedBy: "name" }
  if (/this (policy|setting) is deprecated/i.test(description)) return { displayName, mark: "deprecated", markedBy: "description" }
  if (/^\s*\[to be deprecated\]/i.test(description)) return { displayName, mark: "to-be-deprecated", markedBy: "description" }
  return { displayName, mark: null, markedBy: null }
}

/**
 * Classified catalog by definition ID. Duplicate IDs keep the marked entry, so an unmarked
 * duplicate cannot hide a mark; entries without a string ID are skipped.
 */
export function buildSettingsCatalog(definitions: Array<{ id?: unknown; displayName?: unknown; description?: unknown }>): Map<string, CatalogSetting> {
  const settings = new Map<string, CatalogSetting>()
  for (const definition of definitions) {
    if (typeof definition.id !== "string" || !definition.id) continue
    const entry = catalogSetting(definition)
    const current = settings.get(definition.id)
    if (!current || (entry.mark && !current.mark)) settings.set(definition.id, entry)
  }
  return settings
}

/** Every setting definition ID in a snapshot subtree, at any nesting level, each once, in reading order. */
export function settingDefinitionIds(node: unknown): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    const id = record.settingDefinitionId
    if (typeof id === "string" && id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
    for (const entry of Object.values(record)) walk(entry)
  }
  walk(node)
  return ids
}

export type DeprecatedState = "deprecated" | "to be deprecated" | "not in catalog"

export interface DeprecatedSettingHit {
  definitionId: string
  /** The catalog name; null when the definition is not in the catalog. */
  displayName: string | null
  state: DeprecatedState
}

/**
 * The marked or missing settings among `definitionIds`, against a classified catalog.
 * An ID absent from the catalog is "not in catalog": callers may only report it when the
 * catalog was read completely, and never as definite.
 */
export function deprecatedHits(definitionIds: Iterable<string>, catalog: ReadonlyMap<string, CatalogSetting>): DeprecatedSettingHit[] {
  const hits: DeprecatedSettingHit[] = []
  for (const definitionId of definitionIds) {
    const known = catalog.get(definitionId)
    if (!known) hits.push({ definitionId, displayName: null, state: "not in catalog" })
    else if (known.mark === "deprecated") hits.push({ definitionId, displayName: known.displayName, state: "deprecated" })
    else if (known.mark === "to-be-deprecated") hits.push({ definitionId, displayName: known.displayName, state: "to be deprecated" })
  }
  return hits
}
