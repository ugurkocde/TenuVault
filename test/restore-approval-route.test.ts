import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { POST } from "../src/portal/app/api/restore-backup/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { restoreApprovals, saveRestoreApproval, setRestoreApprovalStore, dismissRestoreApproval } from "../src/main/storage/restore-approvals"
import { AuditSink, setMainAuditSink } from "../src/main/api/audit-sink"
import { pendingEvents, setAuditOutboxStore } from "../src/portal/lib/audit/outbox"
import { memoryStore } from "./helpers"
import { requiredFeatures } from "../src/main/api/plan-gates"
import { resultSummary, statusFromResults, emptyResult } from "../src/main/features/change-sets/model"

const tenantId = "44444444-4444-4444-8444-444444444444"
const requesterId = "33333333-3333-4333-8333-333333333333"
const code = "11111111-1111-4111-8111-111111111111"
const credentials = { tenantId, appId: requesterId, clientSecret: "placeholder" }
const request = (body: object) => new NextRequest("http://tenuvault.internal/api/restore-backup", { method: "POST", body: JSON.stringify({ ...credentials, ...body }) })
let storage: Map<string, string>
beforeEach(() => {
  storage = new Map()
  setRestoreApprovalStore({ get: key => storage.get(key) ?? null, set: (key, value) => { storage.set(key, value) }, delete: key => { storage.delete(key) } })
})
afterEach(() => { vi.unstubAllGlobals(); setMainAuditSink(undefined); setAuditOutboxStore() })
async function seed() {
  const graph: GraphCall = async method => method === "GET" ? { status: 200, body: { status: "approved" } } : { status: 412, body: {} as never, approval: { kind: "pending", code } }
  await new Restorer(graph, { mode: "copy", assignments: false, approvalContext: { tenantId, requesterId } }).restore("backup/DeviceCategories/test.json", { displayName: "Example" })
}
function network(readStatus = 200) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).includes("login.microsoftonline.com")
    ? Response.json({ access_token: `header.${Buffer.from(JSON.stringify({ oid: requesterId, tid: tenantId, scp: "DeviceManagementConfiguration.ReadWrite.All" })).toString("base64url")}.signature` })
    : String(input).endsWith("cancelMyRequest") ? new Response(null, { status: 204 }) : Response.json(readStatus === 200 ? { value: [] } : { error: { message: "Denied" } }, { status: readStatus }))
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}
it.each([200, 403])("does not block review when access policy read returns %s", async status => {
  const fetcher = network(status)
  expect(await (await POST(request({ approvalAction: "detect" }))).json()).toEqual({ enabled: false })
  expect(fetcher.mock.calls.map(call => String(call[0])).filter(url => url.includes("graph.microsoft.com"))).toEqual(["https://graph.microsoft.com/beta/deviceManagement/operationApprovalPolicies?$top=1"])
})
it("withdraws with id and dismisses only terminal records", async () => {
  await seed()
  expect(() => dismissRestoreApproval(tenantId, code)).toThrow("finished requests")
  const fetcher = network()
  expect((await POST(request({ approvalAction: "withdraw", approvalId: code }))).status).toBe(200)
  const write = fetcher.mock.calls.find(call => String(call[0]).endsWith("cancelMyRequest"))!
  expect(JSON.parse(String((write[1] as RequestInit | undefined)?.body))).toEqual({ id: code })
  expect(restoreApprovals(tenantId)[0]!.status).toBe("cancelled")
  expect((await POST(request({ approvalAction: "dismiss", approvalId: code }))).status).toBe(200)
  expect(restoreApprovals(tenantId)).toEqual([])
})
it("does not send stored bodies to the renderer", async () => {
  await seed()
  const fetcher = network()
  const data = await (await POST(request({ approvalAction: "list" }))).json()
  expect(data.records[0]).toMatchObject({ id: code, canComplete: false })
  expect(data.records[0]).not.toHaveProperty("step")
  expect(data.records[0]).not.toHaveProperty("source")
  expect(fetcher).not.toHaveBeenCalled()
})
it("uses stored restore plan requirements for approval actions", async () => {
  await seed()
  expect(requiredFeatures("/api/restore-backup", { tenantId, approvalId: code, approvalAction: "complete", mode: "replace", assignments: true })).toEqual([])
  expect(requiredFeatures("/api/restore-backup", { tenantId, approvalAction: "detect" })).toEqual([])
})
it("counts blocked operations and reports written configurations as partial", () => {
  const result = { ...emptyResult(), status: "approval" as const, partial: true }
  expect(resultSummary([result])).toContain("1 approval blocked")
  expect(statusFromResults([result])).toBe("partial")
})

it("requires the requester to dismiss stale requests but allows local drafts", async () => {
  await seed()
  const record = restoreApprovals(tenantId)[0]!
  saveRestoreApproval({ ...record, status: "stale", requesterId: "other" })
  network()
  expect((await POST(request({ approvalAction: "dismiss", approvalId: code }))).status).toBe(409)
  saveRestoreApproval({ ...record, status: "justification-required", requesterId: "other" })
  expect((await POST(request({ approvalAction: "dismiss", approvalId: code }))).status).toBe(200)
})
it("refreshes and reports status after withdrawal is refused", async () => {
  await seed()
  const original = network()
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("cancelMyRequest")) return Response.json({}, { status: 403 })
    if (String(input).includes("operationApprovalRequests/")) return Response.json({ status: "rejected" })
    return original(input, init)
  }))
  const response = await POST(request({ approvalAction: "withdraw", approvalId: code }))
  expect(response.status).toBe(409)
  expect((await response.json()).error).toContain("Current status: rejected")
  expect(restoreApprovals(tenantId)[0]?.status).toBe("rejected")
})

it("uses the Intune approver and correlates completion without copying justification", async () => {
  const operationId = "77777777-7777-4777-8777-777777777777"
  const approverId = "55555555-5555-4555-8555-555555555555"
  const targetId = "66666666-6666-4666-8666-666666666666"
  const account = "auditdecision"
  await seed()
  saveRestoreApproval({ ...restoreApprovals(tenantId)[0]!, operationId })
  const original = network()
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("operationApprovalRequests/")) return Response.json({
      status: "approved", approver: { user: { id: approverId, displayName: "Approver", Upn: "approver@example.test" } },
      approvalJustification: "SecretApprovalCanary", lastModifiedDateTime: "2026-11-20T12:00:00Z",
    })
    if (String(input).includes("/deviceAppManagement/mobileAppCategories") || String(input).includes("/deviceManagement/deviceCategories")) {
      return Response.json({ id: targetId }, { status: 201 })
    }
    return original(input, init)
  }))
  setMainAuditSink(new AuditSink({
    bind: () => ({ tenantId, storageAccountName: account, user: { id: "untrusted", name: "Old account", email: "" } }),
    transport: async () => { throw new Error("Offline") },
  }))
  try {
    const response = await POST(request({ approvalAction: "complete", approvalId: code }))
    expect(response.status).toBe(200)
    const entries = pendingEvents(account)
    expect(entries).toMatchObject([{
      user: { id: requesterId, tenantId },
      job: { operationId, stage: "approval-complete", status: "completed", items: [{
        targetId, outcome: "created", approval: {
          system: "intune", requestId: code, principalId: approverId, displayName: "Approver", upn: "approver@example.test",
          justificationPresent: true,
        },
      }] },
    }])
    expect(JSON.stringify(entries)).not.toContain("SecretApprovalCanary")
    expect(entries[0]?.job?.items?.[0]?.approval?.decisionAt).toBeUndefined()
  } finally {
    setMainAuditSink(undefined)
    setAuditOutboxStore()
  }
})

it("records the completed request and the next submission with separate IDs under the original operation", async () => {
  const operationId = "77777777-7777-4777-8777-777777777777"
  const nextId = "88888888-8888-4888-8888-888888888888"
  const objectId = "99999999-9999-4999-8999-999999999999"
  const account = "approvalstages"
  await seed()
  const record = restoreApprovals(tenantId)[0]!
  saveRestoreApproval({ ...record, operationId, remaining: [{
    method: "POST", kind: "assignments", path: `deviceManagement/deviceCategories/${objectId}/assign`, body: '{"assignments":[]}',
  }], totalSteps: 2 })
  const local = memoryStore()
  const original = network()
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("operationApprovalRequests/")) return Response.json({ status: "approved" })
    if (String(input).endsWith("/assign")) {
      expect(pendingEvents(account)).toHaveLength(0)
      expect(local.get("audit.restore-jobs")).toContain(code)
      return Response.json({}, { status: 412, headers: { "x-msft-approval-code": nextId } })
    }
    if (new Headers(init?.headers).get("x-msft-approval-code") === code) return Response.json({ id: objectId }, { status: 201 })
    return original(input, init)
  }))
  setAuditOutboxStore(local)
  setMainAuditSink(new AuditSink({
    store: local,
    bind: () => ({ tenantId, storageAccountName: account, user: { id: requesterId, name: "Requester", email: "" } }),
    transport: async () => { throw new Error("Offline") },
  }))
  const response = await POST(request({ approvalAction: "complete", approvalId: code }))
  expect(await response.json()).toMatchObject({ outcome: { approvalId: nextId } })
  expect(pendingEvents(account).map(item => item.job)).toMatchObject([
    { operationId, stage: "approval-submit", status: "pending", items: [{ outcome: "pending", approval: { requestId: nextId } }] },
    { operationId, stage: "approval-complete", status: "warnings", items: [{ outcome: "pending", approval: { requestId: code } }] },
  ])
  expect(restoreApprovals(tenantId).find(item => item.id === nextId)?.operationId).toBe(operationId)
})

it("records a refusal before dispatch as failed with a stable reason", async () => {
  await seed()
  const account = "approvalrefused"
  const original = network()
  const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("operationApprovalRequests/")) return Response.json({ status: "needsApproval" })
    return original(input, init)
  })
  vi.stubGlobal("fetch", calls)
  const local = memoryStore()
  setAuditOutboxStore(local)
  setMainAuditSink(new AuditSink({
    store: local,
    bind: () => ({ tenantId, storageAccountName: account, user: { id: requesterId, name: "Requester", email: "" } }),
    transport: async () => { throw new Error("Offline") },
  }))
  expect((await POST(request({ approvalAction: "complete", approvalId: code }))).status).toBe(409)
  expect(calls.mock.calls.filter(([url, init]) => String(url).includes("graph.microsoft.com") && init?.method !== "GET")).toHaveLength(0)
  expect(pendingEvents(account)[0]?.job).toMatchObject({ status: "failed", stage: "approval-attempt", items: [{
    outcome: "failed", reason: "APPROVAL_COMPLETION_REFUSED", approval: { requestId: code },
  }] })
})

it.each([[400, "failed"], [503, "uncertain"]] as const)("audits a %s assignment after the approved create and deduplicates on restart", async (status, stepOutcome) => {
  await seed()
  const record = restoreApprovals(tenantId)[0]!
  const objectId = "99999999-9999-4999-8999-999999999999"
  saveRestoreApproval({ ...record, totalSteps: 2, remaining: [{
    method: "POST", kind: "assignments", path: `deviceManagement/deviceCategories/${objectId}/assign`, body: '{"assignments":[]}',
  }] })
  const account = "approvalaudit"
  const local = memoryStore()
  setAuditOutboxStore(local)
  const opts = {
    store: local,
    bind: () => ({ tenantId, storageAccountName: account, user: { id: requesterId, name: "Requester", email: "" } }),
    transport: async () => { throw new Error("Offline") },
  }
  setMainAuditSink(new AuditSink(opts))
  const original = network()
  const writes = vi.fn()
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("operationApprovalRequests/")) return Response.json({ status: "approved" })
    if (String(input).endsWith("/assign")) {
      writes("assign")
      return Response.json({}, { status })
    }
    if (new Headers(init?.headers).get("x-msft-approval-code") === code) {
      writes("create")
      return Response.json({ id: objectId }, { status: 201 })
    }
    return original(input, init)
  }))
  const response = await POST(request({ approvalAction: "complete", approvalId: code }))
  expect(await response.json()).toMatchObject({ outcome: { success: false, partial: true, auditUncertain: status === 503 } })
  const [entry] = pendingEvents(account)
  expect(entry?.job).toMatchObject({ status: "warnings", stage: "approval-complete", items: [{
    targetId: objectId, outcome: "partial", approval: { requestId: code },
    applied: expect.arrayContaining([{ operation: "create", field: "displayName" }]),
    steps: [{ kind: "content", outcome: "applied" }, { kind: "assignments", outcome: stepOutcome }],
  }] })
  // The receipt was durably handed to the outbox, but the approval record still needs reconciliation.
  saveRestoreApproval({ ...record, objectId, status: "approved", continuationPending: true })
  const restarted = new AuditSink(opts)
  restarted.recover()
  setMainAuditSink(restarted)
  await POST(request({ approvalAction: "complete", approvalId: code }))
  expect(pendingEvents(account).map(item => item.id)).toEqual([entry?.id])
  expect(writes.mock.calls).toEqual([["create"], ["assign"]])
})

it.each([400, 403])("records definitive Graph refusal %s after dispatch with the original approval ID", async status => {
  await seed()
  const account = "approvaldenied"
  const local = memoryStore()
  setAuditOutboxStore(local)
  setMainAuditSink(new AuditSink({
    store: local,
    bind: () => ({ tenantId, storageAccountName: account, user: { id: requesterId, name: "Requester", email: "" } }),
    transport: async () => { throw new Error("Offline") },
  }))
  const original = network()
  let graphStatus = status
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("operationApprovalRequests/")) return Response.json({ status: "approved" })
    if (new Headers(init?.headers).get("x-msft-approval-code") === code) {
      expect(local.get("audit.restore-jobs")).toContain(code)
      return graphStatus === 201 ? Response.json({ id: requesterId }, { status: 201 }) : Response.json({ error: { message: "Denied" } }, { status: graphStatus })
    }
    return original(input, init)
  }))
  const refusal = await POST(request({ approvalAction: "complete", approvalId: code }))
  expect(refusal.status).toBe(status)
  expect(await refusal.json()).toMatchObject({ code: "APPROVAL_COMPLETION_REFUSED" })
  expect(pendingEvents(account)[0]?.job).toMatchObject({ status: "failed", items: [{
    outcome: "failed", reason: "APPROVAL_COMPLETION_REFUSED", approval: { requestId: code },
  }] })
  graphStatus = 201
  expect((await POST(request({ approvalAction: "complete", approvalId: code }))).status).toBe(200)
  expect(pendingEvents(account).map(entry => [entry.job?.stage, entry.job?.status])).toEqual([
    ["approval-attempt", "failed"], ["approval-complete", "completed"],
  ])
})

it("records a read failure before any restore write as failed", async () => {
  const graph: GraphCall = vi.fn(async () => { throw new Error("Preflight read failed") })
  const outcome = await new Restorer(graph, { mode: "replace", assignments: false })
    .restore("backup/DeviceCategories/test.json", { id: "test", displayName: "Test" })
  expect(outcome).toMatchObject({ success: false, auditUncertain: false })
})

it("correlates a retry after main restarts only for the original actor, source and destination", async () => {
  const local = memoryStore()
  const account = "restorecorrelation"
  const foreignTenant = "88888888-8888-4888-8888-888888888888"
  const opts = {
    store: local,
    bind: (destination: string) => ({ tenantId: destination, storageAccountName: account, user: { id: requesterId, name: "Requester", email: "" } }),
    transport: async () => { throw new Error("Offline") },
  }
  setAuditOutboxStore(local)
  let actor = requesterId
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === "login.microsoftonline.com") return Response.json({
      access_token: `header.${Buffer.from(JSON.stringify({ oid: actor, tid: url.pathname.split("/")[1], scp: "DeviceManagementConfiguration.ReadWrite.All" })).toString("base64url")}.signature`,
    })
    if (url.pathname.endsWith("/metadata.json")) return Response.json({ TenantId: tenantId, Status: "Success" })
    if (url.pathname.endsWith("/test.json")) return Response.json({ displayName: "Test" })
    if (url.hostname === "graph.microsoft.com") return Response.json({}, { status: 400 })
    return new Response(null, { status: 404 })
  }))
  const run = async (backupId: string, retryOf?: string, target?: string) => {
    const response = await POST(request({
      storageAccountName: account, backupId, retryOf, restoreType: "selective",
      selectedPolicies: [{ path: `${backupId}/DeviceCategories/test.json` }],
      ...(target ? { targetTenants: [{ tenantId: target, appId: requesterId }] } : {}),
    }))
    expect(response.status).toBe(200)
    const { jobId, details } = await response.json()
    expect(details.results[0].retryJobId).toBe(jobId)
    return jobId as string
  }
  setMainAuditSink(new AuditSink(opts))
  const original = await run("backup")
  setMainAuditSink(new AuditSink(opts))
  const retry = await run("backup", original)
  const differentSource = await run("other", original)
  const differentDestination = await run("backup", original, foreignTenant)
  actor = foreignTenant
  const differentActor = await run("backup", original)
  const operations = new Map(pendingEvents(account).map(entry => [entry.job?.runId, entry.job?.operationId]))
  expect(operations.get(retry)).toBe(original)
  for (const id of [differentSource, differentDestination, differentActor]) expect(operations.get(id)).toBe(id)
})
