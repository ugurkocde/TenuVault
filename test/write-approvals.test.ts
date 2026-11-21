import { readFileSync } from "node:fs"
import { graphCaller } from "../src/portal/lib/policies/graph-restore"
import { afterEach, expect, it, vi } from "vitest"
import { ApiHost } from "../src/main/api/host"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { graphDispatchGuard, sameObservation, withWriteCheckpoint, withExemptGraphCaller } from "../src/main/write-approvals/dispatch"
import { setWriteApprovals } from "../src/main/write-approvals/service"
import { writeApprovalRoutes } from "../src/main/write-approvals/routes"
import { POST as restoreRoute } from "../src/portal/app/api/restore-backup/route"
import { POST as driftRoute } from "../src/portal/app/api/revert-policy/route"
import { localStorageAccountName, DELEGATED_CLIENT_SECRET, INTERNAL_API_ORIGIN } from "../src/shared/constants"
import { WRITE_APPROVAL_LIFETIME } from "../src/shared/write-approvals"
import { approvalTenant, secondTenant, requester, reviewer, approvalAccount, writeApprovalFixture } from "./helpers/write-approval-fixture"

afterEach(() => { setWriteApprovals(undefined); vi.unstubAllGlobals() })

const tenant = approvalTenant
const prepare = (tenant = approvalTenant) => {
  const details = { name: "[Restored] Target", version: 1, password: "fixture-value" }
  const operation = {
    tenant, reference: ["operation", 1], summary: { kind: "Policy copy", count: 1, targets: [details.name], fields: ["password"] },
    observe: async () => ({ content: { name: details.name, password: details.password }, target: { version: details.version } }),
  }
  return { details, operation }
}
const runTransport = (approval: ReturnType<ReturnType<typeof writeApprovalFixture>["profile"]>["service"], actor = requester) => {
  const dispatch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: requester.oid }))
  let identity = actor
  const send = createBridgedFetch({
    dispatch: async () => new Response(null, { status: 404 }),
    getDelegatedToken: async () => { throw new Error("No token stub") },
    fetch: dispatch,
    authorizeGraph: graphDispatchGuard(approval, token => token === "app-only" ? undefined : ({
      tenant: token === "other-tenant" ? secondTenant : tenant, actor: identity, current: () => identity.oid === actor.oid,
    })),
  })
  const graph = (token = "issuer-observed", target = "deviceManagement/deviceCategories", method = "POST", body?: unknown) => send(`https://graph.microsoft.com/beta/${target}`, {
    method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { dispatch, graph, setIdentity: (value: typeof actor) => { identity = value } }
}

it("keeps local and unenrolled shared tenants working, and checks storage before the first Azure write", async () => {
  const { profile, state } = writeApprovalFixture()
  const { service } = profile()
  const { operation } = prepare()
  const { graph, dispatch } = runTransport(service)
  await service.run([operation], () => graph())
  state.online = false
  await expect(service.run([operation], () => graph())).rejects.toThrow("could not be verified")
  state.account = localStorageAccountName(tenant)
  await service.run([operation], () => graph())
  await expect(service.enable(tenant)).rejects.toThrow("Use shared Azure storage")
  expect(dispatch).toHaveBeenCalledTimes(2)
})

it("shares immutable requests, claims once, revalidates and prevents replay", async () => {
  const { profile, values } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  const { operation, details } = prepare()
  const { graph, dispatch } = runTransport(first.service)
  await first.service.enable(tenant)
  await expect(graph()).rejects.toThrow("current tenant write approval")
  await expect(graph("app-only")).rejects.toThrow("delegated")
  await expect(first.service.run([operation], () => graph())).rejects.toThrow("pending")
  expect(dispatch).not.toHaveBeenCalled()
  const row = (await second.service.inbox(tenant)).requests[0]!
  const id = row.request.id
  expect(row.request.requester).toEqual(requester)
  expect(row.local).toBe(false)
  expect([...values.values()].map(item => item.body).join(" ")).not.toContain(details.password)
  await expect(first.service.decide(tenant, id, "approve")).rejects.toThrow("different signed-in admin")
  const decisions = await Promise.allSettled([second.service.decide(tenant, id, "approve"), second.service.decide(tenant, id, "reject")])
  expect(decisions.filter(value => value.status === "fulfilled")).toHaveLength(1)
  await expect(second.service.run([operation], () => graph())).rejects.toThrow("pending")
  const attempts = await Promise.allSettled([first.service.run([operation], () => graph()), first.service.run([operation], () => graph())])
  expect(attempts.filter(value => value.status === "fulfilled")).toHaveLength(1)
  expect(dispatch).toHaveBeenCalledTimes(1)
  await expect(first.service.run([operation], () => graph())).rejects.toThrow("pending")
  expect((await second.service.inbox(tenant)).requests.find(entry => entry.request.id === id)?.request.state).toBe("finished")
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it("refuses changed bytes and state, expires requests, and rejects a different actual Graph destination", async () => {
  const { profile, state } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  const { operation, details } = prepare()
  const { graph, dispatch } = runTransport(first.service)
  await first.service.enable(tenant)
  const apply = () => first.service.run([operation], () => graph("other-tenant"))
  await expect(apply()).rejects.toThrow("pending")
  const id = (await second.service.inbox(tenant)).requests[0]!.request.id
  await second.service.decide(tenant, id, "approve")
  details.version = 2
  await expect(apply()).rejects.toThrow(`changed after request ${id}`)
  details.version = 1
  await expect(apply()).rejects.toThrow("pending")
  const fresh = (await second.service.inbox(tenant)).requests.find(row => row.request.state === "pending")!.request.id
  await second.service.decide(tenant, fresh, "approve")
  await expect(apply()).rejects.toThrow("not included in the tenant write review")
  state.time += WRITE_APPROVAL_LIFETIME
  await expect(apply()).rejects.toThrow("pending")
  const newId = (await second.service.inbox(tenant)).requests.find(row => row.request.state === "pending")!.request.id
  state.time += WRITE_APPROVAL_LIFETIME
  await expect(second.service.decide(tenant, newId, "approve")).rejects.toThrow("expired")
  expect(dispatch).not.toHaveBeenCalled()
})

it("preflights all destinations, rejects a changed checkpoint, and does not pass a write batch without a permit", async () => {
  const { profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  const a = prepare(), b = prepare(secondTenant)
  const { graph, dispatch } = runTransport(first.service)
  await first.service.enable(tenant)
  await first.service.enable(secondTenant)
  const bulk = () => first.service.run([a.operation, b.operation], async () => {
    a.details.version++
    return withWriteCheckpoint(sameObservation(1, async () => a.details.version), () => graph())
  })
  const batch = { requests: [{ method: "GET", url: "/deviceManagement/deviceCategories" }, { method: "POST", url: "/deviceManagement/deviceCategories" }] }
  await expect(graph("issuer-observed", "$batch", "POST", batch)).rejects.toThrow("current tenant write approval")
  await expect(bulk()).rejects.toThrow("pending")
  await second.service.decide(tenant, (await second.service.inbox(tenant)).requests[0]!.request.id, "approve")
  await expect(bulk()).rejects.toThrow("pending")
  await second.service.decide(secondTenant, (await second.service.inbox(secondTenant)).requests[0]!.request.id, "approve")
  await expect(bulk()).rejects.toThrow("destination changed after review")
  expect(dispatch).not.toHaveBeenCalled()
})

it("fails closed on lost storage and keeps the binding until an audited generation-specific disable", async () => {
  const { profile, state, audits } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  const { graph, dispatch } = runTransport(first.service)
  await first.service.enable(tenant)
  const oldClient = profile(reviewer, undefined, "0.5.3")
  await expect(oldClient.service.inbox(tenant)).rejects.toThrow("requires TenuVault 0.6.0")
  state.account = localStorageAccountName(tenant)
  await expect(graph()).rejects.toThrow("enrolled with sharedapprovals")
  state.account = approvalAccount
  state.online = false
  await expect(graph()).rejects.toThrow("could not be verified")
  state.online = true
  await expect(first.service.disable(tenant)).rejects.toThrow("pending")
  const id = (await second.service.inbox(tenant)).requests[0]!.request.id
  await second.service.decide(tenant, id, "approve")
  state.auditAvailable = false
  await expect(first.service.disable(tenant)).rejects.toThrow("Audit receipt unavailable")
  expect(await first.service.active(tenant)).toBe(true)
  state.auditAvailable = true
  await expect(first.service.disable(tenant)).rejects.toThrow("pending")
  const replacement = (await second.service.inbox(tenant)).requests.find(row => row.request.state === "pending")!.request.id
  await second.service.decide(tenant, replacement, "approve")
  await first.service.disable(tenant)
  expect(audits).toContainEqual(expect.objectContaining({ action: "Tenant write approval disabled", requestId: replacement, requester: requester.oid, approver: reviewer.oid, generation: 1 }))
  expect((await second.service.inbox(tenant)).requests.every(row => row.superseded)).toBe(true)
  state.account = localStorageAccountName(tenant)
  await graph()
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it("survives a restart after dispatch without replaying a claimed request", async () => {
  const { profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  const { operation } = prepare()
  const { dispatch, graph } = runTransport(first.service)
  await first.service.enable(tenant)
  await expect(first.service.run([operation], () => graph())).rejects.toThrow("pending")
  const id = (await second.service.inbox(tenant)).requests[0]!.request.id
  await second.service.decide(tenant, id, "approve")
  let dispatched!: () => void
  const started = new Promise<void>(resolve => { dispatched = resolve })
  // Keep the origin alive at the point where it would have died. A new service has no
  // in-memory permit, but retains the same secure store and shared conditional claim.
  let settle!: () => void
  const stopped = new Promise<void>(resolve => { settle = resolve })
  const attempt = first.service.run([operation], async () => { await graph(); dispatched(); await stopped })
  await started
  const restart = profile(requester, first.store)
  try {
    await expect(restart.service.run([operation], () => graph())).rejects.toThrow("uncertain apply outcome")
    await expect(second.service.releaseInterrupted(tenant, id)).rejects.toThrow("original installation")
    await restart.service.releaseInterrupted(tenant, id)
    await expect(restart.service.run([operation], () => graph())).rejects.toThrow("pending")
    expect(dispatch).toHaveBeenCalledTimes(1)
  } finally { settle(); await attempt }
})

it.each([
  { route: "/api/restore-backup", action: { backupId: "fixture", restoreType: "selective", selectedPolicies: [{ path: "fixture/DeviceCategories/source.json" }] } },
  { route: "/api/revert-policy", action: { action: "restore", policyId: requester.oid, policyType: "DeviceCategories", backupPath: "fixture/DeviceCategories/source.json" } },
  { route: "/api/revert-policy", action: { action: "revert", policyId: requester.oid, policyType: "DeviceCategories", backupPath: "fixture/DeviceCategories/source.json" } },
])("requires review across two profiles through IPC for $route", async ({ route, action }) => {
  const { profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  setWriteApprovals(first.service)
  let writes = 0
  let clash = false
  const network: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    if (req.url.endsWith("metadata.json")) return Response.json({ TenantId: tenant, Status: "Success", Failures: 0 })
    if (req.url.endsWith("source.json")) return Response.json({ id: requester.oid, displayName: "Source" })
    if (new URL(req.url).pathname.endsWith("/deviceCategories")) {
      if (req.method === "GET") return Response.json({ value: clash ? [{ id: reviewer.oid, displayName: "[Restored] Source" }] : [] })
      if (req.method === "POST") { writes++; return Response.json({ id: reviewer.oid }) }
    }
    if (new URL(req.url).hostname.endsWith(".blob.core.windows.net")) return new Response(null, { status: req.method === "PUT" ? 201 : 404 })
    if ("action" in action && action.action === "revert" && req.url.includes("graph.microsoft.com")) {
      if (req.method === "PATCH") writes++
      return Response.json({ id: requester.oid, displayName: clash ? "Concurrent edit" : "Current" })
    }
    return Response.json({ id: reviewer.oid, displayName: "[Restored] Source" })
  }
  const host = new ApiHost({ routes: { ...writeApprovalRoutes(first.service), "/api/restore-backup": { POST: restoreRoute }, "/api/revert-policy": { POST: driftRoute } } })
  const fetcher = createBridgedFetch({
    dispatch: request => host.dispatch(request), fetch: network,
    getDelegatedToken: async () => ({ accessToken: "trusted", expiresOn: null }),
    authorizeGraph: graphDispatchGuard(first.service, token => token === "trusted" ? { tenant, actor: requester, current: () => true } : undefined),
  })
  vi.stubGlobal("fetch", fetcher)
  const body = { tenantId: tenant, appId: requester.oid, clientSecret: DELEGATED_CLIENT_SECRET, storageAccountName: approvalAccount, ...action }
  const send = async () => {
    const response = await host.handleIpc({ method: "POST", path: route, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) })
    return JSON.parse(new TextDecoder().decode(response.body))
  }
  const controls = (action: string) => host.dispatch(new Request(`${INTERNAL_API_ORIGIN}/api/tenant-write-approvals`, {
    method: "POST", body: JSON.stringify({ tenantId: tenant, action, confirmManagedCutover: true }),
  }))
  expect((await controls("enable")).ok).toBe(true)
  expect((await send()).error).toContain("pending")
  const id = (await second.service.inbox(tenant)).requests[0]!.request.id
  await second.service.decide(tenant, id, "approve")
  clash = true
  expect((await send()).error).toContain("changed after request")
  expect(writes).toBe(0)
  clash = false
  expect((await send()).error).toContain("pending")
  await second.service.decide(tenant, (await second.service.inbox(tenant)).requests.find(row => row.request.state === "pending")!.request.id, "approve")
  expect((await send()).success).toBe(true)
  expect(writes).toBe(1)
  expect((await send()).error).toContain("pending")
  expect(writes).toBe(1)
})


it.each([401, 429])("checks the destination and identity again before a Graph retry after %i", async status => {
  const { profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  const { operation, details } = prepare()
  await first.service.enable(tenant)
  const network = vi.fn(async () => new Response("{}", { status, headers: { "retry-after": "0" } }))
  const transport = createBridgedFetch({
    dispatch: async () => new Response(null, { status: 404 }),
    getDelegatedToken: async () => { throw new Error("No delegated exchange expected") },
    fetch: network,
    authorizeGraph: graphDispatchGuard(first.service, token => ({
      tenant, actor: token === "refreshed-as-other-user" ? reviewer : requester, current: () => true,
    })),
  })
  const send = graphCaller("original", transport, {
    sleep: async () => { details.version++ },
    refreshToken: async () => {
      first.session.actor = reviewer
      return "refreshed-as-other-user"
    },
  })
  const apply = () => first.service.run([operation], () => withWriteCheckpoint(sameObservation(1, async () => details.version), () => send("POST", "deviceManagement/deviceCategories")))
  await expect(apply()).rejects.toThrow("pending")
  await second.service.decide(tenant, (await second.service.inbox(tenant)).requests[0]!.request.id, "approve")
  await expect(apply()).rejects.toThrow(status === 401 ? "current tenant write approval" : "destination changed after review")
  expect(network).toHaveBeenCalledTimes(1)
})

it("keeps writes available without storage until the tenant has an independent binding", async () => {
  const { profile, state } = writeApprovalFixture()
  const { service } = profile()
  const { operation } = prepare()
  const { graph, dispatch } = runTransport(service)
  state.hasProfile = false
  await service.run([operation], () => graph())
  expect(dispatch).toHaveBeenCalledTimes(1)
  state.hasProfile = true
  await service.enable(tenant)
  state.hasProfile = false
  await expect(service.run([operation], () => graph())).rejects.toThrow("Reconnect the destination tenant")
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it("checks the prior Azure account even when the second installation has never read the policy", async () => {
  const { profile, state } = writeApprovalFixture()
  const first = profile(), second = profile()
  expect(second.store.get(`write-approval.binding.${tenant}`)).toBeNull()
  await first.service.enable(tenant)
  await expect(second.service.beforeStorageChange(tenant, localStorageAccountName(tenant))).rejects.toThrow("before changing storage")
  await second.service.beforeStorageChange(tenant)
  expect(second.store.get(`write-approval.binding.${tenant}`)).toBe(approvalAccount)
  state.hasProfile = false
  await expect(second.service.active(tenant)).rejects.toThrow("Reconnect the destination tenant")
})

it("exempts a real-format permission grant only for the provisioning caller", async () => {
  const { profile } = writeApprovalFixture()
  const { service } = profile()
  await service.enable(tenant)
  const network = vi.fn(async () => new Response(null, { status: 204 }))
  const send = createBridgedFetch({
    dispatch: async () => new Response(null, { status: 404 }), getDelegatedToken: async () => ({ accessToken: "token", expiresOn: null }),
    authorizeGraph: graphDispatchGuard(service, () => ({ tenant, actor: requester, current: () => true })), fetch: network,
  })
  const grant = () => send("https://graph.microsoft.com/v1.0/oauth2PermissionGrants/c1D67-_BgkqJAKZxG_8FgGK6fWeo5UrHEBvnc9YfGTs", { method: "PATCH", headers: { authorization: "Bearer token" } })
  await expect(grant()).rejects.toThrow("current tenant write approval")
  expect((await withExemptGraphCaller("registration", grant)).status).toBe(204)
  await expect(grant()).rejects.toThrow("current tenant write approval")
  await expect(send("https://graph.microsoft.us/beta/$batch", { method: "POST", headers: { authorization: "Bearer token" },
    body: JSON.stringify({ requests: [{ id: "1", method: "GET", url: "/me" }, { id: "2", method: "PATCH", url: "/deviceManagement/deviceCategories/id" }] }) })).rejects.toThrow("current tenant write approval")
  expect(network).toHaveBeenCalledTimes(1)
})

it("rechecks absence at each dispatch after admitting the run", async () => {
  const { profile, state } = writeApprovalFixture()
  const { service } = profile()
  const { graph, dispatch } = runTransport(service)
  await service.run([prepare().operation], async () => { await graph(); await graph() })
  expect(state.policyReads).toBe(3)
  expect(dispatch).toHaveBeenCalledTimes(2)
})

it("loads one enabled policy body per run and checks its version at each mutation", async () => {
  const { profile, state } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  await first.service.enable(tenant)
  const { operation } = prepare()
  const { graph, dispatch } = runTransport(first.service)
  const run = () => first.service.run([operation], async () => { await graph(); await graph() })
  await expect(run()).rejects.toThrow("pending")
  await second.service.decide(tenant, (await second.service.inbox(tenant)).requests[0]!.request.id, "approve")
  state.policyReads = 0
  state.policyChecks = 0
  await run()
  expect(state.policyReads).toBe(1)
  expect(state.policyChecks).toBe(3)
  expect(dispatch).toHaveBeenCalledTimes(2)
})

it.each(["expiry", "generation", "request"])("revalidates the %s after the target checkpoint", async change => {
  const { profile, state, values } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  await first.service.enable(tenant)
  const { operation } = prepare()
  const { graph, dispatch } = runTransport(first.service)
  await expect(first.service.run([operation], () => graph())).rejects.toThrow("pending")
  const id = (await second.service.inbox(tenant)).requests[0]!.request.id
  await second.service.decide(tenant, id, "approve")
  const check = async () => {
    if (change === "expiry") state.serverTime = state.time + WRITE_APPROVAL_LIFETIME + 60_000
    else {
      const [name, record] = [...values].find(([key]) => key.endsWith(change === "generation" ? "policy.json" : `requests/${id}.json`))!
      const value = JSON.parse(record.body)
      Object.assign(value, change === "generation" ? { generation: value.generation + 1 } : { state: "interrupted" })
      values.set(name, { body: JSON.stringify(value), etag: '"changed"' })
    }
  }
  await expect(first.service.run([operation], () => withWriteCheckpoint(check, () => graph()))).rejects.toThrow()
  expect(dispatch).not.toHaveBeenCalled()
})

it("keeps readable inbox rows, flags invalid records and conditionally prunes expired terminal rows", async () => {
  const { profile, state, values } = writeApprovalFixture()
  const { service } = profile()
  await service.enable(tenant)
  const first = prepare()
  const run = () => service.run([first.operation], async () => {})
  await expect(run()).rejects.toThrow("pending")
  const { request } = (await service.inbox(tenant)).requests[0]!
  const real = [...values.keys()].find(name => name.endsWith(`requests/${request.id}.json`))!
  const invalid = real.replace(request.id, reviewer.oid)
  values.set(invalid, { body: '{"schema":2}', etag: '"invalid"' })
  expect(await service.inbox(tenant)).toMatchObject({ invalidRecords: 1, requests: [{ request }] })
  await service.decide(tenant, request.id, "cancel")
  state.serverTime = state.time + WRITE_APPROVAL_LIFETIME + 31 * 86400000
  expect(await service.inbox(tenant)).toMatchObject({ invalidRecords: 1, requests: [] })
  expect(values.has(real)).toBe(false)
  await expect(run()).rejects.toThrow("pending")
})

it("preflights a whole cross-tenant selective retry before sending the approved destination's writes", async () => {
  const source = "33333333-3333-4333-8333-333333333333"
  const { profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  setWriteApprovals(first.service)
  const selectedPolicies = ["first", "second"].map(name => ({ path: `fixture/DeviceCategories/${name}.json` }))
  const targetTenants = [tenant, secondTenant].map((tenantId, index) => ({ tenantId, appId: requester.oid, selectedPolicies: [selectedPolicies[index]] }))
  const mutations: string[] = []
  const send = createBridgedFetch({
    dispatch: async () => new Response(null, { status: 404 }),
    getDelegatedToken: async tenant => ({ accessToken: tenant, expiresOn: null }),
    authorizeGraph: graphDispatchGuard(first.service, token => ({ tenant: token, actor: requester, current: () => true })),
    fetch: async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (url.pathname.endsWith("metadata.json")) return Response.json({ TenantId: source, Status: "Success", Failures: 0 })
      if (url.hostname.endsWith(".blob.core.windows.net")) return Response.json({ id: requester.oid, displayName: url.pathname.endsWith("first.json") ? "First" : "Second" })
      if (req.method === "GET") {
        expect(url.searchParams.get("$filter")).toMatch(/^displayName eq '(First|Second)'$/)
        return Response.json({ value: [] })
      }
      mutations.push(String((await req.json()).displayName))
      return Response.json({ id: reviewer.oid })
    },
  })
  vi.stubGlobal("fetch", send)
  await first.service.enable(tenant)
  await first.service.enable(secondTenant)
  const host = new ApiHost({ routes: { "/api/restore-backup": { POST: restoreRoute } } })
  const run = () => host.dispatch(new Request(`${INTERNAL_API_ORIGIN}/api/restore-backup`, { method: "POST", body: JSON.stringify({
    tenantId: source, appId: requester.oid, clientSecret: DELEGATED_CLIENT_SECRET, storageAccountName: approvalAccount,
    backupId: "fixture", restoreType: "selective", selectedPolicies, targetTenants,
  }) }))
  expect((await run()).status).toBe(409)
  const approve = async (id: string) => {
    const request = (await second.service.inbox(id)).requests[0]!.request
    await second.service.decide(id, request.id, "approve")
  }
  await approve(tenant)
  expect((await run()).status).toBe(409)
  expect(mutations).toEqual([])
  await approve(secondTenant)
  expect(await (await run()).json()).toMatchObject({ success: true })
  expect(mutations).toEqual(["First", "Second"])
})

it("binds the resolved Autopilot device and its actual update steps even though it cannot be created", async () => {
  const { Restorer } = await import("../src/portal/lib/policies/graph-restore")
  const { state, profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  setWriteApprovals(first.service)
  await first.service.enable(tenant)
  const path = "fixture/AutopilotDevices/source.json"
  const snapshot = { id: requester.oid, serialNumber: "SERIAL123", groupTag: "Requested" }
  let groupTag = "Current"
  let writes = 0
  const send = createBridgedFetch({
    dispatch: async () => new Response(null, { status: 404 }), getDelegatedToken: async () => ({ accessToken: "sign-in", expiresOn: null }),
    authorizeGraph: graphDispatchGuard(first.service, () => ({ tenant, actor: requester, current: () => true })),
    fetch: async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (req.method !== "GET") { writes++; return new Response(null, { status: 204 }) }
      if (url.pathname.endsWith(requester.oid)) return new Response(null, { status: 404 })
      const device = { ...snapshot, id: reviewer.oid, groupTag }
      if (url.pathname.endsWith(reviewer.oid)) return Response.json(device)
      return Response.json({ value: [device] })
    },
  })
  const restorer = new Restorer(graphCaller("sign-in", send), { mode: "replace", assignments: false, writeApprovalTenant: tenant })
  let review: Awaited<ReturnType<typeof restorer.approvalObservation>>
  const operation = { ...prepare().operation, observe: async () => review = await restorer.approvalObservation(path, snapshot) }
  const run = () => first.service.run([operation], () => restorer.restore(path, snapshot, undefined, review))
  await expect(run()).rejects.toThrow("pending")
  expect(review!.review).toMatchObject({ name: "SERIAL123", id: reviewer.oid, fields: expect.arrayContaining(["groupTag"]) })
  const request = (await second.service.inbox(tenant)).requests[0]!.request
  await second.service.decide(tenant, request.id, "approve")
  state.beforeAudit = event => { if (event.action.endsWith("claimed")) groupTag = "Changed outside the restore" }
  expect(await run()).toMatchObject({ success: false, error: expect.stringContaining("changed after review") })
  expect(writes).toBe(0)
})

it.each(["changed", "deleted", "unreadable"])("reports a %s repair without aborting other items", async condition => {
  const { setApprovedRestoreRepairStore } = await import("../src/portal/lib/policies/graph-restore")
  const { memoryStore } = await import("./helpers")
  const repairStore = memoryStore()
  const { state, profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  setWriteApprovals(first.service)
  setApprovedRestoreRepairStore({ ...repairStore, keys: () => [...repairStore.values.keys()] })
  try {
    await first.service.enable(tenant)
    const path = "fixture/DeviceConfigurations/source.json"
    const other = "fixture/DeviceCategories/other.json"
    const snapshot = { id: requester.oid, displayName: "Example", description: "Reviewed", assignments: [{ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: secondTenant } }] }
    let live: Record<string, unknown> | undefined
    let refuseAssignment = true
    let liveStatus = 200
    let writes = 0
    const transport = createBridgedFetch({
      dispatch: async () => new Response(null, { status: 404 }),
      getDelegatedToken: async () => ({ accessToken: "token", expiresOn: null }),
      authorizeGraph: graphDispatchGuard(first.service, () => ({ tenant, actor: requester, current: () => true })),
      fetch: async (input, init) => {
        const request = new Request(input, init), url = new URL(request.url)
        if (url.pathname.endsWith("metadata.json")) return Response.json({ TenantId: tenant, Status: "Success", Failures: 0 })
        if (url.pathname.endsWith("source.json")) return Response.json(snapshot)
        if (url.pathname.endsWith("other.json")) return Response.json({ displayName: "Other" })
        if (url.pathname.endsWith(`groups/${secondTenant}`)) return Response.json({ id: secondTenant })
        if (request.method === "GET") {
          if (url.pathname.endsWith(reviewer.oid)) return Response.json(live ?? {}, { status: liveStatus })
          if (url.pathname.endsWith("/assignments")) return Response.json({ value: [] })
          return Response.json({ value: live && url.pathname.endsWith("deviceConfigurations") ? [live] : [] })
        }
        writes++
        if (url.pathname.endsWith("/assign")) return refuseAssignment
          ? Response.json({ error: { message: "Assignment refused" } }, { status: 400 }) : new Response(null, { status: 204 })
        if (url.pathname.endsWith("deviceConfigurations")) {
          live = { ...await request.json() as Record<string, unknown>, id: reviewer.oid, assignments: [] }
          return Response.json(live, { status: 201 })
        }
        return Response.json({ id: secondTenant }, { status: 201 })
      },
    })
    vi.stubGlobal("fetch", transport)
    const host = new ApiHost({ routes: { "/api/restore-backup": { POST: restoreRoute } } })
    const run = (selectedPolicies: Array<{ path: string; repairToken?: string }>) => host.dispatch(new Request(`${INTERNAL_API_ORIGIN}/api/restore-backup`, { method: "POST", body: JSON.stringify({
      tenantId: tenant, appId: requester.oid, clientSecret: DELEGATED_CLIENT_SECRET, storageAccountName: approvalAccount,
      backupId: "fixture", restoreType: "selective", assignments: true, selectedPolicies,
    }) }))
    const approve = async () => {
      const row = (await second.service.inbox(tenant)).requests.find(row => row.request.state === "pending" && !row.decision)!
      await second.service.decide(tenant, row.request.id, "approve")
    }
    expect((await run([{ path }])).status).toBe(409)
    await approve()
    const partial = await (await run([{ path }])).json()
    const repair = partial.details.results[0].repairToken
    expect(typeof repair).toBe("string")
    const { writeRecords } = await import("../src/main/storage/restore-journal")
    expect(writeRecords()).toContainEqual(expect.objectContaining({
      objectId: reviewer.oid, path: "deviceManagement/deviceConfigurations", verifiedPostStep: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(writes).toBe(2)
    const persisted = new Map(repairStore.values)
    expect(JSON.parse(persisted.get(`write-approval.restore-repair.${repair}`)!).expectedCurrent.description).toBe("Reviewed")
    setApprovedRestoreRepairStore({ get: key => persisted.get(key) ?? null, set: (key, value) => { persisted.set(key, value) }, delete: key => { persisted.delete(key) }, keys: () => [...persisted.keys()] })
    refuseAssignment = false
    if (condition !== "changed") liveStatus = condition === "deleted" ? 404 : 403
    const retry = () => run([{ path, repairToken: repair }, { path: other }])
    expect((await retry()).status).toBe(409)
    expect(writes).toBe(2)
    await approve()
    if (condition === "changed") state.beforeAudit = event => { if (event.action.endsWith("claimed")) live!.description = "Later edit" }
    const outcome = await (await retry()).json()
    expect(outcome.details.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path, success: false, retryable: false, error: expect.stringContaining(condition === "changed" ? "changed after review" : condition === "deleted" ? "missing" : "could not be verified") }),
      expect.objectContaining({ path: other, success: true }),
    ]))
    expect(writes).toBe(3)
  } finally { setApprovedRestoreRepairStore(undefined) }
})

it("audits a disable intent before CAS and refuses an approval that expired during that receipt", async () => {
  const { profile, state, audits } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  await first.service.enable(tenant)
  await expect(first.service.disable(tenant)).rejects.toThrow("pending")
  const row = (await second.service.inbox(tenant)).requests[0]!
  await second.service.decide(tenant, row.request.id, "approve")
  state.beforeAudit = event => {
    if (event.action === "Tenant write approval disable requested") state.serverTime = state.time + WRITE_APPROVAL_LIFETIME + 60_000
  }
  await expect(first.service.disable(tenant)).rejects.toThrow()
  expect((await first.service.inbox(tenant)).enabled).toBe(true)
  expect(audits.map(event => event.action)).toContain("Tenant write approval disable requested")
  expect(audits.map(event => event.action)).not.toContain("Tenant write approval disabled")
})

it("allows a tenant with no backup container and fails closed if an enrolled container disappears", async () => {
  const { profile, state } = writeApprovalFixture()
  const { service } = profile()
  const { graph, dispatch } = runTransport(service)
  state.containerMissing = true
  expect(await service.inbox(tenant)).toMatchObject({ enabled: false, requests: [] })
  await service.run([prepare().operation], () => graph())
  state.containerMissing = false
  await service.enable(tenant)
  state.containerMissing = true
  await expect(graph()).rejects.toThrow("enrolled tenant approval policy is missing")
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it.each([undefined, "anotheraccount"])("requires confirmation to leave unreadable storage and verifies it before writes, next account %s", async next => {
  const { profile, state } = writeApprovalFixture()
  const origin = profile(), other = profile(reviewer)
  const { graph, dispatch } = runTransport(origin.service)
  state.blockedAccounts.add(approvalAccount)
  const refused = vi.fn(async () => false)
  await expect(origin.service.beforeStorageChange(tenant, next, refused)).rejects.toThrow("cancelled")
  expect(refused).toHaveBeenCalledWith(approvalAccount)
  await origin.service.beforeStorageChange(tenant, next, async () => true)
  state.account = next ?? localStorageAccountName(tenant)
  await expect(graph()).rejects.toThrow("could not be verified")
  state.blockedAccounts.clear()
  const account = state.account
  state.account = approvalAccount
  await other.service.enable(tenant)
  state.account = account
  await expect(graph()).rejects.toThrow("enrolled with")
  expect(dispatch).not.toHaveBeenCalled()
})

it("serializes an account move with approval activation", async () => {
  const { profile, state } = writeApprovalFixture()
  const { service } = profile()
  const starting = service.enable(tenant)
  const move = service.withStorageProfiles(async () => {
    await service.beforeStorageChange(tenant, "anotheraccount")
    state.account = "anotheraccount"
  })
  await starting
  await expect(move).rejects.toThrow("before changing storage")
  expect(state.account).toBe(approvalAccount)
})

it.each([false, true])("refuses dispatch after another desktop enables or re-enables approval, previously disabled %s", async disabled => {
  const { profile, state } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  if (disabled) {
    await first.service.enable(tenant)
    await expect(first.service.disable(tenant)).rejects.toThrow("pending")
    await second.service.decide(tenant, (await second.service.inbox(tenant)).requests[0]!.request.id, "approve")
    await first.service.disable(tenant)
  }
  const { graph, dispatch } = runTransport(first.service)
  await expect(first.service.run([prepare().operation], async () => {
    await graph()
    await second.service.enable(tenant)
    await graph()
  })).rejects.toThrow("current tenant write approval")
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(state.conditionalReads).toBe(disabled ? 2 : 0)
})

it("uses Azure time and displays invalid legacy decisions alongside readable inbox records", async () => {
  const { profile, state, values } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  state.serverTime = Date.UTC(2026, 10, 20)
  vi.spyOn(Date, "now").mockReturnValue(state.serverTime + 31 * 86_400_000)
  try {
    await first.service.enable(tenant)
    const { operation } = prepare()
    const run = () => first.service.run([operation], async () => undefined)
    await expect(run()).rejects.toThrow("pending")
    const { request } = (await second.service.inbox(tenant)).requests[0]!
    expect(request.createdAt).toBe(state.serverTime)
    expect(request.expiresAt).toBe(state.serverTime + WRITE_APPROVAL_LIFETIME)
    state.serverTime += 60_000
    await second.service.decide(tenant, request.id, "approve")
    expect((await first.service.inbox(tenant)).requests[0]!.decision?.at).toBe(state.serverTime)
    const [key, value] = [...values].find(([key]) => key.includes("/decisions/"))!
    values.set(key, { ...value, body: JSON.stringify({ ...JSON.parse(value.body), at: request.createdAt - 1000 }) })
    expect((await first.service.inbox(tenant)).requests[0]).toMatchObject({ invalidDecisionTime: true })
    await expect(run()).rejects.toThrow("record is invalid")
    state.failedReads.add(key)
    expect(await first.service.inbox(tenant)).toMatchObject({ invalidRecords: 1, requests: [] })
  } finally { vi.restoreAllMocks() }
})

it("requires the caller-bound exemption to withdraw an Intune request", async () => {
  const { service } = writeApprovalFixture().profile()
  await service.enable(tenant)
  const { graph, dispatch } = runTransport(service)
  const send = () => graph("issuer-observed", "deviceManagement/operationApprovalRequests/cancelMyRequest")
  await expect(send()).rejects.toThrow("current tenant write approval")
  expect((await withExemptGraphCaller("restore-withdraw", send)).ok).toBe(true)
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it.each([false, true])("resolves a named location from its approved creation, with an intervening edit: %s", async edited => {
  const { profile } = writeApprovalFixture()
  const origin = profile(), second = profile(reviewer)
  setWriteApprovals(origin.service)
  await origin.service.enable(tenant)
  const location = { id: requester.oid, "@odata.type": "#microsoft.graph.ipNamedLocation", displayName: "Office", ipRanges: [] }
  const policy = { id: tenant, displayName: "Require MFA", state: "disabled", conditions: { locations: { includeLocations: [requester.oid] } } }
  const writes: Record<string, unknown>[] = []
  let created: Record<string, unknown> | undefined
  const transport = createBridgedFetch({
    dispatch: async () => new Response(null, { status: 404 }),
    getDelegatedToken: async () => ({ accessToken: "fixture", expiresOn: null }),
    authorizeGraph: graphDispatchGuard(origin.service, () => ({ tenant, actor: requester, current: () => true })),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      if (path.endsWith("metadata.json")) return Response.json({ TenantId: tenant, Status: "Success", Failures: 0 })
      if (path.endsWith("office.json")) return Response.json(location)
      if (path.endsWith("mfa.json")) return Response.json(policy)
      if (request.method === "GET") {
        if (path.endsWith(reviewer.oid) && created) return Response.json(created)
        if (path.endsWith("/namedLocations") || path.endsWith("/policies")) return Response.json({ value: [] })
        return Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 })
      }
      const body = await request.json() as Record<string, unknown>
      writes.push(body)
      if (path.endsWith("/namedLocations")) {
        const response = { ...body, id: reviewer.oid }
        created = edited ? { ...response, isTrusted: true } : response
        return Response.json(response, { status: 201 })
      }
      return Response.json({ ...body, id: secondTenant }, { status: 201 })
    },
  })
  vi.stubGlobal("fetch", transport)
  const host = new ApiHost({ routes: { "/api/restore-backup": { POST: restoreRoute } } })
  const run = () => host.dispatch(new Request(`${INTERNAL_API_ORIGIN}/api/restore-backup`, { method: "POST", body: JSON.stringify({
    tenantId: tenant, appId: requester.oid, clientSecret: DELEGATED_CLIENT_SECRET, storageAccountName: approvalAccount,
    backupId: "fixture", restoreType: "selective",
    selectedPolicies: [{ path: "fixture/ConditionalAccessPolicies/mfa.json" }, { path: "fixture/NamedLocations/office.json" }],
  }) }))
  expect((await run()).status).toBe(409)
  await second.service.decide(tenant, (await second.service.inbox(tenant)).requests[0]!.request.id, "approve")
  const result = await (await run()).json()
  expect(result.success).toBe(!edited)
  expect(writes).toHaveLength(edited ? 1 : 2)
  if (!edited) expect(writes[1]).toMatchObject({ conditions: { locations: { includeLocations: [reviewer.oid] } } })
})


it("documents request creation as the start of the seven-day deadline", () => {
  for (const doc of ["apps/app-backup.md", "changes.md", "sync.md", "restore/index.md", "baselines/quick-start.md"]) {
    const guide = readFileSync(new URL(`../docs-site/src/content/docs/${doc}`, import.meta.url), "utf8")
    expect(guide).toContain("The deadline is seven days from request creation. The Tenant approvals inbox shows the expiry.")
  }
})
