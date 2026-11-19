import { randomUUID } from "node:crypto"
import type { Item } from "../../src/shared/intune/registry"
import { graphContinuation } from "../../src/shared/graph-continuation"
import { appIdentity, appPayload } from "../../src/main/restore/directory-9b"
import { LAB_8C_APP, LAB_8C_TENANT } from "./configuration-8c-lab"
export const LAB_9B_PREFIX = "TV06-TEST-"
export interface AppLabIntent { name: string; folder: string; id?: string; appId?: string; state: "intent" | "created" | "removed" }
export interface AppLabRecovery { save: (intent: AppLabIntent) => void; load: () => AppLabIntent[]; clear: () => void; evidence: (event: Item) => void }
/** Closed fixture operations only. Cleanup is the sole operation permitted on earlier prefixed fixtures. */
export function directory9bLab(token: string, tenant: string, labApp: string, recovery: AppLabRecovery, protectedAppId: string, fetchImpl: typeof fetch = fetch, pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
  protectedAppId = appIdentity(protectedAppId)
  if (protectedAppId === labApp) throw new Error("Identify the TenuVault registration separately from the lab app")
  const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())
  if (tenant !== LAB_8C_TENANT || labApp !== LAB_8C_APP || claims.tid !== tenant || (claims.appid ?? claims.azp) !== labApp || claims.scp) throw new Error("Outside the approved app-only lab connection")
  for (const role of ["Application.ReadWrite.OwnedBy", "Application.Read.All", "DelegatedPermissionGrant.ReadWrite.All", "AppRoleAssignment.ReadWrite.All"]) if (!claims.roles?.includes(role)) throw new Error(`Missing lab permission: ${role}`)
  const root = "https://graph.microsoft.com/v1.0/", created = new Map<string, AppLabIntent>()
  const request = async (path: string, method = "GET", body?: Item): Promise<Item> => {
    const response = await fetchImpl(root + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
    recovery.evidence({ method, path: path.split("?")[0]!, status: response.status })
    if (response.status === 404 && ["GET", "DELETE"].includes(method)) return { absent: true }
    if (!response.ok) throw new Error(`Lab ${method} refused (HTTP ${response.status}). Response bodies are not recorded.`)
    return response.status === 204 ? {} : await response.json() as Item
  }
  async function* list(path: string) {
    const start = root + path, seen = new Set<string>()
    let next: string | undefined = start
    while (next) {
      const page = await request(graphContinuation(start, next, seen).slice(root.length))
      if (!Array.isArray(page.value)) throw new Error("Incomplete lab audit")
      for (const row of page.value) {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Malformed lab audit")
        yield row as Item
      }
      if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new Error("Invalid lab continuation")
      next = page["@odata.nextLink"] as string | undefined
    }
  }
  const protectedApp = (item: Item) => String(item.appId).toLowerCase() === labApp || String(item.appId).toLowerCase() === protectedAppId
  // Both registrations are protected by app ID even if their display names acquire the test prefix.
  const fixture = (item: Item) => typeof item.displayName === "string" && item.displayName.startsWith(LAB_9B_PREFIX) && !protectedApp(item) && item.appOwnerOrganizationId !== "f8cdef31-a31e-4b4a-93e4-5f571e91255a"
  const audit = async () => {
    const rows: Array<{ folder: string; id: string; appId: string; deleted: boolean }> = []
    for (const [folder, type] of [["applications", "application"], ["servicePrincipals", "servicePrincipal"]]) for (const deleted of [false, true]) {
      const path = deleted ? `directory/deletedItems/microsoft.graph.${type}` : folder
      for await (const item of list(path + "?$top=999&$select=id,appId,displayName" + (folder === "servicePrincipals" ? ",appOwnerOrganizationId" : ""))) if (String(item.displayName).startsWith(LAB_9B_PREFIX)) {
        if (!fixture(item)) throw new Error("A protected app has the test prefix. Cleanup is refused.")
        for (const intent of recovery.load()) if (intent.folder === folder && intent.name === item.displayName && intent.state !== "removed") recovery.save({ ...intent, id: appIdentity(item.id), appId: appIdentity(item.appId), state: "created" })
        rows.push({ folder: folder!, id: appIdentity(item.id), appId: appIdentity(item.appId), deleted })
      }
    }
    return rows
  }
  const cleanup = async () => {
    for (let attempt = 0, stable = 0; attempt < 60; attempt++) {
      const rows = await audit()
      for (const row of rows) {
        await request(row.deleted ? `directory/deletedItems/${row.id}` : `${row.folder}/${row.id}`, "DELETE")
        if (row.deleted) for (const intent of recovery.load()) if (intent.id === row.id || intent.appId === row.appId || intent.name === created.get(row.id)?.name) recovery.save({ ...intent, state: "removed" })
      }
      stable = rows.length ? 0 : stable + 1
      if (stable >= 3 && recovery.load().every(intent => intent.state === "removed")) { recovery.clear(); created.clear(); return }
      await pause(1000)
    }
    throw new Error("Cleanup is unresolved. Durable intent is retained; no new fixtures may be created.")
  }
  const current = async (id: string) => {
    const intent = created.get(appIdentity(id))
    if (!intent) throw new Error("Existing lab objects cannot be changed")
    const item = await request(`${intent.folder}/${id}?$select=id,appId,displayName,description,appRoles${intent.folder === "servicePrincipals" ? ",oauth2PermissionScopes,appOwnerOrganizationId,servicePrincipalType" : ",api"}`)
    if (!fixture(item) || item.id !== id || item.appId !== intent.appId || item.displayName !== intent.name) throw new Error("Fixture identity no longer matches")
    return { item, intent }
  }
  const verify = async (folder: string, id: string, expected: Item) => {
    for (let attempt = 0, stable = 0; attempt < 60; attempt++) {
      const item = await request(`${folder}/${id}?$select=id,appId,displayName,description`)
      stable = Object.entries(expected).every(([key, value]) => item[key] === value) ? stable + 1 : 0
      if (stable >= 3) return item
      await pause(1000)
    }
    throw new Error("Lab read-back did not match")
  }
  return { audit, cleanup,
    async createApplication() {
      if (recovery.load().some(intent => intent.state === "intent")) throw new Error("Resolve unanswered fixture creation before continuing")
      const name = LAB_9B_PREFIX + randomUUID(), roleId = randomUUID(), scopeId = randomUUID()
      const intent: AppLabIntent = { folder: "applications", name, state: "intent" }; recovery.save(intent)
      const item = await request("applications", "POST", { displayName: name, signInAudience: "AzureADMyOrg", appRoles: [{ id: roleId, displayName: "Test access", description: "Fixture access only", value: "Test.Access", isEnabled: true, allowedMemberTypes: ["Application"] }], api: { oauth2PermissionScopes: [{ id: scopeId, value: "Test.Read", type: "Admin", isEnabled: true, adminConsentDisplayName: "Read fixture", adminConsentDescription: "Read fixture only" }] } })
      intent.id = appIdentity(item.id); intent.appId = appIdentity(item.appId); intent.state = "created"; recovery.save(intent); created.set(intent.id, intent)
      await verify("applications", intent.id, { id: intent.id, appId: intent.appId, displayName: name })
      return { id: intent.id, appId: intent.appId, roleId, scopeId }
    },
    async createPrincipal(appId: string) {
      const backing = [...created.values()].find(item => item.folder === "applications" && item.appId === appId)
      if (!backing) throw new Error("Service principals require a backing app created in this run")
      const intent: AppLabIntent = { folder: "servicePrincipals", name: backing.name, appId, state: "intent" }; recovery.save(intent)
      const item = await request("servicePrincipals", "POST", { appId })
      intent.id = appIdentity(item.id); intent.state = "created"; recovery.save(intent); created.set(intent.id, intent)
      await verify("servicePrincipals", intent.id, { id: intent.id, appId, displayName: backing.name })
      return intent.id
    },
    async lifecycle(id: string) {
      const { item, intent } = await current(id)
      const folder = intent.folder === "applications" ? "Applications" : "ServicePrincipals"
      const saved = appPayload(folder, "update", { ...item, displayName: item.displayName!, description: "Original fixture" })
      await request(`${intent.folder}/${id}`, "PATCH", saved); await verify(intent.folder, id, saved)
      await request(`${intent.folder}/${id}`, "PATCH", { description: "Changed fixture" }); await verify(intent.folder, id, { description: "Changed fixture" })
      await request(`${intent.folder}/${id}`, "PATCH", saved); await verify(intent.folder, id, saved)
      await request(`${intent.folder}/${id}`, "DELETE")
      for (let attempt = 0; attempt < 60; attempt++) { const deleted = await request(`directory/deletedItems/${id}?$select=id,appId,displayName`); if (deleted.id === id && deleted.appId === intent.appId) break; if (attempt === 59) throw new Error("Deleted fixture is unreadable"); await pause(1000) }
      await request(`directory/deletedItems/${id}/restore`, "POST", {})
      await verify(intent.folder, id, { ...saved, appId: intent.appId! })
      recovery.evidence({ kind: "recycle-metadata-only", folder: intent.folder, matched: true, productionAdmitted: false })
    },
    async consent(clientId: string, resourceId: string) {
      const client = await current(clientId), resource = await current(resourceId)
      if (client.intent.folder !== "servicePrincipals" || resource.intent.folder !== "servicePrincipals") throw new Error("Consent is allowed only between test enterprise apps")
      const grant = await request("oauth2PermissionGrants", "POST", { clientId, resourceId, consentType: "AllPrincipals", principalId: null, scope: "Test.Read" })
      if (typeof grant.id !== "string" || !/^[A-Za-z0-9_-]{40,160}$/.test(grant.id)) throw new Error("Invalid fixture grant identity")
      const read = await request(`oauth2PermissionGrants/${grant.id}`)
      if (read.clientId !== clientId || read.resourceId !== resourceId || read.scope !== "Test.Read") throw new Error("Fixture grant read-back failed")
      await request(`oauth2PermissionGrants/${grant.id}`, "PATCH", { scope: "Test.Read" })
      if ((await request(`oauth2PermissionGrants/${grant.id}`)).scope !== "Test.Read") throw new Error("Merged scope read-back failed")
      await request(`oauth2PermissionGrants/${grant.id}`, "DELETE")
    },
    async appRole(clientId: string, resourceId: string, roleId: string) {
      const client = await current(clientId), resource = await current(resourceId)
      if (client.intent.folder !== "servicePrincipals" || resource.intent.folder !== "servicePrincipals" || !Array.isArray(resource.item.appRoles) || !(resource.item.appRoles as Item[]).some(role => role.id === roleId)) throw new Error("App roles are allowed only between test enterprise apps and their own roles")
      const assignment = await request(`servicePrincipals/${clientId}/appRoleAssignments`, "POST", { principalId: clientId, resourceId, appRoleId: appIdentity(roleId) })
      if (typeof assignment.id !== "string" || !/^[A-Za-z0-9_-]{40,160}$/.test(assignment.id)) throw new Error("Invalid fixture assignment identity")
      const read = await request(`servicePrincipals/${clientId}/appRoleAssignments/${assignment.id}`)
      if (read.principalId !== clientId || read.resourceId !== resourceId || read.appRoleId !== roleId) throw new Error("Fixture assignment read-back failed")
      await request(`servicePrincipals/${clientId}/appRoleAssignments/${assignment.id}`, "DELETE")
    },
  }
}
