import { expect, it } from "vitest"
import { compareLargePage, largeContents } from "../src/main/backup/large-page"
import { indexPath, largeIndexes, readIndexShard } from "../src/shared/large-backup"
const folder = "DeviceConfigurations"
const descriptor = (count: number) => ({ Items: {}, LargeItems: { [folder]: { version: 1, count, shards: Math.ceil(count / 1000), complete: true } } })
const hash = "A".repeat(22)
const entry = (at: number, changed = false) => ({ id: `id-${String(at).padStart(6, "0")}`, file: `id-${String(at).padStart(6, "0")}.json`, hash: changed ? "B".repeat(22) : hash })
it("reads only the requested bounded contents shard and exposes remaining pages", async () => {
  const read: string[] = []
  const result = await largeContents(descriptor(100_000), "backup", 42, async name => { read.push(name); return Array.from({ length: 1000 }, (_, i) => entry(42000 + i)) })
  expect(read).toEqual([indexPath(folder, 42)])
  expect(result.content.groups[0]?.policies).toHaveLength(1000)
  expect(result.hasMore).toBe(true)
  await expect(largeContents(descriptor(5), "backup", -1, async () => [])).rejects.toThrow("page")
})
it("merges additions, changes and removals without reading snapshots or the full indexes", async () => {
  const before = [entry(0), entry(2), entry(3)], after = [entry(1), entry(2, true), entry(3)]
  expect(await compareLargePage(folder, descriptor(3), descriptor(3), [0, 0], async () => before, async () => after)).toEqual({ changes: [{ id: entry(0).id, change: "removed" }, { id: entry(1).id, change: "added" }, { id: entry(2).id, change: "modified" }], examined: 4, unchanged: 1, next: null })
})
it("caps a comparison window at 200 changes and resumes with a pair-scoped cursor", async () => {
  const read = async () => Array.from({ length: 1000 }, (_, i) => entry(i))
  const changed = async () => Array.from({ length: 1000 }, (_, i) => entry(i, true))
  const first = await compareLargePage(folder, descriptor(1000), descriptor(1000), [0, 0], read, changed)
  expect(first.changes).toHaveLength(200)
  expect(first.next).toEqual([200, 200])
  await expect(compareLargePage(folder, descriptor(1), descriptor(1), [100, 0], read, changed)).rejects.toThrow("cursor")
})
it("rejects malformed, duplicate and out-of-order inventory entries and incomplete coverage", async () => {
  expect(() => largeIndexes({ LargeItems: { X: { version: 1, count: 2000, shards: 1, complete: true } } })).toThrow("inventory")
  expect(() => readIndexShard([entry(0), entry(0)], 2)).toThrow("entry")
  expect(() => readIndexShard([{ ...entry(0), file: "../x.json" }], 1)).toThrow("entry")
  expect(() => readIndexShard([], 1)).toThrow("shard")
  const before = descriptor(1); before.LargeItems[folder]!.complete = false
  await expect(compareLargePage(folder, before, descriptor(1), [0, 0], async () => [], async () => [])).rejects.toThrow("completely")
})
