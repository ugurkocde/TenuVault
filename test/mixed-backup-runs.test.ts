import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
    const first = { ...await f.read(ordinary), RunId: "same-run", CompanionBackup: large, LargeBackupOutcomes: [{ Folder: "AuthorizationPolicy", Outcome: "saved", Saved: 1 }] }
    const second = { ...await f.read(large), RunId: "same-run", CompanionBackup: ordinary }
    await f.write(ordinary, "metadata.json", first); await f.write(large, "metadata.json", second)
    return { ...f, first, second }
  }
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
    if (["missing", "403"].includes(state)) expect(f.requests.filter(value => value === `GET /${LARGE_BACKUP_CONTAINER}/${large}/metadata.json`)).toHaveLength(1)
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
