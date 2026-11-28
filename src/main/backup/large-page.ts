import { indexPath, LARGE_SHARD_ITEMS, largeIndexes, readIndexShard } from "../../shared/large-backup"
import { typeForFolder } from "../../shared/intune/registry"
import type { JsonFileReader } from "./large-files"

/** One shard per large folder, with its total explicitly separate from the visible policies. */
export async function largeContents(metadata: Record<string, any>, backupId: string, page: number, read: JsonFileReader) {
  if (!Number.isSafeInteger(page) || page < 0 || page > 500) throw new Error("Invalid inventory page")
  const groups = []
  const indexes = largeIndexes(metadata)
  for (const [folder, index] of Object.entries(indexes)) {
    const type = typeForFolder(folder)
    if (!type) throw new Error("Unknown inventory folder")
    const entries = index.complete && page < index.shards ? readIndexShard(await read(indexPath(folder, page)), Math.min(LARGE_SHARD_ITEMS, index.count - page * LARGE_SHARD_ITEMS)) : []
    groups.push({ folder, label: type.label, area: type.area, limitation: type.limitation ?? "This inventory cannot be restored.", count: index.count, policies: entries.map(entry => ({ name: entry.file, path: `${backupId}/${folder}/${entry.file}`, size: 0, type: folder, displayName: entry.id })) })
  }
  // Existing configuration remains on its current preview path; its inventory is already bounded by metadata.
  const legacy = new Map<string, typeof groups[number]>()
  for (const [key, item] of Object.entries(metadata.Items ?? {}) as Array<[string, { file: string }]>) {
    const [folder, id] = key.split("/")
    const type = typeForFolder(folder!)
    if (!type || indexes[folder!] || !id || !/^[^/\\]+\.json$/.test(item.file)) throw new Error("Invalid backup inventory")
    let group = legacy.get(folder!)
    if (!group) { group = { folder: folder!, label: type.label, area: type.area, limitation: type.limitation ?? "", count: 0, policies: [] }; legacy.set(folder!, group) }
    group.count++; group.policies.push({ name: item.file, path: `${backupId}/${folder}/${item.file}`, size: 0, type: folder!, displayName: item.file.replace(/\.json$/, "") })
  }
  return { backupId, content: { groups: [...legacy.values(), ...groups], metadata }, totalPolicies: Object.entries(metadata.ItemCounts ?? {}).reduce<number>((sum, [folder, count]) => sum + (folder !== "TotalPolicies" && typeof count === "number" ? count : 0), 0), largePage: page, hasMore: Object.values(indexes).some(index => index.complete && page + 1 < index.shards) }
}

/** Merge two sorted inventories in bounded windows. A cursor is scoped to one folder and pair. */
export async function compareLargePage(folder: string, before: Record<string, any>, after: Record<string, any>, positions: [number, number], readBefore: JsonFileReader, readAfter: JsonFileReader) {
  const indexes = [largeIndexes(before)[folder], largeIndexes(after)[folder]]
  if (indexes.some(index => !index?.complete)) throw new Error("Both backups must completely cover this inventory")
  const readers = [readBefore, readAfter]
  const caches: Array<{ shard: number; entries: ReturnType<typeof readIndexShard> } | undefined> = []
  const pos = [...positions] as [number, number]
  for (let side = 0; side < 2; side++) if (!Number.isSafeInteger(pos[side]) || pos[side]! < 0 || pos[side]! > indexes[side]!.count) throw new Error("Invalid comparison cursor")
  const peek = async (side: number) => {
    const at = pos[side]!, index = indexes[side]!
    if (at >= index.count) return null
    const shard = Math.floor(at / LARGE_SHARD_ITEMS)
    if (caches[side]?.shard !== shard) caches[side] = { shard, entries: readIndexShard(await readers[side]!(indexPath(folder, shard)), Math.min(LARGE_SHARD_ITEMS, index.count - shard * LARGE_SHARD_ITEMS)) }
    return caches[side]!.entries[at % LARGE_SHARD_ITEMS]!
  }
  const changes: Array<{ id: string; change: "added" | "modified" | "removed" }> = []
  let examined = 0, unchanged = 0
  while (examined < LARGE_SHARD_ITEMS && changes.length < 200) {
    const [left, right] = await Promise.all([peek(0), peek(1)])
    if (!left && !right) break
    examined++
    if (!left || (right && right.id.toLowerCase() < left.id.toLowerCase())) { changes.push({ id: right!.id, change: "added" }); pos[1]++ }
    else if (!right || left.id.toLowerCase() < right.id.toLowerCase()) { changes.push({ id: left.id, change: "removed" }); pos[0]++ }
    else { if (left.hash !== right.hash) changes.push({ id: left.id, change: "modified" }); else unchanged++; pos[0]++; pos[1]++ }
  }
  return { changes, examined, unchanged, next: pos[0] < indexes[0]!.count || pos[1] < indexes[1]!.count ? pos : null }
}
