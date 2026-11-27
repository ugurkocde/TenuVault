import { backupBlobName, LARGE_BACKUP_CONTAINER } from "../src/shared/backup-storage"
import { createHash } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Readable } from "node:stream"
import { exportLargeArchive, importLargeArchive, reviewLargeArchive, saveLargeDownload } from "../src/main/backup/large-archive"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { BlobAlreadyExistsError, LocalBlobStore } from "../src/main/storage/local-blob-store"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { LARGE_SHARD_ITEMS } from "../src/shared/large-backup"
const tenant = "11111111-1111-1111-1111-111111111111", backup = "backup-large-2026-11-16-120000"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function synthetic(count = 11, bytes = 100) {
  const root = await mkdtemp(join(tmpdir(), "tv-tar-test-")); roots.push(root)
  const path = join(root, "backup.tar")
  const id = (at: number) => `object-${String(at).padStart(8, "0")}`
  const snapshot = (at: number) => ({ id: id(at), payload: "x".repeat(bytes) })
  const metadata = { BackupFolder: backup, TenantId: tenant, Status: "Success", Failures: 0, Coverage: "Complete", Items: {}, ItemCounts: { DeviceConfigurations: count, TotalPolicies: count }, LargeItems: { DeviceConfigurations: { version: 1, count, shards: Math.ceil(count / 1000), complete: true } }, Scope: { Included: ["DeviceConfigurations"], Excluded: [] } }
  const read = async (name: string) => {
    if (name.startsWith("_index/")) {
      const part = Number(name.split("/").at(-1)!.replace(".json", ""))
      return Array.from({ length: Math.min(LARGE_SHARD_ITEMS, count - part * LARGE_SHARD_ITEMS) }, (_, offset) => {
        const at = part * LARGE_SHARD_ITEMS + offset
        return { id: id(at), file: `${id(at)}.json`, hash: snapshotHash(snapshot(at)) }
      })
    }
    return snapshot(Number(name.match(/object-(\d+)/)![1]))
  }
  const stream = Readable.toWeb(Readable.from(exportLargeArchive(tenant, backup, metadata, read))) as ReadableStream<Uint8Array>
  await saveLargeDownload(stream, path)
  return { root, path, metadata, read }
}
it("exports and reviews more than 60000 files and 128 MiB with bounded tar records", async () => {
  const f = await synthetic(60_001, 2300)
  const reviewed = await reviewLargeArchive(f.path)
  expect(reviewed.count).toBe(60_001)
  // The disk-heavy import probe is opt-in and stays outside the normal test run.
  if (process.env.TV_TEST_LARGE_IMPORT === "1") {
    const store = new LocalBlobStore(join(f.root, "encrypted"), [Buffer.alloc(32, 3)])
    await importLargeArchive(store, reviewed)
    const metadata = JSON.parse((await store.get(`tvlocal-${tenant}`, LARGE_BACKUP_CONTAINER, backupBlobName(`${backup}/metadata.json`))).data.toString())
    expect(metadata.LargeItems.DeviceConfigurations.count).toBe(60_001)
  }
  const handle = await open(f.path, "r")
  try { expect((await handle.stat()).size).toBeGreaterThan(128 * 1024 * 1024) }
  finally { await handle.close() }
}, process.env.TV_TEST_LARGE_IMPORT === "1" ? 1_200_000 : 120_000)
it("imports reviewed shards and snapshots and refuses an occupied destination", async () => {
  const f = await synthetic()
  const store = new LocalBlobStore(join(f.root, "encrypted"), [Buffer.alloc(32, 3)])
  const reviewed = await reviewLargeArchive(f.path)
  await importLargeArchive(store, reviewed)
  const result = JSON.parse((await store.get(`tvlocal-${tenant}`, LARGE_BACKUP_CONTAINER, backupBlobName(`${backup}/metadata.json`))).data.toString())
  expect(result.Import.sha256).toBe(reviewed.digest)
  expect(result.LargeItems).toEqual(f.metadata.LargeItems)
  await expect(importLargeArchive(store, reviewed)).rejects.toThrow("already exists")
})
it.each(["../evil.json", "/evil.json", "DeviceConfigurations\\evil.json"])("rejects unsafe tar paths: %s", async name => {
  const f = await synthetic()
  const raw = await readFile(f.path)
  raw.fill(0, 0, 100); raw.write(name, 0)
  raw.fill(32, 148, 156); raw.write(raw.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148)
  await writeFile(f.path, raw)
  await expect(reviewLargeArchive(f.path)).rejects.toThrow("Unsafe")
})
it("refuses unsupported entry kinds, size bombs, truncated archives and trailing entries", async () => {
  const f = await synthetic()
  const original = await readFile(f.path)
  for (const mutate of [
    (raw: Buffer) => { raw[156] = 50; return raw },
    (raw: Buffer) => { raw.write((9 * 1024 * 1024).toString(8).padStart(11, "0") + "\0", 124); return raw },
  ]) {
    const raw = mutate(Buffer.from(original)); raw.fill(32, 148, 156); raw.write(raw.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148)
    await writeFile(f.path, raw)
    await expect(reviewLargeArchive(f.path)).rejects.toThrow("Unsafe")
  }
  await writeFile(f.path, original.subarray(0, original.length - 100))
  await expect(reviewLargeArchive(f.path)).rejects.toThrow("extra or missing")
  await writeFile(f.path, Buffer.concat([original, Buffer.alloc(512)]))
  await expect(reviewLargeArchive(f.path)).rejects.toThrow("extra or missing")
})
it("rolls back a changed reviewed source and never publishes its metadata", async () => {
  const f = await synthetic()
  const store = new LocalBlobStore(join(f.root, "encrypted"), [Buffer.alloc(32, 3)])
  const reviewed = await reviewLargeArchive(f.path)
  reviewed.digest = "changed"
  await expect(importLargeArchive(store, reviewed)).rejects.toThrow("changed since review")
  expect(await store.list(`tvlocal-${tenant}`, LARGE_BACKUP_CONTAINER)).toEqual([])
})
it("keeps a late collision and another writer's replacement during rollback", async () => {
  const f = await synthetic(1)
  const root = join(f.root, "encrypted")
  const store = new LocalBlobStore(root, [Buffer.alloc(32, 3)])
  const writer = new LocalBlobStore(root, [Buffer.alloc(32, 3)])
  const account = `tvlocal-${tenant}`
  const marker = `${backup}/.tenuvault-owner.json`
  const policy = backupBlobName(`${backup}/DeviceConfigurations/object-00000000.json`)
  const foreign = Buffer.from('{"writer":"another import"}')
  const put = store.put.bind(store)
  vi.spyOn(store, "put").mockImplementation(async (...args) => {
    if (args[2] === policy) {
      await writer.put(account, LARGE_BACKUP_CONTAINER, marker, foreign, "application/json")
      await writer.put(account, LARGE_BACKUP_CONTAINER, policy, foreign, "application/json", true)
    }
    return put(...args)
  })
  await expect(importLargeArchive(store, await reviewLargeArchive(f.path))).rejects.toThrow(BlobAlreadyExistsError)
  for (const name of [marker, policy]) expect((await writer.get(account, LARGE_BACKUP_CONTAINER, name)).data).toEqual(foreign)
  expect((await writer.list(account, LARGE_BACKUP_CONTAINER)).map(blob => blob.name).sort()).toEqual([marker, policy].sort())
})

it("removes a failed streaming download and preserves the destination", async () => {
  const f = await synthetic()
  const original = await readFile(f.path)
  const body = Readable.toWeb(Readable.from((async function* () { yield Buffer.from("partial"); throw new Error("read failed") })())) as ReadableStream<Uint8Array>
  await expect(saveLargeDownload(body, f.path)).rejects.toThrow("read failed")
  expect(await readFile(f.path)).toEqual(original)
})

it("preserves long Unicode policy file names in POSIX path records", async () => {
  const f = await synthetic(1)
  const name = "設定".repeat(60) + ".json", snapshot = { id: "configuration", displayName: "設定" }
  const metadata = { ...f.metadata, Items: { "CompliancePolicies/configuration": { file: name, hash: snapshotHash(snapshot) } }, ItemCounts: { ...f.metadata.ItemCounts, CompliancePolicies: 1, TotalPolicies: 2 } }
  const read = async (path: string) => path.startsWith("CompliancePolicies/") ? snapshot : f.read(path)
  const path = join(f.root, "derived.tar")
  await saveLargeDownload(Readable.toWeb(Readable.from(exportLargeArchive(tenant, backup, metadata, read))) as ReadableStream<Uint8Array>, path)
  expect((await reviewLargeArchive(path)).count).toBe(2)
})

async function relationshipArchive(count: number, members: number) {
  const f = await synthetic(count)
  const member = (at: number) => `member-${String(at).padStart(8, "0")}`
  const hash = createHash("sha256")
  for (let at = 0; at < members; at++) hash.update(JSON.stringify(member(at)) + "\n")
  const reference = { format: "sorted-id-shards-v1", count: members, shards: Math.ceil(members / LARGE_SHARD_ITEMS), complete: true, hash: hash.digest("hex") }
  const snapshot = (at: number) => ({ id: `object-${String(at).padStart(8, "0")}`, members: reference })
  const read = async (name: string) => {
    if (name.startsWith("_index/")) return Array.from({ length: count }, (_, at) => {
      const value = snapshot(at)
      return { id: value.id, file: `${value.id}.json`, hash: snapshotHash(value) }
    })
    if (name.startsWith("_relations/")) {
      const shard = Number(name.split("/").at(-1)!.replace(".json", ""))
      return Array.from({ length: Math.min(LARGE_SHARD_ITEMS, members - shard * LARGE_SHARD_ITEMS) }, (_, at) => member(shard * LARGE_SHARD_ITEMS + at))
    }
    return snapshot(Number(name.match(/object-(\d+)/)![1]))
  }
  const path = join(f.root, "derived.tar")
  await saveLargeDownload(Readable.toWeb(Readable.from(exportLargeArchive(tenant, backup, f.metadata, read))) as ReadableStream<Uint8Array>, path)
  return { ...f, path, read, reference, snapshot }
}

it("round trips three objects with 500000 members each beyond the parent file allowance", async () => {
  const f = await relationshipArchive(3, 500_000)
  const reviewed = await reviewLargeArchive(f.path)
  expect(reviewed.count).toBe(3)
  const store = new LocalBlobStore(join(f.root, "encrypted"), [Buffer.alloc(32, 3)])
  await importLargeArchive(store, reviewed)
  const account = `tvlocal-${tenant}`
  // 1500 relationship shards, three snapshots, one index, metadata and ownership.
  expect(await store.list(account, LARGE_BACKUP_CONTAINER)).toHaveLength(1506)
  for (let at = 0; at < 3; at++) {
    const name = `${backup}/_relations/DeviceConfigurations/${f.snapshot(at).id}/members/000499.json`
    const ids = JSON.parse((await store.get(account, LARGE_BACKUP_CONTAINER, backupBlobName(name))).data.toString())
    expect(ids).toHaveLength(1000)
    expect(ids.at(-1)).toBe("member-00499999")
  }
  const metadata = JSON.parse((await store.get(account, LARGE_BACKUP_CONTAINER, backupBlobName(`${backup}/metadata.json`))).data.toString())
  expect(metadata.Import.sha256).toBe(reviewed.digest)
}, 120_000)

it.each([500_001, 499_999])("refuses a fingerprinted but forged relationship count of %s on export and import", async count => {
  const f = await relationshipArchive(1, 500_000)
  const forged = { ...f.snapshot(0), members: { ...f.reference, count, shards: Math.ceil(count / LARGE_SHARD_ITEMS) } }
  const forgedHash = snapshotHash(forged)
  const read = async (name: string) => name.startsWith("_index/") ? [{ id: forged.id, file: `${forged.id}.json`, hash: forgedHash }] : name.startsWith("_relations/") ? f.read(name) : forged
  const error = count > 500_000 ? "Invalid relationship inventory" : "Invalid relationship shard"
  await expect(saveLargeDownload(Readable.toWeb(Readable.from(exportLargeArchive(tenant, backup, f.metadata, read))) as ReadableStream<Uint8Array>, join(f.root, "forged.tar"))).rejects.toThrow(error)
  const raw = await readFile(f.path)
  let offset = 0
  while (offset < raw.length - 1024) {
    const name = raw.subarray(offset, offset + 100).toString().replace(/\0.*$/s, "")
    const size = Number.parseInt(raw.subarray(offset + 124, offset + 136).toString(), 8)
    const start = offset + 512
    if (name.startsWith("_index/")) {
      const value = JSON.parse(raw.subarray(start, start + size).toString())
      value[0].hash = forgedHash
      const bytes = Buffer.from(JSON.stringify(value)); expect(bytes.length).toBe(size); bytes.copy(raw, start)
    } else if (name === `DeviceConfigurations/${forged.id}.json`) {
      const bytes = Buffer.from(JSON.stringify(forged)); expect(bytes.length).toBe(size); bytes.copy(raw, start)
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  await writeFile(f.path, raw)
  await expect(reviewLargeArchive(f.path)).rejects.toThrow(error)
}, 120_000)

it("refuses a declared inventory beyond the global file cap before reading snapshots", async () => {
  const f = await synthetic(1)
  const types = INTUNE_TYPES.slice(0, 11)
  const metadata = {
    ...f.metadata,
    LargeItems: Object.fromEntries(types.map(type => [type.folder, { version: 1, count: 500_000, shards: 500, complete: true }])),
    ItemCounts: { ...Object.fromEntries(types.map(type => [type.folder, 500_000])), TotalPolicies: types.filter(type => !type.inventory).length * 500_000 },
  }
  await expect(exportLargeArchive(tenant, backup, metadata, async () => { throw new Error("Snapshots must not be read") }).next()).rejects.toThrow("Archive file count exceeds the inventory allowance")
})
