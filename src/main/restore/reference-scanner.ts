import { INTUNE_TYPES, type Item } from "../../shared/intune/registry"
import { graphVersion, organizationReader, readEntries, readObject, listSnapshot } from "../../shared/intune/read"
import { safetyReader } from "./safety-reader"

/** Uses the real backup reader, including every expanded page and sub-resource, with fresh live GETs. */
export async function referenceSnapshots(token: string, fetchImpl: typeof fetch = fetch): Promise<Array<{ path: string; snapshot: Item }>> {
  const snapshots: Array<{ path: string; snapshot: Item }> = []
  for (const type of INTUNE_TYPES.filter(type => type.restoreSafety !== "identity")) {
    const reader = organizationReader(safetyReader(token, fetchImpl, graphVersion(type), type.headers))
    for (const item of await readEntries(type, reader)) {
      if (typeof item.id !== "string" || !item.id) throw new Error("Reference scan returned a policy without an ID")
      snapshots.push({ path: `${type.folder}/${item.id}`, snapshot: type.listOnly ? listSnapshot(type, item) : await readObject(type, item.id, reader) })
    }
  }
  return snapshots
}
