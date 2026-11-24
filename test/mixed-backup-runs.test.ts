import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backupSummary, normalizeBackupStatus } from "../src/portal/lib/backup-health"
import { BackupEngine } from "../src/main/backup/engine"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"
import { NextRequest } from "../src/main/api/next-server-shim"
import { BACKUP_CONTAINER } from "../src/shared/constants"
import { backupBlobName, backupContainer, LARGE_BACKUP_CONTAINER } from "../src/shared/backup-storage"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { POST as history } from "../src/portal/app/api/list-backups/route"
import { POST as download } from "../src/portal/app/api/download-backup/route"
import { POST as validate } from "../src/portal/app/api/restore-validate/route"
import { importLargeArchive, reviewLargeArchive } from "../src/main/backup/large-archive"
import { reviewArchive, importConfirmedArchive } from "../src/main/backup/archive"
import { CLIENT, jwt, registerTestTypes, TENANT, testType } from "./helpers/backup-fixture"

const roots: string[] = []
let undo: (() => void) | undefined
const local = `tvlocal-${TENANT}`
const largeType = testType("AuthorizationPolicy", "synthetic", { volume: "large", listOnly: true, apiVersion: "v1.0", inventory: true })
afterEach(async () => { undo?.(); undo = undefined; vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

for (const azure of [false, true]) describe(azure ? "Azure emulator mixed runs" : "local mixed runs", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "tv-isolation-")); roots.push(root)
    const store = new LocalBlobStore(root, [Buffer.alloc(32, 9)])
    const account = azure ? "isolationstore" : local
    let refused = 0, failAt = "all"
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
      if (refused && url.pathname.startsWith(`/${LARGE_BACKUP_CONTAINER}`) && (failAt === "all" || url.pathname.includes(failAt))) return new Response(`<Error><Code>${refused === 403 ? "AuthorizationPermissionMismatch" : "ContainerNotFound"}</Code></Error>`, { status: refused })
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
    return { root, store, account, fetcher, requests, write, read, request, seed, refuse: (status: number, at = "all") => { refused = status; failAt = at } }
  }

  const ordinary = "backup-2020-01-01-000000", large = "backup-large-2020-01-01-000000"
  async function pair() {
    undo = registerTestTypes([largeType])
    const f = await setup()
    await f.seed(ordinary); await f.seed(large, true)
    // A finished split run's ordinary manifest is its final one, with the run's status.
    const first = { ...await f.read(ordinary), RunId: "same-run", CompanionBackup: large, LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "saved", Saved: 1 }], RunStatus: "Success", RunCounts: { saved: 2, failures: 0 } }
    const second = { ...await f.read(large), RunId: "same-run", CompanionBackup: ordinary }
    await f.write(ordinary, "metadata.json", first); await f.write(large, "metadata.json", second)
    return { ...f, first, second }
  }
  it("shows a verified split backup with access-only omissions as completed with incomplete coverage", async () => {
    const f = await pair()
    const skipped = { Folder: "DefenderCustomDetectionRules", Outcome: "skipped", Cause: "permission", Reason: "Needs access" }
    await f.write(ordinary, "metadata.json", { ...f.first, Coverage: "Incomplete", Outcomes: [{ Folder: "DeviceCategories", Outcome: "saved", Saved: 1 }, skipped] })
    const result = await (await history(f.request({ summary: true }))).json()
    expect(result.backups).toHaveLength(1)
    expect(result.backups[0]).toMatchObject({ id: ordinary, status: "Success", coverage: "incomplete", notReadCauses: { DefenderCustomDetectionRules: "permission" }, ordinaryOnlyExport: true })
  })

  it("shows one complete run and adds no requests or payload listings for reciprocal resolution", async () => {
    const f = await pair()
    for (const summary of [true, false]) {
      f.requests.length = 0
      const result = await (await history(f.request({ summary }))).json()
      expect(result.backups).toHaveLength(1)
      expect(result.backups[0]).toMatchObject({ id: ordinary, companionId: large, status: "Success", coverage: "complete", totalPolicies: 2 })
      expect(f.requests.filter(value => value.includes("comp=list") && value.includes("payload"))).toEqual([])
      // Cold summary: 2 lists + 2 manifests, locally 2 property reads. Full adds one ordinary folder list.
      expect(f.requests.length).toBe((azure ? 4 : 6) + (summary ? 0 : 1))
    }
  })
  it("keeps the valid history run successful on Dashboard beside a rejected claimant", async () => {
    const f = await pair()
    const claimant = "backup-large-2020-01-02-000000"
    await f.seed(claimant, true)
    await f.write(claimant, "metadata.json", { ...f.second, BackupFolder: claimant })
    const result = await (await history(f.request({ summary: true }))).json()
    expect(result.backups).toHaveLength(2)
    expect(result.backups.find((row: any) => row.id === ordinary)).toMatchObject({ status: "Success", companionId: large })
    const rows = result.backups.map((row: any) => ({ ...row, tenantId: TENANT, status: normalizeBackupStatus(row), timestamp: new Date(row.timestamp) }))
    expect(backupSummary(rows, [], { since: new Date(0) })).toMatchObject({ stored: 2, successful: 1, failed: 1, successRate: 50 })
  })
  it("does not let a cached successful companion hide a later metadata 403", async () => {
    const f = await pair()
    expect((await (await history(f.request({ summary: true }))).json()).backups[0].status).toBe("Success")
    f.refuse(403, "metadata.json")
    const result = await (await history(f.request({ summary: true }))).json()
    expect(result.backups).toHaveLength(1)
    expect(result.backups[0]).toMatchObject({ status: "incomplete", coverage: "incomplete", warning: expect.stringContaining("unreadable") })
  })
  it.each(["forged", "stale", "mismatched ID", "missing run ID", "missing companion ID", "missing reciprocal ID", "wrong tenant"])("does not join a %s link or report it complete", async scenario => {
    const f = await pair()
    const second = { ...f.second }, first = { ...f.first }
    if (scenario === "forged") second.CompanionBackup = "backup-2020-01-02-000000"
    if (scenario === "stale") second.RunId = "another-run"
    if (scenario === "mismatched ID") second.BackupFolder = "backup-large-2020-01-02-000000"
    if (scenario === "missing run ID") delete second.RunId
    if (scenario === "missing companion ID") delete first.CompanionBackup
    if (scenario === "missing reciprocal ID") delete second.CompanionBackup
    if (scenario === "wrong tenant") second.TenantId = "22222222-2222-2222-2222-222222222222"
    await f.write(ordinary, "metadata.json", first); await f.write(large, "metadata.json", second)
    const result = await (await history(f.request({ summary: true }))).json()
    const row = result.backups.find((entry: any) => entry.id === ordinary)
    expect(row).toMatchObject({ status: "incomplete", coverage: "incomplete", warning: expect.stringContaining("companion does not match") })
    expect(row.companionId).toBeUndefined()
    expect((await validate(f.request({ backupId: ordinary }))).status).toBe(200)
    expect((await download(f.request({ backupId: ordinary }))).status).toBe(409)
  })
  it("rejects a forged unfinished claim instead of joining its run", async () => {
    const f = await pair()
    await f.store.delete(local, LARGE_BACKUP_CONTAINER, `${large}/metadata.json`)
    await f.write(large, ".tenuvault-owner.json", { TenantId: TENANT, RunId: "forged-run", CompanionBackup: ordinary })
    const result = await (await history(f.request({ summary: true }))).json()
    expect(result.backups).toHaveLength(2)
    expect(result.backups.find((row: any) => row.id === ordinary)).toMatchObject({ status: "incomplete", warning: expect.stringContaining("companion does not match") })
  })
  it.each(["running", "cancelled", "crashed", "missing", "403", "failed capture"])("shows incomplete coverage and its per-type cause for a %s companion", async state => {
    const f = await pair()
    if (["running", "crashed", "missing"].includes(state)) {
      await f.store.delete(local, LARGE_BACKUP_CONTAINER, `${large}/metadata.json`)
      if (state === "crashed") await f.write(large, ".tenuvault-owner.json", { TenantId: TENANT, RunId: "same-run", CompanionBackup: ordinary })
      if (state === "running") {
        // A recent claim, as opposed to the old crashed claim.
        const recent = `backup-large-${new Date().toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "")}`
        await f.write(ordinary, "metadata.json", { ...f.first, CompanionBackup: recent })
        await f.write(recent, ".tenuvault-owner.json", { TenantId: TENANT, RunId: "same-run", CompanionBackup: ordinary })
      }
    }
    if (state === "cancelled") await f.write(large, "metadata.json", { ...f.second, Status: "Cancelled", Coverage: "Incomplete" })
    if (state === "403") f.refuse(403)
    if (state === "failed capture") await f.write(ordinary, "metadata.json", { ...f.first, LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "failed", Error: "Expired paging token" }] })
    f.requests.length = 0
    const result = await (await history(f.request({ summary: true }))).json()
    const row = result.backups.find((entry: any) => entry.id === ordinary)
    expect(result.backups).toHaveLength(1)
    expect(row).toMatchObject({ status: "incomplete", coverage: "incomplete", notRead: ["AuthorizationPolicy"], ordinaryOnlyExport: expect.any(Boolean) })
    expect(row.largeProblems[0].reason).toContain(state === "cancelled" ? "cancelled" : state === "running" ? "running" : state === "failed capture" ? "Expired paging token" : state === "403" ? "403" : state === "crashed" ? "crashed" : "missing")
    expect(f.requests.some(value => value.includes("payload"))).toBe(false)
    if (["missing", "403"].includes(state)) expect(f.requests.filter(value => value === `GET /${LARGE_BACKUP_CONTAINER}/${large}/metadata.json`)).toHaveLength(state === "missing" ? 0 : 1)
    expect((await validate(f.request({ backupId: ordinary }))).status).toBe(200)
  })
  it("exports either selected half as one tar and imports both with reciprocal identity intact", async () => {
    const f = await pair()
    for (const backupId of [ordinary, large]) {
      const response = await download(f.request({ backupId }))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/x-tar")
      const archive = join(f.root, `${backupId}.tar`)
      await writeFile(archive, Buffer.from(await response.arrayBuffer()))
      const reviewed = await reviewLargeArchive(archive)
      expect(reviewed).toMatchObject({ backupId: ordinary, companionId: large, count: 2 })
      const imported = new LocalBlobStore(join(f.root, `import-${backupId}`), [Buffer.alloc(32, 9)])
      await importLargeArchive(imported, reviewed)
      for (const [id, metadata] of [[ordinary, f.first], [large, f.second]] as const) {
        const value = JSON.parse((await imported.get(local, backupContainer(id), `${id}/metadata.json`)).data.toString())
        expect(value).toMatchObject({ CompanionBackup: metadata.CompanionBackup, RunId: "same-run", Coverage: "Complete" })
        expect(JSON.parse((await imported.get(local, backupContainer(id), `${id}/.tenuvault-owner.json`)).data.toString())).toMatchObject({ CompanionBackup: metadata.CompanionBackup, RunId: "same-run" })
      }
      expect(JSON.parse((await imported.get(local, BACKUP_CONTAINER, `${ordinary}/DeviceCategories/one.json`)).data.toString()).id).toBe("one")
      await expect(importLargeArchive(imported, reviewed)).rejects.toThrow("already exists")
      const original = f.fetcher.getMockImplementation()!
      f.fetcher.mockImplementation(async (input, init) => {
        const url = new URL(String(input))
        if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "storage" })
        url.hostname = `${local}.blob.core.windows.net`
        return handleLocalBlobRequest(imported, new Request(url, init))
      })
      const rows = (await (await history(f.request({ summary: true }))).json()).backups
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: ordinary, companionId: large, status: "Success", coverage: "complete" })
      expect((await validate(f.request({ backupId: ordinary }))).status).toBe(200)
      f.fetcher.mockImplementation(original)
    }
  })
  it("rejects tampered reciprocal identities and rolls back both halves if the reviewed digest changes", async () => {
    const f = await pair()
    const response = await download(f.request({ backupId: ordinary }))
    const archive = join(f.root, "tampered.tar")
    await writeFile(archive, Buffer.from(await response.arrayBuffer()))
    const reviewed = await reviewLargeArchive(archive)
    const imported = new LocalBlobStore(join(f.root, "rollback"), [Buffer.alloc(32, 9)])
    await expect(importLargeArchive(imported, { ...reviewed, digest: "changed" })).rejects.toThrow("changed since review")
    for (const container of [BACKUP_CONTAINER, LARGE_BACKUP_CONTAINER]) expect(await imported.list(local, container)).toEqual([])
    const bytes = await readFile(archive)
    const position = bytes.indexOf('"RunId":"same-run"', bytes.indexOf(`${large}/metadata.json`))
    expect(position).toBeGreaterThan(0)
    bytes.write('"RunId":"fake-run"', position)
    await writeFile(archive, bytes)
    await expect(reviewLargeArchive(archive)).rejects.toThrow("companion does not match")
  })
  it("requires an explicitly labeled ordinary-only ZIP when the companion is unreadable and imports it independently", async () => {
    const f = await pair(); f.refuse(403)
    expect((await download(f.request({ backupId: ordinary }))).status).toBe(409)
    const response = await download(f.request({ backupId: ordinary, ordinaryOnly: true }))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-disposition")).toContain("ordinary-only.zip")
    const reviewed = await reviewArchive(Buffer.from(await response.arrayBuffer()))
    const imported = new LocalBlobStore(join(f.root, "ordinary-import"), [Buffer.alloc(32, 9)])
    await importConfirmedArchive(imported, reviewed, async () => true, async () => undefined)
    const metadata = JSON.parse((await imported.get(local, BACKUP_CONTAINER, `${ordinary}/metadata.json`)).data.toString())
    expect(metadata).toMatchObject({ Status: "Success", Coverage: "Complete", Export: { kind: "ordinary-only" } })
    expect(metadata.CompanionBackup).toBeUndefined()
    expect(await imported.list(local, LARGE_BACKUP_CONTAINER)).toEqual([])
  })
  it.each(["expired", "in grace", "unowned", "foreign claim", "off", "interrupted", "cancelled", "mismatched", "half-deleted pair", "forged run claim", "forged folder claim"])("cleans or reports owned remnants in both containers: %s", async state => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const now = new Date("2026-11-17T12:00:00Z")
    const date = state === "in grace" ? "2026-11-10" : "2026-11-01"
    const halves = [`backup-${date}-000000`, `backup-large-${date}-000000`]
    for (const id of halves) {
      await f.seed(id, id.includes("large"))
      const metadata = { ...await f.read(id), RunId: "same-run", CompanionBackup: id === halves[0] ? halves[1] : halves[0], ...(id === halves[0] ? { LargeBackupOutcomes: [] } : {}), ...(["cancelled", "forged run claim", "forged folder claim"].includes(state) ? { Status: "Cancelled", Coverage: "Incomplete" } : {}), ...(state === "mismatched" && id === halves[1] ? { RunId: "other-run" } : {}) }
      await f.write(id, "metadata.json", metadata)
      // Simulate a crash or a delete that already removed the manifest.
      if (!["interrupted", "cancelled", "mismatched", "half-deleted pair", "forged run claim", "forged folder claim"].includes(state)) await f.store.delete(local, backupContainer(id), `${id}/metadata.json`)
      await f.write(id, ".tenuvault-owner.json", { ...(state === "unowned" ? {} : { Source: "TenuVault Desktop" }), TenantId: state === "foreign claim" ? CLIENT : TENANT, RunId: ["interrupted", "cancelled", "mismatched", "half-deleted pair", "forged folder claim"].includes(state) ? metadata.RunId : id, ...(state === "forged folder claim" ? { BackupFolder: "backup-2000-01-01-000000" } : {}), ...(id.includes("large") ? { LargeInventory: { version: 1 }, CompanionBackup: halves[0] } : { CompanionBackup: halves[1] }) })
    }
    if (state === "half-deleted pair") for (const blob of await f.store.list(local, BACKUP_CONTAINER, `${halves[0]}/`)) await f.store.delete(local, BACKUP_CONTAINER, blob.name)
    const rows = await (await history(f.request({ summary: true }))).json()
    if (!["foreign claim", "interrupted"].includes(state)) expect(rows.warnings.join(" ")).toMatch(/Backup remnants: .*at least .*recovery days/)
    if (state === "in grace") expect(rows.warnings.join(" ")).toContain("2 owned")
    if (["unowned", "forged run claim", "forged folder claim"].includes(state)) expect(rows.warnings.join(" ")).toContain("2 unverified")
    let interrupt = state === "interrupted"
    const original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (input, init) => {
      if (interrupt && init?.method === "DELETE" && String(input).includes("DeviceCategories/")) {
        interrupt = false
        return new Response("Delete interrupted", { status: 403 })
      }
      return original(input, init)
    })
    const run = async (at: Date) => {
      const engine = new BackupEngine({ now: () => at, fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), retentionDays: () => state === "off" ? 0 : 1 })
      return engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    }
    let job = await run(now)
    if (state === "interrupted") {
      expect((await f.store.list(local, BACKUP_CONTAINER, `${halves[0]}/`)).some(blob => blob.name.endsWith(".tenuvault-owner.json"))).toBe(true)
      expect(job.log.join(" ")).toContain("Could not remove old backups")
      const interruptedRows = await (await history(f.request({ summary: true }))).json()
      expect(interruptedRows.warnings.join(" ")).toContain("2 owned")
      job = await run(new Date(now.getTime() + 1000))
    }
    const deleted = ["expired", "interrupted", "cancelled", "mismatched", "half-deleted pair"].includes(state)
    for (const id of halves) {
      const remaining = await f.store.list(local, backupContainer(id), backupBlobName(`${id}/`))
      expect(remaining.length > 0).toBe(!deleted)
      if (deleted) expect(await f.store.list(local, backupContainer(id), `${id}/`)).toHaveLength(0)
    }
    if (["unowned", "foreign claim", "forged run claim", "forged folder claim"].includes(state)) expect(job.log.join(" ")).toMatch(/kept 1 unverified halves \([1-9]\d* bytes\)/)
    if (state === "off") expect(f.requests.filter(value => value.startsWith("DELETE"))).toHaveLength(0)
    else expect(job.log.join(" ")).toMatch(/Remnant cleanup: deleted \d+ halves \(\d+ bytes\); kept \d+ owned halves \(\d+ bytes\)/)
    if (state === "in grace") {
      job = await run(new Date("2026-11-19T12:00:00Z"))
      for (const id of halves) expect(await f.store.list(local, backupContainer(id), `${id}/`)).toHaveLength(0)
    }
  })
  it("keeps a complete ordinary half whose companion is missing while it holds the newest complete copy of a type", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const ordinaryId = "backup-2026-11-01-000000", largeId = "backup-large-2026-11-01-000000"
    const snapshot = { id: "one", displayName: "Terms" }
    await f.write(ordinaryId, "TermsAndConditions/one.json", snapshot)
    await f.write(ordinaryId, "metadata.json", { BackupFolder: ordinaryId, TenantId: TENANT, RunId: "same-run", Status: "Success", Failures: 0, Coverage: "Complete", Scope: { Included: ["TermsAndConditions"], Excluded: [] }, Items: { "TermsAndConditions/one": { file: "one.json", hash: snapshotHash(snapshot) } }, ItemCounts: { TermsAndConditions: 1, TotalPolicies: 1 }, CompanionBackup: largeId, LargeBackupOutcomes: [] })
    await f.write(ordinaryId, ".tenuvault-owner.json", { Source: "TenuVault Desktop", TenantId: TENANT, RunId: "same-run", CompanionBackup: largeId })
    // The newer complete run leaves terms and conditions out of its scope, so it holds no copy of them.
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune"] }), retentionDays: () => 1 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceCategories").map(type => type.folder) } }))
    expect(job.log.join(" ")).toContain("Remnant cleanup")
    expect((await f.store.list(local, BACKUP_CONTAINER, `${ordinaryId}/`)).some(blob => blob.name.endsWith("TermsAndConditions/one.json"))).toBe(true)
    expect(f.requests.filter(value => value.startsWith("DELETE") && value.includes(ordinaryId))).toHaveLength(0)
  })
  it("keeps an incomplete remnant while one of its types is the newest complete copy", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const ordinaryId = "backup-2026-11-01-000000", largeId = "backup-large-2026-11-01-000000"
    const snapshot = { id: "one", displayName: "Terms" }
    await f.write(ordinaryId, "TermsAndConditions/one.json", snapshot)
    // Terms and conditions were read in full; scope tags failed, so the half as a whole is incomplete.
    await f.write(ordinaryId, "metadata.json", { BackupFolder: ordinaryId, TenantId: TENANT, RunId: "same-run", Status: "CompletedWithWarnings", Failures: 1, Coverage: "Incomplete", Scope: { Included: ["TermsAndConditions", "ScopeTags"], Excluded: [] }, FailedTypes: ["ScopeTags"], Outcomes: [{ Folder: "TermsAndConditions", Outcome: "saved", Saved: 1 }, { Folder: "ScopeTags", Outcome: "failed", Error: "Read failed" }], Items: { "TermsAndConditions/one": { file: "one.json", hash: snapshotHash(snapshot) } }, ItemCounts: { TermsAndConditions: 1, TotalPolicies: 1 }, CompanionBackup: largeId, LargeBackupOutcomes: [] })
    await f.write(ordinaryId, ".tenuvault-owner.json", { Source: "TenuVault Desktop", TenantId: TENANT, RunId: "same-run", CompanionBackup: largeId })
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune"] }), retentionDays: () => 1 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceCategories").map(type => type.folder) } }))
    expect(job.log.join(" ")).toContain("Remnant cleanup")
    expect((await f.store.list(local, BACKUP_CONTAINER, `${ordinaryId}/`)).some(blob => blob.name.endsWith("TermsAndConditions/one.json"))).toBe(true)
  })
  it("keeps a standalone backup with warnings while it holds a type's newest complete copy, and lets it cover older copies", async () => {
    const f = await setup()
    const olderId = "backup-2026-10-01-000000", newerId = "backup-2026-11-01-000000"
    const snapshot = { id: "one", displayName: "Terms" }
    for (const id of [olderId, newerId]) {
      await f.write(id, "TermsAndConditions/one.json", snapshot)
      await f.write(id, ".tenuvault-owner.json", { Source: "TenuVault Desktop", TenantId: TENANT, RunId: `run-${id}` })
    }
    const items = { "TermsAndConditions/one": { file: "one.json", hash: snapshotHash(snapshot) } }
    await f.write(olderId, "metadata.json", { BackupFolder: olderId, TenantId: TENANT, RunId: `run-${olderId}`, Status: "Success", Failures: 0, Coverage: "Complete", Scope: { Included: ["TermsAndConditions"], Excluded: [] }, Outcomes: [{ Folder: "TermsAndConditions", Outcome: "saved", Saved: 1 }], Items: items, ItemCounts: { TermsAndConditions: 1, TotalPolicies: 1 } })
    // Terms and conditions were read in full; scope tags failed, so the run finished with warnings.
    await f.write(newerId, "metadata.json", { BackupFolder: newerId, TenantId: TENANT, RunId: `run-${newerId}`, Status: "CompletedWithWarnings", Failures: 1, Coverage: "Incomplete", Scope: { Included: ["TermsAndConditions", "ScopeTags"], Excluded: [] }, FailedTypes: ["ScopeTags"], Outcomes: [{ Folder: "TermsAndConditions", Outcome: "saved", Saved: 1 }, { Folder: "ScopeTags", Outcome: "failed", Error: "Read failed" }], Items: items, ItemCounts: { TermsAndConditions: 1, TotalPolicies: 1 } })
    // The current run leaves terms and conditions out of its scope, so it holds no copy of them.
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune"] }), retentionDays: () => 1 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceCategories").map(type => type.folder) } }))
    expect(job.status, job.exception).toBe("Completed")
    expect((await f.store.list(local, BACKUP_CONTAINER, `${newerId}/`)).some(blob => blob.name.endsWith("TermsAndConditions/one.json"))).toBe(true)
    expect(await f.store.list(local, BACKUP_CONTAINER, `${olderId}/`)).toHaveLength(0)
  })
  it("keeps an older backup's copy of a type that failed in a newer backup with warnings", async () => {
    const f = await setup()
    const olderId = "backup-2026-10-01-000000", newerId = "backup-2026-11-01-000000"
    const snapshot = { id: "one", displayName: "Tag" }
    await f.write(olderId, "ScopeTags/one.json", snapshot)
    await f.write(olderId, ".tenuvault-owner.json", { Source: "TenuVault Desktop", TenantId: TENANT, RunId: `run-${olderId}` })
    await f.write(olderId, "metadata.json", { BackupFolder: olderId, TenantId: TENANT, RunId: `run-${olderId}`, Status: "Success", Failures: 0, Coverage: "Complete", Scope: { Included: ["ScopeTags"], Excluded: [] }, Outcomes: [{ Folder: "ScopeTags", Outcome: "saved", Saved: 1 }], Items: { "ScopeTags/one": { file: "one.json", hash: snapshotHash(snapshot) } }, ItemCounts: { ScopeTags: 1, TotalPolicies: 1 } })
    await f.write(newerId, ".tenuvault-owner.json", { Source: "TenuVault Desktop", TenantId: TENANT, RunId: `run-${newerId}` })
    // The newer run could not read scope tags, so it holds no complete copy of them.
    await f.write(newerId, "metadata.json", { BackupFolder: newerId, TenantId: TENANT, RunId: `run-${newerId}`, Status: "CompletedWithWarnings", Failures: 1, Coverage: "Incomplete", Scope: { Included: ["ScopeTags"], Excluded: [] }, FailedTypes: ["ScopeTags"], Outcomes: [{ Folder: "ScopeTags", Outcome: "failed", Error: "Read failed" }], Items: {}, ItemCounts: { ScopeTags: 0, TotalPolicies: 0 } })
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune"] }), retentionDays: () => 1 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceCategories").map(type => type.folder) } }))
    expect(job.status, job.exception).toBe("Completed")
    expect((await f.store.list(local, BACKUP_CONTAINER, `${olderId}/`)).some(blob => blob.name.endsWith("ScopeTags/one.json"))).toBe(true)
  })
  it("reports warnings, live and in its final manifest, when the large inventory commit fails with a server error", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    // The large snapshots and their index are written; the large manifest fails with a server error,
    // not the 403 or 404 that means large storage is not provisioned.
    f.refuse(500, "metadata.json")
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), retentionDays: () => 0 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    const final = await f.read(job.backupFolder!)
    expect(final.RunStatus).toBe("CompletedWithWarnings")
    expect(final.RunCounts.failures).toBeGreaterThan(0)
    expect(final.LargeBackupOutcomes).toEqual(expect.arrayContaining([expect.objectContaining({ Folder: "AuthorizationPolicy", Outcome: "failed" })]))
    expect(job.results?.types.find(type => type.folder === "AuthorizationPolicy")).toMatchObject({ state: "unreadable", reason: "The directory inventory could not be saved to large backup storage." })
    // The final ordinary manifest landed, so the run is confirmed: its audit reports warnings, not uncertain.
    expect(job.status).toBe("Completed")
    expect(job.commitUnconfirmed).toBeFalsy()
    expect(job.failures).toBeGreaterThan(0)
  })
  it("reports warnings, not a failure, when an empty ordinary half stands and the large inventory commit fails", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const original = f.fetcher.getMockImplementation()!
    // Both selected collections are empty, so nothing is saved, but the ordinary half is read in full.
    f.fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === "graph.microsoft.com" && (url.pathname === "/v1.0/synthetic" || url.pathname === "/beta/deviceManagement/deviceCategories")) return Response.json({ value: [] })
      return original(input, init)
    })
    f.refuse(500, "metadata.json")
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), retentionDays: () => 0 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    expect(job.status, job.exception).toBe("Completed")
    expect((await f.read(job.backupFolder!)).RunStatus).toBe("CompletedWithWarnings")
  })
  it("fails a split run whose ordinary reads failed when its large uploads have no committed inventory", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const original = f.fetcher.getMockImplementation()!
    // Every ordinary object read fails; the large snapshots upload, but their manifest commit fails.
    f.fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === "graph.microsoft.com" && url.pathname.startsWith("/beta/deviceManagement/deviceCategories/")) return Response.json({ error: { code: "BadRequest", message: "Bad request" } }, { status: 400 })
      return original(input, init)
    })
    f.refuse(500, "metadata.json")
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), retentionDays: () => 0 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    expect(job.status).toBe("Failed")
    expect((await f.read(job.backupFolder!)).RunStatus).toBe("Failed")
  })
  it("reports a large-only commit that gets no answer with the inventory-save reason", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (init?.method === "PUT" && url.pathname.startsWith(`/${LARGE_BACKUP_CONTAINER}`) && url.pathname.endsWith("metadata.json")) throw new TypeError("fetch failed")
      return original(input, init)
    })
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["entra"] }), retentionDays: () => 0 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "AuthorizationPolicy").map(type => type.folder) } }))
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("The directory inventory could not be saved to large backup storage.")
    expect(job.commitUnconfirmed).toBe(true)
  })
  it.each([403, 500])("fails a split run with nothing read when its ordinary list is refused and its large inventory commit gets %s", async commitStatus => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === "graph.microsoft.com" && url.pathname === "/beta/deviceManagement/deviceCategories") return Response.json({ error: { code: "Forbidden", message: "Forbidden" } }, { status: 403 })
      return original(input, init)
    })
    // The large snapshots upload; their manifest commit then fails, so the large type holds nothing.
    f.refuse(commitStatus, "metadata.json")
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), retentionDays: () => 0 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    const final = await f.read(job.backupFolder!)
    expect(final.RunStatus).toBe("Failed")
    expect(job.status).toBe("Failed")
    const large = (final.LargeBackupOutcomes as Array<{ Folder: string; Saved?: number }>).find(entry => entry.Folder === "AuthorizationPolicy")
    expect(large?.Saved ?? 0).toBe(0)
  })
  it("saves a split run's own record when storage refuses replacing its early ordinary manifest", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const original = f.fetcher.getMockImplementation()!
    let ordinaryManifestWrites = 0
    // An immutability policy accepts the early manifest and refuses replacing it.
    f.fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (init?.method === "PUT" && url.pathname.startsWith(`/${BACKUP_CONTAINER}/`) && url.pathname.endsWith("/metadata.json") && ++ordinaryManifestWrites > 1) {
        return new Response("<Error><Code>BlobImmutableDueToPolicy</Code></Error>", { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
      }
      return original(input, init)
    })
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), retentionDays: () => 0 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    expect(job.status, job.exception).toBe("Completed")
    expect(job.commitUnconfirmed).toBeFalsy()
    const early = await f.read(job.backupFolder!)
    expect(early.RunStatus).toBeUndefined()
    expect(await f.read(job.backupFolder!, "run-status.json")).toMatchObject({ BackupFolder: job.backupFolder, TenantId: TENANT, RunId: early.RunId, RunStatus: "Success", RunCounts: { failures: 0 }, EndTime: expect.any(String), Duration: expect.any(String), DurationSeconds: expect.any(Number) })
    expect((await validate(f.request({ backupId: job.backupFolder }))).status).toBe(200)
    // History and the full export read the run's final result from its record.
    const rows = await (await history(f.request({ summary: true }))).json()
    expect(rows.backups.find((entry: any) => entry.id === job.backupFolder)).toMatchObject({ ordinaryOnlyExport: false })
    const archive = await download(f.request({ backupId: job.backupFolder }))
    expect(archive.status).toBe(200)
    expect(archive.headers.get("content-type")).toBe("application/x-tar")
    const bytes = Buffer.from(await archive.arrayBuffer()).toString("latin1")
    expect(bytes).not.toContain("run-status.json")
    expect(bytes).toMatch(/"RunStatus":\s*"Success"/)
  })
  it("keeps a permission refusal of the final ordinary manifest a failure, without a run record", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    const original = f.fetcher.getMockImplementation()!
    let ordinaryManifestWrites = 0
    // A path-scoped permission refuses replacing the manifest but would allow creating another file.
    f.fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (init?.method === "PUT" && url.pathname.startsWith(`/${BACKUP_CONTAINER}/`) && url.pathname.endsWith("/metadata.json") && ++ordinaryManifestWrites > 1) {
        return new Response("<Error><Code>AuthorizationPermissionMismatch</Code></Error>", { status: 403, headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" } })
      }
      return original(input, init)
    })
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), retentionDays: () => 0 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    expect(job.status).toBe("Failed")
    expect((await f.store.list(local, BACKUP_CONTAINER, `${job.backupFolder}/`)).some(blob => blob.name.endsWith("run-status.json"))).toBe(false)
  })
  it("leaves a large-only run unconfirmed when its own manifest commit gets a server error", async () => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    f.refuse(500, "metadata.json")
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["entra"] }), retentionDays: () => 0 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "AuthorizationPolicy").map(type => type.folder) } }))
    expect(job.backupFolder).toMatch(/^backup-large-/)
    expect(job.commitUnconfirmed).toBe(true)
    expect(job.status).toBe("Failed")
    // A server outage is reported as what it was, without the provisioning guidance.
    expect(job.exception).toContain("Storage returned 500")
    expect(job.exception).not.toContain("Storage not provisioned for large backups")
  })
  it.each([403, 404])("fails a large-only run whose only manifest storage refuses with %s, with the provisioning guidance", async status => {
    undo = registerTestTypes([largeType])
    const f = await setup()
    f.refuse(status, "metadata.json")
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["entra"] }), retentionDays: () => 0 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "AuthorizationPolicy").map(type => type.folder) } }))
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("Storage not provisioned for large backups")
  })
  it("never lets a legacy manifest that says its coverage is incomplete replace an older complete copy", async () => {
    const f = await setup()
    const olderId = "backup-2026-10-01-000000", newerId = "backup-2026-11-01-000000"
    const snapshot = { id: "one", displayName: "Tag" }
    for (const id of [olderId, newerId]) {
      await f.write(id, "ScopeTags/one.json", snapshot)
      await f.write(id, ".tenuvault-owner.json", { Source: "TenuVault Desktop", TenantId: TENANT, RunId: `run-${id}` })
    }
    const items = { "ScopeTags/one": { file: "one.json", hash: snapshotHash(snapshot) } }
    await f.write(olderId, "metadata.json", { BackupFolder: olderId, TenantId: TENANT, RunId: `run-${olderId}`, Status: "Success", Failures: 0, Coverage: "Complete", Scope: { Included: ["ScopeTags"], Excluded: [] }, Items: items, ItemCounts: { ScopeTags: 1, TotalPolicies: 1 } })
    // No per-type outcomes, and a coverage that says it is incomplete, as in an inconsistent imported manifest.
    await f.write(newerId, "metadata.json", { BackupFolder: newerId, TenantId: TENANT, RunId: `run-${newerId}`, Status: "Success", Failures: 0, Coverage: "Incomplete", Scope: { Included: ["ScopeTags"], Excluded: [] }, Items: items, ItemCounts: { ScopeTags: 1, TotalPolicies: 1 } })
    const engine = new BackupEngine({ now: () => new Date("2026-11-17T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune"] }), retentionDays: () => 1 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceCategories").map(type => type.folder) } }))
    expect(job.status, job.exception).toBe("Completed")
    expect((await f.store.list(local, BACKUP_CONTAINER, `${olderId}/`)).some(blob => blob.name.endsWith("ScopeTags/one.json"))).toBe(true)
  })
  it("shows a split run's final result and timing from its record when the early ordinary manifest stayed", async () => {
    const f = await pair()
    const { RunStatus: _status, RunCounts: _counts, ...early } = f.first
    await f.write(ordinary, "metadata.json", { ...early, LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "failed", Error: "The backup stopped before this type was read in full." }], DurationSeconds: 5 })
    await f.write(ordinary, "run-status.json", { BackupFolder: ordinary, TenantId: TENANT, RunId: "same-run", AuthMode: early.AuthMode, CompletedAt: "2020-01-01T00:45:00.000Z", DurationSeconds: 2700, RunStatus: "Success", RunCounts: { saved: 2, failures: 0 }, LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "saved", Saved: 1 }] })
    const rows = await (await history(f.request({ summary: true }))).json()
    expect(rows.backups.find((entry: any) => entry.id === ordinary)).toMatchObject({ duration: 2700, ordinaryOnlyExport: false })
    // A record from another run changes nothing.
    await f.write(ordinary, "run-status.json", { BackupFolder: ordinary, TenantId: TENANT, RunId: "other-run", AuthMode: early.AuthMode, DurationSeconds: 2700, RunStatus: "Success", LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "saved", Saved: 1 }] })
    const again = await (await history(f.request({ summary: true }))).json()
    expect(again.backups.find((entry: any) => entry.id === ordinary)).toMatchObject({ duration: 5, ordinaryOnlyExport: true })
  })
  it("asks to retry the full download when a split run's record cannot be read, instead of calling the run incomplete", async () => {
    const f = await pair()
    const { RunStatus: _status, RunCounts: _counts, ...early } = f.first
    await f.write(ordinary, "metadata.json", { ...early, LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "failed", Error: "The backup stopped before this type was read in full." }] })
    await f.write(ordinary, "run-status.json", { BackupFolder: ordinary, TenantId: TENANT, RunId: "same-run", AuthMode: early.AuthMode, RunStatus: "Success", LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "saved", Saved: 1 }] })
    const original = f.fetcher.getMockImplementation()!
    let failRecord = true
    f.fetcher.mockImplementation(async (input, init) => {
      if (failRecord && String(input).includes("run-status.json")) return new Response("<Error><Code>ServerBusy</Code></Error>", { status: 500 })
      return original(input, init)
    })
    // History keeps the full download offered while the record cannot be read.
    const rows = await (await history(f.request({ summary: true }))).json()
    expect(rows.backups.find((entry: any) => entry.id === ordinary)).toMatchObject({ ordinaryOnlyExport: false })
    f.requests.length = 0
    const refused = await download(f.request({ backupId: ordinary }))
    expect(refused.status).toBe(503)
    // The retry answer comes before any companion lookup.
    expect(f.requests.some(value => value.includes(`${large}/metadata.json`))).toBe(false)
    expect((await refused.json()).error).toContain("Try again in a moment")
    // An explicit ordinary-only copy reads neither the record nor the companion.
    f.requests.length = 0
    const ordinaryCopy = await download(f.request({ backupId: ordinary, ordinaryOnly: true }))
    expect(ordinaryCopy.status).toBe(200)
    expect(f.requests.some(value => value.includes("run-status.json") || value.includes(`${large}/metadata.json`))).toBe(false)
    failRecord = false
    const archive = await download(f.request({ backupId: ordinary }))
    expect(archive.status).toBe(200)
    expect(archive.headers.get("content-type")).toBe("application/x-tar")
  })
  it("treats a split run's record that is not valid JSON as missing, in history and downloads", async () => {
    const f = await pair()
    const { RunStatus: _status, RunCounts: _counts, ...early } = f.first
    await f.write(ordinary, "metadata.json", { ...early, LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "failed", Error: "The backup stopped before this type was read in full." }] })
    await f.store.put(local, BACKUP_CONTAINER, backupBlobName(`${ordinary}/run-status.json`), Buffer.from("{oops"), "application/json")
    const rows = await (await history(f.request({ summary: true }))).json()
    expect(rows.backups.find((entry: any) => entry.id === ordinary)).toMatchObject({ ordinaryOnlyExport: true })
    const refused = await download(f.request({ backupId: ordinary }))
    expect(refused.status).toBe(409)
  })
  if (!azure) it.each(["fetch", "body"])("keeps the full download offered when a local run record stalls during %s past the history budget", async stage => {
    const f = await pair()
    const { RunStatus: _status, RunCounts: _counts, ...early } = f.first
    await f.write(ordinary, "metadata.json", { ...early, LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "failed" }] })
    const budget = new AbortController()
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 15_000 ? budget.signal : realTimeout(ms))
    const original = f.fetcher.getMockImplementation()!
    let reading = false
    f.fetcher.mockImplementation(async (input, init) => {
      if (!String(input).endsWith("/run-status.json")) return original(input, init)
      if (stage === "body") return new Response(new ReadableStream({ pull: () => { reading = true; budget.abort() } }))
      reading = true
      budget.abort()
      return new Promise<Response>(() => {})
    })
    try {
      let rows: any
      const result = history(f.request({ summary: true })).then(async response => { rows = await response.json() })
      await vi.waitFor(() => {
        expect(reading).toBe(true)
        expect(rows?.backups.find((entry: any) => entry.id === ordinary)).toMatchObject({ ordinaryOnlyExport: false })
      })
      await result
    } finally { timeout.mockRestore() }
  })
  it.each(["discovered", "linked"])("offers both downloads while the %s companion returns a transient 503", async discovery => {
    const f = await pair()
    f.refuse(503, discovery === "discovered" ? "metadata.json" : "all")
    const rows = await (await history(f.request({ summary: true }))).json()
    const row = rows.backups.find((entry: any) => entry.id === ordinary)
    expect(row).toMatchObject({ ordinaryOnlyExport: false, ordinaryOnlyAvailable: true, coverage: "incomplete" })
    const refused = await download(f.request({ backupId: ordinary, largeInventory: true }))
    expect(refused.status).toBe(503)
    const ordinaryCopy = await download(f.request({ backupId: ordinary, ordinaryOnly: true }))
    expect(ordinaryCopy.headers.get("content-disposition")).toContain("ordinary-only.zip")
    f.refuse(0)
    const archive = await download(f.request({ backupId: ordinary, largeInventory: true }))
    expect(archive.headers.get("content-type")).toBe("application/x-tar")
    await archive.body?.cancel()
  })
  it("offers both downloads when a discovery 503 exhausts the companion lookup budget", async () => {
    const f = await pair()
    for (let day = 2; day <= 9; day++) {
      const id = `backup-2020-01-0${day}-000000`, companion = `backup-large-2020-01-0${day}-000000`
      await f.seed(id); await f.seed(companion, true)
      await f.write(id, "metadata.json", { ...f.first, BackupFolder: id, RunId: id, CompanionBackup: companion })
      await f.write(companion, "metadata.json", { ...f.second, BackupFolder: companion, RunId: id, CompanionBackup: id })
    }
    f.refuse(503)
    const rows = await (await history(f.request({ summary: true }))).json()
    expect(rows.backups).toHaveLength(9)
    const companionReads = f.requests.filter(value => value.startsWith(`GET /${LARGE_BACKUP_CONTAINER}/`) && value.endsWith("/metadata.json"))
    expect(companionReads).toHaveLength(8)
    const skipped = rows.backups.filter((row: any) => !companionReads.includes(`GET /${LARGE_BACKUP_CONTAINER}/${row.id.replace("backup-", "backup-large-")}/metadata.json`))
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ ordinaryOnlyExport: false, ordinaryOnlyAvailable: true, coverage: "incomplete", warning: expect.stringContaining("lookup recovery budget was reached") })
    const refused = await download(f.request({ backupId: skipped[0].id, largeInventory: true }))
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ ordinaryOnlyAvailable: true })
  })
  it("asks to retry the full download when the large half of a split run cannot be read in time", async () => {
    const f = await pair()
    const original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes(`${large}/metadata.json`)) return new Response("<Error><Code>ServerBusy</Code></Error>", { status: 503 })
      return original(input, init)
    })
    const refused = await download(f.request({ backupId: ordinary }))
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("other half of this run"), ordinaryOnlyAvailable: true })
  })
  it("refuses a download from the large half whose ordinary half does not match, without reading its record", async () => {
    const f = await pair()
    const { RunStatus: _status, RunCounts: _counts, ...early } = f.first
    await f.write(ordinary, "metadata.json", { ...early, RunId: "another-run" })
    const original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (input, init) => String(input).includes("run-status.json") ? new Response("busy", { status: 500 }) : original(input, init))
    const refused = await download(f.request({ backupId: large }))
    expect(refused.status).toBe(409)
    expect(f.fetcher.mock.calls.some(([input]) => String(input).includes("run-status.json"))).toBe(false)
  })
  it("answers within the deadline when the large half never answers, even from storage that ignores the signal", async () => {
    const f = await pair()
    const original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (input, init) => String(input).includes(`${large}/metadata.json`) ? new Promise<Response>(() => {}) : original(input, init))
    const started = Date.now()
    const refused = await download(f.request({ backupId: ordinary }))
    expect(refused.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(30_000)
  }, 60_000)
  it("protects a valid complete run inside retention", async () => {
    const f = await pair()
    const engine = new BackupEngine({ now: () => new Date("2020-01-01T12:00:00Z"), fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), retentionDays: () => 1 })
    await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    for (const id of [ordinary, large]) expect(await f.read(id)).toMatchObject({ RunId: "same-run", Status: "Success" })
    expect(f.requests.filter(value => value.startsWith("DELETE"))).toHaveLength(0)
  })
  it.each(["complete", "unreadable", "mismatched", "orphan"])("retains a %s mixed run as one unit or preserves it for recovery", async state => {
    const f = await pair()
    if (state === "unreadable") f.refuse(403, "metadata.json")
    if (state === "mismatched") await f.write(large, "metadata.json", { ...f.second, RunId: "wrong-run" })
    if (state === "orphan") for (const blob of await f.store.list(local, BACKUP_CONTAINER, `${ordinary}/`)) await f.store.delete(local, BACKUP_CONTAINER, blob.name)
    const engine = new BackupEngine({ fetch: f.fetcher, getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["intune", "entra"] }), retentionDays: () => 1 })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account, scope: { excluded: INTUNE_TYPES.filter(type => !["DeviceCategories", "AuthorizationPolicy"].includes(type.folder)).map(type => type.folder) } }))
    expect(job.status, job.exception).toBe("Completed")
    expect((await f.store.list(local, LARGE_BACKUP_CONTAINER, `${large}/`)).length > 0).toBe(state !== "complete")
    if (state !== "orphan") expect((await f.store.list(local, BACKUP_CONTAINER, `${ordinary}/`)).length > 0).toBe(state !== "complete")
    if (state === "orphan") {
      const result = await (await history(f.request())).json()
      expect(result.backups.find((entry: any) => entry.id === large)).toMatchObject({ status: "incomplete", notRead: ["AuthorizationPolicy"], largeProblems: [{ folder: "AuthorizationPolicy", reason: expect.stringContaining("orphaned") }], warning: expect.stringContaining("orphaned") })
    }
  })
})
