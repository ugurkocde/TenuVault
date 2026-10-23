import type { IntuneType, Item } from "./registry"

/**
 * Reads one Intune object the way a backup stores it: the detail GET with the type's $expand and
 * $select, paged expanded collections, extras, and masked values in plain text.
 *
 * Backup uses it to write snapshots and restore uses it to read the live object before replacing it,
 * so both compare like with like. Paths are relative to https://graph.microsoft.com/beta/.
 */
export interface GraphReader {
  get: (path: string) => Promise<Item>
  /** Follows @odata.nextLink; accepts a relative path or an absolute nextLink. */
  list: (path: string) => Promise<Item[]>
}

export function detailPath(type: IntuneType, id: string): string {
  if (type.singleton) return type.path
  const query = [type.expand && `$expand=${type.expand}`, type.select && `$select=${type.select}`].filter(Boolean).join("&")
  return `${type.path}/${encodeURIComponent(id)}${query ? `?${query}` : ""}`
}

export async function readObject(type: IntuneType, id: string, graph: GraphReader): Promise<Item> {
  const detail = await graph.get(detailPath(type, id))
  if (type.singleton) return singletonSnapshot(type.singleton, detail)
  // Large expanded collections (such as Settings Catalog settings) page like lists.
  for (const [key, value] of Object.entries(detail)) {
    if (key.endsWith("@odata.nextLink") && typeof value === "string") {
      const property = key.slice(0, -"@odata.nextLink".length)
      if (!Array.isArray(detail[property])) throw new Error(`Invalid expanded collection ${property}`)
      detail[property] = [...(detail[property] as Item[]), ...(await graph.list(value))]
      delete detail[key]
    }
  }
  // Extra paths are built from Graph-returned IDs, so each ID is encoded as one path segment.
  const encodedId = encodeURIComponent(id)
  for (const extra of type.extras ?? []) {
    if (extra.single) {
      detail[extra.property] = (await graph.get(extra.path(encodedId)))[extra.property] ?? null
      continue
    }
    const entries = await graph.list(extra.path(encodedId))
    if (extra.each) {
      for (const entry of entries) {
        const path = extra.each.path(encodedId, encodeURIComponent(String(entry.id)))
        if (extra.each.property) entry[extra.each.property] = await graph.list(path)
        else {
          Object.assign(entry, await graph.get(path))
          delete entry["@odata.context"]
        }
      }
    }
    detail[extra.property] = entries
  }
  for (const secret of type.secrets?.(detail) ?? []) {
    const plain = await graph.get(secret.path)
    if (typeof plain.value !== "string") throw new Error("Microsoft Graph did not return an encrypted setting's value")
    secret.apply(plain.value)
  }
  delete detail["@odata.context"]
  return detail
}

/** A tenant-wide object under its stored ID, with only the properties its type keeps (see IntuneType.singleton). */
function singletonSnapshot(singleton: NonNullable<IntuneType["singleton"]>, detail: Item): Item {
  const snapshot: Item = { id: singleton.id }
  for (const key of singleton.properties) if (key in detail) snapshot[key] = detail[key] ?? null
  return snapshot
}

/**
 * Whether a snapshot's empty `assignments` means "not read" rather than "not assigned": it was written
 * by a version that expanded the assignments of a type Graph answers with an empty list (see
 * assignmentsFormerlyExpanded). Such snapshots still carry the expand's `assignments@odata.context`,
 * which the {id}/assignments read does not add.
 */
export function assignmentsUnread(type: IntuneType | undefined, snapshot: Item | null | undefined): boolean {
  return (
    type?.assignmentsFormerlyExpanded === true &&
    !!snapshot &&
    "assignments@odata.context" in snapshot &&
    Array.isArray(snapshot.assignments) &&
    snapshot.assignments.length === 0
  )
}

/**
 * Two backed-up versions of an object, without their assignments when the older one could not read
 * them, so reading them now does not show up as a change.
 */
export function withoutUnreadAssignments<T extends Item>(type: IntuneType | undefined, older: T, newer: T): [T, T] {
  if (!assignmentsUnread(type, older)) return [older, newer]
  const { assignments: _older, ...before } = older
  const { assignments: _newer, ...after } = newer
  return [before as T, after as T]
}
