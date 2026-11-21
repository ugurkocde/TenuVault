import type { KeyValueStore } from "../storage/secure-store"
import { RestoreSafetyError, RestoreWriteDeferredError } from "../../shared/intune/restore-guards"
import { isRestorePersistenceError, GuardedRunJournal, type GuardedRun, type GuardedStep } from "./guarded-run"

type Rejection = { step: string; attempt: number }
type State = { locks: Record<string, { owner: string; journal: string; rejected?: Rejection }>; deadlines: Record<string, number>; discarded: Record<string, true>; invalid?: boolean }
export const directoryPagePrefix = (tenant: string, id: string) => `restore.directory.${encodeURIComponent(tenant)}.${encodeURIComponent(id)}.`
export const directoryMappingKey = (tenant: string, folder: string, source: string) => `restore.directory.mapping.${encodeURIComponent(tenant.toLowerCase())}.objectId.${folder}.${source.toLowerCase()}`
/** One atomic value arbitrates page ownership and discard. All mutations are synchronous. */
export function directoryObjectState(store: KeyValueStore, tenant: string, owner: string, now: () => number = Date.now, retryableLock: (owner: string) => boolean = () => false) {
  const key = `restore.directory.coordinator.${tenant.toLowerCase()}`
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  const load = (): State => {
    const raw = store.get(key)
    if (raw === null) return { locks: {}, deadlines: {}, discarded: {} }
    try {
      const state = JSON.parse(raw)
      if (record(state) && Object.keys(state).every(key => ["locks", "deadlines", "discarded"].includes(key)) && record(state.locks) && record(state.deadlines) && record(state.discarded)) return state as State
    } catch { /* Unknown state is retained and refused for each requested object. */ }
    return { locks: {}, deadlines: {}, discarded: {}, invalid: true }
  }
  const invalid = (id: string): never => { throw new RestoreSafetyError(`Directory coordinator state for object ${id} could not be verified. No write was sent. Review this object's saved restore state.`) }
  const verify = (state: State, id: string) => {
    if (state.invalid) invalid(id)
    const lock = state.locks[id], deadline = state.deadlines[id]
    if (lock !== undefined) {
      if (!record(lock) || Object.keys(lock).some(key => !["owner", "journal", "rejected"].includes(key)) || typeof lock.owner !== "string" || typeof lock.journal !== "string") invalid(id)
      if (lock.rejected !== undefined && (!record(lock.rejected) || Object.keys(lock.rejected).length !== 2 || typeof lock.rejected.step !== "string" || !Number.isSafeInteger(lock.rejected.attempt) || lock.rejected.attempt < 1)) invalid(id)
      const prefix = directoryPagePrefix(tenant, lock.owner) + "batch."
      if (!lock.journal.startsWith(prefix) || !/^\d+\.$/.test(lock.journal.slice(prefix.length))) invalid(id)
    }
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline < 0)) invalid(id)
    if (state.discarded[owner] !== undefined && state.discarded[owner] !== true) invalid(id)
  }
  const save = (state: State) => store.set(key, JSON.stringify(state))
  const object = (step: Pick<GuardedStep, "sourceId" | "targetId">) => (step.targetId ?? step.sourceId).toLowerCase()
  const assertActive = (state = load()) => {
    if (state.discarded[owner]) throw new RestoreSafetyError("This saved directory restore was discarded. It can never send again.")
  }
  const acquire = (state: State, id: string, journal: string) => {
    const lock = state.locks[id.toLowerCase()]
    if (lock && lock.owner !== owner) {
      if (retryableLock(lock.owner)) throw new RestoreWriteDeferredError("A settled earlier directory page owns this object. Retry that page's cleanup before resuming this page.")
      throw new RestoreSafetyError("Another saved directory page owns this object. Resolve or discard that page first.")
    }
    state.locks[id.toLowerCase()] = { owner, journal, ...(lock?.journal === journal && lock.rejected ? { rejected: lock.rejected } : {}) }
  }
  // A throttle can reach either atomic record first. Recover the journal half before
  // ownership is released, and let prepare publish the coordinator half on resume.
  const recoverDeadlines = (state: State, ids = Object.keys(state.locks)) => {
    if (state.invalid) invalid(owner)
    const history = new Map<string, GuardedRun[]>()
    for (const id of ids) {
      const lock = state.locks[id]
      if (lock?.owner !== owner) continue
      verify(state, id)
      const journal = new GuardedRunJournal({ get: name => store.get(lock.journal + name), set: () => { throw new Error("Read-only history") }, delete: () => { throw new Error("Read-only history") } })
      const runs = history.get(lock.journal) ?? journal.list(tenant)
      history.set(lock.journal, runs)
      for (const run of runs) for (const entry of run.entries) {
        if (entry.retryAt === undefined) continue
        if (!Number.isFinite(entry.retryAt) || entry.retryAt < 0) invalid(id)
        const target = (entry.targetId ?? entry.step.targetId ?? store.get(directoryMappingKey(tenant, entry.step.folder, entry.step.sourceId)) ?? entry.step.sourceId).toLowerCase()
        if (target === id) state.deadlines[id] = Math.max(state.deadlines[id] ?? 0, entry.retryAt)
      }
    }
  }
  const createJournalKey = (step: Pick<GuardedStep, "folder" | "sourceId">) => `restore.directory.create-journal.${tenant.toLowerCase()}.${step.folder}.${step.sourceId.toLowerCase()}`
  const createJournal = (step: Pick<GuardedStep, "folder" | "sourceId">): string | null => {
    const prefix = store.get(createJournalKey(step))
    if (prefix !== null && (!prefix.startsWith(`restore.directory.${encodeURIComponent(tenant)}.`) || !/\.batch\.\d+\.$/.test(prefix))) invalid(step.sourceId)
    return prefix
  }
  const clearCreateJournal = (step: Pick<GuardedStep, "folder" | "sourceId">, prefix: string) => {
    if (createJournal(step) !== prefix) return
    try { store.delete(createJournalKey(step)) }
    catch { console.warn(`Directory create reference cleanup failed for object ${step.sourceId}. The mapping is durable; cleanup will be retried.`) }
  }
  /** Replay confirmed mapping publication only for requested identities. */
  const recoverMappings = (steps: Array<Pick<GuardedStep, "folder" | "sourceId" | "targetId">>, state = load(), history?: Map<string, GuardedRun[]>) => {
    const ids = new Set(steps.flatMap(step => [step.sourceId, step.targetId, store.get(directoryMappingKey(tenant, step.folder, step.sourceId))].filter((id): id is string => !!id).map(id => id.toLowerCase())))
    const uncertainCreates = new Set<string>()
    for (const id of ids) verify(state, id)
    // Create journal references survive a lost coordinator lock. One source cannot
    // replace its reference while the previous create is still uncertain.
    const journals = new Set([...ids].flatMap(id => state.locks[id] ? [state.locks[id].journal] : []))
    for (const step of steps) {
      const prefix = createJournal(step)
      if (prefix) journals.add(prefix)
    }
    for (const journalPrefix of journals) {
      const journal = new GuardedRunJournal({ get: name => store.get(journalPrefix + name), set: () => { throw new Error("Read-only history") }, delete: () => { throw new Error("Read-only history") } })
      const runs = (() => {
        try {
          const runs = history?.get(journalPrefix) ?? journal.list(tenant)
          history?.set(journalPrefix, runs)
          return runs
        }
        catch (error) {
          if (isRestorePersistenceError(error)) throw error
          return invalid([...ids].find(id => state.locks[id]?.journal === journalPrefix) ?? steps[0]!.sourceId)
        }
      })()
      for (const run of runs) for (const entry of run.entries) {
        if (entry.state === "uncertain" && entry.step.operation === "create" && ids.has(entry.step.sourceId.toLowerCase())) uncertainCreates.add(entry.step.sourceId.toLowerCase())
      }
      for (const run of runs) for (const mapping of run.mappings) {
        // Only a confirmed create in this exact journal can publish its replacement.
        if (!ids.has(mapping.source.toLowerCase()) && !ids.has(mapping.target.toLowerCase())) continue
        if (!run.entries.some(entry => entry.step.operation === "create" && entry.state === "applied" && entry.step.folder === mapping.folder && entry.step.sourceId === mapping.source && entry.targetId === mapping.target)) continue
        const publicationState = history ? load() : state
        const source = mapping.source.toLowerCase(), target = mapping.target.toLowerCase()
        verify(publicationState, source); verify(publicationState, target)
        const mappingKey = directoryMappingKey(tenant, mapping.folder, mapping.source), previous = store.get(mappingKey)
        const sourceLock = publicationState.locks[source] ?? (!previous && createJournal({ folder: mapping.folder, sourceId: mapping.source }) === journalPrefix ? { owner: run.id, journal: journalPrefix } : undefined)
        const targetLock = publicationState.locks[target]
        if (sourceLock?.journal !== journalPrefix) {
          if (previous?.toLowerCase() === target) clearCreateJournal({ folder: mapping.folder, sourceId: mapping.source }, journalPrefix)
          continue
        }
        if ((previous && previous.toLowerCase() !== target) || (targetLock && targetLock.owner !== sourceLock.owner)) throw new RestoreSafetyError(`The stored mapping or ownership conflicts for directory object ${source}. Review this object's saved restore state.`)
        publicationState.locks[source] = sourceLock
        publicationState.locks[target] = sourceLock
        if (publicationState.deadlines[source]) {
          publicationState.deadlines[target] = Math.max(publicationState.deadlines[target] ?? 0, publicationState.deadlines[source])
          delete publicationState.deadlines[source]
        }
        save(publicationState)
        store.set(mappingKey, mapping.target)
        const step = { folder: mapping.folder, sourceId: mapping.source }
        clearCreateJournal(step, journalPrefix)
      }
    }
    return uncertainCreates
  }
  return {
    assertActive,
    discarded: () => !!load().discarded[owner],
    prepare: (step: GuardedStep, journal: string): number | undefined => {
      const state = load(); assertActive(state)
      const target = object(step)
      verify(state, target)
      recoverDeadlines(state, [target])
      acquire(state, target, journal); save(state)
      return state.deadlines[object(step)] || undefined
    },
    retryDeadline: (step: Pick<GuardedStep, "sourceId" | "targetId">): number | undefined => {
      const state = load(), id = object(step)
      verify(state, id)
      return state.deadlines[id] || undefined
    },
    rejected: (step: GuardedStep, journal: string, attempt: number | undefined): boolean => {
      const state = load(), id = object(step)
      verify(state, id)
      const lock = state.locks[id]
      return lock?.owner === owner && lock.journal === journal && lock.rejected?.step === step.key && lock.rejected.attempt === attempt
    },
    clearRejected: (step: GuardedStep, journal: string, attempt: number | undefined) => {
      const state = load(), id = object(step)
      verify(state, id)
      const lock = state.locks[id]
      if (lock?.owner === owner && lock.journal === journal && lock.rejected?.step === step.key && attempt !== undefined && attempt > lock.rejected.attempt) {
        delete lock.rejected
        save(state)
      }
    },
    recordThrottle: (step: Pick<GuardedStep, "sourceId" | "targetId"> & { folder?: string }, retryAt: number, rejected?: Rejection) => {
      const mapped = step.targetId ?? (step.folder ? store.get(directoryMappingKey(tenant, step.folder, step.sourceId)) : undefined)
      const state = load(), id = object({ ...step, targetId: mapped ?? undefined })
      verify(state, id)
      state.deadlines[id] = Math.max(state.deadlines[id] ?? 0, retryAt)
      if (rejected) {
        if (state.locks[id]?.owner !== owner) invalid(id)
        state.locks[id]!.rejected = rejected
      }
      save(state)
    },
    beforeSend: (step: GuardedStep) => {
      const state = load(); assertActive(state)
      verify(state, object(step))
      if (state.locks[object(step)]?.owner !== owner) throw new RestoreSafetyError("This page no longer owns the directory object.")
      if ((state.deadlines[object(step)] ?? 0) > now()) throw new RestoreWriteDeferredError("Microsoft Graph Retry-After has not elapsed. Resume to repeat safety checks.", state.deadlines[object(step)])
    },
    recoverMappings,
    trackCreate: (step: GuardedStep, journal: string) => {
      if (step.operation !== "create") return
      const state = load(), id = object(step)
      verify(state, id)
      const lock = state.locks[id]
      if (lock && lock.owner !== owner) throw new RestoreSafetyError("Another saved directory page owns this object. Resolve or discard that page first.")
      if (recoverMappings([step]).has(step.sourceId.toLowerCase())) throw new RestoreWriteDeferredError("An earlier create for this object is unconfirmed. Confirm its result first.")
      store.set(createJournalKey(step), journal)
    },
    /** One read-only capture snapshot; only requested principals and journals are examined. */
    mappingCapture: () => {
      const state = load(), history = new Map<string, GuardedRun[]>()
      return (steps: Array<Pick<GuardedStep, "folder" | "sourceId" | "targetId">>) => recoverMappings(steps, state, history)
    },
    releaseCreated: (ids: string[]) => {
      const state = load()
      recoverDeadlines(state, ids.map(id => id.toLowerCase()))
      for (const id of ids) {
        verify(state, id.toLowerCase())
        if (state.locks[id.toLowerCase()]?.owner === owner) delete state.locks[id.toLowerCase()]
      }
      save(state)
    },
    release: (discard = false) => {
      const state = load()
      recoverDeadlines(state)
      if (discard) state.discarded[owner] = true
      for (const [id, lock] of Object.entries(state.locks)) if (lock?.owner === owner) {
        verify(state, id)
        delete state.locks[id]
      }
      save(state)
    },
  }
}
