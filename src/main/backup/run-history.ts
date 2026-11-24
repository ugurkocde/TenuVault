import type { KeyValueStore } from "../storage/secure-store"

const KEY = "backup.recentRuns"
// Older folders without a manifest already appear incomplete when their owner is unknown.
const KEEP_MS = 24 * 60 * 60_000

export interface BackupRunIdentity {
  id: string
  tenantId: string
  storageAccountName: string
  startTime: string
}

const keyFor = (tenantId: string, account: string, id: string) => JSON.stringify([tenantId.toLowerCase(), account.toLowerCase(), id])

/** Ownership evidence for recent runs, shared by the window and the background launch. */
export class BackupRunHistory {
  private recent: Record<string, number> = {}

  constructor(private readonly store: KeyValueStore, private readonly now = Date.now) {
    try {
      const value: unknown = JSON.parse(store.get(KEY) ?? "{}")
      if (value && typeof value === "object" && !Array.isArray(value)) this.recent = Object.fromEntries(
        Object.entries(value).filter(([, at]) => typeof at === "number" && at >= this.now() - KEEP_MS),
      )
    } catch {
      console.warn("[backup] Could not read recent backup run ownership.")
    }
  }

  remember(runs: BackupRunIdentity[]): void {
    const cutoff = this.now() - KEEP_MS
    for (const run of runs) {
      const at = Date.parse(run.startTime)
      if (at >= cutoff) this.recent[keyFor(run.tenantId, run.storageAccountName, run.id)] = at
    }
    if (!runs.length) return
    this.recent = Object.fromEntries(Object.entries(this.recent).filter(([, at]) => at >= cutoff))
    try {
      this.store.set(KEY, JSON.stringify(this.recent))
    } catch {
      console.warn("[backup] Could not save recent backup run ownership.")
    }
  }

  owns(tenantId: string, account: string, id: string): boolean {
    return Object.hasOwn(this.recent, keyFor(tenantId, account, id))
  }
}
