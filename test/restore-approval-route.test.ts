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
  const original = network()
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("operationApprovalRequests/")) return Response.json({ status: "approved" })
    if (String(input).endsWith("/assign")) {
      expect(pendingEvents(account)[0]?.job?.items?.[0]?.approval?.requestId).toBe(code)
      return Response.json({}, { status: 412, headers: { "x-msft-approval-code": nextId } })
    }
    if (new Headers(init?.headers).get("x-msft-approval-code") === code) return Response.json({ id: objectId }, { status: 201 })
    return original(input, init)
  }))
  const local = memoryStore()
  setAuditOutboxStore(local)
  setMainAuditSink(new AuditSink({
    store: local,
    bind: () => ({ tenantId, storageAccountName: account, user: { id: requesterId, name: "Requester", email: "" } }),
    transport: async () => { throw new Error("Offline") },
  }))
  const response = await POST(request({ approvalAction: "complete", approvalId: code }))
  expect(await response.json()).toMatchObject({ outcome: { approvalId: nextId } })
  expect(pendingEvents(account).map(item => item.job)).toMatchObject([
    { operationId, stage: "approval-complete", status: "completed", items: [{ outcome: "created", approval: { requestId: code } }] },
    { operationId, stage: "approval-submit", status: "pending", items: [{ outcome: "pending", approval: { requestId: nextId } }] },
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
  expect(pendingEvents(account)[0]?.job).toMatchObject({ status: "failed", stage: "approval-complete", items: [{
    outcome: "failed", reason: "APPROVAL_COMPLETION_REFUSED", approval: { requestId: code },
  }] })
})
