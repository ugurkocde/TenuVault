import type { AppAssignmentCheck } from "../../shared/app-sources/types"
import { sourceTenant } from "../app-sources/store"
import { assignmentReader, AssignmentReadError } from "./assignment-graph"

const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const text = (value: unknown, max = 300) => typeof value === "string" ? value.slice(0, max) : ""
const id = (value: unknown) => typeof value === "string" && guid.test(value) ? value.toLowerCase() : null
export interface AssignmentObservation {
  id: string
  intent: string
  type: string
  groupId: string | null
  filterId: string | null
  filterMode: string
}
export interface AssignmentFacts {
  deviceKnown: boolean
  memberships: Map<string, string> | null
  groups: Map<string, { name: string; hidden: boolean }>
  filters: Map<string, { name: string; rule: string }>
  warnings: string[]
}
const explainIntent = (intent: string) => ({ required: "Required", available: "Available", availableWithoutEnrollment: "Available without enrollment", uninstall: "Uninstall" })[intent] ?? "Unknown intent"
const install = (intent: string) => intent === "required" || intent === "available"
const result = (appId: string, status: AppAssignmentCheck["status"], summary: string): AppAssignmentCheck => ({ appId, status, summary, checkedAt: new Date().toISOString(), steps: [], warnings: [], assignments: [] })

/** Assignment evidence is guidance, never proof of content-service authorization. */
export function evaluateAssignments(appId: string, rows: AssignmentObservation[], facts: AssignmentFacts): AppAssignmentCheck {
  const output = result(appId, "review", "Review this app's targeting before backup.")
  output.warnings.push(...facts.warnings)
  const states = rows.map(row => {
    const exclusion = row.type === "exclusionGroupAssignmentTarget"
    let matches: boolean | null = null, user = false
    let target = "Unrecognized assignment target", detail = "Review this target in Intune."
    if (row.type === "allDevicesAssignmentTarget") {
      target = "All devices"; matches = facts.deviceKnown ? true : null
      detail = facts.deviceKnown ? "Includes this enrolled PC." : "This PC's enrollment could not be confirmed."
    } else if (row.type === "allLicensedUsersAssignmentTarget") {
      target = "All users"; user = true; detail = "User targeting does not establish this PC's device assignment."
    } else if (["groupAssignmentTarget", "exclusionGroupAssignmentTarget"].includes(row.type) && row.groupId) {
      const group = facts.groups.get(row.groupId), memberName = facts.memberships?.get(row.groupId)
      target = group?.name || memberName || `Group ${row.groupId}`
      // Hidden or unreadable groups must not turn an absent membership into a definite negative.
      if (facts.deviceKnown && facts.memberships) matches = facts.memberships.has(row.groupId) ? true : group && !group.hidden ? false : null
      detail = matches === true ? exclusion ? "This PC belongs to this exclusion group." : "This PC belongs to this group (including nested membership)."
        : matches === false ? "Not in this PC's reported group memberships; user membership is not checked." : "This PC's membership could not be confirmed."
    }
    const filtered = Boolean(row.filterId) || row.filterMode !== "none"
    const filterInfo = row.filterId ? facts.filters.get(row.filterId) : null
    const filter = filtered ? { name: filterInfo?.name || (row.filterId ? `Filter ${row.filterId}` : "Unresolved filter"), mode: row.filterMode, rule: filterInfo?.rule || null } : null
    if (filter && matches !== false && !user) {
      detail += " Intune filter evaluation still needs review."
      output.steps.push(row.filterMode === "include" ? `Check include filter “${filter.name}”: this PC must match its rule.` : row.filterMode === "exclude" ? `Check exclude filter “${filter.name}”: this PC must not match its rule.` : `Review the unresolved filter on “${target}” in Intune.`)
    }
    output.assignments.push({ id: row.id, intent: explainIntent(row.intent), target, match: user ? "user" : matches === false ? "not-member" : matches === null || filtered ? "unknown" : exclusion ? "excluded" : "included", detail, filter })
    return { row, target, matches, user, exclusion, uncertain: matches === null || filtered }
  })
  if (!facts.deviceKnown) {
    output.status = "unavailable"; output.summary = "This PC's identity or enrollment could not be confirmed."
    output.steps.unshift("Check Windows enrollment in the selected tenant, then recheck assignments. Do not change targeting based on this incomplete check.")
    return output
  }
  const conflicts = states.filter(s => s.row.intent === "uninstall" && (s.user || s.matches !== false))
  const candidates = states.filter(s => install(s.row.intent) && !s.exclusion && !s.user && s.matches === true && !s.uncertain)
  const effective = candidates.filter(s => !states.some(other => other.row.intent === s.row.intent && other.exclusion && other.matches !== false))
  const excluded = states.filter(s => install(s.row.intent) && s.exclusion && s.matches === true && !s.uncertain)
  const unknown = states.some(s => !s.user && s.matches !== false && (s.uncertain || !["required", "available", "uninstall"].includes(s.row.intent)))
  if (effective.length && !conflicts.length && !unknown) {
    output.status = "device-targeted"; output.summary = "A device assignment includes this PC."
    output.steps.unshift("No device-targeting change is indicated by this check. Start backup; Intune still decides whether installer content is available.")
  } else if (excluded.length) {
    output.summary = "This PC matches an app exclusion."
    for (const s of excluded) output.steps.unshift(`Review the ${explainIntent(s.row.intent)} exclusion for “${s.target}”. If this PC should receive the app, adjust its exclusion scope. Another include assignment of the same intent will not override it.`)
  } else if (!rows.length) {
    output.summary = "No assignments were found for this app."
    output.steps.unshift("In Intune, assign the app as Required to a dedicated device group containing this PC.")
  } else if (states.every(s => s.user)) {
    output.summary = "Only user targeting was found."
    output.steps.unshift("This check cannot confirm device access from user assignments. To target this PC explicitly, add a Required assignment to a dedicated device group containing it. Existing user assignments can remain.")
  } else if (!candidates.length && !unknown && !conflicts.length) {
    output.summary = "No device assignment was found for this PC."
    output.steps.unshift("Add this PC to the intended assigned device group, or assign the app as Required to a dedicated device group containing this PC.")
  }
  if (conflicts.length) {
    output.summary = "Review the app's install and uninstall targeting."
    for (const s of conflicts) output.steps.unshift(`Review the Uninstall assignment to “${s.target}” and any competing install intent before changing targeting.`)
  }
  if (output.status !== "device-targeted") output.steps.push("After any intended targeting change, sync this PC with Intune, allow membership changes to propagate, then select Recheck assignments.")
  if (states.some(s => s.user)) output.warnings.push("User assignments are shown, but the signed-in administrator is not assumed to be this PC's assigned user.")
  if (states.some(s => s.row.filterId || s.row.filterMode !== "none")) output.warnings.push("Filter rules are shown for review. TenuVault does not reproduce Intune's filter evaluation.")
  output.steps = [...new Set(output.steps)]
  output.warnings = [...new Set(output.warnings)]
  return output
}

function parseRows(raw: Record<string, unknown>[]): AssignmentObservation[] {
  const seen = new Set<string>()
  return raw.map(row => {
    const key = text(row.id, 256), intent = text(row.intent, 50), target = row.target
    if (!key || seen.has(key) || !intent || !target || typeof target !== "object" || Array.isArray(target)) throw new AssignmentReadError(null)
    seen.add(key)
    const t = target as Record<string, unknown>
    const type = text(t["@odata.type"]), filterId = id(t.deviceAndAppManagementAssignmentFilterId)
    return { id: key, intent, type: type.startsWith("#microsoft.graph.") ? type.slice(17) : "unknown", groupId: id(t.groupId), filterId, filterMode: t.deviceAndAppManagementAssignmentFilterId && !filterId ? "unknown" : text(t.deviceAndAppManagementAssignmentFilterType, 50) || (filterId ? "unknown" : "none") }
  })
}

async function inBatches<T>(values: string[], action: (value: string) => Promise<T>): Promise<void> {
  for (let start = 0; start < values.length; start += 4) await Promise.all(values.slice(start, start + 4).map(action))
}

export async function checkAppAssignments(tenant: string, app: string, tokenForTenant: (tenant: string) => Promise<string>, options: { platform?: string; device: () => Promise<string>; fetch?: typeof fetch }): Promise<AppAssignmentCheck> {
  const tenantId = sourceTenant(tenant), appId = sourceTenant(app)
  if ((options.platform ?? process.platform) !== "win32") return result(appId, "unsupported", "Check assignments on the enrolled Windows PC that will capture the installer.")
  try {
    const token = await tokenForTenant(tenantId)
    if (!token) throw new AssignmentReadError(401)
    const graph = assignmentReader(token, options.fetch)
    const [raw, device] = await Promise.all([
      graph.list(`/beta/deviceAppManagement/mobileApps/${appId}/assignments?$select=id,intent,target`, 500),
      options.device().then(value => sourceTenant(value)).catch(() => null),
    ])
    const rows = parseRows(raw), facts: AssignmentFacts = { deviceKnown: device !== null, memberships: null, groups: new Map(), filters: new Map(), warnings: [] }
    const groupIds = [...new Set(rows.flatMap(row => row.groupId ? [row.groupId] : []))]
    const filterIds = [...new Set(rows.flatMap(row => row.filterId ? [row.filterId] : []))]
    await Promise.all([
      (async () => {
        if (!device || !groupIds.length) return
        try {
          const memberships = await graph.list(`/beta/devices(deviceId='${device}')/transitiveMemberOf?$select=id,displayName&$top=100`, 10000)
          const groups = new Map<string, string>()
          for (const group of memberships) {
            if (!id(group.id) || typeof group["@odata.type"] !== "string") throw new AssignmentReadError(null)
            if (group["@odata.type"] === "#microsoft.graph.group") groups.set(id(group.id)!, text(group.displayName))
          }
          facts.memberships = groups
        } catch (error) {
          facts.warnings.push(error instanceof AssignmentReadError && error.status === 403 ? "Microsoft denied device-group membership reads. Check delegated Device.Read.All on the existing app registration and the administrator's role. Grant consent if needed, reconnect Microsoft, then recheck." : "Device-group membership could not be read completely. Missing results are not treated as non-membership.")
        }
      })(),
      inBatches(groupIds.slice(0, 50), async groupId => {
        try {
          const group = await graph.get(`/beta/groups/${groupId}?$select=id,displayName,visibility`)
          if (id(group.id) === groupId && text(group.displayName) && Object.hasOwn(group, "visibility")) facts.groups.set(groupId, { name: text(group.displayName), hidden: group.visibility === "HiddenMembership" })
        } catch { /* Membership IDs may still establish a positive match. */ }
      }),
      inBatches(filterIds.slice(0, 50), async filterId => {
        try {
          const filter = await graph.get(`/beta/deviceManagement/assignmentFilters/${filterId}?$select=id,displayName,rule`)
          if (id(filter.id) === filterId) facts.filters.set(filterId, { name: text(filter.displayName), rule: text(filter.rule, 4096) })
        } catch { /* The unresolved filter remains an explicit review item. */ }
      }),
    ])
    if (groupIds.some(value => !facts.groups.has(value) && !facts.memberships?.get(value))) facts.warnings.push("Some group names or visibility settings could not be read. IDs are shown instead; group metadata requires delegated GroupMember.Read.All (or an existing broader group-read permission).")
    if (filterIds.some(value => !facts.filters.has(value))) facts.warnings.push("Some filter details could not be read. Review them in Intune; filter reads require DeviceManagementConfiguration.Read.All or its read/write equivalent.")
    return evaluateAssignments(appId, rows, facts)
  } catch (error) {
    const output = result(appId, "unavailable", error instanceof AssignmentReadError ? error.message : "The assignment check could not be completed. Reconnect Microsoft or retry.")
    output.steps.push("Review assignments in Intune or retry this check. An incomplete check does not mean the app is unassigned.")
    return output
  }
}
