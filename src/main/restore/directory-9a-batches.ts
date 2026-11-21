import type { PartitionedRestoreStore } from "../storage/directory-restore-store"
import type { KeyValueStore } from "../storage/secure-store"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedRun, type GuardedIO } from "./guarded-run"
import { directoryMappingKey, directoryPagePrefix, directoryObjectState } from "./directory-object-state"
import { RestoreSafetyError, RestoreWriteDeferredError } from "../../shared/intune/restore-guards"
import type { Item } from "../../shared/intune/registry"

export const directoryMappedId = (store: KeyValueStore, tenant: string, folder: string, sourceId: string): string | undefined => {
  return store.get(directoryMappingKey(tenant, folder, sourceId)) ?? undefined
}

export interface DirectoryBatchSource {
  /** Stable immutable backup/index fingerprint. A cursor resumes this exact source. */
  fingerprint: string
  page: (cursor: string | null, limit: number) => Promise<{ entries: GuardedRun["entries"]; next: string | null }>
}
/** Each batch has its own durable 8a journal partition. Neither previews nor journal saves grow with the directory. */
export async function executeDirectoryBatches(store: PartitionedRestoreStore, identity: Omit<GuardedRun, "entries" | "mappings">, source: DirectoryBatchSource, io: GuardedIO, signal?: AbortSignal, limit = 20, reconcileOnly = false): Promise<{ status: "complete" | "partial"; batches: number; failed: number }> {
  if (store.partitioned !== true) throw new RestoreSafetyError("Directory restores require partitioned durable storage, not the whole app-state store.")
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RestoreSafetyError("The directory batch budget must be 1 to 100 steps.")
  const prefix = directoryPagePrefix(identity.tenant, identity.id)
  const objectState = directoryObjectState(store, identity.tenant, identity.id)
  objectState.assertActive()
  const binding = restoreFingerprint({ ...identity, actor: { ...identity.actor, recoveryAccountIds: [] }, sourceFingerprint: source.fingerprint } as unknown as Item)
  const saved = store.get(prefix + "cursor")
  const state: { binding: string; cursor: string | null; batch: number; done: boolean; failed: number; warning?: boolean } = saved ? JSON.parse(saved) : { binding, cursor: null, batch: 0, done: false, failed: 0 }
  if (state.binding !== binding) throw new RestoreSafetyError("The directory restore source or identity changed. Resume the original plan.")
  const save = () => store.set(prefix + "cursor", JSON.stringify(state))
  save()
  while (!state.done && !signal?.aborted) {
    objectState.assertActive()
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
    const resolved = new Map(page.entries.map(({ step }) => [step.key, { ...step, targetId: step.targetId ?? directoryMappedId(store, identity.tenant, step.folder, step.sourceId) }]))
    const effective = (step: typeof page.entries[number]["step"]) => resolved.get(step.key)!
    const guardedIO: GuardedIO = { ...io, prepareStep: step => {
      if (journal.load(identity.tenant, identity.id)?.entries.some(entry => entry.state === "uncertain" && (entry.targetId ?? entry.step.targetId ?? entry.step.sourceId).toLowerCase() === (effective(step).targetId ?? step.sourceId).toLowerCase())) throw new RestoreWriteDeferredError("This page has an unanswered write for this object. Confirm its result first.")
      objectState.recoverMappings([effective(step)])
      return objectState.prepare(effective(step), batchKey)
    }, defer: (step, retryAt) => objectState.recordThrottle(effective(step), retryAt),
      write: (step, body, targetId, beforeSend, currentRun, writeSignal, onUnapplied) =>
        io.write(step, body, targetId, () => { objectState.beforeSend(effective(step)); beforeSend() }, currentRun, writeSignal, onUnapplied),
    }
    const result = await executeGuardedRun(journal, run, guardedIO, signal, reconcileOnly)
    objectState.recoverMappings(result.run.entries.filter(entry => entry.step.operation === "create" && entry.state === "applied").map(entry => entry.step))
    // A confirmed create is resolved once both identities and its mapping are durable.
    objectState.releaseCreated(result.run.entries.filter(entry => entry.step.operation === "create" && entry.state === "applied").flatMap(entry => [entry.step.sourceId, entry.targetId!]))
    if (result.run.entries.some(entry => ["pending", "captured", "deferred", "uncertain"].includes(entry.state))) return { status: "partial", batches: state.batch, failed: state.failed }
    state.warning ||= !!result.run.referenceWarning
    state.failed += result.run.entries.filter(entry => entry.state !== "applied").length
    state.cursor = page.next; state.batch++; state.done = page.next === null; save()
  }
  if (state.done) objectState.release()
  return { status: state.done && state.failed === 0 && !state.warning ? "complete" : "partial", batches: state.batch, failed: state.failed }
}
