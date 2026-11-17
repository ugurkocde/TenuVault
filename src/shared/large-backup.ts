/** Large inventories use bounded, sorted shards rather than entries in metadata.Items. */
export const LARGE_SHARD_ITEMS = 1000
export const LARGE_MAX_ITEMS = 500_000
export const LARGE_MAX_SHARDS = LARGE_MAX_ITEMS / LARGE_SHARD_ITEMS
export const LARGE_TYPE_MS = 2 * 60 * 60_000
export const LARGE_TYPE_REQUESTS = 250_000
export const LARGE_JOB_MS = 8 * 60 * 60_000
export interface LargeIndex { version: 1; count: number; shards: number; complete: boolean }
export type LargeIndexes = Record<string, LargeIndex>
export interface LargeEntry { id: string; file: string; hash: string }
export const indexPath = (folder: string, shard: number) => `_index/${folder}/${String(shard).padStart(6, "0")}.json`
export const relationPath = (folder: string, id: string, property: string, shard: number) => `_relations/${folder}/${id}/${property}/${String(shard).padStart(6, "0")}.json`
export const safeLargeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)
export function largeIndexes(metadata: Record<string, any> | null | undefined): LargeIndexes {
  const indexes = metadata?.LargeItems
  if (indexes === undefined) return {}
  if (!indexes || typeof indexes !== "object" || Array.isArray(indexes) || Object.keys(indexes).length > 100) throw new Error("Invalid large inventory")
  for (const [folder, value] of Object.entries(indexes)) {
    const index = value as LargeIndex
    if (!/^[A-Za-z0-9]+$/.test(folder) || !index || index.version !== 1 || !Number.isInteger(index.count) || index.count < 0 || index.count > LARGE_MAX_ITEMS || !Number.isInteger(index.shards) || index.shards !== Math.ceil(index.count / LARGE_SHARD_ITEMS) || typeof index.complete !== "boolean") throw new Error("Invalid large inventory")
  }
  return indexes
}
/** Each shard is independently bounded and strictly ordered, including across shard boundaries. */
export function readIndexShard(value: unknown, expected: number, previous = ""): LargeEntry[] {
  if (!Array.isArray(value) || value.length !== expected || expected > LARGE_SHARD_ITEMS) throw new Error("Invalid inventory shard")
  for (const item of value) {
    if (!item || !safeLargeId(item.id) || item.id.toLowerCase() <= previous.toLowerCase() || item.file !== `${item.id}.json` || typeof item.hash !== "string" || !/^[A-Za-z0-9+/]{22}$/.test(item.hash)) throw new Error("Invalid inventory entry")
    previous = item.id
  }
  return value
}
