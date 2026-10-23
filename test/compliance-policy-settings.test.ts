import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST as restorePreview } from "../src/portal/app/api/restore-preview/route"
import { validateBackup } from "../src/portal/lib/policies/restore-validation"
import { complianceSettingChanges } from "../src/shared/intune/compliance-settings"
import { itemName, typeForFolder, type Item } from "../src/shared/intune/registry"
import { readObject } from "../src/shared/intune/read"
import { buildRestorePlan, buildUpdatePlan, NotRestorableError, restoreCapabilities } from "../src/shared/intune/restore-plan"
import { formatValue, settingLabel } from "../src/shared/intune/drift-format"
import { Restorer } from "../src/portal/lib/policies/graph-restore"
import { compareObjects } from "../src/portal/app/api/detect-drifts/route"

const type = typeForFolder("CompliancePolicySettings")!
const ID = "CompliancePolicySettings"
const PATH = "b/CompliancePolicySettings/Compliance policy settings.json"

/** GET deviceManagement/settings as a lab tenant answered it, with the unrelated tenant features around the compliance settings. */
const live = (settings: Item = {}): Item => ({
  "@odata.context": "https://graph.microsoft.com/beta/$metadata#deviceManagement/settings",
  deviceComplianceCheckinThresholdDays: 30,
  isScheduledActionEnabled: true,
  secureByDefault: false,
  enhancedJailBreak: false,
  deviceInactivityBeforeRetirementInDay: 0,
  derivedCredentialProvider: "notConfigured",
  derivedCredentialUrl: null,
  androidDeviceAdministratorEnrollmentEnabled: false,
  enableLogCollection: true,
  m365AppDiagnosticsEnabled: true,
  ...settings,
})

const snapshot = (settings: Item = {}): Item => ({ id: ID, secureByDefault: true, deviceComplianceCheckinThresholdDays: 30, isScheduledActionEnabled: true, enhancedJailBreak: false, ...settings })

describe("Compliance policy settings type", () => {
  it("is a tenant-wide singleton in the Compliance area", () => {
    expect(type).toMatchObject({ area: "Compliance", path: "deviceManagement/settings", restore: "singleton" })
    expect(itemName(type, snapshot())).toBe("Compliance policy settings")
  })

  it("backs up only the compliance settings, under a fixed ID", async () => {
    const requested: string[] = []
    const detail = await readObject(type, ID, {
      get: async (path) => {
        requested.push(path)
        return live()
      },
      list: async () => [],
    })
    expect(requested).toEqual(["deviceManagement/settings"])
    expect(detail).toEqual({ id: ID, deviceComplianceCheckinThresholdDays: 30, isScheduledActionEnabled: true, secureByDefault: false, enhancedJailBreak: false })
  })

  it("is never created as a copy, only replaced in place", () => {
    expect(() => buildRestorePlan(type, snapshot())).toThrow(NotRestorableError)
    const { blocker, replaceBlocker } = restoreCapabilities(type, snapshot())
    expect(blocker).toMatch(/tenant-wide setting.*replaces it in place/)
    expect(replaceBlocker).toBeUndefined()
  })

  it("writes only the settings that differ, with PATCH on deviceManagement", () => {
    const steps = buildUpdatePlan(type, snapshot({ deviceComplianceCheckinThresholdDays: 60 }), ID, { current: { id: ID, ...live() } })
    expect(steps).toEqual([{ method: "PATCH", path: "deviceManagement", body: { settings: { secureByDefault: true, deviceComplianceCheckinThresholdDays: 60 } }, kind: "content" }])
  })

  it("never writes a validity period Intune rejects", () => {
    // Graph returns 0 when the period was never set; Intune accepts 1 to 120 days.
    for (const days of [0, 121, 1.5, null]) {
      const steps = buildUpdatePlan(type, snapshot({ deviceComplianceCheckinThresholdDays: days }), ID, { current: live({ deviceComplianceCheckinThresholdDays: 45 }) })
      expect(steps).toEqual([{ method: "PATCH", path: "deviceManagement", body: { settings: { secureByDefault: true } }, kind: "content" }])
    }
    expect(buildUpdatePlan(type, snapshot({ secureByDefault: false, deviceComplianceCheckinThresholdDays: 0 }), ID, { current: live({ deviceComplianceCheckinThresholdDays: 45 }) })).toEqual([])
  })

  it("describes each change as the admin center does, with what it does to users", () => {
    const changes = complianceSettingChanges(snapshot({ deviceComplianceCheckinThresholdDays: 10 }), live())
    expect(changes).toEqual([
      {
        key: "secureByDefault",
        label: "Mark devices with no compliance policy assigned as",
        from: "Compliant",
        to: "Not compliant",
        restored: true,
        warning: expect.stringMatching(/become noncompliant.*Conditional Access/),
      },
      {
        key: "deviceComplianceCheckinThresholdDays",
        label: "Compliance status validity period (days)",
        from: "30",
        to: "10",
        restored: true,
        warning: expect.stringMatching(/last 10 days become noncompliant/),
      },
    ])
    const relaxed = complianceSettingChanges(snapshot({ secureByDefault: false }), live({ secureByDefault: true }))
    expect(relaxed[0]).toMatchObject({ from: "Not compliant", to: "Compliant", warning: expect.stringMatching(/count as compliant/) })
    const unset = complianceSettingChanges(snapshot({ secureByDefault: false, deviceComplianceCheckinThresholdDays: 0 }), live({ deviceComplianceCheckinThresholdDays: 45 }))
    expect(unset).toEqual([{ key: "deviceComplianceCheckinThresholdDays", label: "Compliance status validity period (days)", from: "45", to: "Not set (Intune uses 30)", restored: false }])
    expect(type.review).toBeDefined()
  })
})

describe("Restoring compliance policy settings", () => {
  type Call = { method: string; path: string; body?: Item }
  const fakeGraph = (current: Item) => {
    const calls: Call[] = []
    const graph = async (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: Item) => {
      calls.push({ method, path, ...(body ? { body } : {}) })
      if (method === "GET" && path === "deviceManagement/settings") return { status: 200, body: current }
      return { status: 200, body: {} }
    }
    return { graph, calls }
  }

  it("replaces the live settings in place", async () => {
    const { graph, calls } = fakeGraph(live())
    const outcome = await new Restorer(graph, { mode: "replace", assignments: true }).restore(PATH, snapshot())
    expect(outcome).toMatchObject({ success: true, action: "updated", policyId: ID, policyName: "Compliance policy settings" })
    expect(calls).toEqual([
      { method: "GET", path: "deviceManagement/settings" },
      { method: "PATCH", path: "deviceManagement", body: { settings: { secureByDefault: true } } },
    ])
  })

  it("leaves matching settings alone", async () => {
    const { graph, calls } = fakeGraph(live({ secureByDefault: true }))
    const outcome = await new Restorer(graph, { mode: "replace", assignments: false }).restore(PATH, snapshot())
    expect(outcome).toMatchObject({ success: true, action: "unchanged", policyName: "Compliance policy settings" })
    expect(calls.map((call) => call.method)).toEqual(["GET"])
  })

  it("writes nothing and says so when only an invalid backed-up value differs", async () => {
    const { graph, calls } = fakeGraph(live({ secureByDefault: true, deviceComplianceCheckinThresholdDays: 45 }))
    const outcome = await new Restorer(graph, { mode: "replace", assignments: false }).restore(PATH, snapshot({ deviceComplianceCheckinThresholdDays: 0 }))
    expect(outcome).toMatchObject({ success: true, action: "unchanged", warnings: [expect.stringMatching(/Nothing was written/)] })
    expect(calls.map((call) => call.method)).toEqual(["GET"])
  })

  it("never creates a copy, in this tenant or another one", async () => {
    for (const options of [{ mode: "copy" as const, assignments: false }, { mode: "copy" as const, assignments: false, crossTenant: true }]) {
      const { graph, calls } = fakeGraph(live())
      const outcome = await new Restorer(graph, options).restore(PATH, snapshot())
      expect(outcome).toMatchObject({ success: false, action: "skipped", error: expect.stringMatching(/cannot be created as a copy or copied to another tenant/) })
      expect(calls).toEqual([])
    }
  })
})

describe("Compliance policy settings drift", () => {
  it("reports each changed setting by its admin center name and values", () => {
    const changes = compareObjects(snapshot({ secureByDefault: false }), snapshot({ secureByDefault: true }))
    expect(changes).toEqual([{ field: "secureByDefault", oldValue: false, newValue: true }])
    const label = settingLabel(changes[0]!)
    expect(label).toEqual({ label: "Mark devices with no compliance policy assigned as", path: "secureByDefault", property: "secureByDefault" })
    expect(formatValue(false, undefined, undefined, label.property)).toEqual({ kind: "text", text: "Compliant", raw: "false" })
    expect(formatValue(true, undefined, undefined, label.property)).toEqual({ kind: "text", text: "Not compliant", raw: "true" })
    expect(formatValue(0, undefined, undefined, "deviceComplianceCheckinThresholdDays").text).toBe("Not set (Intune uses 30)")
    // Other properties keep the generic labels and values.
    expect(formatValue(true)).toEqual({ kind: "text", text: "true" })
  })
})

describe("Compliance policy settings restore review", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("lists what replacing the live settings changes, without writing to the tenant", async () => {
    const backupId = "backup-2026-10-23-020000"
    const path = `${backupId}/CompliancePolicySettings/Compliance policy settings.json`
    const methods: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "token" })
      if (url.hostname === "graph.microsoft.com") {
        methods.push(`${init?.method ?? "GET"} ${url.pathname}`)
        return Response.json(live())
      }
      if (decodeURIComponent(url.pathname) === `/intune-backups/${path}`) return Response.json(snapshot(), { headers: { "x-tenuvault-authenticated": "true" } })
      return new Response("", { status: 404 })
    }))
    const body = { tenantId: "tenant", appId: "app", clientSecret: "test", storageAccountName: "store", backupId, paths: [path], live: true }
    const response = await restorePreview(new NextRequest("http://tenuvault.internal/api/restore-preview", { method: "POST", body: JSON.stringify(body) }))
    expect(response.status).toBe(200)
    const { items } = await response.json()
    expect(items[0]).toMatchObject({
      name: "Compliance policy settings",
      live: "changed",
      blocker: expect.stringContaining("cannot be created as a copy"),
      changes: [{ label: "Mark devices with no compliance policy assigned as", from: "Compliant", to: "Not compliant", restored: true, warning: expect.stringContaining("Conditional Access") }],
    })
    expect(items[0].replaceBlocker).toBeUndefined()
    expect(methods).toEqual(["GET /beta/deviceManagement/settings"])
  })
})

describe("Compliance policy settings backup validation", () => {
  it("passes a backup that holds them, since restore replaces them in place", async () => {
    const backupId = "backup-2026-10-23-020000"
    const path = `${backupId}/CompliancePolicySettings/Compliance policy settings.json`
    const report = await validateBackup({ backupId, metadata: { Status: "Success", Failures: 0, FailedTypes: [] }, listedPaths: [path], readSnapshot: async () => ({ ok: true, snapshot: snapshot() }) })
    expect(report).toMatchObject({ total: 1, passed: 1, failed: 0 })
    expect(report.items[0]!.checks.find((check) => check.id === "payload")).toMatchObject({ ok: true, detail: expect.stringContaining("replaces it in place") })
  })
})
