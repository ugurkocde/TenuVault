import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { exportLargeArchive, reviewLargeArchive } from "../src/main/backup/large-archive"
import type { Item } from "../src/shared/intune/registry"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"

const tenant = "11111111-1111-1111-1111-111111111111", backup = "backup-large-2026-11-16-120000"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const emptyHash = createHash("sha256").digest("hex")
const reference = (format: string) => ({ format, count: 0, shards: 0, complete: true, hash: emptyHash })

// Rewrite the snapshot and its index fingerprint in a valid archive, including tar lengths and checksums.
function forge(raw: Buffer, snapshot: Item): Buffer {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < raw.length - 1024;) {
    const header = Buffer.from(raw.subarray(offset, offset + 512))
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "")
    const size = Number.parseInt(header.subarray(124, 136).toString(), 8)
    let body = raw.subarray(offset + 512, offset + 512 + size)
    if (name.startsWith("Groups/")) body = Buffer.from(JSON.stringify(snapshot))
    if (name.startsWith("_index/")) {
      const entries = JSON.parse(body.toString()); entries[0].hash = snapshotHash(snapshot)
      body = Buffer.from(JSON.stringify(entries))
    }
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124)
    header.fill(32, 148, 156)
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148)
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)])
}

const invalid: Array<[string, unknown]> = [
  ...["format", "count", "shards", "complete", "hash"].map(key => [key, undefined] as [string, unknown]),
  ["count", -1], ["count", 500001], ["count", 0.5], ["shards", 1], ["shards", 0.5], ["hash", "invalid"], ["complete", false],
  ["reference", null], ["reference", []], ["reference", "complete"],
]
it.each(["members", "settings"])("rejects malformed declared %s relationships on export and archive review", async property => {
  const root = await mkdtemp(join(tmpdir(), "tv-directory-validation-")); roots.push(root)
  const path = join(root, "forged.tar")
  const snapshot = { id: tenant, members: reference("sorted-id-shards-v1"), owners: reference("sorted-id-shards-v1"), settings: reference("sorted-object-shards-v1") }
  const metadata = { BackupFolder: backup, TenantId: tenant, Status: "Success", Failures: 0, Coverage: "Complete", Items: {}, ItemCounts: { Groups: 1, TotalPolicies: 0 }, LargeItems: { Groups: { version: 1, count: 1, shards: 1, complete: true } }, Scope: { Included: ["Groups"], Excluded: [] } }
  const read = (value: Item) => async (name: string) => name.startsWith("_index/") ? [{ id: tenant, file: `${tenant}.json`, hash: snapshotHash(value) }] : value
  const collect = async (value: Item) => { const chunks = []; for await (const chunk of exportLargeArchive(tenant, backup, metadata, read(value))) chunks.push(chunk); return Buffer.concat(chunks) }
  const valid = await collect(snapshot)
  await writeFile(path, valid)
  expect((await reviewLargeArchive(path)).count).toBe(1)
  for (const [key, value] of invalid) {
    const ref: Record<string, unknown> = { ...snapshot[property as "members" | "settings"], [key]: value }
    if (value === undefined) delete ref[key]
    const forged = { ...snapshot, [property]: key === "reference" ? value : ref }
    await expect(collect(forged), `${property}.${key} export`).rejects.toThrow()
    await writeFile(path, forge(valid, forged))
    await expect(reviewLargeArchive(path), `${property}.${key} review`).rejects.toThrow()
  }
  // The archive is actually rewritten, rather than a reader stub rejecting it.
  expect(await readFile(path)).not.toEqual(valid)
})
