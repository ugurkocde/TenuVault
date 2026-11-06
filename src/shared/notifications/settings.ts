/**
 * Changed setting names from audit events. Intune and Entra log each changed property with
 * its old and new value. The values are compared here, in memory, and dropped: only the
 * names of the settings whose value changed leave this module. A value is never returned,
 * stored or sent, and the runbook's Get-TvChangedSettings follows the same rules.
 *
 * Only updates have changed settings. A create or delete lists every property of the
 * object, which says nothing about what changed, so callers ask for updates only.
 */

/** How many setting names a message shows; the rest is counted. */
export const MAX_SETTING_NAMES = 15
/** How many names a change keeps for alert matching, so a filter on any changed setting still works. */
export const MAX_TRACKED_SETTINGS = 200
const MAX_SETTING_NAME = 120

/** Bookkeeping fields Intune and Entra log on every write. They never count as a setting. */
const NOISE = new Set(["id", "createddatetime", "lastmodifieddatetime", "modifieddatetime", "version", "devicemanagementapiversion", "templateid", "deleteddatetime"])

export interface ChangedSettings {
  names: string[]
  more: number
}

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/** "<null>" and "null" are how Intune writes a recorded empty value; both mean the same. */
function normalizedValue(value: string): string {
  const trimmed = value.trim()
  return trimmed === "<null>" || trimmed === "null" ? "" : trimmed
}

/** "$Collection.RoleScopeTagIds[0]" as "RoleScopeTagIds": one name per collection, not per index. */
function settingName(raw: string): string | null {
  const name = raw.replace(/^\$Collection\./, "").replace(/\[\d+\]/g, "").trim()
  if (!name || NOISE.has(name.toLowerCase())) return null
  return name.slice(0, MAX_SETTING_NAME)
}

function bounded(names: string[]): ChangedSettings {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(name)
  }
  return { names: unique.slice(0, MAX_TRACKED_SETTINGS), more: Math.max(0, unique.length - MAX_TRACKED_SETTINGS) }
}

/** Parses a logged value that holds a whole object as JSON, or null. */
function jsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith("{")) return null
  try {
    return record(JSON.parse(trimmed))
  } catch {
    return null
  }
}

/** Same value for the comparison: objects by their sorted JSON, everything else as JSON. */
function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const object = record(value)
  if (object) return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`
  return JSON.stringify(value ?? null)
}

/**
 * The paths that differ between two versions of an object, as dotted names down to three
 * levels ("conditions.users.excludeGroups"). Lists are compared whole: a changed list is
 * one changed setting, named by its path.
 */
function differingPaths(before: Record<string, unknown>, after: Record<string, unknown>, prefix: string, depth: number, out: string[]): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  for (const key of keys) {
    if (NOISE.has(key.toLowerCase()) || key.startsWith("@odata")) continue
    const a = before[key]
    const b = after[key]
    if (sameValue(a, b)) continue
    const path = prefix ? `${prefix}.${key}` : key
    const childA = record(a)
    const childB = record(b)
    const countBefore = out.length
    if (depth < 3 && (childA || childB)) differingPaths(childA ?? {}, childB ?? {}, path, depth + 1, out)
    // A leaf, or an object that only changed between null and empty: the path itself changed.
    if (out.length === countBefore) out.push(path.slice(0, MAX_SETTING_NAME))
  }
}

/**
 * The settings an Intune update changed, from one resource of an auditEvent. A property
 * counts only when both its old and its new value were recorded and they differ: Intune
 * writes null (not "<null>") for a side it did not record, which settings catalog updates
 * do for every property.
 */
export function intuneChangedSettings(resource: Record<string, unknown> | null): ChangedSettings {
  if (!resource || !Array.isArray(resource.modifiedProperties)) return { names: [], more: 0 }
  const names: string[] = []
  for (const entry of resource.modifiedProperties) {
    const property = record(entry)
    if (!property || typeof property.displayName !== "string") continue
    if (typeof property.oldValue !== "string" || typeof property.newValue !== "string") continue
    if (normalizedValue(property.oldValue) === normalizedValue(property.newValue)) continue
    const name = settingName(property.displayName)
    if (name) names.push(name)
  }
  return bounded(names)
}

/**
 * The settings an Entra update changed, from the target resources of a directoryAudit. A
 * property that holds the whole object as JSON (ConditionalAccessPolicy, NamedLocation and
 * the like) is compared field by field; any other property counts by its own name.
 */
export function entraChangedSettings(targets: Array<Record<string, unknown>>): ChangedSettings {
  const names: string[] = []
  for (const target of targets) {
    if (!Array.isArray(target.modifiedProperties)) continue
    for (const entry of target.modifiedProperties) {
      const property = record(entry)
      if (!property || typeof property.displayName !== "string") continue
      if (typeof property.oldValue !== "string" || typeof property.newValue !== "string") continue
      const before = jsonObject(property.oldValue)
      const after = jsonObject(property.newValue)
      if (before && after) {
        differingPaths(before, after, "", 1, names)
        continue
      }
      if (normalizedValue(property.oldValue) === normalizedValue(property.newValue)) continue
      const name = settingName(property.displayName)
      if (name) names.push(name)
    }
  }
  return bounded(names)
}
