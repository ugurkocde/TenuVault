vi.hoisted(() => vi.stubGlobal("__TV_LAB_EXPANDED_ENTRA__", true))

import { notifiedStatus, scheduledResult } from "../src/main/backup/scheduler"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { runObservation } from "../src/shared/connection-health/observe"
import { SignInRequiredError } from "../src/main/auth/msal"
import { BackupEngine } from "../src/main/backup/engine"
import { FailedAttemptLog } from "../src/main/backup/failed-attempts"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"
import { NextRequest } from "../src/main/api/next-server-shim"
import { BACKUP_CONTAINER, RESOURCE_SCOPES } from "../src/shared/constants"
import { backupBlobName, backupContainer, LARGE_BACKUP_CONTAINER } from "../src/shared/backup-storage"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { POST as history } from "../src/portal/app/api/list-backups/route"
import { POST as drift } from "../src/portal/app/api/detect-drifts/route"
import { POST as changes } from "../src/portal/app/api/backup-changes/route"
import { POST as contents } from "../src/portal/app/api/list-backup-contents/route"
import { POST as validate } from "../src/portal/app/api/restore-validate/route"
import { exportLargeArchive, importLargeArchive, reviewLargeArchive, saveLargeDownload } from "../src/main/backup/large-archive"
import { CLIENT, jwt, registerTestTypes, TENANT, testType } from "./helpers/backup-fixture"
import { memoryStore } from "./helpers"

const roots: string[] = []
let undo: (() => void) | undefined
const local = `tvlocal-${TENANT}`
const largeType = testType("AuthorizationPolicy", "synthetic", { volume: "large", listOnly: true, apiVersion: "v1.0", inventory: true })
afterEach(async () => { undo?.(); undo = undefined; vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

for (const azure of [false, true]) describe(azure ? "Azure emulator isolation" : "local store isolation", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "tv-isolation-")); roots.push(root)
    const store = new LocalBlobStore(root, [Buffer.alloc(32, 9)])
    const account = azure ? "isolationstore" : local
    let refused = 0, failAt = "all", refusalCode: string | undefined
    const requests: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "storage" })
      if (url.pathname === "/api/revert-metadata") return Response.json({ reverts: {} })
      if (url.hostname === "graph.microsoft.com") {
        if (url.pathname === "/v1.0/synthetic") return Response.json({ value: [{ id: "large-one", displayName: "Large" }] })
        if (url.pathname === "/beta/deviceManagement/deviceCategories") return Response.json({ value: [{ id: "one", displayName: "One" }, { id: "two", displayName: "Two" }] })
        if (url.pathname.startsWith("/beta/deviceManagement/deviceCategories/")) return Response.json({ id: url.pathname.split("/").at(-1), displayName: "Category" })
        throw new Error(`Unexpected Graph request ${url}`)
      }
      requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`)
      if (refused && url.pathname.startsWith(`/${LARGE_BACKUP_CONTAINER}`) && (failAt === "all" || url.pathname.includes(failAt))) return new Response(`<Error><Code>${refusalCode ?? (refused === 403 ? "AuthorizationPermissionMismatch" : "ContainerNotFound")}</Code></Error>`, { status: refused })
      url.hostname = `${local}.blob.core.windows.net`
      return handleLocalBlobRequest(store, new Request(url, init))
    })
    vi.stubGlobal("fetch", fetcher)
    const write = async (folder: string, name: string, value: unknown) => {
      await store.createContainer(local, backupContainer(folder))
      await store.put(local, backupContainer(folder), backupBlobName(`${folder}/${name}`), Buffer.from(JSON.stringify(value)), "application/json")
    }
    const read = async (folder: string, name = "metadata.json") => JSON.parse((await store.get(local, backupContainer(folder), backupBlobName(`${folder}/${name}`))).data.toString())
    const request = (extra = {}) => new NextRequest("http://tenuvault.internal/api/test", { method: "POST", body: JSON.stringify({ tenantId: TENANT, appId: CLIENT, clientSecret: "test", subscriptionId: "local", resourceGroupName: "local", storageAccountName: account, ...extra }) })
    const seed = async (folder: string, large = false) => {
      const folderName = large ? "AuthorizationPolicy" : "DeviceCategories", snapshot = { id: "one", displayName: "Category" }
      await write(folder, `${folderName}/one.json`, snapshot)
      if (large) await write(folder, `_index/${folderName}/000000.json`, [{ id: "one", file: "one.json", hash: snapshotHash(snapshot) }])
      await write(folder, "metadata.json", { BackupFolder: folder, TenantId: TENANT, Status: "Success", Failures: 0, Coverage: "Complete", Scope: { Included: [folderName], Excluded: [] }, Items: large ? {} : { [`${folderName}/one`]: { file: "one.json", hash: snapshotHash(snapshot) } }, ItemCounts: { [folderName]: 1, TotalPolicies: large ? 0 : 1 }, ...(large ? { LargeItems: { [folderName]: { version: 1, count: 1, shards: 1, complete: true } } } : {}) })
    }
    return { root, store, account, fetcher, requests, write, read, request, seed, refuse: (status: number, at = "all", code?: string) => { refused = status; failAt = at; refusalCode = code } }
  }
  if (azure) it.each([
    [403, "AuthenticationFailed", "Sign in again to this tenant."],
    [404, "BlobNotFound", "Check the configured container or backup location."],
  ])("preserves HTTP %i %s guidance when large storage fails", async (status, code, guidance) => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    f.refuse(status, "all", code)
    const engine = new BackupEngine({ fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }) })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    expect(job.status, job.exception).toBe("Completed")
    expect(job.log.join("\n")).toContain(`HTTP ${status}, ${code}`)
    expect(job.log.join("\n")).toContain(guidance)
    expect(await f.read(job.backupFolder!)).toMatchObject({ Status: "Success", RunStatus: "CompletedWithWarnings", LargeBackupOutcomes: [{ Outcome: "failed", Error: expect.stringContaining(guidance) }] })
  })
  if (azure) it.each(["large storage", "directory read"])("keeps sign-in guidance when delegated sign-in ends during %s", async phase => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const refusalScope = phase === "large storage" ? RESOURCE_SCOPES.storage : RESOURCE_SCOPES.graph
    const engine = new BackupEngine({
      fetch: f.fetcher,
      getToken: async (tenantId, clientId, scope) => {
        if (scope === refusalScope && (phase === "large storage" || f.requests.some(request => request.includes(LARGE_BACKUP_CONTAINER)))) {
          const afterOrdinaryBackup = f.requests.some(request => request.includes("metadata.json"))
          if (afterOrdinaryBackup) throw new SignInRequiredError(tenantId, clientId, "Sign in again as private-admin@example.test.", scope, { errorNo: "50076" })
        }
        return jwt({ scp: "Policy.Read.All" })
      },
      services: () => ({ services: ["intune", "entra"] }),
    })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    const resource = phase === "large storage" ? "Azure Storage" : "Microsoft Graph"
    expect(job.status).toBe("Failed")
    expect(job.log.join("\n")).toContain(`Backup failed: ${resource} (AADSTS50076). Sign in again to this tenant.`)
    expect(job.log.join("\n")).not.toContain("private-admin@example.test")
  })

  if (azure) it.each(["directory payload upload", "large manifest commit"])("keeps sign-in guidance when delegated sign-in ends before %s", async phase => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const original = f.fetcher.getMockImplementation()!
    let expire = false
    f.fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init)
      const path = new URL(String(input)).pathname
      if (phase === "directory payload upload" ? path === "/v1.0/synthetic" : path.includes("/_index/AuthorizationPolicy/")) expire = true
      return response
    })
    const history = new FailedAttemptLog(memoryStore())
    const engine = new BackupEngine({
      fetch: f.fetcher,
      getToken: async (tenantId, clientId, scope) => {
        if (expire && scope === RESOURCE_SCOPES.storage) {
          expire = false
          throw new SignInRequiredError(tenantId, clientId, "Sign in again as private-admin@example.test.", scope, { errorNo: "50076" })
        }
        return jwt({ scp: "Policy.Read.All" })
      },
      services: () => ({ services: ["intune", "entra"] }),
      onFinished: (job, request) => history.finished(job, request),
    })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    const guidance = "Azure Storage (AADSTS50076). Sign in again to this tenant."
    const attempts = history.list(TENANT)
    expect(job.log.join("\n")).toContain(`Backup failed: ${guidance}`)
    expect(job.status).toBe("Failed")
    expect(attempts).toMatchObject([{ runId: job.id, message: guidance }])
    expect(JSON.stringify({ job, attempts })).not.toContain("private-admin@example.test")
    expect(job.outcomes?.types).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder: "DeviceCategories", outcome: "saved", saved: 2 }),
      expect.objectContaining({ folder: "AuthorizationPolicy", outcome: "failed", saved: 0 }),
    ]))
  })
  for (const status of [403, 404]) for (const at of ["all", "payload/", "metadata.json"]) it(`saves all ordinary snapshots in a scheduled app-only run with large storage ${status} at ${at}`, async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    await f.store.createContainer(local, BACKUP_CONTAINER)
    f.refuse(status, at)
    const engine = new BackupEngine({ fetch: f.fetcher, getToken: async () => { throw new Error("No interactive token allowed") }, unattendedTokens: () => ({ mode: "app-only", graph: async () => jwt({ roles: ["Policy.Read.All"] }), storage: async () => "storage" }), services: () => ({ services: ["intune", "entra"] }) })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, trigger: "scheduled", scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    expect(job.status, job.exception).toBe("Completed")
    expect(job.backupFolder).toMatch(/^backup-\d/)
    for (const name of ["One", "Two"]) expect(await f.read(job.backupFolder!, `DeviceCategories/${name}.json`)).toHaveProperty("id")
    const metadata = await f.read(job.backupFolder!)
    expect(metadata).toMatchObject({ Status: "Success", Coverage: "Complete", ItemCounts: { DeviceCategories: 2, TotalPolicies: 2 }, Scope: { Included: ["DeviceCategories"] } })
    expect(metadata).not.toHaveProperty("LargeItems")
    expect(metadata.RunStatus).toBe("CompletedWithWarnings")
    expect(scheduledResult(job).status).toBe("Failed")
    expect(notifiedStatus(job)).toBe("CompletedWithWarnings")
    expect(metadata.LargeBackupOutcomes).toMatchObject([{ Folder: "AuthorizationPolicy", Outcome: "failed", Error: expect.stringContaining("Storage not provisioned for large backups") }])
    expect(job.outcomes?.types.find(type => type.folder === "AuthorizationPolicy")).toMatchObject({ outcome: "failed", error: expect.stringContaining("New-TenuVaultStorage.ps1 -BackupReaderAppId") })
    expect(job.log.join("\n")).not.toContain("Storage Blob Data Contributor")
    expect(runObservation(job.outcomes!).refused.some(type => type.folder === "AuthorizationPolicy")).toBe(false)
    expect((await contents(f.request({ backupId: job.backupFolder }))).status).toBe(200)
    expect((await validate(f.request({ backupId: job.backupFolder }))).status).toBe(200)
  })
  it.each([403, 404])("returns all 500 ordinary folders with storage-specific history guidance when large history returns %s", async status => {
    const f = await setup()
    for (let at = 0; at < 500; at++) await f.seed(`backup-${new Date(Date.UTC(2020, 0, 1 + at)).toISOString().slice(0, 10)}-000000`)
    f.refuse(status)
    for (const summary of [true, false]) {
      const response = await history(f.request({ summary }))
      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.backups).toHaveLength(500)
      if (azure) expect(result.warnings).toEqual([expect.stringContaining("New-TenuVaultStorage.ps1 -BackupReaderAppId")])
      else if (status === 404) expect(result.warnings ?? []).toEqual([])
      else expect(result.warnings).toEqual([expect.stringContaining("Check access to the local backup folder")])
    }
    const response = await changes(f.request({ backupId: "backup-2020-01-02-000000" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ comparedWith: "backup-2020-01-01-000000", warnings: [expect.stringContaining("New-TenuVaultStorage.ps1")] })
    const compared = await drift(f.request())
    expect(compared.status).toBe(200)
    expect((await compared.json()).warnings).toContainEqual(expect.objectContaining({ message: expect.stringContaining("New-TenuVaultStorage.ps1") }))
  }, 60_000)
  it("keeps ordinary comparison available when large discovery works but large manifests are unreadable", async () => {
    const f = await setup()
    await f.seed("backup-2026-11-15-120000")
    await f.seed("backup-2026-11-16-120000")
    await f.seed("backup-large-2026-11-17-120000", true)
    f.refuse(403, "metadata.json")
    const listed = await history(f.request())
    expect(listed.status).toBe(200)
    const result = await listed.json()
    expect(result.backups).toHaveLength(2)
    expect(result.warnings).toContainEqual(expect.stringContaining(azure ? "New-TenuVaultStorage.ps1" : "Check access to the local backup folder"))
    const compared = await drift(f.request())
    expect(compared.status).toBe(200)
    expect((await compared.json()).warnings).toContainEqual(expect.objectContaining({ message: expect.stringContaining("New-TenuVaultStorage.ps1") }))
  })
  for (const mixed of [false, true]) it.each([403, 404])(`retains and deletes ordinary history independently of large storage %s (mixed: ${mixed})`, async status => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const old = "backup-2020-01-01-000000"
    await f.seed(old)
    f.refuse(status)
    const engine = new BackupEngine({ fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: mixed ? ["intune", "entra"] : ["intune"] }), retentionDays: () => 1 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceCategories" && !(mixed && type.folder === "AuthorizationPolicy")).map(type => type.folder) } }))
    expect(job.status, job.exception).toBe("Completed")
    expect(await f.store.list(local, BACKUP_CONTAINER, `${old}/`)).toEqual([])
    expect(f.requests.some(request => request.includes(LARGE_BACKUP_CONTAINER))).toBe(mixed)
  })
  it("keeps ordinary snapshots restorable while history marks a cancelled mixed run incomplete", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const original = f.fetcher.getMockImplementation()!
    let reached!: () => void
    const reading = new Promise<void>(resolve => { reached = resolve })
    f.fetcher.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/v1.0/synthetic") {
        reached()
        await new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }))
      }
      return original(input, init)
    })
    const engine = new BackupEngine({ fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), now: () => new Date("2026-11-16T12:00:00Z") })
    const job = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } })
    await reading
    expect(await f.read(job.backupFolder!)).toMatchObject({ Status: "Success", Coverage: "Complete", ItemCounts: { DeviceCategories: 2 } })
    engine.cancel(job.id)
    await engine.waitForJob(job)
    expect(job.status).toBe("Cancelled")
    expect(await f.read(job.backupFolder!)).toMatchObject({ Status: "Success", Coverage: "Complete" })
    expect(await f.read("backup-large-2026-11-16-120000")).toMatchObject({ Status: "Cancelled", Coverage: "Incomplete" })
    const rows = (await (await history(f.request())).json()).backups
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: job.backupFolder, status: "incomplete", coverage: "incomplete", warning: expect.stringContaining("cancelled") })
    expect((await validate(f.request({ backupId: job.backupFolder }))).status).toBe(200)
  })
  it("keeps companion folders independent through history, comparison, restore and archive import", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const engine = new BackupEngine({ fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), now: () => new Date("2026-11-16T12:00:00Z") })
    await f.seed("backup-2026-11-15-120000")
    await f.seed("backup-large-2026-11-15-120000", true)
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    const ordinary = job.backupFolder!, companion = "backup-large-2026-11-16-120000"
    expect(job.status, job.exception).toBe("Completed")
    expect(await f.read(ordinary)).toMatchObject({ CompanionBackup: companion, RunId: job.id, Coverage: "Complete" })
    const metadata = await f.read(companion)
    expect(metadata).toMatchObject({ CompanionBackup: ordinary, RunId: job.id, Scope: { Included: ["AuthorizationPolicy"] }, Items: {}, LargeItems: { AuthorizationPolicy: { count: 1, complete: true } } })
    const listed = await history(f.request({ summary: true }))
    const rows = (await listed.json()).backups
    expect(rows).toHaveLength(3)
    expect(rows.find((row: any) => row.id === ordinary).comparedWith).toBe("backup-2026-11-15-120000")
    const compared = await drift(f.request({ comparison: ordinary }))
    expect(compared.status).toBe(200)
    expect((await compared.json()).baseline.id).toBe("backup-2026-11-15-120000")
    expect((await validate(f.request({ backupId: ordinary }))).status).toBe(200)
    const archive = join(f.root, "companion.tar")
    await saveLargeDownload(Readable.toWeb(Readable.from(exportLargeArchive(TENANT, companion, metadata, name => f.read(companion, name)))) as ReadableStream<Uint8Array>, archive)
    const imported = new LocalBlobStore(join(f.root, "import"), [Buffer.alloc(32, 9)])
    await importLargeArchive(imported, await reviewLargeArchive(archive))
    expect(await imported.list(local, BACKUP_CONTAINER)).toEqual([])
    f.fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "storage" })
      if (url.pathname === "/api/revert-metadata") return Response.json({ reverts: {} })
      url.hostname = `${local}.blob.core.windows.net`
      return handleLocalBlobRequest(imported, new Request(url, init))
    })
    // Both discovery routes tolerate an absent ordinary container on a large-only import.
    const only = await history(f.request())
    expect((await only.json()).backups).toHaveLength(1)
    const changesResponse = await changes(f.request({ backupId: companion }))
    expect(changesResponse.status).toBe(200)
    expect(await changesResponse.json()).toMatchObject({ comparedWith: null })
    // Import a second companion and compare entirely within large storage.
    const secondMetadata = { ...metadata, BackupFolder: "backup-large-2026-11-17-120000" }
    const second = join(f.root, "second.tar")
    await saveLargeDownload(Readable.toWeb(Readable.from(exportLargeArchive(TENANT, secondMetadata.BackupFolder, secondMetadata, name => f.read(companion, name)))) as ReadableStream<Uint8Array>, second)
    await importLargeArchive(imported, await reviewLargeArchive(second))
    const drifts = await drift(f.request())
    expect(drifts.status, await drifts.clone().text()).toBe(200)
    expect((await drifts.json()).drifts).toEqual([])
  })
})
