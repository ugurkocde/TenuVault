import { rejectProxyAuthResponses } from "../api/network-error"
import { DirectoryReadDeferredError, DirectoryThrottledError, retryDirectoryWrite } from "./directory-retry"
import { typeForFolder, type Item } from "../../shared/intune/registry"
import { graphContinuation } from "../../shared/graph-continuation"
import { directoryPermissionBlocker } from "./directory-permissions"
import { directoryReadShape } from "./directory-read-shape"
import { RestoreSafetyError, RestoreWriteDeferredError, RestoreWriteRefusedError, guardRestoreItem, type RestoreActor } from "../../shared/intune/restore-guards"
import { requireRestoreActor } from "./restore-actor"
import { requireDirectoryApprovals } from "./directory-9a"
import { appIdentity, applicationAdmission, applicationPermissions, applicationReview, restorableApp, requireApplicationRestoreAccess } from "./directory-9b"
import { assertNoSecrets, isRestorePersistenceError, restoreFingerprint, type GuardedIO, type GuardedStep } from "./guarded-run"
import type { ModuleSetting } from "../services/settings"

const root = "https://graph.microsoft.com/v1.0/"
const collection = (folder: string) => {
  if (folder === "Applications") return "applications"
  if (folder === "ServicePrincipals") return "servicePrincipals"
  if (folder === "OAuth2PermissionGrants") return "oauth2PermissionGrants"
  throw new RestoreSafetyError("Outside application restore scope.")
}
/** Application operations plug into the existing directory journal, batching and approval service. */
export function directory9bIO(token: string, actor: RestoreActor, fetchImpl: typeof fetch = fetch, protectedAppIds: () => readonly string[] = () => [], settings: () => ModuleSetting | undefined = () => undefined, wait?: (ms: number) => Promise<void>, onReadThrottled?: (retryAt: number) => void) {
  requireRestoreActor(token, actor)
  const fetchRequest = rejectProxyAuthResponses(fetchImpl)
  const request = async (path: string, method = "GET", body?: Item, signal?: AbortSignal): Promise<Item | null> => {
    if (signal?.aborted) throw new RestoreWriteDeferredError("The application request was cancelled before sending.")
    const response = await fetchRequest(root + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: method === "GET" && signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) }).catch(error => {
      if (isRestorePersistenceError(error)) throw error
      if (method === "GET" && signal?.aborted) throw new RestoreWriteDeferredError("The application read was cancelled before sending a write.")
      if (method === "GET") throw new DirectoryReadDeferredError()
      throw error
    })
    if (response.status === 404 && method === "GET") return null
    if (!response.ok) {
      if (response.status === 429) {
        const error = new DirectoryThrottledError(response)
        if (method === "GET") onReadThrottled?.(error.retryAt!)
        throw error
      }
      if (method === "GET" && (response.status === 408 || response.status >= 500)) throw new DirectoryReadDeferredError()
      // A dispatched PATCH may have committed before a timeout or gateway failure.
      // Keep the durable send marker uncertain so restart reconciles by read-back only.
      if (method === "PATCH" && (response.status === 408 || response.status >= 500)) throw new Error("The application write has an unconfirmed result.")
      throw new RestoreWriteRefusedError(response.status)
    }
    if (method === "GET" && !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) throw new DirectoryReadDeferredError()
    if (response.status === 204) {
      if (method === "GET") throw new DirectoryReadDeferredError()
      return {}
    }
    const text = await response.text().catch(error => {
      if (isRestorePersistenceError(error)) throw error
      if (method === "GET" && signal?.aborted) throw new RestoreWriteDeferredError("The application read was cancelled before sending a write.")
      if (method === "GET") throw new DirectoryReadDeferredError()
      throw error
    })
    try {
      const value: unknown = JSON.parse(text)
      return method === "GET" ? directoryReadShape(value, new URL(root + path)) : value as Item
    }
    catch (error) {
      if (method === "GET") throw new DirectoryReadDeferredError()
      throw error
    }
  }
  async function* list(path: string, signal?: AbortSignal): AsyncGenerator<Item> {
    const start = root + path, seen = new Set<string>()
    let next: string | undefined = start
    while (next) {
      const page = await request(graphContinuation(start, next, seen).slice(root.length), "GET", undefined, signal)
      if (!Array.isArray(page?.value)) throw new RestoreSafetyError("Application reference collection is incomplete.")
      for (const item of page.value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new RestoreSafetyError("Application reference collection is malformed.")
        yield item as Item
      }
      if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new RestoreSafetyError("Invalid application continuation.")
      next = page["@odata.nextLink"] as string | undefined
    }
  }
  const object = async (folder: string, id: string, deleted = false, expectedAppId?: string, signal?: AbortSignal): Promise<Item | null> => {
    const item = await request(`${deleted ? "directory/deletedItems" : collection(folder)}/${appIdentity(id)}?$select=id,appId,displayName,description,notes${folder === "ServicePrincipals" ? ",appOwnerOrganizationId,servicePrincipalType,tags" : ""}`, "GET", undefined, signal)
    if (!item) return null
    if (appIdentity(item.id) !== appIdentity(id)) throw new RestoreSafetyError("The application target identity changed.")
    restorableApp(item, folder, false, protectedAppIds())
    if (expectedAppId && appIdentity(item.appId) !== appIdentity(expectedAppId)) throw new RestoreSafetyError("The saved application app ID does not match the live target.")
    if (folder !== "Applications" || deleted) return item
    // appOwnerOrganizationId is documented on servicePrincipal, not application.
    // Resolve the same appId and apply the established first-party check to its owner.
    const principal = await resolveApp(appIdentity(item.appId), signal)
    restorableApp(principal, "ServicePrincipals", true, protectedAppIds())
    const live = await request(`applications/${appIdentity(id)}?$select=id,appId,displayName,description,notes`, "GET", undefined, signal)
    if (!live || appIdentity(live.id) !== appIdentity(id) || appIdentity(live.appId) !== appIdentity(item.appId)) throw new RestoreSafetyError("The application target identity changed.")
    restorableApp(live, folder, false, protectedAppIds())
    if (expectedAppId && appIdentity(live.appId) !== appIdentity(expectedAppId)) throw new RestoreSafetyError("The saved application app ID does not match the live target.")
    return { ...live, appOwnerOrganizationId: principal.appOwnerOrganizationId!, servicePrincipalType: principal.servicePrincipalType!, servicePrincipalId: principal.id! }
  }
  const resolveApp = async (appId: string, signal?: AbortSignal): Promise<Item> => {
    const matches: Item[] = []
    for await (const item of list(`servicePrincipals?$filter=${encodeURIComponent(`appId eq '${appIdentity(appId)}'`)}&$select=id,appId,displayName,appOwnerOrganizationId,servicePrincipalType,appRoles,oauth2PermissionScopes`, signal)) {
      if (String(item.appId).toLowerCase() !== appId.toLowerCase()) throw new RestoreSafetyError("The app ID lookup returned another application.")
      matches.push(item)
      if (matches.length > 1) break
    }
    if (matches.length !== 1) throw new RestoreSafetyError("An app ID is unresolved or ambiguous. This relationship is blocked.")
    appIdentity(matches[0]!.id)
    return { ...matches[0]!, "@odata.type": "#microsoft.graph.servicePrincipal" }
  }
  const resolveUser = async (id: string, signal?: AbortSignal): Promise<Item> => {
    const user = await request(`users/${appIdentity(id)}?$select=id,displayName,onPremisesSyncEnabled`, "GET", undefined, signal)
    if (!user || user.id !== id) throw new RestoreSafetyError("The user principal is unresolved.")
    return { ...user, "@odata.type": "#microsoft.graph.user" }
  }
  const endpoints = async (step: GuardedStep, signal?: AbortSignal) => {
    const intent = step.directory!
    const resource = await resolveApp(intent.resourceAppId!, signal)
    const client = intent.clientAppId ? await resolveApp(intent.clientAppId, signal) : null
    if (client) restorableApp(client, "ServicePrincipals")
    const principal = intent.principalId ? await resolveUser(intent.principalId, signal) : client
    if (!principal) throw new RestoreSafetyError("The relationship principal is unresolved.")
    return { resource, client, principal }
  }
  const read: GuardedIO["read"] = async (step, targetId, signal) => {
    const action = step.directory!.action
    if (action === "consent" || action === "app-role") {
      const { resource, client, principal } = await endpoints(step, signal)
      const path = action === "consent" ? `oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${appIdentity(client!.id)}'`)}` : `servicePrincipals/${appIdentity(principal.id)}/appRoleAssignments`
      let match: Item | null = null
      for await (const item of list(path, signal)) {
        if (item.resourceId !== resource.id) continue
        if (action === "consent" ? item.clientId !== client!.id || item.consentType !== step.desired.consentType || (item.principalId ?? null) !== (step.desired.principalId ?? null) : item.principalId !== principal.id || item.appRoleId !== step.desired.appRoleId) continue
        if (match) throw new RestoreSafetyError("The relationship is ambiguous.")
        match = item
      }
      return match
    }
    if (action === "policy" || step.directory?.unresolved) return null
    if (action === "owner") {
      const resource = await object(step.folder, step.targetId ?? step.sourceId, false, undefined, signal)
      if (!resource) throw new RestoreSafetyError("The ownership resource is missing.")
      const principal = await resolveUser(step.directory!.principalId!, signal)
      let present = false
      for await (const owner of list(`${collection(step.folder)}/${appIdentity(resource.id)}/owners?$select=id`, signal)) if (owner.id === principal.id) present = true
      return { id: resource.id!, present, principalId: principal.id!, resource, principal }
    }
    if (action === "recycle") {
      const live = await object(step.folder, targetId ?? step.sourceId, false, undefined, signal)
      return live ? { ...live, restored: true } : object(step.folder, targetId ?? step.sourceId, true, undefined, signal)
    }
    return object(step.folder, targetId ?? step.targetId ?? step.sourceId, false, step.directory?.expectedAppId, signal)
  }
  const review = async (step: GuardedStep, preimage?: Item | null, signal?: AbortSignal) => {
    const action = step.directory!.action
    if (step.directory?.unresolved || action === "policy") return applicationReview(step, null, { id: step.targetId ?? step.sourceId, displayName: "Application reference" }, null, actor)
    const current = preimage === undefined ? await read(step, step.targetId, signal) : preimage
    let resource: Item, principal: Item | null = null
    if (action === "consent" || action === "app-role") {
      const resolved = await endpoints(step, signal); resource = resolved.resource; principal = resolved.principal
    } else {
      resource = action === "owner" ? current?.resource as Item : current ?? { ...step.desired, id: step.sourceId }
      if (action === "owner") principal = current?.principal as Item
    }
    return applicationReview(step, current, resource, principal, actor)
  }
  const permissionBlocker = (step: GuardedStep) => directoryPermissionBlocker(token, applicationPermissions(step))
  const requirePermissions = (step: GuardedStep) => {
    const blocker = permissionBlocker(step)
    if (blocker) throw new RestoreWriteDeferredError(blocker)
  }
  const preview = async (step: GuardedStep) => {
    requireApplicationRestoreAccess(settings())
    const current = await read(step, step.targetId)
    assertNoSecrets(current)
    step.preview = restoreFingerprint(current)
    if (step.folder === "Applications" && step.directory?.action === "update") {
      step.desired = Object.fromEntries(Object.entries(step.desired).filter(([key, value]) => JSON.stringify(current?.[key]) !== JSON.stringify(value)))
      step.properties = Object.keys(step.desired)
    }
    const result = await review(step, current)
    const missingPermission = permissionBlocker(step)
    if (missingPermission) result.blocker ??= missingPermission
    return result
  }
  const references: GuardedIO["references"] = async (step, _current, _desired, signal) => {
    requirePermissions(step)
    const result = await review(step, undefined, signal)
    if (result.blocker) throw new RestoreSafetyError(result.blocker)
    return { complete: true, principals: result.principal ? [result.principal.id] : [], applications: [result.resource.id, step.directory?.clientAppId ?? "", step.directory?.resourceAppId ?? ""] }
  }
  const hydrate = async (step: GuardedStep, signal?: AbortSignal) => {
    if (step.directory?.action !== "app-role" || step.directory.unresolved) return
    const { resource, principal } = await endpoints(step, signal)
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
    write: async (step, body, targetId, beforeSend, run, signal, onUnapplied) => {
      return retryDirectoryWrite(async () => {
        let dispatched = false
        try {
          if (signal?.aborted) throw new RestoreWriteDeferredError("The application write was cancelled before sending.")
          requireRestoreActor(token, actor)
          const blocker = applicationAdmission(step)
          if (blocker) throw new RestoreSafetyError(blocker)
          if (!run || run.origin !== "restore" || run.tenant !== actor.tenantId || !run.source) throw new RestoreSafetyError("Application access can only be restored from an owned same-tenant backup.")
          requireDirectoryApprovals(step, run, ["directory-item"])
          requirePermissions(step)
          const path = `applications/${appIdentity(targetId)}`
          // Build only the exact reviewed changes. No live field is copied into the PATCH.
          const payload = Object.fromEntries(Object.entries(body).filter(([key, value]) => ["displayName", "description"].includes(key) && typeof value === "string" && value.trim()))
          if (!Object.keys(payload).length || restoreFingerprint(payload) !== restoreFingerprint(body) || restoreFingerprint(body) !== restoreFingerprint(step.desired) || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...step.properties].sort())) throw new RestoreSafetyError("Unsupported application write properties.")
          appIdentity(step.directory!.expectedAppId)
          const current = await read(step, targetId, signal)
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
          dispatched = true
          await request(path, "PATCH", payload, signal)
          return { id: targetId }
        } catch (error) {
          if (isRestorePersistenceError(error)) throw error
          if (!(error instanceof DirectoryThrottledError) && !dispatched && signal?.aborted) throw new RestoreWriteDeferredError("The application write was cancelled before sending.")
          throw error
        }
      }, onUnapplied, signal, wait)
    },
  }
  return { ...io, review, preview, hydrate, list, object, resolveApp, resolveUser, async locate(folder: string, sourceId: string) {
    const live = await object(folder, sourceId)
    if (live) { restorableApp(live, folder); return { action: "update" as const, current: live } }
    const deleted = await object(folder, sourceId, true)
    return deleted ? { action: "recycle" as const, current: deleted } : { action: "create" as const, current: null }
  } }
}
