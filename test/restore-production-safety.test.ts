import { moduleForFolder, type Need } from "../src/shared/services/modules"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { safetyReader } from "../src/main/restore/safety-reader"
import { RecoveryAccounts, resolveRestoreActor, resolveSafetyReferences } from "../src/main/restore/safety-resolvers"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedStep, type GuardedRun, type GuardedIO } from "../src/main/restore/guarded-run"
import { IdentityRestoreService } from "../src/main/restore/service"
import { restoreSafetyRoutes } from "../src/main/restore/routes"
import { referenceMatches, REFERENCE_SCAN_EXCLUDED } from "../src/main/restore/reference-scanner"
import { bindRestoreConnection, dispatchIdentityRestore, setIdentityRestoreDispatch } from "../src/main/restore/dispatch"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { INTUNE_TYPES, typeForFolder, type Item } from "../src/shared/intune/registry"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { guardRestoreItem } from "../src/shared/intune/restore-guards"

// These 8a transport fixtures deliberately substitute future capabilities and permissions together.
const fixtureNeeds = ["SecurityDefaults", "UserFlowAttributes"].map(folder => moduleForFolder(folder)!.part.restore as { delegated: Need })
const savedNeeds = fixtureNeeds.map(need => need.delegated)
beforeEach(() => { fixtureNeeds[0]!.delegated = [["Policy.Read.All"]]; fixtureNeeds[1]!.delegated = [["IdentityUserFlow.ReadWrite.All"]] })
afterEach(() => { fixtureNeeds.forEach((need, i) => { need.delegated = savedNeeds[i]! }) })

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const user = guid(1), tenant = guid(2), client = guid(3), app = guid(4), sp = guid(5), group = guid(6), recovery = guid(7)
const token = `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: user, appid: client, scp: "Policy.ReadWrite.Authorization Policy.Read.All Policy.ReadWrite.ConditionalAccess" })).toString("base64url")}.s`
const actor = { tenantId: tenant, userId: user, clientId: client, applicationObjectId: app, servicePrincipalId: sp, recoveryAccountIds: [recovery] }
const step: GuardedStep = { key: "one", folder: "Groups", sourceId: group, operation: "update", targetId: group, properties: [], desired: {}, preview: restoreFingerprint(null), requires: [] }
function storage() {
  const values = new Map<string, string>()
  return { values, get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value) }, delete: (key: string) => { values.delete(key) } }
}
function reader() {
  const get = vi.fn(async (path: string): Promise<Item> => {
    if (path.startsWith("directoryObjects/")) return { id: path.split("/")[1]!, "@odata.type": path.includes(group) ? "#microsoft.graph.group" : "#microsoft.graph.user" }
    return { id: path.split("/")[1]!.split("?")[0]!, accountEnabled: true, userType: "Member", onPremisesSyncEnabled: null }
  })
  const list = vi.fn(async (path: string): Promise<Item[]> => {
    if (path.startsWith("applications?")) return [{ id: app, appId: client }]
    if (path.startsWith("servicePrincipals?")) return [{ id: sp, appId: client }]
    if (path.includes("transitiveMembers")) return [{ id: user }]
    if (path.includes("/owners?")) return [{ id: recovery }]
    if (path.startsWith("identityGovernance/")) return [{ principalId: recovery }]
    if (path.startsWith("roleManagement/directory/roleDefinitions")) return [{ id: guid(10), templateId: "62e90394-69f5-4237-9190-012177145e10" }, { id: guid(11), templateId: "e8611ab8-c189-46e8-94e1-60213ab1f814" }]
    if (path.endsWith("roleAssignments")) return [{ id: guid(12), principalId: group, roleDefinitionId: guid(10), directoryScopeId: "/" }]
    if (path.endsWith("roleEligibilityScheduleInstances")) return [{ id: guid(13), principalId: guid(14), roleDefinitionId: guid(11), directoryScopeId: "/", endDateTime: "2099-01-01T00:00:00Z" }]
    return []
  })
  return { get, list }
}

describe("production restore safety reads", () => {
  it("finishes collections, retains filters, and refuses malicious or incomplete continuations", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => { expect(options?.method).toBe("GET"); return Response.json(fetcher.mock.calls.length === 1 ? { value: [{ id: user }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=next" } : { value: [{ id: recovery }] }) })
    expect(await safetyReader(token, fetcher).list("users?$filter=accountEnabled%20eq%20true")).toHaveLength(2)
    expect(String(fetcher.mock.calls[1]![0])).toContain("$filter=accountEnabled%20eq%20true")
    for (const page of [{ value: [], "@odata.nextLink": "https://example.com/users" }, { value: [], "@odata.nextLink": 12 }, { value: [null] }, {}]) {
      const mock = vi.fn(async () => Response.json(page))
      await expect(safetyReader(token, mock).list("users")).rejects.toThrow()
      expect(mock).toHaveBeenCalledTimes(1)
    }
    await expect(safetyReader(token, async () => new Response("", { status: 403 })).get("users")).rejects.toThrow("403")
  })
  it("persists reviewed enabled cloud recovery accounts per tenant and refuses invalid, guest and disabled accounts", async () => {
    const store = storage(), accounts = new RecoveryAccounts(store), graph = reader()
    expect(accounts.get(tenant)).toEqual([])
    await accounts.save(tenant, [recovery, recovery], graph)
    expect(new RecoveryAccounts(store).get(tenant)).toEqual([recovery])
    expect(accounts.get(guid(20))).toEqual([])
    await expect(accounts.save(tenant, ["wrong"], graph)).rejects.toThrow()
    graph.get.mockResolvedValue({ id: user, accountEnabled: false, userType: "Guest" })
    await expect(accounts.save(tenant, [user], graph)).rejects.toThrow("enabled cloud")
    expect(accounts.get(tenant)).toEqual([recovery])
    store.set(`restore.recovery.${tenant}`, "{}")
    expect(() => accounts.get(tenant)).toThrow()
  })
  it("resolves both protected registration IDs and refuses an absent or ambiguous registration", async () => {
    const graph = reader()
    expect(await resolveRestoreActor(graph, { tenantId: tenant, clientId: client, userId: user }, [recovery])).toEqual(actor)
    graph.list.mockResolvedValue([])
    await expect(resolveRestoreActor(graph, { tenantId: tenant, clientId: client, userId: user }, [])).rejects.toThrow("both be resolved")
    await expect(resolveRestoreActor(graph, { tenantId: "bad", clientId: client, userId: user }, [])).rejects.toThrow("connection")
  })
  it("protects indirect members, owners and PIM eligible principals and resolves active and eligible remaining administrators", async () => {
    const graph = reader()
    const refs = await resolveSafetyReferences(graph, step, { id: group }, {})
    expect(refs.complete).toBe(true)
    expect(refs.principals).toEqual(expect.arrayContaining([group, user, recovery]))
    expect(refs.remainingAdministrators?.privilegedRole).toContain(guid(14))
    expect(() => guardRestoreItem(actor, step.folder, group, refs, true)).toThrow("protected")
    graph.list.mockRejectedValue(new Error("403"))
    expect((await resolveSafetyReferences(graph, step, null, {})).complete).toBe(false)
  })
  it("never counts expired, scoped, disabled or removed holders as recovery access", async () => {
    const graph = reader(), list = graph.list.getMockImplementation()!
    graph.list.mockImplementation(async path => path.endsWith("roleAssignments") ? [{ id: guid(12), principalId: guid(15), roleDefinitionId: guid(10), directoryScopeId: "/" }] : path.endsWith("roleEligibilityScheduleInstances") ? [{ id: guid(13), principalId: guid(14), roleDefinitionId: guid(11), directoryScopeId: "/", endDateTime: "2000-01-01T00:00:00Z" }] : list(path))
    const refs = await resolveSafetyReferences(graph, { ...step, folder: "EntraRoleAssignments", targetId: guid(12), allowRemoval: true }, { id: guid(12), principalId: guid(15) }, {})
    expect(refs).toMatchObject({ complete: true, remainingAdministrators: { global: [], privilegedRole: [] } })
    expect(() => guardRestoreItem(actor, "EntraRoleAssignments", guid(12), refs, true)).toThrow("last Global Administrator")
    expect((await resolveSafetyReferences(graph, step, null, { principalId: "unknown" })).complete).toBe(false)
  })
  it("scans current Intune and CA references through relevant details and extras and fails on an unread collection", async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      expect(options?.method).toBe("GET"); const url = new URL(String(input)); calls.push(url.pathname)
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [{ id: user }] })
      if (url.pathname.endsWith(`/deviceConfigurations/${user}`)) return Response.json({ id: user, displayName: "Policy", assignments: [{ target: { groupId: recovery } }] })
      if (url.pathname.endsWith("/deviceManagement")) return Response.json({ id: "settings", deviceComplianceCheckinThresholdDays: 30 })
      return Response.json({ value: [] })
    })
    const snapshots = await referenceMatches(token, [{ kind: "objectId", folder: "Users", source: recovery, target: user }], fetcher)
    expect(snapshots.some(snapshot => snapshot.path === `DeviceConfigurations/${user}`)).toBe(true)
    for (const type of INTUNE_TYPES.filter(type => type.restoreSafety !== "identity" && !type.staticIds && !type.singleton && !REFERENCE_SCAN_EXCLUDED.has(type.folder))) expect(calls.some(path => path.endsWith(`/${type.path}`))).toBe(true)
    await expect(referenceMatches(token, [], async () => new Response("", { status: 403 }))).rejects.toThrow()
  })
  it("bounds every reference request and rejects cancellation, time and size limits", async () => {
    const fetcher = vi.fn(async () => Response.json({ value: [] }))
    await expect(referenceMatches(token, [], fetcher, { requests: 2 })).rejects.toThrow("request budget")
    expect(fetcher).toHaveBeenCalledTimes(2)
    await expect(referenceMatches(token, [], fetcher, { bytes: 1 })).rejects.toThrow("size budget")
    // A large answer is cancelled once it passes the budget, not read to the end first.
    let pulled = 0, cancelled = false
    const chunk = new Uint8Array(1024 * 1024).fill(32)
    const streaming = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) { pulled++; if (pulled > 20) stream.close(); else stream.enqueue(chunk) },
      cancel() { cancelled = true },
    }), { status: 200 }))
    await expect(referenceMatches(token, [], streaming, { bytes: 4 * 1024 * 1024 })).rejects.toThrow("size budget")
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(10)
    const controller = new AbortController(); controller.abort()
    fetcher.mockClear()
    await expect(referenceMatches(token, [], fetcher, { signal: controller.signal })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    const stuck = vi.fn(() => new Promise<Response>(() => {}))
    await expect(referenceMatches(token, [], stuck, { milliseconds: 10 })).rejects.toThrow()
    expect(stuck).toHaveBeenCalledTimes(1)
  })
  it("scans paged assignments incrementally and never reads scripts, images or secret values", async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); calls.push(url.toString())
      if (url.pathname.endsWith("/deviceManagementScripts")) return Response.json({ value: [{ id: user, roleScopeTagIds: [recovery] }] })
      if (url.pathname.endsWith(`/deviceManagementScripts/${user}`)) {
        expect(url.searchParams.get("$select")).toBe("id,roleScopeTagIds")
        return Response.json({ id: user, roleScopeTagIds: [recovery], assignments: [], "assignments@odata.nextLink": `https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts/${user}/assignments?$skiptoken=next` })
      }
      if (url.pathname.endsWith("/assignments")) return Response.json({ value: [{ target: { groupId: recovery } }] })
      return Response.json({ value: [] })
    })
    const matches = await referenceMatches(token, [{ kind: "objectId", folder: "Users", source: recovery, target: user }], fetcher)
    expect(matches.map(match => match.property)).toEqual(["roleScopeTagIds.0", "assignments.0.target.groupId"])
    for (const folder of REFERENCE_SCAN_EXCLUDED) expect(calls.some(call => new URL(call).pathname.endsWith(typeForFolder(folder)!.path))).toBe(false)
    expect(calls.some(call => /PlainText|localizedNotificationMessages|themeColorLogo/.test(call))).toBe(false)
  })

})

describe("trusted identity dispatch and history", () => {
  it("requires a main-process bound connection and sends future enabled types away from the legacy writer", async () => {
    const graph: GraphCall = vi.fn(async () => { throw new Error("legacy writer reached") })
    const request = { path: "backup/SecurityDefaults/one.json", snapshot: { id: "one" }, origin: "restore" as const }
    expect((await dispatchIdentityRestore(graph, request)).success).toBe(false)
    const handler = vi.fn(async () => ({ path: request.path, success: false, error: "reviewed plan required" }))
    setIdentityRestoreDispatch(handler)
    bindRestoreConnection(graph, tenant)
    const type = typeForFolder("SecurityDefaults")!, previous = type.restore
    type.restore = "singleton"
    try {
      expect((await new Restorer(graph, { mode: "replace", assignments: false }).restore(request.path, request.snapshot)).error).toBe("reviewed plan required")
      expect((await new Restorer(graph, { mode: "replace", assignments: false }).repair(request.path, guid(25))).error).toBe("reviewed plan required")
      expect(handler).toHaveBeenCalledWith(tenant, expect.objectContaining({ origin: "repair" }))
      expect(graph).not.toHaveBeenCalled()
    } finally { type.restore = previous }
  })
  it("lists durable guarded outcomes and saved per-policy references without exposing payloads or a reset action", async () => {
    const store = storage(), journal = new GuardedRunJournal(store), accounts = new RecoveryAccounts(store)
    const run: GuardedRun = { version: 1, id: guid(26), tenant, actor, origin: "restore", entries: [{ step, state: "uncertain", sent: { displayName: "private payload" } }], mappings: [], replacedReferences: [{ path: "ConditionalAccessPolicies/policy", property: "conditions.users.excludeUsers", mapping: { kind: "objectId", folder: "Users", source: user, target: recovery } }] }
    journal.save(run)
    const service = { reconcile: vi.fn() } as unknown as IdentityRestoreService
    const connection = vi.fn(async () => ({ token, tenantId: tenant, clientId: client, userId: user }))
    const authorize = vi.fn(async () => {})
    const route = restoreSafetyRoutes(journal, accounts, connection, authorize, service)["/api/restore-safety"]!.POST!
    const call = (body: object) => route(new Request("http://localhost", { method: "POST", body: JSON.stringify({ tenantId: tenant, ...body }) }) as never)
    const response = await call({ action: "list" }); const text = await response.text()
    expect(text).toContain("ConditionalAccessPolicies/policy"); expect(text).not.toContain("private payload")
    expect((await call({ action: "not-applied", runId: run.id })).status).toBe(400)
    expect((await call({ action: "reconcile", runId: run.id })).status).toBe(200)
    expect(service.reconcile).toHaveBeenCalledWith(tenant, run.id)
    authorize.mockRejectedValue(new Error("Sign in"))
    expect((await call({ action: "list" })).status).toBe(409)
  })
  it("keeps backup-only types blocked without even resolving a connection", async () => {
    const store = storage(), connect = vi.fn(async () => ({ token, tenantId: tenant, clientId: client, userId: user }))
    const service = new IdentityRestoreService(new GuardedRunJournal(store), new RecoveryAccounts(store), connect)
    const request = { path: "backup/SecurityDefaults/one.json", snapshot: { id: user }, origin: "restore" as const }
    expect((await service.restore(tenant, request)).success).toBe(false)
    await expect(service.prepare(tenant, request, "update", user)).rejects.toThrow("backup-only")
    expect(connect).not.toHaveBeenCalled()
  })
  it("reconciles only sent steps and leaves absent creates uncertain without resetting or writing", async () => {
    const store = storage(), journal = new GuardedRunJournal(store)
    const run: GuardedRun = { version: 1, id: "run", tenant, actor, origin: "restore", entries: [{ step: { ...step, folder: "Fixture", operation: "create" }, state: "uncertain", sent: {} }, { step: { ...step, key: "pending", folder: "Fixture" }, state: "pending" }], mappings: [] }
    journal.save(run)
    const write = vi.fn(async () => ({ id: guid(33) }))
    const io: GuardedIO = { token, type: () => ({ folder: "Fixture", label: "Fixture", path: "fixture", area: "Tenant settings", nameKey: "displayName", restore: "create" as const }), read: async () => null, findCreated: async () => [], references: async () => ({ complete: true, principals: [], applications: [] }), write }
    const result = await executeGuardedRun(journal, run, io, undefined, true)
    expect(result.run.entries.map(entry => entry.state)).toEqual(["uncertain", "pending"])
    expect(write).not.toHaveBeenCalled()
  })
})

it("executes only the immutable main-process preview and reconciles through the production service without resending", async () => {
  const store = storage(), journal = new GuardedRunJournal(store)
  let live: Item = { id: "securityDefaults", isEnabled: false }
  let writes = 0
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input))
    if (options?.method !== "GET") { writes++; live = { ...live, ...JSON.parse(String(options?.body)) }; return new Response(null, { status: 204 }) }
    if (url.pathname.endsWith("applications")) return Response.json({ value: [{ id: app, appId: client }] })
    if (url.pathname.endsWith("servicePrincipals")) return Response.json({ value: [{ id: sp, appId: client }] })
    if (url.pathname.includes("identitySecurityDefaultsEnforcementPolicy")) return Response.json(live)
    return Response.json({ value: [] })
  })
  const service = new IdentityRestoreService(journal, new RecoveryAccounts(store), async () => ({ token, tenantId: tenant, clientId: client, userId: user }), fetcher)
  const type = typeForFolder("SecurityDefaults")!, previous = type.restore
  type.restore = "singleton"
  try {
    const request = { path: "backup/SecurityDefaults/securityDefaults.json", snapshot: { id: "securityDefaults", isEnabled: true }, origin: "restore" as const }
    const run = await service.prepare(tenant, request, "update", "securityDefaults")
    await service.confirm(tenant, run.id, (await service.review(tenant, run.id)).fingerprint)
    expect(writes).toBe(0)
    const altered = await service.restore(tenant, { ...request, runId: run.id, snapshot: { ...request.snapshot, isEnabled: false } })
    expect(altered.success).toBe(false)
    expect(writes).toBe(0)
    expect((await service.restore(tenant, { ...request, runId: run.id })).success).toBe(true)
    expect(writes).toBe(1)
    await service.reconcile(tenant, run.id)
    expect(writes).toBe(1)
    expect([...store.values.values()].join()).not.toContain(token)
  } finally { type.restore = previous }
})

it("loads mappings before the real prepared preview and validates newer mappings at execution", async () => {
  const store = storage(), journal = new GuardedRunJournal(store)
  const source = guid(40), created = guid(41)
  const mapping = { kind: "objectId" as const, folder: "UserFlowAttributes", source, target: created }
  const rowType = typeForFolder("UserFlowAttributes")!, previous = rowType.restore
  rowType.restore = "create"
  const contract = restoreMatrixRow("UserFlowAttributes")!.create!, blocked = contract.blockedReason
  delete contract.blockedReason
  const calls: string[] = []
  const configuration = { description: "Example", dataType: "string" }
  let exists = false
  const fetcher = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input)); calls.push(`${options?.method} ${url.pathname}`)
    if (options?.method !== "GET") { expect(exists).toBe(false); exists = true; return Response.json({ ...configuration, id: created, displayName: "original name" }) }
    if (url.pathname.endsWith("applications")) return Response.json({ value: [{ id: app, appId: client }] })
    if (url.pathname.endsWith("servicePrincipals")) return Response.json({ value: [{ id: sp, appId: client }] })
    if (url.pathname.endsWith(created)) return Response.json({ ...configuration, id: created, displayName: "changed name" })
    return Response.json({ value: [] })
  }) as typeof fetch
  const permissions = token.replace(token.split(".")[1]!, Buffer.from(JSON.stringify({ tid: tenant, oid: user, appid: client, scp: "IdentityUserFlow.ReadWrite.All Policy.Read.All" })).toString("base64url"))
  const service = new IdentityRestoreService(journal, new RecoveryAccounts(store), async () => ({ token: permissions, tenantId: tenant, clientId: client, userId: user }), fetcher)
  const request = { path: `backup/UserFlowAttributes/${source}.json`, snapshot: { ...configuration, id: source, displayName: "original name" }, origin: "restore" as const }
  try {
    const early = await service.prepare(tenant, request, "create")
    const first = await service.prepare(tenant, request, "create")
    expect((await service.restore(tenant, { ...request, runId: first.id })).success).toBe(true)
    expect((await service.restore(tenant, { ...request, runId: early.id })).success).toBe(false)
    const later = await service.prepare(tenant, request, "create")
    expect(later.mappings).toEqual([mapping])
    expect(later.entries[0]!.step.targetId).toBe(created)
    expect(later.entries[0]!.step.preview).toBe(restoreFingerprint({ ...configuration, id: created, displayName: "changed name" }))
    expect((await service.restore(tenant, { ...request, runId: later.id })).success).toBe(false)
    expect(calls.filter(call => !call.startsWith("GET"))).toHaveLength(1)
    expect(calls.some(call => call.endsWith(created))).toBe(true)
  } finally { rowType.restore = previous; contract.blockedReason = blocked }
})

for (const failure of ["preflight", "lost-response", "crash-before-send"] as const) it(`recovers the production send boundary after ${failure}`, async () => {
  const store = storage(), journal = new GuardedRunJournal(store)
  let live: Item = { id: "securityDefaults", isEnabled: false }, reads = 0, writes = 0
  let inject = true
  const fetcher = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input))
    if (options?.method !== "GET") {
      writes++; live = { ...live, ...JSON.parse(String(options?.body)) }
      if (inject && failure === "lost-response") throw new Error("response lost")
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith("applications")) return Response.json({ value: [{ id: app, appId: client }] })
    if (url.pathname.endsWith("servicePrincipals")) return Response.json({ value: [{ id: sp, appId: client }] })
    if (url.pathname.endsWith(`/users/${recovery}`)) return Response.json({ id: recovery })
    if (url.pathname.includes("identitySecurityDefaultsEnforcementPolicy")) {
      reads++
      if (inject && failure === "preflight" && reads === 5) return new Response(null, { status: 503 })
      return Response.json(live)
    }
    return Response.json({ value: [] })
  }) as typeof fetch
  const service = new IdentityRestoreService(journal, new RecoveryAccounts(store), async () => ({ token, tenantId: tenant, clientId: client, userId: user }), fetcher)
  const type = typeForFolder("SecurityDefaults")!, previous = type.restore
  type.restore = "singleton"
  try {
    const request = { path: "backup/SecurityDefaults/securityDefaults.json", snapshot: { id: "securityDefaults", isEnabled: true }, origin: "restore" as const }
    const run = await service.prepare(tenant, request, "update", "securityDefaults")
    await service.confirm(tenant, run.id, (await service.review(tenant, run.id)).fingerprint)
    if (failure === "crash-before-send") {
      const save = store.set
      store.set = (key, value) => { save(key, value); if (value.includes('"state":"uncertain"')) throw new Error("process stopped after journal commit") }
    }
    await service.restore(tenant, { ...request, runId: run.id }).catch(() => {})
    const entry = journal.load(tenant, run.id)!.entries[0]!
    expect(entry.state).toBe(failure === "preflight" ? "failed-before-send" : "uncertain")
    expect(writes).toBe(failure === "lost-response" ? 1 : 0)
    inject = false
    store.set = (key, value) => { store.values.set(key, value) }
    const accounts = new RecoveryAccounts(store)
    // A changed protection list cannot prevent read-back of an already sent write.
    store.set(`restore.recovery.${tenant}`, JSON.stringify([recovery]))
    await new IdentityRestoreService(journal, accounts, async () => ({ token, tenantId: tenant, clientId: client, userId: user }), fetcher).reconcile(tenant, run.id)
    expect(journal.load(tenant, run.id)!.entries[0]!.state).toBe(failure === "lost-response" ? "applied" : entry.state)
    const fresh = await service.prepare(tenant, request, "update", "securityDefaults")
    await service.confirm(tenant, fresh.id, (await service.review(tenant, fresh.id)).fingerprint)
    const outcome = await service.restore(tenant, { ...request, runId: fresh.id })
    expect(outcome.success).toBe(failure !== "crash-before-send")
    expect(writes).toBe(failure === "lost-response" ? 2 : failure === "preflight" ? 1 : 0)
  } finally { type.restore = previous }
})

it("restores the explicit username-hint subset from a full branding backup and binds the complete source", async () => {
  const store = storage(), journal = new GuardedRunJournal(store)
  const brandingToken = `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: user, appid: client, scp: "Organization.Read.All OrganizationalBranding.ReadWrite.All Application.Read.All" })).toString("base64url")}.s`
  const live: Item = { id: "EntraCompanyBranding", usernameHintText: "Current hint", backgroundColor: "#333333", localizations: [{ id: "fr", usernameHintText: "Current localized hint" }] }
  const writes: Item[] = []
  const fetcher = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input))
    if (options?.method !== "GET") {
      const body = JSON.parse(String(options?.body)) as Item
      writes.push(body); Object.assign(live, body)
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith("applications")) return Response.json({ value: [{ id: app, appId: client }] })
    if (url.pathname.endsWith("servicePrincipals")) return Response.json({ value: [{ id: sp, appId: client }] })
    if (url.pathname.endsWith("organization")) return Response.json({ value: [{ id: tenant }] })
    if (url.pathname.endsWith("branding")) return Response.json(live)
    return Response.json({ value: [] })
  }) as typeof fetch
  const service = new IdentityRestoreService(journal, new RecoveryAccounts(store), async () => ({ token: brandingToken, tenantId: tenant, clientId: client, userId: user }), fetcher)
  const snapshot = { id: "EntraCompanyBranding", usernameHintText: "Saved hint", backgroundColor: "#ffffff", localizations: [{ id: "fr", usernameHintText: "Saved localized hint" }] }
  const request = { path: "backup/EntraCompanyBranding/Branding.json", snapshot, origin: "restore" as const }
  const run = await service.prepare(tenant, request, "update", snapshot.id)
  expect(run.entries[0]!.step.desired).toEqual({ usernameHintText: "Saved hint" })
  const review = await service.review(tenant, run.id)
  expect(review.changes).toEqual([{ property: "usernameHintText", before: "Current hint", after: "Saved hint" }])
  await service.confirm(tenant, run.id, review.fingerprint)
  expect((await service.restore(tenant, { ...request, runId: run.id, snapshot: { ...snapshot, backgroundColor: "#000000" } })).success).toBe(false)
  expect(writes).toEqual([])
  expect((await service.restore(tenant, { ...request, runId: run.id })).success).toBe(true)
  expect(writes).toEqual([{ usernameHintText: "Saved hint" }])
  expect(live.backgroundColor).toBe("#333333")
  expect(live.localizations).toEqual([{ id: "fr", usernameHintText: "Current localized hint" }])
})

it.each(["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies"])("refuses to recreate %s when its original ID still exists with changed contents", async folder => {
  const store = storage(), journal = new GuardedRunJournal(store)
  const source = guid(60)
  const scopedToken = `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: user, appid: client, scp: "Policy.ReadWrite.ApplicationConfiguration Application.Read.All" })).toString("base64url")}.s`
  let exists = true, writes = 0
  const fetcher = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input))
    if (options?.method !== "GET") { writes++; throw new Error("Must not write during preview") }
    if (url.pathname.endsWith("applications")) return Response.json({ value: [{ id: app, appId: client }] })
    if (url.pathname.endsWith("servicePrincipals")) return Response.json({ value: [{ id: sp, appId: client }] })
    if (url.pathname.endsWith("/" + source)) return exists ? Response.json({ id: source, displayName: "Renamed since backup", definition: ["changed"], isOrganizationDefault: false }) : new Response(null, { status: 404 })
    return Response.json({ value: [] })
  }) as typeof fetch
  const service = new IdentityRestoreService(journal, new RecoveryAccounts(store), async () => ({ token: scopedToken, tenantId: tenant, clientId: client, userId: user }), fetcher)
  const definition = folder === "TokenLifetimePolicies" ? { TokenLifetimePolicy: { Version: 1, AccessTokenLifetime: "01:00:00" } } : { ActivityBasedTimeoutPolicy: { Version: 1, ApplicationPolicies: [{ ApplicationId: "default", WebSessionIdleTimeout: "00:05:00" }] } }
  const request = { path: `backup/${folder}/Policy.json`, snapshot: { id: source, displayName: "Original policy", isOrganizationDefault: false, definition: [JSON.stringify(definition)] }, origin: "restore" as const }
  await expect(service.prepare(tenant, request, "create")).rejects.toThrow("original policy still exists")
  expect(journal.list(tenant)).toEqual([])
  expect(writes).toBe(0)
  exists = false
  const run = await service.prepare(tenant, request, "create")
  expect(run.entries[0]!.step.preview).toBe(restoreFingerprint(null))
  expect(writes).toBe(0)
})

it("names missing restore access before trying protected-registration reads", async () => {
  const store = storage(), fetcher = vi.fn(async () => { throw new Error("Must not reach Graph") })
  const readOnlyToken = `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: user, appid: client, scp: "Policy.Read.All" })).toString("base64url")}.s`
  const service = new IdentityRestoreService(new GuardedRunJournal(store), new RecoveryAccounts(store), async () => ({ token: readOnlyToken, tenantId: tenant, clientId: client, userId: user }), fetcher)
  const request = { path: "backup/TokenLifetimePolicies/Policy.json", snapshot: { id: guid(60), displayName: "Policy" }, origin: "restore" as const }
  await expect(service.prepare(tenant, request, "update", guid(60))).rejects.toThrow("Policy.ReadWrite.ApplicationConfiguration")
  await expect(service.prepare(tenant, request, "update", guid(60))).rejects.toThrow("Services and permissions shows how to add it")
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies", "AuthenticationFlowsPolicy", "EntraCompanyBranding"])("restores %s through the production service with exactly generated area permissions", async folder => {
  const { areaPermissions } = await import("../src/shared/services/manifest")
  const area = moduleForFolder(folder)!.area
  const scopes = new Set(areaPermissions(area, "restore", "delegated"))
  const scopedToken = `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: user, appid: client, scp: [...scopes].join(" "), wids: ["62e90394-69f5-4237-9190-012177145e10"] })).toString("base64url")}.s`
  const row = restoreMatrixRow(folder)!, source = guid(80)
  const original: Item = folder === "AuthenticationFlowsPolicy" ? { selfServiceSignUp: { isEnabled: false } } : folder === "EntraCompanyBranding" ? { usernameHintText: "old hint" } : { displayName: "Original", isOrganizationDefault: false }
  const snapshot = { id: source, ...original, ...(folder === "AuthenticationFlowsPolicy" ? { selfServiceSignUp: { isEnabled: true } } : folder === "EntraCompanyBranding" ? { usernameHintText: "Saved hint" } : { displayName: "Saved" }) }
  let live = { id: source, ...original }, writes = 0
  const forbidden: string[] = [], reads: string[] = []
  const path = row.readPath.replace("{organizationId}", tenant)
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)), resource = url.pathname.replace(/^\/v1\.0\//, "")
    if (init?.method !== "GET") { writes++; Object.assign(live, JSON.parse(String(init?.body))); return new Response(null, { status: 204 }) }
    reads.push(resource)
    // Every endpoint is checked against its documented permission, even if a resolver catches the error.
    const allowed = resource === "organization" ? scopes.has("Organization.Read.All") : resource.endsWith("/appliesTo") ? scopes.has("Application.Read.All") && scopes.has("Policy.ReadWrite.ApplicationConfiguration") : resource === path || resource === `${path}/${source}` ? scopes.has(row.update!.permissions[0]!) : false
    if (!allowed) { forbidden.push(resource); throw new Error(`Read outside generated permission set: ${resource}`) }
    if (resource === "organization") return Response.json({ value: [{ id: tenant }] })
    if (resource.endsWith("/appliesTo")) return Response.json({ value: [] })
    return Response.json(live)
  }) as typeof fetch
  const store = storage()
  // Recovery identities do not need directory reads for a payload that cannot affect them.
  store.set(`restore.recovery.${tenant}`, JSON.stringify([recovery]))
  const journal = new GuardedRunJournal(store), service = new IdentityRestoreService(journal, new RecoveryAccounts(store), async () => ({ token: scopedToken, tenantId: tenant, clientId: client, userId: user }), fetcher)
  const request = { path: `backup/${folder}/Policy.json`, snapshot, origin: "restore" as const }
  const run = await service.prepare(tenant, request, "update", source)
  await service.confirm(tenant, run.id, (await service.review(tenant, run.id)).fingerprint)
  expect(await service.restore(tenant, { ...request, runId: run.id })).toMatchObject({ success: true })
  expect(forbidden).toEqual([])
  expect(reads.some(read => /directoryObjects|roleManagement|users|applications|servicePrincipals/.test(read))).toBe(false)
  expect(writes).toBe(1)
  expect(row.update!.protections).toEqual([])
})

it("rejects confirmation reuse across runs, tenants, actors and sources", async () => {
  const store = storage(), journal = new GuardedRunJournal(store)
  let connectedTenant = tenant
  const scopedToken = () => `h.${Buffer.from(JSON.stringify({ tid: connectedTenant, oid: user, appid: client, scp: "Policy.ReadWrite.AuthenticationFlows" })).toString("base64url")}.s`
  const service = new IdentityRestoreService(journal, new RecoveryAccounts(store), async () => ({ token: scopedToken(), tenantId: connectedTenant, clientId: client, userId: user }), async () => Response.json({ id: "flows", selfServiceSignUp: { isEnabled: false } }))
  const request = { path: "backup/AuthenticationFlowsPolicy/Flows.json", snapshot: { id: "flows", selfServiceSignUp: { isEnabled: true } }, origin: "restore" as const }
  const first = await service.prepare(tenant, request, "update")
  const approval = (await service.review(tenant, first.id)).fingerprint
  const second = await service.prepare(tenant, request, "update")
  await expect(service.confirm(tenant, second.id, approval)).rejects.toThrow("confirmation no longer matches")
  const { configurationApproval } = await import("../src/main/restore/entra-configuration")
  const exactStep = first.entries[0]!.step
  expect(configurationApproval(exactStep, { ...first, tenant: tenant.toUpperCase() })).toBe(approval)
  for (const altered of [{ ...first, id: "another-run" }, { ...first, tenant: guid(90) }, { ...first, actor: { ...first.actor, userId: recovery } }, { ...first, source: { ...first.source!, path: "another-backup/AuthenticationFlowsPolicy/Flows.json" } }, { ...first, source: { ...first.source!, fingerprint: "changed" } }]) expect(configurationApproval(exactStep, altered)).not.toBe(approval)
  connectedTenant = guid(90)
  const other = await service.prepare(connectedTenant, request, "update")
  await expect(service.confirm(connectedTenant, other.id, approval)).rejects.toThrow("confirmation no longer matches")
  // A copied approval also fails at execution, independently of the confirmation endpoint.
  second.entries[0]!.step.confirmation = { kind: "authentication", fingerprint: approval }
  journal.save(second)
  expect(await service.restore(tenant, { ...request, runId: second.id }).catch(error => ({ error: error.message }))).toMatchObject({ error: expect.any(String) })
  connectedTenant = tenant
  const result = await service.restore(tenant, { ...request, runId: second.id })
  expect(result).toMatchObject({ success: false, error: expect.stringContaining("Confirm this configuration separately") })
})
