import { comparableSnapshot } from "../../shared/intune/compare"
import { createHash } from "node:crypto"
import { LARGE_SHARD_ITEMS, indexPath, largeIndexes, readIndexShard, relationPath, safeLargeId, type LargeEntry, type LargeIndex } from "../../shared/large-backup"
import { snapshotHash } from "../../portal/lib/policies/backup-manifest"
import type { Item } from "../../shared/intune/registry"

export type JsonFileReader = (name: string) => Promise<any>
export async function* indexedEntries(folder: string, index: LargeIndex, read: JsonFileReader): AsyncGenerator<LargeEntry> {
  if (!index.complete) throw new Error("This large type was not read in full")
  let previous = ""
  for (let shard = 0; shard < index.shards; shard++) {
    const entries = readIndexShard(await read(indexPath(folder, shard)), Math.min(LARGE_SHARD_ITEMS, index.count - shard * LARGE_SHARD_ITEMS), previous)
    for (const entry of entries) { previous = entry.id; yield entry }
  }
}

/** A canonical archive order validates every reference before admitting its bytes. */
export async function* largeFiles(metadata: Record<string, any>, read: JsonFileReader, relationship?: (shards: number) => void): AsyncGenerator<{ name: string; value: unknown }> {
  yield { name: "metadata.json", value: metadata }
  const legacyPaths = new Set<string>()
  for (const [identity, item] of Object.entries(metadata.Items ?? {}) as Array<[string, { file: string; hash: string }]>) {
    const [folder, id, ...rest] = identity.split("/")
    if (!folder || !id || rest.length || !/^[A-Za-z0-9]+$/.test(folder) || !/^[^/\\]+\.json$/.test(item.file)) throw new Error("Invalid backup inventory")
    const name = `${folder}/${item.file}`, value = await read(name)
    if (legacyPaths.has(name.toLowerCase())) throw new Error("Duplicate archive path")
    legacyPaths.add(name.toLowerCase())
    if (value.id !== id || snapshotHash(value as Item) !== item.hash) throw new Error("Backup fingerprint mismatch")
    yield { name, value }
  }
  for (const [folder, index] of Object.entries(largeIndexes(metadata)).sort(([a], [b]) => a < b ? -1 : 1)) {
    if (!index.complete) throw new Error("The large backup is incomplete")
    let previous = ""
    for (let shard = 0; shard < index.shards; shard++) {
      const name = indexPath(folder, shard)
      const entries = readIndexShard(await read(name), Math.min(LARGE_SHARD_ITEMS, index.count - shard * LARGE_SHARD_ITEMS), previous)
      yield { name, value: entries }
      for (const entry of entries) {
        previous = entry.id
        const name = `${folder}/${entry.file}`, value = await read(name)
        if (value.id !== entry.id || snapshotHash(value as Item) !== entry.hash) throw new Error("Backup fingerprint mismatch")
        yield { name, value }
        for (const [property, reference] of Object.entries(value) as Array<[string, any]>) {
          if (!reference || typeof reference !== "object" || Array.isArray(reference) || !["sorted-id-shards-v1", "sorted-object-shards-v1"].includes(reference.format) || !("shards" in reference)) continue
          if (!safeLargeId(property) || !reference.complete || !Number.isSafeInteger(reference.count) || reference.count < 0 || reference.count > 500_000 || reference.shards !== Math.ceil(reference.count / LARGE_SHARD_ITEMS)) throw new Error("Invalid relationship inventory")
          relationship?.(reference.shards)
          const hash = createHash("sha256")
          let last = ""
          for (let part = 0; part < reference.shards; part++) {
            const child = relationPath(folder, entry.id, property, part), ids = await read(child)
            if (!Array.isArray(ids) || ids.length !== Math.min(LARGE_SHARD_ITEMS, reference.count - part * LARGE_SHARD_ITEMS)) throw new Error("Invalid relationship shard")
            for (const value of ids) {
              const id = reference.format === "sorted-id-shards-v1" ? value : value?.id
              if (reference.format === "sorted-object-shards-v1" && (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 8192)) throw new Error("Invalid sub-collection definition")
              if (!safeLargeId(id) || id.toLowerCase() <= last.toLowerCase()) throw new Error("Invalid relationship ID")
              hash.update(JSON.stringify(reference.format === "sorted-id-shards-v1" ? value : comparableSnapshot(value)) + "\n"); last = id
            }
            yield { name: child, value: ids }
          }
          if (hash.digest("hex") !== reference.hash) throw new Error("Relationship fingerprint mismatch")
        }
      }
    }
  }
}
