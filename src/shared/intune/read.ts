import type { GraphVersion, IntuneType, Item, Json } from "./registry"

/**
 * Reads one Intune object the way a backup stores it: the detail GET with the type's $expand and
 * $select, paged expanded collections, extras, and masked values in plain text.
 *
 * Backup uses it to write snapshots and restore uses it to read the live object before replacing it,
 * so both compare like with like. Paths are relative to the type's Microsoft Graph version (see
 * graphVersion); the reader sends the type's headers with every request.
 */
export interface GraphReader {
  get: (path: string) => Promise<Item>
  /** Follows @odata.nextLink; accepts a relative path or an absolute nextLink. */
  list: (path: string) => Promise<Item[]>
}

/** The Microsoft Graph version a type's paths are relative to. */
export function graphVersion(type: Pick<IntuneType, "apiVersion">): GraphVersion {
  return type.apiVersion ?? "beta"
}

const listQuery = (type: IntuneType) => [type.filter && `$filter=${encodeURIComponent(type.filter)}`, type.listQuery].filter(Boolean)

/** The list GET of a type: its path with its mandatory filter and its extra query. */
export function listPath(type: IntuneType): string {
  const query = listQuery(type).join("&")
  return `${type.path}${query ? `?${query}` : ""}`
}

/** A discovery answer never describes whether the requested configuration type is set up. */
export class ScopeDiscoveryError extends Error {
  constructor(override readonly cause: unknown) {
    super(`Could not discover configuration scopes: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

/** Lists the actual scopes before reading filtered collections; no unread scope becomes empty coverage. */
export async function readEntries(type: IntuneType, graph: GraphReader): Promise<Item[]> {
  if (type.singleton) return [{ ...await graph.get(detailPath(type, type.singleton.id)), id: type.singleton.id }]
  if (type.staticIds) return type.staticIds.map(id => ({ id }))
  let entries: Item[]
  if (type.listSource) {
    const scopes = await graph.list(type.listSource.path).catch(error => { throw new ScopeDiscoveryError(error) })
    entries = []
    for (const scope of scopes) {
      if (typeof scope.id !== "string" || !scope.id) throw new Error("Microsoft Graph returned a scope without an ID")
      const filter = type.listSource.filter(scope.id)
      entries.push(...await graph.list(`${type.path}?$filter=${encodeURIComponent(filter)}`))
    }
  } else entries = await graph.list(listPath(type))
  return entries.map(entry => withIdentity(type, entry))
}

function withIdentity(type: IntuneType, entry: Item): Item {
  if (!type.idKey) return entry
  const id = entry[type.idKey]
  if (typeof id !== "string" || !id) throw new Error(`Microsoft Graph returned an object without ${type.idKey}`)
  return { ...entry, id }
}

export interface ReadOptions {
  /**
   * Backup only, never restore: whether a refused plain-text read of a masked value keeps it masked
   * (****) instead of failing the object. Microsoft documents DeviceManagementConfiguration.Read.All
   * as enough to read encrypted OMA-URI values, so this applies only when it refuses the Backup
   * Reader's read anyway. A masked snapshot is never
   * restorable (see the registry's restorable checks), so it can only record that the value exists.
   */
  keepMasked?: (error: unknown) => boolean
  /** Records an unread optional sub-read. Without this callback it fails the object. */
  onUnreadExtra?: (property: string, error: unknown) => void
}

export function detailPath(type: IntuneType, id: string): string {
  const shape = [type.expand && `$expand=${type.expand}`, type.select && `$select=${type.select}`].filter(Boolean)
  // A tenant-wide object that Graph answers as a list is read like one, with the type's filter and extra query.
  if (type.singleton) {
    const query = [...(type.singleton.collection ? listQuery(type) : []), ...shape].join("&")
    return `${type.path}${query ? `?${query}` : ""}`
  }
  const query = shape.join("&")
  return `${type.path}/${encodeURIComponent(id)}${query ? `?${query}` : ""}`
}

export async function readObject(type: IntuneType, id: string, graph: GraphReader, options: ReadOptions = {}): Promise<Item> {
  const read = await graph.get(detailPath(type, id))
  let detail = type.singleton ? singletonObject(type.singleton, read) : read
  if (type.staticIds) detail = { ...detail, id }
  detail = withIdentity(type, detail)
  // Large expanded collections (such as Settings Catalog settings) page like lists.
  for (const [key, value] of Object.entries(detail)) {
    if (key.endsWith("@odata.nextLink") && typeof value === "string") {
      const property = key.slice(0, -"@odata.nextLink".length)
      if (!Array.isArray(detail[property])) throw new Error(`Invalid expanded collection ${property}`)
      detail[property] = [...(detail[property] as Item[]), ...(await graph.list(value))]
      delete detail[key]
    }
  }
  // A type that keeps only some properties keeps them of the object itself; what its extras read is stored next to them.
  if (type.keep) detail = keptSnapshot(type.keep, detail)
  // Extra paths are built from Graph-returned IDs, so each ID is encoded as one path segment.
  // A tenant-wide object is stored under its type's ID; its sub-reads use the ID Graph gave it, when it has one.
  const encodedId = encodeURIComponent(type.singleton && typeof detail.id === "string" && detail.id ? detail.id : id)
  for (const extra of type.extras ?? []) {
    try {
      if (extra.object) {
        detail[extra.property] = await graph.get(extra.path(encodedId))
        continue
      }
      if (extra.single) {
        detail[extra.property] = (await graph.get(extra.path(encodedId)))[extra.property] ?? null
        continue
      }
      const entries = await graph.list(extra.path(encodedId))
      if (extra.ids) {
        detail[extra.property] = sortedIds(entries, extra.property)
        continue
      }
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
    } catch (error) {
      const answer = error as { status?: number; answer?: { code?: string; message?: string } }
      const matches = (pattern: NonNullable<IntuneType["notConfigured"]>[number]) => pattern.status === answer.status && (!pattern.code || pattern.code.toLowerCase() === answer.answer?.code?.toLowerCase()) && (!pattern.message || answer.answer?.message?.toLowerCase().includes(pattern.message.toLowerCase()))
      if (extra.notConfigured?.some(matches) && (!extra.notConfiguredWhen || extra.notConfiguredWhen(detail))) { detail[extra.property] = []; continue }
      if (!options.onUnreadExtra || !extra.optional?.some(matches)) throw error
      // An absent property means unread, never an empty collection that could mean not configured.
      delete detail[extra.property]
      options.onUnreadExtra(extra.property, error)
    }
  }
  for (const secret of type.secrets?.(detail) ?? []) {
    let plain: Item
    try {
      plain = await graph.get(secret.path)
    } catch (error) {
      if (!options.keepMasked?.(error)) throw error
      secret.apply(MASKED_VALUE)
      continue
    }
    if (typeof plain.value !== "string") throw new Error("Microsoft Graph did not return an encrypted setting's value")
    secret.apply(plain.value)
  }
  delete detail["@odata.context"]
  const snapshot = withoutNeverStored(type, type.singleton ? singletonSnapshot(type, detail) : detail)
  if (type.maxSnapshotBytes && new TextEncoder().encode(JSON.stringify(snapshot, null, 2)).byteLength > type.maxSnapshotBytes) throw new Error(`The ${type.label} JSON exceeds the ${type.maxSnapshotBytes} byte limit`)
  return snapshot
}

/**
 * The snapshot a backup stores for a list entry of a `listOnly` type, the same as readObject would
 * return for the object (see IntuneType.keep).
 */
export function listSnapshot(type: IntuneType, item: Item): Item {
  // Removing nested properties must not change the list entry itself.
  const copy = type.neverStored?.length || type.neverStoredKeys?.length ? structuredClone(item) : { ...item }
  delete copy["@odata.context"]
  return withoutNeverStored(type, type.keep ? keptSnapshot(type.keep, copy) : copy)
}

/** The IDs of a collection's entries, each once and in a fixed order, so two reads of the same set compare equal. */
function sortedIds(entries: Item[], property: string): string[] {
  const ids = entries.map((entry) => {
    if (typeof entry.id !== "string" || !entry.id) throw new Error(`Microsoft Graph returned an entry without an ID in ${property}`)
    return entry.id
  })
  return [...new Set(ids)].sort()
}

/** The snapshot without the properties its type never stores (see IntuneType.neverStored). */
function withoutNeverStored(type: IntuneType, snapshot: Item): Item {
  const remove = (value: Json | undefined, path: string[]): void => {
    if (Array.isArray(value)) {
      for (const entry of value) remove(entry, path)
      return
    }
    if (!value || typeof value !== "object") return
    const [key, ...rest] = path
    if (rest.length) remove(value[key!], rest)
    else delete value[key!]
  }
  const keys = new Set(type.neverStoredKeys)
  const scrub = (value: Json): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) { value.forEach(scrub); return }
    for (const key of Object.keys(value)) {
      if (key !== "id" && keys.has(key)) delete value[key]
      else scrub(value[key]!)
    }
  }
  if (keys.size) scrub(snapshot)
  // Backups, comparison and restore identify an object by its ID, so no type can leave it out.
  for (const path of type.neverStored ?? []) if (path !== "id") remove(snapshot, path.split("."))
  return snapshot
}

/**
 * The live object that has the snapshot's `locateBy` value, read like a backup, when exactly one does.
 * Used when the backed-up ID no longer exists, for objects Intune gives a new ID when they are added again.
 */
export async function locateObject(type: IntuneType, snapshot: Item, graph: GraphReader): Promise<Item | undefined> {
  const key = type.locateBy
  const value = key ? snapshot[key] : undefined
  if (!key || typeof value !== "string" || !value.trim()) return undefined
  // contains() is the filter Graph supports on these properties; it also matches longer values, so the match is exact here.
  const filter = `contains(${key},'${value.replace(/'/g, "''")}')`
  const found = (await graph.list(`${type.path}?$filter=${encodeURIComponent(filter)}`))
    .filter((item) => typeof item[key] === "string" && (item[key] as string).toLowerCase() === value.toLowerCase())
  if (found.length !== 1 || typeof found[0]!.id !== "string") return undefined
  return type.listOnly ? listSnapshot(type, found[0]!) : readObject(type, found[0]!.id, graph)
}

/** The object's ID and the properties its type keeps, with values Graph leaves out or returns as null stored as "". */
function keptSnapshot(keep: string[], detail: Item): Item {
  const snapshot: Item = { id: detail.id ?? null }
  for (const key of keep) snapshot[key] = detail[key] ?? ""
  return snapshot
}

/** How Microsoft Graph shows an encrypted value it does not return in plain text. */
export const MASKED_VALUE = "****"

/**
 * The snapshot as a read that could not decrypt its masked values would store it, or null for a type
 * without masked values. Backups fingerprint it so a snapshot with **** and one with the plain value
 * compare as the same object.
 */
export function withMaskedSecrets(type: IntuneType, snapshot: Item): Item | null {
  // Only objects with encrypted values are copied; finding them does not change the snapshot.
  if (!type.secrets?.(snapshot).length) return null
  const copy = structuredClone(snapshot)
  const secrets = type.secrets(copy)
  if (!secrets.length) return null
  for (const secret of secrets) secret.apply(MASKED_VALUE)
  return copy
}

/** The tenant-wide object of a read: the answer itself, or the one entry of the list Graph answers with (see IntuneType.singleton). */
function singletonObject(singleton: NonNullable<IntuneType["singleton"]>, read: Item): Item {
  if (!singleton.collection) return read
  // A list that goes on may hold a second object, or a page that cannot be read: its first entry is not the tenant's setting.
  if ("@odata.nextLink" in read) throw new Error("Microsoft Graph returned a list that continues on another page where one tenant-wide object was expected")
  const entries = read.value
  // Storing one of several, or nothing, would pass for the tenant's setting.
  if (!Array.isArray(entries) || entries.length !== 1 || !entries[0] || typeof entries[0] !== "object" || Array.isArray(entries[0])) {
    throw new Error(`Microsoft Graph returned ${Array.isArray(entries) ? entries.length : "no"} objects where one tenant-wide object was expected`)
  }
  return entries[0] as Item
}

/**
 * A tenant-wide object under its stored ID: with the properties its type keeps and what its extras
 * read, or with every property when the type names none (see IntuneType.singleton).
 */
function singletonSnapshot(type: IntuneType, detail: Item): Item {
  const snapshot: Item = { id: type.singleton!.id }
  const kept = type.singleton!.properties
  if (!kept) {
    const { id: _own, ...rest } = detail
    return { ...snapshot, ...rest }
  }
  for (const key of [...kept, ...(type.extras ?? []).map((extra) => extra.property)]) if (key in detail) snapshot[key] = detail[key] ?? null
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

/** Keeps a resolver failure distinct from an answer from the requested type's endpoint. */
export class OrganizationResolutionError extends Error {
  constructor(override readonly cause: unknown) {
    super(`Could not resolve the organization ID: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

/** Resolves the organization-scoped paths without embedding a tenant ID in the registry. */
export function organizationReader(graph: GraphReader): GraphReader {
  let organization: Promise<string> | undefined
  const resolve = async (path: string): Promise<string> => {
    if (!path.includes("{organizationId}")) return path
    organization ??= graph.list("organization?$select=id").then(entries => {
      if (entries.length !== 1 || typeof entries[0]?.id !== "string" || !entries[0].id) throw new Error("Microsoft Graph did not return exactly one organization ID")
      return encodeURIComponent(entries[0].id)
    }).catch(error => { throw new OrganizationResolutionError(error) })
    return path.replaceAll("{organizationId}", await organization)
  }
  return { get: async path => graph.get(await resolve(path)), list: async path => graph.list(await resolve(path)) }
}
