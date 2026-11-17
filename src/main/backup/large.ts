import { createHash } from "node:crypto"
import { LARGE_MAX_ITEMS, LARGE_SHARD_ITEMS, indexPath, relationPath, safeLargeId, type LargeEntry, type LargeIndex } from "../../shared/large-backup"
import { listPath, listSnapshot, readObject, type GraphReader } from "../../shared/intune/read"
import type { IntuneType, Item } from "../../shared/intune/registry"
import { snapshotHash } from "../../portal/lib/policies/backup-manifest"
import { SortedSpool } from "./sorted-spool"

export interface LargeCapture {
  type: IntuneType
  reader: GraphReader
  pages: (path: string) => AsyncIterable<Item[]>
  put: (path: string, body: string) => Promise<void>
  signal: AbortSignal
  saved: () => void
}

/** No large list or relationship array survives its page. The caller publishes completion last. */
export async function captureLarge({ type, reader, pages, put, signal, saved }: LargeCapture): Promise<LargeIndex> {
  if (type.singleton || type.staticIds || type.listSource || type.expand || type.extras?.some(extra => !extra.ids || extra.each)) throw new Error("Large types require a plain collection and ID-only relationship reads")
  const spool = new SortedSpool<LargeEntry>()
  let count = 0
  try {
    for await (const page of pages(listPath(type))) {
      signal.throwIfAborted()
      if (page.length > LARGE_SHARD_ITEMS) throw new Error("The large collection page exceeds 1000 objects")
      const entries: LargeEntry[] = []
      const pending = new Set<Promise<void>>()
      let failed: unknown
      const save = (path: string, body: string, entry: LargeEntry) => {
        const task = put(path, body).then(() => { entries.push(entry); saved() }, error => { failed ??= error }).finally(() => pending.delete(task))
        pending.add(task)
      }
      try {
      for (const item of page) {
        signal.throwIfAborted()
        if (type.skip?.(item)) continue
        if (!safeLargeId(item.id)) throw new Error("The large collection returned an unsafe object ID")
        if (++count > LARGE_MAX_ITEMS) throw new Error("The large inventory object limit was reached")
        const parentType = { ...type, extras: undefined }
        const snapshot = type.listOnly ? listSnapshot(parentType, item) : await readObject(parentType, item.id, reader)
        for (const extra of type.extras ?? []) {
          if (!safeLargeId(extra.property)) throw new Error("Invalid relationship property")
          const ids = new SortedSpool<{ id: string }>()
          try {
            for await (const members of pages(extra.path(encodeURIComponent(item.id)))) {
              if (members.length > LARGE_SHARD_ITEMS || members.some(member => !safeLargeId(member.id))) throw new Error("Invalid relationship page")
              await ids.add(members.map(member => ({ id: member.id as string })))
            }
            let chunk: string[] = [], shards = 0, total = 0
            const hash = createHash("sha256")
            const flush = async () => {
              if (!chunk.length) return
              await put(relationPath(type.folder, item.id as string, extra.property, shards++), JSON.stringify(chunk))
              chunk = []
            }
            for await (const member of ids.entries()) {
              signal.throwIfAborted()
              hash.update(JSON.stringify(member.id) + "\n")
              chunk.push(member.id); total++
              if (chunk.length === LARGE_SHARD_ITEMS) await flush()
            }
            await flush()
            snapshot[extra.property] = { format: "sorted-id-shards-v1", count: total, shards, complete: true, hash: hash.digest("hex") }
          } finally { await ids.close() }
        }
        const body = JSON.stringify(snapshot, null, 2)
        if (Buffer.byteLength(body) > (type.maxSnapshotBytes ?? 8 * 1024 * 1024)) throw new Error("The large snapshot exceeds its size limit")
        save(`${type.folder}/${item.id}.json`, body, { id: item.id, file: `${item.id}.json`, hash: snapshotHash(snapshot) })
        if (pending.size >= 16) await Promise.race(pending)
        if (failed) { await Promise.all(pending); throw failed }
      }
      } finally { await Promise.all(pending) }
      if (failed) throw failed
      await spool.add(entries)
    }
    let chunk: LargeEntry[] = [], shards = 0
    const flush = async () => {
      if (!chunk.length) return
      await put(indexPath(type.folder, shards++), JSON.stringify(chunk))
      chunk = []
    }
    for await (const entry of spool.entries()) {
      signal.throwIfAborted()
      chunk.push(entry)
      if (chunk.length === LARGE_SHARD_ITEMS) await flush()
    }
    await flush()
    return { version: 1, count, shards, complete: true }
  } finally { await spool.close() }
}
