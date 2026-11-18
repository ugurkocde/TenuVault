import { ALL_RESTORE_PROTECTIONS, operationProtections, type RestoreProtection } from "../../shared/intune/restore-matrix"
import type { KeyValueStore } from "../storage/secure-store"
import type { GraphReader } from "../../shared/intune/read"
import type { Item } from "../../shared/intune/registry"
import { isGuid } from "../../shared/security"
import { RestoreSafetyError, type RestoreActor, type SafetyReferences } from "../../shared/intune/restore-guards"
import type { GuardedStep } from "./guarded-run"

const recoveryKey = (tenant: string) => `restore.recovery.${tenant.toLowerCase()}`
export class RecoveryAccounts {
  constructor(private readonly store: KeyValueStore) {}
  get(tenant: string): string[] {
    const raw = this.store.get(recoveryKey(tenant))
    if (raw === null) return []
    const ids: unknown = JSON.parse(raw)
    if (!Array.isArray(ids) || ids.some(id => !isGuid(id))) throw new RestoreSafetyError("Saved recovery accounts could not be verified.")
    return ids
  }
  async save(tenant: string, ids: string[], reader: GraphReader): Promise<void> {
    if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => !isGuid(id))) throw new RestoreSafetyError("Enter up to 20 recovery account object IDs.")
    const unique = [...new Set(ids.map(id => id.toLowerCase()))]
    for (const id of unique) {
      const user = await reader.get(`users/${id}?$select=id,accountEnabled,userType,onPremisesSyncEnabled`)
      if (user.id !== id || user.accountEnabled !== true || user.userType !== "Member" || user.onPremisesSyncEnabled === true) throw new RestoreSafetyError("Recovery accounts must be enabled cloud member accounts in this tenant.")
    }
    this.store.set(recoveryKey(tenant), JSON.stringify(unique))
  }
}
const GA = "62e90394-69f5-4237-9190-012177145e10"
const PRA = "e8611ab8-c189-46e8-94e1-60213ab1f814"
const idOf = (item: Item, key = "id"): string => {
  const value = item[key]
  if (!isGuid(value)) throw new RestoreSafetyError("A required identity could not be resolved.")
  return value
}

export async function resolveRestoreActor(reader: GraphReader, connection: { tenantId: string; clientId: string; userId: string }, recoveryAccountIds: string[], protections: readonly RestoreProtection[] = ALL_RESTORE_PROTECTIONS): Promise<RestoreActor> {
  if (![connection.tenantId, connection.clientId, connection.userId].every(isGuid)) throw new RestoreSafetyError("A signed-in tenant connection is required.")
  if (!protections.length) return { ...connection, recoveryAccountIds: [] }
  const filter = encodeURIComponent(`appId eq '${connection.clientId}'`)
  const apps = await reader.list(`applications?$filter=${filter}&$select=id,appId`)
  const principals = await reader.list(`servicePrincipals?$filter=${filter}&$select=id,appId`)
  if (apps.length !== 1 || principals.length !== 1 || apps[0]!.appId !== connection.clientId || principals[0]!.appId !== connection.clientId) throw new RestoreSafetyError("The connected registration and enterprise app could not both be resolved.")
  for (const id of recoveryAccountIds) if (idOf(await reader.get(`users/${encodeURIComponent(id)}?$select=id`)) !== id) throw new RestoreSafetyError("A recovery account could not be resolved.")
  return { tenantId: connection.tenantId, clientId: connection.clientId, userId: connection.userId, applicationObjectId: idOf(apps[0]!), servicePrincipalId: idOf(principals[0]!), recoveryAccountIds }
}

/** Fresh resolution per item. Missing permissions, limited objects and incomplete pages block the item. */
export async function resolveSafetyReferences(reader: GraphReader, step: GuardedStep, current: Item | null, desired: Item): Promise<SafetyReferences> {
  const protections = operationProtections(step.folder, step.operation)
  if (!protections.length) return { principals: [], applications: [], complete: true }
  const principals = new Set<string>()
  const applications = new Set<string>()
  try {
    const affected = new Set<string>()
    const walk = (value: unknown, key = "") => {
      if (Array.isArray(value)) { for (const child of value) walk(child, key); return }
      if (value && typeof value === "object") {
        const object = value as Item
        if (/^(members|owners|assignTo)$/i.test(key) && object.id !== undefined) { if (!isGuid(object.id)) throw new Error("Unresolved relationship"); affected.add(object.id) }
        for (const [name, child] of Object.entries(value)) walk(child, name)
        return
      }
      if (typeof value !== "string") return
      if (/^(principalId|userId|groupId|memberId|ownerId|clientId|resourceId|assignTo|members|owners|includeUsers|excludeUsers|includeGroups|excludeGroups)$/i.test(key)) {
        if (!isGuid(value)) throw new Error("Unresolved principal")
        affected.add(value)
      }
      if (key === "@odata.id") {
        const url = new URL(value)
        if (url.origin !== "https://graph.microsoft.com" || !/^\/(v1\.0|beta)\/(users|groups|directoryObjects|servicePrincipals)\/[0-9a-f-]+$/i.test(url.pathname) || url.search || url.hash) throw new Error("Unresolved relationship URL")
        const id = url.pathname.split("/").at(-1)!
        if (!isGuid(id)) throw new Error("Unresolved relationship ID")
        affected.add(id)
      }
      if (/^(appId|applicationId)$/i.test(key)) { if (!isGuid(value)) throw new Error("Unresolved app"); applications.add(value) }
    }
    if (protections.includes("identity-references")) { walk(current); walk(desired) }
    if (["Users", "Groups", "ServicePrincipals", "AdministrativeUnits"].includes(step.folder)) affected.add(step.targetId ?? step.sourceId)
    if (step.folder === "Applications") applications.add(step.targetId ?? step.sourceId)
    const expanded = new Map<string, string[]>()
    const expand = async (id: string, holdersOnly = false): Promise<string[]> => {
      const cacheKey = `${id}:${holdersOnly}`
      const cached = expanded.get(cacheKey)
      if (cached) return cached
      if (!isGuid(id)) throw new Error("Unresolved principal")
      const object = await reader.get(`directoryObjects/${id}`)
      const kind = object["@odata.type"]
      let ids = [idOf(object)]
      if (kind === "#microsoft.graph.group") {
        const members = await reader.list(`groups/${id}/transitiveMembers?$select=id`)
        const owners = !holdersOnly && affected.has(id) ? await reader.list(`groups/${id}/owners?$select=id`) : []
        const eligible = await reader.list(`identityGovernance/privilegedAccess/group/eligibilityScheduleInstances?$filter=${encodeURIComponent(`groupId eq '${id}'`)}`)
        ids = [...ids, ...members.map(item => idOf(item)), ...owners.map(item => idOf(item)), ...eligible.filter(item => !holdersOnly || item.accessId === "member").filter(item => {
          for (const key of ["startDateTime", "endDateTime"]) if (item[key] !== null && item[key] !== undefined && (typeof item[key] !== "string" || !Number.isFinite(Date.parse(item[key] as string)))) throw new Error("Unresolved eligibility period")
          return (!item.startDateTime || Date.parse(item.startDateTime as string) <= Date.now()) && (!item.endDateTime || Date.parse(item.endDateTime as string) > Date.now())
        }).map(item => idOf(item, "principalId"))]
      } else if (kind !== "#microsoft.graph.user" && kind !== "#microsoft.graph.servicePrincipal") throw new Error("Unknown principal kind")
      expanded.set(cacheKey, ids)
      return ids
    }
    for (const id of affected) for (const principal of await expand(id)) principals.add(principal)
    if (!protections.includes("remaining-administrators")) return { principals: [...principals], applications: [...applications], complete: true }
    const definitions = await reader.list("roleManagement/directory/roleDefinitions?$select=id,templateId")
    const assignments = await reader.list("roleManagement/directory/roleAssignments")
    const eligibility = await reader.list("roleManagement/directory/roleEligibilityScheduleInstances")
    if (step.folder === "EntraRoleDefinitions") for (const assignment of [...assignments, ...eligibility]) {
      if (assignment.roleDefinitionId === (step.targetId ?? step.sourceId)) for (const id of await expand(idOf(assignment, "principalId"))) principals.add(id)
    }
    const remaining = { global: [] as string[], privilegedRole: [] as string[] }
    for (const assignment of [...assignments, ...eligibility]) {
      for (const key of ["startDateTime", "endDateTime"]) if (assignment[key] !== null && assignment[key] !== undefined && (typeof assignment[key] !== "string" || !Number.isFinite(Date.parse(assignment[key] as string)))) throw new Error("Unresolved assignment period")
      if (typeof assignment.endDateTime === "string" && Date.parse(assignment.endDateTime) <= Date.now()) continue
      if (typeof assignment.startDateTime === "string" && Date.parse(assignment.startDateTime) > Date.now()) continue
      const definition = definitions.find(item => item.id === assignment.roleDefinitionId)
      if (!definition) throw new Error("Unresolved role")
      const role = definition.templateId === GA ? "global" : definition.templateId === PRA ? "privilegedRole" : undefined
      // Scoped assignments are never proof of tenant-wide recovery access.
      if (!role || assignment.directoryScopeId !== "/") continue
      if (step.allowRemoval && (assignment.id === current?.id || assignment.id === step.targetId)) continue
      for (const id of await expand(idOf(assignment, "principalId"), true)) {
        if (principals.has(id) && step.allowRemoval) continue
        const object = await reader.get(`directoryObjects/${id}`)
        if (object["@odata.type"] !== "#microsoft.graph.user") continue
        const user = await reader.get(`users/${id}?$select=id,accountEnabled`)
        if (user.accountEnabled !== true) continue
        remaining[role].push(idOf(user))
      }
    }
    return { principals: [...principals], applications: [...applications], remainingAdministrators: remaining, complete: true }
  } catch { return { principals: [...principals], applications: [...applications], complete: false } }
}
