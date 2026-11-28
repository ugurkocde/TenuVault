import { GraphResponseValidationError } from "../graph-response-validation"
import type { DetailEnvelope, GraphVersion, IntuneType, Item, Json } from "./registry"

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
  /** Backup readers validate detail responses against the version they request. */
  detailVersion?: GraphVersion
  /** Follows @odata.nextLink; accepts a relative path or an absolute nextLink. */
  list: (path: string, idKey?: string) => Promise<Item[]>
  /** Validates an expanded page and follows its continuation, or reads the beta relationship when the page is omitted. */
  completeList?: (path: string, page?: unknown) => Promise<Item[]>
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
export async function readEntries(type: IntuneType, graph: GraphReader, discover: (path: string) => Promise<Item[]> = graph.list): Promise<Item[]> {
  if (type.singleton) {
    const path = detailPath(type, type.singleton.id)
    const response = await graph.get(path)
    const read = graph.detailVersion ? policyDetail(type, type.singleton.id, path, response, graph.detailVersion) : response
    return [{ ...read, id: type.singleton.id }]
  }
  if (type.staticIds) return type.staticIds.map(id => ({ id }))
  let entries: Item[]
  if (type.listSource) {
    const scopes = await discover(type.listSource.path).catch(error => { throw new ScopeDiscoveryError(error) })
    entries = []
    for (const scope of scopes) {
      if (typeof scope.id !== "string" || !scope.id) throw new GraphResponseValidationError("Microsoft Graph returned a scope without an ID")
      const filter = type.listSource.filter(scope.id)
      entries.push(...await graph.list(`${type.path}?$filter=${encodeURIComponent(filter)}`))
    }
  } else entries = await graph.list(listPath(type), type.idKey)
  return entries.map(entry => withIdentity(type, entry))
}

function withIdentity(type: IntuneType, entry: Item): Item {
  if (!type.idKey) return entry
  const id = entry[type.idKey]
  if (typeof id !== "string" || !id) throw new GraphResponseValidationError(`Microsoft Graph returned an object without ${type.idKey}`)
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

function validateDetail(read: Json, expected?: { key: string; id: string }, envelope?: DetailEnvelope): Item {
  if (!read || typeof read !== "object" || Array.isArray(read) || Object.hasOwn(read, "@odata.nextLink")) {
    throw new GraphResponseValidationError("Microsoft Graph did not return a single policy object")
  }
  const matchesIdentity = expected && Object.hasOwn(read, expected.key) && read[expected.key] === expected.id
  const value = read.value
  const inner = envelope === "valueObject" && value && typeof value === "object" && !Array.isArray(value)
    ? value
    : envelope === "singleValueArray" && Array.isArray(value) && value.length === 1 ? value[0] : undefined
  // A bare entity can have a value property of its own. A declared wrapper with its own identity still has to match.
  const innerHasIdentity = expected && inner && typeof inner === "object" && !Array.isArray(inner) && Object.hasOwn(inner, expected.key)
  if (inner !== undefined && (!matchesIdentity || innerHasIdentity)) return validateDetail(inner, expected)
  if (Array.isArray(value) && (!matchesIdentity || Object.hasOwn(read, "@odata.count"))) {
    throw new GraphResponseValidationError("Microsoft Graph did not return a single policy object")
  }
  if (expected && !matchesIdentity) {
    throw new GraphResponseValidationError(`Microsoft Graph returned a policy without the requested ${expected.key}`)
  }
  return read
}

function policyDetail(type: IntuneType, id: string, path: string, read: Item, version: GraphVersion): Item {
  if (type.singleton?.collection) return validateDetail(singletonObject(type.singleton, read))
  const envelope = type.detailEnvelope?.[version]
  if (type.singleton) return validateDetail(read, undefined, envelope)
  if (type.staticIds) {
    const detail = validateDetail(read)
    // Fixed routes use stable keys, while Graph may identify the resource with a tenant-specific ID.
    if (detail.id === id) return detail
    const context = detail["@odata.context"]
    if (typeof detail.id !== "string" || !detail.id.trim() || typeof context !== "string" || !context.endsWith(`$metadata#${path}/$entity`)) {
      throw new GraphResponseValidationError("Microsoft Graph returned a policy without the requested template identity")
    }
    return detail
  }
  return validateDetail(read, { key: type.idKey ?? "id", id }, envelope)
}

export class ExpansionRecoveryError extends Error {
  constructor(override readonly cause: unknown) {
    super("An expanded collection could not be recovered", { cause })
  }
}

export async function readObject(type: IntuneType, id: string, graph: GraphReader, options: ReadOptions = {}): Promise<Item> {
  const path = detailPath(type, id)
  const read = await graph.get(path)
  let detail = graph.detailVersion ? policyDetail(type, id, path, read, graph.detailVersion) : type.singleton ? singletonObject(type.singleton, read) : read
  const envelope = graph.detailVersion && type.detailEnvelope?.[graph.detailVersion]
  const getDetail = async (path: string, expected?: { key: string; id: string }, envelope?: DetailEnvelope) => {
    const response = await graph.get(path)
    return graph.detailVersion ? validateDetail(response, expected, envelope) : response
  }
  if (type.staticIds) detail = { ...detail, id }
  detail = withIdentity(type, detail)
  await completeExpanded(detail, graph, path.split("?")[0]!, type.expandedCollections ?? type.expand?.split(","), type.expansionFallbacks)
  // A type that keeps only some properties keeps them of the object itself; what its extras read is stored next to them.
  if (type.keep) detail = keptSnapshot(type.keep, detail)
  // Extra paths are built from Graph-returned IDs, so each ID is encoded as one path segment.
  // A tenant-wide object is stored under its type's ID; its sub-reads use the ID Graph gave it, when it has one.
  const encodedId = encodeURIComponent(type.singleton && typeof detail.id === "string" && detail.id ? detail.id : id)
  for (const extra of type.extras ?? []) {
    try {
      if (extra.object) {
        detail[extra.property] = await getDetail(extra.path(encodedId), undefined, envelope)
        continue
      }
      if (extra.single) {
        detail[extra.property] = (await getDetail(extra.path(encodedId), { key: "id", id }, envelope))[extra.property] ?? null
        continue
      }
      const collection = extra.path(encodedId)
      const entries = await graph.list(collection)
      if (extra.ids) {
        detail[extra.property] = sortedIds(entries, extra.property)
        continue
      }
      if (extra.each) {
        for (const entry of entries) {
          const path = extra.each.path(encodedId, encodeURIComponent(String(entry.id)))
          if (extra.each.property) entry[extra.each.property] = await graph.list(path)
          else {
            Object.assign(entry, await getDetail(path, { key: "id", id: String(entry.id) }, envelope))
            delete entry["@odata.context"]
          }
        }
      }
      await completeExpanded(entries, graph, collection.split("?")[0]!, extra.expandedCollections, extra.expansionFallbacks)
      detail[extra.property] = entries
    } catch (error) {
      const answer = error as { continuationPage?: true; status?: number; answer?: { code?: string; message?: string } }
      const matches = (pattern: NonNullable<IntuneType["notConfigured"]>[number]) => pattern.status === answer.status && (!pattern.code || pattern.code.toLowerCase() === answer.answer?.code?.toLowerCase()) && (!pattern.message || answer.answer?.message?.toLowerCase().includes(pattern.message.toLowerCase()))
      if (!answer.continuationPage && extra.notConfigured?.some(matches) && (!extra.notConfiguredWhen || extra.notConfiguredWhen(detail))) { detail[extra.property] = []; continue }
      if (!options.onUnreadExtra || !extra.optional?.some(matches)) throw error
      // An absent property means unread, never an empty collection that could mean not configured.
      delete detail[extra.property]
      options.onUnreadExtra(extra.property, error)
    }
  }
  for (const secret of type.secrets?.(detail) ?? []) {
    let plain: Item
    try {
      plain = await getDetail(secret.path)
    } catch (error) {
      if (!options.keepMasked?.(error)) throw error
      secret.apply(MASKED_VALUE)
      continue
    }
    if (typeof plain.value !== "string") throw new GraphResponseValidationError("Microsoft Graph did not return an encrypted setting's value")
    secret.apply(plain.value)
  }
  delete detail["@odata.context"]
  const snapshot = storedSnapshot(type, type.singleton ? singletonSnapshot(type, detail) : detail)
  if (type.maxSnapshotBytes && new TextEncoder().encode(JSON.stringify(snapshot, null, 2)).byteLength > type.maxSnapshotBytes) throw new GraphResponseValidationError(`The ${type.label} JSON exceeds the ${type.maxSnapshotBytes} byte limit`)
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
  if (type.keep && type.volume === "large") {
    const keep = new Set(["id", ...type.keep])
    // Preserve nulls and continuation evidence until the closed directory schema validates it.
    const selected = Object.fromEntries(Object.entries(copy).filter(([key]) => keep.has(key) || (key.endsWith("@odata.nextLink") && keep.has(key.slice(0, -"@odata.nextLink".length)))))
    return storedSnapshot(type, selected)
  }
  return storedSnapshot(type, type.keep ? keptSnapshot(type.keep, copy) : copy)
}

function storedSnapshot(type: IntuneType, snapshot: Item): Item {
  return orderedSnapshot(type, withoutNeverStored(type, type.normalizeSnapshot ? type.normalizeSnapshot(snapshot) : snapshot))
}

/** Read every expanded page, including terminal and nested pages, before storing it. */
async function completeExpanded(
  value: Json, graph: GraphReader, path: string, collections: readonly string[] = [],
  fallbacks: IntuneType["expansionFallbacks"] = {}, prefix = "",
): Promise<void> {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const entry of value) {
      const id = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.id : undefined
      await completeExpanded(entry, graph, path && typeof id === "string" && id ? `${path}/${encodeURIComponent(id)}` : "", collections, fallbacks, prefix)
    }
    return
  }
  const continuation = "@odata.nextLink"
  const declared = graph.completeList ? collections.filter(property => !property.includes(".")) : []
  const expanded = new Set(declared)
  for (const key of Object.keys(value)) {
    if (key.endsWith(continuation)) expanded.add(key.slice(0, -continuation.length))
  }
  // Every collection requested through $expand in the registry returns entities keyed by id.
  for (const property of expanded) {
    const key = `${property}${continuation}`
    const nextLink = value[key]
    if (graph.completeList) {
      if (!path) throw new GraphResponseValidationError(`Invalid expanded collection ${property}`)
      if (declared.includes(property) && !Object.hasOwn(value, property)) {
        const relationship = fallbacks[prefix + property] ?? property
        try {
          if (relationship === false) throw new GraphResponseValidationError(`Microsoft Graph did not return the expanded collection ${prefix}${property}`)
          value[property] = await graph.completeList(`${path}/${relationship}`)
        } catch (error) {
          throw new ExpansionRecoveryError(error)
        }
      } else {
        const page = { value: value[property], ...(Object.hasOwn(value, key) && { [continuation]: nextLink }) }
        value[property] = await graph.completeList(`${path}/${property}`, page)
      }
    } else {
      if (typeof nextLink !== "string") continue
      if (!Array.isArray(value[property])) throw new GraphResponseValidationError(`Invalid expanded collection ${property}`)
      value[property] = [...value[property] as Json[], ...await graph.list(nextLink)]
    }
    delete value[key]
  }
  for (const [key, child] of Object.entries(value)) {
    const prefixKey = `${key}.`
    const nested = collections.filter(property => property.startsWith(prefixKey)).map(property => property.slice(prefixKey.length))
    await completeExpanded(child, graph, path ? `${path}/${key}` : "", nested, fallbacks, prefix + prefixKey)
  }
}

/** Sort declared unordered collections at any depth; ordered settings keep their response order. */
function orderedSnapshot(type: IntuneType, snapshot: Item): Item {
  for (const [property, key] of Object.entries(type.unorderedCollections ?? {})) {
    const order = (value: Json, path: string[]): void => {
      if (Array.isArray(value)) { for (const entry of value) order(entry, path); return }
      if (!value || typeof value !== "object") return
      const [name, ...rest] = path
      const entries = value[name!]
      if (entries === undefined || entries === null) {
        if (type.requiredCollections?.includes(property)) throw new GraphResponseValidationError(`Microsoft Graph did not return the expanded collection ${property}`)
        return
      }
      if (rest.length) { order(entries, rest); return }
      const identity = (entry: Item): string | undefined => key === "$content" ? stableContent(entry) : typeof entry[key] === "string" ? entry[key] as string : undefined
      if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry) || !identity(entry))) throw new GraphResponseValidationError(`Microsoft Graph returned an entry without ${key} in ${property}`)
      value[name!] = [...entries].sort((a, b) => {
        const left = identity(a as Item)!
        const right = identity(b as Item)!
        return left < right ? -1 : left > right ? 1 : 0
      })
    }
    order(snapshot, property.split("."))
  }
  return snapshot
}

/** Subject sets have no Graph ID; their complete query or typed target defines their identity. */
function stableContent(value: Json): string {
  if (!value || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableContent).join(",")}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableContent(value[key]!)}`).join(",")}}`
}

/** The IDs of a collection's entries, each once and in a fixed order, so two reads of the same set compare equal. */
export function sortedIds(entries: Item[], property: string): string[] {
  const ids = entries.map((entry) => {
    if (typeof entry.id !== "string" || !entry.id) throw new GraphResponseValidationError(`Microsoft Graph returned an entry without an ID in ${property}`)
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
  if (read && typeof read === "object" && Object.hasOwn(read, "@odata.nextLink")) throw new GraphResponseValidationError("Microsoft Graph returned a list that continues on another page where one tenant-wide object was expected")
  const entries = read?.value
  // Storing one of several, or nothing, would pass for the tenant's setting.
  if (!Array.isArray(entries) || entries.length !== 1 || !entries[0] || typeof entries[0] !== "object" || Array.isArray(entries[0])) {
    throw new GraphResponseValidationError(`Microsoft Graph returned ${Array.isArray(entries) ? entries.length : "no"} objects where one tenant-wide object was expected`)
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
      if (entries.length !== 1 || typeof entries[0]?.id !== "string" || !entries[0].id) throw new GraphResponseValidationError("Microsoft Graph did not return exactly one organization ID")
      return encodeURIComponent(entries[0].id)
    }).catch(error => { throw new OrganizationResolutionError(error) })
    return path.replaceAll("{organizationId}", await organization)
  }
  return {
    ...graph,
    get: async path => graph.get(await resolve(path)),
    list: async (path, idKey) => graph.list(await resolve(path), idKey),
    ...(graph.completeList && { completeList: async (path: string, page?: unknown) => graph.completeList!(await resolve(path), page) }),
  }
}
