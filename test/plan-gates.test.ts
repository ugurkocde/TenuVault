import { describe, expect, it, vi } from "vitest"
import { planGuard, requiredFeature, requiredFeatures } from "../src/main/api/plan-gates"
import { backupRoutes } from "../src/main/api/desktop-routes"
import { ApiHost } from "../src/main/api/host"
import type { BackupEngine } from "../src/main/backup/engine"
import { allows, upgradeMessage, type Plan } from "../src/shared/plans"
import { localStorageAccountName } from "../src/shared/constants"

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER = "22222222-2222-2222-2222-222222222222"
const CLIENT = "33333333-3333-3333-3333-333333333333"

describe("Plan features", () => {
  it("gives Pro every Pro feature and keeps MSP features for MSP", () => {
    expect(allows("community", "fullRestore")).toBe(false)
    expect(allows("pro", "fullRestore")).toBe(true)
    expect(allows("pro", "crossTenant")).toBe(false)
    expect(allows("msp", "crossTenant")).toBe(true)
    expect(upgradeMessage("crossTenant")).toMatch(/included in TenuVault MSP/)
  })
})

describe("requiredFeature", () => {
  it("lets Community restore one item as an unassigned copy", () => {
    expect(requiredFeature("/api/restore-backup", { restoreType: "selective", selectedPolicies: [{}], mode: "copy" })).toBeNull()
    expect(requiredFeature("/api/restore-backup", { restoreType: "full" })).toBe("fullRestore")
    expect(requiredFeature("/api/restore-backup", { restoreType: "selective", selectedPolicies: [{}, {}] })).toBe("fullRestore")
    expect(requiredFeature("/api/restore-backup", { restoreType: "selective", selectedPolicies: [{}], mode: "replace" })).toBe("replaceRestore")
    expect(requiredFeature("/api/restore-backup", { restoreType: "selective", selectedPolicies: [{}], assignments: true })).toBe("restoreAssignments")
  })

  it("gates drift revert, the audit log and Azure storage, and leaves audit writes free", () => {
    expect(requiredFeature("/api/revert-policy", { action: "restore" })).toBeNull()
    expect(requiredFeature("/api/revert-policy", { action: "revert" })).toBe("driftRevert")
    expect(requiredFeature("/api/audit/log", { tenantId: TENANT })).toBeNull()
    for (const path of ["/api/audit/logs", "/api/audit/stats", "/api/audit/export", "/api/audit/cleanup"]) expect(requiredFeature(path, { tenantId: TENANT })).toBe("auditLog")
    expect(requiredFeature("/api/backup/start", { storageAccountName: localStorageAccountName(TENANT) })).toBeNull()
    expect(requiredFeature("/api/backup/start", { storageAccountName: "contosobackups" })).toBe("azureStorage")
  })

  it("lets Community assess every framework except CIS", () => {
    const windows = [{ name: "Win - OIB - SC - Test", platforms: "windows10" }]
    const macos = [{ name: "MacOS - OIB - FileVault", platforms: "macOS" }]
    for (const frameworkId of ["microsoft", "custom", "stig", "ncsc-dsg"]) {
      for (const policies of [windows, macos, [...windows, ...macos], []]) expect(requiredFeature("/api/frameworks", { action: "assess", frameworkId, reference: "r", policies })).toBeNull()
    }
    for (const action of ["workspace-load", "workspace-save", "create"]) expect(requiredFeature("/api/frameworks", { action })).toBeNull()
    for (const frameworkId of ["cis-benchmarks", "cis-controls"]) expect(requiredFeature("/api/frameworks", { action: "assess", frameworkId, policies: windows })).toBe("baselineAllPlatforms")
  })

  it("keeps framework reports free except for CIS content", () => {
    const exports = ["native-pdf", "native-csv", "native-json", "workspace-pdf", "workspace-csv", "workspace-json"]
    for (const action of exports) {
      for (const frameworkId of ["iso-27001", "essential-eight", "ncsc-dsg", "custom", "microsoft", "oib", undefined]) expect(requiredFeature("/api/frameworks", { action, frameworkId, tenantId: TENANT })).toBeNull()
      for (const frameworkId of ["cis-benchmarks", "cis-controls"]) expect(requiredFeature("/api/frameworks", { action, frameworkId, tenantId: TENANT })).toBe("baselineAllPlatforms")
    }
    for (const action of ["native-history", "native-delete", "workspace-load", "workspace-save", "workspace-delete-assessment"]) {
      expect(requiredFeature("/api/frameworks", { action, frameworkId: "cis-benchmarks", tenantId: TENANT })).toBeNull()
    }
  })

  it("checks every feature a restore uses", () => {
    expect(requiredFeatures("/api/restore-backup", { restoreType: "selective", selectedPolicies: [{}], mode: "replace", assignments: true })).toEqual(["replaceRestore", "restoreAssignments"])
  })

  it("keeps every OIBDeployer flow in Community and gates in-place updates, drift fixes and other tenants", () => {
    for (const action of ["oib-source", "oib-versions", "oib-downloads", "oib-load", "oib-compare", "oib-validate", "oib-validations", "oib-runs", "oib-undo", "oib-progress", "oib-backup-options"]) {
      expect(requiredFeature("/api/oib", { action, platform: "macos" })).toBeNull()
    }
    expect(requiredFeature("/api/oib", { action: "oib-deploy", platform: "macos", items: [{ source: "a", mode: "create" }] })).toBeNull()
    expect(requiredFeature("/api/oib", { action: "oib-deploy", items: [{ source: "a", mode: "create" }, { source: "b", mode: "update", targetId: "x" }] })).toBe("replaceRestore")
    expect(requiredFeature("/api/oib", { action: "oib-fix", items: [{ source: "b", mode: "update", targetId: "x" }] })).toBe("driftRevert")
    expect(requiredFeature("/api/oib", { action: "oib-deploy", bulk: true, items: [{ source: "a", mode: "create" }] })).toBe("bulkActions")
  })

  it("needs MSP for each OpenIntuneBaseline deploy to a further tenant", () => {
    expect(requiredFeature("/api/oib", { action: "oib-deploy", platform: "macos", bulk: true, items: [{ source: "a", mode: "create" }] })).toBe("bulkActions")
    expect(requiredFeature("/api/oib", { action: "oib-load", platform: "macos", bulk: true })).toBeNull()
  })
})

describe("planGuard for frameworks and OpenIntuneBaseline", () => {
  const post = (body: object, path = "/api/frameworks") => new Request(`http://tenuvault.internal${path}`, { method: "POST", body: JSON.stringify({ tenantId: TENANT, ...body }) })
  const oib = (body: object) => post(body, "/api/oib")
  const community = planGuard(async () => "community")
  const pro = planGuard(async () => "pro")
  const msp = planGuard(async () => "msp")
  const unlicensed = planGuard(async () => null)

  it("lets Community deploy and compare every platform in its one tenant", async () => {
    for (const platform of ["windows", "macos", "win365", "byod"]) {
      for (const action of ["oib-load", "oib-compare", "oib-validate", "oib-runs", "oib-undo"]) expect(await community(oib({ action, platform }))).toBeNull()
      expect(await community(oib({ action: "oib-deploy", platform, items: [{ source: "a", mode: "create" }] }))).toBeNull()
    }
  })

  it("answers 402 to a Community in-place update or drift fix and lets Pro through", async () => {
    const deploy = (mode: string) => oib({ action: "oib-deploy", platform: "windows", items: [{ source: "a", mode, targetId: "x" }] })
    const fix = () => oib({ action: "oib-fix", platform: "windows", items: [{ source: "a", mode: "update", targetId: "x" }] })
    expect((await community(deploy("update")))?.status).toBe(402)
    expect((await community(fix()))?.status).toBe(402)
    expect(await community(deploy("create"))).toBeNull()
    expect(await pro(deploy("update"))).toBeNull()
    expect(await pro(fix())).toBeNull()
  })

  it("answers 402 to a deploy to a further tenant below MSP", async () => {
    const bulk = oib({ action: "oib-deploy", platform: "windows", bulk: true, items: [{ source: "a", mode: "create" }] })
    expect((await community(bulk.clone()))?.status).toBe(402)
    const refused = await pro(bulk.clone())
    expect(refused?.status).toBe(402)
    expect(await refused?.json()).toMatchObject({ upgrade: "bulkActions" })
    expect(await msp(bulk.clone())).toBeNull()
  })

  it("lets every plan export non-CIS framework reports and needs Pro for CIS reports", async () => {
    for (const action of ["native-pdf", "native-csv", "native-json", "workspace-pdf", "workspace-csv", "workspace-json"]) {
      for (const guard of [community, pro, msp]) expect(await guard(post({ action, frameworkId: "iso-27001", runId: "r" }))).toBeNull()
      const cis = post({ action, frameworkId: "cis-benchmarks", runId: "r" })
      expect((await community(cis.clone()))?.status).toBe(402)
      expect(await pro(cis.clone())).toBeNull()
      expect(await msp(cis.clone())).toBeNull()
    }
  })

  it("keeps the audit log Pro and MSP and lets every plan write entries", async () => {
    const audit = (path: string) => new Request(`http://tenuvault.internal${path}`, { method: "POST", body: JSON.stringify({ tenantId: TENANT, exportOptions: { format: "csv" } }) })
    for (const path of ["/api/audit/logs", "/api/audit/stats", "/api/audit/export", "/api/audit/cleanup"]) {
      const refused = await community(audit(path))
      expect(refused?.status).toBe(402)
      expect(await refused?.json()).toMatchObject({ upgrade: "auditLog" })
      expect(await pro(audit(path))).toBeNull()
    }
    expect(await community(audit("/api/audit/log"))).toBeNull()
  })

  it("leaves an expired or unlicensed tenant to the handler, which refuses it", async () => {
    // A lapsed license resolves to Community; a tenant beyond the free slot resolves to null and
    // the route's own entitlement check (native authorize, token bridge) refuses it.
    expect(await unlicensed(post({ action: "native-csv", frameworkId: "cis-benchmarks" }))).toBeNull()
    expect(await unlicensed(oib({ action: "oib-deploy", platform: "windows", bulk: true, items: [{ source: "a", mode: "create" }] }))).toBeNull()
  })
})

describe("planGuard", () => {
  const request = (body: object) => new Request("http://tenuvault.internal/api/restore-backup", { method: "POST", body: JSON.stringify(body) })

  it("answers 402 with an upgrade message when the plan does not include the feature", async () => {
    const response = await planGuard(async () => "community")(request({ tenantId: TENANT, restoreType: "full" }))
    expect(response?.status).toBe(402)
    expect(await response?.json()).toMatchObject({ upgrade: "fullRestore", error: upgradeMessage("fullRestore") })
  })

  it("lets the request through for a plan that includes it, and leaves the request body readable", async () => {
    const original = request({ tenantId: TENANT, restoreType: "full" })
    expect(await planGuard(async () => "pro")(original)).toBeNull()
    expect(await original.json()).toMatchObject({ restoreType: "full" })
  })

  it("needs MSP on the source and every target tenant to copy to other tenants", async () => {
    const other = "22222222-2222-2222-2222-222222222222"
    const copy = request({ tenantId: TENANT, restoreType: "selective", selectedPolicies: [{}], targetTenants: [{ tenantId: other, appId: other }] })
    expect(requiredFeature("/api/restore-backup", { targetTenants: [] })).toBe("bulkActions")
    expect(await planGuard(async () => "msp")(copy.clone())).toBeNull()
    expect((await planGuard(async () => "pro")(copy.clone()))?.status).toBe(402)
    expect((await planGuard(async (id) => (id === TENANT ? "msp" : "community"))(copy.clone()))?.status).toBe(402)
    expect((await planGuard(async (id) => (id === TENANT ? "msp" : null))(copy.clone()))?.status).toBe(402)
  })

  it("answers 400 to a tenantId that is not a string instead of skipping the plan check", async () => {
    for (const tenantId of [[TENANT], { id: TENANT }, 1, null]) {
      expect((await planGuard(async () => "community")(request({ tenantId, restoreType: "full" })))?.status).toBe(400)
    }
    expect(await planGuard(async () => "community")(request({ restoreType: "full" }))).toBeNull()
  })

  it("leaves unlicensed tenants to the request itself", async () => {
    expect(await planGuard(async () => null)(request({ tenantId: TENANT, restoreType: "full" }))).toBeNull()
  })
})

describe("bulk backup and drift plan gates", () => {
  const plans = (map: Record<string, Plan | null>) => async (id: string) => map[id] ?? null
  const post = (path: string, body: object) => new Request(`http://tenuvault.internal${path}`, { method: "POST", body: JSON.stringify(body) })
  const bulkBackup = (tenantId = TENANT) => post("/api/backup/start", {
    tenantId, appId: CLIENT, storageAccountName: localStorageAccountName(tenantId),
    bulk: true, targetTenants: [{ tenantId: tenantId === TENANT ? OTHER : TENANT }],
  })
  const bulkDrift = (tenantId = TENANT) => post("/api/detect-drifts", {
    tenantId, appId: CLIENT, storageAccountName: localStorageAccountName(tenantId),
    bulk: true, targetTenants: [{ tenantId: tenantId === TENANT ? OTHER : TENANT }],
  })

  it("needs bulkActions for bulk backup and drift, and nothing extra for single tenant calls", () => {
    expect(requiredFeatures("/api/backup/start", { storageAccountName: localStorageAccountName(TENANT) })).toEqual([])
    expect(requiredFeatures("/api/backup/start", { storageAccountName: localStorageAccountName(TENANT), bulk: true })).toContain("bulkActions")
    expect(requiredFeatures("/api/backup/start", { storageAccountName: localStorageAccountName(TENANT), targetTenants: [{ tenantId: OTHER }] })).toContain("bulkActions")
    expect(requiredFeatures("/api/backup/start", { storageAccountName: "contosobackups", bulk: true })).toEqual(expect.arrayContaining(["azureStorage", "bulkActions"]))
    expect(requiredFeature("/api/detect-drifts", { tenantId: TENANT })).toBeNull()
    expect(requiredFeature("/api/detect-drifts", { tenantId: TENANT, bulk: true })).toBe("bulkActions")
    expect(requiredFeature("/api/detect-drifts", { tenantId: TENANT, targetTenants: [{ tenantId: OTHER }] })).toBe("bulkActions")
  })

  it("refuses a bulk backup over a mixed MSP and Pro estate with 402, whichever tenant it starts from", async () => {
    const mixed = planGuard(plans({ [TENANT]: "msp", [OTHER]: "pro" }))
    const refused = await mixed(bulkBackup())
    expect(refused?.status).toBe(402)
    expect(await refused?.json()).toMatchObject({ upgrade: "bulkActions", error: upgradeMessage("bulkActions") })
    expect((await mixed(bulkBackup(OTHER)))?.status).toBe(402)
    expect((await planGuard(plans({ [TENANT]: "msp", [OTHER]: null }))(bulkBackup()))?.status).toBe(402)
    expect((await planGuard(plans({ [TENANT]: null, [OTHER]: "msp" }))(bulkBackup()))?.status).toBe(402)
    expect((await planGuard(plans({ [TENANT]: null, [OTHER]: "msp" }))(bulkDrift()))?.status).toBe(402)
  })

  it("lets a bulk backup over all MSP tenants through", async () => {
    const allMsp = planGuard(plans({ [TENANT]: "msp", [OTHER]: "msp" }))
    expect(await allMsp(bulkBackup())).toBeNull()
    expect(await allMsp(bulkBackup(OTHER))).toBeNull()
  })

  it("gives drift Check all the same per tenant enforcement", async () => {
    const mixed = planGuard(plans({ [TENANT]: "msp", [OTHER]: "pro" }))
    const refused = await mixed(bulkDrift())
    expect(refused?.status).toBe(402)
    expect(await refused?.json()).toMatchObject({ upgrade: "bulkActions" })
    expect((await mixed(bulkDrift(OTHER)))?.status).toBe(402)
    expect(await planGuard(plans({ [TENANT]: "msp", [OTHER]: "msp" }))(bulkDrift())).toBeNull()
  })

  it("leaves single tenant backup and drift calls exactly as before", async () => {
    const community = planGuard(plans({ [TENANT]: "community" }))
    expect(await community(post("/api/backup/start", { tenantId: TENANT, appId: CLIENT, storageAccountName: localStorageAccountName(TENANT) }))).toBeNull()
    expect(await community(post("/api/detect-drifts", { tenantId: TENANT, appId: CLIENT, storageAccountName: localStorageAccountName(TENANT) }))).toBeNull()
    const azure = await community(post("/api/backup/start", { tenantId: TENANT, appId: CLIENT, storageAccountName: "contosobackups" }))
    expect(azure?.status).toBe(402)
    expect(await azure?.json()).toMatchObject({ upgrade: "azureStorage" })
    // A single call for an unusable tenant is still left to the request itself, as before.
    expect(await planGuard(plans({ [TENANT]: null }))(post("/api/backup/start", { tenantId: TENANT, appId: CLIENT, storageAccountName: "contosobackups" }))).toBeNull()
  })

  it("answers 400 to malformed bulk target tenants instead of skipping them", async () => {
    const msp = planGuard(plans({ [TENANT]: "msp", [OTHER]: "msp" }))
    for (const targetTenants of ["nope", [{ tenantId: 1 }], [{}], [null]]) {
      const body = { tenantId: TENANT, appId: CLIENT, storageAccountName: localStorageAccountName(TENANT), bulk: true, targetTenants }
      expect((await msp(post("/api/backup/start", body)))?.status).toBe(400)
      expect((await msp(post("/api/detect-drifts", body)))?.status).toBe(400)
    }
  })

  it("refuses a mixed bulk backup before any job starts and starts jobs for an all MSP estate", async () => {
    const start = vi.fn(() => ({ id: "job-1", status: "Running" }))
    const drift = vi.fn(async () => Response.json({ drifts: [], summary: { total: 0, critical: 0 } }))
    const routes = { ...backupRoutes({ start, get: () => undefined } as unknown as BackupEngine), "/api/detect-drifts": { POST: drift } }
    const mixedHost = new ApiHost({ routes, guard: planGuard(plans({ [TENANT]: "msp", [OTHER]: "pro" })) })
    expect((await mixedHost.dispatch(bulkBackup())).status).toBe(402)
    expect((await mixedHost.dispatch(bulkDrift())).status).toBe(402)
    expect(start).not.toHaveBeenCalled()
    expect(drift).not.toHaveBeenCalled()

    const mspHost = new ApiHost({ routes, guard: planGuard(plans({ [TENANT]: "msp", [OTHER]: "msp" })) })
    expect((await mspHost.dispatch(bulkBackup())).status).toBe(200)
    expect(start).toHaveBeenCalledTimes(1)
    expect((await mspHost.dispatch(bulkDrift())).status).toBe(200)
    expect(drift).toHaveBeenCalledTimes(1)

    const communityHost = new ApiHost({ routes, guard: planGuard(plans({ [TENANT]: "community" })) })
    const single = post("/api/backup/start", { tenantId: TENANT, appId: CLIENT, storageAccountName: localStorageAccountName(TENANT) })
    expect((await communityHost.dispatch(single)).status).toBe(200)
    expect(start).toHaveBeenCalledTimes(2)
    expect((await communityHost.dispatch(post("/api/detect-drifts", { tenantId: TENANT, appId: CLIENT, storageAccountName: localStorageAccountName(TENANT) }))).status).toBe(200)
    expect(drift).toHaveBeenCalledTimes(2)
  })
})
