import { afterEach, describe, expect, it, vi } from "vitest"
import { applyChangeSet, approveChangeSet, createChangeSet, createRollbackChangeSet, previewChangeSet } from "../src/main/features/change-sets/engine"
import type { ChangeSetRecord } from "../src/main/features/change-sets/model"
import { fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"
import { FakeTenant, setting, wire } from "./feature-change-sets-fakes"
import { createAuditLogger } from "../src/portal/lib/audit/logger"
import { pendingEvents, setAuditOutboxStore } from "../src/portal/lib/audit/outbox"
import { AuditEventType, AuditResult, AuditSeverity, type AuditLogEntry, type CreateAuditLogInput } from "../src/portal/lib/audit/types"
import { POST as exportLogs } from "../src/portal/app/api/audit/export/route"
import { POST as queryLogs } from "../src/portal/app/api/audit/logs/route"
import { NextRequest } from "../src/main/api/next-server-shim"

interface AuditCall {
  tenantId: string
  user: { id: string; email: string; name: string }
  logEntry: CreateAuditLogInput
}

function setup(options: { backup?: "ok" | "fail" | "no-start" } = {}) {
  const deps = fakeDeps({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro" } })
  const tenant = new FakeTenant(TENANT_A)
  wire(deps, [tenant, new FakeTenant(TENANT_B)], options)
  const audit: AuditCall[] = []
  const api = deps.api
  deps.api = async (path, tenantId, body = {}) => {
    if (path === "/api/audit/log") {
      audit.push({ tenantId, user: body.user as AuditCall["user"], logEntry: body.logEntry as CreateAuditLogInput })
      return Response.json({ success: true })
    }
    return api(path, tenantId, body)
  }
  return { deps, tenant, audit }
}

/** One create operation from the promotion workflow, approved and ready to apply. */
async function approvedCreate(context: ReturnType<typeof setup>) {
  const record = await createChangeSet(context.deps, TENANT_A, {
    title: "Promote firewall policy",
    origin: { workflow: "promotion", recordId: "promotion-1" },
    operations: [{ folder: "ConfigurationPolicies", action: "create", proposed: { name: "New firewall policy", platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings: [setting("vendor_msft_firewall_enable", "vendor_msft_firewall_enable_true")] } }],
  }, "Admin")
  const preview = await previewChangeSet(context.deps, TENANT_A, record.id)
  await approveChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, targetFingerprint: preview.targetFingerprint, reviewer: "Reviewer" }, "Admin")
  return { record, preview }
}

afterEach(() => { vi.unstubAllGlobals(); setAuditOutboxStore(undefined) })

describe("change set audit entries", () => {
  it("records one entry per apply and per rollback with origin, tenant, outcome and counts", async () => {
    const context = setup()
    const { record, preview } = await approvedCreate(context)
    const applied = await applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")
    expect(applied.status).toBe("applied")
    expect(context.audit).toHaveLength(1)
    expect(context.audit[0]!.tenantId).toBe(TENANT_A)
    expect(context.audit[0]!.user).toEqual({ id: "admin@contoso.test", email: "admin@contoso.test", name: "Admin" })
    expect(context.audit[0]!.logEntry).toMatchObject({
      eventType: AuditEventType.CHANGE_SET_APPLIED,
      action: "Apply change set",
      resource: { type: "policy", id: record.id, name: "Promote firewall policy" },
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.INFO,
      details: {
        workflow: "promotion", originRecordId: "promotion-1", changeSetId: record.id, kind: "change", rollbackOf: null,
        status: "applied", attempt: 1, operations: 1, verified: 1, failed: 0, uncertain: 0, pending: 0, created: 1, updated: 0, deleted: 0,
      },
    })

    const rollback = await createRollbackChangeSet(context.deps, TENANT_A, record.id, {}, "Admin")
    const rollbackPreview = await previewChangeSet(context.deps, TENANT_A, rollback.id)
    await approveChangeSet(context.deps, TENANT_A, rollback.id, { contentHash: rollbackPreview.contentHash, targetFingerprint: rollbackPreview.targetFingerprint }, "Admin")
    const rolledBack = await applyChangeSet(context.deps, TENANT_A, rollback.id, { contentHash: rollbackPreview.contentHash, confirmed: true }, "Admin")
    expect(rolledBack.status).toBe("applied")
    expect(context.audit).toHaveLength(2)
    expect(context.audit[1]!.logEntry).toMatchObject({
      eventType: AuditEventType.CHANGE_SET_ROLLED_BACK,
      action: "Roll back change set",
      resource: { type: "policy", id: rollback.id },
      result: AuditResult.SUCCESS,
      details: {
        workflow: "promotion", changeSetId: rollback.id, kind: "rollback", rollbackOf: record.id,
        status: "applied", operations: 1, verified: 1, failed: 0, created: 0, updated: 0, deleted: 1,
      },
    })
  })

  it("records a failed apply as a failure, not as success", async () => {
    const context = setup()
    const { record, preview } = await approvedCreate(context)
    context.tenant.failWrite = () => 400
    const applied = await applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin") as ChangeSetRecord
    expect(applied.status).toBe("failed")
    expect(context.audit).toHaveLength(1)
    expect(context.audit[0]!.logEntry).toMatchObject({
      eventType: AuditEventType.CHANGE_SET_APPLIED,
      result: AuditResult.FAILURE,
      severity: AuditSeverity.ERROR,
      details: { workflow: "promotion", status: "failed", operations: 1, verified: 0, failed: 1, created: 0 },
    })
  })

  it("records a partial apply as partial with both counts", async () => {
    const context = setup()
    const create = (name: string) => ({ folder: "ConfigurationPolicies", action: "create" as const, proposed: { name, platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings: [setting("vendor_msft_firewall_enable", "vendor_msft_firewall_enable_true")] } })
    const record = await createChangeSet(context.deps, TENANT_A, {
      title: "Deploy two policies",
      origin: { workflow: "custom-baseline", recordId: "deployment-1" },
      operations: [create("First policy"), create("Second policy")],
    }, "Admin")
    const preview = await previewChangeSet(context.deps, TENANT_A, record.id)
    await approveChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, targetFingerprint: preview.targetFingerprint }, "Admin")
    context.tenant.failWrite = (_method, _path, count) => (count === 2 ? 400 : undefined)
    const applied = await applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")
    expect(applied.status).toBe("partial")
    expect(context.audit).toHaveLength(1)
    expect(context.audit[0]!.logEntry).toMatchObject({
      eventType: AuditEventType.CHANGE_SET_APPLIED,
      result: AuditResult.PARTIAL,
      severity: AuditSeverity.WARNING,
      details: { workflow: "custom-baseline", status: "partial", operations: 2, verified: 1, failed: 1, created: 1 },
    })
  })

  it("records an apply that stops before writing as a failure with the error", async () => {
    const context = setup({ backup: "fail" })
    const { record, preview } = await approvedCreate(context)
    await expect(applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")).rejects.toThrow(/nothing was written/)
    expect(context.tenant.writeCount()).toBe(0)
    expect(context.audit).toHaveLength(1)
    expect(context.audit[0]!.logEntry).toMatchObject({
      result: AuditResult.FAILURE,
      severity: AuditSeverity.ERROR,
      details: { workflow: "promotion", status: "failed", operations: 1, verified: 0, failed: 0, pending: 1 },
    })
    expect(context.audit[0]!.logEntry.details?.error?.code).toBe("CHANGE_SET_APPLY_FAILED")
    expect(context.audit[0]!.logEntry.details?.error?.message).toContain("nothing was written")
  })

  it("records an uncertain apply as partial with the uncertain count", async () => {
    const context = setup()
    const { record, preview } = await approvedCreate(context)
    // The create is applied but its response is lost, so the outcome stays uncertain.
    context.tenant.failWrite = (method) => (method === "POST" ? "lost" : undefined)
    const applied = await applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")
    expect(applied.status).toBe("uncertain")
    expect(context.audit).toHaveLength(1)
    expect(context.audit[0]!.logEntry).toMatchObject({
      result: AuditResult.PARTIAL,
      severity: AuditSeverity.WARNING,
      details: { status: "uncertain", operations: 1, verified: 0, failed: 0, uncertain: 1, created: 0 },
    })
  })

  it("records a failure entry when the apply throws after writing", async () => {
    const context = setup()
    const { record, preview } = await approvedCreate(context)
    const update = context.deps.records.update.bind(context.deps.records)
    context.deps.records.update = ((domain: string, tenantId: string, id: string, change: never, meta: { actor: string | null; reason: string }) => {
      if (meta.reason.startsWith("Apply finished")) throw new Error("Record store unavailable")
      return update(domain, tenantId, id, change, meta)
    }) as typeof context.deps.records.update
    await expect(applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")).rejects.toThrow(/Record store unavailable/)
    expect([...context.tenant.policies.values()].some((policy) => policy.name === "New firewall policy")).toBe(true)
    expect(context.audit).toHaveLength(1)
    expect(context.audit[0]!.logEntry).toMatchObject({
      result: AuditResult.FAILURE,
      severity: AuditSeverity.ERROR,
      details: { status: "failed", attempt: 1, operations: 1, verified: 1, created: 1 },
    })
    expect(context.audit[0]!.logEntry.details?.error?.message).toContain("Record store unavailable")
  })

  it("keeps the apply outcome when the audit write itself fails", async () => {
    const context = setup()
    const { record, preview } = await approvedCreate(context)
    const api = context.deps.api
    context.deps.api = async (path, tenantId, body = {}) => path === "/api/audit/log" ? Response.json({ error: "Storage unavailable" }, { status: 500 }) : api(path, tenantId, body)
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const applied = await applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")
      expect(applied.status).toBe("applied")
      expect([...context.tenant.policies.values()].some((policy) => policy.name === "New firewall policy")).toBe(true)
      expect(errors.mock.calls.some(([message]) => String(message).includes("[audit] Failed to record change set apply"))).toBe(true)
    } finally {
      errors.mockRestore()
    }
  })

  it("flows through the audit list and export routes next to existing stored entries", async () => {
    const context = setup()
    const { record, preview } = await approvedCreate(context)
    await applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")
    expect(context.audit).toHaveLength(1)

    // Build the stored entry the way /api/audit/log does, then read it back through the
    // list and export routes together with an entry of an older event type.
    const call = context.audit[0]!
    const logger = await createAuditLogger("change-set-audit-test", "", { ...call.user, tenantId: TENANT_A })
    const stored = await logger.queue(call.logEntry)
    expect(pendingEvents("change-set-audit-test").map((entry) => entry.id)).toEqual([stored.id])
    const legacy: AuditLogEntry = {
      id: "legacy-1", timestamp: stored.timestamp, eventType: AuditEventType.BACKUP_COMPLETED, severity: AuditSeverity.INFO,
      user: { ...call.user, tenantId: TENANT_A }, action: "Scheduled backup",
      resource: { type: "backup", id: "backup-1", name: "Backup" }, result: AuditResult.SUCCESS,
      context: { ipAddress: "unknown", userAgent: "desktop" },
    }
    const entries = [stored, legacy]
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "storage-token" })
      if (url.searchParams.get("comp") === "list") return new Response("<Blobs><Blob><Name>day.json</Name></Blob></Blobs><NextMarker></NextMarker>")
      return Response.json({ entries })
    }))
    const at = new Date(stored.timestamp).getTime()
    const filter = { startDate: new Date(at - 3600_000), endDate: new Date(at + 3600_000) }
    const body = (extra: object) => JSON.stringify({ tenantId: TENANT_A, appId: "app", clientSecret: "test", storageAccountName: "store", ...extra })

    const listed = await queryLogs(new NextRequest("http://tenuvault.internal/api/audit/logs", { method: "POST", body: body({ filter }) }))
    expect(listed.status).toBe(200)
    const listedJson = await listed.json()
    expect(listedJson.data.map((entry: AuditLogEntry) => entry.id).sort()).toEqual([stored.id, "legacy-1"].sort())
    expect(listedJson.data.find((entry: AuditLogEntry) => entry.id === stored.id)).toMatchObject({ eventType: "CHANGE_SET_APPLIED", action: "Apply change set", result: "SUCCESS" })

    const filtered = await queryLogs(new NextRequest("http://tenuvault.internal/api/audit/logs", { method: "POST", body: body({ filter: { ...filter, eventTypes: [AuditEventType.CHANGE_SET_APPLIED] } }) }))
    expect((await filtered.json()).data.map((entry: AuditLogEntry) => entry.id)).toEqual([stored.id])

    const exported = await exportLogs(new NextRequest("http://tenuvault.internal/api/audit/export", { method: "POST", body: body({ exportOptions: { format: "json", filter, includeDetails: true } }) }))
    expect(exported.status).toBe(200)
    const exportedJson = await exported.json()
    expect(exportedJson.logs.map((entry: AuditLogEntry) => entry.id).sort()).toEqual([stored.id, "legacy-1"].sort())
    expect(exportedJson.logs.find((entry: AuditLogEntry) => entry.id === stored.id).details).toMatchObject({ workflow: "promotion", verified: 1 })

    const csv = await (await exportLogs(new NextRequest("http://tenuvault.internal/api/audit/export", { method: "POST", body: body({ exportOptions: { format: "csv", filter } }) }))).text()
    expect(csv).toContain("Apply change set")
    expect(csv).toContain("CHANGE_SET_APPLIED")
  })
})
