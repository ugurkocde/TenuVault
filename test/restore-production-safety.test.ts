import { describe, expect, it, vi } from "vitest"
import { safetyReader } from "../src/main/restore/safety-reader"
import { RecoveryAccounts, resolveRestoreActor, resolveSafetyReferences } from "../src/main/restore/safety-resolvers"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedStep, type GuardedRun, type GuardedIO } from "../src/main/restore/guarded-run"
import { IdentityRestoreService } from "../src/main/restore/service"
import { restoreSafetyRoutes } from "../src/main/restore/routes"
import { referenceSnapshots } from "../src/main/restore/reference-scanner"
import { bindRestoreConnection, dispatchIdentityRestore, setIdentityRestoreDispatch } from "../src/main/restore/dispatch"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { INTUNE_TYPES, typeForFolder, type Item } from "../src/shared/intune/registry"
import { guardRestoreItem } from "../src/shared/intune/restore-guards"

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
  it("scans every registered current Intune and CA policy through details and extras and fails on an unread collection", async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      expect(options?.method).toBe("GET"); const url = new URL(String(input)); calls.push(url.pathname)
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [{ id: user }] })
      if (url.pathname.endsWith(`/deviceConfigurations/${user}`)) return Response.json({ id: user, displayName: "Policy", assignments: [] })
      if (url.pathname.endsWith("/deviceManagement")) return Response.json({ id: "settings", deviceComplianceCheckinThresholdDays: 30 })
      return Response.json({ value: [] })
    })
    const snapshots = await referenceSnapshots(token, fetcher)
    expect(snapshots.some(snapshot => snapshot.path === `DeviceConfigurations/${user}`)).toBe(true)
    for (const type of INTUNE_TYPES.filter(type => type.restoreSafety !== "identity" && !type.staticIds)) expect(calls.some(path => path.endsWith(`/${type.path}`))).toBe(true)
    await expect(referenceSnapshots(token, async () => new Response("", { status: 403 }))).rejects.toThrow()
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
