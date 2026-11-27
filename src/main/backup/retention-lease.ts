import { BlobLeaseError } from "./blob-writer"
import { RequestTimeoutError } from "./request"

export const LEASE_DURATION_SECONDS = 60
export const LEASE_DURATION_MS = LEASE_DURATION_SECONDS * 1000
export const LEASE_RENEW_MS = 30_000
export const LEASE_RENEW_BATCH_WINDOW_MS = 15_000
export const LEASE_SAFETY_MARGIN_MS = 10_000
export const LEASE_CONCURRENCY = 8
export const LEASE_CLEANUP_DEADLINE_MS = 30_000
export const PERMANENT_LEASE_FAILURE_RUNS = 3

export interface TrackedLease {
  leaseId: string
  expiresAt: number
  renew: (signal: AbortSignal) => Promise<void>
  release: (signal: AbortSignal) => Promise<void>
}

export interface RetentionLeaseManager {
  track(lease: TrackedLease): void
  ensureFresh(): Promise<void>
  cleanup(deadlineMs?: number): Promise<void>
}

async function raceAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  let onAbort: () => void = () => undefined
  const aborted = new Promise<void>(resolve => {
    onAbort = () => resolve()
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    await Promise.race([promise.catch(() => undefined), aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

/**
 * Coordinates per-lease expiry tracking, expiry-ordered bounded-parallel renewals,
 * pre-DELETE safety margin checks, and deadline-bounded cleanup.
 */
export function createRetentionLeaseManager(): RetentionLeaseManager {
  const leases: TrackedLease[] = []
  let renewError: unknown
  let activeRenew: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const renewAbort = new AbortController()

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const dueLeases = (now: number): TrackedLease[] => {
    const hasDue = leases.some(lease => lease.expiresAt - now <= LEASE_RENEW_MS)
    if (!hasDue) return []
    return leases
      .filter(lease => lease.expiresAt - now <= LEASE_RENEW_MS + LEASE_RENEW_BATCH_WINDOW_MS)
      .sort((a, b) => a.expiresAt - b.expiresAt)
  }

  const startRenew = (due: TrackedLease[]): Promise<void> => {
    const sorted = [...due].sort((a, b) => a.expiresAt - b.expiresAt)
    const passAbort = new AbortController()
    const signal = AbortSignal.any([renewAbort.signal, passAbort.signal])
    const pending = (async () => {
      let next = 0
      const outcome: { failed: boolean; error?: unknown } = { failed: false }
      const worker = async () => {
        while (!outcome.failed && !stopped && !signal.aborted && next < sorted.length) {
          const lease = sorted[next++]!
          const startedAt = Date.now()
          if (lease.expiresAt <= startedAt) {
            if (!outcome.failed) {
              outcome.failed = true
              outcome.error = new BlobLeaseError(new Error("Replacement lease expired before it could be renewed."))
            }
            passAbort.abort(outcome.error)
            return
          }
          try {
            await lease.renew(signal)
            if (stopped || renewAbort.signal.aborted) return
            lease.expiresAt = startedAt + LEASE_DURATION_MS
          } catch (error) {
            if (stopped || renewAbort.signal.aborted) return
            if (!outcome.failed) {
              outcome.failed = true
              outcome.error = error instanceof BlobLeaseError ? error : new BlobLeaseError(error)
            }
            passAbort.abort(outcome.error)
            return
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(LEASE_CONCURRENCY, sorted.length) }, worker))
      if (outcome.failed && !stopped && !renewAbort.signal.aborted) {
        renewError ??= outcome.error
        throw outcome.error
      }
    })()
    const tracked = pending.finally(() => {
      if (activeRenew === tracked) activeRenew = undefined
    })
    activeRenew = tracked
    void tracked.catch(() => undefined)
    return tracked
  }

  const schedule = () => {
    clearTimer()
    if (stopped || renewError || leases.length === 0) return
    let earliest = Infinity
    for (const lease of leases) {
      if (lease.expiresAt < earliest) earliest = lease.expiresAt
    }
    const delay = Math.max(0, earliest - LEASE_RENEW_MS - Date.now())
    timer = setTimeout(() => {
      timer = undefined
      if (stopped || renewError) return
      if (activeRenew) {
        void activeRenew.then(() => schedule(), () => undefined)
        return
      }
      const due = dueLeases(Date.now())
      if (due.length === 0) {
        schedule()
        return
      }
      void startRenew(due).then(
        () => schedule(),
        () => undefined,
      )
    }, delay)
    timer.unref?.()
  }

  return {
    track(lease: TrackedLease) {
      leases.push(lease)
      if (!stopped && !renewError && !activeRenew) schedule()
    },

    async ensureFresh() {
      const renewedInCall = new Set<TrackedLease>()
      while (true) {
        if (renewError) throw renewError
        if (activeRenew) {
          await activeRenew.catch(() => undefined)
          if (renewError) throw renewError
          continue
        }
        const now = Date.now()
        const expired = leases.find(lease => lease.expiresAt <= now)
        if (expired) {
          renewError = new BlobLeaseError(new Error("Replacement lease expired before deletion."))
          throw renewError
        }
        const due = dueLeases(now)
        const remainingDue = due.filter(lease => !renewedInCall.has(lease))
        if (remainingDue.length > 0) {
          for (const lease of remainingDue) renewedInCall.add(lease)
          try {
            await startRenew(remainingDue)
          } catch (error) {
            renewError ??= error
            throw renewError
          }
          schedule()
          continue
        }
        const unsafe = leases.find(lease => lease.expiresAt - now <= LEASE_SAFETY_MARGIN_MS)
        if (unsafe) {
          renewError = new BlobLeaseError(new Error("Replacement lease is within 10 seconds of expiry and could not be confirmed renewed before deletion."))
          throw renewError
        }
        return
      }
    },

    async cleanup(deadlineMs = LEASE_CLEANUP_DEADLINE_MS) {
      stopped = true
      clearTimer()
      const deadline = new AbortController()
      const deadlineTimer = setTimeout(() => {
        deadline.abort(new RequestTimeoutError("Lease cleanup timed out."))
      }, deadlineMs)
      deadlineTimer.unref?.()
      try {
        renewAbort.abort(new Error("Lease renewal stopped."))
        const inflight = activeRenew
        if (inflight) {
          await raceAbort(inflight, deadline.signal)
        }
        if (deadline.signal.aborted) return

        const toRelease = [...leases]
        if (toRelease.length === 0) return
        let next = 0
        const worker = async () => {
          while (!deadline.signal.aborted && next < toRelease.length) {
            const lease = toRelease[next++]!
            await lease.release(deadline.signal).catch(() => undefined)
          }
        }
        const releases = Promise.all(Array.from({ length: Math.min(LEASE_CONCURRENCY, toRelease.length) }, worker))
        await raceAbort(releases, deadline.signal)
      } finally {
        clearTimeout(deadlineTimer)
      }
    },
  }
}

export function leaseFailureKey(local: boolean, error: BlobLeaseError): string | undefined {
  if (local) {
    if (error.code === "LeaseUnavailable") return "local:lock"
    if (error.code === "RetentionLockManualIntervention") {
      return error.lockPath ? `local:manual:${error.lockPath}` : "local:manual"
    }
    if (error.code === "LeaseAlreadyPresent" && error.lockHolder) {
      return `local:holder:${error.lockPath ?? ""}:${error.lockHolder}`
    }
    return undefined
  }
  if (error.status === 403) return `azure:403:${error.code ?? ""}`
  return undefined
}

export function permanentLeaseFailureWarning(local: boolean, consecutiveRuns: number, error?: BlobLeaseError): string {
  if (local) {
    if (error?.code === "RetentionLockManualIntervention") {
      const pathDetail = error.lockPath ? ` (${error.lockPath})` : ""
      return `Retention skipped cleanup on ${consecutiveRuns} consecutive runs because the local retention lock${pathDetail} requires manual inspection. Delete the lock file only if no other computer is running TenuVault on this backup folder.`
    }
    if (error?.code === "LeaseAlreadyPresent" && error.lockHolder) {
      const pathDetail = error.lockPath ? ` (${error.lockPath})` : ""
      return `Retention skipped cleanup on ${consecutiveRuns} consecutive runs because the same local retention lock${pathDetail} is still held by another TenuVault instance. Check whether another TenuVault process is stuck, and delete the lock file only if no other computer is running TenuVault on this backup folder.`
    }
    return `Retention skipped cleanup on ${consecutiveRuns} consecutive runs because the backup folder does not support the local retention lock. Check folder permissions or move local backups to a folder that supports exclusive lock files.`
  }
  return `Retention skipped cleanup on ${consecutiveRuns} consecutive runs because Azure Storage refused blob leases (HTTP 403). Blob leases require the "Storage Blob Data Contributor" role or the Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write permission.`
}
