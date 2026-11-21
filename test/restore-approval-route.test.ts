import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { POST } from "../src/portal/app/api/restore-backup/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { restoreApprovals, saveRestoreApproval, setRestoreApprovalStore, dismissRestoreApproval } from "../src/main/storage/restore-approvals"
import { requiredFeatures } from "../src/main/api/plan-gates"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { graphDispatchGuard } from "../src/main/write-approvals/dispatch"
import { setWriteApprovals } from "../src/main/write-approvals/service"
import { reviewer, unenrolledApprovals, writeApprovalFixture } from "./helpers/write-approval-fixture"
import { resultSummary, statusFromResults, emptyResult } from "../src/main/features/change-sets/model"

beforeEach(() => setWriteApprovals(unenrolledApprovals("azure")))

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
afterEach(() => { setWriteApprovals(undefined); vi.unstubAllGlobals() })
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


it("keeps a saved Intune request and requires separate review for submission and completion", async () => {
  const { profile } = writeApprovalFixture()
  const origin = profile({ oid: requesterId, label: "Requester" }), second = profile(reviewer)
  const draftGraph: GraphCall = async method => {
    if (method === "GET") return { status: 200, body: { value: [] } }
    return { status: 412, body: {} as Record<string, never>, approval: { kind: "justification-required" } }
  }
  const start = new Restorer(draftGraph, {
    mode: "copy", assignments: false, approvalContext: { tenantId, requesterId },
  })
  const path = "backup/DeviceCategories/test.json"
  await start.restore(path, { displayName: "Example" })
  const draft = restoreApprovals(tenantId)[0]!
  setWriteApprovals(origin.service)
  await origin.service.enable(tenantId)
  let mutations = 0
  const token = `header.${Buffer.from(JSON.stringify({ oid: requesterId, tid: tenantId, scp: "DeviceManagementConfiguration.ReadWrite.All" })).toString("base64url")}.signature`
  const fetcher = createBridgedFetch({
    dispatch: async () => new Response(null, { status: 404 }),
    getDelegatedToken: async () => ({ accessToken: token, expiresOn: null }),
    authorizeGraph: graphDispatchGuard(origin.service, value => value === token ? { tenant: tenantId, actor: { oid: requesterId, label: "Requester" }, current: () => true } : undefined),
    fetch: async (input, init) => {
      const req = new Request(input, init)
      const url = req.url
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: token })
      if (url.endsWith("cancelMyRequest")) return new Response(null, { status: 204 })
      if (url.includes("operationApprovalRequests/")) return Response.json({ status: "approved", approver: { user: { id: reviewer.oid, displayName: "Reviewer", Upn: "reviewer@example.invalid" } } })
      if (req.method === "GET") return Response.json({ value: [] })
      mutations++
      if (req.headers.has("x-msft-approval-justification")) return new Response("{}", { status: 412, headers: { "x-msft-approval-code": code } })
      expect(req.headers.get("x-msft-approval-code")).toBe(code)
      return Response.json({ id: code })
    },
  })
  vi.stubGlobal("fetch", fetcher)
  const approve = async () => {
    const row = (await second.service.inbox(tenantId)).requests.find(item => item.request.state === "pending" && !item.decision)
    await second.service.decide(tenantId, row!.request.id, "approve")
  }
  const submit = () => POST(request({ approvalAction: "submit", approvalId: draft.id, justification: "Restore the approved category" }))
  expect((await submit()).status).toBe(409)
  expect(mutations).toBe(0)
  await approve()
  expect(await (await submit()).json()).toMatchObject({ outcome: { approvalState: "submitted", approvalId: code } })
  expect(mutations).toBe(1)
  const complete = () => POST(request({ approvalAction: "complete", approvalId: code }))
  expect((await complete()).status).toBe(409)
  expect(mutations).toBe(1)
  await approve()
  expect(await (await complete()).json()).toMatchObject({ outcome: { success: true, intuneApprover: { user: { id: reviewer.oid, displayName: "Reviewer", upn: "reviewer@example.invalid" } } } })
  expect(mutations).toBe(2)
})
