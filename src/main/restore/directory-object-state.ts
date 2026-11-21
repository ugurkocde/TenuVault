import type { KeyValueStore } from "../storage/secure-store"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { GuardedRunJournal, type GuardedStep } from "./guarded-run"

type State = { locks: Record<string, { owner: string; journal: string }>; deadlines: Record<string, number>; discarded: Record<string, true> }
export const directoryPagePrefix = (tenant: string, id: string) => `restore.directory.${encodeURIComponent(tenant)}.${encodeURIComponent(id)}.`
export const directoryMappingKey = (tenant: string, folder: string, source: string) => `restore.directory.mapping.${encodeURIComponent(tenant.toLowerCase())}.objectId.${folder}.${source.toLowerCase()}`
/** One atomic value arbitrates page ownership and discard. All mutations are synchronous. */
export function directoryObjectState(store: KeyValueStore, tenant: string, owner: string) {
  const key = `restore.directory.coordinator.${tenant.toLowerCase()}`
  const load = (): State => { const raw = store.get(key); return raw ? JSON.parse(raw) : { locks: {}, deadlines: {}, discarded: {} } }
  const save = (state: State) => store.set(key, JSON.stringify(state))
  const object = (step: GuardedStep) => (step.targetId ?? step.sourceId).toLowerCase()
  const assertActive = (state = load()) => {
    if (state.discarded[owner]) throw new RestoreSafetyError("This saved directory restore was discarded. It can never send again.")
  }
  const acquire = (state: State, id: string, journal: string) => {
    const lock = state.locks[id.toLowerCase()]
    if (lock && lock.owner !== owner) throw new RestoreSafetyError("Another saved directory page owns this object. Resolve or discard that page first.")
    state.locks[id.toLowerCase()] = { owner, journal }
  }
  return {
    assertActive,
    discarded: () => !!load().discarded[owner],
    prepare: (step: GuardedStep, journal: string): number | undefined => {
      const state = load(); assertActive(state)
      if (store.get(journal + `superseded.${step.folder}.${step.sourceId.toLowerCase()}`) || store.get(directoryPagePrefix(tenant, owner) + `batch.0.superseded.${step.folder}.${step.sourceId.toLowerCase()}`)) throw new RestoreSafetyError("An older version invalidated this saved page. Discard it and preview again.")
      const legacyKeys: string[] = []
      // Older journals remain fail closed until their original page resolves.
      for (const id of new Set([step.sourceId, step.targetId].filter(Boolean))) {
        const legacyKey = `restore.directory.unanswered.${encodeURIComponent(tenant.toLowerCase())}.${step.folder}.${id!.toLowerCase()}`
        const legacy = store.get(legacyKey)
        if (legacy) legacyKeys.push(legacyKey)
        if (legacy && !legacy.startsWith(directoryPagePrefix(tenant, owner))) throw new RestoreSafetyError("An earlier directory page has an unanswered write for this object. Resolve that page first.")
      }
      const retryAt = Math.max(state.deadlines[object(step)] ?? 0, JSON.parse(store.get(`restore.directory.object.${encodeURIComponent(tenant.toLowerCase())}.${step.folder}.${step.sourceId.toLowerCase()}`) ?? "{}").retryAt ?? 0)
      if (retryAt) state.deadlines[object(step)] = retryAt
      // Transfer legacy source ownership and deadlines to the resolved live identity atomically.
      const source = step.sourceId.toLowerCase(), target = object(step)
      const sourceLock = state.locks[source]
      if (source !== target && sourceLock) {
        const targetLock = state.locks[target]
        if (targetLock && targetLock.owner !== sourceLock.owner) throw new RestoreSafetyError("Another saved directory page owns this object. Resolve or discard that page first.")
        state.locks[target] = sourceLock
        delete state.locks[source]
      }
      if (source !== target && state.deadlines[source]) {
        state.deadlines[target] = Math.max(state.deadlines[target] ?? 0, state.deadlines[source])
        delete state.deadlines[source]
      }
      // Persist a key migration even when a competing page is refused.
      if (state.locks[target] && state.locks[target].owner !== owner) save(state)
      acquire(state, target, journal); save(state)
      for (const legacyKey of legacyKeys) store.delete(legacyKey)
      return state.deadlines[object(step)] || undefined
    },
    recordThrottle: (step: GuardedStep, retryAt: number) => {
      const state = load(), id = object(step)
      state.deadlines[id] = Math.max(state.deadlines[id] ?? 0, retryAt); save(state)
    },
    beforeSend: (step: GuardedStep) => {
      const state = load(); assertActive(state)
      if (state.locks[object(step)]?.owner !== owner) throw new RestoreSafetyError("This page no longer owns the directory object.")
      if ((state.deadlines[object(step)] ?? 0) > Date.now()) throw new RestoreSafetyError("Microsoft Graph Retry-After has not elapsed.")
    },
    /** Replay journal publication before planning or releasing a page, including after a failed mapping save. */
    recoverMappings: () => {
      const state = load()
      for (const journalPrefix of new Set(Object.values(state.locks).map(lock => lock.journal))) {
        const journal = new GuardedRunJournal({ get: name => store.get(journalPrefix + name), set: () => { throw new Error("Read-only history") }, delete: () => { throw new Error("Read-only history") } })
        for (const run of journal.list(tenant)) {
          for (const entry of run.entries) {
            const source = entry.step.sourceId.toLowerCase()
            const id = (entry.targetId ?? entry.step.targetId ?? store.get(directoryMappingKey(tenant, entry.step.folder, source)) ?? source).toLowerCase()
            const deadline = Math.max(entry.retryAt ?? 0, state.deadlines[source] ?? 0, state.deadlines[id] ?? 0)
            if (deadline) state.deadlines[id] = deadline
            if (source !== id) {
              delete state.deadlines[source]
              const sourceLock = state.locks[source], targetLock = state.locks[id]
              if (entry.step.operation !== "create" && sourceLock?.journal === journalPrefix && (!targetLock || targetLock.owner === sourceLock.owner)) {
                state.locks[id] = sourceLock; delete state.locks[source]
              }
            }
          }
          save(state)
          for (const mapping of run.mappings) {
            // Only a confirmed create in this exact journal can publish its replacement.
            if (!run.entries.some(entry => entry.step.operation === "create" && entry.state === "applied" && entry.step.folder === mapping.folder && entry.step.sourceId === mapping.source && entry.targetId === mapping.target)) continue
            const sourceLock = state.locks[mapping.source.toLowerCase()]
            const targetLock = state.locks[mapping.target.toLowerCase()]
            if (sourceLock?.journal !== journalPrefix) continue
            if (!targetLock || targetLock.owner === sourceLock.owner) state.locks[mapping.target.toLowerCase()] = sourceLock
            const source = mapping.source.toLowerCase(), target = mapping.target.toLowerCase()
            if (state.deadlines[source]) {
              state.deadlines[target] = Math.max(state.deadlines[target] ?? 0, state.deadlines[source])
              delete state.deadlines[source]
            }
            save(state)
            const mappingKey = directoryMappingKey(tenant, mapping.folder, mapping.source), previous = store.get(mappingKey)
            if (previous && previous !== mapping.target) continue
            store.set(mappingKey, mapping.target)
          }
        }
      }
    },
    releaseCreated: (ids: string[]) => {
      const state = load()
      for (const id of ids) if (state.locks[id.toLowerCase()]?.owner === owner) delete state.locks[id.toLowerCase()]
      save(state)
    },
    release: (discard = false) => {
      const state = load()
      if (discard) state.discarded[owner] = true
      for (const [id, lock] of Object.entries(state.locks)) if (lock.owner === owner) delete state.locks[id]
      save(state)
    },
  }
}
