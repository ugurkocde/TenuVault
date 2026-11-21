import { graphCaller } from "../src/portal/lib/policies/graph-restore"
import { afterEach, expect, it, vi } from "vitest"
import { ApiHost } from "../src/main/api/host"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { graphDispatchGuard, sameObservation, withWriteCheckpoint } from "../src/main/write-approvals/dispatch"
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
    if (req.url.endsWith("deviceCategories")) {
      if (req.method === "GET") return Response.json({ value: clash ? [{ id: reviewer.oid, displayName: "[Restored] Source" }] : [] })
      if (req.method === "POST") { writes++; return Response.json({ id: reviewer.oid }) }
    }
    if (new URL(req.url).hostname.endsWith(".blob.core.windows.net")) return new Response(null, { status: req.method === "PUT" ? 201 : 404 })
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
