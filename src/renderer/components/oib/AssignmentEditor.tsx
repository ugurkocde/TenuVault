import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { GroupAccessCard } from "../GroupAccess"
import { GroupCountLabel, GroupSearch, useGroupCounts, type GroupDirectory } from "../GroupSearch"
import type { GroupCounts, GroupSearchResult, TenantGroup } from "../../../shared/group-access"
import { cn } from "~/lib/utils"
import { emptySpec, FILTER_PLATFORM_LABELS, filterManagementType, filterPlatformFor, MAX_GROUPS_PER_LIST, platformFilterPlatform, specGroupIds, type FilterPlatform, type OibAssignmentSpec, type OibGroupRef, type OibScope, type UnmarkedChoice } from "../../../shared/oib/assignments"
import type { OibPlatform } from "../../../shared/oib/types"
import { errorText, oibRequest, type OibTenant } from "./common"

/**
 * Device groups, user groups, excluded groups and assignment filters for OIB policies. OIB marks
 * each policy as device or user targeted; device groups go to device policies, user groups to
 * user policies. The main process checks each selected group and filter before it writes anything.
 */

interface OibFilter { id: string; displayName: string; platform: string; managementType: "devices" | "apps" }

/** What the policies to assign need: how many of each scope, and the filter platforms they take. */
export interface AssignmentTargets {
  device: number
  user: number
  unmarked: number
  filterPlatforms: FilterPlatform[]
  /** Policies whose type takes no filter, by the filter platform the rest of their platform uses. */
  unfiltered: Partial<Record<FilterPlatform, number>>
}

export function assignmentTargets(policies: Array<{ platform: OibPlatform; folder?: string; scope?: OibScope }>): AssignmentTargets {
  const platforms = new Set<FilterPlatform>()
  const unfiltered: Partial<Record<FilterPlatform, number>> = {}
  for (const policy of policies) {
    const platform = policy.folder ? filterPlatformFor(policy.folder, policy.platform) : undefined
    if (platform) platforms.add(platform)
    const own = platformFilterPlatform(policy.platform)
    if (policy.folder && !platform && own) unfiltered[own] = (unfiltered[own] ?? 0) + 1
  }
  return {
    device: policies.filter(p => p.scope === "device").length,
    user: policies.filter(p => p.scope === "user").length,
    unmarked: policies.filter(p => !p.scope).length,
    filterPlatforms: [...platforms],
    unfiltered: Object.fromEntries(Object.entries(unfiltered).filter(([platform]) => platforms.has(platform as FilterPlatform))),
  }
}

/** One tenant's assignment choices, with the group names read from that tenant. Plain data, so a parent can keep one per tenant. */
export interface AssignmentData {
  spec: OibAssignmentSpec
  /** Group names read from the tenant, by ID. */
  names: Record<string, string>
  /** Group IDs the tenant does not have (known only when groups can be read). */
  missing: string[]
  /** null until the first group read; false when the app may not read groups. */
  readable: boolean | null
  checking: boolean
}

export const newAssignment = (spec?: OibAssignmentSpec): AssignmentData => ({
  spec: spec ?? emptySpec(),
  names: Object.fromEntries(spec ? [...spec.deviceGroups, ...spec.userGroups, ...spec.excludeDeviceGroups, ...spec.excludeUserGroups].flatMap(g => g.name ? [[g.id, g.name]] : []) : []),
  missing: [], readable: null, checking: false,
})

export interface AssignmentState {
  tenant: OibTenant
  data: AssignmentData
  update: (change: (data: AssignmentData) => AssignmentData) => void
}

/** Groups of the spec the tenant does not have. */
export const unknownGroups = (data: AssignmentData, targets: AssignmentTargets) => specGroupIds(specFor(data, targets)).filter(id => data.missing.includes(id))

/** Verify selected groups whenever the effective selection changes or the editor reopens. */
function useGroupLookup({ tenant, data, update }: AssignmentState, targets: AssignmentTargets, enabled: boolean) {
  const key = specGroupIds(specFor(data, targets)).sort().join(",")
  useEffect(() => {
    if (!key || !enabled) return
    const ids = key.split(",")
    let live = true
    update(d => ({ ...d, checking: true }))
    oibRequest<{ readable: boolean; groups: TenantGroup[]; missing: string[] }>({ action: "oib-group-lookup", tenantId: tenant.tenantId, appId: tenant.appId, ids })
      .then(result => {
        if (!live) return
        update(d => result.readable
          ? {
            ...d, readable: true, checking: false,
            names: { ...d.names, ...Object.fromEntries(result.groups.map(g => [g.id, g.displayName])) },
            missing: [...d.missing.filter(id => !ids.includes(id)), ...result.missing],
          }
          : { ...d, readable: false, checking: false })
      })
      // The main process checks the groups again before it writes.
      .catch(() => { if (live) update(d => ({ ...d, checking: false })) })
    return () => { live = false; update(d => d.checking ? { ...d, checking: false } : d) }
  }, [tenant.tenantId, tenant.appId, key, enabled])
}

function scopeUsed(targets: AssignmentTargets, spec: OibAssignmentSpec, scope: "device" | "user") {
  return targets[scope] > 0 || (targets.unmarked > 0 && (spec.unmarked === "both" || spec.unmarked === scope))
}

/** Send the scopes and filters the selected policies use. */
export function specFor(data: AssignmentData, targets: AssignmentTargets): OibAssignmentSpec {
  const { spec } = data
  const named = (list: OibGroupRef[]) => list.map(g => ({ id: g.id, ...(data.names[g.id] ? { name: data.names[g.id] } : {}) }))
  const filters = Object.fromEntries(Object.entries(spec.filters).filter(([platform, choice]) => choice && targets.filterPlatforms.includes(platform as FilterPlatform)))
  const devices = scopeUsed(targets, spec, "device")
  const users = scopeUsed(targets, spec, "user")
  return {
    ...spec,
    deviceGroups: devices ? named(spec.deviceGroups) : [],
    userGroups: users ? named(spec.userGroups) : [],
    excludeDeviceGroups: devices && spec.deviceGroups.length ? named(spec.excludeDeviceGroups) : [],
    excludeUserGroups: users && spec.userGroups.length ? named(spec.excludeUserGroups) : [],
    filters,
  }
}

const groupName = (data: AssignmentData, id: string) => data.names[id] ?? id
export const groupNames = (data: AssignmentData, list: OibGroupRef[]) => list.map(g => groupName(data, g.id))

function GroupPicker({ state, directory, list, onChange, label, hint, blocked, scope, used, exclusionNotice }: {
  state: AssignmentState
  directory: GroupDirectory
  list: OibGroupRef[]
  onChange: (list: OibGroupRef[]) => void
  label: string
  hint: string
  blocked: OibGroupRef[]
  scope: "device" | "user"
  used: boolean
  exclusionNotice?: string
}) {
  const { data, update } = state
  const unavailable = new Map(blocked.map(g => [g.id, "Already chosen on the other side. A group cannot be both included and excluded."]))
  for (const group of list) unavailable.set(group.id, "Already chosen")
  const counts = useGroupCounts(directory, used ? list.map(group => group.id).filter(id => !data.missing.includes(id)) : [])
  const full = list.length >= MAX_GROUPS_PER_LIST
  if (!used) return <div aria-disabled="true">
    <p className="text-sm font-medium text-gray-500">{label}</p>
    <p className="text-xs text-gray-500">Not used: no {scope} policy is selected.</p>
  </div>

  return <div>
    <p className="text-sm font-medium text-gray-800">{label}</p>
    <p className="mt-0.5 text-xs text-gray-500">{hint}</p>
    {list.length > 0 && <ul className="mt-2 flex flex-wrap gap-2" aria-label={label}>{list.map(group => {
      const notFound = data.missing.includes(group.id)
      return <li key={group.id} className={cn("inline-flex max-w-full flex-wrap items-center gap-x-2 rounded-full py-1 pl-3 pr-1 text-xs", notFound ? "bg-red-50 text-red-800" : "bg-gray-100 text-gray-800")}>
        <span className="truncate" title={group.id}>{groupName(data, group.id)}{notFound && " (not found in this tenant)"}</span>
        {!notFound && <GroupCountLabel counts={counts?.[group.id]} scope={scope} />}
        <button type="button" className="rounded-full p-1 hover:bg-white/70" aria-label={`Remove ${groupName(data, group.id)}`} onClick={() => onChange(list.filter(entry => entry.id !== group.id))}><X className="h-3 w-3" aria-hidden="true" /></button>
      </li>
    })}</ul>}
    {exclusionNotice && <p className="mt-1 text-xs text-amber-800">{exclusionNotice}</p>}
    {full && <p className="mt-1 text-xs text-gray-500">At most {MAX_GROUPS_PER_LIST} groups.</p>}
    <div className="sm:w-[28rem]">
      <GroupSearch directory={directory} label={label} scope={scope} disabled={full} unavailable={unavailable} onPick={group => {
        update(current => ({ ...current, names: { ...current.names, [group.id]: group.displayName }, missing: current.missing.filter(id => id !== group.id) }))
        onChange([...list, { id: group.id }])
      }} />
    </div>
  </div>
}

/** The tenant's assignment filters, read once per tenant. */
function useFilters(tenant: OibTenant, wanted: boolean) {
  const [state, setState] = useState<{ loading: boolean; filters: OibFilter[]; error: string }>({ loading: wanted, filters: [], error: "" })
  useEffect(() => {
    if (!wanted) return
    let live = true
    setState({ loading: true, filters: [], error: "" })
    oibRequest<{ filters: OibFilter[] }>({ action: "oib-filters", tenantId: tenant.tenantId, appId: tenant.appId })
      .then(r => live && setState({ loading: false, filters: r.filters, error: "" }), e => live && setState({ loading: false, filters: [], error: errorText(e, "The assignment filters could not be read.") }))
    return () => { live = false }
  }, [tenant.tenantId, wanted])
  return state
}

const scopeCount = (count: number, scope: string) => `${count} ${scope} ${count === 1 ? "policy" : "policies"}`

/** The assignment choices for one tenant. `targets` says which policies they apply to. */
export function AssignmentEditor({ state, targets, accessMissing, accessContext, onRecheck }: {
  state: AssignmentState
  targets: AssignmentTargets
  accessMissing: boolean
  accessContext: string
  onRecheck?: () => void
}) {
  useGroupLookup(state, targets, !accessMissing)
  const { data, tenant, update } = state
  const { spec } = data
  const setSpec = (change: (spec: OibAssignmentSpec) => OibAssignmentSpec) => update(d => ({ ...d, spec: change(d.spec) }))
  const unknown = unknownGroups(data, targets)
  const filters = useFilters(tenant, !accessMissing && targets.filterPlatforms.length > 0)
  const unmarkedTo = (choice: UnmarkedChoice) => choice === "both" ? "device and user groups" : choice === "device" ? "device groups" : choice === "user" ? "user groups" : "no groups"
  const hintFor = (scope: "device" | "user") => {
    const counts = [
      targets[scope] && scopeCount(targets[scope], scope),
      targets.unmarked && (spec.unmarked === "both" || spec.unmarked === scope) && scopeCount(targets.unmarked, "unmarked"),
    ].filter(Boolean)
    return `Assigned to the ${counts.join(" and ")}.`
  }
  const credentials = { tenantId: tenant.tenantId, appId: tenant.appId }
  const directory: GroupDirectory = {
    tenantKey: `${tenant.tenantId}:${tenant.appId}`,
    enabled: !accessMissing,
    search: query => oibRequest<GroupSearchResult>({ ...credentials, action: "oib-groups", query }),
    counts: ids => oibRequest<{ counts: Record<string, GroupCounts> }>({ ...credentials, action: "oib-group-counts", ids }),
    onRefused: () => update(d => ({ ...d, readable: false })),
  }
  const device = scopeUsed(targets, spec, "device")
  const user = scopeUsed(targets, spec, "user")
  const inclusions = [...spec.deviceGroups, ...spec.userGroups]
  const exclusions = [...spec.excludeDeviceGroups, ...spec.excludeUserGroups]
  return <>
    {accessMissing && <GroupAccessCard tenant={tenant} context={accessContext} onRecheck={() => {
      update(d => ({ ...d, readable: null, missing: [] }))
      onRecheck?.()
    }} />}
    <div hidden={accessMissing} className="space-y-5">
      <GroupPicker state={state} directory={directory} list={spec.deviceGroups} onChange={list => setSpec(s => ({ ...s, deviceGroups: list }))} blocked={exclusions} label="Device groups" hint={hintFor("device")} scope="device" used={device} />
      <GroupPicker state={state} directory={directory} list={spec.userGroups} onChange={list => setSpec(s => ({ ...s, userGroups: list }))} blocked={exclusions} label="User groups" hint={hintFor("user")} scope="user" used={user} />
      <GroupPicker state={state} directory={directory} list={spec.excludeDeviceGroups} onChange={list => setSpec(s => ({ ...s, excludeDeviceGroups: list }))} blocked={inclusions} label="Excluded device groups" hint="Excluded from the policies that get device groups. Intune only applies exclusions of the same kind as the include." scope="device" used={device}
        exclusionNotice={spec.excludeDeviceGroups.length && !spec.deviceGroups.length ? "Exclusions only apply together with device groups. On their own they change nothing." : undefined} />
      <GroupPicker state={state} directory={directory} list={spec.excludeUserGroups} onChange={list => setSpec(s => ({ ...s, excludeUserGroups: list }))} blocked={inclusions} label="Excluded user groups" hint="Excluded from the policies that get user groups. Intune only applies exclusions of the same kind as the include." scope="user" used={user}
        exclusionNotice={spec.excludeUserGroups.length && !spec.userGroups.length ? "Exclusions only apply together with user groups. On their own they change nothing." : undefined} />
      {targets.unmarked > 0 && <label className="block text-sm font-medium text-gray-800">Policies without a device or user marker ({targets.unmarked})
        <select value={spec.unmarked} onChange={e => setSpec(s => ({ ...s, unmarked: e.target.value as UnmarkedChoice }))} className="mt-2 block h-10 w-full rounded-full border border-gray-300 bg-white px-4 text-sm font-normal sm:w-[28rem]">
          {(["both", "device", "user", "none"] as const).map(choice => <option key={choice} value={choice}>Assign to {unmarkedTo(choice)}</option>)}
        </select>
        <span className="mt-1 block text-xs font-normal text-gray-500">OpenIntuneBaseline names these policies without D or U, so they are not known to be device or user policies.</span>
      </label>}
      {targets.filterPlatforms.length > 0 && <fieldset>
        <legend className="text-sm font-medium text-gray-800">Assignment filters (optional)</legend>
        <p className="mt-0.5 text-xs text-gray-500">Applied to each device and user group of the policies on that platform. Exclusions take no filter.{filters.error && <span className="ml-1 text-red-700">{filters.error}</span>}</p>
        <div className="mt-2 space-y-2">{targets.filterPlatforms.map(platform => {
          const choice = spec.filters[platform]
          const options = filters.filters.filter(f => f.platform === platform && f.managementType === filterManagementType(platform))
          const set = (next: OibAssignmentSpec["filters"][FilterPlatform]) => setSpec(s => ({ ...s, filters: { ...s.filters, [platform]: next } }))
          return <div key={platform} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-40 text-gray-700">{FILTER_PLATFORM_LABELS[platform]}</span>
            <select aria-label={`${FILTER_PLATFORM_LABELS[platform]} filter`} value={choice?.id ?? ""} disabled={filters.loading} onChange={e => set(e.target.value ? { id: e.target.value, mode: choice?.mode ?? "include", name: options.find(f => f.id === e.target.value)?.displayName } : undefined)} className="h-10 min-w-0 flex-1 rounded-full border border-gray-300 bg-white px-4 text-sm sm:max-w-xs">
              <option value="">{filters.loading ? "Loading filters…" : options.length ? "No filter" : "No filter (none for this platform)"}</option>
              {options.map(f => <option key={f.id} value={f.id}>{f.displayName}</option>)}
            </select>
            {choice && <select aria-label={`${FILTER_PLATFORM_LABELS[platform]} filter mode`} value={choice.mode} onChange={e => set({ ...choice, mode: e.target.value as "include" | "exclude" })} className="h-10 rounded-full border border-gray-300 bg-white px-4 text-sm">
              <option value="include">Include matching devices</option>
              <option value="exclude">Exclude matching devices</option>
            </select>}
            {choice && !!targets.unfiltered[platform] && <p className="w-full text-xs text-amber-800">{targets.unfiltered[platform] === 1 ? "1 selected policy is a Windows update profile, which takes" : `${targets.unfiltered[platform]} selected policies are Windows update profiles, which take`} no filter: {targets.unfiltered[platform] === 1 ? "it goes" : "they go"} to the whole group.</p>}
          </div>
        })}</div>
      </fieldset>}
      {unknown.length > 0 && <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{unknown.length === 1 ? "A group was" : `${unknown.length} groups were`} not found in {tenant.name}. Remove {unknown.length === 1 ? "it" : "them"} to continue.</p>}
    </div>
  </>
}

/** One line per scope saying where the policies go, for the review and confirmation. */
export function assignmentSummary(data: AssignmentData, targets: AssignmentTargets): string[] {
  const { spec } = data
  const names = (list: OibGroupRef[]) => groupNames(data, list).join(", ")
  const unmarkedGroups = spec.unmarked === "both" ? [...spec.deviceGroups, ...spec.userGroups] : spec.unmarked === "device" ? spec.deviceGroups : spec.unmarked === "user" ? spec.userGroups : []
  const line = (count: number, scope: string, list: OibGroupRef[]) => count ? `${scopeCount(count, scope)}: ${list.length ? names(list) : "unassigned"}` : ""
  const assigned = (targets.device && spec.deviceGroups.length) || (targets.user && spec.userGroups.length) || (targets.unmarked && unmarkedGroups.length)
  const filters = Object.entries(spec.filters).filter(([p, c]) => c && targets.filterPlatforms.includes(p as FilterPlatform)).map(([p, c]) => `${FILTER_PLATFORM_LABELS[p as FilterPlatform]} filter: ${c!.name ?? c!.id} (${c!.mode})`)
  return [
    line(targets.device, "device", spec.deviceGroups),
    line(targets.user, "user", spec.userGroups),
    line(targets.unmarked, "unmarked", [...new Map(unmarkedGroups.map(g => [g.id, g])).values()]),
    assigned && spec.deviceGroups.length && spec.excludeDeviceGroups.length ? `Excluded device groups: ${names(spec.excludeDeviceGroups)}` : "",
    assigned && spec.userGroups.length && spec.excludeUserGroups.length ? `Excluded user groups: ${names(spec.excludeUserGroups)}` : "",
    assigned && filters.length ? listFilters(filters) : "",
    ...(assigned ? unfilteredLines(spec, targets) : []),
  ].filter(Boolean)
}

const listFilters = (filters: string[]) => filters.join("; ")

/** Policies on a platform with a chosen filter whose type takes none: they get the whole group. */
function unfilteredLines(spec: OibAssignmentSpec, targets: AssignmentTargets): string[] {
  return Object.entries(targets.unfiltered).flatMap(([platform, count]) => spec.filters[platform as FilterPlatform] && count
    ? [`${count === 1 ? "1 policy takes" : `${count} policies take`} no filter (Windows update profiles), so ${count === 1 ? "it goes" : "they go"} to the whole group without the ${FILTER_PLATFORM_LABELS[platform as FilterPlatform]} filter`] : [])
}

/** Whether the choices can be sent: no unknown group and no lookup still running. */
export const assignmentReady = (data: AssignmentData, targets: AssignmentTargets) => !unknownGroups(data, targets).length && !data.checking
