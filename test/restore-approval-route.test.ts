import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { POST } from "../src/portal/app/api/restore-backup/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { restoreApprovals, setRestoreApprovalStore, dismissRestoreApproval } from "../src/main/storage/restore-approvals"
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
afterEach(() => vi.unstubAllGlobals())
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
  network()
  const data = await (await POST(request({ approvalAction: "list" }))).json()
  expect(data.records[0]).toMatchObject({ id: code, canComplete: true })
  expect(data.records[0]).not.toHaveProperty("step")
  expect(data.records[0]).not.toHaveProperty("source")
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
