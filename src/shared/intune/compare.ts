import type { Json } from "./registry"

/**
 * Properties Intune changes on every write or read without the configuration changing: timestamps,
 * version counters, response annotations and the reference IDs of encrypted values.
 */
const VOLATILE = new Set(["lastModifiedDateTime", "createdDateTime", "modifiedDateTime", "version", "secretReferenceValueId", "_tenuvaultOmaMasked"])

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
