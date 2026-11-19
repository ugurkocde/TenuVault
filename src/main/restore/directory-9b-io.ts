import { typeForFolder, type Item } from "../../shared/intune/registry"
import { directoryObjectId } from "../../shared/intune/entra-directory"
import { graphContinuation } from "../../shared/graph-continuation"
import { grantedPermissions } from "../../shared/services/token"
import { RestoreSafetyError, RestoreWriteDeferredError, RestoreWriteRefusedError, guardRestoreItem, mergeConsentScopes, type RestoreActor } from "../../shared/intune/restore-guards"
import { requireRestoreActor } from "./restore-actor"
import { requireDirectoryApprovals } from "./directory-9a"
import { appIdentity, appPayload, applicationAdmission, applicationPermissions, applicationReview, restorableApp } from "./directory-9b"
import { restoreFingerprint, type GuardedIO, type GuardedStep } from "./guarded-run"

const root = "https://graph.microsoft.com/v1.0/"
const collection = (folder: string) => {
  if (folder === "Applications") return "applications"
  if (folder === "ServicePrincipals") return "servicePrincipals"
  if (folder === "OAuth2PermissionGrants") return "oauth2PermissionGrants"
  throw new RestoreSafetyError("Outside application restore scope.")
}
const grantId = (value: unknown) => {
  if (!directoryObjectId("OAuth2PermissionGrants", value)) throw new RestoreSafetyError("Invalid consent grant identity.")
  return value as string
}
/** Application operations plug into the existing directory journal, batching and approval service. */
export function directory9bIO(token: string, actor: RestoreActor, fetchImpl: typeof fetch = fetch) {
  requireRestoreActor(token, actor)
  const request = async (path: string, method = "GET", body?: Item, signal?: AbortSignal): Promise<Item | null> => {
    signal?.throwIfAborted()
    const response = await fetchImpl(root + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) })
    if (response.status === 404 && method === "GET") return null
    if (!response.ok) throw new RestoreWriteRefusedError(response.status)
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
  const object = (folder: string, id: string, deleted = false) => request(`${deleted ? "directory/deletedItems" : collection(folder)}/${appIdentity(id)}?$select=id,appId,displayName,description${folder === "ServicePrincipals" ? ",appOwnerOrganizationId,servicePrincipalType,tags" : ""}`)
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
    return object(step.folder, targetId ?? step.targetId ?? step.sourceId)
  }
  const review = async (step: GuardedStep) => {
    const action = step.directory!.action
    if (step.directory?.unresolved || action === "policy") return applicationReview(step, null, { id: step.targetId ?? step.sourceId, displayName: "Application reference" }, null, actor)
    let resource: Item, principal: Item | null = null
    if (action === "consent" || action === "app-role") {
      const resolved = await endpoints(step); resource = resolved.resource; principal = resolved.principal
    } else {
      resource = (await object(step.folder, step.targetId ?? step.sourceId, action === "recycle")) ?? { ...step.desired, id: step.sourceId }
      if (action === "owner") principal = await resolveUser(step.directory!.principalId!)
    }
    return applicationReview(step, await read(step, step.targetId), resource, principal, actor)
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
      const result = await review(step)
      if (result.blocker) throw new RestoreSafetyError(result.blocker)
      requireDirectoryApprovals(step, run, result.approvals)
      const granted = grantedPermissions(token)
      if (granted?.kind !== "delegated" || applicationPermissions(step).some(permission => !granted.permissions.has(permission))) throw new RestoreSafetyError("The signed-in connection lacks this operation's least-privileged permission.")
      const current = await read(step, targetId)
      if (restoreFingerprint(current) !== step.preview) throw new RestoreSafetyError("The tenant changed. Preview this application again.")
      const refs = await references(step, current, body)
      guardRestoreItem(actor, step.folder, targetId, refs, false, ["identity-references"])
      const action = step.directory!.action
      let path = collection(step.folder), method = "POST", payload: Item
      if (action === "create" || action === "update") {
        let source = action === "update" ? { ...await object(step.folder, appIdentity(targetId)), ...body } : body
        if (action === "create" && step.folder === "ServicePrincipals") {
          const matches: Item[] = []
          for await (const app of list(`applications?$filter=${encodeURIComponent(`appId eq '${appIdentity(body.appId)}'`)}&$select=id,appId,displayName`)) matches.push(app)
          if (matches.length !== 1 || matches[0]!.appId !== body.appId) throw new RestoreSafetyError("The backing local app registration must resolve uniquely before enterprise app creation.")
          source = { ...matches[0]!, servicePrincipalType: "Application", appOwnerOrganizationId: actor.tenantId }
        }
        payload = appPayload(step.folder, action, { ...source, ...body })
        if (restoreFingerprint(payload) !== restoreFingerprint(body) || restoreFingerprint(body) !== restoreFingerprint(step.desired)) throw new RestoreSafetyError("Unsupported application write properties.")
        if (action === "update") { path += "/" + appIdentity(targetId); method = "PATCH" }
      } else if (action === "gallery") {
        path = `applicationTemplates/${appIdentity(step.directory!.templateId)}/instantiate`; payload = appPayload(step.folder, "gallery", body)
        if (restoreFingerprint(payload) !== restoreFingerprint(body)) throw new RestoreSafetyError("Unsupported gallery properties.")
      } else if (action === "owner") {
        if (body.present !== true || body.principalId !== step.directory!.principalId || Object.keys(body).length !== 2) throw new RestoreSafetyError("Owners are adds only.")
        path += `/${appIdentity(targetId)}/owners/$ref`; payload = { "@odata.id": root + "directoryObjects/" + appIdentity(body.principalId) }
      } else if (action === "consent" || action === "app-role") {
        const { resource, client, principal } = await endpoints(step)
        if (step.desired.resourceId !== resource.id || (action === "consent" ? step.desired.clientId !== client?.id : step.desired.principalId !== principal.id)) throw new RestoreSafetyError("An app ID now resolves to a different object. Preview this relationship again.")
        if (action === "consent") {
          const names = String(step.desired.scope).split(/\s+/).filter(Boolean)
          if (!names.length || !Array.isArray(resource.oauth2PermissionScopes) || names.some(name => !(resource.oauth2PermissionScopes as Item[]).some(scope => scope.value === name && scope.isEnabled === true))) throw new RestoreSafetyError("A delegated scope no longer resolves on the resource app.")
          payload = { clientId: client!.id!, resourceId: resource.id!, principalId: step.desired.consentType === "Principal" ? principal.id! : null, consentType: step.desired.consentType!, scope: mergeConsentScopes(String(current?.scope ?? ""), String(step.desired.scope)) }
          if (current) { path += "/" + grantId(current.id); method = "PATCH"; payload = { scope: payload.scope! } }
        } else {
          if (!Array.isArray(resource.appRoles) || !(resource.appRoles as Item[]).some(role => role.id === step.desired.appRoleId && role.isEnabled === true && Array.isArray(role.allowedMemberTypes) && role.allowedMemberTypes.includes("Application"))) throw new RestoreSafetyError("The app role no longer resolves for this principal type.")
          path = `servicePrincipals/${appIdentity(principal.id)}/appRoleAssignments`; payload = { principalId: principal.id!, resourceId: resource.id!, appRoleId: step.desired.appRoleId! }
        }
        const expected = action === "consent" ? { ...step.desired, scope: mergeConsentScopes(String(current?.scope ?? ""), String(step.desired.scope)) } : step.desired
        if (restoreFingerprint(body) !== restoreFingerprint(expected)) throw new RestoreSafetyError("The grant differs from its approved mapping.")
      } else throw new RestoreSafetyError("This application operation has no admitted write contract.")
      signal?.throwIfAborted(); beforeSend()
      // A throttle is a definite refusal. A new preview rechecks all mappings; no blind replay.
      const answer = await request(path, method, payload, signal)
      return { id: String((action === "gallery" ? (answer?.servicePrincipal as Item | undefined)?.id : answer?.id) ?? targetId ?? "") }
    },
  }
  return { ...io, review, hydrate, list, object, resolveApp, resolveUser, async locate(folder: string, sourceId: string) {
    const live = await object(folder, sourceId)
    if (live) { restorableApp(live, folder); return { action: "update" as const, current: live } }
    const deleted = await object(folder, sourceId, true)
    return deleted ? { action: "recycle" as const, current: deleted } : { action: "create" as const, current: null }
  } }
}
