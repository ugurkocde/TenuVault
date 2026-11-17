import { afterEach, expect, it } from "vitest"
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Readable } from "node:stream"
import { exportLargeArchive, importLargeArchive, reviewLargeArchive, saveLargeDownload } from "../src/main/backup/large-archive"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { LARGE_SHARD_ITEMS } from "../src/shared/large-backup"
const tenant = "11111111-1111-1111-1111-111111111111", backup = "backup-2026-11-16-120000"
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
    const metadata = JSON.parse((await store.get(`tvlocal-${tenant}`, "intune-backups", `${backup}/metadata.json`)).data.toString())
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
  const result = JSON.parse((await store.get(`tvlocal-${tenant}`, "intune-backups", `${backup}/metadata.json`)).data.toString())
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
  expect(await store.list(`tvlocal-${tenant}`, "intune-backups")).toEqual([])
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
  await saveLargeDownload(Readable.toWeb(Readable.from(exportLargeArchive(tenant, backup, metadata, read))) as ReadableStream<Uint8Array>, f.path)
  expect((await reviewLargeArchive(f.path)).count).toBe(2)
})
