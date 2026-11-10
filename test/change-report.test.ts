import { describe, expect, it } from "vitest"
import { buildChangeReport, changeReportJson, changeReportMarkdown, describeAssignment, describeValue, publicAuditNote, reportFileName, reportTitle, summaryLine, type ReportAudit } from "../src/shared/reports/change-report"
import { buildChangeReportDocument } from "../src/shared/reports/change-report-html"
import { documentItem, redactedChanges } from "../src/portal/app/api/detect-drifts/route"
import { mapAuditEvent } from "../src/shared/notifications/audit"
import { mapEntraAuditEvent } from "../src/shared/notifications/entra"
import type { Drift, DriftResult } from "../src/shared/intune/drift"
import { periodPair, parseAddresses } from "../src/renderer/features/reports/api"
import type { BackupSummary } from "../src/portal/components/backup/types"

const TENANT = "11111111-1111-1111-1111-111111111111"

const base = { tenant: "Current Tenant", tenantId: "current-tenant", detectedAt: "2026-11-06T07:00:00Z", fromBackup: "backup-2026-11-05-020000", toBackup: "backup-2026-11-06-020000", description: "", impact: "", affectedPolicies: 1, affectedDevices: 0 }

function drift(overrides: Partial<Drift>): Drift {
  return { id: `drift-${Math.random()}`, severity: "info", type: "Settings Catalog policy", configName: "Policy", configId: "id", changeType: "modified", ...base, ...overrides } as Drift
}

function result(drifts: Drift[]): DriftResult {
  return {
    drifts,
    summary: { total: drifts.length, critical: 0, warning: 0, info: 0, added: 0, modified: 0, deleted: 0, affectedTenants: 1 },
    lastScan: "2026-11-06T07:00:00Z",
    backupsAnalyzed: 2,
    baseline: { id: "backup-2026-11-05-020000", timestamp: "2026-11-05T02:00:00.000Z", trigger: "scheduled", status: "Success" },
    comparison: { id: "backup-2026-11-06-020000", timestamp: "2026-11-06T02:00:00.000Z", trigger: "scheduled", status: "Success" },
    warnings: [],
    stats: { compared: drifts.length, unchanged: 0 },
    settingNames: { settings: { device_vendor_msft_policy_config_defender_allowcloudprotection: "Allow Cloud Protection" }, options: { device_vendor_msft_policy_config_defender_allowcloudprotection_1: "Allowed" } },
  }
}

const options = { tenantId: TENANT, tenantName: "Contoso", generatedAt: "2026-11-06T07:05:00Z", trigger: "manual" as const, includeValues: true, includeActors: true }

function auditEvent(id: string, at: string, resourceId: string | null, name: string | null, upn = "admin@contoso.test", operation = "Patch") {
  return { ...mapAuditEvent({ id, activityDateTime: at, activity: `${operation} DeviceManagementConfigurationPolicy`, activityOperationType: operation, activityResult: "Success", category: "DeviceConfiguration", actor: { userPrincipalName: upn }, resources: [{ displayName: name, resourceId, type: "DeviceManagementConfigurationPolicy" }] })!, source: "Intune" }
}

describe("change report model", () => {
  const drifts = [
    drift({ configId: "p-1", configName: "Defender", changes: [{ field: "settings[device_vendor_msft_policy_config_defender_allowcloudprotection].settingInstance.choiceSettingValue.value", oldValue: "device_vendor_msft_policy_config_defender_allowcloudprotection_0", newValue: "device_vendor_msft_policy_config_defender_allowcloudprotection_1" }] }),
    drift({ configId: "p-2", configName: "Old policy", changeType: "deleted", severity: "warning", changes: [{ field: "passwordMinimumLength", oldValue: 8, newValue: undefined }, { field: "displayName", oldValue: "Old policy", newValue: undefined }] }),
    drift({ configId: "p-3", configName: "New profile", changeType: "added", changes: [{ field: "assignments[0]", oldValue: undefined, newValue: { target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "g-1" } } }] }),
  ]
  const audit: ReportAudit = {
    changes: [
      auditEvent("a1", "2026-11-05T10:00:00Z", "p-1", "Defender"),
      auditEvent("a2", "2026-11-05T11:00:00Z", null, "Old policy", "other@contoso.test", "Delete"),
      auditEvent("a3", "2026-11-05T12:00:00Z", "x-9", "Undone change"),
    ],
  }

  it("matches audit events to items by ID, by name only when the event names no ID, and keeps the rest as other activity", () => {
    const report = buildChangeReport(result(drifts), audit, options)
    expect(report.items.map((item) => [item.change, item.name, item.activity.map((event) => event.who)])).toEqual([
      ["deleted", "Old policy", ["other@contoso.test"]],
      ["modified", "Defender", ["admin@contoso.test"]],
      ["added", "New profile", []],
    ])
    expect(report.otherActivity).toEqual([expect.objectContaining({ target: "Undone change", who: "admin@contoso.test" })])
    expect(report.summary).toEqual({ added: 1, modified: 1, deleted: 1, critical: 0, attributed: 2 })
    expect(summaryLine(report)).toBe("1 changed, 1 added, 1 deleted; 2 of 3 with matching audit events.")
  })

  it("shows readable setting names and values, and leaves the item name out of a documented item", () => {
    const report = buildChangeReport(result(drifts), audit, options)
    const defender = report.items.find((item) => item.name === "Defender")!
    expect(defender.settings).toEqual([expect.objectContaining({ name: "Allow Cloud Protection", before: "0", after: "Allowed" })])
    const deleted = report.items.find((item) => item.change === "deleted")!
    expect(deleted.settings.map((setting) => [setting.name, setting.before, setting.after])).toEqual([["Password minimum length", "8", null]])
    expect(deleted.restoreFrom).toBe("backup-2026-11-05-020000")
    const added = report.items.find((item) => item.change === "added")!
    expect(added.settings[0]!.after).toBe("Included group g-1")
  })

  it("leaves values and actors out when asked", () => {
    const report = buildChangeReport(result(drifts), audit, { ...options, includeValues: false, includeActors: false })
    expect(report.items.flatMap((item) => item.settings).every((setting) => setting.before === null && setting.after === null)).toBe(true)
    expect(report.items.flatMap((item) => item.activity).every((event) => event.who === null)).toBe(true)
    expect(report.audit.actors).toBe(false)
    expect(changeReportMarkdown(report)).not.toContain("admin@contoso.test")
    expect(changeReportMarkdown(report)).toContain("Setting values are left out")
  })

  it("says who is unknown when the audit log could not be read", () => {
    const report = buildChangeReport(result(drifts), { error: "Microsoft Graph returned 403." }, options)
    expect(report.audit).toEqual({ status: "unavailable", note: "Microsoft Graph returned 403.", actors: true })
    expect(summaryLine(report)).toBe("1 changed, 1 added, 1 deleted. Who made them is unknown: the audit log could not be read.")
  })

  it("never stores or exports a raw Graph error as the audit note", () => {
    const raw = `The Intune audit log could not be read: Microsoft Graph returned 429: { "_version": 3, "Message": "An error has occurred - Operation ID (for customer support): 00000000-0000-0000-0000-000000000000 - Activity ID: 29bdbd1d - Url: https://proxy.amsub0502.manage.microsoft.com/StatelessAuditingFEService/98cf933b/deviceManagement/auditEvents?api-version=5022-08-30&$filter=activityDateTime", "CustomApiErrorPhrase": "", "RetryAfter": null, "ErrorSourceService": "", "HttpHeaders": "{}" }`
    const report = buildChangeReport(result(drifts), { error: raw }, options)
    expect(report.audit.note).toBe("Microsoft Graph throttled the audit log request (429). Generate the report again in a few minutes.")
    expect(changeReportMarkdown(report)).not.toContain("proxy.")
    expect(buildChangeReportDocument({ ...report, audit: { ...report.audit, note: raw } }).html).not.toContain("proxy.")
    expect(publicAuditNote("Your account needs an Intune role that can read audit logs.")).toBe("Your account needs an Intune role that can read audit logs.")
    expect(publicAuditNote(null)).toBeNull()
  })

  it("cleans short prefixed raw errors and the JSON export of a stored report", () => {
    expect(publicAuditNote(`The Intune audit log could not be read: Microsoft Graph returned 500: {"error":"bad","tenantId":"98cf933b-ffff-9653-1071-110617354693"}`)).toBe("Microsoft Graph returned 500.")
    expect(publicAuditNote("Could not read the log for tenant 98cf933b-ffff-9653-1071-110617354693 today.")).toBe("The audit log could not be read.")
    const legacy = buildChangeReport(result(drifts), { changes: [] }, options)
    const stored = { ...legacy, audit: { status: "unavailable" as const, actors: true, note: `The Intune audit log could not be read: Microsoft Graph returned 503: {"error":"x","tenantId":"98cf933b-ffff-9653-1071-110617354693","url":"https://proxy.example.invalid/auditEvents?$filter=activityDateTime"}` } }
    for (const exported of [changeReportJson(stored), changeReportMarkdown(stored), buildChangeReportDocument(stored).html]) {
      expect(exported).not.toContain("98cf933b")
      expect(exported).not.toContain("proxy.example.invalid")
      expect(exported).toContain("Microsoft Graph returned 503.")
    }
  })

  it("words a throttled audit read for email in a cloud report, and keeps the in-app advice on the desktop", () => {
    const throttled = "The Intune audit log could not be read: Microsoft Graph throttled the request (429). Generate the report again in a few minutes."
    const desktop = buildChangeReport(result(drifts), { error: throttled }, options)
    expect(desktop.audit.note).toBe(throttled)
    expect(desktop).not.toHaveProperty("cloud")
    expect(summaryLine(desktop)).toBe("1 changed, 1 added, 1 deleted. Who made them is unknown: the audit log could not be read.")
    const cloud = buildChangeReport(result(drifts), { error: throttled }, { ...options, cloud: true })
    expect(cloud.cloud).toBe(true)
    expect(cloud.audit.note).toBe("Microsoft Graph throttled the Intune audit log request.")
    expect(summaryLine(cloud)).toBe("1 changed, 1 added, 1 deleted. Who made them is unknown: the audit log could not be read.")
    expect(summaryLine(cloud, { reason: true })).toBe("1 changed, 1 added, 1 deleted. Who made them is unknown. Microsoft Graph throttled the Intune audit log request.")
    // A stored cloud report with a raw throttled error is cleaned the same way in every export.
    const stored = { ...cloud, audit: { ...cloud.audit, note: `Microsoft Graph returned 429: {"_version":3,"Message":"Operation ID: 1"}` } }
    for (const exported of [changeReportJson(stored), changeReportMarkdown(stored), buildChangeReportDocument(stored).html]) {
      expect(exported).toContain("Microsoft Graph throttled the Intune audit log request.")
      expect(exported).not.toMatch(/again/i)
    }
    expect(publicAuditNote(stored.audit.note)).toBe("Microsoft Graph throttled the audit log request (429). Generate the report again in a few minutes.")
  })

  it("names the report after the tenant and the backup days", () => {
    const report = buildChangeReport(result([]), { changes: [] }, options)
    expect(reportTitle(report)).toBe("Changes in Contoso, 5 Nov 2026 to 6 Nov 2026")
    expect(reportFileName(report)).toBe("change-report-contoso-2026-11-06")
    expect(summaryLine(report)).toBe("No changes between the two backups.")
  })

  it("escapes tenant text in Markdown so it cannot add links, HTML or table cells", () => {
    const hostile = drift({ configId: "p-9", configName: "<img src=x onerror=alert(1)> [link](https://evil.test) | cell", changes: [{ field: "description2", oldValue: "a|b", newValue: "<b>c</b>" }] })
    const markdown = changeReportMarkdown(buildChangeReport(result([hostile]), { changes: [] }, options))
    // CommonMark reads a backslash-escaped character literally, so only unescaped ones could become markup.
    expect(markdown).not.toMatch(/(?<!\\)[<[]/)
    expect(markdown).not.toContain("](https")
    expect(markdown).toContain("\\<img src=x onerror=alert\\(1\\)\\> \\[link\\]\\(https://evil.test\\) \\| cell")
    expect(markdown).toContain("| Description2 | a\\|b | \\<b\\>c\\</b\\> |")
  })

  it("describes assignments and OMA-URI settings as one line", () => {
    expect(describeAssignment({ target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: "g-2" } })).toBe("Excluded group g-2")
    expect(describeAssignment({ target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget", deviceAndAppManagementAssignmentFilterId: "f-1", deviceAndAppManagementAssignmentFilterType: "include" } })).toBe("All devices (filter include f-1)")
    expect(describeValue("omaSettings[Foo]", { omaUri: "./Device/Vendor/MSFT/Foo", value: 1 })).toBe("./Device/Vendor/MSFT/Foo = 1")
  })
})

describe("documented and redacted items", () => {
  it("lists every setting of a new Settings Catalog policy, redacting secret values", () => {
    const rows = documentItem({
      id: "p", name: "Wi-Fi", settings: [
        { id: "0", settingInstance: { settingDefinitionId: "device_vendor_msft_policy_config_defender_allowcloudprotection", choiceSettingValue: { value: "device_vendor_msft_policy_config_defender_allowcloudprotection_1", children: [] } } },
        { id: "1", settingInstance: { settingDefinitionId: "vendor_msft_wifi_key", simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", value: "hunter2" } } },
      ],
      omaSettings: [{ displayName: "PSK", omaUri: "./Vendor/Wifi", isEncrypted: true, value: "plaintext-key" }],
    }, "added")
    expect(JSON.stringify(rows)).not.toContain("hunter2")
    expect(JSON.stringify(rows)).not.toContain("plaintext-key")
    expect(rows.map((row) => row.field)).toEqual(expect.arrayContaining(["name", "settings[device_vendor_msft_policy_config_defender_allowcloudprotection]", "settings[vendor_msft_wifi_key]", "omaSettings[PSK]"]))
    expect(rows.every((row) => row.oldValue === undefined)).toBe(true)
  })

  it("documents every row, so a report can count the settings it does not list", () => {
    const content = Object.fromEntries(Array.from({ length: 450 }, (_, index) => [`setting${index}`, index]))
    const rows = documentItem({ displayName: "Big", ...content }, "added")
    expect(rows).toHaveLength(451)
    const report = buildChangeReport(result([drift({ configId: "big", configName: "Big", changeType: "added", changes: rows })]), { changes: [] }, options)
    expect(report.items[0]!.settings).toHaveLength(300)
    expect(report.items[0]!.moreSettings).toBe(150)
  })

  it("shows a changed secret as one Secret values row without its value", () => {
    const before = { passwordMinimumLength: 8, wifiPassword: "old-secret" }
    const after = { passwordMinimumLength: 10, wifiPassword: "new-secret" }
    const rows = redactedChanges(before, after)
    expect(JSON.stringify(rows)).not.toMatch(/old-secret|new-secret/)
    expect(rows.map((row) => row.field)).toEqual(["passwordMinimumLength", "secretValues"])
    expect(redactedChanges({ a: 1 }, { a: 2 }).map((row) => row.field)).toEqual(["a"])
  })
})

describe("change report PDF document", () => {
  const hostile = drift({ configId: "p-9", configName: "</style><script>alert(1)</script>", changes: [{ field: "x", oldValue: "1", newValue: "2" }] })
  const report = buildChangeReport(result([hostile]), { changes: [] }, options)

  it("escapes every value and loads nothing", () => {
    const { html, print } = buildChangeReportDocument(report)
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;/style&gt;&lt;script&gt;")
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`)
    expect(html).not.toMatch(/src="(?!data:)/)
    expect(print).toMatchObject({ pageSize: "A4", printBackground: true })
  })

  it("names TenuVault unless the report is white labelled", () => {
    expect(buildChangeReportDocument(report).html).toContain("TenuVault | Change report")
    const branded = buildChangeReportDocument(report, { branding: { companyName: "Fabrikam IT", footerText: "Fabrikam IT, confidential" } }).html
    expect(branded).not.toContain("TenuVault")
    expect(branded).toContain("Fabrikam IT")
  })
})

describe("audit events name their objects", () => {
  it("labels a live-shaped event by its activityType when activity is null", () => {
    const mapped = mapAuditEvent({ id: "live-1", activityDateTime: "2026-11-06T09:32:33Z", displayName: "Update device compliance policy and associated ScheduledActionForRule.", componentName: "DeviceCompliancePolicy", activity: null, activityType: "Patch DeviceCompliancePolicy", activityOperationType: "Patch", activityResult: "Success", category: "Compliance", actor: { applicationDisplayName: "Example app" }, resources: [{ displayName: "TV-ALERTS-TEST compliance", resourceId: "cp-1", type: "Windows10CompliancePolicy" }] })
    expect(mapped?.activity).toBe("Patch DeviceCompliancePolicy")
    expect(mapped?.actorAppName).toBe("Example app")
  })


  it("keep the ID of the named object for matching: the policy on an assignment event, the Entra target", () => {
    expect(mapAuditEvent({ id: "1", activityDateTime: "2026-11-05T10:00:00Z", activityOperationType: "Patch", activityResult: "Success", resources: [{ resourceId: "assignment-1" }, { displayName: "A", resourceId: "p-1" }] })?.resourceId).toBe("p-1")
    expect(mapEntraAuditEvent({ id: "2", activityDateTime: "2026-11-05T10:00:00Z", activityDisplayName: "Update conditional access policy", operationType: "Update", result: "success", loggedByService: "Conditional Access", targetResources: [{ id: "ca-1", displayName: "Require MFA" }] })?.resourceId).toBe("ca-1")
  })
})

describe("report periods", () => {
  const backup = (id: string, timestamp: string, status = "Success") => ({ id, timestamp, status, type: "scheduled" }) as BackupSummary
  const backups = [
    backup("b6", "2026-11-06T02:00:00Z"),
    backup("b5w", "2026-11-05T12:00:00Z", "CompletedWithWarnings"),
    backup("b5", "2026-11-05T02:00:00Z"),
    backup("b1", "2026-10-30T02:00:00Z"),
    backup("b0", "2026-10-20T02:00:00Z"),
  ]

  it("compares the newest complete backup with the one before it, or with the newest at least N days older", () => {
    expect(periodPair(backups, "previous")).toEqual({ baseline: "b5", comparison: "b6" })
    expect(periodPair(backups, "7")).toEqual({ baseline: "b1", comparison: "b6" })
    expect(periodPair(backups, "30")).toEqual({ baseline: "b0", comparison: "b6" })
    expect(periodPair(backups.slice(0, 2), "previous")).toBeNull()
  })

  it("reads comma, semicolon and space separated addresses", () => {
    expect(parseAddresses(" a@contoso.com; b@fabrikam.com,c@x.io ")).toEqual([
      { type: "address", address: "a@contoso.com" },
      { type: "address", address: "b@fabrikam.com" },
      { type: "address", address: "c@x.io" },
    ])
  })
})
