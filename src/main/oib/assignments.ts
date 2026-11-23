import type { GraphCall } from "../../portal/lib/policies/graph-restore"
import type { Item } from "../../shared/intune/registry"
import { FILTER_PLATFORM_LABELS, FILTER_PLATFORMS, filterManagementType, specGroupIds, type FilterPlatform, type OibAssignmentSpec } from "../../shared/oib/assignments"
import { FrameworkError } from "../frameworks/service"

/**
 * Tenant reads for OIB assignments: group search and names, assignment filters, and the check of
 * an assignment spec against the tenant before anything changes. Group reads need a group read
 * permission (Group.Read.All or GroupMember.Read.All); without one they report `readable: false`
 * and the admin works with object IDs. Filters are Intune objects the app can always read.
 */

const GRAPH_BETA = "https://graph.microsoft.com/beta/"
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Graph takes at most 15 values in one `id in (...)` filter. */
const IDS_PER_REQUEST = 15
const MAX_FILTER_PAGES = 20
const SEARCH_RESULTS = 15

export interface OibGroup {
  id: string
  displayName: string
  /** "security", "microsoft365" or "other" (distribution lists cannot be assigned). */
  kind: "security" | "microsoft365" | "other"
  dynamic: boolean
}

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

function toGroup(entry: Item): OibGroup | null {
  if (typeof entry.id !== "string" || typeof entry.displayName !== "string") return null
  const unified = Array.isArray(entry.groupTypes) && entry.groupTypes.includes("Unified")
  const dynamic = Array.isArray(entry.groupTypes) && entry.groupTypes.includes("DynamicMembership")
  return { id: entry.id.toLowerCase(), displayName: entry.displayName, kind: unified ? "microsoft365" : entry.securityEnabled === true ? "security" : "other", dynamic }
}

/** Groups whose name starts with the query (or the group with that object ID). */
export async function searchGroups(graph: GraphCall, query: string): Promise<{ readable: boolean; groups: OibGroup[] }> {
  const text = query.trim().slice(0, 120)
  if (!text) return { readable: true, groups: [] }
  const filter = GUID.test(text) ? `id eq '${text.toLowerCase()}'` : `startswith(displayName,'${text.replaceAll("'", "''")}')`
  const response = await graph("GET", `groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName,securityEnabled,mailEnabled,groupTypes&$top=${SEARCH_RESULTS}`)
  if (denied(response.status)) return { readable: false, groups: [] }
  if (response.status >= 300) throw new FrameworkError(`Groups could not be searched (${response.status}). ${errorOf(response.body)}`.trim(), 502)
  const groups = (Array.isArray(response.body.value) ? (response.body.value as Item[]) : []).flatMap((entry) => toGroup(entry) ?? [])
  return { readable: true, groups: groups.sort((a, b) => a.displayName.localeCompare(b.displayName)) }
}

/**
 * The groups with these IDs. `readable: false` when the token cannot read groups; then nothing is
 * known about them. `missing` holds the IDs no group has.
 */
export async function lookupGroups(graph: GraphCall, ids: string[]): Promise<{ readable: boolean; groups: OibGroup[]; missing: string[] }> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()).filter((id) => GUID.test(id)))]
  const groups: OibGroup[] = []
  for (let index = 0; index < wanted.length; index += IDS_PER_REQUEST) {
    const chunk = wanted.slice(index, index + IDS_PER_REQUEST)
    const filter = `id in (${chunk.map((id) => `'${id}'`).join(",")})`
    const response = await graph("GET", `groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName,securityEnabled,mailEnabled,groupTypes`)
    if (denied(response.status)) return { readable: false, groups: [], missing: [] }
    if (response.status >= 300) throw new FrameworkError(`Groups could not be read (${response.status}). ${errorOf(response.body)}`.trim(), 502)
    groups.push(...(Array.isArray(response.body.value) ? (response.body.value as Item[]) : []).flatMap((entry) => toGroup(entry) ?? []))
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
  /** Group names read from the tenant, by ID; empty when groups cannot be read. */
  groupNames: Record<string, string>
  filterNames: Record<string, string>
  /** False when the groups could not be read, so their existence was not checked. */
  groupsChecked: boolean
}

/**
 * Checks a spec against the tenant before anything changes: every group exists (when groups can be
 * read) and every filter exists with the platform and management type it is chosen for. Graph
 * accepts a filter of another platform without complaint, so this check is the only one.
 * Names read here replace the names the renderer sent.
 */
export async function checkSpec(graph: GraphCall, spec: OibAssignmentSpec): Promise<CheckedSpec> {
  const ids = specGroupIds(spec)
  const lookup = ids.length ? await lookupGroups(graph, ids) : { readable: true, groups: [], missing: [] }
  if (lookup.missing.length) throw new FrameworkError(`${lookup.missing.length === 1 ? "This group does" : "These groups do"} not exist in the tenant: ${lookup.missing.join(", ")}. Nothing was changed.`)
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
    spec: { ...spec, deviceGroups: named(spec.deviceGroups), userGroups: named(spec.userGroups), excludeGroups: named(spec.excludeGroups), filters },
    groupNames, filterNames, groupsChecked: lookup.readable,
  }
}
