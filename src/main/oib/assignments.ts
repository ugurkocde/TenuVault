import type { GraphCall } from "../../portal/lib/policies/graph-restore"
import { groupKind, GROUP_CHECK_REQUIRED, GROUP_SEARCH_LIMIT, type GroupSearchResult, type TenantGroup } from "../../shared/group-access"
import type { IntuneType, Item } from "../../shared/intune/registry"
import { isGuid } from "../../shared/security"
import { FILTER_PLATFORM_LABELS, FILTER_PLATFORMS, filterManagementType, specGroupIds, type FilterPlatform, type OibAssignmentSpec } from "../../shared/oib/assignments"
import { FrameworkError } from "../frameworks/service"

/**
 * Tenant reads for OIB assignments: group search and names, assignment filters, and the check of
 * an assignment spec against the tenant before anything changes. Group reads return
 * `readable: false` when the tenant refuses access.
 */

const GRAPH_BETA = "https://graph.microsoft.com/beta/"
/** Graph takes at most 15 values in one `id in (...)` filter. */
const IDS_PER_REQUEST = 15
const MAX_FILTER_PAGES = 20

export interface OibFilter {
  id: string
  displayName: string
  platform: string
  managementType: "devices" | "apps"
}

const denied = (status: number) => status === 401 || status === 403

const errorOf = (body: Item) => {
  const error = body.error as Item | undefined
  return typeof error?.message === "string" && error.message ? error.message : ""
}

export function toGroup(entry: Item): TenantGroup | null {
  if (!isGuid(entry.id) || typeof entry.displayName !== "string") return null
  const dynamic = Array.isArray(entry.groupTypes) && entry.groupTypes.includes("DynamicMembership")
  return { id: entry.id.toLowerCase(), displayName: entry.displayName, kind: groupKind(entry.securityEnabled, entry.groupTypes), dynamic }
}

/** Groups whose name starts with the query (or the group with that object ID). */
export async function searchGroups(graph: GraphCall, query: string): Promise<GroupSearchResult> {
  const text = query.trim().slice(0, 120)
  if (!text) return { readable: true, groups: [] }
  const objectId = isGuid(text) ? text.toLowerCase() : null
  const filter = objectId ? `id eq '${objectId}'` : `startswith(displayName,'${text.replaceAll("'", "''")}')`
  const response = await graph("GET", `groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName,securityEnabled,mailEnabled,groupTypes&$top=${GROUP_SEARCH_LIMIT}`)
  if (denied(response.status)) return { readable: false, groups: [] }
  if (response.status >= 300) throw new FrameworkError(`Groups could not be searched (${response.status}). ${errorOf(response.body)}`.trim(), 502)
  if (!Array.isArray(response.body.value)) throw new FrameworkError("The groups were not returned.", 502)
  const groups = (response.body.value as Item[]).slice(0, GROUP_SEARCH_LIMIT).flatMap((entry) => toGroup(entry) ?? [])
  return { readable: true, groups: groups.sort((a, b) => a.displayName.localeCompare(b.displayName)) }
}

/**
 * The groups with these IDs. `readable: false` when the token cannot read groups; then nothing is
 * known about them. `missing` holds the IDs no group has.
 */
export async function lookupGroups(graph: GraphCall, ids: string[]): Promise<{ readable: boolean; groups: TenantGroup[]; missing: string[] }> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))]
  const groups: TenantGroup[] = []
  for (let index = 0; index < wanted.length; index += IDS_PER_REQUEST) {
    const chunk = wanted.slice(index, index + IDS_PER_REQUEST).filter(isGuid)
    if (!chunk.length) continue
    const filter = `id in (${chunk.map((id) => `'${id}'`).join(",")})`
    let next = `groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName,securityEnabled,mailEnabled,groupTypes`
    for (let page = 0; next; page++) {
      if (page >= IDS_PER_REQUEST) throw new FrameworkError("The groups could not be read completely.", 502)
      const response = await graph("GET", next)
      if (denied(response.status)) return { readable: false, groups: [], missing: [] }
      // A filter for a single missing ID can return 404 instead of an empty list.
      if (page === 0 && chunk.length === 1 && response.status === 404 && (response.body.error as Item | undefined)?.code === "Request_ResourceNotFound") break
      if (response.status >= 300) throw new FrameworkError(`Groups could not be read (${response.status}). ${errorOf(response.body)}`.trim(), 502)
      if (!Array.isArray(response.body.value)) throw new FrameworkError("The groups were not returned.", 502)
      for (const entry of response.body.value as Item[]) {
        const group = toGroup(entry)
        if (group && chunk.includes(group.id)) groups.push(group)
      }
      const link = response.body["@odata.nextLink"]
      if (link && !(typeof link === "string" && link.startsWith(GRAPH_BETA + "groups?"))) throw new FrameworkError("The groups could not be read completely.", 502)
      next = typeof link === "string" && link ? link.slice(GRAPH_BETA.length) : ""
    }
  }
  const found = new Set(groups.map((group) => group.id))
  return { readable: true, groups, missing: wanted.filter((id) => !found.has(id)) }
}

/** The tenant's assignment filters on the platforms OIB uses. */
export async function listFilters(graph: GraphCall): Promise<OibFilter[]> {
  const filters: OibFilter[] = []
  let next: string | undefined = "deviceManagement/assignmentFilters?$select=id,displayName,platform,assignmentFilterManagementType"
  for (let page = 0; next; page++) {
    if (page >= MAX_FILTER_PAGES) throw new FrameworkError("The assignment filters could not be read completely.", 502)
    const response = await graph("GET", next)
    if (response.status >= 300) throw new FrameworkError(`The assignment filters could not be read (${response.status}). ${errorOf(response.body)}`.trim(), response.status === 403 ? 403 : 502)
    for (const entry of Array.isArray(response.body.value) ? (response.body.value as Item[]) : []) {
      if (typeof entry.id !== "string" || typeof entry.displayName !== "string" || typeof entry.platform !== "string") continue
      if (!(FILTER_PLATFORMS as readonly string[]).includes(entry.platform)) continue
      filters.push({ id: entry.id.toLowerCase(), displayName: entry.displayName, platform: entry.platform, managementType: entry.assignmentFilterManagementType === "apps" ? "apps" : "devices" })
    }
    const link = response.body["@odata.nextLink"]
    next = typeof link === "string" && link.startsWith(GRAPH_BETA) ? link.slice(GRAPH_BETA.length) : undefined
  }
  return filters.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export interface CheckedSpec {
  spec: OibAssignmentSpec
  /** Group names read from the tenant, by ID. */
  groupNames: Record<string, string>
  filterNames: Record<string, string>
}

/**
 * Check that every group exists and each filter matches its platform and management type.
 * Graph accepts a filter of another platform, so TenuVault checks before writing.
 * Names read here replace the names the renderer sent.
 */
export async function checkSpec(graph: GraphCall, spec: OibAssignmentSpec): Promise<CheckedSpec> {
  const ids = specGroupIds(spec)
  const lookup = ids.length ? await lookupGroups(graph, ids) : { readable: true, groups: [], missing: [] }
  if (!lookup.readable) throw new FrameworkError(GROUP_CHECK_REQUIRED, 403)
  if (lookup.missing.length) throw new FrameworkError(`${lookup.missing.length === 1 ? "This group does" : "These groups do"} not exist in the tenant: ${lookup.missing.join(", ")}. Nothing was changed.`)
  const unassignable = lookup.groups.filter((group) => group.kind === "other")
  if (unassignable.length) throw new FrameworkError(`Intune cannot assign distribution lists: ${unassignable.map((group) => group.displayName).join(", ")}. Choose a security or Microsoft 365 group. Nothing was changed.`)
  const groupNames = Object.fromEntries(lookup.groups.map((group) => [group.id, group.displayName]))
  const chosen = Object.entries(spec.filters).filter((entry): entry is [FilterPlatform, NonNullable<OibAssignmentSpec["filters"][FilterPlatform]>] => !!entry[1])
  const filterNames: Record<string, string> = {}
  if (chosen.length) {
    const filters = await listFilters(graph)
    for (const [platform, choice] of chosen) {
      const filter = filters.find((entry) => entry.id === choice.id)
      if (!filter) throw new FrameworkError(`The assignment filter ${choice.name ?? choice.id} does not exist in the tenant. Nothing was changed.`)
      if (filter.platform !== platform || filter.managementType !== filterManagementType(platform)) throw new FrameworkError(`The assignment filter ${filter.displayName} is not a ${FILTER_PLATFORM_LABELS[platform]} filter. Nothing was changed.`)
      filterNames[filter.id] = filter.displayName
    }
  }
  const named = (list: OibAssignmentSpec["deviceGroups"]) => list.map((group) => ({ id: group.id, ...(groupNames[group.id] ? { name: groupNames[group.id] } : {}) }))
  const filters = Object.fromEntries(chosen.map(([platform, choice]) => [platform, { id: choice.id, mode: choice.mode, ...(filterNames[choice.id] ? { name: filterNames[choice.id] } : {}) }]))
  return {
    spec: { ...spec, deviceGroups: named(spec.deviceGroups), userGroups: named(spec.userGroups), excludeDeviceGroups: named(spec.excludeDeviceGroups), excludeUserGroups: named(spec.excludeUserGroups), filters },
    groupNames, filterNames,
  }
}

const MAX_ASSIGNMENT_PAGES = 50

/**
 * A deployed policy's name and its assignments, and nothing else: the full backup read of some
 * types (administrative templates read every definition value) would widen the time between
 * reading the assignments and writing them. The assignments come last. Settings Catalog returns
 * an empty list for $expand on a single object, so its assignments are read as their own
 * collection; the other types expand them (app protection lists them late otherwise).
 * Undefined when the policy no longer exists.
 */
export async function readCurrentAssignments(graph: GraphCall, type: IntuneType, id: string): Promise<{ name?: string; assignments: Item[] } | undefined> {
  const gone = (status: number, body: Item) => status === 404 || (status === 400 && /ResourceNotFound/i.test(JSON.stringify(body)))
  const path = `${type.path}/${encodeURIComponent(id)}`
  const separate = !!type.extras?.some((extra) => extra.property === "assignments")
  const head = await graph("GET", `${path}?$select=id,${type.nameKey}${separate ? "" : "&$expand=assignments"}`)
  if (gone(head.status, head.body)) return undefined
  if (head.status >= 300) throw new FrameworkError(`The policy could not be read (${head.status}). ${errorOf(head.body)}`.trim(), 502)
  const name = typeof head.body[type.nameKey] === "string" ? (head.body[type.nameKey] as string) : undefined
  const assignments: Item[] = []
  let next: string | undefined = `${path}/assignments`
  if (!separate) {
    if (!Array.isArray(head.body.assignments)) throw new FrameworkError("The assignments of the policy were not returned.", 502)
    assignments.push(...(head.body.assignments as Item[]))
    // An expanded list can continue on further pages; a list cut short would drop groups from the write and from undo.
    const link = head.body["assignments@odata.nextLink"]
    if (link == null || link === "") return { name, assignments }
    if (!(typeof link === "string" && link.startsWith(GRAPH_BETA))) throw new FrameworkError("The assignments of the policy could not be read completely.", 502)
    next = link.slice(GRAPH_BETA.length)
  }
  for (let page = 0; next; page++) {
    if (page >= MAX_ASSIGNMENT_PAGES) throw new FrameworkError("The assignments of the policy could not be read completely.", 502)
    const response = await graph("GET", next)
    // Only the policy itself reading as not found means it is gone; a missing assignment page is a failed read.
    if (response.status >= 300) throw new FrameworkError(`The assignments could not be read (${response.status}). ${errorOf(response.body)}`.trim(), 502)
    if (!Array.isArray(response.body.value)) throw new FrameworkError("The assignments of the policy were not returned.", 502)
    assignments.push(...(response.body.value as Item[]))
    const link = response.body["@odata.nextLink"]
    if (link != null && link !== "" && !(typeof link === "string" && link.startsWith(GRAPH_BETA))) throw new FrameworkError("The assignments of the policy could not be read completely.", 502)
    next = typeof link === "string" && link ? link.slice(GRAPH_BETA.length) : undefined
  }
  return { name, assignments }
}
