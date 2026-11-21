import { isGuid } from "../../shared/security"
import type { KeyValueStore } from "../storage/secure-store"
import { RestoreWriteDeferredError } from "../../shared/intune/restore-guards"
import { GuardedRunJournal } from "./guarded-run"
import { directoryPagePrefix } from "./directory-object-state"

/** Bounded journal links outlive page locks, so a lagging replica cannot resurrect a removed survivor. */
export function directoryRelationshipHistory(store: KeyValueStore, tenant: string, target: string) {
  const key = `restore.directory.relationship-history.${tenant.toLowerCase()}.${target.toLowerCase()}`
  const deferred = (): never => { throw new RestoreWriteDeferredError("Saved relationship results could not establish a remaining member. Resume after reviewing this group's restore history.") }
  const load = (name: string): string | null => {
    try {
      const raw = store.get(name), prefix: unknown = raw === null ? null : JSON.parse(raw)
      if (prefix !== null && (typeof prefix !== "string" || !prefix.startsWith(`restore.directory.${encodeURIComponent(tenant)}.`) || !/\.batch\.\d+\.$/.test(prefix))) return deferred()
      return prefix
    } catch { return deferred() }
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
    removed: (kind: "members" | "owners"): Set<string> => {
      const removed = new Set<string>(), settled = new Set<string>(), seen = new Set<string>()
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
            if ((entry.targetId ?? step.targetId ?? step.sourceId).toLowerCase() !== target.toLowerCase() || step.directory?.action !== (kind === "members" ? "member" : "owner")) continue
            if (!isGuid(step.directory.principalId)) return deferred()
            const principal = step.directory.principalId.toLowerCase()
            if (settled.has(principal)) continue
            if (entry.state === "applied" || entry.state === "uncertain" && step.desired.present === false) {
              if (typeof step.desired.present !== "boolean") return deferred()
              if (!step.desired.present) removed.add(principal)
              settled.add(principal)
            }
          }
          const link = key + "." + prefix
          if (store.get(link) === null) return deferred()
          prefix = load(link)
        }
      } catch { return deferred() }
      return removed
    },
  }
}
