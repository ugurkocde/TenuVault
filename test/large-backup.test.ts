vi.hoisted(() => vi.stubGlobal("__TV_LAB_EXPANDED_ENTRA__", true))

import { createHash } from "node:crypto"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { backupBlobName, LARGE_BACKUP_CONTAINER } from "../src/shared/backup-storage"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { POST as history } from "../src/portal/app/api/list-backups/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { fixture, scriptedGraph } from "./helpers/backup-fixture"
import { BackupEngine } from "../src/main/backup/engine"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { jwt, registerTestTypes, TENANT, CLIENT, testType } from "./helpers/backup-fixture"
import { fakeGraph } from "./helpers/fake-graph"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { indexPath, largeIndexes } from "../src/shared/large-backup"

const type = testType("AuthorizationPolicy", "syntheticUsers", { volume: "large", apiVersion: "v1.0", inventory: true, listOnly: true, listQuery: "$top=999&$select=id,displayName", keep: ["displayName"] })
let undo: (() => void) | undefined
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); undo?.(); undo = undefined; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

for (const azure of [false, true]) describe(azure ? "Azure blob protocol" : "encrypted local store", () => {
  async function setup(options: Partial<Parameters<typeof fakeGraph>[0]> = {}, extra = {}) {
    undo = registerTestTypes([{ ...type, ...extra }])
    const graph = await fakeGraph({ collections: { syntheticUsers: { count: 23 } }, pageSize: 7, ...options })
    const root = await mkdtemp(join(tmpdir(), "tv-large-")); roots.push(root)
    const store = new LocalBlobStore(root, [Buffer.alloc(32, 7)])
    const account = azure ? "syntheticstore" : `tvlocal-${TENANT}`
    // Azure requests cross the real blob REST adapter, backed by the same test emulator used locally.
    const local = `tvlocal-${TENANT}`
    const requests: string[] = []
    const engine = new BackupEngine({
      fetch: (async (input, init) => {
        const url = new URL(String(input))
        if (url.hostname === "graph.microsoft.com") return graph.fetch(input, init)
        const target = new URL(url); target.hostname = `${local}.blob.core.windows.net`
        requests.push(`${init?.method ?? "GET"} ${url.pathname}`)
        return handleLocalBlobRequest(store, new Request(target, init))
      }) as typeof fetch,
      getToken: async () => jwt({ scp: "Policy.Read.All" }),
      services: () => ({ services: ["entra"], areas: {} }),
      retentionDays: () => 1,
    })
    const start = (tenantId = TENANT) => engine.start({ tenantId, clientId: CLIENT, storageAccountName: account, scope: { excluded: [] } })
    const metadata = async (folder: string) => JSON.parse((await store.get(local, LARGE_BACKUP_CONTAINER, backupBlobName(`${folder}/metadata.json`))).data.toString())
    return { graph, engine, store, local, start, metadata, requests }
  }
  it("streams selected pages and publishes a bounded sorted index after all reads", async () => {
    const f = await setup({ collections: { syntheticUsers: { count: 23, members: { object: 0, count: 53 } } } }, { extras: [{ property: "members", ids: true, path: (id: string) => `syntheticUsers/${id}/members?$select=id&$top=999` }] })
    try {
      const job = await f.engine.waitForJob(f.start())
      expect(job.status, job.exception).toBe("Completed")
      const metadata = await f.metadata(job.backupFolder!)
      expect(metadata.Items).toEqual({})
      expect(largeIndexes(metadata).AuthorizationPolicy).toEqual({ version: 1, count: 23, shards: 1, complete: true })
      const entries = JSON.parse((await f.store.get(f.local, LARGE_BACKUP_CONTAINER, backupBlobName(`${job.backupFolder}/${indexPath(type.folder, 0)}`))).data.toString())
      expect(entries).toHaveLength(23)
      const snapshot = JSON.parse((await f.store.get(f.local, LARGE_BACKUP_CONTAINER, backupBlobName(`${job.backupFolder}/${type.folder}/${f.graph.id(0)}.json`))).data.toString())
      expect(snapshot.members).toMatchObject({ count: 53, shards: 1, complete: true })
      expect(f.graph.stats().requests).toBe(34)
    } finally { await f.graph.close() }
  })
  it("never publishes a saved prefix when a paging token expires", async () => {
    const f = await setup({ expireAt: 2 })
    try {
      await f.store.createContainer(f.local, LARGE_BACKUP_CONTAINER)
      const old = "backup-large-2020-01-01-000000"
      await f.store.put(f.local, LARGE_BACKUP_CONTAINER, backupBlobName(`${old}/metadata.json`), Buffer.from(JSON.stringify({ TenantId: TENANT, Status: "Success", Failures: 0, Scope: { Included: [type.folder] }, Items: {} })), "application/json")
      const job = await f.engine.waitForJob(f.start())
      const metadata = await f.metadata(job.backupFolder!)
      expect(metadata.LargeItems.AuthorizationPolicy.complete).toBe(false)
      expect(metadata.Coverage).toBe("Incomplete")
      expect(metadata.FailedTypes).toContain(type.folder)
      expect(metadata.ItemCounts.AuthorizationPolicy).toBe(7)
      expect((await f.store.list(f.local, LARGE_BACKUP_CONTAINER, `${old}/`)).length).toBe(1)
      expect(f.requests.some(request => request.startsWith("DELETE "))).toBe(false)
    } finally { await f.graph.close() }
  })
  it("cancels after a stored page without publishing complete coverage", async () => {
    let cancel = () => {}
    const f = await setup({ onRequest: count => { if (count === 2) cancel() } })
    try {
      const job = f.start()
      cancel = () => { f.engine.cancel(job.id) }
      await f.engine.waitForJob(job)
      expect(job.status).toBe("Cancelled")
      const metadata = await f.metadata(job.backupFolder!)
      expect(metadata.Status).toBe("Cancelled")
      expect(metadata.Coverage).toBe("Incomplete")
      expect(metadata.ItemCounts.AuthorizationPolicy).toBe(7)
      expect(metadata.LargeItems.AuthorizationPolicy.complete).toBe(false)
    } finally { await f.graph.close() }
  })
  it("records cancellation and a fresh engine cannot mistake a crashed type for complete", async () => {
    const f = await setup()
    try {
      const job = f.start()
      f.engine.cancel(job.id)
      expect((await f.engine.waitForJob(job)).status).toBe("Cancelled")
      // A crash before metadata leaves only ownership and snapshots. Restart reads no completion record.
      await f.store.createContainer(f.local, LARGE_BACKUP_CONTAINER)
      const folder = "backup-large-2020-01-01-000000"
      await f.store.put(f.local, LARGE_BACKUP_CONTAINER, backupBlobName(`${folder}/.tenuvault-owner.json`), Buffer.from(JSON.stringify({ TenantId: TENANT, RunId: "crashed" })), "application/json")
      await f.store.put(f.local, LARGE_BACKUP_CONTAINER, backupBlobName(`${folder}/${type.folder}/partial.json`), Buffer.from('{"id":"partial"}'), "application/json")
      const restarted = new LocalBlobStore(roots.at(-1)!, [Buffer.alloc(32, 7)])
      expect((await restarted.list(f.local, LARGE_BACKUP_CONTAINER, `${folder}/`)).some(file => file.name.endsWith("metadata.json"))).toBe(false)
    } finally { await f.graph.close() }
  })
  it("retries dropped connections and honors repeated service throttles through the last page", async () => {
    const f = await setup({ throttleEvery: 2, retryAfter: 0.001, dropAt: 1 })
    try {
      const job = await f.engine.waitForJob(f.start())
      expect(job.coverage).toBe("complete")
      expect((await f.metadata(job.backupFolder!)).LargeItems.AuthorizationPolicy.count).toBe(23)
      expect(f.graph.stats().throttles).toBeGreaterThan(0)
    } finally { await f.graph.close() }
  }, 15_000)
  it.each(["complete", "missing index", "missing relationship", "damaged relationship"])("checks every large inventory shard before deletion: %s", async state => {
    const f = await setup()
    const old = "backup-large-2020-01-01-000000"
    try {
      await f.store.createContainer(f.local, LARGE_BACKUP_CONTAINER)
      const write = (name: string, value: unknown) => f.store.put(f.local, LARGE_BACKUP_CONTAINER, backupBlobName(`${old}/${name}`), Buffer.from(JSON.stringify(value)), "application/json")
      await write(".tenuvault-owner.json", { TenantId: TENANT, RunId: "old" })
      const oldObject = { id: "old", members: { format: "sorted-id-shards-v1", count: 1, shards: 1, complete: true, hash: createHash("sha256").update('"member"\n').digest("hex") } }
      await write(`${type.folder}/old.json`, oldObject)
      if (state !== "missing index") await write(indexPath(type.folder, 0), [{ id: "old", file: "old.json", hash: snapshotHash(oldObject) }])
      if (state !== "missing relationship") await write(`_relations/${type.folder}/old/members/000000.json`, [state === "damaged relationship" ? "different" : "member"])
      await write("metadata.json", { TenantId: TENANT, Status: "Success", Failures: 0, Scope: { Included: [type.folder] }, Items: {}, LargeItems: { [type.folder]: { version: 1, count: 1, shards: 1, complete: true } } })
      const job = await f.engine.waitForJob(f.start())
      expect(job.coverage).toBe("complete")
      if (state !== "complete") {
        expect(f.requests.filter(request => request.startsWith("DELETE "))).toEqual([])
        if (state !== "missing index") expect((await f.store.list(f.local, LARGE_BACKUP_CONTAINER, `${old}/`)).some(blob => blob.name.endsWith("metadata.json"))).toBe(true)
        expect(job.log.join(" ")).toMatch(/could not be verified|not available|is unavailable/)
        return
      }
      expect(await f.store.list(f.local, LARGE_BACKUP_CONTAINER, `${old}/`)).toEqual([])
      expect(await f.store.list(f.local, LARGE_BACKUP_CONTAINER, backupBlobName(`${old}/`))).toEqual([])
      const deleted = f.requests.filter(request => request.startsWith("DELETE "))
      const manifest = deleted.findIndex(request => request.endsWith("/metadata.json"))
      expect(manifest).toBe(azure ? deleted.length - 2 : 0)
      expect(deleted.at(-1)).toContain(".tenuvault-owner.json")
      expect(deleted.some(request => request.includes("_relations"))).toBe(true)
    } finally { await f.graph.close() }
  })
  it("ends only the type at its request budget and keeps older coverage", async () => {
    const f = await setup({}, { readBudget: { durationMs: 60_000, maxRequests: 1 } })
    try {
      const job = await f.engine.waitForJob(f.start())
      expect(job.coverage).toBe("incomplete")
      expect((await f.metadata(job.backupFolder!)).FailedTypes).toContain(type.folder)
    } finally { await f.graph.close() }
  })
})

it("releases the engine queue while a large tenant waits for another Graph page", async () => {
  undo = registerTestTypes([type])
  let release!: () => void, reached!: () => void
  const page = new Promise<void>(resolve => { reached = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const root = await mkdtemp(join(tmpdir(), "tv-fair-")); roots.push(root)
  const store = new LocalBlobStore(root, [Buffer.alloc(32, 2)])
  const engine = new BackupEngine({
    fetch: (async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === "graph.microsoft.com") {
        if (!url.pathname.includes("syntheticUsers")) return Response.json({ value: [] })
        if (url.searchParams.has("$skiptoken")) { reached(); await blocked; return Response.json({ value: [] }) }
        return Response.json({ value: [{ id: "one" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/syntheticUsers?$skiptoken=1" })
      }
      return handleLocalBlobRequest(store, new Request(input, init))
    }) as typeof fetch,
    getToken: async () => jwt({ scp: "Policy.Read.All" }),
    services: tenant => ({ services: tenant === TENANT ? ["entra"] : ["intune"] }),
  })
  const large = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: `tvlocal-${TENANT}` })
  await page
  const other = "33333333-3333-3333-3333-333333333333"
  const small = engine.start({ tenantId: other, clientId: CLIENT, storageAccountName: `tvlocal-${other}`, scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceCategories").map(type => type.folder) } })
  try {
    expect((await engine.waitForJob(small)).status).toBe("Completed")
    expect(large.status).toBe("Running")
  } finally { release(); await engine.waitForJob(large) }
})

it("keeps relationship coverage incomplete after an unread continuation and continues the next type", async () => {
  const broken = { ...type, extras: [{ property: "members", ids: true as const, path: (id: string) => `syntheticUsers/${id}/members?$select=id` }] }
  const next = testType("TokenLifetimePolicies", "other", { volume: "large", listOnly: true, apiVersion: "v1.0" })
  undo = registerTestTypes([broken, next])
  const { scriptedGraph, fixture } = await import("./helpers/backup-fixture")
  const f = fixture(scriptedGraph({
    "/v1.0/syntheticUsers?$top=999&$select=id,displayName": { value: [{ id: "group" }] },
    "/v1.0/syntheticUsers/group/members?$select=id": { value: [{ id: "first" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/syntheticUsers/group/members?page=2" },
    "/v1.0/syntheticUsers/group/members?page=2": () => Response.json({ error: { code: "Expired", message: "expired" } }, { status: 410 }),
    "/v1.0/other": { value: [{ id: "other" }] },
  }), { getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["entra"] }) })
  const job = await f.run()
  expect(job.coverage).toBe("incomplete")
  expect((await f.files(job)).some(name => name.endsWith("group.json"))).toBe(false)
  expect((await f.manifest(job)).LargeItems.TokenLifetimePolicies.complete).toBe(true)
})

it.each([false, true])("lists history during a streaming capture without listing snapshots (Azure protocol: %s)", async azure => {
  undo = registerTestTypes([type])
  let release!: () => void, reached!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const page = new Promise<void>(resolve => { reached = resolve })
  const f = fixture(scriptedGraph({
    "/v1.0/syntheticUsers?$top=999&$select=id,displayName": { value: [{ id: "one" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/syntheticUsers?page=2" },
    "/v1.0/syntheticUsers?page=2": async () => { reached(); await blocked; return Response.json({ value: [] }) },
  }), { getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["entra"] }) })
  const job = f.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: f.account })
  try {
    await page
    const marker = await f.file(job, ".tenuvault-owner.json")
    expect(marker).toMatchObject({ RunId: job.id, LargeInventory: { version: 1 } })
    const listings: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "storage" })
      if (url.searchParams.get("comp") === "list") { expect(url.searchParams.get("prefix") ?? "").not.toContain("payload"); listings.push(url.search) }
      url.hostname = `${f.account}.blob.core.windows.net`
      return handleLocalBlobRequest(f.store, new Request(url, init))
    }))
    for (const summary of [false, true]) {
      const response = await history(new NextRequest("http://tenuvault.internal/api/list-backups", { method: "POST", body: JSON.stringify({ tenantId: TENANT, appId: CLIENT, clientSecret: "test", subscriptionId: "local", resourceGroupName: "local", storageAccountName: azure ? "syntheticstore" : f.account, summary }) }))
      expect(response.status).toBe(200)
      expect((await response.json()).backups).toMatchObject([{ id: job.backupFolder, status: "running", runId: job.id, largeInventory: true }])
    }
    expect(listings).toHaveLength(4)
  } finally { release(); await f.engine.waitForJob(job) }
})
