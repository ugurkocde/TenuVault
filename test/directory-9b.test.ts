import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import { directory9bIO } from "../src/main/restore/directory-9b-io"
import { appPayload, applicationAdmission, applicationReview, DIRECTORY_9B_FOLDERS } from "../src/main/restore/directory-9b"
import { applicationObjectStep, applicationRelationshipSteps } from "../src/main/restore/directory-9b-plan"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { MICROSOFT_ORGANIZATION_ID } from "../src/shared/intune/entra-directory"
import { graphPermissions } from "../src/shared/services/manifest"
import { restoreCapability, typeForFolder, type Item } from "../src/shared/intune/registry"
import { restoreFingerprint, type GuardedStep } from "../src/main/restore/guarded-run"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
const actor = { tenantId: id(1), userId: id(2), clientId: id(3), applicationObjectId: id(4), servicePrincipalId: id(5), recoveryAccountIds: [id(6)] }
const app = { id: id(10), appId: id(11), displayName: "API", appOwnerOrganizationId: id(1), servicePrincipalType: "Application", appRoles: [{ id: id(90), displayName: "Test role", isEnabled: true, allowedMemberTypes: ["Application"] }], oauth2PermissionScopes: [{ value: "Test.Read", isEnabled: true }] }
const client = { ...app, id: id(12), appId: id(13), displayName: "Client" }
const token = `h.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: "Application.Read.All Directory.Read.All Application.ReadWrite.All DelegatedPermissionGrant.ReadWrite.All AppRoleAssignment.ReadWrite.All" })).toString("base64url")}.s`
function world() {
  const writes: string[] = [], objects = new Map<string, Item>(), grants: Item[] = []
  objects.set(`applications/${id(4)}`, { id: id(4), appId: id(3) })
  objects.set(`applications/${id(10)}`, app)
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace("/v1.0/", ""), method = init?.method ?? "GET"
    if (method !== "GET") { writes.push(path); return Response.json({ id: id(80) }, { status: 201 }) }
    if (path === "applications" && url.searchParams.get("$filter")?.includes(id(3))) return Response.json({ value: [{ id: id(4), appId: id(3) }] })
    if (path === "servicePrincipals") {
      const filter = url.searchParams.get("$filter") ?? ""
      return Response.json({ value: filter.includes(id(3)) ? [{ id: id(5), appId: id(3) }] : [app, client].filter(item => filter.includes(String(item.appId))) })
    }
    if (path === "oauth2PermissionGrants") return Response.json({ value: grants })
    if (path.endsWith("/owners") || path.endsWith("/appRoleAssignments")) return Response.json({ value: [] })
    if (objects.has(path)) return Response.json(objects.get(path))
    return new Response(null, { status: 404 })
  })
  const io = directory9bIO(token, actor, fetcher)
  return { io, writes, objects, grants, fetcher }
}
const step = (action: NonNullable<GuardedStep["directory"]>["action"], folder = "Applications"): GuardedStep => ({ folder, key: "test", sourceId: id(10), targetId: id(10), operation: "update", directory: { action }, desired: { displayName: "Saved" }, properties: ["displayName"], preview: restoreFingerprint(null), requires: [] })
it("keeps all 9b capabilities and every action closed without adding product permissions", async () => {
  for (const folder of DIRECTORY_9B_FOLDERS) {
    expect(restoreCapability(typeForFolder(folder)!)).toBe("none")
    for (const action of ["create", "update", "recycle", "gallery", "owner", "consent", "app-role", "policy"] as const) {
      const env = world(), candidate = step(action, folder)
      expect(applicationAdmission(candidate)).toBeTruthy()
      await expect(env.io.write(candidate, candidate.desired, id(10), () => {})).rejects.toThrow()
      expect(env.writes).toEqual([])
    }
  }
  for (const mode of ["delegated", "application"] as const) {
    const backup = graphPermissions({ entra: { access: "backup", areas: ["applications"] } }, mode)
    const restore = graphPermissions({ entra: { access: "restore", areas: ["applications"] } }, mode)
    expect(restore.includes("Directory.Read.All")).toBe(backup.includes("Directory.Read.All"))
    for (const scope of ["Application.ReadWrite.All", "Application.ReadWrite.OwnedBy", "DelegatedPermissionGrant.ReadWrite.All", "AppRoleAssignment.ReadWrite.All", "Directory.ReadWrite.All", "Organization.ReadWrite.All"]) expect(restore).not.toContain(scope)
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
  const env = world()
  const gallery = await applicationObjectStep("ServicePrincipals", { ...app, tags: ["WindowsAzureActiveDirectoryGalleryApplicationPrimaryV1"] }, env.io, async () => app)
  expect(gallery.directory).toMatchObject({ action: "gallery", unresolved: expect.stringContaining("TemplateId") })
  const original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((input, init) => String(input).includes("servicePrincipals?") ? Promise.resolve(Response.json({ value: [app, app] })) : original(input, init))
  await expect(env.io.resolveApp(String(app.appId))).rejects.toThrow("ambiguous")
})
it("uses the production service and saved page resume while refusing execution and imported origins", async () => {
  const env = world(), data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), env.fetcher)
  const request = { path: `backup/Applications/${app.id}.json`, snapshot: app, origin: "restore" as const }
  const options = { stage: "object" as const, exactMembers: false, exactOwners: false }
  const page = await service().prepare(actor.tenantId, request, options, async () => app)
  expect(page.rows).toHaveLength(1); expect(page.rows[0]!.review.blocker).toBeTruthy()
  expect(await service().resume(actor.tenantId, { ...request, runId: page.runId })).toEqual(page)
  await expect(service().execute(actor.tenantId, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).rejects.toThrow("Approve each")
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
it("enforces final-send approvals, scope validation, self-benefit, stale preview and origin even under test-only admission", async () => {
  const { restoreMatrixRow } = await import("../src/shared/intune/restore-matrix")
  const { approveDirectory } = await import("../src/main/restore/directory-9a")
  const contract = restoreMatrixRow("OAuth2PermissionGrants")!.directoryRestore!, previous = structuredClone(contract)
  try {
    contract.phase = "enabled"; contract.evidence = { consent: { date: "test", result: "round-trip-matched" } }
    const env = world(), saved = { id: "A".repeat(43), clientId: id(50), resourceId: id(51), principalId: null, consentType: "AllPrincipals", scope: "Test.Read" }
    const candidate = await applicationObjectStep("OAuth2PermissionGrants", saved, env.io, async (_folder, sourceId) => ({ id: sourceId, appId: sourceId === id(50) ? client.appId : app.appId }))
    const run = { version: 1 as const, id: id(99), tenant: actor.tenantId, actor, origin: "restore" as const, source: { path: "backup/OAuth2PermissionGrants/g.json", fingerprint: "source" }, entries: [], mappings: [] }
    const before = vi.fn()
    await expect(env.io.write(candidate, candidate.desired, undefined, before, run)).rejects.toThrow("Approve each")
    for (const kind of ["directory-item", "privileged-relationship", "security-response"]) approveDirectory(candidate, run, kind)
    await expect(env.io.write(candidate, candidate.desired, undefined, before, { ...run, origin: "import" })).rejects.toThrow("owned same-tenant")
    const cancelled = new AbortController(); cancelled.abort()
    await expect(env.io.write(candidate, candidate.desired, undefined, before, run, cancelled.signal)).rejects.toThrow("cancelled")
    expect(env.writes).toEqual([])
    await env.io.write(candidate, candidate.desired, undefined, before, run)
    expect(before).toHaveBeenCalledOnce()
    const sent = env.fetcher.mock.calls.find(([, init]) => init?.method === "POST")!
    expect(JSON.parse(String(sent[1]?.body))).toEqual({ clientId: client.id, resourceId: app.id, principalId: null, consentType: "AllPrincipals", scope: "Test.Read" })
    env.grants.push({ ...candidate.desired, id: "B".repeat(43), scope: "Other.Read" })
    await expect(env.io.write(candidate, candidate.desired, undefined, before, run)).rejects.toThrow("tenant changed")
  } finally { Object.assign(contract, previous); delete contract.evidence }
})
it("builds metadata, owner-add and role-add transports under isolated test-only admission", async () => {
  const { restoreMatrixRow } = await import("../src/shared/intune/restore-matrix")
  const { approveDirectory } = await import("../src/main/restore/directory-9a")
  const original = DIRECTORY_9B_FOLDERS.map(folder => structuredClone(restoreMatrixRow(folder)!.directoryRestore!))
  try {
    for (const folder of DIRECTORY_9B_FOLDERS) {
      const contract = restoreMatrixRow(folder)!.directoryRestore!
      contract.phase = "enabled"; contract.evidence = Object.fromEntries(["update", "owner", "app-role"].map(action => [action, { date: "test", result: "round-trip-matched" as const }]))
    }
    const env = world(), fetcher = env.fetcher.getMockImplementation()!
    env.fetcher.mockImplementation((input, init) => String(input).includes(`users/${id(60)}`) ? Promise.resolve(Response.json({ id: id(60), displayName: "Owner" })) : fetcher(input, init))
    const metadata = step("update"); metadata.preview = restoreFingerprint(app)
    const owner = step("owner"); owner.directory!.principalId = id(60); owner.desired = { present: true, principalId: id(60) }; owner.properties = Object.keys(owner.desired); owner.preview = restoreFingerprint(await env.io.read(owner))
    const assignment = step("app-role", "ServicePrincipals"); assignment.directory = { action: "app-role", clientAppId: String(client.appId), resourceAppId: String(app.appId), roleName: "Test role" }; assignment.desired = { principalId: client.id, resourceId: app.id, appRoleId: id(90) }; assignment.properties = Object.keys(assignment.desired); assignment.preview = restoreFingerprint(null); assignment.operation = "create"; delete assignment.targetId
    for (const candidate of [metadata, owner, assignment]) {
      const run = { version: 1 as const, id: id(99), tenant: actor.tenantId, actor, origin: "restore" as const, source: { path: "owned/path", fingerprint: "source" }, entries: [], mappings: [] }
      for (const kind of (await env.io.review(candidate)).approvals) approveDirectory(candidate, run, kind)
      await env.io.write(candidate, candidate.desired, candidate.targetId, () => {}, run)
    }
    const sent = env.fetcher.mock.calls.filter(([, init]) => init?.method !== "GET")
    expect(sent.map(([url, init]) => [new URL(String(url)).pathname, init?.method, JSON.parse(String(init?.body))])).toEqual([
      [`/v1.0/applications/${id(10)}`, "PATCH", { displayName: "Saved" }],
      [`/v1.0/applications/${id(10)}/owners/$ref`, "POST", { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${id(60)}` }],
      [`/v1.0/servicePrincipals/${client.id}/appRoleAssignments`, "POST", { principalId: client.id, resourceId: app.id, appRoleId: id(90) }],
    ])
  } finally { for (const [index, folder] of DIRECTORY_9B_FOLDERS.entries()) { const contract = restoreMatrixRow(folder)!.directoryRestore!; Object.assign(contract, original[index]); delete contract.evidence } }
})
it("persists bounded application relationship pages and advances beyond unresolved rows", async () => {
  const env = world(), ids = Array.from({ length: 65 }, (_, n) => id(100+n)), data = new Map<string, string>()
  const snapshot = { ...app, owners: { format: "sorted-id-shards-v1", complete: true, count: ids.length, shards: 1, hash: createHash("sha256").update(ids.map(value => JSON.stringify(value)+"\n").join("")).digest("hex") } }
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, ...actor }), env.fetcher)
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
