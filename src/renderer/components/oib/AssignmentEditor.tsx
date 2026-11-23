import { useEffect, useId, useRef, useState } from "react"
import { Plus, X } from "lucide-react"
import { cn } from "~/lib/utils"
import { emptySpec, FILTER_PLATFORM_LABELS, filterManagementType, filterPlatformFor, MAX_GROUPS_PER_LIST, platformFilterPlatform, specGroupIds, type FilterPlatform, type OibAssignmentSpec, type OibGroupRef, type OibScope, type UnmarkedChoice } from "../../../shared/oib/assignments"
import type { OibPlatform } from "../../../shared/oib/types"
import { errorText, GUID, oibRequest, type OibTenant } from "./common"

/**
 * Device groups, user groups, excluded groups and assignment filters for OIB policies. OIB marks
 * each policy as device or user targeted; device groups go to device policies, user groups to
 * user policies. Groups are searched by name when the app may read groups, otherwise their object
 * IDs are pasted. The main process checks every group and filter again before it changes anything.
 */

interface OibGroup { id: string; displayName: string; kind: "security" | "microsoft365" | "other"; dynamic: boolean }
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
export const unknownGroups = (data: AssignmentData) => specGroupIds(data.spec).filter(id => data.missing.includes(id))

/** Reads the names of chosen groups that have none yet; IDs the tenant does not have become `missing`. */
function useGroupNames({ tenant, data, update }: AssignmentState) {
  const pending = specGroupIds(data.spec).filter(id => !(id in data.names) && !data.missing.includes(id))
  const key = pending.join(",")
  useEffect(() => {
    if (!pending.length || data.readable === false) return
    let live = true
    update(d => ({ ...d, checking: true }))
    oibRequest<{ readable: boolean; groups: OibGroup[]; missing: string[] }>({ action: "oib-group-lookup", tenantId: tenant.tenantId, appId: tenant.appId, ids: pending })
      .then(result => {
        if (!live) return
        update(d => result.readable
          ? { ...d, readable: true, checking: false, names: { ...d.names, ...Object.fromEntries(result.groups.map(g => [g.id, g.displayName])) }, missing: [...new Set([...d.missing, ...result.missing])] }
          : { ...d, readable: false, checking: false })
      })
      // The main process checks the groups again before it changes anything.
      .catch(() => { if (live) update(d => ({ ...d, checking: false })) })
    return () => { live = false; update(d => ({ ...d, checking: false })) }
  }, [tenant.tenantId, key, data.readable])
}

/** The spec as the main process takes it: names read from the tenant, and only filters the policies take. */
export function specFor(data: AssignmentData, targets: AssignmentTargets): OibAssignmentSpec {
  const named = (list: OibGroupRef[]) => list.map(g => ({ id: g.id, ...(data.names[g.id] ? { name: data.names[g.id] } : {}) }))
  const filters = Object.fromEntries(Object.entries(data.spec.filters).filter(([platform, choice]) => choice && targets.filterPlatforms.includes(platform as FilterPlatform)))
  return { ...data.spec, deviceGroups: named(data.spec.deviceGroups), userGroups: named(data.spec.userGroups), excludeDeviceGroups: named(data.spec.excludeDeviceGroups), excludeUserGroups: named(data.spec.excludeUserGroups), filters }
}

const groupName = (data: AssignmentData, id: string) => data.names[id] ?? id
export const groupNames = (data: AssignmentData, list: OibGroupRef[]) => list.map(g => groupName(data, g.id))

const KIND_LABEL: Record<OibGroup["kind"], string> = { security: "Security", microsoft365: "Microsoft 365", other: "Distribution" }

/** Group search and object ID entry for one list. */
function GroupPicker({ state, list, onChange, label, hint }: { state: AssignmentState; list: OibGroupRef[]; onChange: (list: OibGroupRef[]) => void; label: string; hint: string }) {
  const { data, tenant, update } = state
  const id = useId()
  const [text, setText] = useState("")
  const [results, setResults] = useState<OibGroup[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const query = text.trim()
  const pasted = GUID.test(query)
  const taken = new Set(specGroupIds(data.spec))
  const unknown = unknownGroups(data)
  const full = list.length >= MAX_GROUPS_PER_LIST

  useEffect(() => {
    setError("")
    // Results of the previous query never answer this one, not even to Enter.
    setResults([])
    if (query.length < 2 || pasted || data.readable === false) { setSearching(false); return }
    let live = true
    setSearching(true)
    const timer = setTimeout(() => {
      oibRequest<{ readable: boolean; groups: OibGroup[] }>({ action: "oib-groups", tenantId: tenant.tenantId, appId: tenant.appId, query })
        .then(result => {
          if (!live) return
          update(d => d.readable === result.readable ? d : { ...d, readable: result.readable })
          setResults(result.readable ? result.groups : [])
        })
        .catch(e => { if (live) setError(errorText(e)) })
        .finally(() => { if (live) setSearching(false) })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [query, data.readable, tenant.tenantId])

  const add = (group: { id: string; displayName?: string }) => {
    const groupId = group.id.toLowerCase()
    if (taken.has(groupId) || full) return
    if (group.displayName) update(d => ({ ...d, names: { ...d.names, [groupId]: group.displayName! } }))
    onChange([...list, { id: groupId }])
    setText(""); setResults([])
    input.current?.focus()
  }

  return <div>
    <label htmlFor={id} className="text-sm font-medium text-gray-800">{label}</label>
    <p className="mt-0.5 text-xs text-gray-500">{hint}</p>
    {list.length > 0 && <ul className="mt-2 flex flex-wrap gap-2" aria-label={label}>{list.map(g => {
      const notFound = unknown.includes(g.id)
      return <li key={g.id} className={cn("inline-flex max-w-full items-center gap-1 rounded-full py-1 pl-3 pr-1 text-xs", notFound ? "bg-red-50 text-red-800" : "bg-gray-100 text-gray-800")}>
        <span className="truncate" title={g.id}>{groupName(data, g.id)}{notFound && " (not found in this tenant)"}</span>
        <button type="button" className="rounded-full p-1 hover:bg-white/70" aria-label={`Remove ${groupName(data, g.id)}`} onClick={() => onChange(list.filter(x => x.id !== g.id))}><X className="h-3 w-3" aria-hidden="true" /></button>
      </li>
    })}</ul>}
    <div className="relative mt-2 sm:w-[28rem]">
      <div className="flex gap-2">
        <input ref={input} id={id} value={text} disabled={full} onChange={e => setText(e.target.value)} autoComplete="off"
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (pasted) add({ id: query }); else if (results.length === 1) add(results[0]!) } }}
          placeholder={data.readable === false ? "Group object ID" : "Search by name or paste an object ID"}
          className="h-10 min-w-0 flex-1 rounded-full border border-gray-300 px-4 text-sm" aria-describedby={`${id}-status`} />
        {pasted && <button type="button" className="inline-flex h-10 items-center gap-1 rounded-full border border-gray-200 px-4 text-sm" disabled={taken.has(query.toLowerCase())} onClick={() => add({ id: query })}><Plus className="h-4 w-4" aria-hidden="true" />Add</button>}
      </div>
      <p id={`${id}-status`} role="status" className="mt-1 text-xs text-gray-500">
        {full ? `At most ${MAX_GROUPS_PER_LIST} groups.` : pasted && taken.has(query.toLowerCase()) ? "This group is already chosen." : searching ? "Searching…" : error ? <span className="text-red-700">{error}</span> : query.length >= 2 && !pasted && data.readable !== false && !results.length ? "No group name starts with this." : ""}
      </p>
      {results.length > 0 && <ul className="mt-1 max-h-56 overflow-auto rounded-2xl border border-gray-200 bg-white p-1 shadow-sm" aria-label={`Groups matching ${query}`}>{results.map(group => {
        const disabled = taken.has(group.id) || group.kind === "other"
        return <li key={group.id}><button type="button" disabled={disabled} onClick={() => add(group)} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">
          <span className="min-w-0 truncate">{group.displayName}<span className="ml-2 font-mono text-xs text-gray-400" title={group.id}>{group.id.slice(0, 8)}</span></span>
          <span className="shrink-0 text-xs text-gray-500">{group.kind === "other" ? "Cannot be assigned" : taken.has(group.id) ? "Chosen" : `${KIND_LABEL[group.kind]}${group.dynamic ? ", dynamic" : ""}`}</span>
        </button></li>
      })}</ul>}
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
export function AssignmentEditor({ state, targets }: { state: AssignmentState; targets: AssignmentTargets }) {
  useGroupNames(state)
  const { data, tenant, update } = state
  const { spec } = data
  const setSpec = (change: (spec: OibAssignmentSpec) => OibAssignmentSpec) => update(d => ({ ...d, spec: change(d.spec) }))
  const unknown = unknownGroups(data)
  const filters = useFilters(tenant, targets.filterPlatforms.length > 0)
  const unmarkedTo = (choice: UnmarkedChoice) => choice === "both" ? "device and user groups" : choice === "device" ? "device groups" : choice === "user" ? "user groups" : "no groups"
  const deviceHint = [targets.device && `Assigned to the ${scopeCount(targets.device, "device")}`, targets.unmarked && (spec.unmarked === "both" || spec.unmarked === "device") && `and the ${scopeCount(targets.unmarked, "unmarked")}`].filter(Boolean).join(" ") || "No device policy is selected."
  const userHint = [targets.user && `Assigned to the ${scopeCount(targets.user, "user")}`, targets.unmarked && (spec.unmarked === "both" || spec.unmarked === "user") && `and the ${scopeCount(targets.unmarked, "unmarked")}`].filter(Boolean).join(" ") || "No user policy is selected."
  return <div className="space-y-5">
    {data.readable === false && <p role="note" className="rounded-2xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950">This app registration may not read groups, so groups cannot be searched by name. Paste each group's object ID from Entra. To search by name, add the Group.Read.All permission (the setup script's -IncludeGroupRead switch) and sign in again.</p>}
    <GroupPicker state={state} list={spec.deviceGroups} onChange={list => setSpec(s => ({ ...s, deviceGroups: list }))} label="Device groups" hint={`${deviceHint}.`} />
    <GroupPicker state={state} list={spec.userGroups} onChange={list => setSpec(s => ({ ...s, userGroups: list }))} label="User groups" hint={`${userHint}.`} />
    <GroupPicker state={state} list={spec.excludeDeviceGroups} onChange={list => setSpec(s => ({ ...s, excludeDeviceGroups: list }))} label="Excluded device groups" hint="Excluded from the policies that get device groups. Intune only applies an exclusion of the same kind as the include, so exclude devices here." />
    <GroupPicker state={state} list={spec.excludeUserGroups} onChange={list => setSpec(s => ({ ...s, excludeUserGroups: list }))} label="Excluded user groups" hint="Excluded from the policies that get user groups. Excluding a user group from a device policy has no effect in Intune, so exclude users here." />
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
export const assignmentReady = (data: AssignmentData) => !unknownGroups(data).length && !data.checking
