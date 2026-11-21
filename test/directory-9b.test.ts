import { graphAssignment } from "./fixtures/directory-graph-v1"
import { graphNotFound } from "./fixtures/directory-response"
import { approveDirectory } from "../src/main/restore/directory-9a"
import { executeDirectoryBatches } from "../src/main/restore/directory-9a-batches"
import { setDirectoryRestoreService } from "../src/main/restore/directory-dispatch"
import { POST } from "../src/portal/app/api/restore-directory/route"
import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import { directory9bIO } from "../src/main/restore/directory-9b-io"
import { appPayload, applicationAdmission, applicationPermissions, TENUVAULT_DESKTOP_APP_ID, applicationReview, DIRECTORY_9B_FOLDERS } from "../src/main/restore/directory-9b"
import { applicationObjectStep, applicationRelationshipSteps } from "../src/main/restore/directory-9b-plan"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { ModuleSettings } from "../src/main/services/settings"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { MICROSOFT_ORGANIZATION_ID } from "../src/shared/intune/entra-directory"
import { graphPermissions } from "../src/shared/services/manifest"
import { restoreCapability, typeForFolder, type Item } from "../src/shared/intune/registry"
import { executeGuardedRun, restoreFingerprint, GuardedRunJournal, type GuardedRun, type GuardedStep } from "../src/main/restore/guarded-run"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
const actor = { tenantId: id(1), userId: id(2), clientId: id(3), applicationObjectId: id(4), servicePrincipalId: id(5), recoveryAccountIds: [id(6)] }
const app = { tags: null, description: null, notes: null, id: id(10), appId: id(11), displayName: "API", appOwnerOrganizationId: id(1), servicePrincipalType: "Application", appRoles: [{ id: id(90), displayName: "Test role", isEnabled: true, allowedMemberTypes: ["Application"] }], oauth2PermissionScopes: [{ value: "Test.Read", isEnabled: true }] }
const client = { ...app, id: id(12), appId: id(13), displayName: "Client" }
const token = `h.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: "Application.Read.All Directory.Read.All Application.ReadWrite.All DelegatedPermissionGrant.ReadWrite.All AppRoleAssignment.ReadWrite.All" })).toString("base64url")}.s`
function world() {
  const writes: string[] = [], objects = new Map<string, Item>(), grants: Item[] = [], roles: Item[] = []
  objects.set(`applications/${id(4)}`, { id: id(4), appId: id(3) })
  objects.set(`applications/${id(10)}`, { ...app })
  objects.set(`servicePrincipals/${id(10)}`, { ...app })
  objects.set(`servicePrincipals/${id(12)}`, { ...client })
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace("/v1.0/", ""), method = init?.method ?? "GET"
    if (method !== "GET") {
      writes.push(path)
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (method === "PATCH" && objects.has(path)) Object.assign(objects.get(path)!, body)
      if (path === "oauth2PermissionGrants") { const grant = { ...body, id: "A".repeat(43) }; grants.push(grant); return Response.json(grant, { status: 201 }) }
      if (path.startsWith("oauth2PermissionGrants/") && method === "PATCH") Object.assign(grants.find(grant => grant.id === path.split("/")[1])!, body)
      if (path.endsWith("/appRoleAssignments")) { const role = { ...graphAssignment, ...body }; roles.push(role); return Response.json(role, { status: 201 }) }
      return new Response(null, { status: 204 })
    }
    if (path === "applications" && url.searchParams.get("$filter")?.includes(id(3))) return Response.json({ value: [{ id: id(4), appId: id(3) }] })
    if (path === "servicePrincipals") {
      const filter = url.searchParams.get("$filter") ?? ""
      return Response.json({ value: filter.includes(id(3)) ? [{ id: id(5), appId: id(3) }] : [app, client].filter(item => filter.includes(String(item.appId))) })
    }
    if (path === "oauth2PermissionGrants") return Response.json({ value: grants })
    if (path.endsWith("/appRoleAssignments")) return Response.json({ value: roles })
    if (path.endsWith("/owners")) return Response.json({ value: [] })
    if (objects.has(path)) return Response.json(objects.get(path))
    return graphNotFound()
  })
  const data = new Map<string, string>()
  const settings = new ModuleSettings({ get: key => data.get(key) ?? null, set: (key, value) => { data.set(key, value) }, delete: key => { data.delete(key) } })
  settings.setChoice(actor.tenantId, { entra: { access: "restore", areas: ["applications"] } })
  const io = directory9bIO(token, actor, fetcher, () => [], () => settings.get(actor.tenantId).entra)
  return { io, writes, objects, grants, roles, fetcher, settings }
}
const step = (action: NonNullable<GuardedStep["directory"]>["action"], folder = "Applications"): GuardedStep => ({ folder, key: "test", sourceId: id(10), targetId: id(10), operation: "update", directory: { action, expectedAppId: String(app.appId) }, desired: { displayName: "Saved" }, properties: ["displayName"], preview: restoreFingerprint(null), requires: [] })
it("admits only metadata and refuses every other transport with a valid run and all approvals", async () => {
  const admitted: Record<string, string[]> = { Applications: ["update"], ServicePrincipals: [], OAuth2PermissionGrants: [] }
  for (const folder of DIRECTORY_9B_FOLDERS) {
    expect(restoreCapability(typeForFolder(folder)!)).toBe(admitted[folder]!.length ? "create" : "none")
    for (const action of ["create", "update", "recycle", "gallery", "owner", "consent", "app-role", "policy"] as const) {
      const env = world(), candidate = step(action, folder)
      expect(!!applicationAdmission(candidate), `${folder}/${action}`).toBe(!admitted[folder]!.includes(action))
      candidate.preview = restoreFingerprint(await env.io.read(step("update")))
      const run = runFor(candidate)
      if (admitted[folder]!.includes(action)) await env.io.write(candidate, candidate.desired, id(10), () => {}, run)
      else {
        expect(applicationPermissions(candidate)).toEqual([])
        await expect(env.io.write(candidate, candidate.desired, id(10), () => {}, run)).rejects.toThrow(applicationAdmission(candidate))
      }
      expect(env.writes).toHaveLength(admitted[folder]!.includes(action) ? 1 : 0)
    }
  }
  for (const mode of ["delegated", "application"] as const) {
    const backup = graphPermissions({ entra: { access: "backup", areas: ["applications"] } }, mode)
    const restore = graphPermissions({ entra: { access: "restore", areas: ["applications"] } }, mode)
    for (const scope of ["Directory.Read.All", "Directory.ReadWrite.All", "Organization.ReadWrite.All", "Application.ReadWrite.OwnedBy"]) expect(restore.filter(scope => !backup.includes(scope))).not.toContain(scope)
  }
})
it("checks the recycle bin before recreation and warns that a new app ID breaks every client", async () => {
  const env = world(); env.objects.delete(`applications/${id(10)}`)
  env.objects.set(`directory/deletedItems/${id(10)}`, app)
  const recycle = await applicationObjectStep("Applications", app, env.io, async () => app)
  expect(recycle.directory?.action).toBe("recycle")
  expect(applicationAdmission(recycle)).toContain("completely verified")
  env.objects.delete(`directory/deletedItems/${id(10)}`)
  const recreated = await applicationObjectStep("Applications", app, env.io, async () => app)
  expect(recreated.directory?.action).toBe("create")
  expect(recreated.desired).not.toHaveProperty("appId")
  expect(applicationReview(recreated, null, app, null, actor).notices.join(" ")).toContain("breaks every client")
  expect(await env.io.findCreated(recreated, recreated.desired)).toEqual([])
})
it("excludes credentials and SSO from closed payloads and rejects first-party or synced identities", () => {
  const saved = { ...app, passwordCredentials: [{ secretText: "never" }], keyCredentials: [], preferredSingleSignOnMode: "saml", accountEnabled: true }
  expect(appPayload("Applications", "create", saved)).toEqual({ displayName: "API" })
  expect(appPayload("ServicePrincipals", "create", saved)).toEqual({ appId: app.appId })
  expect(appPayload("ServicePrincipals", "update", saved)).toEqual({ displayName: "API" })
  for (const extra of ([{ appOwnerOrganizationId: MICROSOFT_ORGANIZATION_ID }, { servicePrincipalType: "ManagedIdentity" }, { onPremisesSyncEnabled: false }] as Item[])) expect(() => appPayload("ServicePrincipals", "create", { ...saved, ...extra })).toThrow()
})
it("resolves grant endpoints by saved app ID and merges existing scopes in the review", async () => {
  const env = world(), grant = { id: "A".repeat(43), clientId: id(50), resourceId: id(51), principalId: null, consentType: "AllPrincipals", scope: "Test.Read" }
  env.grants.push({ ...grant, clientId: client.id, resourceId: app.id, scope: "Existing.Read" })
  const source = async (_folder: string, sourceId: string) => ({ id: sourceId, appId: sourceId === id(50) ? client.appId : app.appId })
  const candidate = await applicationObjectStep("OAuth2PermissionGrants", grant, env.io, source)
  expect(candidate.desired).toMatchObject({ clientId: client.id, resourceId: app.id })
  expect(candidate.operation).toBe("update")
  const review = await env.io.review(candidate)
  expect(review.principal).toMatchObject({ name: "Client", type: "servicePrincipal" })
  expect(review.approvals).toEqual(["directory-item", "privileged-relationship", "security-response"])
  expect(review.changes).toContainEqual({ property: "scope", before: "Existing.Read", after: "Existing.Read Test.Read" })
  expect(env.writes).toEqual([])
})
it("protects owners, the signed-in account, recovery accounts and the TenuVault client", () => {
  const owner = step("owner"); owner.directory!.principalId = id(2)
  expect(applicationReview(owner, { present: false }, app, { id: id(2), displayName: "Admin", "@odata.type": "#microsoft.graph.user" }, actor).blocker).toContain("protected")
  owner.directory!.principalId = id(60)
  expect(applicationReview(owner, { present: false }, app, { id: id(60), displayName: "Owner", "@odata.type": "#microsoft.graph.user" }, actor).approvals).toEqual(["directory-item", "privileged-relationship", "security-response"])
  const consent = step("consent", "OAuth2PermissionGrants"); consent.directory!.clientAppId = actor.clientId
  expect(applicationReview(consent, null, app, client, actor).blocker).toContain("protected")
  const assignment = step("app-role", "ServicePrincipals")
  expect(applicationReview(assignment, null, { ...app, appOwnerOrganizationId: MICROSOFT_ORGANIZATION_ID }, client, actor).approvals).toContain("privileged-relationship")
})
it("refuses gallery guessing and ambiguous app ID lookups", async () => {
  const env = world(); env.objects.delete(`servicePrincipals/${app.id}`)
  const gallery = await applicationObjectStep("ServicePrincipals", { ...app, tags: ["WindowsAzureActiveDirectoryGalleryApplicationPrimaryV1"] }, env.io, async () => app)
  expect(gallery.directory).toMatchObject({ action: "gallery", unresolved: expect.stringContaining("TemplateId") })
  const original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((input, init) => String(input).includes("servicePrincipals?") ? Promise.resolve(Response.json({ value: [app, app] })) : original(input, init))
  await expect(env.io.resolveApp(String(app.appId))).rejects.toThrow("ambiguous")
})
it("uses saved page resume while refusing unapproved execution and imported origins", async () => {
  const env = world(), data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher, () => [], env.settings)
  const request = { path: `backup/Applications/${app.id}.json`, snapshot: { ...app, displayName: "Saved" }, origin: "restore" as const }
  const options = { stage: "object" as const, exactMembers: false, exactOwners: false }
  const page = await service().prepare(actor.tenantId, request, options, async () => app)
  expect(page.rows).toHaveLength(1); expect(page.rows[0]!.review.blocker).toBeUndefined()
  expect(await service().resume(actor.tenantId, { ...request, runId: page.runId })).toEqual(page)
  await expect(service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, {})).rejects.toThrow("Approve each")
  await expect(service().prepare(actor.tenantId, { ...request, origin: "import" }, options, async () => app)).rejects.toThrow("Imported")
  expect(env.writes).toEqual([])
})
it("authenticates relationship shards before publishing a complete inventory", async () => {
  const env = world(), ids = [id(60)], snapshot = { ...app, owners: { format: "sorted-id-shards-v1", complete: true, count: 1, shards: 1, hash: createHash("sha256").update(JSON.stringify(ids[0])+"\n").digest("hex") } }
  const rows = []
  for await (const row of applicationRelationshipSteps(`backup/Applications/${app.id}.json`, snapshot, String(app.id), env.io, async () => ids, async () => app)) rows.push(row)
  expect(rows[0]?.directory).toMatchObject({ action: "owner", principalId: id(60) })
  snapshot.owners.hash = "bad"
  await expect((async () => { for await (const _row of applicationRelationshipSteps(`backup/Applications/${app.id}.json`, snapshot, String(app.id), env.io, async () => ids, async () => app)) { /* consume */ } })()).rejects.toThrow("fingerprint")
})
it("enforces metadata final-send approvals, cancellation, origin and stale preview", async () => {
  const env = world(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  const run = runFor(candidate), before = vi.fn()
  delete candidate.directoryApprovals
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, before, run)).rejects.toThrow("Approve each")
  approveDirectory(candidate, run, "directory-item")
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, before, { ...run, origin: "import" })).rejects.toThrow("owned same-tenant")
  const cancelled = new AbortController(); cancelled.abort()
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, before, run, cancelled.signal)).rejects.toThrow("cancelled")
  expect(before).not.toHaveBeenCalled(); expect(env.writes).toEqual([])
  await env.io.write(candidate, candidate.desired, candidate.targetId, before, run)
  expect(before).toHaveBeenCalledOnce()
  expect(JSON.parse(String(env.fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")![1]?.body))).toEqual({ displayName: "Saved" })
  env.objects.get(`applications/${app.id}`)!.description = "Changed concurrently"
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, before, run)).rejects.toThrow("tenant changed")
  expect(env.writes).toHaveLength(1)
})
it("keeps blocked transports closed even if mutable matrix evidence is enabled", async () => {
  const { restoreMatrixRow } = await import("../src/shared/intune/restore-matrix")
  const original = DIRECTORY_9B_FOLDERS.map(folder => structuredClone(restoreMatrixRow(folder)!.directoryRestore!))
  try {
    for (const folder of DIRECTORY_9B_FOLDERS) {
      const contract = restoreMatrixRow(folder)!.directoryRestore!
      contract.phase = "enabled"; contract.evidence = Object.fromEntries(["create", "update", "recycle", "gallery", "owner", "consent", "app-role", "policy"].map(action => [action, { date: "test", result: "round-trip-matched" as const }]))
    }
    for (const folder of DIRECTORY_9B_FOLDERS) for (const action of ["create", "update", "recycle", "gallery", "owner", "consent", "app-role", "policy"] as const) {
      if (folder === "Applications" && action === "update") continue
      const env = world(), candidate = step(action, folder), run = runFor(candidate)
      expect(applicationPermissions(candidate)).toEqual([])
      await expect(env.io.write(candidate, candidate.desired, candidate.targetId, () => {}, run)).rejects.toThrow(applicationAdmission(candidate))
      expect(env.writes).toEqual([])
    }
  } finally { for (const [index, folder] of DIRECTORY_9B_FOLDERS.entries()) { const contract = restoreMatrixRow(folder)!.directoryRestore!; Object.assign(contract, original[index]); if (!original[index]!.evidence) delete contract.evidence } }
})
it("persists bounded application relationship pages and advances beyond unresolved rows", async () => {
  const env = world(), ids = Array.from({ length: 65 }, (_, n) => id(100+n)), data = new Map<string, string>()
  const snapshot = { ...app, owners: { format: "sorted-id-shards-v1", complete: true, count: ids.length, shards: 1, hash: createHash("sha256").update(ids.map(value => JSON.stringify(value)+"\n").join("")).digest("hex") } }
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher, () => [], env.settings)
  const request = { path: `backup/Applications/${app.id}.json`, snapshot, origin: "restore" as const }
  const options = { stage: "relationships" as const, exactMembers: false, exactOwners: false }
  const first = await service().prepare(actor.tenantId, request, options, async () => ids)
  expect(first.rows).toHaveLength(50); expect(first.more).toBe(true)
  expect(first.rows.every(row => row.review.blocker)).toBe(true)
  const last = await service().prepare(actor.tenantId, request, { ...options, previousRunId: first.runId }, async () => { throw new Error("Must reuse the saved difference") })
  expect(last.rows).toHaveLength(15); expect(last.more).toBe(false)
  expect(first.rows.map(row => row.key)).not.toContain(last.rows[0]!.key)
  expect(env.writes).toEqual([])
})
it("refuses principal-specific consent instead of replaying a raw saved user ID", async () => {
  const env = world()
  await expect(applicationObjectStep("OAuth2PermissionGrants", { id: "A".repeat(43), clientId: id(50), resourceId: id(51), consentType: "Principal", principalId: id(2), scope: "Test.Read" }, env.io, async (_folder, sourceId) => ({ id: sourceId, appId: sourceId === id(50) ? client.appId : app.appId }))).rejects.toThrow("Raw saved principal IDs")
  const candidate = step("consent", "OAuth2PermissionGrants"); candidate.desired.consentType = "Principal"
  expect(applicationAdmission(candidate)).toContain("typed user mapping")
  expect(env.writes).toEqual([])
})

it.each(["Applications"])("executes admitted %s metadata through the durable production service", async folder => {
  const env = world(), data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher, () => [], env.settings)
  const saved = { ...app, displayName: "Saved", description: "Saved description" }
  const request = { path: `backup/${folder}/${app.id}.json`, snapshot: saved, origin: "restore" as const }
  const page = await service().prepare(actor.tenantId, request, { stage: "object", exactMembers: false, exactOwners: false }, async () => saved)
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  expect(await service().resume(actor.tenantId, { ...request, runId: page.runId })).toEqual(page)
  const approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  const result = await service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, approvals)
  expect(result).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.objects.get(`${folder === "Applications" ? "applications" : "servicePrincipals"}/${app.id}`)).toMatchObject({ displayName: "Saved", description: "Saved description" })
  const count = env.writes.length
  await service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, approvals)
  expect(env.writes).toHaveLength(count)
})
it.each([false, true])("keeps tenant-wide consent blocked through the production service, existing grant %s", async existing => {
  const env = world(), data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const service = new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher, () => [], env.settings)
  const saved = { id: "A".repeat(43), clientId: client.id, resourceId: app.id, consentType: "AllPrincipals", principalId: null, scope: "Test.Read" }
  if (existing) env.grants.push({ ...saved, scope: "Existing.Read" })
  const request = { path: `backup/OAuth2PermissionGrants/${saved.id}.json`, snapshot: saved, origin: "restore" as const }
  const page = await service.prepare(actor.tenantId, request, { stage: "object", exactMembers: false, exactOwners: false }, async path => path.includes(String(client.id)) ? client : app)
  expect(page.rows[0]!.review.blocker).toContain("HTTP 400")
  await expect(service.execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).rejects.toThrow("Approve each")
  expect(env.writes).toEqual([])
})
it("refuses null metadata clearing and a synchronized or protected enterprise app at final send", async () => {
  expect(appPayload("Applications", "update", { ...app, description: null })).toEqual({ displayName: "API" })
  for (const unsafe of [{ ...app, onPremisesSyncEnabled: true }, { ...app, appId: actor.clientId }]) {
    const env = world(), candidate = step("update", "ServicePrincipals")
    env.objects.set(`servicePrincipals/${app.id}`, unsafe)
    candidate.directory!.expectedAppId = String(unsafe.appId)
    candidate.preview = restoreFingerprint(unsafe)
    await expect(env.io.write(candidate, candidate.desired, candidate.targetId, () => {})).rejects.toThrow()
    if ("onPremisesSyncEnabled" in unsafe) await expect(env.io.review(candidate)).rejects.toThrow("source directory")
    else expect((await env.io.review(candidate)).blocker).toContain("protected")
    expect(env.writes).toEqual([])
  }
})
it("keeps saved app roles blocked after the lab recreation refusal despite all approvals", async () => {
  const env = world(), data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const service = new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher, () => [], env.settings)
  const assignment = { id: "A".repeat(43), principalId: client.id, resourceId: app.id, appRoleId: id(90) }
  const declare = (rows: unknown[], ids = false) => ({ format: ids ? "sorted-id-shards-v1" : "sorted-object-shards-v1", count: rows.length, shards: rows.length ? 1 : 0, complete: true, hash: createHash("sha256").update(rows.map(row => JSON.stringify(row)+"\n").join("")).digest("hex") })
  const saved = { ...client, owners: declare([], true), appRoleAssignments: declare([assignment]), appRoleAssignedTo: declare([]) }
  const request = { path: `backup/ServicePrincipals/${client.id}.json`, snapshot: saved, origin: "restore" as const }
  const page = await service.prepare(actor.tenantId, request, { stage: "relationships", exactMembers: false, exactOwners: false }, async path => path.includes("appRoleAssignments") ? [assignment] : path.includes(String(client.id)) ? client : app)
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]!.review.blocker).toContain("HTTP 400")
  expect(page.rows[0]!.review.approvals).toEqual(["directory-item", "privileged-relationship", "security-response"])
  await expect(service.execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).rejects.toThrow("Approve each")
  expect(env.roles).toEqual([])
  expect(env.writes).toEqual([])
})
it.each(["update"] as const)("requires the exact delegated %s permission at final send", async action => {
  const { approveDirectory } = await import("../src/main/restore/directory-9a")
  const env = world(), narrow = `h.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: "Application.Read.All Directory.Read.All" })).toString("base64url")}.s`
  const io = directory9bIO(narrow, actor, env.fetcher, () => [], () => env.settings.get(actor.tenantId).entra)
  const candidate = action === "update" ? await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, io, async () => app) : await applicationObjectStep("OAuth2PermissionGrants", { id: "A".repeat(43), clientId: client.id, resourceId: app.id, consentType: "AllPrincipals", principalId: null, scope: "Test.Read" }, io, async (_folder, sourceId) => sourceId === client.id ? client : app)
  const run = { version: 1 as const, id: id(99), tenant: actor.tenantId, actor, origin: "restore" as const, source: { path: "owned/path", fingerprint: "source" }, entries: [], mappings: [] }
  for (const kind of (await io.review(candidate)).approvals) approveDirectory(candidate, run, kind)
  await expect(io.write(candidate, candidate.desired, candidate.targetId, () => {}, run)).rejects.toThrow("least-privileged permission")
  expect(env.writes).toEqual([])
})

function runFor(candidate: GuardedStep): GuardedRun {
  const run: GuardedRun = { version: 1, id: id(99), tenant: actor.tenantId, actor, origin: "restore", source: { path: `backup/${candidate.folder}/${candidate.sourceId}.json`, fingerprint: "source" }, entries: [{ step: candidate, state: "pending" }], mappings: [] }
  for (const kind of ["directory-item", "privileged-relationship", "security-response"]) approveDirectory(candidate, run, kind)
  return run
}
function persisted(env = world(), protectedIds: string[] = []) {
  const data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher, () => protectedIds, env.settings)
  return { ...env, store, data, service }
}
const options = { stage: "object" as const, exactMembers: false, exactOwners: false }
const metadataRequest = (saved: Item = { ...app, displayName: "Saved", description: "Saved description" }) => ({ path: `backup/Applications/${app.id}.json`, snapshot: saved, origin: "restore" as const })
const optOutVariants = ["area", "service", "backup"] as const
function optOut(settings: ModuleSettings, variant: typeof optOutVariants[number]) {
  if (variant === "area") settings.setArea(actor.tenantId, "entra", "applications", false)
  if (variant === "service") settings.set(actor.tenantId, "entra", false)
  if (variant === "backup") settings.setAccess(actor.tenantId, "entra", "backup")
}
it.each(optOutVariants)("refuses application preview and final send after %s opt-out with a still-consented token", async variant => {
  const env = persisted(), request = metadataRequest()
  const page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  optOut(env.settings, variant)
  await expect(env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)).rejects.toThrow("Backup and restore access")
  await expect(env.io.preview(step("update"))).rejects.toThrow("Backup and restore access")
  const result = await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  expect(result).toMatchObject({ status: "partial", outcomes: [{ state: "failed-before-send" }] })
  expect(env.writes).toEqual([])
})
it("refuses preview and send when no saved settings provider is supplied", async () => {
  const env = world(), io = directory9bIO(token, actor, env.fetcher)
  const candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, io, async () => app)
  await expect(io.preview(candidate)).rejects.toThrow("Backup and restore access")
  await expect(io.write(candidate, candidate.desired, candidate.targetId, () => {}, runFor(candidate))).rejects.toThrow("Backup and restore access")
  const data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const service = new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher)
  await expect(service.prepare(actor.tenantId, metadataRequest(), options, async () => app)).rejects.toThrow("Backup and restore access")
  expect(env.writes).toEqual([])
})
it.each(optOutVariants)("rechecks saved %s opt-out during the final GET before recording a send", async variant => {
  const env = world(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  const run = runFor(candidate), original = env.fetcher.getMockImplementation()!, before = vi.fn()
  let reads = 0
  env.fetcher.mockImplementation((url, init) => {
    if (new URL(String(url)).pathname === `/v1.0/applications/${app.id}` && (!init?.method || init.method === "GET") && ++reads === 2) optOut(env.settings, variant)
    return original(url, init)
  })
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, before, run)).rejects.toThrow("Backup and restore access")
  expect(before).not.toHaveBeenCalled()
  expect(env.writes).toEqual([])
})
it.each(optOutVariants)("reconciles a sent but uncertain write after %s opt-out without resending", async variant => {
  const env = persisted(), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init)
    return init?.method === "PATCH" ? new Response(null, { status: 504 }) : response
  })
  const request = metadataRequest(), page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  const approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  const first = await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, approvals)
  expect(first).toMatchObject({ status: "partial", outcomes: [{ state: "uncertain" }] })
  optOut(env.settings, variant)
  expect(await env.service().resume(actor.tenantId, { ...request, runId: page.runId })).toEqual({ ...page, unresolved: true, canDiscard: false, selection: page.rows.map(row => row.key), outcomes: first.outcomes })
  expect(await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, approvals)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.writes).toHaveLength(1)
})
it.each([408, 500, 502, 503, 504])("reconciles a committed PATCH followed by HTTP %s after restart with exactly one send", async status => {
  const env = persisted(), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init)
    return init?.method === "PATCH" ? new Response(null, { status }) : response
  })
  const request = metadataRequest(), page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  const approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  const first = await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, approvals)
  expect(first).toMatchObject({ status: "partial", outcomes: [{ state: "uncertain" }] })
  expect(env.writes).toHaveLength(1)
  expect(await env.service().resume(actor.tenantId, { ...request, runId: page.runId })).toEqual({ ...page, unresolved: true, canDiscard: false, selection: page.rows.map(row => row.key), outcomes: first.outcomes })
  const resumed = await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, approvals)
  expect(resumed).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.writes).toHaveLength(1)
})
it("keeps an unmatched ambiguous PATCH uncertain across restarts without resending", async () => {
  const env = persisted(), original = env.fetcher.getMockImplementation()!, sends = vi.fn()
  env.fetcher.mockImplementation((url, init) => {
    if (init?.method === "PATCH") { sends(); return Promise.resolve(new Response(null, { status: 504 })) }
    return original(url, init)
  })
  const request = metadataRequest(), page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  for (let restart = 0; restart < 3; restart++) {
    const result = await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
    expect(result).toMatchObject({ status: "partial", outcomes: [{ state: "uncertain" }] })
  }
  expect(sends).toHaveBeenCalledOnce()
})
it.each([400, 401, 403])("records HTTP %s as a definite metadata refusal", async status => {
  const env = persisted(), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((url, init) => init?.method === "PATCH" ? Promise.resolve(new Response(null, { status })) : original(url, init))
  const request = metadataRequest(), page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  expect(await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).toMatchObject({ status: "partial", outcomes: [{ state: "failed" }] })
})
it.each([null, "", "   "])("offers a valid name change while explaining a blocked description clear %s", async description => {
  const env = persisted(), request = metadataRequest({ ...app, displayName: "Saved", description })
  const page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  expect(page.rows[0]!.review).toMatchObject({ changes: [{ property: "displayName", before: "API", after: "Saved" }] })
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  expect(page.rows[0]!.review.notices.join(" ")).toContain("description: clearing")
  await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  expect(JSON.parse(String(env.fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")![1]?.body))).toEqual({ displayName: "Saved" })
})
it("evaluates description independently of a blocked name clear and refuses clear-only previews", async () => {
  const env = persisted(), request = metadataRequest({ ...app, displayName: null, description: "Saved description" })
  const page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  expect(page.rows[0]!.review.changes).toEqual([{ property: "description", before: null, after: "Saved description" }])
  expect(page.rows[0]!.review.notices.join(" ")).toContain("displayName: clearing")
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  const clear = metadataRequest({ ...app, displayName: null, description: null })
  const blocked = await env.service().prepare(actor.tenantId, clear, options, async () => clear.snapshot)
  expect(blocked.rows[0]!.review.blocker).toContain("No nonempty")
  await expect(env.service().execute(actor.tenantId, { ...clear, runId: blocked.runId }, blocked.fingerprint, { [blocked.rows[0]!.key]: blocked.rows[0]!.review.approvals })).rejects.toThrow("Approve each")
  expect(env.writes).toEqual([])
})
it("uses the same final preview preimage for displayed changes and fingerprint, sending only displayed keys", async () => {
  const env = persisted(), request = metadataRequest({ ...app, displayName: "Saved", description: "Same" })
  env.objects.get(`applications/${app.id}`)!.description = "Same"
  const original = env.fetcher.getMockImplementation()!
  let reads = 0
  env.fetcher.mockImplementation((url, init) => {
    if (new URL(String(url)).pathname === `/v1.0/applications/${app.id}` && (!init?.method || init.method === "GET") && ++reads === 3) env.objects.get(`applications/${app.id}`)!.displayName = "Changed before preview"
    return original(url, init)
  })
  const page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  expect(page.rows[0]!.review.changes).toEqual([{ property: "displayName", before: "Changed before preview", after: "Saved" }])
  const raw = JSON.parse(env.data.get(`restore.directory.review.${actor.tenantId}.${page.runId}`)!)
  expect(raw.run.entries[0].step.preview).toBe(restoreFingerprint(await env.io.read(raw.run.entries[0].step)))
  expect(raw.run.entries[0].step.desired).toEqual({ displayName: "Saved" })
  await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  const patch = env.fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!
  expect(JSON.parse(String(patch.body))).toEqual({ displayName: "Saved" })
  expect(patch.headers).not.toHaveProperty("If-Match")
})
it.each(["displayName", "description", "notes"])("refuses final-read drift in reviewed or unreviewed field %s", async property => {
  const env = world(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  const run = runFor(candidate), original = env.fetcher.getMockImplementation()!, before = vi.fn()
  let reads = 0
  env.fetcher.mockImplementation((url, init) => {
    if (new URL(String(url)).pathname === `/v1.0/applications/${app.id}` && (!init?.method || init.method === "GET") && ++reads === 2) env.objects.get(`applications/${app.id}`)![property] = "Concurrent edit"
    return original(url, init)
  })
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, before, run)).rejects.toThrow("tenant changed")
  expect(before).not.toHaveBeenCalled(); expect(env.writes).toEqual([])
})
it.each([
  { appId: TENUVAULT_DESKTOP_APP_ID },
  { appId: TENUVAULT_DESKTOP_APP_ID.toUpperCase() },
  { notes: "Used by the TenuVault desktop app. Delegated permissions only, no credentials." },
  { notes: "TenuVault Backup Reader: read-only, app-only identity for TenuVault scheduled backups." },
])("protects TenuVault-owned registrations at preview and final send %j", async unsafe => {
  const env = world(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  const run = runFor(candidate)
  Object.assign(env.objects.get(`applications/${app.id}`)!, unsafe)
  await expect(env.io.preview(candidate)).rejects.toThrow("protected")
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, () => {}, run)).rejects.toThrow("protected")
  expect(env.writes).toEqual([])
})
it("protects the configured Backup Reader by app ID even after a rename or marker removal", async () => {
  const env = persisted(world(), [String(app.appId)])
  await expect(env.service().prepare(actor.tenantId, metadataRequest(), options, async () => app)).rejects.toThrow("protected")
  const plain = directory9bIO(token, actor, env.fetcher, () => [], () => env.settings.get(actor.tenantId).entra), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, plain, async () => app)
  await plain.preview(candidate)
  const run = runFor(candidate), protectedIO = directory9bIO(token, actor, env.fetcher, () => [String(app.appId)], () => env.settings.get(actor.tenantId).entra)
  await expect(protectedIO.write(candidate, candidate.desired, candidate.targetId, () => {}, run)).rejects.toThrow("protected")
  expect(env.writes).toEqual([])
})
it.each(["lowercase", "uppercase"])("protects a configured %s app ID against mixed-case live app IDs at preview and send", async variant => {
  const protectedId = "abcdefab-cdef-4abc-8def-abcdefabcdef"
  const env = world(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  const run = runFor(candidate)
  const protectedIO = directory9bIO(token, actor, env.fetcher, () => [variant === "uppercase" ? protectedId.toUpperCase() : protectedId], () => env.settings.get(actor.tenantId).entra)
  env.objects.get(`applications/${app.id}`)!.appId = variant === "uppercase" ? protectedId : protectedId.toUpperCase()
  await expect(protectedIO.preview(candidate)).rejects.toThrow("protected")
  await expect(protectedIO.write(candidate, candidate.desired, candidate.targetId, () => {}, run)).rejects.toThrow("protected")
  expect(env.writes).toEqual([])
})
it("refuses an uppercase Microsoft owner tenant on an application at preview and send", async () => {
  const env = world(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  const run = runFor(candidate)
  env.objects.get(`applications/${app.id}`)!.appOwnerOrganizationId = MICROSOFT_ORGANIZATION_ID.toUpperCase()
  await expect(env.io.preview(candidate)).rejects.toThrow("Microsoft first-party")
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, () => {}, run)).rejects.toThrow("Microsoft first-party")
  expect(env.writes).toEqual([])
})
it.each(["microsoft", "microsoft-uppercase", "failed lookup", "ambiguous", "missing-owner", "wrong-type", "wrong-appId"])("refuses an Application with %s identity at preview and final send", async variant => {
  const env = world(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  const run = runFor(candidate), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((url, init) => {
    if (new URL(String(url)).pathname === "/v1.0/servicePrincipals") {
      if (variant === "failed lookup") return Promise.resolve(Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 }))
      const principal = { ...app }
      if (variant === "microsoft") principal.appOwnerOrganizationId = MICROSOFT_ORGANIZATION_ID
      if (variant === "microsoft-uppercase") principal.appOwnerOrganizationId = MICROSOFT_ORGANIZATION_ID.toUpperCase()
      if (variant === "missing-owner") delete (principal as Item).appOwnerOrganizationId
      if (variant === "wrong-type") principal.servicePrincipalType = "ManagedIdentity"
      if (variant === "wrong-appId") principal.appId = id(88)
      return Promise.resolve(Response.json({ value: variant === "ambiguous" ? [principal, principal] : [principal] }))
    }
    return original(url, init)
  })
  await expect(env.io.preview(candidate)).rejects.toThrow()
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, () => {}, run)).rejects.toThrow()
  expect(env.writes).toEqual([])
})
it("requests no blocked-action scopes in restore, in any mode or area selection", () => {
  for (const folder of DIRECTORY_9B_FOLDERS) for (const action of ["create", "update", "recycle", "gallery", "owner", "consent", "app-role", "policy"] as const) {
    const permissions = applicationPermissions(step(action, folder))
    for (const scope of ["DelegatedPermissionGrant.ReadWrite.All", "AppRoleAssignment.ReadWrite.All", "AppRegistration.Create", "Directory.Read.All"]) expect(permissions).not.toContain(scope)
  }
  for (const mode of ["delegated", "application"] as const) for (const areas of [[], ["applications"]]) {
    const backup = graphPermissions({ entra: { access: "backup", areas } }, mode)
    const restore = graphPermissions({ entra: { access: "restore", areas } }, mode)
    const added = restore.filter(scope => !backup.includes(scope))
    for (const scope of ["DelegatedPermissionGrant.ReadWrite.All", "AppRoleAssignment.ReadWrite.All", "AppRegistration.Create", "Directory.Read.All", "Directory.ReadWrite.All", "Organization.ReadWrite.All"]) expect(added).not.toContain(scope)
    expect(restore.includes("Application.ReadWrite.All")).toBe(mode === "delegated" && areas.includes("applications"))
  }
})
it("refuses every blocked 9b variant through persisted batch plans and journal restart", async () => {
  for (const folder of DIRECTORY_9B_FOLDERS) for (const action of ["create", "update", "recycle", "gallery", "owner", "consent", "app-role", "policy"] as const) {
    if (folder === "Applications" && action === "update") continue
    const env = persisted(), candidate = step(action, folder)
    candidate.preview = restoreFingerprint(await env.io.read(step("update")))
    const run = runFor(candidate), source = { fingerprint: "reviewed", page: async () => ({ entries: run.entries, next: null }) }
    const { entries: _entries, mappings: _mappings, ...identity } = run
    expect(await executeDirectoryBatches(env.store, identity, source, env.io)).toMatchObject({ status: "partial", failed: 1 })
    expect(await executeDirectoryBatches(env.store, identity, source, env.io)).toMatchObject({ status: "partial", failed: 1 })
    const prefix = `restore.directory.${actor.tenantId}.${run.id}.batch.0.`
    const journal = new GuardedRunJournal({ get: key => env.store.get(prefix + key), set: (key, value) => env.store.set(prefix + key, value), delete: key => env.store.delete(prefix + key) })
    expect(journal.load(actor.tenantId, run.id)!.entries[0]!.state).toBe("blocked")
    expect(env.writes).toEqual([])
  }
})

const declaration = (rows: unknown[], ids = false) => ({ format: ids ? "sorted-id-shards-v1" : "sorted-object-shards-v1", count: rows.length, shards: rows.length ? 1 : 0, complete: true, hash: createHash("sha256").update(rows.map(row => JSON.stringify(row)+"\n").join("")).digest("hex") })
const portalVariants = [
  "application-create", "application-recycle", "application-owner", "application-owner-removal",
  "enterprise-create", "enterprise-gallery", "enterprise-update", "enterprise-recycle", "enterprise-owner", "enterprise-owner-removal",
  "consent-create", "consent-update", "consent-principal",
  "appRoleAssignments", "appRoleAssignedTo",
  "tokenLifetimePolicies", "claimsMappingPolicies", "homeRealmDiscoveryPolicies", "appManagementPolicies", "tokenIssuancePolicies",
]
it.each(portalVariants)("refuses %s through the owned portal route, dispatcher and saved-page resume", async variant => {
  const env = persisted(), grant = { id: "A".repeat(43), clientId: client.id, resourceId: app.id, principalId: null, consentType: "AllPrincipals", scope: "Test.Read" }
  const enterprise = variant.startsWith("enterprise-") || variant.startsWith("appRole") || variant.endsWith("Policies")
  const consent = variant.startsWith("consent-")
  const folder = consent ? "OAuth2PermissionGrants" : enterprise ? "ServicePrincipals" : "Applications"
  const rows: Record<string, unknown[]> = {}
  let snapshot: Item = consent ? { ...grant } : { ...app, displayName: "Saved", description: "Saved description", owners: declaration([], true), appRoleAssignments: declaration([]), appRoleAssignedTo: declaration([]) }
  const relationships = variant.includes("owner") || variant.startsWith("appRole") || variant.endsWith("Policies")
  if (variant.endsWith("create") && !consent || variant.endsWith("gallery")) env.objects.delete(`${enterprise ? "servicePrincipals" : "applications"}/${app.id}`)
  if (variant.endsWith("gallery")) snapshot.tags = ["WindowsAzureActiveDirectoryGalleryApplicationPrimaryV1"]
  if (variant.endsWith("recycle")) {
    env.objects.delete(`${enterprise ? "servicePrincipals" : "applications"}/${app.id}`)
    env.objects.set(`directory/deletedItems/${app.id}`, app)
  }
  if (variant === "consent-update") env.grants.push({ ...grant, scope: "Existing.Read" })
  if (variant === "consent-principal") snapshot = { ...grant, consentType: "Principal", principalId: id(60) }
  if (variant.includes("owner")) { snapshot.owners = declaration([id(60)], true); rows.owners = [id(60)] }
  if (variant.startsWith("appRole")) {
    rows[variant] = [{ id: "B".repeat(43), principalId: client.id, resourceId: app.id, appRoleId: id(90) }]
    snapshot[variant] = declaration(rows[variant])
  }
  if (variant.endsWith("Policies")) { rows[variant] = [id(80)]; snapshot[variant] = declaration(rows[variant]!, true) }
  const original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((url, init) => String(url).includes(`users/${id(60)}`) ? Promise.resolve(Response.json({ id: id(60), displayName: "Owner", onPremisesSyncEnabled: null })) : original(url, init))
  const path = `backup/${folder}/${snapshot.id}.json`
  const storage = vi.fn(async (url: RequestInfo | URL) => {
    const text = String(url)
    if (text.includes("oauth2")) return Response.json({ access_token: "storage-test-token" })
    if (text.endsWith("metadata.json")) return Response.json({ TenantId: actor.tenantId })
    if (text.endsWith(".tenuvault-owner.json")) return new Response(null, { status: 404 })
    if (text.endsWith(path)) return Response.json(snapshot)
    const shard = Object.keys(rows).find(kind => text.includes(kind))
    if (shard) return Response.json(rows[shard])
    return Response.json(text.includes(String(client.id)) ? client : app)
  })
  const base = { tenantId: actor.tenantId, appId: actor.clientId, clientSecret: "placeholder", storageAccountName: "store", backupId: "backup", path, stage: relationships ? "relationships" : "object", exactOwners: variant.endsWith("removal") }
  const call = async (body: object) => POST(new Request("http://localhost/api/restore-directory", { method: "POST", body: JSON.stringify({ ...base, ...body }) }) as Parameters<typeof POST>[0])
  try {
    vi.stubGlobal("fetch", storage)
    setDirectoryRestoreService(env.service())
    const response = await call({ action: "preview" }), page = await response.json()
    if (["application-owner-removal", "enterprise-owner-removal", "consent-principal"].includes(variant)) {
      expect(response.status).toBe(409)
      expect(page.error).toContain(variant === "consent-principal" ? "Raw saved principal IDs" : "Exact removal")
    } else {
      expect(response.status).toBe(200)
      expect(page.rows).toHaveLength(1)
      expect(page.rows[0].review.blocker).toBeTruthy()
      setDirectoryRestoreService(env.service())
      expect(await (await call({ action: "resume", runId: page.runId })).json()).toEqual(page)
      const refused = await call({ action: "restore", runId: page.runId, fingerprint: page.fingerprint, approvals: { [page.rows[0].key]: ["directory-item", "privileged-relationship", "security-response"] } })
      expect(refused.status).toBe(409)
      expect((await refused.json()).error).toContain("Approve each")
    }
    expect(env.writes).toEqual([])
    expect(storage.mock.calls.every(([url]) => !String(url).includes("graph.microsoft.com"))).toBe(true)
  } finally { vi.unstubAllGlobals() }
})


async function ownedMetadataRoute(env: ReturnType<typeof persisted>, snapshot: Item, run: (call: (body: object) => ReturnType<typeof POST>) => Promise<void>) {
  const path = `backup/Applications/${app.id}.json`
  const storage = vi.fn(async (url: RequestInfo | URL) => {
    const text = String(url)
    if (text.includes("oauth2")) return Response.json({ access_token: "storage-test-token" })
    if (text.endsWith("metadata.json")) return Response.json({ TenantId: actor.tenantId })
    if (text.endsWith(".tenuvault-owner.json")) return new Response(null, { status: 404 })
    if (text.endsWith(path)) return Response.json(snapshot)
    throw new Error("Unexpected backup read")
  })
  const base = { tenantId: actor.tenantId, appId: actor.clientId, clientSecret: "placeholder", storageAccountName: "store", backupId: "backup", path, stage: "object" }
  const call = (body: object) => POST(new Request("http://localhost/api/restore-directory", { method: "POST", body: JSON.stringify({ ...base, ...body }) }) as Parameters<typeof POST>[0])
  try {
    vi.stubGlobal("fetch", storage)
    setDirectoryRestoreService(env.service())
    await run(call)
    expect(storage.mock.calls.some(([url]) => String(url).endsWith(path))).toBe(true)
    expect(storage.mock.calls.every(([url]) => !String(url).includes("graph.microsoft.com"))).toBe(true)
  } finally { vi.unstubAllGlobals() }
}
it.each(["misfiled", "saved-appId", "live-objectId", "preview-appId"])('rejects %s identity through the owned route before saving a preview', async variant => {
  const env = persisted(), snapshot = { ...app, displayName: "Saved", ...(variant === "misfiled" ? { id: client.id } : {}), ...(variant === "saved-appId" ? { appId: client.appId } : {}) }
  if (variant === "live-objectId") env.objects.get(`applications/${app.id}`)!.id = id(88)
  if (variant === "preview-appId") {
    const original = env.fetcher.getMockImplementation()!
    let reads = 0
    env.fetcher.mockImplementation((url, init) => {
      if (new URL(String(url)).pathname === `/v1.0/applications/${app.id}` && (!init?.method || init.method === "GET") && ++reads === 3) env.objects.get(`applications/${app.id}`)!.appId = client.appId
      return original(url, init)
    })
  }
  await ownedMetadataRoute(env, snapshot, async call => {
    const response = await call({ action: "preview" }), result = await response.json()
    expect(response.status).toBe(409)
    expect(result.error).toContain(variant === "misfiled" ? "filename does not match" : variant === "live-objectId" ? "directory object identity changed" : "app ID does not match")
    expect([...env.data.keys()].some(key => key.startsWith("restore.directory."))).toBe(false)
    expect(env.writes).toEqual([])
  })
})
it.each(["before-execution", "final-read"])('refuses appId changes at %s through the owned route and saved-page restart', async timing => {
  const env = persisted(), request = metadataRequest()
  await ownedMetadataRoute(env, request.snapshot, async call => {
    const response = await call({ action: "preview" }), page = await response.json()
    expect(response.status).toBe(200)
    expect(page.rows[0].review.blocker).toBeUndefined()
    const raw = JSON.parse(env.data.get(`restore.directory.review.${actor.tenantId}.${page.runId}`)!)
    expect(raw.run.entries[0].step.directory.expectedAppId).toBe(app.appId)
    setDirectoryRestoreService(env.service())
    expect(await (await call({ action: "resume", runId: page.runId })).json()).toEqual(page)
    if (timing === "before-execution") env.objects.get(`applications/${app.id}`)!.appId = client.appId
    else {
      const original = env.fetcher.getMockImplementation()!
      let reads = 0
      env.fetcher.mockImplementation((url, init) => {
        // Initial capture and reference review each read twice. Change at the writer's final read.
        if (new URL(String(url)).pathname === `/v1.0/applications/${app.id}` && (!init?.method || init.method === "GET") && ++reads === 5) env.objects.get(`applications/${app.id}`)!.appId = client.appId
        return original(url, init)
      })
    }
    const approvals = { [page.rows[0].key]: ["directory-item"] }
    const result = await (await call({ action: "restore", runId: page.runId, fingerprint: page.fingerprint, approvals })).json()
    expect(result).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: timing === "final-read" ? "failed-before-send" : "blocked" }] })
    if (timing === "before-execution") expect(result.outcomes[0].reason).toContain("app ID does not match")
    expect(env.writes).toEqual([])
  })
})
it("refuses a metadata write without the expected appId from its saved plan", async () => {
  const env = world(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  delete candidate.directory!.expectedAppId
  const before = vi.fn()
  await expect(env.io.write(candidate, candidate.desired, candidate.targetId, before, runFor(candidate))).rejects.toThrow("reference could not be resolved")
  expect(before).not.toHaveBeenCalled()
  expect(env.writes).toEqual([])
})

it.each(["success", "503", "timeout"])("keeps cancellation plus %s during the final application read resumable with exactly one PATCH", async failure => {
  const env = persisted(), service = env.service(), request = metadataRequest()
  const page = await service.prepare(actor.tenantId, request, options, async () => request.snapshot)
  const original = env.fetcher.getMockImplementation()!
  let release!: () => void, reached!: () => void, reads = 0
  const finalRead = new Promise<void>(resolve => { reached = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    // Capture, reference review and final writer read each resolve the application twice.
    if (new URL(String(input)).pathname === `/v1.0/applications/${app.id}` && (!init?.method || init.method === "GET") && ++reads === 6) {
      reached(); await new Promise<void>(resolve => { release = resolve })
      expect(init?.signal?.aborted).toBe(true)
      if (failure === "503") return new Response(null, { status: 503 })
      if (failure === "timeout") throw new DOMException("Read timed out", "TimeoutError")
    }
    return original(input, init)
  })
  const saved = { ...request, runId: page.runId }, approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  const pending = service.execute(actor.tenantId, saved, page.fingerprint, approvals)
  await finalRead; await service.cancel(actor.tenantId, page.runId); release()
  const result = await pending
  expect(result).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }] })
  expect(env.writes).toEqual([])
  const restarted = env.service()
  expect(await restarted.resume(actor.tenantId, saved)).toEqual({ ...page, unresolved: true, selection: page.rows.map(row => row.key), outcomes: result.outcomes })
  expect(await restarted.execute(actor.tenantId, saved, page.fingerprint, approvals)).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
  await env.service().execute(actor.tenantId, saved, page.fingerprint, approvals)
  expect(env.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1)
  expect(env.writes).toEqual([`applications/${app.id}`])
})

it("persists a confirmed 429 as unapplied and repeats final reads before exactly one retry", async () => {
  const env = persisted(), request = metadataRequest()
  const page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  const original = env.fetcher.getMockImplementation()!
  let sends = 0
  env.fetcher.mockClear().mockImplementation((url, init) => init?.method === "PATCH" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "2" } })) : original(url, init))
  vi.useFakeTimers()
  try {
    const pending = env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
    await vi.advanceTimersByTimeAsync(0)
    expect(sends).toBe(1)
    const journal = [...env.data.entries()].find(([key]) => key.includes("batch.0.restore.guarded."))!
    const entry = JSON.parse(journal[1]).runs[page.runId].entries[0]
    expect(entry.state).toBe("deferred")
    expect(entry.retryAt).toBe(Date.now() + 2000)
    await vi.advanceTimersByTimeAsync(1999)
    expect(sends).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
    expect(sends).toBe(2)
    expect(env.fetcher.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === `/v1.0/applications/${app.id}` && init?.method === "GET")).toHaveLength(8)
    expect(env.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/v1.0/servicePrincipals" && new URL(String(url)).searchParams.get("$filter")?.includes(app.appId))).toHaveLength(4)
    expect(env.writes).toEqual([`applications/${app.id}`])
    expect([...env.data.keys()].some(key => key.startsWith("restore.directory.unanswered."))).toBe(false)
  } finally { vi.useRealTimers() }
})
it("cancels a 429 backoff and resumes the saved page without violating Retry-After", async () => {
  const env = persisted(), request = metadataRequest(), service = env.service()
  const page = await service.prepare(actor.tenantId, request, options, async () => request.snapshot)
  const original = env.fetcher.getMockImplementation()!
  let sends = 0
  env.fetcher.mockImplementation((url, init) => init?.method === "PATCH" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "2" } })) : original(url, init))
  const saved = { ...request, runId: page.runId }, approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  vi.useFakeTimers()
  try {
    const pending = service.execute(actor.tenantId, saved, page.fingerprint, approvals)
    await vi.advanceTimersByTimeAsync(0)
    await service.cancel(actor.tenantId, page.runId)
    const result = await pending
    expect(result).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }] })
    expect(sends).toBe(1); expect(env.writes).toEqual([])
    const restarted = env.service()
    expect(await restarted.resume(actor.tenantId, saved)).toEqual({ ...page, unresolved: true, selection: page.rows.map(row => row.key), outcomes: result.outcomes })
    const resumed = restarted.execute(actor.tenantId, saved, page.fingerprint, approvals)
    await vi.advanceTimersByTimeAsync(1999)
    expect(sends).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await resumed).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
    await env.service().execute(actor.tenantId, saved, page.fingerprint, approvals)
    expect(sends).toBe(2); expect(env.writes).toEqual([`applications/${app.id}`])
  } finally { vi.useRealTimers() }
})
it.each(["opt-in", "origin", "identity", "protected", "drift", "approval"])("rechecks %s before retrying a confirmed application throttle", async change => {
  const env = world(), protectedIds: string[] = []
  const wait = vi.fn(async () => {
    if (change === "opt-in") optOut(env.settings, "area")
    if (change === "origin") run.origin = "import"
    if (change === "identity") env.objects.get(`applications/${app.id}`)!.appId = client.appId
    if (change === "protected") protectedIds.push(app.appId)
    if (change === "drift") env.objects.get(`applications/${app.id}`)!.displayName = "Changed during backoff"
    if (change === "approval") delete candidate.directoryApprovals
  })
  const io = directory9bIO(token, actor, env.fetcher, () => protectedIds, () => env.settings.get(actor.tenantId).entra, wait)
  const candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, io, async () => app)
  await io.preview(candidate)
  const run = runFor(candidate), original = env.fetcher.getMockImplementation()!, beforeSend = vi.fn(), unapplied = vi.fn()
  env.fetcher.mockImplementation((url, init) => init?.method === "PATCH" ? Promise.resolve(new Response(null, { status: 429 })) : original(url, init))
  await expect(io.write(candidate, candidate.desired, candidate.targetId, beforeSend, run, undefined, unapplied)).rejects.toThrow()
  expect(beforeSend).toHaveBeenCalledOnce(); expect(unapplied).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledOnce()
  expect(env.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1)
  expect(env.writes).toEqual([])
})
it.each([503, "timeout", "network"])("keeps an unapplied but unconfirmed %s PATCH uncertain across consistent old reads", async failure => {
  const env = persisted(), request = metadataRequest(), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((url, init) => {
    if (init?.method !== "PATCH") return original(url, init)
    if (failure === "timeout") return Promise.reject(new DOMException("Timed out", "TimeoutError"))
    if (failure === "network") return Promise.reject(new TypeError("Network unavailable"))
    return Promise.resolve(new Response(null, { status: Number(failure) }))
  })
  const page = await env.service().prepare(actor.tenantId, request, options, async () => request.snapshot)
  for (let restart = 0; restart < 4; restart++) expect(await env.service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).toMatchObject({ status: "partial", outcomes: [{ state: "uncertain" }] })
  expect(env.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1)
  expect(env.writes).toEqual([])
})
it.each(["120", "1"])("defers a confirmed application throttle at Retry-After %s when the retry budget ends", async header => {
  const env = persisted(), wait = vi.fn(async (_ms: number) => {})
  const io = directory9bIO(token, actor, env.fetcher, () => [], () => env.settings.get(actor.tenantId).entra, wait)
  const candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, io, async () => app)
  await io.preview(candidate)
  const run = runFor(candidate), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((url, init) => init?.method === "PATCH" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": header } })) : original(url, init))
  const result = await executeGuardedRun(new GuardedRunJournal(env.store), run, io)
  expect(result).toMatchObject({ status: "partial", run: { entries: [{ state: "deferred", retryAt: expect.any(Number) }] } })
  expect(env.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(header === "120" ? 1 : 5)
  expect(wait).toHaveBeenCalledTimes(header === "120" ? 0 : 4)
  expect(env.writes).toEqual([])
})

it.each(["headers", "body"])("reports cancellation of an application GET during %s transport", async phase => {
  const env = world(), controller = new AbortController()
  const fetcher: typeof fetch = async () => {
    if (phase === "headers") { controller.abort(); throw new Error("Connection aborted") }
    return new Response(new ReadableStream({ start(stream) { controller.abort(); stream.error(new Error("Connection aborted")) } }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  const io = directory9bIO(token, actor, fetcher)
  const step = await applicationObjectStep("Applications", app, directory9bIO(token, actor, env.fetcher), async () => app)
  await expect(io.read(step, String(app.id), controller.signal)).rejects.toThrow("cancelled")
})

it("removes unpublished application relationship inventory after repeated page-save failures", async () => {
  const env = world(), ids = [id(60)], data = new Map<string, string>()
  const snapshot = { ...app, owners: { format: "sorted-id-shards-v1", complete: true, count: 1, shards: 1, hash: createHash("sha256").update(JSON.stringify(ids[0]) + "\n").digest("hex") } }
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => {
    if (key.startsWith("restore.directory.review.")) throw new Error("Preview save unavailable")
    data.set(key, value)
  }, delete: (key: string) => { data.delete(key) } }
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher, () => [], env.settings)
  const request = { path: `backup/Applications/${app.id}.json`, snapshot, origin: "restore" as const }
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(service().prepare(actor.tenantId, request, { stage: "relationships", exactMembers: false, exactOwners: false }, async () => ids)).rejects.toThrow("Preview save unavailable")
    expect(data.size).toBe(0)
  }
  expect(env.writes).toEqual([])
})


it("attempts every unpublished application inventory delete and retries the failed record", async () => {
  const env = world(), ids = Array.from({ length: 101 }, (_, n) => id(100 + n)), data = new Map<string, string>(), deletes: string[] = []
  const snapshot = { ...app, owners: { format: "sorted-id-shards-v1", complete: true, count: ids.length, shards: 1, hash: createHash("sha256").update(ids.map(id => JSON.stringify(id) + "\n").join("")).digest("hex") } }
  let failing = true
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => {
    if (key.startsWith("restore.directory.review.")) throw new Error("Preview save unavailable")
    data.set(key, value)
  }, delete: (key: string) => {
    deletes.push(key)
    if (failing && key.endsWith(".0")) throw new Error("Delete unavailable")
    data.delete(key)
  } }
  const service = new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher, () => [], env.settings)
  const request = { path: `backup/Applications/${app.id}.json`, snapshot, origin: "restore" as const }, options = { stage: "relationships" as const, exactMembers: false, exactOwners: false }
  await expect(service.prepare(actor.tenantId, request, options, async () => ids)).rejects.toThrow("Preview save unavailable")
  expect(deletes).toHaveLength(3); expect([...data.keys()]).toEqual([expect.stringMatching(/\.0$/)])
  failing = false
  await expect(service.prepare(actor.tenantId, request, options, async () => ids)).rejects.toThrow("Preview save unavailable")
  expect(data.size).toBe(0); expect(env.writes).toEqual([])
})

it.each([false, true])("keeps application cleanup queued across a failed review lookup (published: %s)", async published => {
  const env = world(), ids = [id(60)], data = new Map<string, string>()
  const snapshot = { ...app, owners: { format: "sorted-id-shards-v1", complete: true, count: 1, shards: 1, hash: createHash("sha256").update(JSON.stringify(ids[0]) + "\n").digest("hex") } }
  let failing = true
  const store = { partitioned: true as const, get: (key: string) => {
    if (failing && key.startsWith("restore.directory.review.")) throw new Error("Review lookup unavailable")
    return data.get(key) ?? null
  }, set: (key: string, value: string) => {
    if (failing && key.startsWith("restore.directory.review.")) {
      if (published) data.set(key, value)
      throw new Error("Review save unavailable")
    }
    data.set(key, value)
  }, delete: (key: string) => { data.delete(key) } }
  const service = new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), async () => actor, env.fetcher, () => [], env.settings)
  const request = { path: `backup/Applications/${app.id}.json`, snapshot, origin: "restore" as const }
  await expect(service.prepare(actor.tenantId, request, { stage: "relationships", exactMembers: false, exactOwners: false }, async () => ids)).rejects.toThrow("Review save unavailable")
  const records = [...data.entries()].filter(([key]) => key.startsWith("restore.directory.inventory."))
  expect(records).toHaveLength(1)
  failing = false
  await service.prepare(actor.tenantId, request, { stage: "object", exactMembers: false, exactOwners: false }, async () => ids)
  for (const [key, value] of records) expect(data.get(key)).toBe(published ? value : undefined)
  expect(env.writes).toEqual([])
})


it("defers an empty application continuation before accepting the reference list", async () => {
  const env = world(), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/servicePrincipals" ? Promise.resolve(Response.json({ value: [app], "@odata.nextLink": "" })) : original(input, init))
  await expect(env.io.preview(step("update"))).rejects.toThrow("temporary Microsoft Graph read failure")
  expect(env.writes).toEqual([])
})
it.each(["appId", "appOwnerOrganizationId"])("resumes application metadata after malformed %s ownership evidence without duplicate PATCH", async field => {
  const env = persisted(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  const run = runFor(candidate), journal = new GuardedRunJournal(env.store), original = env.fetcher.getMockImplementation()!
  approveDirectory(candidate, run, "directory-item")
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/servicePrincipals" ? Promise.resolve(Response.json({ value: [{ ...app, [field]: "invalid" }] })) : original(input, init))
  expect((await executeGuardedRun(journal, run, env.io)).run.entries[0]!.state).toBe("deferred")
  expect(env.writes).toEqual([])
  env.fetcher.mockImplementation(original)
  expect((await executeGuardedRun(journal, run, env.io)).run.entries[0]!.state).toBe("applied")
  await executeGuardedRun(journal, run, env.io)
  expect(env.writes).toEqual([`applications/${app.id}`])
})

it("reads a user's opaque app role assignment from the users endpoint", async () => {
  const env = world(), userId = id(60)
  env.objects.set(`users/${userId}`, { id: userId, displayName: "Sample user", onPremisesSyncEnabled: null })
  const assignment = { ...graphAssignment, principalId: userId, principalType: "User", resourceId: app.id, appRoleId: id(90) }
  env.roles.push(assignment)
  const candidate = step("app-role")
  candidate.directory = { action: "app-role", resourceAppId: app.appId, principalId: userId }
  candidate.desired = { appRoleId: id(90) }
  expect(await env.io.read(candidate)).toEqual(assignment)
  const paths = env.fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)
  expect(paths).toContain(`/v1.0/users/${userId}/appRoleAssignments`)
  expect(paths).not.toContain(`/v1.0/servicePrincipals/${userId}/appRoleAssignments`)
  expect(env.writes).toEqual([])
})
it("finishes normal application metadata preview without reading app role assignments", async () => {
  const env = world()
  expect(await env.io.preview(step("update"))).toMatchObject({ changes: [{ property: "displayName", before: "API", after: "Saved" }] })
  expect(env.fetcher.mock.calls.every(([input]) => !String(input).includes("appRoleAssignments"))).toBe(true)
  expect(env.writes).toEqual([])
})
it("defers a repeated application nextLink before fetching it again", async () => {
  const env = world(), original = env.fetcher.getMockImplementation()!
  const next = "https://graph.microsoft.com/v1.0/servicePrincipals?$skiptoken=repeat"
  let reads = 0
  env.fetcher.mockImplementation((input, init) => {
    if (new URL(String(input)).pathname === "/v1.0/servicePrincipals") { reads++; return Promise.resolve(Response.json({ value: [], "@odata.nextLink": next })) }
    return original(input, init)
  })
  await expect(async () => { for await (const _item of env.io.list("servicePrincipals")) {} }).rejects.toThrow("temporary Microsoft Graph read failure")
  expect(reads).toBe(2); expect(env.writes).toEqual([])
})

it("previews and restores a home-tenant application name without a service principal", async () => {
  const env = world(), original = env.fetcher.getMockImplementation()!, data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const application = { id: app.id, appId: app.appId, displayName: "API", description: null, notes: null }
  env.objects.set(`applications/${app.id}`, application)
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/servicePrincipals" && new URL(String(input)).searchParams.get("$filter")?.includes(app.appId) ? Promise.resolve(Response.json({ value: [] })) : original(input, init))
  const candidate = await applicationObjectStep("Applications", { ...application, displayName: "Saved" }, env.io, async () => application)
  expect(await env.io.preview(candidate)).toMatchObject({ changes: [{ property: "displayName", before: "API", after: "Saved" }] })
  const run = runFor(candidate), journal = new GuardedRunJournal(store)
  approveDirectory(candidate, run, "directory-item")
  expect((await executeGuardedRun(journal, run, env.io)).run.entries[0]!.state).toBe("applied")
  expect(application.displayName).toBe("Saved")
  await executeGuardedRun(journal, run, env.io)
  expect(env.writes).toEqual([`applications/${app.id}`])
})
it.each(["desktop appId", "backup reader appId", "marked notes", "marked name"])("protects an application without a service principal by %s", async marker => {
  const env = world(), original = env.fetcher.getMockImplementation()!
  const application = { id: app.id, appId: marker === "desktop appId" ? TENUVAULT_DESKTOP_APP_ID : marker === "backup reader appId" ? id(99) : app.appId, displayName: marker === "marked name" ? "TenuVault Backup Reader" : "API", description: null, notes: marker === "marked notes" ? "TenuVault Backup Reader: owned registration" : null }
  env.objects.set(`applications/${app.id}`, application)
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/servicePrincipals" ? Promise.resolve(Response.json({ value: [] })) : original(input, init))
  const io = directory9bIO(token, actor, env.fetcher, () => [id(99)], () => env.settings.get(actor.tenantId).entra)
  await expect(io.preview(step("update"))).rejects.toThrow("protected")
  expect(env.writes).toEqual([])
})
it.each(["ambiguous", "failed"])("defers %s optional service principal evidence instead of treating it as absent", async failure => {
  const env = persisted(), candidate = await applicationObjectStep("Applications", { ...app, displayName: "Saved" }, env.io, async () => app)
  await env.io.preview(candidate)
  const run = runFor(candidate), journal = new GuardedRunJournal(env.store), original = env.fetcher.getMockImplementation()!
  approveDirectory(candidate, run, "directory-item")
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/servicePrincipals" ? Promise.resolve(failure === "ambiguous" ? Response.json({ value: [app, app] }) : Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 })) : original(input, init))
  expect((await executeGuardedRun(journal, run, env.io)).run.entries[0]!.state).toBe("deferred")
  expect(env.writes).toEqual([])
  env.fetcher.mockImplementation(original)
  expect((await executeGuardedRun(journal, run, env.io)).run.entries[0]!.state).toBe("applied")
  expect(env.writes).toEqual([`applications/${app.id}`])
})
