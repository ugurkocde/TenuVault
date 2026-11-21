import { withTenantWrite } from "../src/main/features/write-lock"
import { setWriteApprovals } from "../src/main/write-approvals/service"
import { approvalAccount, requester, reviewer, secondTenant, unenrolledApprovals, writeApprovalFixture } from "./helpers/write-approval-fixture"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiHost } from "../src/main/api/host"
import { createAuditRecorder } from "../src/main/api/audit"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { graphDispatchGuard } from "../src/main/write-approvals/dispatch"
import { DELEGATED_CLIENT_SECRET } from "../src/shared/constants"
import { handleOib, reviewedOibRoute, migrateLegacyOibRuns, OIB_BACKUP_POLLING, setOibStore } from "../src/main/oib/service"
import { packFolder, packItems, parsePackFile, resetOibSource } from "../src/main/oib/source"
import type { OibBackupOptions, OibCatalog, OibComparison, OibProgress, OibRun, UndoResult, ValidationRun } from "../src/shared/oib/types"
import { saveWrite, setRestoreJournalStore } from "../src/main/storage/restore-journal"
import { memoryStore } from "./helpers"

beforeEach(() => setWriteApprovals(unenrolledApprovals("none")))
afterEach(() => setWriteApprovals(undefined))

const tenantId = "11111111-1111-1111-1111-111111111111"
const appId = "22222222-2222-2222-2222-222222222222"
const pilot = "44444444-4444-4444-4444-444444444444"
const commit = "a".repeat(40)
const OIB_A = "92CE33B8-FF64-4604-A18D-35555F26C4BE"
const OIB_OLD = "86EB0653-DD3D-4CBA-BB51-1FFDC3E1F39C"
const EXISTING = "55555555-5555-5555-5555-555555555555"
const CREATED = "66666666-6666-6666-6666-666666666666"
const SC = "WINDOWS/IntuneManagement/SettingsCatalog/Win - OIB - SC - Test - v3.8.json"
const COMPLIANCE = "WINDOWS/IntuneManagement/CompliancePolicies/Win - OIB - Compliance - Password - v3.1.json"

const setting = (value: number) => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "device_vendor_msft_test", simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value } } })
const settingsCatalog = (name: string, value = 1) => ({
  "@odata.type": "#microsoft.graph.deviceManagementConfigurationPolicy", id: "author-id", name, description: `Tenant %OrganizationId% OIBID:${OIB_A}`,
  platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["7"], assignments: [{ target: { groupId: "author-group" } }], settings: [setting(value)],
})
const compliance = { "@odata.type": "#microsoft.graph.windows10CompliancePolicy", id: "c", displayName: "Win - OIB - Compliance - Password - v3.1", passwordRequired: true,
  scheduledActionsForRule: [{ ruleName: "PasswordRequired", scheduledActionConfigurations: [{ actionType: "block", gracePeriodHours: 0 }] }] }
const manifest = { oibVersion: "3.8", policies: [
  { oibId: OIB_A, name: "Win - OIB - SC - Test - v3.8", policyType: "SettingsCatalog", previousVersions: [OIB_OLD] },
  { oibId: "BDE95674-F4F0-4E6E-A49A-D0197BE56560", name: "Win - OIB - Compliance - Password - v3.1", policyType: "CompliancePolicies", licenseRequirements: "" },
] }

interface Tenant {
  /** Settings Catalog policies the tenant has, returned by list and detail reads. */
  policies: Array<{ id: string; name: string; description?: string; value?: number; tags?: string[] }>
  backupOk?: boolean
  /** metadata.json of the backup the deployment takes (backup-1); complete when left out. */
  metadata?: Record<string, unknown> | null
  /** Backups the listing route returns, newest first is not assumed. */
  backups?: Array<{ id: string; timestamp: string; status?: string; metadata?: Record<string, unknown> | null }>
  /** Status polls that report the backup running before it completes. */
  running?: number
  /** Bodies sent to /api/backup/start. */
  started?: Array<Record<string, unknown>>
  /** oib-progress answers read while the backup ran. */
  seen?: OibProgress[]
}

const COMPLETE = { Status: "Success", Failures: 0, TenantId: tenantId, Scope: { Excluded: [] }, SkippedTypes: [], FailedTypes: [], DurationSeconds: 120 }
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/** GitHub, the token endpoint, the app's backup routes and Graph for one tenant. */
function world(state: Tenant, writes: string[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    if (url.endsWith("/commits/main")) return Response.json({ sha: commit, commit: { committer: { date: "2026-09-01T00:00:00Z" } } })
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [
      { type: "blob", path: "WINDOWS/PolicyManifest.json" }, { type: "blob", path: "WINDOWS/README.md" }, { type: "blob", path: SC }, { type: "blob", path: COMPLIANCE },
      { type: "blob", path: "MACOS/IntuneManagement/SettingsCatalog/Mac.json" },
    ] })
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      if (url.endsWith("PolicyManifest.json")) return Response.json(manifest)
      return new Response(`\uFEFF${JSON.stringify(url.includes("CompliancePolicies") ? compliance : settingsCatalog("Win - OIB - SC - Test - v3.8", 1))}`)
    }
    if (url.includes("oauth2")) return Response.json({ access_token: "test" })
    if (url.endsWith("/api/backup/start")) {
      state.started?.push(JSON.parse(String(init!.body)) as Record<string, unknown>)
      return Response.json({ jobId: "job-1" })
    }
    if (url.endsWith("/api/backup/status")) {
      if (state.running) {
        state.running--
        const response = Response.json({ isComplete: false, progress: 40, progressMessage: "Reading Settings Catalog" })
        state.seen?.push(await handleOib({ action: "oib-progress", tenantId }) as OibProgress)
        return response
      }
      return Response.json({ isComplete: true, isSuccessful: state.backupOk !== false, backupFolder: "backup-1", exception: state.backupOk === false ? "Storage unavailable" : undefined })
    }
    if (url.endsWith("/api/list-backups")) return Response.json({ backups: (state.backups ?? []).map(({ metadata: _metadata, ...backup }) => ({ status: "Success", ...backup })) })
    if (url.endsWith("/api/list-backup-contents")) {
      const { backupId } = JSON.parse(String(init!.body)) as { backupId: string }
      const metadata = backupId === "backup-1" ? (state.metadata === undefined ? COMPLETE : state.metadata) : state.backups?.find(b => b.id === backupId)?.metadata
      return Response.json({ backupId, content: { groups: [], metadata: metadata ?? null } })
    }
    if (method === "GET" && url.endsWith("/roleScopeTags/0")) return Response.json({ id: "0" })
    const path = url.replace("https://graph.microsoft.com/beta/", "")
    if (method === "GET" && path.startsWith("deviceManagement/configurationPolicies?")) {
      return Response.json({ value: state.policies.map(p => ({ id: p.id, name: p.name, description: p.description ?? "" })) })
    }
    if (method === "GET" && path.startsWith("deviceManagement/deviceCompliancePolicies?")) return Response.json({ value: [] })
    const detail = /^deviceManagement\/configurationPolicies\/([^?/]+)(\/assignments)?(\?|$)/.exec(path)
    if (method === "GET" && detail) {
      const found = state.policies.find(p => p.id === decodeURIComponent(detail[1]!))
      if (!found) return Response.json({ error: { code: "ResourceNotFound", message: "Not found" } }, { status: 404 })
      if (detail[2]) return Response.json({ value: [{ id: "a1", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "prod" } }] })
      return Response.json({ id: found.id, name: found.name, description: found.description ?? "", platforms: "windows10", technologies: "mdm", ...(found.tags ? { roleScopeTagIds: found.tags } : {}), settings: [setting(found.value ?? 1)] })
    }
    writes.push(`${method} ${path}${init?.body ? ` ${String(init.body)}` : ""}`)
    if (method === "POST" && path === "deviceManagement/configurationPolicies") return Response.json({ id: CREATED, name: "created" })
    if (method === "PUT") {
      const id = path.split("/")[2]
      const body = JSON.parse(String(init!.body)) as { name: string; settings: Array<{ settingInstance: { simpleSettingValue: { value: number } } }> }
      const target = state.policies.find(p => p.id === id)
      if (target) { target.name = body.name; target.value = body.settings[0]!.settingInstance.simpleSettingValue.value }
      return Response.json({})
    }
    return new Response(null, { status: 204 })
  })
}

let store: ReturnType<typeof memoryStore>
beforeEach(() => { store = memoryStore(); setOibStore(store); setRestoreJournalStore(store); resetOibSource(); OIB_BACKUP_POLLING.intervalMs = 0 })
afterEach(() => { vi.unstubAllGlobals(); setOibStore(null) })

async function source() {
  const { commit: resolved } = await handleOib({ action: "oib-source" }) as { commit: string }
  return resolved
}
const base = { tenantId, appId, storageAccountName: `tvlocal-${tenantId}`, platform: "windows" }

describe("OIB pack files", () => {
  it("maps each OIB folder to the registry folder that creates it and ignores other files", () => {
    expect(packFolder("windows", "WINDOWS/IntuneManagement/SettingsCatalog/Win.json")).toBe("ConfigurationPolicies")
    expect(packFolder("windows", "WINDOWS/IntuneManagement/CompliancePolicies/Win.json")).toBe("CompliancePolicies")
    expect(packFolder("windows", "WINDOWS/IntuneManagement/UpdatePolicies/Win.json")).toBe("DeviceConfigurations")
    expect(packFolder("windows", "WINDOWS/IntuneManagement/DeviceConfiguration/Win.json")).toBe("DeviceConfigurations")
    expect(packFolder("windows", "WINDOWS/IntuneManagement/DriverUpdateProfiles/Win.json")).toBe("DriverUpdateProfiles")
    expect(packFolder("macos", "MACOS/NativeImport/Mac.json")).toBe("ConfigurationPolicies")
    expect(packFolder("windows", "WINDOWS/PolicyManifest.json")).toBeUndefined()
    expect(packFolder("windows", "WINDOWS/IntuneManagement/SettingsCatalog/nested/Win.json")).toBeUndefined()
    expect(packFolder("windows", "MACOS/IntuneManagement/SettingsCatalog/Mac.json")).toBeUndefined()
  })

  it("parses files with a byte order mark and deploys a policy found twice once, without the author's assignments", () => {
    expect(parsePackFile(`\uFEFF{"name":"Mac"}`)).toEqual({ name: "Mac" })
    const items = packItems("macos", [
      { path: "MACOS/NativeImport/Mac - FileVault.json", json: settingsCatalog("Mac - FileVault") },
      { path: "MACOS/IntuneManagement/SettingsCatalog/Mac - FileVault.json", json: settingsCatalog("Mac - FileVault") },
    ])
    expect(items.map(i => i.source)).toEqual(["MACOS/IntuneManagement/SettingsCatalog/Mac - FileVault.json"])
    expect(items[0]!.snapshot).not.toHaveProperty("assignments")
  })
})

describe("OIB source", () => {
  it("resolves main to a commit, loads the pack with its manifest and refuses commits it did not resolve", async () => {
    vi.stubGlobal("fetch", world({ policies: [] }, []))
    await expect(handleOib({ action: "oib-load", platform: "windows", commit })).rejects.toThrow("Reload")
    expect(await source()).toBe(commit)
    const catalog = await handleOib({ action: "oib-load", platform: "windows", commit }) as OibCatalog
    expect(catalog).toMatchObject({ platform: "windows", version: "v3.8", manifest: true, reference: `OpenIntuneBaseline Windows v3.8 · main @ ${commit.slice(0, 7)}` })
    expect(catalog.policies.map(p => [p.policyType, p.oibId])).toEqual([["SettingsCatalog", OIB_A], ["CompliancePolicies", "BDE95674-F4F0-4E6E-A49A-D0197BE56560"]])
    expect(JSON.stringify(catalog)).not.toContain("settingDefinitionId")
    await expect(handleOib({ action: "oib-load", platform: "linux", commit })).rejects.toThrow("supported OpenIntuneBaseline platform")
  })
})

describe("OIB source failures", () => {
  it("names the platform and release without repository paths or commits, keeps other platforms and retries the download", async () => {
    let fail = true
    const inner = world({ policies: [] }, [])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => fail && String(input).includes("CompliancePolicies") ? new Response("busy", { status: 503 }) : inner(input, init)))
    await source()
    const [windows, macos] = await Promise.allSettled([handleOib({ action: "oib-load", platform: "windows", commit }), handleOib({ action: "oib-load", platform: "macos", commit })])
    expect(windows.status === "rejected" && (windows.reason as Error).message).toBe("OpenIntuneBaseline Windows main @ aaaaaaa could not be loaded: GitHub returned 503.")
    expect(macos).toMatchObject({ status: "fulfilled", value: { platform: "macos" } })
    expect(warn.mock.calls.some(([line]) => String(line).includes(commit))).toBe(true)
    fail = false
    expect(await handleOib({ action: "oib-load", platform: "windows", commit })).toMatchObject({ platform: "windows", policies: [{}, {}] })
    warn.mockRestore()
  })
})

describe("Existing Deployment comparison", () => {
  it("matches tenant policies on the OIBID in their description", async () => {
    vi.stubGlobal("fetch", world({ policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.1", description: `OIBID:${OIB_OLD}` }] }, []))
    await source()
    const comparison = await handleOib({ ...base, action: "oib-compare", commit }) as OibComparison
    expect(comparison.matches).toMatchObject([
      { source: SC, status: "outdated", method: "oibid", tenant: { id: EXISTING }, tenantVersion: "3.1", oibVersion: "3.8" },
      { source: COMPLIANCE, status: "missing" },
    ])
  })

  it("fails the comparison when a continuation link is not a beta Graph link", async () => {
    const inner = world({ policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.1", description: `OIBID:${OIB_OLD}` }] }, [])
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? "GET") === "GET" && url.includes("deviceManagement/configurationPolicies?")) {
        return Response.json({ value: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.1", description: `OIBID:${OIB_OLD}` }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/deviceManagement/configurationPolicies?$skiptoken=x" })
      }
      return inner(input, init)
    }))
    await source()
    await expect(handleOib({ ...base, action: "oib-compare", commit })).rejects.toThrow(/could not be read completely/)
  })
})

describe("deployments", () => {
  it("changes nothing when the backup fails", async () => {
    const writes: string[] = []
    vi.stubGlobal("fetch", world({ policies: [], backupOk: false }, writes))
    await source()
    await expect(handleOib({ ...base, action: "oib-deploy", commit, items: [{ source: SC, mode: "create" }] })).rejects.toThrow("The backup failed, so nothing was changed. Storage unavailable")
    expect(writes).toEqual([])
  })

  it("refreshes the token when the pre-deploy inventory read gets a 401", async () => {
    const writes: string[] = []
    const inner = world({ policies: [] }, writes)
    let expired = true
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (expired && (init?.method ?? "GET") === "GET" && url.includes("deviceManagement/configurationPolicies?")) {
        expired = false
        return Response.json({ error: { code: "InvalidAuthenticationToken", message: "Access token has expired" } }, { status: 401 })
      }
      return inner(input, init)
    }))
    await source()
    const run = await handleOib({ ...base, action: "oib-deploy", commit, items: [{ source: SC, mode: "create" }] }) as OibRun
    expect(run).toMatchObject({ failed: [], created: [{ id: CREATED }] })
  })

  it("creates policies under their OIB names with the tenant ID filled in, assigns only the pilot group and records the run", async () => {
    const writes: string[] = []
    vi.stubGlobal("fetch", world({ policies: [] }, writes))
    await source()
    const run = await handleOib({ ...base, action: "oib-deploy", commit, items: [{ source: SC, mode: "create" }], pilotGroupId: pilot }) as OibRun
    expect(run).toMatchObject({ kind: "deploy", commit, backupFolder: "backup-1", pilotGroupId: pilot, failed: [], created: [{ folder: "ConfigurationPolicies", id: CREATED, name: "Win - OIB - SC - Test - v3.8" }] })
    // The pilot group is checked live before anything is created.
    expect(writes[0]).toBe(`GET groups/${pilot}`)
    const [create, assign] = writes.filter(write => !write.startsWith("GET "))
    expect(create).toContain('"name":"Win - OIB - SC - Test - v3.8"')
    expect(create).toContain(`Tenant ${tenantId}`)
    expect(create).not.toContain("author-group")
    expect(assign).toContain(`"groupId":"${pilot}"`)
    expect(await handleOib({ action: "oib-runs", tenantId })).toMatchObject({ runs: [{ runId: run.runId }] })
  })

  it("skips the backup when turned off, and leaves policies the tenant already has alone", async () => {
    const writes: string[] = []
    const fetch = world({ policies: [{ id: EXISTING, name: "Renamed by admin", description: `OIBID:${OIB_A}` }] }, writes)
    vi.stubGlobal("fetch", fetch)
    await source()
    const run = await handleOib({ ...base, storageAccountName: null, action: "oib-deploy", commit, backup: false, items: [{ source: SC, mode: "create" }] }) as OibRun
    expect(run).toMatchObject({ created: [], skipped: [{ name: "Win - OIB - SC - Test - v3.8", reason: "Already in the tenant as Renamed by admin." }] })
    expect(run.backupFolder).toBeUndefined()
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/api/backup/"))).toBe(false)
    expect(writes).toEqual([])
  })

  it("updates an outdated policy in place without touching assignments, and undo puts the previous version back", async () => {
    const writes: string[] = []
    const state: Tenant = { policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.1", value: 7, tags: ["0", "12"] }] }
    vi.stubGlobal("fetch", world(state, writes))
    await source()
    // Undo uses the previous version saved in the run, so an update may skip the backup.
    const run = await handleOib({ ...base, storageAccountName: null, action: "oib-deploy", commit, backup: { mode: "none" }, items: [{ source: SC, mode: "update", targetId: EXISTING }] }) as OibRun
    expect(run).toMatchObject({ backupMode: "none", commit, failed: [], created: [], updated: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.8", previousName: "Win - OIB - SC - Test - v3.1" }] })
    expect(run.backupFolder).toBeUndefined()
    expect(run.updated[0]).not.toHaveProperty("before")
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(new RegExp(`^PUT deviceManagement/configurationPolicies/${EXISTING} `))
    // The tenant's scope tags stay; the pack's Default tag applies only to new policies.
    expect(JSON.parse(writes[0]!.slice(writes[0]!.indexOf(" {") + 1)).roleScopeTagIds).toEqual(["0", "12"])
    expect(writes.some(w => w.includes("/assign"))).toBe(false)
    expect(state.policies[0]).toMatchObject({ name: "Win - OIB - SC - Test - v3.8", value: 1 })

    const undone = await handleOib({ action: "oib-undo", tenantId, appId, runId: run.runId }) as UndoResult
    expect(undone).toMatchObject({ run: null, results: [{ action: "restored", done: true, name: "Win - OIB - SC - Test - v3.1" }] })
    expect(state.policies[0]).toMatchObject({ name: "Win - OIB - SC - Test - v3.1", value: 7 })
    expect(await handleOib({ action: "oib-runs", tenantId })).toEqual({ runs: [] })
  })

  it("undo leaves a policy the admin deleted since the run deleted and reports it, instead of recreating it", async () => {
    const writes: string[] = []
    const state: Tenant = { policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.1", value: 7 }] }
    vi.stubGlobal("fetch", world(state, writes))
    await source()
    const run = await handleOib({ ...base, storageAccountName: null, action: "oib-deploy", commit, backup: { mode: "none" }, items: [{ source: SC, mode: "update", targetId: EXISTING }] }) as OibRun
    state.policies = []
    writes.length = 0
    const undone = await handleOib({ action: "oib-undo", tenantId, appId, runId: run.runId }) as UndoResult
    expect(writes).toEqual([])
    expect(undone).toMatchObject({ run: null, results: [{ action: "restored", done: true, note: "already deleted in Intune, so the previous version was not recreated" }] })
    expect(await handleOib({ action: "oib-runs", tenantId })).toEqual({ runs: [] })
  })

  it("undo restores the previous version to a journaled replacement when approvals are off", async () => {
    const writes: string[] = []
    const state: Tenant = { policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.1", value: 7 }] }
    vi.stubGlobal("fetch", world(state, writes))
    await source()
    const run = await handleOib({ ...base, storageAccountName: null, action: "oib-deploy", commit, backup: { mode: "none" }, items: [{ source: SC, mode: "update", targetId: EXISTING }] }) as OibRun
    state.policies = [{ id: CREATED, name: "Win - OIB - SC - Test - v3.1", value: 42 }]
    saveWrite({ key: "replacement", method: "POST", path: "deviceManagement/configurationPolicies", tenant: tenantId,
      sourceId: EXISTING, objectId: CREATED, state: "complete", at: new Date().toISOString() })
    writes.length = 0
    const undone = await handleOib({ action: "oib-undo", tenantId, appId, runId: run.runId }) as UndoResult
    expect(writes).toEqual([expect.stringContaining(`PUT deviceManagement/configurationPolicies/${CREATED}`)])
    expect(undone).toMatchObject({ run: null, results: [{ action: "restored", done: true }] })
    expect(state.policies[0]!.value).toBe(7)
  })

  it("does not recreate a policy deleted between reading it and updating it", async () => {
    const writes: string[] = []
    const state: Tenant = { policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.1", value: 7 }] }
    const tenant = world(state, writes)
    let reads = 0
    // The deploy's own read finds the policy; it is deleted before the restore reads it again.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && new RegExp(`configurationPolicies/${EXISTING}(\\?|$)`).test(String(input)) && ++reads === 2) state.policies = []
      return tenant(input, init)
    }))
    await source()
    const run = await handleOib({ ...base, storageAccountName: null, action: "oib-deploy", commit, backup: { mode: "none" }, items: [{ source: SC, mode: "update", targetId: EXISTING }] }) as OibRun
    expect(writes).toEqual([])
    expect(run).toMatchObject({ created: [], updated: [], failed: [{ error: "The tenant policy no longer exists. Compare again." }] })
  })

  it("undo deletes created objects, keeps what could not be deleted, and rejects unknown runs", async () => {
    const run: OibRun = { runId: "run-1", tenantId, createdAt: "2026-09-26T00:00:00Z", kind: "deploy", platform: "windows", reference: "r",
      created: [{ folder: "ConfigurationPolicies", id: "77777777-7777-7777-7777-777777777777", name: "A" }, { folder: "CompliancePolicies", id: "88888888-8888-8888-8888-888888888888", name: "B" }], updated: [], failed: [] }
    store.set(`oib:runs:${tenantId}`, JSON.stringify([run]))
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("oauth2")) return Response.json({ access_token: "test" })
      calls.push(`${init?.method} ${url}`)
      seen.push(await handleOib({ action: "oib-progress", tenantId }) as OibProgress)
      return url.includes("8888") ? Response.json({ error: { message: "Forbidden" } }, { status: 403 }) : new Response(null, { status: 204 })
    }))
    const seen: OibProgress[] = []
    const result = await handleOib({ action: "oib-undo", tenantId, appId, runId: "run-1" }) as UndoResult
    expect(seen).toMatchObject([{ kind: "undo", stage: "Deleting A", done: 0, total: 2 }, { kind: "undo", stage: "Deleting B", done: 1, total: 2 }])
    expect(await handleOib({ action: "oib-progress", tenantId })).toBeNull()
    expect(calls).toEqual([
      "DELETE https://graph.microsoft.com/beta/deviceManagement/configurationPolicies/77777777-7777-7777-7777-777777777777",
      "DELETE https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies/88888888-8888-8888-8888-888888888888",
    ])
    expect(result).toMatchObject({ run: { created: [{ name: "B" }] }, results: [{ name: "A", done: true }, { name: "B", done: false, error: "Forbidden" }] })
    await expect(handleOib({ action: "oib-undo", tenantId, appId, runId: "missing" })).rejects.toThrow("already undone")
  })

  it("validates the selection", async () => {
    vi.stubGlobal("fetch", world({ policies: [] }, []))
    await source()
    await expect(handleOib({ ...base, action: "oib-deploy", commit, items: [] })).rejects.toThrow("between 1 and 200")
    await expect(handleOib({ ...base, action: "oib-deploy", commit, items: [{ source: SC, mode: "update" }] })).rejects.toThrow("tenant policy to update")
    await expect(handleOib({ ...base, action: "oib-deploy", commit, items: [{ source: SC, mode: "create" }, { source: SC, mode: "create" }] })).rejects.toThrow("selected twice")
    await expect(handleOib({ ...base, action: "oib-deploy", commit, items: [{ source: SC, mode: "create" }], pilotGroupId: "All devices" })).rejects.toThrow("object ID")
    await expect(handleOib({ ...base, action: "oib-fix", commit, items: [{ source: SC, mode: "create" }] })).rejects.toThrow("updates an existing policy")
    await expect(handleOib({ ...base, action: "oib-deploy", commit, backup: false, items: [{ source: "WINDOWS/elsewhere.json", mode: "create" }] })).rejects.toThrow("not part of this OIB pack")
  })
})

describe("backup choice", () => {
  const update = { source: SC, mode: "update", targetId: EXISTING }
  const outdated = (): Tenant => ({ policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.1", value: 7 }] })

  it("backs up only the types the run writes, reports the backup percent and refuses a backup that missed them", async () => {
    const writes: string[] = []
    const state: Tenant = { ...outdated(), running: 2, started: [], seen: [] }
    vi.stubGlobal("fetch", world(state, writes))
    await source()
    const run = await handleOib({ ...base, action: "oib-deploy", commit, backup: true, items: [update] }) as OibRun
    expect(run).toMatchObject({ backupMode: "new", backupFolder: "backup-1", updated: [{ id: EXISTING }] })
    const excluded = (state.started![0]!.scope as { excluded: string[] }).excluded
    expect(excluded).not.toContain("ConfigurationPolicies")
    expect(excluded).toContain("CompliancePolicies")
    expect(excluded).toContain("Apps")
    expect(state.seen).toMatchObject([{ kind: "deploy", percent: 0, stage: "Backing up 1 policy type" }, { kind: "deploy", percent: 40, backupJobId: "job-1", stage: "Backing up 1 policy type: Reading Settings Catalog" }])
    expect(Date.parse(state.seen![0]!.startedAt)).toBeGreaterThan(0)
    expect(await handleOib({ action: "oib-progress", tenantId })).toBeNull()

    const incomplete = { ...outdated(), metadata: { ...COMPLETE, SkippedTypes: ["ConfigurationPolicies"] } }
    vi.stubGlobal("fetch", world(incomplete, writes))
    writes.length = 0
    await expect(handleOib({ ...base, action: "oib-deploy", commit, backup: { mode: "new" }, items: [update] })).rejects.toThrow(/did not collect every policy type this run changes \(settings catalog and endpoint security policies skipped for missing permissions\), so nothing was changed/)
    vi.stubGlobal("fetch", world({ ...outdated(), metadata: { ...COMPLETE, Status: "CompletedWithWarnings", Failures: 2 } }, writes))
    await expect(handleOib({ ...base, action: "oib-deploy", commit, items: [update] })).rejects.toThrow("not complete (status CompletedWithWarnings, 2 failure(s))")
    expect(writes).toEqual([])
  })

  it("reuses a complete backup of this tenant from the last 24 hours and refuses any other", async () => {
    const writes: string[] = []
    const fresh = "backup-2026-10-01-090000"
    const state: Tenant = { ...outdated(), started: [], backups: [
      { id: fresh, timestamp: minutesAgo(30), metadata: COMPLETE },
      { id: "backup-2026-09-29-090000", timestamp: minutesAgo(26 * 60), metadata: COMPLETE },
      { id: "backup-2026-09-30-090000", timestamp: minutesAgo(60), metadata: { ...COMPLETE, TenantId: "99999999-9999-9999-9999-999999999999" } },
      { id: "backup-2026-09-30-080000", timestamp: minutesAgo(90), metadata: { ...COMPLETE, Scope: { Excluded: ["ConfigurationPolicies"] } } },
      { id: "backup-2026-09-30-070000", timestamp: minutesAgo(100), metadata: { ...COMPLETE, TenantId: undefined } },
    ] }
    vi.stubGlobal("fetch", world(state, writes))
    await source()
    const reuse = (folder: string) => handleOib({ ...base, action: "oib-deploy", commit, backup: { mode: "reuse", folder }, items: [update] })
    await expect(reuse("backup-2026-09-29-090000")).rejects.toThrow("more than 24 hours old")
    await expect(reuse("backup-2026-09-30-090000")).rejects.toThrow("not recorded as this tenant's backup")
    await expect(reuse("backup-2026-09-30-070000")).rejects.toThrow("not recorded as this tenant's backup")
    await expect(reuse("backup-2026-09-28-090000")).rejects.toThrow("not recorded as this tenant's backup")
    await expect(reuse("backup-2026-09-30-080000")).rejects.toThrow("settings catalog and endpoint security policies left out of the backup scope")
    await expect(reuse("../elsewhere")).rejects.toThrow("Choose whether to back up now")
    await expect(handleOib({ ...base, storageAccountName: "", action: "oib-deploy", commit, backup: { mode: "reuse", folder: fresh }, items: [update] })).rejects.toThrow("or skip the backup")
    expect(writes).toEqual([])
    const run = await reuse(fresh) as OibRun
    expect(run).toMatchObject({ backupMode: "reuse", backupFolder: fresh, updated: [{ id: EXISTING }] })
    expect(state.started).toEqual([])
  })

  it("never offers a backup the user cancelled, so it does not hide an older finished one", async () => {
    const state: Tenant = { policies: [], backups: [
      { id: "backup-2026-10-01-095000", timestamp: minutesAgo(20), status: "Cancelled", metadata: { ...COMPLETE, Status: "Cancelled" } },
      { id: "backup-2026-10-01-090000", timestamp: minutesAgo(62), metadata: COMPLETE },
    ] }
    vi.stubGlobal("fetch", world(state, []))
    const { recent } = await handleOib({ ...base, action: "oib-backup-options", folders: ["ConfigurationPolicies"] }) as OibBackupOptions
    expect(recent).toMatchObject({ folder: "backup-2026-10-01-090000", complete: true })
  })

  it("reports the newest finished backup of the tenant with its age and the requested types it misses", async () => {
    const state: Tenant = { policies: [], backups: [
      { id: "backup-2026-10-01-100000", timestamp: minutesAgo(5), status: "running" },
      // A run that stopped early is recorded as failed and is never offered for reuse.
      { id: "backup-2026-10-01-095000", timestamp: minutesAgo(20), status: "Failed", metadata: { ...COMPLETE, Status: "Failed" } },
      { id: "backup-2026-10-01-090000", timestamp: minutesAgo(62), metadata: { ...COMPLETE, SkippedTypes: ["CompliancePolicies"] } },
      { id: "backup-2026-09-30-090000", timestamp: minutesAgo(600), metadata: COMPLETE },
    ] }
    vi.stubGlobal("fetch", world(state, []))
    const options = (folders: string[], extra = {}) => handleOib({ ...base, action: "oib-backup-options", folders, ...extra }) as Promise<OibBackupOptions>
    const { recent } = await options(["ConfigurationPolicies", "CompliancePolicies"])
    expect(recent).toMatchObject({ folder: "backup-2026-10-01-090000", ageMinutes: 60, complete: false, missing: ["compliance policies"], reason: "compliance policies skipped for missing permissions." })
    expect(Date.parse(recent!.completedAt)).toBe(Date.parse(state.backups![2]!.timestamp) + 120_000)
    expect((await options(["ConfigurationPolicies"])).recent).toMatchObject({ complete: true, missing: [] })
    expect((await options(["ConfigurationPolicies"])).recent).not.toHaveProperty("reason")
    expect(await options(["ConfigurationPolicies"], { storageAccountName: "" })).toEqual({ recent: null })
    await expect(options(["configurationpolicies"])).rejects.toThrow("Unknown policy type")
    await expect(options([])).rejects.toThrow("Name the policy types")
    vi.stubGlobal("fetch", world({ policies: [], backups: [] }, []))
    expect(await options(["ConfigurationPolicies"])).toEqual({ recent: null })
  })
})

describe("Policy Validation", () => {
  it("reports setting drift per policy, keeps history and leaves the tenant unchanged", async () => {
    const writes: string[] = []
    vi.stubGlobal("fetch", world({ policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.8", value: 3 }] }, writes))
    await source()
    const run = await handleOib({ ...base, action: "oib-validate", commit, items: [{ source: SC, targetId: EXISTING }] }) as ValidationRun
    expect(run.results).toMatchObject([{ source: SC, status: "drifted", tenantPolicyName: "Win - OIB - SC - Test - v3.8", result: { matched: 0, mismatches: [{ settingDefinitionId: "device_vendor_msft_test", oibValue: "1", tenantValue: "3" }] } }])
    expect(writes).toEqual([])
    expect(await handleOib({ action: "oib-validations", tenantId })).toMatchObject({ runs: [{ runId: run.runId }] })
    await handleOib({ ...base, action: "oib-validate", commit, save: false, items: [{ source: SC, targetId: EXISTING }] })
    expect((await handleOib({ action: "oib-validations", tenantId }) as { runs: unknown[] }).runs).toHaveLength(1)
    expect(await handleOib({ action: "oib-validation-delete", tenantId, runId: run.runId })).toEqual({ runs: [] })
  })

  it("reports when a single-policy check was not kept because Saved validations holds only full validations", async () => {
    vi.stubGlobal("fetch", world({ policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.8", value: 3 }] }, []))
    await source()
    const full = Array.from({ length: 50 }, (_, index) => ({ runId: `full-${index}`, tenantId, platform: "windows", commit, reference: "r", validatedAt: "2026-09-01T00:00:00Z", validationVersion: 1, selection: "all", results: [] }))
    store.set(`oib:validations:${tenantId}`, JSON.stringify(full))
    const single = await handleOib({ ...base, action: "oib-validate", commit, selection: "single", items: [{ source: SC, targetId: EXISTING }] }) as ValidationRun & { saved: boolean }
    expect(single.saved).toBe(false)
    const kept = (await handleOib({ action: "oib-validations", tenantId }) as { runs: ValidationRun[] }).runs
    expect(kept.map((run) => run.runId)).toEqual(full.map((run) => run.runId))
    const all = await handleOib({ ...base, action: "oib-validate", commit, selection: "all", items: [{ source: SC, targetId: EXISTING }] }) as ValidationRun & { saved: boolean }
    expect(all).toMatchObject({ saved: true, selection: "all" })
    expect((await handleOib({ action: "oib-validations", tenantId }) as { runs: ValidationRun[] }).runs[0]!.runId).toBe(all.runId)
  })

  it("resets a drifted policy with Fix drift and records it as an undoable run", async () => {
    const writes: string[] = []
    const state: Tenant = { policies: [{ id: EXISTING, name: "Win - OIB - SC - Test - v3.8", value: 3 }] }
    vi.stubGlobal("fetch", world(state, writes))
    await source()
    const run = await handleOib({ ...base, action: "oib-fix", commit, backup: { mode: "new" }, items: [{ source: SC, mode: "update", targetId: EXISTING }] }) as OibRun
    expect(run).toMatchObject({ kind: "fix", backupMode: "new", backupFolder: "backup-1", updated: [{ id: EXISTING }] })
    expect(state.policies[0]!.value).toBe(1)
    const validation = await handleOib({ ...base, action: "oib-validate", commit, save: false, items: [{ source: SC, targetId: EXISTING }] }) as ValidationRun
    expect(validation.results[0]!.status).toBe("compliant")
  })
})

describe("legacy data", () => {
  const legacyRun = (runId: string, reference: string) => ({ runId, tenantId, createdAt: "2026-09-20T00:00:00Z", platform: "win365", reference, backupFolder: "backup-0",
    created: [{ folder: "ConfigurationPolicies", id: "77777777-7777-7777-7777-777777777777", name: "W365 - OIB - Test" }], failed: [], skipped: [{ name: "Existing" }] })

  it("moves Quick Start runs into the OpenIntuneBaseline history, keeps the original and deletes nothing else", () => {
    const legacy = memoryStore()
    const quickStart = JSON.stringify([legacyRun("qs-1", "OpenIntuneBaseline Windows 365 v1.0 · 616c4de"), legacyRun("qs-2", "OpenIntuneBaseline Windows 365 v1.1 · 1234567")])
    legacy.set(`quickstart:runs:${tenantId}`, quickStart)
    for (const key of [`framework.workspace.${tenantId}.oib`, `framework.workspace.${tenantId}.custom`]) legacy.set(key, "{}")
    migrateLegacyOibRuns({ keys: () => [...legacy.values.keys()], get: legacy.get, set: legacy.set, delete: legacy.delete })
    expect([...legacy.values.keys()].sort()).toEqual([`framework.workspace.${tenantId}.custom`, `framework.workspace.${tenantId}.oib`, `oib:runs:${tenantId}`, `quickstart:migrated:${tenantId}`])
    expect(legacy.get(`quickstart:migrated:${tenantId}`)).toBe(quickStart)
    const runs = JSON.parse(legacy.get(`oib:runs:${tenantId}`)!) as OibRun[]
    expect(runs).toMatchObject([
      { runId: "qs-1", kind: "deploy", platform: "win365", legacy: "quickstart", commit: "616c4de853f975819f4d1106dc92fe620f4c78d6", backupFolder: "backup-0", updated: [], skipped: [{ name: "Existing", reason: "Already in the tenant." }] },
      { runId: "qs-2", legacy: "quickstart" },
    ])
    expect(runs[1]).not.toHaveProperty("commit")
    // A second start finds nothing left to migrate.
    migrateLegacyOibRuns({ keys: () => [...legacy.values.keys()], get: legacy.get, set: legacy.set, delete: legacy.delete })
    expect(JSON.parse(legacy.get(`oib:runs:${tenantId}`)!)).toHaveLength(2)
  })

  it("keeps a migrated Quick Start run undoable", async () => {
    migrateLegacyOibRuns({ keys: () => [`quickstart:runs:${tenantId}`], get: (key) => key.startsWith("quickstart:runs:") ? JSON.stringify([legacyRun("qs-1", "r · 616c4de")]) : store.get(key), set: store.set, delete: () => undefined })
    expect(await handleOib({ action: "oib-runs", tenantId })).toMatchObject({ runs: [{ runId: "qs-1", legacy: "quickstart" }] })
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("oauth2")) return Response.json({ access_token: "test" })
      calls.push(`${init?.method} ${url}`)
      return new Response(null, { status: 204 })
    }))
    expect(await handleOib({ action: "oib-undo", tenantId, appId, runId: "qs-1" })).toMatchObject({ run: null, results: [{ action: "removed", done: true }] })
    expect(calls).toEqual(["DELETE https://graph.microsoft.com/beta/deviceManagement/configurationPolicies/77777777-7777-7777-7777-777777777777"])
  })

  it("keeps migrated runs undoable when newer runs fill the history", async () => {
    const run = (runId: string, createdAt: string, legacy?: boolean): OibRun => ({ runId, tenantId, createdAt, kind: "deploy", platform: "windows", reference: "r", ...(legacy ? { legacy: "quickstart" as const } : {}),
      created: [{ folder: "ConfigurationPolicies", id: "77777777-7777-7777-7777-777777777777", name: runId }], updated: [], failed: [] })
    const newer = Array.from({ length: 20 }, (_, i) => run(`new-${i}`, `2026-09-2${Math.min(i, 9)}T00:00:${String(i).padStart(2, "0")}Z`))
    store.set(`oib:runs:${tenantId}`, JSON.stringify([run("qs-old", "2026-01-01T00:00:00Z", true), ...newer]))
    vi.stubGlobal("fetch", world({ policies: [] }, []))
    await source()
    await handleOib({ ...base, action: "oib-deploy", commit, items: [{ source: SC, mode: "create" }] })
    const ids = (JSON.parse(store.get(`oib:runs:${tenantId}`)!) as OibRun[]).map(r => r.runId)
    expect(ids).toContain("qs-old")
    expect(ids).not.toContain("new-0")
    expect(ids).toHaveLength(21)
  })

  it("leaves unreadable Quick Start records where they are", () => {
    const legacy = memoryStore()
    legacy.set(`quickstart:runs:${tenantId}`, "{not json")
    migrateLegacyOibRuns({ keys: () => [...legacy.values.keys()], get: legacy.get, set: legacy.set, delete: legacy.delete })
    expect(legacy.get(`quickstart:runs:${tenantId}`)).toBe("{not json")
  })
})


it("requires approval for deployment, pilot, fix and undo", async () => {
  const { profile } = writeApprovalFixture()
  const origin = profile(), second = profile(reviewer)
  setWriteApprovals(origin.service)
  const writes: string[] = []
  const state: Tenant = { policies: [{ id: EXISTING, name: "Existing policy", value: 2 }] }
  const graph = world(state, writes)
  let created: Record<string, unknown> | undefined
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith(`groups/${pilot}`)) return Response.json({ id: pilot })
    if (url.includes("/deviceManagement/configurationPolicies") && init?.method === "GET" && !url.includes("/configurationPolicies/")) return Response.json({ value: state.policies })
    if (url.endsWith("/scopeTags/0") || url.endsWith("/roleScopeTags/0")) return Response.json({ id: "0" })
    if (url.endsWith("/configurationPolicies") && init?.method === "POST") {
      const body = JSON.parse(String(init.body))
      state.policies.push({ id: CREATED, name: body.name, description: body.description })
      created = { ...body, id: CREATED, assignments: [] }
      await graph(input, init)
      return Response.json(created, { status: 201 })
    }
    if (created && init?.method === "GET" && url.includes(`/configurationPolicies/${CREATED}`)) {
      if (url.includes("/assignments")) return Response.json({ value: [] })
      return Response.json(created)
    }
    return graph(input, init)
  })
  const approve = async () => {
    const current = (await second.service.inbox(tenantId)).requests.find(row => row.request.state === "pending" && !row.decision)
    await second.service.decide(tenantId, current!.request.id, "approve")
  }
  try {
    await origin.service.enable(tenantId)
    await source()
    const deploy = () => handleOib({ ...base, action: "oib-deploy", commit, backup: { mode: "none" }, items: [{ source: SC, mode: "create" }], pilotGroupId: pilot }) as Promise<OibRun>
    await expect(deploy()).rejects.toThrow("pending")
    expect(writes).toHaveLength(0)
    expect((await second.service.inbox(tenantId)).requests[0]!.request.summary.operations?.[0]?.assignments[0]).toContain(pilot)
    await approve()
    const deployed = await deploy()
    expect(deployed.created).toHaveLength(1)
    expect(writes).toHaveLength(2)
    const fix = () => handleOib({ ...base, action: "oib-fix", commit, backup: { mode: "none" }, items: [{ source: SC, mode: "update", targetId: EXISTING }] })
    await expect(fix()).rejects.toThrow("pending")
    expect(writes).toHaveLength(2)
    await approve()
    expect(await fix()).toMatchObject({ updated: [{ id: EXISTING }] })
    const undo = () => handleOib({ ...base, action: "oib-undo", runId: deployed.runId })
    await expect(undo()).rejects.toThrow("pending")
    expect(writes).toHaveLength(3)
    await approve()
    expect(await undo()).toMatchObject({ results: [{ action: "removed", done: true }] })
    expect(writes).toHaveLength(4)
  } finally { setWriteApprovals(undefined) }
})


it.each([false, true])("records every reviewed OIB outcome through Graph transport when a later lock is held: %s", async held => {
  const { profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  setWriteApprovals(first.service)
  const writes: string[] = []
  const network = world({ policies: [] }, writes)
  const audit = vi.fn(async () => new Response(null, { status: 200 }))
  const admit = vi.fn(async () => null)
  const host = new ApiHost({ routes: { "/api/oib-reviewed-batches": { POST: reviewedOibRoute(admit) } }, onHandled: createAuditRecorder(audit, () => null) })
  const transport = createBridgedFetch({
    dispatch: request => host.dispatch(request), fetch: network,
    getDelegatedToken: async tenant => ({ accessToken: tenant, expiresOn: null }),
    authorizeGraph: graphDispatchGuard(first.service, token => ({ tenant: token, actor: requester, current: () => true })),
  })
  vi.stubGlobal("fetch", transport)
  try {
    await source()
    const batches = [tenantId, secondTenant].map(tenant => ({
      ...base, tenantId: tenant, clientSecret: DELEGATED_CLIENT_SECRET,
      action: "oib-deploy", commit, backup: { mode: "none" }, items: [{ source: SC, mode: "create" }],
    }))
    const run = async () => {
      const reply = await host.handleIpc({ method: "POST", path: "/api/oib-reviewed-batches", headers: {},
        body: new TextEncoder().encode(JSON.stringify({ tenantId, batches })) })
      return { status: reply.status, body: JSON.parse(new TextDecoder().decode(reply.body)) }
    }
    expect(await run()).toEqual({ status: 200, body: { legacy: true } })
    await first.service.enable(tenantId)
    await first.service.enable(secondTenant)
    expect((await run()).status).toBe(409)
    const approve = async (tenant: string) => {
      const row = (await second.service.inbox(tenant)).requests[0]!
      await second.service.decide(tenant, row.request.id, "approve")
    }
    await approve(tenantId)
    expect((await run()).status).toBe(409)
    expect(writes).toEqual([])
    await approve(secondTenant)
    const result = held ? await withTenantWrite(secondTenant, "another job", run) : await run()
    expect(result).toMatchObject({ status: 200, body: { results: [
      { tenant: tenantId, run: { created: [expect.anything()] } },
      held ? { tenant: secondTenant, error: expect.stringContaining("another job") } : { tenant: secondTenant, run: { created: [expect.anything()] } },
    ] } })
    expect(writes).toHaveLength(held ? 1 : 2)
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(2))
  } finally { setWriteApprovals(undefined) }
})


it.each(["pilot", "collision"])("stops a protected OIB deployment when the %s changes during its backup", async change => {
  const { profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  setWriteApprovals(first.service)
  await first.service.enable(tenantId)
  const state: Tenant = { policies: [] }
  const writes: string[] = []
  const network = world(state, writes)
  let backupDone = false
  const transport = createBridgedFetch({
    dispatch: async req => {
      const response = await network(req.url, { method: req.method, body: await req.text() })
      if (req.url.endsWith("/api/backup/status")) {
        backupDone = true
        if (change === "collision") state.policies.push({ id: EXISTING, name: "Other policy with same baseline ID", description: `OIBID:${OIB_A}` })
      }
      return response
    },
    getDelegatedToken: async () => ({ accessToken: "sign-in", expiresOn: null }),
    authorizeGraph: graphDispatchGuard(first.service, () => ({ tenant: tenantId, actor: requester, current: () => true })),
    fetch: (input, init) => String(input).endsWith(`groups/${pilot}`)
      ? Promise.resolve(Response.json({ id: pilot, displayName: backupDone && change === "pilot" ? "Renamed" : "Pilot" }))
      : network(input, init),
  })
  vi.stubGlobal("fetch", transport)
  await source()
  const run = () => handleOib({ ...base, storageAccountName: approvalAccount, clientSecret: DELEGATED_CLIENT_SECRET,
    action: "oib-deploy", commit, backup: { mode: "new" }, pilotGroupId: pilot, items: [{ source: SC, mode: "create" }],
  })
  await expect(run()).rejects.toThrow("pending")
  await second.service.decide(tenantId, (await second.service.inbox(tenantId)).requests[0]!.request.id, "approve")
  expect(await run()).toMatchObject({ created: [] })
  expect(backupDone).toBe(true)
  expect(writes).toEqual([])
})

it("checks enrollment before limiting grouped OIB batches", async () => {
  const { service } = writeApprovalFixture().profile()
  setWriteApprovals(service)
  const batches = Array.from({ length: 101 }, () => ({ ...base, action: "oib-deploy" }))
  const admit = vi.fn(async () => null)
  const post = () => reviewedOibRoute(admit)(new Request("http://local", { method: "POST", body: JSON.stringify({ tenantId, batches }) }))
  expect(await (await post()).json()).toEqual({ legacy: true })
  await service.enable(tenantId)
  expect(await (await post()).json()).toMatchObject({ error: expect.stringContaining("at most 100") })
  expect(admit).not.toHaveBeenCalled()
})

it.each([false, true])("shows and clears Loading the OIB pack while preparing a deployment, grouped %s", async grouped => {
  const { service } = writeApprovalFixture().profile()
  setWriteApprovals(service)
  if (grouped) await service.enable(tenantId)
  const network = world({ policies: [] }, [])
  let observed: OibProgress | undefined
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("oauth2")) observed = await handleOib({ action: "oib-progress", tenantId }) as OibProgress
    return network(input, init)
  })
  await source()
  const child = { ...base, action: "oib-deploy", commit, backup: { mode: "none" }, items: [{ source: SC, mode: "create" }] }
  if (grouped) {
    const response = await reviewedOibRoute(async body => body.tenantId === secondTenant ? new Response(null, { status: 403 }) : null)(
      new Request("http://local", { method: "POST", body: JSON.stringify({ tenantId, batches: [child, { ...child, tenantId: secondTenant }] }) }),
    )
    expect(response.status).toBe(403)
  } else await handleOib(child)
  expect(observed?.stage).toBe("Loading the OIB pack")
  expect(await handleOib({ action: "oib-progress", tenantId })).toBeNull()
})

it("falls back to individual OIB deployments only when no readable policy is enabled", async () => {
  const { profile, state } = writeApprovalFixture()
  const { service } = profile()
  setWriteApprovals(service)
  state.failedReads.add(`.tenuvault-controls/${secondTenant}/write-approval/policy.json`)
  const batches = [tenantId, secondTenant].map(tenantId => ({ ...base, tenantId, action: "oib-deploy" }))
  const admit = vi.fn(async () => null)
  const post = () => reviewedOibRoute(admit)(new Request("http://local", { method: "POST", body: JSON.stringify({ tenantId, batches }) }))
  expect(await (await post()).json()).toEqual({ legacy: true })
  await service.enable(tenantId)
  expect((await post()).status).toBe(409)
  expect(admit).not.toHaveBeenCalled()
})

it("keeps the legacy no-storage skip for an unenrolled destination in a reviewed group", async () => {
  const { profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  setWriteApprovals(first.service)
  await first.service.enable(tenantId)
  const writes: string[] = []
  vi.stubGlobal("fetch", world({ policies: [] }, writes))
  await source()
  const firstBatch = { ...base, action: "oib-deploy", commit, backup: { mode: "none" }, items: [{ source: SC, mode: "create" }] }
  const batches = [firstBatch, { ...firstBatch, tenantId: secondTenant, storageAccountName: undefined, backup: { mode: "new" } }]
  const post = () => reviewedOibRoute(async () => null)(new Request("http://local", { method: "POST", body: JSON.stringify({ tenantId, batches }) }))
  expect(await (await post()).json()).toMatchObject({ error: expect.stringContaining("pending") })
  await second.service.decide(tenantId, (await second.service.inbox(tenantId)).requests[0]!.request.id, "approve")
  expect(await (await post()).json()).toMatchObject({ results: [
    { batchIndex: 0, run: { created: [expect.anything()] } },
    { batchIndex: 1, error: expect.stringContaining("no backup storage") },
  ] })
  expect(writes).toHaveLength(1)
})

it.each(["before apply", "after claim"])("refuses protected undo when the restored scope tag assignment changes %s", async timing => {
  const { profile, state } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  setWriteApprovals(first.service)
  await first.service.enable(tenantId)
  const before = { ...settingsCatalog("Previous policy"), id: EXISTING }
  const run: OibRun = { runId: "scoped-undo", tenantId, createdAt: "2026-11-20T00:00:00Z", kind: "deploy", platform: "windows", reference: "r",
    created: [], updated: [{ id: EXISTING, folder: "ConfigurationPolicies", name: "Updated policy", previousName: "Previous policy", before }], failed: [] }
  store.set(`oib:runs:${tenantId}`, JSON.stringify([run]))
  const writes: string[] = []
  let groupId = pilot
  const graph = world({ policies: [{ id: EXISTING, name: "Updated policy", value: 2, tags: ["0"] }] }, writes)
  vi.stubGlobal("fetch", createBridgedFetch({
    dispatch: async () => new Response(null, { status: 404 }),
    getDelegatedToken: async () => ({ accessToken: "fixture", expiresOn: null }),
    authorizeGraph: graphDispatchGuard(first.service, () => ({ tenant: tenantId, actor: requester, current: () => true })),
    fetch: async (input, init) => {
      const url = String(input)
      if (url.endsWith("/roleScopeTags/7")) return Response.json({ id: "7", displayName: "Pilot" })
      if (url.endsWith("/roleScopeTags/7/assignments")) return Response.json({ value: [{ target: { groupId } }] })
      return graph(input, init)
    },
  }))
  const undo = () => handleOib({ ...base, action: "oib-undo", clientSecret: DELEGATED_CLIENT_SECRET, runId: run.runId })
  await expect(undo()).rejects.toThrow("pending")
  await second.service.decide(tenantId, (await second.service.inbox(tenantId)).requests[0]!.request.id, "approve")
  if (timing === "before apply") {
    groupId = secondTenant
    await expect(undo()).rejects.toThrow("changed after request")
  } else {
    state.beforeAudit = event => { if (event.action.endsWith("claimed")) groupId = secondTenant }
    expect(await undo()).toMatchObject({
      run: { runId: run.runId }, results: [{ id: EXISTING, done: false, error: expect.stringContaining("changed after review") }],
    })
  }
  expect(writes).toEqual([])
})

it("persists completed deletes and audits the remaining work when protected undo stops", async () => {
  const { profile } = writeApprovalFixture()
  const first = profile(), second = profile(reviewer)
  setWriteApprovals(first.service)
  await first.service.enable(tenantId)
  const run: OibRun = { runId: "partial-undo", tenantId, createdAt: "2026-11-20T00:00:00Z", kind: "deploy", platform: "windows", reference: "r",
    created: [EXISTING, CREATED, pilot].map((id, index) => ({ id, folder: "ConfigurationPolicies", name: `Policy ${index}` })), updated: [], failed: [] }
  store.set(`oib:runs:${tenantId}`, JSON.stringify([run]))
  const audit = vi.fn(async (_request: Request) => Response.json({ success: true }))
  const host = new ApiHost({
    routes: { "/api/oib": { POST: async request => Response.json(await handleOib(await request.json())) } },
    onHandled: createAuditRecorder(audit, () => null),
  })
  const writes: string[] = []
  let revision = "before"
  vi.stubGlobal("fetch", createBridgedFetch({
    dispatch: request => host.dispatch(request), getDelegatedToken: async () => ({ accessToken: "fixture", expiresOn: null }),
    authorizeGraph: graphDispatchGuard(first.service, () => ({ tenant: tenantId, actor: requester, current: () => true })),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const id = new URL(request.url).pathname.split("/")[4]
      if (request.method === "GET") return request.url.endsWith("/assignments") ? Response.json({ value: [] }) :
        Response.json({ id, name: id === CREATED ? revision : "original", settings: [] })
      writes.push(id!)
      revision = "edited"
      return new Response(null, { status: 204 })
    },
  }))
  const undo = () => handleOib({ ...base, action: "oib-undo", clientSecret: DELEGATED_CLIENT_SECRET, runId: run.runId })
  await expect(undo()).rejects.toThrow("pending")
  await second.service.decide(tenantId, (await second.service.inbox(tenantId)).requests[0]!.request.id, "approve")
  const response = await host.dispatch(new Request("http://tenuvault.internal/api/oib", { method: "POST",
    body: JSON.stringify({ ...base, action: "oib-undo", clientSecret: DELEGATED_CLIENT_SECRET, runId: run.runId }),
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ run: { created: [{ id: CREATED }, { id: pilot }] },
    results: [{ id: EXISTING, done: true }, { id: CREATED, done: false, error: expect.stringContaining("changed after review") }, { id: pilot, done: false }] })
  expect(await handleOib({ action: "oib-runs", tenantId })).toMatchObject({ runs: [{ created: [{ id: CREATED }, { id: pilot }] }] })
  expect(writes).toEqual([EXISTING])
  await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce())
  expect(await audit.mock.calls[0]![0].json()).toMatchObject({ logEntry: { result: "PARTIAL", details: { undone: 1, notUndone: 2 } } })
})
