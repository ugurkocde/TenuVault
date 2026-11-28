import { DIRECTORY_SCHEMAS, directoryExtraSnapshot, directoryObjectId } from "../../shared/intune/entra-directory"
import { comparableSnapshot } from "../../shared/intune/compare"
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
  unread?: (property: string) => void
}

/** No large list or relationship array survives its page. The caller publishes completion last. */
export async function captureLarge({ type, reader, pages, put, signal, saved, unread }: LargeCapture): Promise<LargeIndex> {
  if (type.singleton || type.staticIds || type.listSource || type.expand || type.extras?.some(extra => extra.each || extra.single || extra.object)) throw new Error("Large types require a plain collection and paged sub-collection reads")
  const spool = new SortedSpool<LargeEntry>(LARGE_MAX_ITEMS, signal)
  let count = 0, complete = true
  try {
    for await (const page of pages(listPath(type))) {
      signal.throwIfAborted()
      if (page.length > LARGE_SHARD_ITEMS) throw new Error("The large collection page exceeds 1000 objects")
      const entries: LargeEntry[] = []
      const pending = new Set<Promise<void>>()
      let failed: unknown
      const save = async (path: string, body: string, entry: LargeEntry) => {
        while (pending.size >= 16) await Promise.race(pending)
        if (failed) throw failed
        const task = put(path, body).then(() => { entries.push(entry); saved() }, error => { failed ??= error }).finally(() => pending.delete(task))
        pending.add(task)
      }
      try {
      const readItem = async (item: Item) => {
        signal.throwIfAborted()
        if (type.skip?.(item)) return
        if (!safeLargeId(item.id) || (type.folder in DIRECTORY_SCHEMAS && !directoryObjectId(type.folder, item.id))) throw new Error("The large collection returned an unsafe object ID")
        if (++count > LARGE_MAX_ITEMS) throw new Error("The large inventory object limit was reached")
        const objectId = item.id
        const parentType = { ...type, extras: undefined }
        const snapshot = type.listOnly ? listSnapshot(parentType, item) : await readObject(parentType, objectId, reader)
        let objectIncomplete = false
        const readExtra = async (extra: NonNullable<IntuneType["extras"]>[number]) => {
          if (!safeLargeId(extra.property) || extra.property === "__proto__") throw new Error("Invalid relationship property")
          const matches = (patterns: typeof extra.optional, error: unknown) => {
            const answer = error as { status?: number; answer?: { code?: string } }
            return patterns?.some(pattern => pattern.status === answer.status && (!pattern.code || pattern.code === answer.answer?.code))
          }
          const incomplete = () => {
            snapshot[extra.property] = { complete: false }
            complete = false
            if (!objectIncomplete) unread?.(extra.property)
            objectIncomplete = true
          }
          const ids = new SortedSpool<Item & { id: string }>(LARGE_MAX_ITEMS, signal)
          try {
            for await (const members of pages(extra.path(encodeURIComponent(objectId)))) {
              if (members.length > LARGE_SHARD_ITEMS || members.some(member => !safeLargeId(member.id))) throw new Error("Invalid relationship page")
              const shaped = members.map(member => {
                if (extra.ids) return { id: member.id as string }
                const snapshot = type.volume === "large" && type.inventory && type.folder in DIRECTORY_SCHEMAS ? directoryExtraSnapshot(extra.property, member) : listSnapshot({ ...type, keep: undefined, normalizeSnapshot: undefined, unorderedCollections: undefined, requiredCollections: undefined, neverStored: type.neverStored?.filter(path => path.startsWith(`${extra.property}.`)).map(path => path.slice(extra.property.length + 1)) }, member)
                const unfinished = (value: unknown): boolean => !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => key.endsWith("@odata.nextLink") || unfinished(child))
                if (unfinished(snapshot) || Buffer.byteLength(JSON.stringify(snapshot)) > 8192) throw new Error("A sub-collection definition is incomplete or exceeds 8 KiB")
                return { ...snapshot, id: member.id as string }
              })
              await ids.add(shaped)
            }
            let chunk: Array<string | Item> = [], shards = 0, total = 0
            const hash = createHash("sha256")
            const flush = async () => {
              if (!chunk.length) return
              await put(relationPath(type.folder, objectId, extra.property, shards++), JSON.stringify(chunk))
              chunk = []
            }
            for await (const member of ids.entries()) {
              signal.throwIfAborted()
              const value = extra.ids ? member.id : member
              hash.update(JSON.stringify(extra.ids ? value : comparableSnapshot(value)) + "\n")
              chunk.push(value); total++
              if (chunk.length === LARGE_SHARD_ITEMS) await flush()
            }
            await flush()
            snapshot[extra.property] = { format: extra.ids ? "sorted-id-shards-v1" : "sorted-object-shards-v1", count: total, shards, complete: true, hash: hash.digest("hex") }
          } catch (error) {
            signal.throwIfAborted()
            // Only an object-specific refusal is recoverable. Budgets, expired tokens and transport
            // errors still end the type, so a partial page sequence never becomes complete coverage.
            if (!matches(extra.optional, error)) throw error
            incomplete()
          } finally { await ids.close() }
        }
        const extras = type.extras ?? []
        if (type.folder in DIRECTORY_SCHEMAS) {
          // Directory fan-out waits on independent endpoints concurrently, without collecting a
          // tenant's relationships. Drain siblings before ending an object after a failed read.
          for (let at = 0; at < extras.length; at += 8) {
            const reads = await Promise.allSettled(extras.slice(at, at + 8).map(readExtra))
            const failed = reads.find((read): read is PromiseRejectedResult => read.status === "rejected")
            if (failed) throw failed.reason
          }
        } else for (const extra of extras) await readExtra(extra)

        const body = JSON.stringify(snapshot, null, 2)
        if (Buffer.byteLength(body) > (type.maxSnapshotBytes ?? 8 * 1024 * 1024)) throw new Error("The large snapshot exceeds its size limit")
        await save(`${type.folder}/${objectId}.json`, body, { id: objectId, file: `${objectId}.json`, hash: snapshotHash(snapshot), sha256: createHash("sha256").update(body).digest("hex") })
        if (pending.size >= 16) await Promise.race(pending)
        if (failed) { await Promise.all(pending); throw failed }
      }
      // Four directory objects bound network fan-out to 32 reads, while snapshot uploads keep
      // the existing 16-slot limit. Existing large declarations retain serial object reads.
      const width = type.folder in DIRECTORY_SCHEMAS ? 4 : 1
      for (let at = 0; at < page.length; at += width) {
        const reads = await Promise.allSettled(page.slice(at, at + width).map(readItem))
        const failedRead = reads.find((read): read is PromiseRejectedResult => read.status === "rejected")
        if (failedRead) throw failedRead.reason
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
    return { version: 1, count, shards, complete }
  } finally { await spool.close() }
}
