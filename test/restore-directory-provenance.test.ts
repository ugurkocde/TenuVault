import { unsetUserFields, unsetGroupFields } from "./fixtures/directory-response"
import { afterEach, expect, it, vi } from "vitest"
import { POST } from "../src/portal/app/api/restore-directory/route"
import { setDirectoryRestoreService } from "../src/main/restore/directory-dispatch"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { ModuleSettings } from "../src/main/services/settings"
import { localStorageAccountName } from "../src/shared/constants"
import type { Item } from "../src/shared/intune/registry"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const tenant = id(1), admin = id(2), appId = id(3), resource = id(10)
const folders = ["Applications", "Users", "Groups", "ServicePrincipals", "OAuth2PermissionGrants"]
afterEach(() => vi.unstubAllGlobals())
function world(folder: string) {
  const data = new Map<string, string>(), writes: string[] = []
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const settings = new ModuleSettings(store)
  settings.setChoice(tenant, { entra: { access: "restore", areas: ["applications", "groups", "usersAndDevices"] } })
  const snapshot: Item = { ...unsetUserFields, ...unsetGroupFields, accountEnabled: false, notes: null, id: resource, appId: id(11), displayName: "Saved", description: "Saved description", userType: "Member", mailNickname: "group", groupTypes: [], mailEnabled: false, securityEnabled: true, isAssignableToRole: false }
  const token = `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: admin, appid: appId, scp: "Application.Read.All Application.ReadWrite.All User.Read.All User.ReadUpdate.All Group.Read.All Group.ReadWrite.All Policy.Read.All" })).toString("base64url")}.s`
  const graph = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace("/beta/", "")
    if (init?.method && init.method !== "GET") { writes.push(path); return new Response(null, { status: 204 }) }
    if (path === "applications" || path === "servicePrincipals") {
      const connection = url.searchParams.get("$filter")?.includes(appId)
      return Response.json({ value: connection ? [{ id: id(path === "applications" ? 4 : 5), appId }] : [{ id: id(12), appId: snapshot.appId, appOwnerOrganizationId: tenant, servicePrincipalType: "Application" }] })
    }
    if ([`applications/${resource}`, `users/${resource}`, `groups/${resource}`].includes(path)) return Response.json({ ...snapshot, displayName: "Current", description: "Current description" })
    if (path === "identity/conditionalAccess/policies") return Response.json({ value: [] })
    throw new Error(`Unexpected Graph read: ${path}`)
  })
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, tenantId: tenant, userId: admin, clientId: appId }), async () => ({ tenantId: tenant, userId: admin, clientId: appId }), graph, () => [], settings)
  setDirectoryRestoreService(service())
  let metadata = () => Response.json({ TenantId: tenant })
  const storage = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("oauth2")) return Response.json({ access_token: "storage-token" })
    if (url.endsWith("metadata.json")) return metadata()
    if (url.endsWith(".tenuvault-owner.json")) return Response.json({ TenantId: tenant })
    if (url.endsWith(`backup/${folder}/${resource}.json`)) return Response.json(snapshot)
    throw new Error("Unexpected storage read")
  })
  vi.stubGlobal("fetch", storage)
  const call = (body: object) => POST(new Request("http://localhost/api/restore-directory", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId, clientSecret: "placeholder", storageAccountName: localStorageAccountName(tenant), backupId: "backup", path: `backup/${folder}/${resource}.json`, stage: "object", ...body }) }) as Parameters<typeof POST>[0])
  return { call, data, writes, graph, service, manifest: (read: () => Response) => { metadata = read } }
}
it.each(["Applications", "Users", "Groups"])("allows a normal owned %s preview but refuses import provenance on preview, resume and execution", async folder => {
  const env = world(folder), response = await env.call({ action: "preview" }), page = await response.json()
  expect(response.status).toBe(200)
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0].review.blocker).toBeUndefined()
  expect(page.rows[0].review.changes.length).toBeGreaterThan(0)
  expect(page.rows[0].review.approvals).toContain("directory-item")
  const approvals = { [page.rows[0].key]: page.rows[0].review.approvals }
  // Same-tenant tar imports retain tenant ownership and record Import in metadata.
  env.manifest(() => Response.json({ TenantId: tenant, SourceTenantId: tenant, Import: { sha256: "0".repeat(64), provenance: "User-reviewed tar; source identity is not cryptographically verified" } }))
  setDirectoryRestoreService(env.service())
  for (const action of ["preview", "resume", "restore"]) {
    const refused = await env.call({ action, runId: page.runId, fingerprint: page.fingerprint, approvals, origin: "restore" })
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toBeTruthy()
  }
  expect(env.writes).toEqual([])
})
it.each(folders)("refuses import markers for both %s preview stages even when the marker is malformed", async folder => {
  const env = world(folder)
  for (const Import of [{ sha256: "0".repeat(64) }, null, false, ""]) {
    env.manifest(() => Response.json({ TenantId: tenant, Import }))
    for (const stage of ["object", "relationships"]) expect((await env.call({ action: "preview", stage })).status).toBe(409)
  }
  expect(env.graph).not.toHaveBeenCalled()
  expect([...env.data.keys()].some(key => key.startsWith("restore.directory."))).toBe(false)
  expect(env.writes).toEqual([])
})
it.each(folders)("fails closed for %s with missing or unreadable provenance despite local ownership", async folder => {
  const env = world(folder)
  for (const read of [() => new Response(null, { status: 404 }), () => new Response(null, { status: 503 }), () => new Response("{broken")]) {
    env.manifest(read)
    const response = await env.call({ action: "preview" })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect((await response.json()).error).toBeTruthy()
  }
  expect(env.graph).not.toHaveBeenCalled()
  expect([...env.data.keys()].some(key => key.startsWith("restore.directory."))).toBe(false)
  expect(env.writes).toEqual([])
})
