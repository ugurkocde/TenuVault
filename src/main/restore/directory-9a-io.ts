import { typeForFolder, restoreCapability, type Item } from "../../shared/intune/registry"
import { operationProtections, restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { RestoreSafetyError, RestoreWriteRefusedError, guardRestoreItem, type RestoreActor } from "../../shared/intune/restore-guards"
import { isGuid } from "../../shared/security"
import { graphContinuation } from "../../shared/graph-continuation"
import { grantedPermissions } from "../../shared/services/token"
import { requireRestoreActor } from "./restore-actor"
import { directoryPayload, directoryReview, disabledUserBody, requireDirectoryApprovals, cloudObject, DIRECTORY_9A_BLOCKER } from "./directory-9a"
import { restoreFingerprint, type GuardedIO, type GuardedStep } from "./guarded-run"

const root = "https://graph.microsoft.com/v1.0/"
const identity = (id: unknown): string => {
  if (!isGuid(id)) throw new RestoreSafetyError("A directory object ID could not be resolved.")
  return id
}
/** Least privilege by operation. Blocked operations contribute no product setup permission. */
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
/** No production caller is wired in phase 1. Both the runner and this final transport retain admission gates. */
export function directory9aIO(token: string, actor: RestoreActor, safety: GuardedIO["references"], fetchImpl: typeof fetch = fetch, scan?: GuardedIO["replacedReferences"], wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): GuardedIO & { review: (step: GuardedStep) => Promise<ReturnType<typeof directoryReview>>; locate: (folder: "Users" | "Groups", sourceId: string) => Promise<{ action: "update" | "recycle" | "create"; current: Item | null }> } {
  requireRestoreActor(token, actor)
  const request = async (path: string, method = "GET", body?: Item, beforeRetry?: () => Promise<void>): Promise<Item | null> => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(root + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
      if (response.status === 429 && attempt < 4) {
        await wait(Math.min(60_000, Math.max(1000, Number(response.headers.get("Retry-After")) * 1000 || 1000)))
        if (method !== "GET") {
          try { if (!beforeRetry) throw new Error("No reviewed retry"); await beforeRetry() } catch { throw new RestoreWriteRefusedError(429) }
        }
        continue
      }
      if (method === "GET" && response.status === 404) return null
      if (method !== "GET" && response.status >= 400 && response.status < 500 && response.status !== 408) throw new RestoreWriteRefusedError(response.status)
      if (!response.ok) throw new Error("Directory request was not confirmed. No response body is retained.")
      return response.status === 204 ? {} : await response.json() as Item
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
    for await (const user of list(`users?$filter=${encodeURIComponent(`${field} eq '${value.replaceAll("'", "''")}'`)}`)) { matches.push(user); if (matches.length > 1) break }
    return matches
  }
  const resolvePrincipal = async (id: string): Promise<Item | null> => {
    const user = await request(`users/${identity(id)}`)
    if (user) {
      if (user.id !== id) throw new RestoreSafetyError("The user identity did not match its reference.")
      return { ...user, "@odata.type": "#microsoft.graph.user" }
    }
    const group = await request(`groups/${identity(id)}`)
    if (group?.id !== id && group !== null) throw new RestoreSafetyError("The group identity did not match its reference.")
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
  const review = async (step: GuardedStep) => {
    const intent = step.directory
    if (!intent) throw new RestoreSafetyError("A directory intent is required.")
    let resource = step.operation === "create" ? null : await request(target(step))
    if (!resource && intent.action === "recycle") resource = await request(`directory/deletedItems/${identity(step.targetId ?? step.sourceId)}`)
    if (resource) { cloudObject(resource); if (step.folder === "Groups") directoryPayload("Groups", "update", resource) }
    const principal = intent.principalId ? await resolvePrincipal(intent.principalId) : null
    let excluded = false
    if (step.folder === "Groups" && (["member", "owner"].includes(intent.action) || (intent.action === "update" && (step.desired.membershipRule !== undefined || step.desired.membershipRuleProcessingState !== undefined)))) {
      if (!resource || typeof resource.isAssignableToRole !== "boolean") throw new RestoreSafetyError("The group's privilege could not be resolved.")
      for await (const policy of list("identity/conditionalAccess/policies?$select=id,conditions")) {
        const users = (policy.conditions as Item | undefined)?.users as Item | undefined
        if (!users || !Array.isArray(users.excludeGroups)) throw new RestoreSafetyError("Conditional Access exclusions could not be resolved.")
        if (users.excludeGroups.includes(step.targetId ?? step.sourceId)) excluded = true
      }
    }
    return directoryReview(step, resource, principal, actor, excluded)
  }
  return {
    token, type: folder => typeForFolder(folder)!, ...(scan ? { replacedReferences: scan } : {}), read, review,
    locate: async (folder, sourceId) => {
      const path = `${folder === "Users" ? "users" : "groups"}/${identity(sourceId)}`
      const current = await request(path)
      if (current) { cloudObject(current); return { action: "update", current } }
      const deleted = await request(`directory/deletedItems/${identity(sourceId)}`)
      return deleted ? { action: "recycle", current: { ...deleted, restored: false } } : { action: "create", current: null }
    },
    findCreated: async (step, sent) => {
      if (step.directory?.action === "license") return []
      return (await find(step)).map(item => step.directory?.action === "invite" ? { id: item.id!, ...sent } : item)
    },
    references: async (step, current, desired) => {
      const result = await review(step)
      if (result.blocker) throw new RestoreSafetyError(result.blocker)
      const refs = await safety(step, current, desired)
      if (step.directory?.principalId) refs.principals = [...refs.principals, step.directory.principalId]
      return refs
    },
    write: async (step, body, targetId, beforeSend, run) => {
      requireRestoreActor(token, actor)
      const type = typeForFolder(step.folder), row = restoreMatrixRow(step.folder)
      if (!type || restoreCapability(type) === "none" || row?.directoryRestore?.phase !== "enabled" || row.directoryRestore.evidence?.[step.directory?.action ?? ""]?.result !== "round-trip-matched") throw new RestoreSafetyError(DIRECTORY_9A_BLOCKER)
      const result = await review(step)
      if (result.blocker) throw new RestoreSafetyError(result.blocker)
      requireDirectoryApprovals(step, run, result.approvals)
      const permissions = directoryPermissions(step)
      if (result.roleAssignable && ["create", "member"].includes(step.directory!.action)) permissions.push("RoleManagement.ReadWrite.Directory")
      const granted = grantedPermissions(token)
      if (granted?.kind !== "delegated" || permissions.some(permission => !granted.permissions.has(permission))) throw new RestoreSafetyError("The signed-in connection lacks this operation's least-privileged permission.")
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
      beforeSend()
      // License writes are never replayed, including on a definite throttle or lost response.
      const response = action === "license" ? await (async () => {
        const answer = await fetchImpl(root + writePath, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000) })
        if (!answer.ok) throw new RestoreWriteRefusedError(answer.status)
        return await answer.json() as Item
      })() : await request(writePath, method, payload, async () => {
        const current = await read(step, targetId)
        if (restoreFingerprint(current) !== step.preview) throw new RestoreSafetyError("The tenant changed while throttled. Preview this item again.")
        const fresh = await review(step)
        if (fresh.blocker) throw new RestoreSafetyError(fresh.blocker)
        requireDirectoryApprovals(step, run, fresh.approvals)
        const references = await safety(step, current, body)
        if (step.directory?.principalId) references.principals = [...references.principals, step.directory.principalId]
        guardRestoreItem(actor, step.folder, targetId, references, step.allowRemoval === true, operationProtections(step.folder, step.operation))
      })
      const id = action === "invite" ? (response?.invitedUser as Item | undefined)?.id : response?.id ?? targetId
      return { id: identity(id) }
    },
  }
}
