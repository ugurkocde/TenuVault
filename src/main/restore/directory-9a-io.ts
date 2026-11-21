import { rejectProxyAuthResponses } from "../api/network-error"
import { DIRECTORY_RETRIES, DirectoryReadDeferredError, DirectoryThrottledError, directoryRetryAt, retryDirectoryWrite, waitForDirectoryRetry } from "./directory-retry"
import { typeForFolder, restoreCapability, type Item } from "../../shared/intune/registry"
import { restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { RestoreSafetyError, RestoreWriteDeferredError, RestoreWriteRefusedError, guardRestoreItem, type RestoreActor } from "../../shared/intune/restore-guards"
import { isGuid } from "../../shared/security"
import { graphContinuation } from "../../shared/graph-continuation"
import { directoryPermissionBlocker } from "./directory-permissions"
import { directoryReadAbsent, directoryReadShape } from "./directory-read-shape"
import { requireRestoreActor } from "./restore-actor"
import { directoryPayload, directoryReview, disabledUserBody, requireDirectoryApprovals, cloudObject, DIRECTORY_9A_BLOCKER } from "./directory-9a"
import { isRestorePersistenceError, guardedProtections, restoreFingerprint, type GuardedIO, type GuardedStep } from "./guarded-run"

const root = "https://graph.microsoft.com/v1.0/"
const identity = (id: unknown): string => {
  if (!isGuid(id)) throw new RestoreSafetyError("A directory object ID could not be resolved.")
  return id
}
/** Least privilege by operation. Blocked operations contribute no product setup permission. */
export function directoryAdmission(step: GuardedStep): string | undefined {
  const contract = restoreMatrixRow(step.folder)?.directoryRestore
  const action = step.directory?.action
  const kinds = [action ?? "missing", ...(step.folder === "Groups" && action === "update" && (step.desired.description === null || step.desired.description === "") ? ["clear description"] : []), ...(step.folder === "Users" && step.desired.accountEnabled !== undefined && action === "update" ? ["account state"] : []), ...(action === "owner" && step.desired.present === false ? ["owner remove"] : []), ...(step.desired.membershipRule !== undefined ? ["dynamic rule"] : []), ...(step.desired.isAssignableToRole === true ? ["role-assignable creation"] : [])]
  if (contract?.phase !== "enabled" || kinds.some(kind => contract.evidence?.[kind]?.result !== "round-trip-matched")) return contract?.contracts?.find(row => row.action === kinds.find(kind => !contract.evidence?.[kind]))?.blocker || DIRECTORY_9A_BLOCKER
}
export function directoryPermissions(step: GuardedStep): string[] {
  const action = step.directory?.action
  if (action === "member") return ["GroupMember.ReadWrite.All"]
  if (action === "owner") return ["Group.ReadWrite.All"]
  if (action === "manager") return ["User.ReadWrite.All"]
  if (action === "license") return ["LicenseAssignment.ReadWrite.All"]
  if (action === "invite") return ["User.Invite.All"]
  if (action === "recycle") return [step.folder === "Users" ? "User.DeleteRestore.All" : "Group.ReadWrite.All"]
  if (step.folder === "Groups") return ["Group.ReadWrite.All"]
  return action === "create" ? ["User.Create"] : ["User.ReadUpdate.All", ...(step.desired.accountEnabled !== undefined ? ["User.EnableDisableAccount.All", "User.Read.All"] : [])]
}
/** The same operation evidence gates the preview and the final transport. */
export function directory9aIO(token: string, actor: RestoreActor, safety: GuardedIO["references"], fetchImpl: typeof fetch = fetch, scan?: GuardedIO["replacedReferences"], wait?: (ms: number) => Promise<void>, signal?: AbortSignal, retryReads = true, onReadThrottled?: (retryAt: number) => void): GuardedIO & { review: (step: GuardedStep, preimage?: Item | null) => Promise<ReturnType<typeof directoryReview>>; ids: (id: string, kind: "members" | "owners") => AsyncIterable<string>; locate: (folder: "Users" | "Groups", sourceId: string) => Promise<{ action: "update" | "recycle" | "create"; current: Item | null }> } {
  requireRestoreActor(token, actor)
  const fetchRequest = rejectProxyAuthResponses(fetchImpl)
  // Preview inventories can retry individual reads. Journalled execution uses raw
  // reads so every throttle reaches its durable entry or restarts the whole writer.
  const request = async (path: string, method = "GET", body?: Item, validateSend?: () => Promise<void>, beforeSend?: () => void): Promise<Item | null> => {
    for (let attempt = 0; ; attempt++) {
      const url = new URL(path.startsWith("https://") ? path : root + path)
      if (method === "GET" && /^(users|groups)\/[0-9a-f-]+$/i.test(path)) url.searchParams.set("$select", path.startsWith("users/") ? "id,displayName,userPrincipalName,mailNickname,userType,accountEnabled,givenName,surname,jobTitle,department,officeLocation,usageLocation,assignedLicenses,onPremisesSyncEnabled,onPremisesImmutableId,onPremisesLastSyncDateTime" : "id,displayName,description,mailNickname,groupTypes,mailEnabled,securityEnabled,isAssignableToRole,membershipRule,membershipRuleProcessingState,onPremisesSyncEnabled")
      if (method !== "GET") {
        try {
          signal?.throwIfAborted()
          await validateSend?.()
          signal?.throwIfAborted()
        } catch (error) {
          if (isRestorePersistenceError(error)) throw error
          if (!(error instanceof DirectoryThrottledError) && signal?.aborted) throw new RestoreWriteDeferredError("The directory write was cancelled before sending.")
          throw error
        }
      } else if (signal?.aborted) throw new RestoreWriteDeferredError("The directory read was cancelled before sending a write.")
      const requestSignal = method === "GET" && signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
      beforeSend?.()
      if (method !== "GET" && signal?.aborted) throw new RestoreWriteDeferredError("The directory write was cancelled before sending.")
      const response = await fetchRequest(url.href, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: requestSignal }).catch(error => {
        if (isRestorePersistenceError(error)) throw error
        if (method === "GET" && signal?.aborted) throw new RestoreWriteDeferredError("The directory read was cancelled before sending a write.")
        if (method === "GET") throw new DirectoryReadDeferredError()
        throw error
      })
      if (response.status === 429) {
        const retryAt = directoryRetryAt(response, attempt)
        if (method === "GET") onReadThrottled?.(retryAt)
        if (method !== "GET" || !retryReads) throw new DirectoryThrottledError(response)
        try {
          if (attempt >= DIRECTORY_RETRIES) throw new DirectoryThrottledError(response)
          await waitForDirectoryRetry(retryAt, signal, wait)
        } catch { throw new RestoreWriteDeferredError("The throttled directory read was not applied. Resume after Retry-After.", retryAt) }
        continue
      }
      if (method === "GET" && response.status === 404) return directoryReadAbsent(response, url)
      if (method !== "GET" && response.status >= 400 && response.status < 500 && response.status !== 408) throw new RestoreWriteRefusedError(response.status)
      if (method === "GET" && (response.status === 408 || response.status >= 500)) throw new DirectoryReadDeferredError()
      if (!response.ok) throw new Error("Directory request was not confirmed. No response body is retained.")
      if (method === "GET" && !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) throw new DirectoryReadDeferredError()
      if (response.status === 204) {
        if (method === "GET") throw new DirectoryReadDeferredError()
        return {}
      }
      const text = await response.text().catch(error => {
        if (isRestorePersistenceError(error)) throw error
        if (method === "GET" && signal?.aborted) throw new RestoreWriteDeferredError("The directory read was cancelled before sending a write.")
        if (method === "GET") throw new DirectoryReadDeferredError()
        throw error
      })
      try {
        const value: unknown = JSON.parse(text)
        return method === "GET" ? directoryReadShape(value, url) : value as Item
      }
      catch (error) {
        if (method === "GET" && !(error instanceof RestoreSafetyError)) throw new DirectoryReadDeferredError()
        throw error
      }
    }
  }
  const permissionBlocker = (step: GuardedStep, roleAssignable = false) => directoryPermissionBlocker(token, [...directoryPermissions(step), ...(roleAssignable && ["create", "member"].includes(step.directory!.action) ? ["RoleManagement.ReadWrite.Directory"] : [])])
  const requirePermissions = (step: GuardedStep, roleAssignable = false) => {
    const blocker = permissionBlocker(step, roleAssignable)
    if (blocker) throw new RestoreWriteDeferredError(blocker)
  }
  const ids = async function* (id: string, kind: "members" | "owners"): AsyncGenerator<string> {
    const start = `https://graph.microsoft.com/${kind === "members" ? "beta" : "v1.0"}/groups/${identity(id)}/${kind}?$select=id&$top=999`
    let next: string | undefined = start
    const seen = new Set<string>()
    while (next) {
      const page = await request(graphContinuation(start, next, seen))
      if (!Array.isArray(page?.value)) throw new RestoreSafetyError("Invalid relationship collection.")
      for (const item of page.value as Item[]) yield identity(item?.id)
      if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new RestoreSafetyError("Invalid relationship continuation.")
      next = page["@odata.nextLink"] as string | undefined
    }
  }
  const list = async function* (path: string): AsyncGenerator<Item> {
    const start = root + path, seen = new Set<string>()
    let next: string | undefined = start
    while (next) {
      const page = await request(graphContinuation(start, next, seen).slice(root.length))
      if (!Array.isArray(page?.value)) throw new RestoreSafetyError("A directory collection was incomplete.")
      for (const item of page.value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new RestoreSafetyError("A directory collection was malformed.")
        yield item as Item
      }
      if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new RestoreSafetyError("Invalid directory continuation.")
      next = page["@odata.nextLink"] as string | undefined
    }
  }
  const folderPath = (step: GuardedStep) => step.folder === "Users" ? "users" : step.folder === "Groups" ? "groups" : (() => { throw new RestoreSafetyError("Outside directory restore scope.") })()
  const target = (step: GuardedStep, id?: string) => `${folderPath(step)}/${identity(id ?? step.targetId ?? step.sourceId)}`
  const find = async (step: GuardedStep): Promise<Item[]> => {
    const body = step.desired
    // Group aliases are not unique. An unanswered group create remains uncertain without its returned ID.
    if (step.folder === "Groups") return []
    const field = step.directory?.action === "invite" ? "mail" : "userPrincipalName"
    const value = step.directory?.action === "invite" ? body.invitedUserEmailAddress : body.userPrincipalName
    if (typeof value !== "string") throw new RestoreSafetyError("A unique user create key is required.")
    const matches: Item[] = []
    for await (const user of list(`users?$select=id,displayName,userPrincipalName,mailNickname,accountEnabled&$filter=${encodeURIComponent(`${field} eq '${value.replaceAll("'", "''")}'`)}`)) { matches.push(user); if (matches.length > 1) break }
    return matches
  }
  const resolvePrincipal = async (id: string): Promise<Item | null> => {
    const user = await request(`users/${identity(id)}`)
    if (user) {
      if (String(user.id).toLowerCase() !== id.toLowerCase()) throw new RestoreSafetyError("The user identity did not match its reference.")
      return { ...user, "@odata.type": "#microsoft.graph.user" }
    }
    const group = await request(`groups/${identity(id)}`)
    if (group !== null && String(group.id).toLowerCase() !== id.toLowerCase()) throw new RestoreSafetyError("The group identity did not match its reference.")
    return group ? { ...group, "@odata.type": "#microsoft.graph.group" } : null
  }
  const read = async (step: GuardedStep, id?: string): Promise<Item | null> => {
    const intent = step.directory
    if (!intent) throw new RestoreSafetyError("A directory intent is required.")
    if (step.operation === "create" && !id && !step.targetId) {
      const existing = await request(target(step))
      if (existing) return existing
      if (await request(`directory/deletedItems/${identity(step.sourceId)}`)) throw new RestoreSafetyError("Restore this object from the recycle bin first.")
      const matches = await find(step)
      if (matches.length > 1) throw new RestoreSafetyError("The user identity is ambiguous.")
      return matches[0] ?? null
    }
    const path = target(step, id)
    if (["member", "owner"].includes(intent.action)) {
      const principalId = identity(intent.principalId)
      const resource = await request(path)
      if (!resource) throw new RestoreSafetyError("The relationship resource is missing.")
      const current = await request(`${path}/${intent.action === "member" ? "members" : "owners"}/${principalId}`)
      const principal = await resolvePrincipal(principalId)
      return { id: resource.id!, present: current !== null, principalId, resource, principal }
    }
    if (intent.action === "manager") {
      const user = await request(path)
      if (!user) throw new RestoreSafetyError("The managed user is missing.")
      const manager = await request(`${path}/manager`)
      return { id: user.id!, principalId: manager?.id ?? null, resource: user, principal: intent.principalId ? await resolvePrincipal(intent.principalId) : null }
    }
    if (intent.action === "recycle") {
      const live = await request(path)
      if (live) return { id: live.id!, restored: true }
      const deleted = await request(`directory/deletedItems/${identity(step.targetId ?? step.sourceId)}`)
      return deleted ? { ...deleted, restored: false } : null
    }
    if (intent.action === "license") {
      const user = await request(path)
      return user ? { ...user, assignedLicenses: Array.isArray(user.assignedLicenses) ? user.assignedLicenses.filter(license => (license as Item).skuId === ((step.desired.assignedLicenses as Item[] | undefined)?.[0]?.skuId)) : [] } : null
    }
    return request(path)
  }
  const review = async (step: GuardedStep, preimage?: Item | null) => {
    const intent = step.directory
    if (!intent) throw new RestoreSafetyError("A directory intent is required.")
    let resource = preimage !== undefined ? (preimage?.resource as Item | undefined) ?? preimage : step.operation === "create" ? null : await request(target(step))
    if (!resource && intent.action === "recycle") resource = await request(`directory/deletedItems/${identity(step.targetId ?? step.sourceId)}`)
    if (resource) { cloudObject(resource); if (step.folder === "Groups") directoryPayload("Groups", "update", resource) }
    // Delegated non-admin group creation implicitly adds the caller as an owner.
    // A fresh tenant-wide Groups Administrator or Global Administrator assignment
    // establishes the documented security-group exception without restoring ownership.
    if (step.folder === "Groups" && intent.action === "create") {
      let admin = false
      for await (const assignment of list(`roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`principalId eq '${actor.userId}'`)}`)) {
        if (assignment.principalId !== actor.userId || assignment.directoryScopeId !== "/") continue
        const definition = await request(`roleManagement/directory/roleDefinitions/${identity(assignment.roleDefinitionId)}?$select=id,templateId`)
        if (["fdd7a751-b60b-444a-984c-02652fe8fa1c", "62e90394-69f5-4237-9190-012177145e10"].includes(String(definition?.templateId))) admin = true
      }
      if (!admin) throw new RestoreSafetyError("Security-group creation requires a current tenant-wide Groups Administrator or Global Administrator assignment. Non-admin creation can implicitly make the restoring account an owner.")
    }
    const principal = preimage !== undefined && preimage?.principal !== undefined ? preimage.principal as Item | null : intent.principalId ? await resolvePrincipal(intent.principalId) : null
    let excluded = false, included = false, inherited = false, indirectUserChange = false, targetingUnknown = false
    if (step.folder === "Users" && (intent.action === "manager" || (intent.action === "update" && step.desired.displayName !== undefined && step.desired.displayName !== resource?.displayName))) {
      for await (const policy of list("identity/conditionalAccess/policies?$select=id,conditions")) {
        const users = (policy.conditions as Item | undefined)?.users as Item | undefined
        if (!users || !Array.isArray(users.includeGroups) || !Array.isArray(users.excludeGroups) || users.includeGroups.length || users.excludeGroups.length) indirectUserChange = true
      }
    }
    if (step.folder === "Groups" && (["member", "owner"].includes(intent.action) || (intent.action === "update" && (step.desired.membershipRule !== undefined || step.desired.membershipRuleProcessingState !== undefined)))) {
      if (!resource || (typeof resource.isAssignableToRole !== "boolean" && resource.isAssignableToRole !== null)) throw new RestoreSafetyError("The group's privilege could not be resolved.")
      if (["member", "owner"].includes(intent.action)) for await (const parent of list(`groups/${identity(step.targetId ?? step.sourceId)}/memberOf?$select=id`)) { if (parent) { inherited = true; break } }
      try {
        for await (const policy of list("identity/conditionalAccess/policies?$select=id,conditions")) {
          const users = (policy.conditions as Item | undefined)?.users as Item | undefined
          if (!users || !Array.isArray(users.includeGroups) || !Array.isArray(users.excludeGroups) || [...users.includeGroups, ...users.excludeGroups].some(id => !isGuid(id))) throw new DirectoryReadDeferredError()
          if (users.excludeGroups.some(id => String(id).toLowerCase() === (step.targetId ?? step.sourceId).toLowerCase())) excluded = true
          if (users.includeGroups.some(id => String(id).toLowerCase() === (step.targetId ?? step.sourceId).toLowerCase())) included = true
        }
      } catch (error) {
        if (isRestorePersistenceError(error)) throw error
        if (intent.action !== "member" || step.desired.present !== false) throw error
        if (error instanceof DirectoryReadDeferredError) throw error
        // Keep the row visible while refusing removal if any policy page is unreadable.
        if (error instanceof RestoreWriteDeferredError) throw new RestoreWriteDeferredError("Conditional Access group targeting could not be determined. TenuVault cannot remove this member. Review the policies and remove the member in Microsoft Entra. " + error.message, error.retryAt)
        targetingUnknown = true
      }
    }
    const compared = ["member", "owner", "manager", "license"].includes(intent.action) ? { ...resource, ...(preimage === undefined ? await read(step, step.targetId) : preimage) } : resource
    const result = directoryReview(step, compared, principal, actor, excluded)
    // The optional flag is explicitly null on ordinary lab groups, and true on role-assignable fixtures.
    // An omitted or malformed selected field still fails closed.
    if (resource && step.folder === "Groups" && (typeof resource.isAssignableToRole !== "boolean" && resource.isAssignableToRole !== null)) result.blocker ??= "The group's role-assignable state could not be resolved."
    if (principal && ["member", "owner", "manager"].includes(intent.action) && principal["@odata.type"] !== "#microsoft.graph.user") result.blocker ??= "Only user principals have an admitted relationship contract."
    if (indirectUserChange) result.blocker ??= "User name and manager changes need a verified dynamic-membership review while Conditional Access group targeting or exclusions are present or unreadable."
    if (inherited) result.blocker ??= "This group has directory memberships. Its inherited beneficiaries and scoped access need a verified review before restoring links."
    const evidence = restoreMatrixRow(step.folder)?.directoryRestore?.evidence ?? {}
    const requireEvidence = (kind: string, reason: string) => { if (!evidence[kind]) result.blocker ??= reason }
    if (resource?.isAssignableToRole === true || step.desired.isAssignableToRole === true) requireEvidence("role-assignable", "Role-assignable groups remain blocked: privileged restore and delegated safety resolution are not admitted.")
    if (Array.isArray(resource?.groupTypes ?? step.desired.groupTypes)) {
      const types = (resource?.groupTypes ?? step.desired.groupTypes) as string[]
      if (types.includes("Unified")) requireEvidence("microsoft365", "Microsoft 365 group restore has no matched complete live lifecycle.")
      if (types.includes("DynamicMembership")) requireEvidence("dynamic rule", "Dynamic rule restore remains blocked: paused fixture evidence does not establish safe future beneficiaries.")
    }
    if (intent.action === "member" && step.desired.present === false) {
      if (targetingUnknown) result.blocker = "Conditional Access group targeting could not be determined. TenuVault cannot remove this member. Review the policies and remove the member in Microsoft Entra."
      else if (included || excluded) result.blocker = "TenuVault does not remove members from Conditional Access targeted groups because membership changes can affect policy enforcement. Remove the member in Microsoft Entra."
    }
    if (excluded) requireEvidence("privileged-links", "Conditional Access excluded groups remain blocked: indirect security-response recovery is not admitted.")
    if (principal?.["@odata.type"] === "#microsoft.graph.group") requireEvidence("nested-links", "Nested group relationships have no live round trip or admitted indirect-beneficiary guard.")
    const missingPermission = permissionBlocker(step, result.roleAssignable)
    if (missingPermission) result.blocker ??= missingPermission
    return result
  }
  return {
    ids,
    token, type: folder => typeForFolder(folder)!, ...(scan ? { replacedReferences: scan } : {}), review,
    read: (step, id, readSignal) => retryReads || (readSignal && readSignal !== signal) ? directory9aIO(token, actor, safety, fetchImpl, scan, wait, readSignal ?? signal, false, onReadThrottled).read(step, id, readSignal) : read(step, id),
    locate: async (folder, sourceId) => {
      const path = `${folder === "Users" ? "users" : "groups"}/${identity(sourceId)}`
      const current = await request(path)
      if (current) { cloudObject(current); return { action: "update", current } }
      const deleted = await request(`directory/deletedItems/${identity(sourceId)}`)
      return deleted ? { action: "recycle", current: { ...deleted, restored: false } } : { action: "create", current: null }
    },
    findCreated: async (step, sent, readSignal) => {
      if (retryReads || (readSignal && readSignal !== signal)) return directory9aIO(token, actor, safety, fetchImpl, scan, wait, readSignal ?? signal, false, onReadThrottled).findCreated(step, sent, readSignal)
      if (step.directory?.action === "license") return []
      return (await find(step)).map(item => step.directory?.action === "invite" ? { id: item.id!, ...sent } : item)
    },
    references: async (step, current, desired, readSignal) => {
      if (retryReads || (readSignal && readSignal !== signal)) return directory9aIO(token, actor, safety, fetchImpl, scan, wait, readSignal ?? signal, false, onReadThrottled).references(step, current, desired, readSignal)
      requirePermissions(step)
      const result = await review(step)
      requirePermissions(step, result.roleAssignable)
      if (result.blocker) throw new RestoreSafetyError(result.blocker)
      const refs = await safety(step, current, desired)
      if (step.directory?.principalId) refs.principals = [...refs.principals, step.directory.principalId]
      return refs
    },
    write: async (step, body, targetId, beforeSend, run, writeSignal, onUnapplied) => {
      if (retryReads || (writeSignal && writeSignal !== signal)) return directory9aIO(token, actor, safety, fetchImpl, scan, wait, writeSignal ?? signal, false, onReadThrottled).write(step, body, targetId, beforeSend, run, writeSignal, onUnapplied)
      return retryDirectoryWrite(async () => {
        if (signal?.aborted) throw new RestoreWriteDeferredError("The directory write was cancelled before sending.")
        requireRestoreActor(token, actor)
        if (restoreFingerprint(body) !== restoreFingerprint(step.desired)) throw new RestoreSafetyError("The directory write no longer matches its approved difference.")
        const type = typeForFolder(step.folder), row = restoreMatrixRow(step.folder)
        if (!type || restoreCapability(type) === "none" || !row || directoryAdmission(step)) throw new RestoreSafetyError(directoryAdmission(step) ?? DIRECTORY_9A_BLOCKER)
        requirePermissions(step)
        const result = await review(step)
        requirePermissions(step, result.roleAssignable)
        if (result.blocker) throw new RestoreSafetyError(result.blocker)
        requireDirectoryApprovals(step, run, result.approvals)
        const admittedFields = step.folder === "Users" ? (step.directory?.action === "create" ? ["displayName", "mailNickname", "userPrincipalName", "accountEnabled"] : ["displayName"]) : ["description"]
        if (["create", "update"].includes(step.directory!.action) && !(step.folder === "Groups" && step.directory?.action === "create") && Object.keys(body).some(name => !admittedFields.includes(name))) throw new RestoreSafetyError("Only the live-verified directory metadata subset can be restored.")
        const action = step.directory!.action
        const path = target(step, targetId)
        let method = "PATCH", writePath = path, payload: Item | undefined = body
        if (action === "create" || action === "update") {
          const rebuilt = directoryPayload(step.folder, action, { ...(step.folder === "Groups" && action === "update" ? await request(path) : {}), ...body })
          // Only the projected supported properties may reach Graph.
          if (Object.keys(body).some(key => !(key in rebuilt) || JSON.stringify(body[key]) !== JSON.stringify(rebuilt[key]))) throw new RestoreSafetyError("Unsupported directory write property.")
          if (action === "create") { method = "POST"; writePath = folderPath(step); payload = step.folder === "Users" ? disabledUserBody(body) : body }
        } else if (action === "recycle") { method = "POST"; writePath = `directory/deletedItems/${identity(targetId ?? step.sourceId)}/restore`; payload = {} }
        else if (action === "invite") {
          if (body.sendInvitationMessage !== false || typeof body.invitedUserEmailAddress !== "string" || typeof body.inviteRedirectUrl !== "string") throw new RestoreSafetyError("A guest invitation needs its own reviewed address and redirect, without automatic email.")
          method = "POST"; writePath = "invitations"
        } else if (["member", "owner"].includes(action)) {
          const relation = action === "member" ? "members" : "owners", principalId = identity(step.directory!.principalId)
          if (body.principalId !== principalId || typeof body.present !== "boolean") throw new RestoreSafetyError("The relationship no longer matches its preview.")
          method = body.present ? "POST" : "DELETE"
          writePath = `${path}/${relation}/${body.present ? "" : principalId + "/"}$ref`
          payload = body.present ? { "@odata.id": root + "directoryObjects/" + principalId } : undefined
        } else if (action === "manager") {
          const principalId = identity(step.directory!.principalId)
          if (body.principalId !== principalId) throw new RestoreSafetyError("The manager no longer matches its preview.")
          method = "PUT"; writePath = `${path}/manager/$ref`; payload = { "@odata.id": root + "users/" + principalId }
        } else if (action === "license") {
          if (!Array.isArray(body.assignedLicenses) || body.assignedLicenses.length !== 1) throw new RestoreSafetyError("Review one license assignment per user and SKU.")
          const license = body.assignedLicenses[0] as Item
          identity(license?.skuId)
          if (!Array.isArray(license.disabledPlans) || license.disabledPlans.some(plan => !isGuid(plan))) throw new RestoreSafetyError("Invalid disabled license plans.")
          method = "POST"; writePath = `${path}/assignLicense`; payload = { addLicenses: [license], removeLicenses: [] }
        } else throw new RestoreSafetyError("Unsupported directory intent.")
        const response = await request(writePath, method, payload, async () => {
          const current = await read(step, targetId)
          if (restoreFingerprint(current) !== step.preview) throw new RestoreSafetyError("The tenant changed before sending. Preview this item again.")
          const fresh = await review(step, current)
          if (fresh.blocker) throw new RestoreSafetyError(fresh.blocker)
          requireDirectoryApprovals(step, run, fresh.approvals)
          const references = await safety(step, current, body)
          if (step.directory?.principalId) references.principals = [...references.principals, step.directory.principalId]
          guardRestoreItem(actor, step.folder, targetId, references, step.allowRemoval === true, guardedProtections(step))
        }, beforeSend)
        const id = action === "invite" ? (response?.invitedUser as Item | undefined)?.id : response?.id ?? targetId
        return { id: identity(id) }
      }, onUnapplied, signal, wait)
    },
  }
}
