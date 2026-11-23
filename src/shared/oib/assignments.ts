import type { Item } from "../intune/registry"
import type { OibPlatform } from "./types"

/**
 * Assignments for OpenIntuneBaseline policies: which groups (and assignment filter) each policy
 * gets when it is deployed, or when the assignments of a deployed policy are managed.
 *
 * OIB marks every policy as device or user targeted: the PolicyManifest scope, or the " - D - " /
 * " - U - " part of the policy name for packs without a manifest. Device groups go to device
 * policies and user groups to user policies; policies without a marker follow `unmarked`.
 * Targets are Entra groups only. Pure, so the renderer and the main process build the same list.
 */

export type OibScope = "device" | "user"
export type UnmarkedChoice = "both" | "device" | "user" | "none"
export type FilterMode = "include" | "exclude"

export interface OibGroupRef {
  id: string
  /** Display name when the group could be read; shown only, never trusted by the main process. */
  name?: string
}

export interface OibFilterChoice {
  id: string
  mode: FilterMode
  name?: string
}

export interface OibAssignmentSpec {
  deviceGroups: OibGroupRef[]
  userGroups: OibGroupRef[]
  excludeGroups: OibGroupRef[]
  /** Where policies without a device or user marker go. */
  unmarked: UnmarkedChoice
  /** The filter for the include targets of policies of each filter platform (see filterPlatformFor). */
  filters: Partial<Record<FilterPlatform, OibFilterChoice>>
}

/** Assignment filter platforms (the Graph `platform` of an assignmentFilter) OIB policies use. */
export const FILTER_PLATFORMS = ["windows10AndLater", "macOS", "iOS", "androidForWork", "iOSMobileApplicationManagement", "androidMobileApplicationManagement"] as const
export type FilterPlatform = (typeof FILTER_PLATFORMS)[number]

export const FILTER_PLATFORM_LABELS: Record<FilterPlatform, string> = {
  windows10AndLater: "Windows",
  macOS: "macOS",
  iOS: "iOS/iPadOS",
  androidForWork: "Android Enterprise",
  iOSMobileApplicationManagement: "iOS/iPadOS apps",
  androidMobileApplicationManagement: "Android apps",
}

/** Groups per list, and groups across the three lists. */
export const MAX_GROUPS_PER_LIST = 25
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const emptySpec = (): OibAssignmentSpec => ({ deviceGroups: [], userGroups: [], excludeGroups: [], unmarked: "both", filters: {} })

/** Whether the spec assigns anything: policies stay unassigned without an include group. */
export const assignsAnything = (spec: OibAssignmentSpec | undefined): boolean => !!spec && (spec.deviceGroups.length > 0 || spec.userGroups.length > 0)

/** Whether a policy is device or user targeted, from the manifest scope or the OIB name marker. */
export function oibScope(policy: { scope?: string; name: string }): OibScope | undefined {
  const scope = policy.scope?.trim().toLowerCase()
  if (scope === "device") return "device"
  if (scope === "user") return "user"
  const marker = / - ([DU]) - /.exec(policy.name)?.[1]
  return marker === "D" ? "device" : marker === "U" ? "user" : undefined
}

/** Types whose assignments take no filter (Microsoft Learn: Windows update profiles). */
const NO_FILTER_FOLDERS = new Set(["DriverUpdateProfiles", "FeatureUpdateProfiles", "QualityUpdateProfiles"])
const FOLDER_FILTER_PLATFORM: Record<string, FilterPlatform> = {
  AppProtectionIOS: "iOSMobileApplicationManagement",
  AppProtectionAndroid: "androidMobileApplicationManagement",
}
const PLATFORM_FILTER_PLATFORM: Record<OibPlatform, FilterPlatform | undefined> = {
  windows: "windows10AndLater",
  win365: "windows10AndLater",
  macos: "macOS",
  ios: "iOS",
  android: "androidForWork",
  // BYOD holds app protection only; those folders name their own filter platform.
  byod: undefined,
}

/** The assignment filter platform a policy's filter must have, or undefined when the type takes no filter. */
export function filterPlatformFor(folder: string, platform: OibPlatform): FilterPlatform | undefined {
  if (NO_FILTER_FOLDERS.has(folder)) return undefined
  return FOLDER_FILTER_PLATFORM[folder] ?? PLATFORM_FILTER_PLATFORM[platform]
}

/** Managed device filters for device policies, managed app filters for app protection. */
export const filterManagementType = (platform: FilterPlatform): "devices" | "apps" => platform.endsWith("MobileApplicationManagement") ? "apps" : "devices"

export class AssignmentSpecError extends Error {}

function groups(value: unknown, label: string): OibGroupRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new AssignmentSpecError(`The ${label} list is invalid.`)
  if (value.length > MAX_GROUPS_PER_LIST) throw new AssignmentSpecError(`Choose at most ${MAX_GROUPS_PER_LIST} ${label}.`)
  const seen = new Set<string>()
  return value.map((entry) => {
    const id = typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : ""
    if (!GUID.test(id.trim())) throw new AssignmentSpecError(`Each of the ${label} must be an Entra group object ID.`)
    const normalized = id.trim().toLowerCase()
    if (seen.has(normalized)) throw new AssignmentSpecError(`A group is listed twice in the ${label}.`)
    seen.add(normalized)
    const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined
    return { id: normalized, ...(typeof name === "string" && name ? { name: name.slice(0, 256) } : {}) }
  })
}

/** Checks a spec from the renderer; throws AssignmentSpecError with a message the admin can act on. */
export function parseSpec(value: unknown): OibAssignmentSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentSpecError("The assignments are invalid.")
  const input = value as Record<string, unknown>
  const deviceGroups = groups(input.deviceGroups, "device groups")
  const userGroups = groups(input.userGroups, "user groups")
  const excludeGroups = groups(input.excludeGroups, "excluded groups")
  const excluded = new Set(excludeGroups.map((group) => group.id))
  if ([...deviceGroups, ...userGroups].some((group) => excluded.has(group.id))) throw new AssignmentSpecError("A group cannot be both included and excluded.")
  const unmarked = input.unmarked === undefined ? "both" : input.unmarked
  if (unmarked !== "both" && unmarked !== "device" && unmarked !== "user" && unmarked !== "none") throw new AssignmentSpecError("Choose where policies without a device or user marker go.")
  const filters: OibAssignmentSpec["filters"] = {}
  if (input.filters !== undefined) {
    if (!input.filters || typeof input.filters !== "object" || Array.isArray(input.filters)) throw new AssignmentSpecError("The assignment filters are invalid.")
    for (const [platform, choice] of Object.entries(input.filters as Record<string, unknown>)) {
      if (choice == null) continue
      if (!(FILTER_PLATFORMS as readonly string[]).includes(platform)) throw new AssignmentSpecError("Unknown assignment filter platform.")
      const entry = choice as Record<string, unknown>
      if (typeof entry.id !== "string" || !GUID.test(entry.id) || (entry.mode !== "include" && entry.mode !== "exclude")) throw new AssignmentSpecError("Choose an assignment filter and whether it includes or excludes devices.")
      filters[platform as FilterPlatform] = { id: entry.id.toLowerCase(), mode: entry.mode, ...(typeof entry.name === "string" && entry.name ? { name: entry.name.slice(0, 256) } : {}) }
    }
  }
  return { deviceGroups, userGroups, excludeGroups, unmarked, filters }
}

/** Every group the spec names, once. */
export const specGroupIds = (spec: OibAssignmentSpec): string[] => [...new Set([...spec.deviceGroups, ...spec.userGroups, ...spec.excludeGroups].map((group) => group.id))]

/** The include groups a policy of this scope gets. */
export function includesFor(scope: OibScope | undefined, spec: OibAssignmentSpec): OibGroupRef[] {
  const choice: UnmarkedChoice = scope ?? spec.unmarked
  const list = choice === "device" ? spec.deviceGroups : choice === "user" ? spec.userGroups : choice === "both" ? [...spec.deviceGroups, ...spec.userGroups] : []
  const seen = new Set<string>()
  return list.filter((group) => !seen.has(group.id) && seen.add(group.id))
}

export interface PolicyAssignments {
  /** The assignments to write, in Graph's shape. Empty when the policy stays unassigned. */
  assignments: Item[]
  include: number
  exclude: number
  filter?: OibFilterChoice
  /** What was left out, in words: unsupported exclusions or filters. */
  notes: string[]
}

/** The assignments one policy gets from the spec. */
export function assignmentsFor(policy: { folder: string; scope?: OibScope; typeLabel?: string; exclusionsUnsupported?: boolean }, platform: OibPlatform, spec: OibAssignmentSpec): PolicyAssignments {
  const includes = includesFor(policy.scope, spec)
  if (!includes.length) return { assignments: [], include: 0, exclude: 0, notes: [] }
  const notes: string[] = []
  const filterPlatform = filterPlatformFor(policy.folder, platform)
  const chosenFilters = Object.values(spec.filters).filter(Boolean)
  const filter = filterPlatform ? spec.filters[filterPlatform] : undefined
  if (!filterPlatform && chosenFilters.length) notes.push(`Assigned without a filter: ${policy.typeLabel ?? "this policy type"} does not support assignment filters.`)
  const excludes = policy.exclusionsUnsupported ? [] : spec.excludeGroups
  if (policy.exclusionsUnsupported && spec.excludeGroups.length) notes.push(`Excluded groups were left out: ${policy.typeLabel ?? "this policy type"} does not support exclusions.`)
  const assignments: Item[] = [
    ...includes.map((group): Item => ({ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: group.id, ...(filter ? { deviceAndAppManagementAssignmentFilterId: filter.id, deviceAndAppManagementAssignmentFilterType: filter.mode } : {}) } })),
    ...excludes.map((group): Item => ({ target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: group.id } })),
  ]
  return { assignments, include: includes.length, exclude: excludes.length, ...(filter ? { filter } : {}), notes }
}

const targetOf = (assignment: Item): Item => (assignment.target && typeof assignment.target === "object" && !Array.isArray(assignment.target) ? (assignment.target as Item) : {})
const kindOf = (assignment: Item) => String(targetOf(assignment)["@odata.type"] ?? "").replace("#microsoft.graph.", "")
const groupOf = (assignment: Item) => (typeof targetOf(assignment).groupId === "string" ? (targetOf(assignment).groupId as string).toLowerCase() : "")

/** Direct assignments only: assignments that come from a policy set are managed by the set. */
export const directAssignments = (assignments: unknown): Item[] =>
  (Array.isArray(assignments) ? (assignments as Item[]) : []).filter((entry) => entry && typeof entry === "object" && (typeof entry.source !== "string" || entry.source === "direct"))

/** An assignment as /assign takes it: only the target (and intent where the type has one). */
export function writableAssignment(assignment: Item): Item {
  const target = targetOf(assignment)
  const clean: Item = {}
  for (const [key, value] of Object.entries(target)) if (!key.includes("@odata.") || key === "@odata.type") clean[key] = value
  // Graph reports "no filter" as type none with a null ID; sending that back is accepted but noisy.
  if (clean.deviceAndAppManagementAssignmentFilterType === "none" || !clean.deviceAndAppManagementAssignmentFilterId) {
    delete clean.deviceAndAppManagementAssignmentFilterId
    delete clean.deviceAndAppManagementAssignmentFilterType
  }
  return { ...(typeof assignment.intent === "string" ? { intent: assignment.intent } : {}), target: clean }
}

/**
 * Adds the spec's assignments to the current ones. A group that is already a target keeps one
 * entry: the new one (an include gets the new filter). A group the spec includes but the policy
 * excludes (or the other way round) keeps both entries; Intune lets the exclusion win.
 */
export function mergeAssignments(current: Item[], added: Item[]): Item[] {
  const key = (assignment: Item) => `${kindOf(assignment)}|${groupOf(assignment)}`
  const replaced = new Set(added.filter(groupOf).map(key))
  return [...current.map(writableAssignment).filter((assignment) => !groupOf(assignment) || !replaced.has(key(assignment))), ...added]
}

/** Whether two assignment lists target the same groups the same way, in any order. */
export function sameAssignments(a: Item[], b: Item[]): boolean {
  const canonical = (list: Item[]) => list.map(writableAssignment).map((entry) => JSON.stringify(Object.keys(targetOf(entry)).sort().map((k) => [k, targetOf(entry)[k]]).concat([["intent", entry.intent ?? null]]))).sort()
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** Groups one assignment list includes and excludes conflict on, for a note. */
export function conflictingGroups(list: Item[]): string[] {
  const included = new Set(list.filter((entry) => kindOf(entry) === "groupAssignmentTarget").map(groupOf))
  return [...new Set(list.filter((entry) => kindOf(entry) === "exclusionGroupAssignmentTarget").map(groupOf).filter((id) => included.has(id)))]
}

/** One assignment in words, for the review and result. */
export function describeAssignment(assignment: Item, names: Record<string, string> = {}, filters: Record<string, string> = {}): string {
  const target = targetOf(assignment)
  const kind = kindOf(assignment)
  const group = groupOf(assignment)
  const who = kind === "allDevicesAssignmentTarget" ? "All devices"
    : kind === "allLicensedUsersAssignmentTarget" || kind === "allUsersAssignmentTarget" ? "All users"
      : group ? names[group] ?? group : kind || "Unknown target"
  const filterId = typeof target.deviceAndAppManagementAssignmentFilterId === "string" ? target.deviceAndAppManagementAssignmentFilterId.toLowerCase() : ""
  const filterType = target.deviceAndAppManagementAssignmentFilterType
  const filter = filterId && (filterType === "include" || filterType === "exclude") ? `, filter ${filters[filterId] ?? filterId} (${filterType})` : ""
  return `${kind === "exclusionGroupAssignmentTarget" ? "Excluded: " : ""}${who}${filter}`
}
