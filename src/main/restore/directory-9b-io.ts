import { typeForFolder, type Item } from "../../shared/intune/registry"
import { graphContinuation } from "../../shared/graph-continuation"
import { grantedPermissions } from "../../shared/services/token"
import { RestoreSafetyError, RestoreWriteDeferredError, RestoreWriteRefusedError, guardRestoreItem, type RestoreActor } from "../../shared/intune/restore-guards"
import { requireRestoreActor } from "./restore-actor"
import { requireDirectoryApprovals } from "./directory-9a"
import { appIdentity, applicationAdmission, applicationPermissions, applicationReview, restorableApp, requireApplicationRestoreAccess } from "./directory-9b"
import { restoreFingerprint, type GuardedIO, type GuardedStep } from "./guarded-run"
import type { ModuleSetting } from "../services/settings"

const root = "https://graph.microsoft.com/v1.0/"
const collection = (folder: string) => {
  if (folder === "Applications") return "applications"
  if (folder === "ServicePrincipals") return "servicePrincipals"
  if (folder === "OAuth2PermissionGrants") return "oauth2PermissionGrants"
  throw new RestoreSafetyError("Outside application restore scope.")
}
/** Application operations plug into the existing directory journal, batching and approval service. */
export function directory9bIO(token: string, actor: RestoreActor, fetchImpl: typeof fetch = fetch, protectedAppIds: () => readonly string[] = () => [], settings: () => ModuleSetting | undefined = () => undefined) {
  requireRestoreActor(token, actor)
  const request = async (path: string, method = "GET", body?: Item, signal?: AbortSignal): Promise<Item | null> => {
    if (signal?.aborted) throw new RestoreWriteDeferredError("The application request was cancelled before sending.")
    const response = await fetchImpl(root + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) })
    if (response.status === 404 && method === "GET") return null
    if (!response.ok) {
      // A dispatched PATCH may have committed before a timeout, throttle or gateway failure.
      // Keep the durable send marker uncertain so restart reconciles by read-back only.
      if (method === "PATCH" && (response.status === 408 || response.status === 429 || response.status >= 500)) throw new Error("The application write has an unconfirmed result.")
      throw new RestoreWriteRefusedError(response.status)
    }
    return response.status === 204 ? {} : await response.json() as Item
  }
  async function* list(path: string): AsyncGenerator<Item> {
    const start = root + path, seen = new Set<string>()
    let next: string | undefined = start
    while (next) {
      const page = await request(graphContinuation(start, next, seen).slice(root.length))
      if (!Array.isArray(page?.value)) throw new RestoreSafetyError("Application reference collection is incomplete.")
      for (const item of page.value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new RestoreSafetyError("Application reference collection is malformed.")
        yield item as Item
      }
      if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new RestoreSafetyError("Invalid application continuation.")
      next = page["@odata.nextLink"] as string | undefined
    }
  }
  const object = async (folder: string, id: string, deleted = false, expectedAppId?: string): Promise<Item | null> => {
    const item = await request(`${deleted ? "directory/deletedItems" : collection(folder)}/${appIdentity(id)}?$select=id,appId,displayName,description,notes${folder === "ServicePrincipals" ? ",appOwnerOrganizationId,servicePrincipalType,tags" : ""}`)
    if (!item) return null
    if (appIdentity(item.id) !== appIdentity(id)) throw new RestoreSafetyError("The application target identity changed.")
    restorableApp(item, folder, false, protectedAppIds())
    if (expectedAppId && appIdentity(item.appId) !== appIdentity(expectedAppId)) throw new RestoreSafetyError("The saved application app ID does not match the live target.")
    if (folder !== "Applications" || deleted) return item
    // appOwnerOrganizationId is documented on servicePrincipal, not application.
    // Resolve the same appId and apply the established first-party check to its owner.
    const principal = await resolveApp(appIdentity(item.appId))
    restorableApp(principal, "ServicePrincipals", true, protectedAppIds())
    const live = await request(`applications/${appIdentity(id)}?$select=id,appId,displayName,description,notes`)
    if (!live || appIdentity(live.id) !== appIdentity(id) || appIdentity(live.appId) !== appIdentity(item.appId)) throw new RestoreSafetyError("The application target identity changed.")
    restorableApp(live, folder, false, protectedAppIds())
    if (expectedAppId && appIdentity(live.appId) !== appIdentity(expectedAppId)) throw new RestoreSafetyError("The saved application app ID does not match the live target.")
    return { ...live, appOwnerOrganizationId: principal.appOwnerOrganizationId!, servicePrincipalType: principal.servicePrincipalType!, servicePrincipalId: principal.id! }
  }
  const resolveApp = async (appId: string): Promise<Item> => {
    const matches: Item[] = []
    for await (const item of list(`servicePrincipals?$filter=${encodeURIComponent(`appId eq '${appIdentity(appId)}'`)}&$select=id,appId,displayName,appOwnerOrganizationId,servicePrincipalType,appRoles,oauth2PermissionScopes`)) {
      if (String(item.appId).toLowerCase() !== appId.toLowerCase()) throw new RestoreSafetyError("The app ID lookup returned another application.")
      matches.push(item)
      if (matches.length > 1) break
    }
    if (matches.length !== 1) throw new RestoreSafetyError("An app ID is unresolved or ambiguous. This relationship is blocked.")
    appIdentity(matches[0]!.id)
    return { ...matches[0]!, "@odata.type": "#microsoft.graph.servicePrincipal" }
  }
  const resolveUser = async (id: string): Promise<Item> => {
    const user = await request(`users/${appIdentity(id)}?$select=id,displayName,onPremisesSyncEnabled`)
    if (!user || user.id !== id) throw new RestoreSafetyError("The user principal is unresolved.")
    return { ...user, "@odata.type": "#microsoft.graph.user" }
  }
  const endpoints = async (step: GuardedStep) => {
    const intent = step.directory!
    const resource = await resolveApp(intent.resourceAppId!)
    const client = intent.clientAppId ? await resolveApp(intent.clientAppId) : null
    if (client) restorableApp(client, "ServicePrincipals")
    const principal = intent.principalId ? await resolveUser(intent.principalId) : client
    if (!principal) throw new RestoreSafetyError("The relationship principal is unresolved.")
    return { resource, client, principal }
  }
  const read: GuardedIO["read"] = async (step, targetId) => {
    const action = step.directory!.action
    if (action === "consent" || action === "app-role") {
      const { resource, client, principal } = await endpoints(step)
      const path = action === "consent" ? `oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${appIdentity(client!.id)}'`)}` : `servicePrincipals/${appIdentity(principal.id)}/appRoleAssignments`
      let match: Item | null = null
      for await (const item of list(path)) {
        if (item.resourceId !== resource.id) continue
        if (action === "consent" ? item.clientId !== client!.id || item.consentType !== step.desired.consentType || (item.principalId ?? null) !== (step.desired.principalId ?? null) : item.principalId !== principal.id || item.appRoleId !== step.desired.appRoleId) continue
        if (match) throw new RestoreSafetyError("The relationship is ambiguous.")
        match = item
      }
      return match
    }
    if (action === "policy" || step.directory?.unresolved) return null
    if (action === "owner") {
      const resource = await object(step.folder, step.targetId ?? step.sourceId)
      if (!resource) throw new RestoreSafetyError("The ownership resource is missing.")
      const principal = await resolveUser(step.directory!.principalId!)
      let present = false
      for await (const owner of list(`${collection(step.folder)}/${appIdentity(resource.id)}/owners?$select=id`)) if (owner.id === principal.id) present = true
      return { id: resource.id!, present, principalId: principal.id!, resource, principal }
    }
    if (action === "recycle") {
      const live = await object(step.folder, targetId ?? step.sourceId)
      return live ? { ...live, restored: true } : object(step.folder, targetId ?? step.sourceId, true)
    }
    return object(step.folder, targetId ?? step.targetId ?? step.sourceId, false, step.directory?.expectedAppId)
  }
  const review = async (step: GuardedStep, preimage?: Item | null) => {
    const action = step.directory!.action
    if (step.directory?.unresolved || action === "policy") return applicationReview(step, null, { id: step.targetId ?? step.sourceId, displayName: "Application reference" }, null, actor)
    const current = preimage === undefined ? await read(step, step.targetId) : preimage
    let resource: Item, principal: Item | null = null
    if (action === "consent" || action === "app-role") {
      const resolved = await endpoints(step); resource = resolved.resource; principal = resolved.principal
    } else {
      resource = action === "owner" ? current?.resource as Item : current ?? { ...step.desired, id: step.sourceId }
      if (action === "owner") principal = current?.principal as Item
    }
    return applicationReview(step, current, resource, principal, actor)
  }
  const preview = async (step: GuardedStep) => {
    requireApplicationRestoreAccess(settings())
    const current = await read(step, step.targetId)
    step.preview = restoreFingerprint(current)
    if (step.folder === "Applications" && step.directory?.action === "update") {
      step.desired = Object.fromEntries(Object.entries(step.desired).filter(([key, value]) => JSON.stringify(current?.[key]) !== JSON.stringify(value)))
      step.properties = Object.keys(step.desired)
    }
    return review(step, current)
  }
  const references: GuardedIO["references"] = async step => {
    const result = await review(step)
    if (result.blocker) throw new RestoreSafetyError(result.blocker)
    return { complete: true, principals: result.principal ? [result.principal.id] : [], applications: [result.resource.id, step.directory?.clientAppId ?? "", step.directory?.resourceAppId ?? ""] }
  }
  const hydrate = async (step: GuardedStep) => {
    if (step.directory?.action !== "app-role" || step.directory.unresolved) return
    const { resource, principal } = await endpoints(step)
    const role = Array.isArray(resource.appRoles) ? (resource.appRoles as Item[]).find(role => role.id === step.desired.appRoleId && role.isEnabled === true) : null
    if (!role) throw new RestoreSafetyError("The app role no longer resolves. A typed app-role mapping is required.")
    step.directory.roleName = String(role.displayName ?? role.value ?? role.id)
    step.desired = { principalId: principal.id!, resourceId: resource.id!, appRoleId: role.id! }; step.properties = Object.keys(step.desired)
    const current = await read(step)
    if (current) { step.operation = "update"; step.targetId = String(current.id) }
  }
  const io: GuardedIO = {
    token, type: folder => typeForFolder(folder)!, read, references,
    // Display names are not unique and cannot reconcile app or gallery creation.
    findCreated: async step => step.directory?.action === "create" && step.folder === "Applications" || step.directory?.action === "gallery" ? [] : (await read(step) ? [await read(step) as Item] : []),
    write: async (step, body, targetId, beforeSend, run, signal) => {
      if (signal?.aborted) throw new RestoreWriteDeferredError("The application write was cancelled before sending.")
      requireRestoreActor(token, actor)
      const blocker = applicationAdmission(step)
      if (blocker) throw new RestoreSafetyError(blocker)
      if (!run || run.origin !== "restore" || run.tenant !== actor.tenantId || !run.source) throw new RestoreSafetyError("Application access can only be restored from an owned same-tenant backup.")
      requireDirectoryApprovals(step, run, ["directory-item"])
      const granted = grantedPermissions(token)
      if (granted?.kind !== "delegated" || applicationPermissions(step).some(permission => !granted.permissions.has(permission))) throw new RestoreSafetyError("The signed-in connection lacks this operation's least-privileged permission.")
      const path = `applications/${appIdentity(targetId)}`
      // Build only the exact reviewed changes. No live field is copied into the PATCH.
      const payload = Object.fromEntries(Object.entries(body).filter(([key, value]) => ["displayName", "description"].includes(key) && typeof value === "string" && value.trim()))
      if (!Object.keys(payload).length || restoreFingerprint(payload) !== restoreFingerprint(body) || restoreFingerprint(body) !== restoreFingerprint(step.desired) || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...step.properties].sort())) throw new RestoreSafetyError("Unsupported application write properties.")
      appIdentity(step.directory!.expectedAppId)
      const current = await read(step, targetId)
      if (restoreFingerprint(current) !== step.preview) throw new RestoreSafetyError("The tenant changed. Preview this application again.")
      if (Object.entries(payload).some(([key, value]) => JSON.stringify(current?.[key]) === JSON.stringify(value))) throw new RestoreSafetyError("Send only the changed metadata keys shown in review.")
      const result = await review(step, current)
      if (result.blocker) throw new RestoreSafetyError(result.blocker)
      requireDirectoryApprovals(step, run, result.approvals)
      guardRestoreItem(actor, step.folder, targetId, { complete: true, principals: [], applications: [String(current?.id), String(current?.appId)] }, false, ["identity-references"])
      // Read saved opt-in again after all asynchronous checks, before recording a send.
      // Reads stay available so already-sent writes can reconcile after opt-out.
      requireApplicationRestoreAccess(settings())
      if (signal?.aborted) throw new RestoreWriteDeferredError("The application write was cancelled before sending.")
      beforeSend()
      await request(path, "PATCH", payload, signal)
      return { id: targetId }
    },
  }
  return { ...io, review, preview, hydrate, list, object, resolveApp, resolveUser, async locate(folder: string, sourceId: string) {
    const live = await object(folder, sourceId)
    if (live) { restorableApp(live, folder); return { action: "update" as const, current: live } }
    const deleted = await object(folder, sourceId, true)
    return deleted ? { action: "recycle" as const, current: deleted } : { action: "create" as const, current: null }
  } }
}
