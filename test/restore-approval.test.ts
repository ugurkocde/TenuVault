import { beforeEach, describe, expect, it, vi } from "vitest"
import fixtures from "./fixtures/maa/errors.json"
import { approvalSignal } from "../src/shared/intune/approval"
import { Restorer, approvalFingerprint, graphCaller, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { restoreApprovals, saveRestoreApproval, dismissRestoreApproval, setRestoreApprovalStore } from "../src/main/storage/restore-approvals"
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
  const stored = restoreApprovals(tenant).find(entry => entry.id === code)!
  expect(stored).toMatchObject({ status: "rejected", label: record.label, source: {}, remaining: [] })
  expect(stored.step.body).toBeUndefined()
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

it.each([200, 201, 302, 500, 503])("ignores approval headers outside 4xx (%s)", status => {
  expect(approvalSignal(status, fixtures.pending, new Headers({ "x-msft-approval-code": code }))).toBeUndefined()
})
it("fingerprints settings without volatile fields and optionally assignments", () => {
  expect(approvalFingerprint({ ...snapshot, version: 2, lastModifiedDateTime: "today" })).toBe(approvalFingerprint({ ...snapshot, version: 1 }))
  expect(approvalFingerprint({ ...snapshot, description: "changed" })).not.toBe(approvalFingerprint(snapshot))
  expect(approvalFingerprint({ ...snapshot, assignments: [] }, false)).toBe(approvalFingerprint(snapshot, false))
})
it.each(["invalid json", "{}", "null"])("sets aside corrupt storage (%s)", raw => {
  const data = new Map([["restore.approvals", raw]])
  setRestoreApprovalStore({ get: key => data.get(key) ?? null, set: (key, value) => { data.set(key, value) }, delete: key => { data.delete(key) } })
  expect(restoreApprovals(tenant)).toEqual([])
  expect([...data.entries()]).toEqual([[expect.stringContaining("restore.approvals.unreadable."), raw]])
})
it("prunes old terminal records, caps storage and skips unchanged saves", async () => {
  const server = lab()
  await new Restorer(server.graph, { mode: "copy", assignments: false, approvalContext: context }).restore(path, snapshot)
  const template = restoreApprovals(tenant)[0]!
  const records = Array.from({ length: 200 }, (_, index) => ({ ...template, id: String(index), status: "completed", submittedAt: new Date(Date.now() - index * 1000).toISOString() }))
  records.push({ ...template, id: "old", status: "expired", submittedAt: "2000-01-01" })
  const data = new Map([["restore.approvals", JSON.stringify(records)]])
  const set = vi.fn((key: string, value: string) => { data.set(key, value) })
  setRestoreApprovalStore({ get: key => data.get(key) ?? null, set, delete: key => { data.delete(key) } })
  saveRestoreApproval(template)
  expect(restoreApprovals(tenant)).toHaveLength(200)
  expect(restoreApprovals(tenant).some(record => record.id === "old" || record.id === "199")).toBe(false)
  set.mockClear()
  saveRestoreApproval(template)
  expect(set).not.toHaveBeenCalled()
})
it("deduplicates drafts and removes a submitted draft", async () => {
  const server = lab()
  const restorer = new Restorer(server.graph, { mode: "copy", assignments: false, approvalContext: { ...context, justification: undefined } })
  await restorer.restore(path, snapshot)
  await restorer.restore(path, snapshot)
  expect(restoreApprovals(tenant)).toHaveLength(1)
  await restorer.submitApproval(restoreApprovals(tenant)[0]!, "Reviewed")
  expect(restoreApprovals(tenant)).toHaveLength(1)
  expect(restoreApprovals(tenant)[0]!.id).toBe(code)
})
it("retains a draft when Intune returns a code for a different body", async () => {
  const server = lab()
  const restorer = new Restorer(server.graph, { mode: "copy", assignments: false, approvalContext: context })
  await restorer.restore(path, snapshot)
  const existing = restoreApprovals(tenant)[0]!
  const draft = { ...existing, id: second, status: "justification-required", step: { ...existing.step, body: JSON.stringify({ name: "Different" }) } }
  saveRestoreApproval(draft)
  expect(await restorer.submitApproval(draft)).toMatchObject({ error: "A different change to this object is already waiting for approval in Intune. Complete or withdraw it first." })
  expect(restoreApprovals(tenant).find(record => record.id === second)?.status).toBe("justification-required")
})
it("refreshes stale requests, expires missing requests and skips terminal GETs", async () => {
  const server = lab()
  const restorer = new Restorer(server.graph, { mode: "copy", assignments: false, approvalContext: context })
  await restorer.restore(path, snapshot)
  const record = { ...restoreApprovals(tenant)[0]!, status: "stale" }
  saveRestoreApproval(record)
  const graph = vi.fn(async () => ({ status: 404, body: {} }))
  const reader = new Restorer(graph, { mode: "copy", assignments: false, approvalContext: context })
  const expired = await reader.refreshApproval(record)
  expect(expired.status).toBe("expired")
  await reader.refreshApproval(expired)
  expect(graph).toHaveBeenCalledTimes(1)
  dismissRestoreApproval(tenant, code)
  expect(restoreApprovals(tenant)).toEqual([])
})
it("saves a pending continuation when the baseline read fails", async () => {
  const server = lab(true)
  let completed = false
  const graph: GraphCall = async (method, path, body, options) => {
    if (method === "GET" && !path.includes("operationApprovalRequests") && completed) throw new Error("Read unavailable")
    const response = await server.graph(method, path, body, options)
    if (server.completed.length) completed = true
    return response
  }
  const restorer = new Restorer(graph, { mode: "replace", assignments: true, approvalContext: context })
  await restorer.restore(path, snapshot)
  server.approve()
  await expect(restorer.completeApproval(restoreApprovals(tenant).find(record => record.id === code)!)).rejects.toThrow("Read unavailable")
  expect(restoreApprovals(tenant).find(record => record.id === code)).toMatchObject({ continuationPending: true })
  expect(server.completed).toEqual([code])
})

it("preserves pending approval after an intermediate baseline read throws", async () => {
  let wrote = false
  let requestStatus = "needsApproval"
  const graph: GraphCall = async (method, target): ReturnType<GraphCall> => {
    if (method === "GET") {
      if (target.includes("operationApprovalRequests")) return { status: 200, body: { status: requestStatus } }
      if (wrote) throw new Error("Read unavailable")
      if (target.endsWith("/settings") || target.endsWith("/assignments")) return { status: 200, body: { value: [] } }
      return { status: 200, body: { ...snapshot, name: "Current" } }
    }
    if (!target.endsWith("/assign")) { wrote = true; return { status: 200, body: {} } }
    return { status: 412, body: {}, approval: { kind: "pending", code } }
  }
  const outcome = await new Restorer(graph, { mode: "replace", assignments: true, approvalContext: context }).restore(path, snapshot)
  expect(outcome).toMatchObject({ approvalId: code, approvalState: "submitted", partial: true })
  expect(restoreApprovals(tenant).find(record => record.id === code)).toMatchObject({ status: "needsApproval" })
  expect(restoreApprovals(tenant).find(record => record.id === code)?.fingerprint).toBeUndefined()
  requestStatus = "approved"
  wrote = false
  await expect(new Restorer(graph, { mode: "replace", assignments: true, approvalContext: context }).completeApproval(restoreApprovals(tenant).find(record => record.id === code)!)).rejects.toThrow("could not read this object when the request was sent")
})
it("passes the verified repair baseline to a protected remaining update", async () => {
  let assignmentAttempts = 0
  const graph: GraphCall = async (method, target): ReturnType<GraphCall> => {
    if (method === "GET") {
      if (target.endsWith("/settings") || target.endsWith("/assignments")) return { status: 200, body: { value: [] } }
      return { status: 200, body: { ...snapshot, name: "Current" } }
    }
    if (!target.endsWith("/assign")) return { status: 200, body: {} }
    assignmentAttempts++
    return assignmentAttempts === 1 ? { status: 400, body: { error: { message: "Rejected" } } } : { status: 400, body: {}, approval: { kind: "justification-required" } }
  }
  const restorer = new Restorer(graph, { mode: "replace", assignments: true, approvalContext: { ...context, justification: undefined } })
  const first = await restorer.restore(path, snapshot)
  expect(first.repairToken).toBeDefined()
  const repaired = await restorer.repair(path, first.repairToken!)
  expect(repaired).toMatchObject({ approvalState: "required" })
  expect(repaired.approvalId).toBeDefined()
  expect(restoreApprovals(tenant)[0]?.fingerprint).toBeDefined()
})
