import type { Item } from "../../shared/intune/registry"
import type { GraphReader } from "../../shared/intune/read"
import { isGuid } from "../../shared/security"
import { guardRestoreItem, RestoreSafetyError, type RestoreActor } from "../../shared/intune/restore-guards"
import { cloudObject, NEVER_RESTORED, type DirectoryReview } from "./directory-9a"

export const PRIVILEGED_RESTORE_BLOCKER = "This relationship is available for review. A live restore and cleanup round trip is required before execution."
const roles = "roleManagement/directory"
const pimGroups = "identityGovernance/privilegedAccess/group"
export const administrativeUnits = "directory/administrativeUnits"
const scheduleCollections: Record<string, string> = {
  RoleEligibilitySchedules: roles + "/roleEligibilitySchedules",
  RoleAssignmentSchedules: roles + "/roleAssignmentSchedules",
  PimGroupEligibilitySchedules: pimGroups + "/eligibilitySchedules",
  PimGroupAssignmentSchedules: pimGroups + "/assignmentSchedules",
}
export const roleAssignments = roles + "/roleAssignments"
export const roleDefinitions = roles + "/roleDefinitions"

const fail = (message: string): never => { throw new RestoreSafetyError(message) }
export function requirePrivilegeId(value: unknown): string {
  if (!isGuid(value)) return fail("A saved relationship has an invalid or missing object ID.")
  return value.toLowerCase()
}
const object = (value: unknown): Item | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Item : undefined
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN
const collectionFilter = (path: string, field: "principalId" | "groupId", id: string) => path + "?$filter=" + encodeURIComponent(`${field} eq '${requirePrivilegeId(id)}'`)

function schedule(source: Item, eligibility: boolean, now: number): Item {
  if (String(source.assignmentType).toLowerCase() === "activated") fail(NEVER_RESTORED["Activated PIM instances"])
  if (!eligibility && String(source.assignmentType).toLowerCase() !== "assigned") fail("The backup cannot prove this was an administrator-assigned schedule.")
  if (String(source.memberType).toLowerCase() !== "direct") fail("Inherited or unresolved schedule memberships are blocked.")
  const info = object(source.scheduleInfo), expiration = object(info?.expiration), start = date(info?.startDateTime)
  if (!Number.isFinite(start) || info?.recurrence != null) fail("The original schedule start or recurrence could not be restored safely.")
  const startDateTime = new Date(Math.max(now, start)).toISOString()
  if (expiration?.type === "noExpiration" && expiration.endDateTime == null && expiration.duration == null && eligibility) return { startDateTime, expiration: { type: "noExpiration" } }
  const end = date(expiration?.endDateTime)
  if (expiration?.type !== "afterDateTime" || !Number.isFinite(end) || end <= start) fail("The backup has no verified absolute schedule end time.")
  if (end <= now) fail("This schedule has expired. Restoring it would extend access.")
  return { startDateTime, expiration: { type: "afterDateTime", endDateTime: expiration!.endDateTime! } }
}

// Build only documented request properties. These candidates never reach product write transport.
export function privilegeRequest(folder: string, source: Item, principalId: string, target: { roleId?: string; directoryScopeId?: string; groupId?: string; unitId?: string }, now: number, removeMember = false): { method: "POST" | "DELETE"; path: string; body?: Item } {
  principalId = requirePrivilegeId(principalId)
  if (folder === "AdministrativeUnits") {
    const path = `${administrativeUnits}/${requirePrivilegeId(target.unitId)}`
    if (target.roleId) return { method: "POST", path: path + "/scopedRoleMembers", body: { roleId: requirePrivilegeId(target.roleId), roleMemberInfo: { id: principalId } } }
    if (removeMember) return { method: "DELETE", path: `${path}/members/${principalId}/$ref` }
    return { method: "POST", path: path + "/members/$ref", body: { "@odata.id": `https://graph.microsoft.com/beta/directoryObjects/${principalId}` } }
  }
  const group = folder.startsWith("PimGroup")
  const collection = scheduleCollections[folder]
  if (!collection && folder !== "EntraRoleAssignments") return fail("Unsupported privileged relationship.")
  const scope = target.directoryScopeId === "/" ? "/" : target.directoryScopeId?.startsWith("/administrativeUnits/") ? `/administrativeUnits/${requirePrivilegeId(target.directoryScopeId.slice(21))}` : undefined
  if (!group && (!scope || source.appScopeId != null && source.appScopeId !== "")) return fail("This role assignment scope cannot be verified.")
  const accessId = source.accessId
  if (group && accessId !== "owner" && accessId !== "member") return fail("The saved group privilege could not be resolved.")
  const body: Item = group ? { principalId, groupId: requirePrivilegeId(target.groupId), accessId: accessId! } : { principalId, roleDefinitionId: requirePrivilegeId(target.roleId), directoryScopeId: scope! }
  if (!collection) return { method: "POST", path: roleAssignments, body }
  const eligibility = folder.includes("Eligibility")
  return { method: "POST", path: collection.replace(/Schedules$/, "ScheduleRequests"), body: { ...body, action: "adminAssign", scheduleInfo: schedule(source, eligibility, now) } }
}

export async function privilegeObject(reader: GraphReader, collection: string, id: string, unresolved: string): Promise<Item> {
  const result = await reader.get(`${collection}/${requirePrivilegeId(id)}`)
  if (!isGuid(result.id) || result.id.toLowerCase() !== id || typeof result.displayName !== "string" || !result.displayName.trim()) return fail(unresolved)
  return result
}

export function unitChangeBlocker(unit: Item): string | undefined {
  if (unit.isMemberManagementRestricted === true) return "This is a restricted management administrative unit. Its membership and scoped roles are blocked in directory restore."
  if (unit.isMemberManagementRestricted !== false && unit.isMemberManagementRestricted !== null) return "The administrative unit's restriction status could not be verified."
  if (unit.membershipType === "Dynamic" || unit.membershipRule) return "Dynamic administrative unit membership follows its rule."
  if (unit.membershipType !== "Assigned" && unit.membershipType !== null) return "The administrative unit's membership type could not be verified."
}

export interface PrivilegeCandidate {
  source: Item
  principalId?: string
  present?: boolean
  unit?: Item
  removeMember?: boolean
  blocker?: string
}

export async function privilegeReview(folder: string, candidate: PrivilegeCandidate, reader: GraphReader, actor: RestoreActor, map: (folder: string, id: string) => string, now: number): Promise<DirectoryReview> {
  const { source, unit, removeMember } = candidate
  const group = folder.startsWith("PimGroup"), scopedMember = !!unit && source.roleId !== undefined
  const roleSourceId = scopedMember ? source.roleId : source.roleDefinitionId
  const groupEligibility = folder === "PimGroupEligibilitySchedules"
  const approvals = ["directory-item", "privileged-relationship"]
  if (removeMember) approvals.push("exact-unit")
  const review: DirectoryReview = {
    principal: null, resource: { id: "", name: "Unresolved resource", type: "directory" },
    privilege: group ? `${groupEligibility ? "Eligible" : "Active"} group ${source.accessId === "owner" ? "owner" : "member"}`
      : unit ? scopedMember ? "Scoped role member" : removeMember ? "Remove unit member" : "Add unit member"
      : folder === "RoleEligibilitySchedules" ? "Role eligibility" : folder === "RoleAssignmentSchedules" ? "Active role schedule" : "Role assignment",
    scope: "Unresolved scope", approvals, notices: [], roleAssignable: false, changes: [],
  }
  const savedSchedule = object(source.scheduleInfo), end = object(savedSchedule?.expiration)
  if (savedSchedule) review.changes.push({ property: "Schedule", before: null, after: {
    start: Number.isFinite(date(savedSchedule.startDateTime)) ? savedSchedule.startDateTime : null,
    end: end?.type === "noExpiration" ? "No expiration" : Number.isFinite(date(end?.endDateTime)) ? end?.endDateTime : null,
  } })
  const rawPrincipal = requirePrivilegeId(candidate.principalId ?? source.principalId)
  const user = removeMember ? rawPrincipal : map("Users", rawPrincipal), mappedGroup = removeMember ? rawPrincipal : map("Groups", rawPrincipal)
  if (user !== rawPrincipal && mappedGroup !== rawPrincipal) return fail("The principal mapping is ambiguous.")
  const principalId = user !== rawPrincipal ? user : mappedGroup
  const principal = await privilegeObject(reader, "directoryObjects", principalId, "The principal no longer resolves to a current name and type.")
  const type = typeof principal["@odata.type"] === "string" ? principal["@odata.type"].replace(/^#microsoft\.graph\./, "") : ""
  if (!["user", "group", "servicePrincipal", "device"].includes(type) || user !== rawPrincipal && type !== "user" || mappedGroup !== rawPrincipal && type !== "group") return fail("The principal's current type could not be verified.")
  review.principal = { id: principalId, name: String(principal.displayName), type }
  let blocker = candidate.blocker
  const protectedReferences = { complete: true, principals: [principalId], applications: type === "servicePrincipal" && isGuid(principal.appId) ? [principal.appId] : [] }
  try { guardRestoreItem(actor, folder, undefined, protectedReferences, false); cloudObject(principal) }
  catch (error) { blocker = (error as RestoreSafetyError).message }
  if (type !== "user") blocker ??= "This principal type is blocked because all indirect beneficiaries could not be verified."
  const roleId = roleSourceId === undefined ? undefined : map("EntraRoleDefinitions", requirePrivilegeId(roleSourceId))
  const role = roleId ? await privilegeObject(reader, roleDefinitions, roleId, "The saved role no longer resolves.") : undefined
  if (role && role.isEnabled !== true) blocker ??= "The live role definition is disabled or its state could not be verified."
  let directoryScopeId = source.directoryScopeId === "/" ? "/" : undefined
  let groupId: string | undefined
  if (group) {
    groupId = map("Groups", requirePrivilegeId(source.groupId))
    const resource = await privilegeObject(reader, "groups", groupId, "The saved PIM group no longer resolves.")
    review.resource = { id: groupId, name: String(resource.displayName), type: "group" }
    review.scope = `Group ${resource.displayName} (${groupId})`
    review.roleAssignable = resource.isAssignableToRole === true
    if (!Array.isArray(resource.groupTypes) || resource.groupTypes.includes("DynamicMembership") || resource.onPremisesSyncEnabled != null) blocker ??= "Dynamic, synchronized or unresolved PIM groups are blocked."
  } else if (unit) {
    review.resource = { id: String(unit.id), name: String(unit.displayName), type: "administrative unit" }
    review.scope = `Administrative unit ${unit.displayName} (${unit.id})`
    if (role) review.privilege = `Scoped role member: ${role.displayName}`
    blocker ??= unitChangeBlocker(unit)
    if (removeMember && !blocker) {
      try { guardRestoreItem(actor, folder, undefined, protectedReferences, true) }
      catch (error) { blocker = (error as RestoreSafetyError).message }
    }
  } else {
    if (!role || !roleId) return fail("The saved role no longer resolves.")
    review.resource = { id: roleId, name: String(role.displayName), type: "directory role" }
    if (source.appScopeId != null && source.appScopeId !== "") blocker ??= "Application-scoped roles remain blocked."
    else if (directoryScopeId === "/") review.scope = "Entire tenant"
    else if (typeof source.directoryScopeId === "string" && source.directoryScopeId.startsWith("/administrativeUnits/")) {
      const unitId = map("AdministrativeUnits", requirePrivilegeId(source.directoryScopeId.slice(21)))
      const scope = await privilegeObject(reader, administrativeUnits, unitId, "The saved administrative unit scope no longer resolves.")
      directoryScopeId = `/administrativeUnits/${unitId}`
      review.scope = `Administrative unit ${scope.displayName} (${unitId})`
      blocker ??= unitChangeBlocker(scope)
    } else blocker ??= "The saved role scope no longer resolves."
  }
  if (!blocker) {
    try { privilegeRequest(folder, source, principalId, { roleId, directoryScopeId, groupId, unitId: unit ? String(unit.id) : undefined }, now, removeMember) }
    catch (error) { blocker = (error as RestoreSafetyError).message }
  }
  let present = candidate.present
  if (present === undefined && !blocker) {
    const collection = scheduleCollections[folder] ?? roleAssignments
    const current = await reader.list(collectionFilter(collection, group ? "groupId" : "principalId", groupId ?? principalId))
    present = current.some(row => String(row.principalId).toLowerCase() === principalId && (group
      ? String(row.groupId).toLowerCase() === groupId && row.accessId === source.accessId
      : String(row.roleDefinitionId).toLowerCase() === roleId && row.directoryScopeId === directoryScopeId && !row.appScopeId))
  }
  if (present === false && !removeMember) {
    approvals.push("security-response")
    review.notices.push("The current state looks deliberate. Restoring removed access may undo a security response.")
  }
  if (present !== undefined) review.changes.push({ property: "Relationship", before: present ? "Present" : "Absent", after: removeMember ? "Absent" : "Present" })
  if (present && !removeMember) blocker ??= "A current relationship occupies this scope. Its access or schedule will not be changed."
  if (folder === "EntraRoleAssignments") blocker ??= "The saved role link could have come from a time-bound assignment or activation. Its permanent assignment provenance is unavailable."
  return { ...review, blocker: blocker ?? PRIVILEGED_RESTORE_BLOCKER }
}

/** Legacy unit backups stored only scoped membership IDs. An absent ID cannot identify the grant. */
export async function* unitRelationships(snapshot: Item, reader: GraphReader, path: string, exact: boolean, map: (folder: string, id: string) => string): AsyncGenerator<PrivilegeCandidate> {
  const savedMembers = snapshot.members, savedRoles = snapshot.scopedRoleMembers
  if (!Array.isArray(savedMembers) || !savedMembers.every(isGuid)) {
    yield { source: {}, blocker: "The backup does not contain a complete administrative unit member inventory." }
  } else if (savedMembers.length || exact) {
    const live = await reader.list(path + "/members?$select=id")
    const current = new Set(live.map(row => requirePrivilegeId(row.id)))
    const expected = new Set<string>()
    let complete = true
    for (const saved of new Set(savedMembers.map(requirePrivilegeId))) {
      const user = map("Users", saved), group = map("Groups", saved)
      if (user !== saved && group !== saved) {
        complete = false
        yield { source: {}, blocker: "A saved member has an ambiguous principal mapping. Exact removal requires a complete inventory." }
        continue
      }
      const target = user !== saved ? user : group
      expected.add(target)
      if (!current.has(target)) yield { source: {}, principalId: saved, present: false }
    }
    if (exact && complete) for (const id of current) if (!expected.has(id)) yield { source: {}, principalId: id, present: true, removeMember: true }
  }
  if (!Array.isArray(savedRoles)) {
    yield { source: {}, blocker: "The backup does not contain a complete scoped role inventory." }
  } else if (savedRoles.length) {
    const live = await reader.list(path + "/scopedRoleMembers")
    const byId = new Map(live.map(row => [row.id, row]))
    const pairs = new Set(live.map(row => [row.roleId, object(row.roleMemberInfo)?.id].map(value => String(value).toLowerCase()).join("/")))
    for (const saved of savedRoles) {
      const link = object(saved) ?? byId.get(saved)
      const principalId = object(link?.roleMemberInfo)?.id
      if (!link || !isGuid(principalId) || !isGuid(link.roleId)) {
        yield { source: {}, blocker: "This saved scoped role membership lacks the principal or role ID. Capture a new backup with scoped role details." }
        continue
      }
      const mappedRole = map("EntraRoleDefinitions", link.roleId.toLowerCase())
      const principal = principalId.toLowerCase()
      const user = map("Users", principal), group = map("Groups", principal)
      const present = pairs.has(`${mappedRole}/${user !== principal ? user : group}`)
      yield { source: { roleId: link.roleId }, principalId, present }
    }
  }
}
