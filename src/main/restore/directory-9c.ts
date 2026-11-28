import type { Item } from "../../shared/intune/registry"
import type { safetyReader } from "./safety-reader"
import type { GraphReader } from "../../shared/intune/read"
import { isGuid } from "../../shared/security"
import { guardRestoreItem, RestoreSafetyError, RestoreWriteDeferredError, type RestoreActor } from "../../shared/intune/restore-guards"
import { PRIVILEGED_RESTORE_BLOCKER } from "../../shared/intune/directory-review-folders"
import { isRestorePersistenceError } from "./guarded-run"
import { cloudObject, NEVER_RESTORED, type DirectoryReview } from "./directory-9a"

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

function reviewSchedule(value: unknown) {
  const info = object(value), expiration = object(info?.expiration)
  const start = Number.isFinite(date(info?.startDateTime)) ? info?.startDateTime : null
  const end = expiration?.type === "noExpiration" ? "No expiration" : Number.isFinite(date(expiration?.endDateTime)) ? expiration?.endDateTime : null
  return start || end ? { start, end } : null
}

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
  return { method: "POST", path: collection.replace(/Schedules$/, "ScheduleRequests"), body: {
    ...body, action: "adminAssign", justification: "Restore a privileged access schedule with TenuVault.", scheduleInfo: schedule(source, eligibility, now),
  } }
}

export async function privilegeObject(reader: GraphReader, collection: string, id: string, unresolved: string): Promise<Item> {
  return requirePrivilegeObject(await reader.get(`${collection}/${requirePrivilegeId(id)}`), id, unresolved)
}

export function requirePrivilegeObject(result: Item, id: string, unresolved: string): Item {
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
  memberType?: string
  present?: boolean
  unitId?: string
  unit?: Item
  removeMember?: boolean
  blocker?: string
}

export async function privilegeReview(folder: string, candidate: PrivilegeCandidate, reader: ReturnType<typeof safetyReader>, actor: RestoreActor, map: (folder: string, id: string) => string, now: number): Promise<DirectoryReview> {
  const { source, unitId, unit, removeMember } = candidate
  const group = folder.startsWith("PimGroup"), scopedMember = !!unitId && source.roleId !== undefined
  const roleSourceId = scopedMember ? source.roleId : source.roleDefinitionId
  const groupEligibility = folder === "PimGroupEligibilitySchedules"
  const approvals = ["directory-item", "privileged-relationship"]
  if (removeMember) approvals.push("exact-unit")
  const review: DirectoryReview = {
    principal: null, resource: { id: "", name: "Unresolved resource", type: "directory" },
    privilege: group ? `${groupEligibility ? "Eligible" : "Active"} group ${source.accessId === "owner" ? "owner" : "member"}`
      : unitId ? scopedMember ? "Scoped role member" : removeMember ? "Remove unit member" : candidate.principalId ? "Add unit member" : "Administrative unit relationship review"
      : folder === "RoleEligibilitySchedules" ? "Role eligibility" : folder === "RoleAssignmentSchedules" ? "Active role schedule" : "Role assignment",
    scope: "Unresolved scope", approvals, notices: [], roleAssignable: false, changes: [],
  }
  const scheduleCollection = scheduleCollections[folder]
  let currentSchedules: unknown = "Not read"
  let blocker = candidate.blocker
  const unresolved: string[] = []
  const resolve = async <T>(kind: string, savedId: unknown, read: (id: string, identify: (mappedId: string) => void) => Promise<T>) => {
    let id = isGuid(savedId) ? savedId.toLowerCase() : undefined
    try { return await read(requirePrivilegeId(id), mappedId => { id = mappedId }) }
    catch (error) {
      if (error instanceof RestoreWriteDeferredError || isRestorePersistenceError(error)) throw error
      unresolved.push(id ? `The ${kind} ${id} no longer resolves.` : `The saved ${kind} has an invalid or missing ID.`)
      return undefined
    }
  }
  const memberType = candidate.memberType
  const unsupportedMember = memberType && memberType !== "user" && memberType !== "group"
  const beneficiary = unsupportedMember || candidate.blocker && !candidate.principalId ? undefined : await resolve("principal", candidate.principalId ?? source.principalId, async (rawPrincipal, identify) => {
    const user = removeMember || memberType === "group" ? rawPrincipal : map("Users", rawPrincipal)
    const mappedGroup = removeMember || memberType === "user" ? rawPrincipal : map("Groups", rawPrincipal)
    if (user !== rawPrincipal && mappedGroup !== rawPrincipal) return fail("The principal mapping is ambiguous.")
    const id = user !== rawPrincipal ? user : mappedGroup
    identify(id)
    const typedReads = {
      user: `users/${id}?$select=id,displayName,onPremisesSyncEnabled,onPremisesImmutableId,onPremisesLastSyncDateTime`,
      group: `groups/${id}?$select=id,displayName,onPremisesSyncEnabled,onPremisesLastSyncDateTime`,
      servicePrincipal: `servicePrincipals/${id}?$select=id,displayName,appId`,
    }
    const kinds = memberType === "user" || memberType === "group" ? [memberType] as const
      : user !== rawPrincipal ? ["user"] as const : mappedGroup !== rawPrincipal ? ["group"] as const : ["user", "group", "servicePrincipal"] as const
    for (const type of kinds) {
      const principal = await reader.getOptional(typedReads[type])
      if (!principal) continue
      if (isGuid(principal.id) && principal.id.toLowerCase() === id && typeof principal.displayName === "string" && principal.displayName.trim()
        && (principal["@odata.type"] === undefined || principal["@odata.type"] === `#microsoft.graph.${type}`)) return { id, principal, type }
      break
    }
    if (unitId && !scopedMember && !memberType) {
      blocker ??= `Member ${id} could not be identified. It may be an unsupported member type or may no longer exist.`
      return undefined
    }
    return fail("The principal does not have a verified name and type.")
  })
  if (unsupportedMember && candidate.principalId) {
    review.principal = { id: candidate.principalId, name: memberType === "device" ? "Device" : "Unsupported member", type: memberType }
    blocker = memberType === "device" ? "Device members are not restored." : "This administrative unit member type is not supported."
  }
  const principalId = beneficiary?.id
  const protectedReferences = { complete: !!beneficiary, principals: principalId ? [principalId] : [],
    applications: beneficiary?.type === "servicePrincipal" && isGuid(beneficiary.principal.appId) ? [beneficiary.principal.appId] : [] }
  if (beneficiary) {
    const { id, principal, type } = beneficiary
    review.principal = { id, name: String(principal.displayName), type }
    try { guardRestoreItem(actor, folder, undefined, protectedReferences, false); cloudObject(principal) }
    catch (error) { blocker = (error as RestoreSafetyError).message }
    if (type !== "user") blocker ??= "This principal type is blocked because all indirect beneficiaries could not be verified."
  }
  let roleId: string | undefined
  if (scopedMember || !group && !unitId) {
    const role = await resolve("role", roleSourceId, async (savedId, identify) => {
      roleId = map("EntraRoleDefinitions", savedId)
      identify(roleId)
      if (!unitId) review.resource = { id: roleId, name: "Unresolved directory role", type: "directory role" }
      return privilegeObject(reader, roleDefinitions, roleId, "The saved role no longer resolves.")
    })
    if (role) {
      if (role.isEnabled !== true) blocker ??= "The live role definition is disabled or its state could not be verified."
      if (unitId) review.privilege = `Scoped role member: ${role.displayName}`
      else review.resource = { id: String(role.id), name: String(role.displayName), type: "directory role" }
    } else if (scopedMember && roleId) {
      review.privilege = `Scoped role member: unresolved role (${roleId})`
    }
  }
  let directoryScopeId = source.directoryScopeId === "/" ? "/" : undefined
  let groupId: string | undefined
  if (group) {
    const resource = await resolve("group scope", source.groupId, async (savedId, identify) => {
      groupId = map("Groups", savedId)
      identify(groupId)
      review.resource = { id: groupId, name: "Unresolved group", type: "group" }
      review.scope = `Unresolved group (${groupId})`
      return privilegeObject(reader, "groups", groupId, "The saved PIM group no longer resolves.")
    })
    if (resource) {
      review.resource.name = String(resource.displayName)
      review.scope = `Group ${resource.displayName} (${groupId})`
      review.roleAssignable = resource.isAssignableToRole === true
      if (!Array.isArray(resource.groupTypes) || resource.groupTypes.includes("DynamicMembership") || resource.onPremisesSyncEnabled != null) blocker ??= "Dynamic, synchronized or unresolved PIM groups are blocked."
    }
  } else if (unitId) {
    review.resource = { id: unitId, name: unit ? String(unit.displayName) : "Unresolved administrative unit", type: "administrative unit" }
    review.scope = unit ? `Administrative unit ${unit.displayName} (${unitId})` : `Unresolved administrative unit (${unitId})`
    if (unit) blocker ??= unitChangeBlocker(unit)
    else unresolved.push(`The saved administrative unit ${unitId} no longer resolves.`)
    if (removeMember && !blocker && beneficiary) {
      try { guardRestoreItem(actor, folder, undefined, protectedReferences, true) }
      catch (error) { blocker = (error as RestoreSafetyError).message }
    }
  } else if (source.appScopeId != null && source.appScopeId !== "") {
    blocker ??= "Application-scoped roles remain blocked."
  } else if (directoryScopeId === "/") {
    review.scope = "Entire tenant"
  } else if (typeof source.directoryScopeId === "string" && source.directoryScopeId.startsWith("/administrativeUnits/")) {
    const scope = await resolve("administrative unit scope", source.directoryScopeId.slice(21), async (savedId, identify) => {
      const unitId = map("AdministrativeUnits", savedId)
      identify(unitId)
      review.scope = `Unresolved administrative unit (${unitId})`
      return privilegeObject(reader, administrativeUnits, unitId, "The saved administrative unit scope no longer resolves.")
    })
    if (scope) {
      directoryScopeId = `/administrativeUnits/${String(scope.id).toLowerCase()}`
      review.scope = `Administrative unit ${scope.displayName} (${String(scope.id).toLowerCase()})`
      blocker ??= unitChangeBlocker(scope)
    }
  } else {
    blocker ??= "The saved role scope no longer resolves."
  }
  if (unresolved.length) blocker = unitId && !unit && blocker ? [...unresolved, blocker].join(" ") : unresolved.join(" ")
  if (!blocker && principalId) {
    try { privilegeRequest(folder, source, principalId, { roleId, directoryScopeId, groupId, unitId: unit ? String(unit.id) : undefined }, now, removeMember) }
    catch (error) { blocker = (error as RestoreSafetyError).message }
  }
  let present = candidate.present
  if (present === undefined && !blocker && principalId) {
    try {
      const current = await reader.list(collectionFilter(scheduleCollection ?? roleAssignments, group ? "groupId" : "principalId", groupId ?? principalId))
      const matches = current.filter(row => String(row.principalId).toLowerCase() === principalId && (group
        ? String(row.groupId).toLowerCase() === groupId && row.accessId === source.accessId
        : String(row.roleDefinitionId).toLowerCase() === roleId && row.directoryScopeId === directoryScopeId && !row.appScopeId))
      present = matches.length > 0
      if (scheduleCollection) currentSchedules = present ? matches.map(row => reviewSchedule(row.scheduleInfo) ?? "Not read") : null
    } catch (error) {
      if (!scheduleCollection || error instanceof RestoreWriteDeferredError || isRestorePersistenceError(error)) throw error
      blocker = error instanceof RestoreSafetyError ? error.message : "The current schedule could not be read."
    }
  }
  if (scheduleCollection) review.changes.push({ property: "Schedule", before: currentSchedules, after: reviewSchedule(source.scheduleInfo) })
  if (present === false && !removeMember) {
    approvals.push("security-response")
    review.notices.push("The current state looks deliberate. Restoring removed access may undo a security response.")
  }
  if (present !== undefined) review.changes.push({ property: "Relationship", before: present ? "Present" : "Absent", after: removeMember ? "Absent" : "Present" })
  if (present && !removeMember) blocker ??= "A current relationship occupies this scope. Its access or schedule will not be changed."
  if (folder === "EntraRoleAssignments") blocker ??= "The saved role link could have come from a time-bound assignment or activation. Its permanent assignment provenance is unavailable."
  return { ...review, blocker: blocker ?? PRIVILEGED_RESTORE_BLOCKER }
}

export interface UnitReviewCursor {
  saved: number
  live?: { next?: string; offset: number; pages: number }
  scoped: number
}

/** Check a slice of saved links, then walk live pages only when exact membership was selected. */
export async function unitRelationships(snapshot: Item, reader: ReturnType<typeof safetyReader>, path: string | undefined, exact: boolean, map: (folder: string, id: string) => string, previous?: UnitReviewCursor) {
  const cursor: UnitReviewCursor = { saved: 0, scoped: 0, ...previous }
  const rows: PrivilegeCandidate[] = []
  const limit = 50
  const savedMembers = snapshot.members, savedRoles = snapshot.scopedRoleMembers
  if (!Array.isArray(savedMembers) || !savedMembers.every(isGuid)) {
    if (cursor.saved === 0) rows.push({ source: {}, blocker: "The backup does not contain a complete administrative unit member inventory." })
    cursor.saved = 1
  } else {
    const savedIds = [...new Set(savedMembers.map(requirePrivilegeId))]
    const memberTypes = object(snapshot.memberTypes)
    const savedType = (saved: string) => {
      const type = memberTypes?.[saved]
      return typeof type === "string" && /^[a-zA-Z]+$/.test(type) ? type : undefined
    }
    const targetFor = (saved: string) => {
      const type = savedType(saved)
      if (type) return type === "user" ? map("Users", saved) : type === "group" ? map("Groups", saved) : saved
      const user = map("Users", saved), group = map("Groups", saved)
      return user !== saved && group !== saved ? undefined : user !== saved ? user : group
    }
    const end = Math.min(savedIds.length, cursor.saved + limit)
    for (const saved of savedIds.slice(cursor.saved, end)) {
      const memberType = savedType(saved)
      const target = targetFor(saved)
      if (!target) rows.push({ source: {}, principalId: path ? undefined : saved, blocker: "A saved member has an ambiguous principal mapping. Exact removal requires a complete inventory." })
      else if (!path) rows.push({ source: {}, principalId: saved, memberType })
      else {
        const member = await reader.getOptional(`${path}/members/${target}`)
        if (!member) rows.push({ source: {}, principalId: saved, memberType, present: false })
        else if (requirePrivilegeId(member.id) !== target) fail("The current administrative unit member could not be verified.")
      }
    }
    cursor.saved = end
    if (end < savedIds.length) return { rows, cursor }
    if (path && exact && cursor.live?.pages !== -1 && rows.length === limit) return { rows, cursor }
    const expected = path && exact && cursor.live?.pages !== -1 ? new Set(savedIds.map(targetFor)) : undefined
    if (path && expected && !expected.has(undefined)) {
      const live = cursor.live ?? { offset: 0, pages: 0 }
      if (live.pages >= 10_000) fail("The administrative unit membership collection did not finish.")
      const page = await reader.page(path + "/members?$select=id&$top=50", live.next)
      let offset = live.offset
      while (offset < page.rows.length && rows.length < limit) {
        const member = page.rows[offset++]!
        const id = requirePrivilegeId(member.id), type = member["@odata.type"]
        const memberType = typeof type === "string" && /^#microsoft\.graph\.[a-zA-Z]+$/.test(type) ? type.slice("#microsoft.graph.".length) : undefined
        if (!expected.has(id)) rows.push({ source: {}, principalId: id, memberType, present: true, removeMember: true })
      }
      if (offset < page.rows.length) return { rows, cursor: { ...cursor, live: { ...live, offset } } }
      if (page.next) return { rows, cursor: { ...cursor, live: { next: page.next, offset: 0, pages: live.pages + 1 } } }
      cursor.live = { offset: 0, pages: -1 }
    }
  }
  if (rows.length === limit && (!Array.isArray(savedRoles) || cursor.scoped < savedRoles.length)) return { rows, cursor }
  if (!Array.isArray(savedRoles)) {
    rows.push({ source: {}, blocker: "The backup does not contain a complete scoped role inventory." })
  } else if (cursor.scoped < savedRoles.length) {
    const live = path ? await reader.list(path + "/scopedRoleMembers") : []
    const byId = new Map(live.map(row => [row.id, row]))
    const pairs = new Set(live.map(row => [row.roleId, object(row.roleMemberInfo)?.id].map(value => String(value).toLowerCase()).join("/")))
    while (cursor.scoped < savedRoles.length && rows.length < limit) {
      const saved = savedRoles[cursor.scoped++]
      const link = object(saved) ?? byId.get(saved)
      const principalId = object(link?.roleMemberInfo)?.id
      if (!link || !isGuid(principalId) || !isGuid(link.roleId)) {
        rows.push({ source: !path && isGuid(link?.roleId) ? { roleId: link.roleId } : {}, principalId: !path && isGuid(principalId) ? principalId : undefined, blocker: "This saved scoped role membership lacks the principal or role ID. Capture a new backup with scoped role details." })
        continue
      }
      if (!path) {
        rows.push({ source: { roleId: link.roleId }, principalId })
        continue
      }
      const mappedRole = map("EntraRoleDefinitions", link.roleId.toLowerCase())
      const principal = principalId.toLowerCase()
      const user = map("Users", principal), group = map("Groups", principal)
      const present = pairs.has(`${mappedRole}/${user !== principal ? user : group}`)
      rows.push({ source: { roleId: link.roleId }, principalId, present })
    }
    if (cursor.scoped < savedRoles.length) return { rows, cursor }
  }
  return { rows, cursor: undefined }
}
