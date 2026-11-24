import type { Item, Json } from "./registry"

/**
 * Properties Intune changes on every write or read without the configuration changing: timestamps,
 * version counters, response annotations and the reference IDs of encrypted values.
 */
const VOLATILE = new Set(["lastModifiedDateTime", "createdDateTime", "modifiedDateTime", "version", "secretReferenceValueId"])

const volatile = (key: string) => VOLATILE.has(key) || key === "@odata.context" || key.endsWith("@odata.context") || key.endsWith("@odata.nextLink")

/**
 * A snapshot with volatile properties removed and object keys sorted, so two reads of an unchanged
 * object serialize the same. Array order is kept: Intune returns settings in a stable order.
 */
export function comparableSnapshot(value: Json | undefined): Json {
  if (Array.isArray(value)) return value.map((entry) => comparableSnapshot(entry))
  if (value === null || typeof value !== "object") return value ?? null
  const result: { [key: string]: Json } = {}
  for (const key of Object.keys(value).sort()) {
    // A JSON "__proto__" key would replace the copy's prototype instead of becoming a property.
    if (volatile(key) || key === "__proto__") continue
    result[key] = comparableSnapshot(value[key])
  }
  return result
}

/** True when two snapshots hold the same configuration. */
export function sameSnapshot(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(comparableSnapshot(a)) === JSON.stringify(comparableSnapshot(b))
}

// The 0.5 cloud runbook wrote empty assignment arrays as null and singletons as strings.
// Keep the recorded file hash for integrity checks and use this view only for comparisons.
export function roleAssignmentSnapshot(snapshot: Item, format: "arrays" | "legacy"): Item {
  if (!Array.isArray(snapshot?.roleAssignments)) return snapshot
  let changed = false
  const roleAssignments = snapshot.roleAssignments.map(assignment => {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return assignment
    let result = assignment
    for (const key of ["members", "resourceScopes", "scopeMembers", "roleScopeTagIds"]) {
      if (!Object.hasOwn(assignment, key)) continue
      const value = assignment[key]
      if (value === undefined) continue
      let next = value
      if (format === "legacy" && Array.isArray(value)) {
        if (value.length === 0) next = null
        else if (value.length === 1 && typeof value[0] === "string") next = value[0]
      } else if (format === "arrays") {
        if (value === null) next = []
        else if (typeof value === "string") next = [value]
      }
      if (next === value) continue
      if (result === assignment) result = { ...assignment }
      result[key] = next
      changed = true
    }
    return result
  })
  return changed ? { ...snapshot, roleAssignments } : snapshot
}
