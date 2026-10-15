import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleOib, migrateLegacyOibRuns, OIB_BACKUP_POLLING, setOibStore } from "../src/main/oib/service"
import { packFolder, packItems, parsePackFile, resetOibSource } from "../src/main/oib/source"
import type { OibBackupOptions, OibCatalog, OibComparison, OibProgress, OibRun, UndoResult, ValidationRun } from "../src/shared/oib/types"
import { memoryStore } from "./helpers"

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
beforeEach(() => { store = memoryStore(); setOibStore(store); resetOibSource(); OIB_BACKUP_POLLING.intervalMs = 0 })
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
})

describe("deployments", () => {
  it("changes nothing when the backup fails", async () => {
    const writes: string[] = []
    vi.stubGlobal("fetch", world({ policies: [], backupOk: false }, writes))
    await source()
    await expect(handleOib({ ...base, action: "oib-deploy", commit, items: [{ source: SC, mode: "create" }] })).rejects.toThrow("The backup failed, so nothing was changed. Storage unavailable")
    expect(writes).toEqual([])
  })

  it("creates policies under their OIB names with the tenant ID filled in, assigns only the pilot group and records the run", async () => {
    const writes: string[] = []
    vi.stubGlobal("fetch", world({ policies: [] }, writes))
    await source()
    const run = await handleOib({ ...base, action: "oib-deploy", commit, items: [{ source: SC, mode: "create" }], pilotGroupId: pilot }) as OibRun
    expect(run).toMatchObject({ kind: "deploy", commit, backupFolder: "backup-1", pilotGroupId: pilot, failed: [], created: [{ folder: "ConfigurationPolicies", id: CREATED, name: "Win - OIB - SC - Test - v3.8" }] })
    const [create, assign] = writes
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

  it("reports the newest finished backup of the tenant with its age and the requested types it misses", async () => {
    const state: Tenant = { policies: [], backups: [
      { id: "backup-2026-10-01-100000", timestamp: minutesAgo(5), status: "running" },
      { id: "backup-2026-10-01-090000", timestamp: minutesAgo(62), metadata: { ...COMPLETE, SkippedTypes: ["CompliancePolicies"] } },
      { id: "backup-2026-09-30-090000", timestamp: minutesAgo(600), metadata: COMPLETE },
    ] }
    vi.stubGlobal("fetch", world(state, []))
    const options = (folders: string[], extra = {}) => handleOib({ ...base, action: "oib-backup-options", folders, ...extra }) as Promise<OibBackupOptions>
    const { recent } = await options(["ConfigurationPolicies", "CompliancePolicies"])
    expect(recent).toMatchObject({ folder: "backup-2026-10-01-090000", ageMinutes: 60, complete: false, missing: ["compliance policies"], reason: "compliance policies skipped for missing permissions." })
    expect(Date.parse(recent!.completedAt)).toBe(Date.parse(state.backups![1]!.timestamp) + 120_000)
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
