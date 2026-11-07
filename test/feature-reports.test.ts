import { describe, expect, it } from "vitest"
import { afterScheduledBackup, MAX_AUDIT_EVENTS, MAX_REPORTS, readAudit, retentionStart, routes } from "../src/main/features/reports"
import { DOMAINS } from "../src/main/features/domains"
import type { Drift, DriftResult } from "../src/shared/intune/drift"
import { call, fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"

const PATH = "/api/reports"
const PDF = Buffer.from("%PDF-1.7 fake report")

function driftResult(comparison = "backup-2026-11-06-020000"): DriftResult {
  const drift = {
    id: "d1", tenant: "", tenantId: "", severity: "warning", type: "Settings Catalog policy", configName: "Defender", configId: "p-1", changeType: "modified",
    detectedAt: "", fromBackup: "backup-2026-11-05-020000", toBackup: comparison, description: "", impact: "", affectedPolicies: 1, affectedDevices: 0,
    changes: [{ field: "passwordMinimumLength", oldValue: 8, newValue: 12 }],
  } as Drift
  return {
    drifts: [drift],
    summary: { total: 1, critical: 0, warning: 1, info: 0, added: 0, modified: 1, deleted: 0, affectedTenants: 1 },
    lastScan: "2026-11-06T07:00:00Z",
    backupsAnalyzed: 2,
    baseline: { id: "backup-2026-11-05-020000", timestamp: "2026-11-05T02:00:00.000Z", trigger: "scheduled", status: "Success" },
    comparison: { id: comparison, timestamp: "2026-11-06T02:00:00.000Z", trigger: "scheduled", status: "Success" },
    warnings: [],
    stats: { compared: 1, unchanged: 10 },
  }
}

function world(options: { drift?: DriftResult | { status: number; error: string }; auditStatus?: number; pdf?: Buffer; mailStatus?: number } = {}) {
  const apiCalls: Array<{ path: string; body: Record<string, unknown> | undefined }> = []
  const graphCalls: Array<{ method: string; path: string; body: any }> = []
  const deps = fakeDeps({
    plans: { [TENANT_A]: "pro", [TENANT_B]: "community" },
    now: () => new Date("2026-11-06T07:05:00Z"),
    api: async (path, _tenant, body) => {
      apiCalls.push({ path, body })
      const drift = options.drift ?? driftResult()
      if ("error" in drift) return Response.json({ error: drift.error }, { status: drift.status })
      return Response.json(drift)
    },
    graph: (() => async (method: string, path: string, body?: unknown) => {
      graphCalls.push({ method, path, body })
      if (path.startsWith("deviceManagement/auditEvents")) {
        if (options.auditStatus) return { status: options.auditStatus, body: { error: { message: "Forbidden" } } }
        return { status: 200, body: { value: [{ id: "a1", activityDateTime: "2026-11-05T10:00:00Z", activity: "Patch DeviceManagementConfigurationPolicy", activityOperationType: "Patch", activityResult: "Success", category: "DeviceConfiguration", actor: { userPrincipalName: "admin@contoso.test" }, resources: [{ displayName: "Defender", resourceId: "p-1" }] }] } }
      }
      if (path === "me/sendMail") return { status: options.mailStatus ?? 202, body: options.mailStatus ? { error: { message: "Access denied" } } : {} }
      return { status: 404, body: {} }
    }) as never,
    printPdf: async () => new Uint8Array(options.pdf ?? PDF),
  })
  return { deps, routes: routes(deps), apiCalls, graphCalls }
}

async function generate(w: ReturnType<typeof world>, body: Record<string, unknown> = {}) {
  const response = await call(w.routes, PATH, { tenantId: TENANT_A, action: "generate", ...body })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body.report as { id: string; counts: Record<string, number> }
}

describe("change reports route", () => {
  it("compares the backups with documented items, reads the audit window and stores the report", async () => {
    const w = world()
    const report = await generate(w, { baseline: "backup-2026-11-05-020000", comparison: "backup-2026-11-06-020000" })
    expect(w.apiCalls).toEqual([{ path: "/api/detect-drifts", body: { baseline: "backup-2026-11-05-020000", comparison: "backup-2026-11-06-020000", documentItems: true } }])
    const audit = decodeURIComponent(w.graphCalls[0]!.path)
    expect(audit).toContain("activityDateTime gt 2026-11-05T02:00:00.000Z and activityDateTime le 2026-11-06T02:00:00.000Z")
    // No Conditional Access item, so the Entra log (an optional permission) is not read.
    expect(w.graphCalls.some((entry) => entry.path.startsWith("auditLogs/"))).toBe(false)
    expect(report.counts).toMatchObject({ modified: 1, attributed: 1 })
    const status = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })
    expect(status.body.reports).toHaveLength(1)
    const full = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-report", reportId: report.id })
    expect(full.body.report.items[0].activity[0]).toMatchObject({ who: "admin@contoso.test", change: "updated" })
    expect(full.body.report.items[0].settings[0]).toMatchObject({ name: "Password minimum length", before: "8", after: "12" })
  })

  it("asks for both backups or neither", async () => {
    const w = world()
    const response = await call(w.routes, PATH, { tenantId: TENANT_A, action: "generate", baseline: "backup-2026-11-05-020000" })
    expect(response.status).toBe(400)
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "generate", baseline: "../etc", comparison: "backup-2026-11-06-020000" })).status).toBe(400)
  })

  it("passes on why the backups could not be compared", async () => {
    const w = world({ drift: { status: 409, error: "Drift comparison needs two complete backups." } })
    const response = await call(w.routes, PATH, { tenantId: TENANT_A, action: "generate" })
    expect(response).toEqual({ status: 409, body: { error: "Drift comparison needs two complete backups." } })
  })

  it("says when the Conditional Access audit log was cut short", async () => {
    const entra = (index: number) => ({ id: `x${index}`, activityDateTime: "2026-11-05T10:00:00Z", activityDisplayName: "Update conditional access policy", operationType: "Update", result: "success", loggedByService: "Conditional Access", targetResources: [{ id: "ca-1", displayName: "CA001" }] })
    const deps = fakeDeps({
      graph: (() => async (_method: string, path: string) => path.startsWith("auditLogs/")
        ? { status: 200, body: { value: Array.from({ length: MAX_AUDIT_EVENTS + 1 }, (_, index) => entra(index)) } }
        : { status: 200, body: { value: [] } }) as never,
    })
    const drift = driftResult()
    drift.drifts[0]!.type = "Conditional Access policies"
    const audit = await readAudit(deps, TENANT_A, drift)
    expect(audit).toMatchObject({ note: `More than ${MAX_AUDIT_EVENTS} Conditional Access audit events in this window; not all of them were read, so some changes may have no actors.` })
    expect("changes" in audit && audit.changes).toHaveLength(MAX_AUDIT_EVENTS)
  })

  it("reads the audit log without ordering and follows empty pages to the events, as Graph pages through its partitions", async () => {
    const paths: string[] = []
    const deps = fakeDeps({
      graph: (() => async (_method: string, path: string) => {
        paths.push(path)
        const page = paths.length
        if (page < 35) return { status: 200, body: { value: [], "@odata.nextLink": `https://graph.microsoft.com/beta/deviceManagement/auditEvents?$skiptoken=${page}` } }
        return { status: 200, body: { value: [{ id: "a1", activityDateTime: "2026-11-05T10:00:00Z", activity: "Patch", activityOperationType: "Patch", activityResult: "Success", actor: { userPrincipalName: "admin@contoso.test" }, resources: [{ displayName: "Defender", resourceId: "p-1" }] }] } }
      }) as never,
    })
    const audit = await readAudit(deps, TENANT_A, driftResult())
    expect(decodeURIComponent(paths[0]!)).not.toContain("$orderby")
    expect(paths).toHaveLength(35)
    expect(audit).toMatchObject({ note: null })
    expect("changes" in audit && audit.changes.map((change) => change.resourceId)).toEqual(["p-1"])
  })

  it("reads Conditional Access changes Entra still keeps when the window starts before its retention", async () => {
    const filters: string[] = []
    const deps = fakeDeps({
      graph: (() => async (_method: string, path: string) => {
        if (!path.startsWith("auditLogs/")) return { status: 200, body: { value: [] } }
        const filter = decodeURIComponent(path)
        filters.push(filter)
        if (filter.includes("gt 2026-11-05T02:00:00.000Z")) return { status: 400, body: { error: { code: "UnknownError", message: "Specified argument was out of the range of valid values. (Parameter 'Minimum allowed time for activityDateTime is 11/5/2026 12:00:00 PM')" } } }
        return { status: 200, body: { value: [] } }
      }) as never,
    })
    const drift = driftResult()
    drift.drifts[0]!.type = "Conditional Access policies"
    const audit = await readAudit(deps, TENANT_A, drift)
    expect(filters[1]).toContain("activityDateTime gt 2026-11-05T12:00:00.000Z and activityDateTime le 2026-11-06T02:00:00.000Z")
    expect(audit).toMatchObject({ note: "Entra keeps Conditional Access audit events only since 2026-11-05, so earlier Conditional Access changes have no actors." })
    expect(retentionStart("Minimum allowed time for activityDateTime is 10/6/2026 12:00:00 AM")).toBe("2026-10-06T00:00:00.000Z")
    expect(retentionStart("Something else")).toBeNull()
  })

  it("turns a throttled audit read with a raw proxy error into one plain sentence", async () => {
    const deps = fakeDeps({
      graph: (() => async () => ({ status: 429, body: { error: { message: `{ "_version": 3, "Message": "An error has occurred - Operation ID: 00000000 - Url: https://proxy.example.test/StatelessAuditingFEService/tenant-id/deviceManagement/auditEvents?$filter=activityDateTime", "RetryAfter": null }` } } })) as never,
    })
    const audit = await readAudit(deps, TENANT_A, driftResult())
    expect(audit).toEqual({ error: "The Intune audit log could not be read: Microsoft Graph throttled the request (429). Generate the report again in a few minutes." })
  })

  it("keeps the report without actors when the audit log is closed", async () => {
    const w = world({ auditStatus: 403 })
    const report = await generate(w)
    const full = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-report", reportId: report.id })
    expect(full.body.report.audit.status).toBe("unavailable")
    expect(full.body.report.audit.note).toMatch(/403/)
  })

  it("exports PDF, Markdown and JSON", async () => {
    const w = world()
    const report = await generate(w)
    const pdf = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-export", reportId: report.id, format: "pdf" })
    expect(pdf.body).toMatchObject({ fileName: "change-report-tenant-1111-2026-11-06.pdf", encoding: "base64" })
    expect(Buffer.from(pdf.body.data, "base64").subarray(0, 5).toString()).toBe("%PDF-")
    const markdown = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-export", reportId: report.id, format: "markdown" })
    expect(markdown.body.data).toContain("# Changes in Tenant 1111")
    const json = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-export", reportId: report.id, format: "json" })
    expect(JSON.parse(json.body.data).schemaVersion).toBe(1)
  })

  it("sends the report with the PDF attached and records the send", async () => {
    const w = world()
    const report = await generate(w)
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "send", reportId: report.id })).status).toBe(400)
    const saved = await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", recipients: [{ type: "address", address: "auditor@fabrikam.test" }] })
    expect(saved.body.settings.recipients).toEqual([{ type: "address", address: "auditor@fabrikam.test" }])
    const sent = await call(w.routes, PATH, { tenantId: TENANT_A, action: "send", reportId: report.id })
    expect(sent.status).toBe(200)
    const mail = w.graphCalls.find((entry) => entry.path === "me/sendMail")!.body
    expect(mail.message.toRecipients).toEqual([{ emailAddress: { address: "auditor@fabrikam.test" } }])
    // A warning prefix only for deletions or critical changes.
    expect(mail.message.subject).toBe("TenuVault: Changes in Tenant 1111, 5 Nov 2026 to 6 Nov 2026")
    expect(mail.message.attachments[0]).toMatchObject({ name: "change-report-tenant-1111-2026-11-06.pdf", contentType: "application/pdf" })
    expect(Buffer.from(mail.message.attachments[0].contentBytes, "base64").equals(PDF)).toBe(true)
    // The send is recorded in the tenant's audit log through the app's audit route.
    expect(w.apiCalls.find((entry) => entry.path === "/api/audit/log")?.body).toMatchObject({ logEntry: { eventType: "REPORT_SENT", action: "Send change report", details: { recipients: 1, attachment: "pdf", automatic: false } } })
    const status = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })
    expect(status.body.reports[0].lastSend).toMatchObject({ ok: true, recipients: 1, attachment: "pdf" })
  })

  it("attaches Markdown instead of a PDF too large for one request", async () => {
    const w = world({ pdf: Buffer.concat([PDF, Buffer.alloc(3_000_000)]) })
    const report = await generate(w)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", recipients: [{ type: "address", address: "auditor@fabrikam.test" }] })
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "send", reportId: report.id })
    const mail = w.graphCalls.find((entry) => entry.path === "me/sendMail")!.body
    expect(mail.message.attachments[0].name).toMatch(/\.md$/)
    expect(mail.message.body.content).toContain("The PDF was too large to attach")
  })

  it("says the PDF could not be created, without the error text, when printing fails", async () => {
    const w = world()
    w.deps.printPdf = async () => { throw new Error("ENOENT /tmp/tenuvault-report-abc/report.html") }
    const report = await generate(w)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", recipients: [{ type: "address", address: "auditor@fabrikam.test" }] })
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "send", reportId: report.id })
    const mail = w.graphCalls.find((entry) => entry.path === "me/sendMail")!.body
    expect(mail.message.attachments[0].name).toMatch(/\.md$/)
    expect(mail.message.body.content).toContain("The PDF could not be created, so the report is attached as Markdown.")
    expect(mail.message.body.content).not.toContain("ENOENT")
  })

  it("reports a failed send without hiding it", async () => {
    const w = world({ mailStatus: 403 })
    const report = await generate(w)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", recipients: [{ type: "address", address: "auditor@fabrikam.test" }] })
    const sent = await call(w.routes, PATH, { tenantId: TENANT_A, action: "send", reportId: report.id })
    expect(sent.status).toBe(502)
    expect(sent.body.error).toMatch(/403: Access denied/)
  })

  it("validates settings", async () => {
    const w = world()
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", recipients: [{ type: "address", address: "not an address" }] })).status).toBe(400)
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", attachment: "docx" })).status).toBe(400)
    const saved = await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", afterScheduledBackup: true, includeValues: false, attachment: "markdown" })
    expect(saved.body.settings).toMatchObject({ afterScheduledBackup: true, includeValues: false, includeActors: true, attachment: "markdown", skipEmpty: true })
  })

  it("keeps the newest reports only", async () => {
    const w = world()
    for (let index = 0; index < MAX_REPORTS + 2; index++) await generate(w)
    expect(w.deps.records.list(DOMAINS.changeReports, TENANT_A)).toHaveLength(MAX_REPORTS)
  })

  it("needs Pro to generate, while stored reports stay readable", async () => {
    const w = world()
    const generated = await call(w.routes, PATH, { tenantId: TENANT_B, action: "generate" })
    expect(generated.status).toBe(402)
    expect(generated.body.upgrade).toBe("changeReports")
    expect((await call(w.routes, PATH, { tenantId: TENANT_B, action: "get-status" })).status).toBe(200)
  })
})

describe("reports after scheduled backups", () => {
  const recipients = [{ type: "address", address: "auditor@fabrikam.test" }]

  it("does nothing unless the tenant asked for it", async () => {
    const w = world()
    await afterScheduledBackup(w.deps, TENANT_A, "backup-2026-11-06-020000")
    expect(w.apiCalls).toHaveLength(0)
  })

  it("reports and sends once per backup", async () => {
    const w = world()
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", afterScheduledBackup: true, recipients })
    await afterScheduledBackup(w.deps, TENANT_A, "backup-2026-11-06-020000")
    await afterScheduledBackup(w.deps, TENANT_A, "backup-2026-11-06-020000")
    expect(w.apiCalls.filter((entry) => entry.path === "/api/detect-drifts")).toHaveLength(1)
    expect(w.graphCalls.filter((entry) => entry.path === "me/sendMail")).toHaveLength(1)
    const status = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })
    expect(status.body.settings.lastAutomatic).toMatchObject({ outcome: "sent", backup: "backup-2026-11-06-020000" })
    expect(status.body.reports[0]).toMatchObject({ trigger: "scheduled", lastSend: { ok: true, automatic: true } })
  })

  it("compares exactly the scheduled backup with the complete backup before it", async () => {
    const w = world()
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", afterScheduledBackup: true, recipients })
    await afterScheduledBackup(w.deps, TENANT_A, "backup-2026-11-06-020000")
    expect(w.apiCalls[0]).toEqual({ path: "/api/detect-drifts", body: { comparison: "backup-2026-11-06-020000", documentItems: true } })
  })

  it("skips a backup that completed with warnings, without saving or sending a report", async () => {
    const w = world({ drift: { status: 409, error: "Backup backup-2026-11-06-020000 did not complete without warnings, so it is not compared." } })
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", afterScheduledBackup: true, recipients })
    await afterScheduledBackup(w.deps, TENANT_A, "backup-2026-11-06-020000")
    const status = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })
    expect(status.body.settings.lastAutomatic).toMatchObject({ outcome: "skipped", message: expect.stringContaining("did not complete without warnings") })
    expect(status.body.reports).toHaveLength(0)
    expect(w.graphCalls.some((entry) => entry.path === "me/sendMail")).toBe(false)
  })

  it("sends nothing when nothing changed and skipEmpty is on", async () => {
    const empty = { ...driftResult(), drifts: [] }
    const w = world({ drift: empty })
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", afterScheduledBackup: true, recipients })
    await afterScheduledBackup(w.deps, TENANT_A, "backup-2026-11-06-020000")
    const status = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })
    expect(status.body.settings.lastAutomatic).toMatchObject({ outcome: "skipped", message: "Nothing changed, so no report was sent." })
    expect(w.graphCalls.some((entry) => entry.path === "me/sendMail")).toBe(false)
  })

  it("never throws when the outcome itself cannot be recorded", async () => {
    const w = world({ drift: { status: 500, error: "Storage unreachable" } })
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", afterScheduledBackup: true, recipients })
    const update = w.deps.records.update.bind(w.deps.records)
    w.deps.records.update = (() => { throw new Error("The app store is locked") }) as typeof update
    await expect(afterScheduledBackup(w.deps, TENANT_A, "backup-2026-11-06-020000")).resolves.toBeUndefined()
  })

  it("records a failure instead of throwing", async () => {
    const w = world({ drift: { status: 500, error: "Storage unreachable" } })
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "save-settings", afterScheduledBackup: true, recipients })
    await expect(afterScheduledBackup(w.deps, TENANT_A, "backup-2026-11-06-020000")).resolves.toBeUndefined()
    const status = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })
    expect(status.body.settings.lastAutomatic).toMatchObject({ outcome: "failed", message: "Storage unreachable" })
  })
})
