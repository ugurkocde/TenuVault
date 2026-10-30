import { afterEach, describe, expect, it, vi } from "vitest"
import { createAuditRecorder } from "../src/main/api/audit"
import { ApiHost } from "../src/main/api/host"

const TENANT = "11111111-1111-1111-1111-111111111111"
const credentials = { tenantId: TENANT, appId: "fixture-app", clientSecret: "fixture-secret", storageAccountName: "fixturestore" }

afterEach(() => vi.restoreAllMocks())

describe("audit callbacks cannot replace a completed route response", () => {
  it.each([201, 409])("preserves the IPC status, headers and body (%s) when onHandled throws", async (status) => {
    const failure = new Error("Recorder fixture failure")
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const route = vi.fn(() => Response.json({ result: "Route fixture" }, { status, headers: { "x-fixture": "preserved" } }))
    const host = new ApiHost({ routes: { "/api/fixture": { POST: route } }, onHandled: () => { throw failure } })
    const result = await host.handleIpc({ path: "/api/fixture", method: "POST", headers: {}, body: new TextEncoder().encode("{}") })
    expect(route).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(status)
    expect(result.headers["x-fixture"]).toBe("preserved")
    expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({ result: "Route fixture" })
    expect(log).toHaveBeenCalledWith("[api] POST /api/fixture onHandled failed:", failure)
  })

  it.each([42, true, {}, [], null, "", undefined])("skips invalid tenant identity (%j) before account lookup", (tenantId) => {
    const dispatch = vi.fn(async () => Response.json({ success: true }))
    const accountFor = vi.fn((tenantId: string) => { tenantId.toLowerCase(); return null })
    const record = createAuditRecorder(dispatch, accountFor)
    const body = JSON.stringify({ ...credentials, tenantId })
    expect(() => record(new Request("http://tenuvault.internal/api/backup/start", { method: "POST" }), body, Response.json({ jobId: "fixture-job" }))).not.toThrow()
    expect(accountFor).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([
    ["/api/frameworks", "create"], ["/api/oib", "oib-deploy"], ["/api/oib", "oib-fix"], ["/api/oib", "oib-undo"],
    ["/api/restore-backup", "restore"], ["/api/revert-policy", "revert"],
  ])("skips invalid tenant identity for %s %s", async (path, action) => {
    const dispatch = vi.fn(async () => Response.json({ success: true }))
    const accountFor = vi.fn((tenantId: string) => { tenantId.toLowerCase(); return null })
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const record = createAuditRecorder(dispatch, accountFor)
    record(new Request(`http://tenuvault.internal${path}`, { method: "POST" }), JSON.stringify({ ...credentials, tenantId: 42, action }), Response.json({ success: true }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(accountFor).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it.each(["null", "[]", "42", "true", "{invalid"])("skips malformed audit bodies (%s)", (body) => {
    const dispatch = vi.fn(async () => Response.json({ success: true }))
    const record = createAuditRecorder(dispatch, () => null)
    expect(() => record(new Request("http://tenuvault.internal/api/backup/start", { method: "POST" }), body, Response.json({}))).not.toThrow()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("writes framework creation entries to the tenant's configured storage account", async () => {
    const entries: Array<{ storageAccountName?: string }> = []
    const record = createAuditRecorder(async (request) => { entries.push(await request.json()); return Response.json({ success: true }) }, () => null)
    record(
      new Request("http://tenuvault.internal/api/frameworks", { method: "POST" }),
      JSON.stringify({ tenantId: TENANT, appId: "fixture-app", action: "create", runId: "run-1", storageAccountName: "tenantazure" }),
      Response.json({ success: true, results: [{ id: "policy-1", name: "Baseline policy" }] }),
    )
    await vi.waitFor(() => expect(entries).toHaveLength(1))
    expect(entries[0]!.storageAccountName).toBe("tenantazure")
  })

  it("falls back to local storage for framework creations without a storage account", async () => {
    const entries: Array<{ storageAccountName?: string }> = []
    const record = createAuditRecorder(async (request) => { entries.push(await request.json()); return Response.json({ success: true }) }, () => null)
    record(
      new Request("http://tenuvault.internal/api/frameworks", { method: "POST" }),
      JSON.stringify({ tenantId: TENANT, appId: "fixture-app", action: "create", runId: "run-1" }),
      Response.json({ success: true, results: [{ id: "policy-1", name: "Baseline policy" }] }),
    )
    await vi.waitFor(() => expect(entries).toHaveLength(1))
    expect(entries[0]!.storageAccountName).toBe(`tvlocal-${TENANT}`)
  })

  it("logs when the audit write itself fails instead of dropping the entry silently", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const record = createAuditRecorder(async () => new Response("no", { status: 503 }), () => null)
    record(new Request("http://tenuvault.internal/api/backup/start", { method: "POST" }), JSON.stringify(credentials), Response.json({ jobId: "fixture-job" }))
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    expect(log.mock.calls.flat().join(" ")).toContain("503")
  })

  it("still attributes and records a valid handled request", async () => {
    const entries: unknown[] = []
    const accountFor = vi.fn(() => ({ tenantId: TENANT, clientId: "fixture-app", username: "admin@example.test", name: "Fixture admin", homeAccountId: "fixture-account" }))
    const record = createAuditRecorder(async (request) => { entries.push(await request.json()); return Response.json({ success: true }) }, accountFor)
    record(new Request("http://tenuvault.internal/api/backup/start", { method: "POST" }), JSON.stringify(credentials), Response.json({ jobId: "fixture-job" }))
    await vi.waitFor(() => expect(entries).toHaveLength(1))
    expect(accountFor).toHaveBeenCalledWith(TENANT)
    expect(entries[0]).toMatchObject({ tenantId: TENANT, user: { name: "Fixture admin" }, logEntry: { eventType: "BACKUP_STARTED", result: "SUCCESS" } })
  })
})
