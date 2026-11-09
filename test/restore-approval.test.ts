import { beforeEach, describe, expect, it, vi } from "vitest"
import fixtures from "./fixtures/maa/errors.json"
import { approvalSignal } from "../src/shared/intune/approval"
import { Restorer, graphCaller, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { restoreApprovals, setRestoreApprovalStore } from "../src/main/storage/restore-approvals"
import { setRestoreJournalStore, writeRecords } from "../src/main/storage/restore-journal"
import { typeForFolder, type Item } from "../src/shared/intune/registry"
import { writeOperation } from "../src/main/features/change-sets/graph"

const code = "11111111-1111-4111-8111-111111111111"
const second = "22222222-2222-4222-8222-222222222222"
const id = "33333333-3333-4333-8333-333333333333"
const tenant = "44444444-4444-4444-8444-444444444444"
const context = { tenantId: tenant, requesterId: id, justification: "Restore a tested backup" }
const path = "backup/ConfigurationPolicies/example.json"
const snapshot: Item = { id, name: "Example", platforms: "windows10", technologies: "mdm", settings: [], assignments: [{ target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }] }
beforeEach(() => {
  const data = new Map<string, string>()
  const store = { get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  setRestoreApprovalStore(store)
  setRestoreJournalStore(store)
})

describe("approval detection", () => {
  it.each([400, 403, 412])("detects a pending code independently of status %s", status => {
    expect(approvalSignal(status, fixtures.pending)).toEqual({ kind: "pending", code })
    expect(approvalSignal(status, {}, new Headers({ "X-MSFT-Approval-Code": code }))).toEqual({ kind: "pending", code })
  })
  it("reads message-only and nested HttpHeaders codes", () => {
    expect(approvalSignal(412, { error: { message: `Approval needed x-msft-approval-code: ${code}` } })).toEqual({ kind: "pending", code })
    expect(approvalSignal(403, { error: { message: JSON.stringify({ HttpHeaders: JSON.stringify({ "x-msft-approval-code": code }) }) } })).toEqual({ kind: "pending", code })
  })
  it("distinguishes required, locked, validation and generic refusals", () => {
    expect(approvalSignal(400, fixtures.required)).toEqual({ kind: "justification-required" })
    expect(approvalSignal(403, { error: { code: "ApprovalRequired" } })).toEqual({ kind: "justification-required" })
    expect(approvalSignal(409, fixtures.locked)).toEqual({ kind: "locked-by-other" })
    expect(approvalSignal(403, fixtures.refused)).toBeUndefined()
    expect(approvalSignal(400, { error: { message: "Invalid body" } })).toBeUndefined()
  })
})

function lab(update = false) {
  const bodies = new Map<string, string>()
  const completed: string[] = []
  let live: Item = { ...snapshot, name: "Current" }
  let approved = false
  let refuse = false
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    if (init?.method === "GET") {
      if (url.includes("operationApprovalRequests")) return Response.json({ status: approved ? "approved" : "needsApproval", expirationDateTime: "2026-11-13T12:00:00Z", approvalJustification: "Reviewed" })
      if (url.endsWith("/settings") || url.endsWith("/assignments")) return Response.json({ value: [] })
      return Response.json(live)
    }
    const pendingCode = url.endsWith("/assign") ? second : code
    if (headers.has("x-msft-approval-code")) {
      expect(init?.body).toBe(bodies.get(headers.get("x-msft-approval-code")!))
      expect(headers.has("x-msft-approval-justification")).toBe(false)
      if (refuse) return Response.json(fixtures.refused, { status: 403 })
      completed.push(pendingCode)
      return Response.json(url.endsWith("/assign") ? {} : { id }, { status: update ? 200 : 201 })
    }
    if (!headers.has("x-msft-approval-justification")) return Response.json(fixtures.required, { status: 400 })
    bodies.set(pendingCode, String(init?.body))
    return Response.json({ error: { message: `x-msft-approval-code: ${pendingCode}` } }, { status: 412 })
  })
  const graph = graphCaller("token", fetcher as typeof fetch, { tenant })
  return { graph, fetcher, completed, approve: () => { approved = true }, refuse: () => { refuse = true }, drift: () => { live = { ...live, description: "Changed" } } }
}

it.each([false, true])("restores with two exact-byte approval rounds, update=%s", async update => {
  const server = lab(update)
  const restorer = new Restorer(server.graph, { mode: update ? "replace" : "copy", assignments: true, approvalContext: context })
  const outcome = await restorer.restore(path, snapshot)
  expect(outcome).toMatchObject({ approvalState: "submitted", approvalId: code, retryable: false })
  expect(writeRecords().every(record => record.state !== "uncertain")).toBe(true)
  server.approve()
  const first = restoreApprovals(tenant).find(record => record.id === code)!
  expect(await restorer.completeApproval(first)).toMatchObject({ approvalState: "submitted", approvalId: second, partial: true, policyId: id })
  const next = restoreApprovals(tenant).find(record => record.id === second)!
  expect(next).toMatchObject({ stepNumber: 2, totalSteps: 2 })
  expect(await restorer.completeApproval(next)).toMatchObject({ success: true, policyId: id })
  expect(server.completed).toEqual([code, second])
  expect(writeRecords().every(record => record.state === "complete")).toBe(true)
})
it("blocks stale completion without a write", async () => {
  const server = lab(true)
  const restorer = new Restorer(server.graph, { mode: "replace", assignments: true, approvalContext: context })
  await restorer.restore(path, snapshot)
  server.approve(); server.drift()
  await expect(restorer.completeApproval(restoreApprovals(tenant).find(record => record.id === code)!)).rejects.toThrow("live object changed")
  expect(server.completed).toEqual([])
  expect(restoreApprovals(tenant).find(record => record.id === code)?.status).toBe("stale")
})
it("explains generic completion 403 and refreshes status", async () => {
  const server = lab()
  const restorer = new Restorer(server.graph, { mode: "copy", assignments: true, approvalContext: context })
  await restorer.restore(path, snapshot)
  server.approve(); server.refuse()
  await expect(restorer.completeApproval(restoreApprovals(tenant).find(record => record.id === code)!)).rejects.toThrow("Intune refused to complete this request")
  expect(writeRecords().some(record => record.state === "uncertain")).toBe(false)
})
it("retains a runtime-required draft and submits it without a new restore", async () => {
  const server = lab()
  const restorer = new Restorer(server.graph, { mode: "copy", assignments: true, approvalContext: { ...context, justification: undefined } })
  expect(await restorer.restore(path, snapshot)).toMatchObject({ approvalState: "required", retryable: false })
  const draft = restoreApprovals(tenant)[0]!
  expect(await restorer.submitApproval(draft, "Restore this item")).toMatchObject({ approvalState: "submitted" })
  await expect(restorer.submitApproval({ ...draft, status: "completed" }, "Again")).rejects.toThrow("already submitted")
})
it("keeps same-code requests unique and other-admin locks non-retryable", async () => {
  const graph: GraphCall = async method => method === "GET" ? { status: 200, body: { status: "needsApproval" } } : { status: 412, body: {} as Item, approval: { kind: "pending", code } }
  const restorer = new Restorer(graph, { mode: "copy", assignments: false, approvalContext: context })
  await restorer.restore(path, snapshot)
  expect(await restorer.restore(path, snapshot)).toMatchObject({ error: "Already submitted for approval" })
  expect(restoreApprovals(tenant)).toHaveLength(1)
  const locked = new Restorer(async () => ({ status: 409, body: {} as Item, approval: { kind: "locked-by-other" } }), { mode: "copy", assignments: false })
  expect(await locked.restore(path, snapshot)).toMatchObject({ retryable: false, error: expect.stringContaining("Another admin") })
})
it("adds no Graph calls or justification headers for an unprotected restore", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("x-msft-approval-justification")).toBe(false)
    return Response.json({ id })
  })
  const restorer = new Restorer(graphCaller("token", fetcher as typeof fetch), { mode: "copy", assignments: false, approvalContext: context })
  expect(await restorer.restore(path, snapshot)).toMatchObject({ success: true })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it.each([false, true])("change sets report approval blocks accurately, partial=%s", async partial => {
  const graph: GraphCall = async (_method, path) => partial && !path.endsWith("/assign") ? { status: 201, body: { id } } : { status: 400, body: {} as Item, approval: { kind: "justification-required" } }
  const created = vi.fn()
  const outcome = await writeOperation(graph, typeForFolder("ConfigurationPolicies")!, { action: "create", targetId: null, proposed: snapshot, assignments: snapshot.assignments as Item[], current: null }, created)
  expect(outcome).toMatchObject({ state: "approval", partial, objectId: partial ? id : null })
  if (outcome.state !== "approval") throw new Error("Expected approval outcome")
  expect(outcome.message.includes("Nothing was changed")).toBe(!partial)
  expect(created).toHaveBeenCalledTimes(partial ? 1 : 0)
})

it("refuses completion and submission by another requester or tenant", async () => {
  const server = lab()
  const restorer = new Restorer(server.graph, { mode: "copy", assignments: false, approvalContext: context })
  await restorer.restore(path, snapshot)
  const record = restoreApprovals(tenant).find(record => record.id === code)!
  const other = new Restorer(server.graph, { mode: "copy", assignments: false, approvalContext: { ...context, requesterId: second } })
  await expect(other.completeApproval(record)).rejects.toThrow("original requester")
  const differentTenant = new Restorer(server.graph, { mode: "copy", assignments: false, approvalContext: { ...context, tenantId: second } })
  await expect(differentTenant.refreshApproval(record)).rejects.toThrow("request's tenant")
  expect(restoreApprovals(second)).toEqual([])
})

it("refreshes rejected notes and server expiration without trusting payload", async () => {
  const server = lab()
  const restorer = new Restorer(server.graph, { mode: "copy", assignments: false, approvalContext: context })
  await restorer.restore(path, snapshot)
  const record = restoreApprovals(tenant).find(record => record.id === code)!
  const graph: GraphCall = async () => ({ status: 200, body: { status: "rejected", expirationDateTime: "2026-11-13T12:00:00Z", approvalJustification: "Wrong change window", payload: "internal format" } })
  const reader = new Restorer(graph, { mode: "copy", assignments: false, approvalContext: context })
  const refreshed = await reader.refreshApproval(record)
  expect(refreshed).toMatchObject({ status: "rejected", expiresAt: "2026-11-13T12:00:00Z", approverNote: "Wrong change window", step: record.step })
})

it("ignores header names mentioned in successful object content", () => {
  expect(approvalSignal(201, { displayName: "x-msft-approval-justification" })).toBeUndefined()
})
it("keeps repair tokens bound to the original restore after approved creation", async () => {
  const server = lab()
  let assignments = 0
  const graph: GraphCall = async (method, path, body, options) => {
    if (path.endsWith("/assign")) {
      assignments++
      return assignments === 1 ? { status: 400, body: { error: { message: "Invalid assignment" } } } : { status: 200, body: {} }
    }
    return server.graph(method, path, body, options)
  }
  const options = { mode: "copy" as const, assignments: true, repairScope: "original-restore", approvalContext: context }
  const restorer = new Restorer(graph, options)
  await restorer.restore(path, snapshot)
  server.approve()
  const outcome = await restorer.completeApproval(restoreApprovals(tenant).find(record => record.id === code)!)
  expect(outcome).toMatchObject({ partial: true, retryable: true, policyId: id })
  expect(outcome.repairToken).toBeDefined()
  expect(await new Restorer(graph, options).repair(path, outcome.repairToken!)).toMatchObject({ success: true, policyId: id })
})
