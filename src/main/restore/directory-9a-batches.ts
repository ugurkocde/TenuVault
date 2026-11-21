import type { PartitionedRestoreStore } from "../storage/directory-restore-store"
import type { KeyValueStore } from "../storage/secure-store"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedRun, type GuardedIO } from "./guarded-run"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import type { Item } from "../../shared/intune/registry"

const mappingKey = (tenant: string, folder: string, sourceId: string) => `restore.directory.mapping.${encodeURIComponent(tenant.toLowerCase())}.objectId.${folder}.${sourceId.toLowerCase()}`
export const directoryMappedId = (store: KeyValueStore, tenant: string, folder: string, sourceId: string): string | undefined => store.get(mappingKey(tenant, folder, sourceId)) ?? undefined

export interface DirectoryBatchSource {
  /** Stable immutable backup/index fingerprint. A cursor resumes this exact source. */
  fingerprint: string
  page: (cursor: string | null, limit: number) => Promise<{ entries: GuardedRun["entries"]; next: string | null }>
}
/** Each batch has its own durable 8a journal partition. Neither previews nor journal saves grow with the directory. */
export async function executeDirectoryBatches(store: PartitionedRestoreStore, identity: Omit<GuardedRun, "entries" | "mappings">, source: DirectoryBatchSource, io: GuardedIO, signal?: AbortSignal, limit = 20): Promise<{ status: "complete" | "partial"; batches: number; failed: number }> {
  if (store.partitioned !== true) throw new RestoreSafetyError("Directory restores require partitioned durable storage, not the whole app-state store.")
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RestoreSafetyError("The directory batch budget must be 1 to 100 steps.")
  const prefix = `restore.directory.${encodeURIComponent(identity.tenant)}.${encodeURIComponent(identity.id)}.`
  const binding = restoreFingerprint({ ...identity, actor: { ...identity.actor, recoveryAccountIds: [] }, sourceFingerprint: source.fingerprint } as unknown as Item)
  const saved = store.get(prefix + "cursor")
  const state: { binding: string; cursor: string | null; batch: number; done: boolean; failed: number; warning?: boolean } = saved ? JSON.parse(saved) : { binding, cursor: null, batch: 0, done: false, failed: 0 }
  if (state.binding !== binding) throw new RestoreSafetyError("The directory restore source or identity changed. Resume the original plan.")
  const save = () => store.set(prefix + "cursor", JSON.stringify(state))
  save()
  while (!state.done && !signal?.aborted) {
    const batchKey = prefix + `batch.${state.batch}.`
    const partition: KeyValueStore = { get: key => store.get(batchKey + key), set: (key, value) => store.set(batchKey + key, value), delete: key => store.delete(batchKey + key) }
    const journal = new GuardedRunJournal(partition)
    // Persist the exact next cursor and reviewed plan before any write. Never refetch a mutable page on restart.
    const raw = store.get(batchKey + "plan")
    const page = raw ? JSON.parse(raw) as Awaited<ReturnType<DirectoryBatchSource["page"]>> : await source.page(state.cursor, limit)
    if (page.entries.length > limit || (!page.entries.length && page.next !== null) || (page.next !== null && page.next === state.cursor)) throw new RestoreSafetyError("Invalid directory batch page.")
    if (!raw) store.set(batchKey + "plan", JSON.stringify(page))
    const run: GuardedRun = { ...identity, id: identity.id, entries: page.entries, mappings: [] }
    for (const { step } of page.entries) {
      const mapped = directoryMappedId(store, identity.tenant, step.folder, step.sourceId)
      if (mapped && !run.mappings.some(mapping => mapping.folder === step.folder && mapping.source === step.sourceId)) run.mappings.push({ kind: "objectId", folder: step.folder, source: step.sourceId, target: mapped })
    }
    const lockKey = (step: GuardedRun["entries"][number]["step"]) => `restore.directory.unanswered.${encodeURIComponent(identity.tenant.toLowerCase())}.${step.folder}.${step.sourceId.toLowerCase()}`
    const owner = batchKey
    const guardedIO: GuardedIO = { ...io, write: async (step, body, targetId, beforeSend, currentRun, writeSignal, onUnapplied) => {
      const lock = store.get(lockKey(step))
      if (lock && lock !== owner) throw new RestoreSafetyError("An earlier directory batch has an unanswered write for this object. Resume that run first.")
      store.set(lockKey(step), owner)
      return io.write(step, body, targetId, beforeSend, currentRun, writeSignal, onUnapplied)
    } }
    const result = await executeGuardedRun(journal, run, guardedIO, signal)
    // Publish confirmed mappings before releasing conflict locks, including cancelled batches.
    for (const mapping of result.run.mappings) {
      const key = mappingKey(identity.tenant, mapping.folder, mapping.source)
      const previous = store.get(key)
      if (previous && previous !== mapping.target) throw new RestoreSafetyError("An ambiguous directory mapping was refused.")
      store.set(key, mapping.target)
    }
    for (const entry of result.run.entries) {
      const key = lockKey(entry.step)
      if (store.get(key) === owner && !result.run.entries.some(other => lockKey(other.step) === key && ["pending", "captured", "uncertain"].includes(other.state))) store.delete(key)
    }
    if (result.run.entries.some(entry => ["pending", "captured", "uncertain"].includes(entry.state))) return { status: "partial", batches: state.batch, failed: state.failed }
    state.warning ||= !!result.run.referenceWarning
    state.failed += result.run.entries.filter(entry => entry.state !== "applied").length
    state.cursor = page.next; state.batch++; state.done = page.next === null; save()
  }
  return { status: state.done && state.failed === 0 && !state.warning ? "complete" : "partial", batches: state.batch, failed: state.failed }
}
