import { isGuid } from "../../shared/security"
import type { KeyValueStore } from "../storage/secure-store"
import { RestoreWriteDeferredError } from "../../shared/intune/restore-guards"
import { isRestorePersistenceError, GuardedRunJournal, type GuardedStep } from "./guarded-run"
import { directoryPagePrefix } from "./directory-object-state"

/** Covers Microsoft Entra replication delay after our own acknowledged relationship writes. */
export const DIRECTORY_REPLICATION_WINDOW_MS = 30 * 60 * 1000

/** Journal links outlive page locks to verify uncertain writes against our acknowledged writes. */
export function directoryRelationshipHistory(store: KeyValueStore, tenant: string, target: string, now: () => number = Date.now) {
  const key = `restore.directory.relationship-history.${tenant.toLowerCase()}.${target.toLowerCase()}`
  const deferred = (): never => { throw new RestoreWriteDeferredError("Saved relationship history could not be verified. Confirm this uncertain result after reviewing the restore history.") }
  const load = (name: string): string | null => {
    try {
      const raw = store.get(name), prefix: unknown = raw === null ? null : JSON.parse(raw)
      if (prefix !== null && (typeof prefix !== "string" || !prefix.startsWith(`restore.directory.${encodeURIComponent(tenant)}.`) || !/\.batch\.\d+\.$/.test(prefix))) return deferred()
      return prefix
    } catch (error) { if (isRestorePersistenceError(error)) throw error; return deferred() }
  }
  return {
    track: (journal: string) => {
      const head = load(key)
      if (head === journal) return
      // Publish the predecessor first. A failed head save cannot admit an untracked write.
      const link = key + "." + journal
      if (store.get(link) !== null && load(link) !== head) return deferred()
      store.set(link, JSON.stringify(head))
      store.set(key, JSON.stringify(journal))
    },
    canReconcile: (candidate: GuardedStep): boolean => {
      const seen = new Set<string>()
      try {
        let prefix = load(key)
        while (prefix) {
          if (seen.has(prefix)) return deferred()
          seen.add(prefix)
          const journal = new GuardedRunJournal({ get: name => store.get(prefix! + name), set: deferred, delete: deferred })
          const runs = journal.list(tenant)
          if (!runs.length || runs.some(run => prefix !== directoryPagePrefix(tenant, run.id) + prefix!.slice(prefix!.lastIndexOf("batch.")))) return deferred()
          for (const run of runs) for (const entry of [...run.entries].reverse()) {
            const step = entry.step
            if ((entry.targetId ?? step.targetId ?? step.sourceId).toLowerCase() !== target.toLowerCase() || step.directory?.action !== candidate.directory?.action) continue
            if (!isGuid(step.directory?.principalId)) return deferred()
            if (step.directory.principalId.toLowerCase() !== candidate.directory?.principalId?.toLowerCase()) continue
            if (entry.acknowledged && Number.isFinite(entry.acknowledgedAt) && now() < entry.acknowledgedAt! + DIRECTORY_REPLICATION_WINDOW_MS) {
              if (typeof step.desired.present !== "boolean") return deferred()
              if (step.desired.present !== candidate.desired.present) return false
            }
          }
          const link = key + "." + prefix
          if (store.get(link) === null) return deferred()
          prefix = load(link)
        }
      } catch (error) { if (isRestorePersistenceError(error)) throw error; return deferred() }
      return true
    },
  }
}
