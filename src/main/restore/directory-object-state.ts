import type { KeyValueStore } from "../storage/secure-store"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { GuardedRunJournal, type GuardedStep } from "./guarded-run"

type ObjectPlan = { owner: string; retryAt?: number }
/** Object deadlines outlive backup retention. Only an unanswered dispatch owns a conflict lock. */
export function directoryObjectState(store: KeyValueStore, tenant: string, owner: string) {
  const object = (step: GuardedStep) => `${encodeURIComponent(tenant.toLowerCase())}.${step.folder}.${step.sourceId.toLowerCase()}`
  const lockKey = (step: GuardedStep) => `restore.directory.unanswered.${object(step)}`
  const planKey = (step: GuardedStep) => `restore.directory.object.${object(step)}`
  const invalidated = (previous: string, step: GuardedStep) => `${previous}superseded.${step.folder}.${step.sourceId.toLowerCase()}`
  const load = (step: GuardedStep): ObjectPlan | undefined => {
    const raw = store.get(planKey(step))
    return raw ? JSON.parse(raw) : undefined
  }
  const check = (step: GuardedStep) => {
    if (store.get(invalidated(owner, step))) throw new RestoreSafetyError("A newer directory plan superseded this unapplied step. It can no longer send.")
    const lock = store.get(lockKey(step))
    if (lock && lock !== owner) throw new RestoreSafetyError("An earlier directory batch has an unanswered write for this object. Resume that run first.")
  }
  const recordThrottle = (step: GuardedStep, retryAt: number) => {
    const previous = load(step)
    store.set(planKey(step), JSON.stringify({ owner: previous?.owner ?? owner, retryAt: Math.max(previous?.retryAt ?? 0, retryAt) }))
  }
  const defer = (step: GuardedStep, retryAt: number) => {
    check(step)
    recordThrottle(step, retryAt)
    if (store.get(lockKey(step)) === owner) store.delete(lockKey(step))
  }
  return {
    prepare: (step: GuardedStep): number | undefined => {
      // Older versions also locked captured, unapplied entries. Migrate only when the
      // durable journal proves there is no uncertain send, never from an absent record.
      const lock = store.get(lockKey(step))
      if (lock) {
        const partition: KeyValueStore = { get: key => store.get(lock + key), set: () => { throw new Error("Read-only history") }, delete: () => { throw new Error("Read-only history") } }
        const entries = new GuardedRunJournal(partition).list(tenant).flatMap(run => run.entries).filter(entry => object(entry.step) === object(step))
        if (entries.some(entry => entry.state === "uncertain")) {
          throw new RestoreSafetyError("An earlier directory batch has an unanswered write for this object. Resume that run first.")
        }
        if (entries.length) {
          const retryAt = Math.max(0, ...entries.map(entry => entry.retryAt ?? 0), load(step)?.retryAt ?? 0)
          store.set(planKey(step), JSON.stringify({ owner: lock, retryAt }))
          store.delete(lockKey(step))
        }
      }
      check(step)
      const previous = load(step)
      // Invalidate before changing ownership. A crash between saves can only refuse
      // the old page, never let it reclaim ownership after a newer page has sent.
      if (previous && previous.owner !== owner) store.set(invalidated(previous.owner, step), "true")
      store.set(planKey(step), JSON.stringify({ ...previous, owner }))
      return previous?.retryAt
    },
    defer,
    // Actor reads happen before journal execution and may precede reconciliation.
    // Record their deadline without releasing any existing uncertain-send lock.
    recordThrottle,
    beforeSend: (step: GuardedStep) => { check(step); store.set(lockKey(step), owner) },
    settle: (step: GuardedStep, uncertain: boolean) => { if (!uncertain && store.get(lockKey(step)) === owner) store.delete(lockKey(step)) },
  }
}
