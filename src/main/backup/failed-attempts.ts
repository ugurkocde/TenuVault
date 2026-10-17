import { randomUUID } from "node:crypto"
import type { FailedBackupAttempt } from "../../shared/ipc"
import { parseBackupName } from "../../shared/intune/backup-names"
import type { KeyValueStore } from "../storage/secure-store"
import type { BackupJob, BackupRequest } from "./engine"

const KEY = "backup.failedAttempts"
/** The log keeps each tenant's most recent attempts. */
export const MAX_FAILED_ATTEMPTS_PER_TENANT = 200
/** Twice the longest Dashboard period, so the period before it can be compared too. */
export const FAILED_ATTEMPT_DAYS = 60
const MAX_MESSAGE = 200

/**
 * Backup attempts that failed, kept in the app's encrypted store on this device. Many leave no
 * trace in storage, for example a sign-in that failed, a license or plan refusal, a Graph list that
 * failed before the folder was claimed, or another backup of the tenant that was already running.
 *
 * The Dashboard counts runs. Each backup run counts once: by its folder when storage holds one for
 * it, otherwise by its attempt record. So every failed run is recorded with its run id and the
 * instant its folder name uses, whether or not it wrote a folder, and the Dashboard drops a record
 * whose folder is listed. Refusals outside the engine never have a folder. The single exception:
 * repeated failures because Microsoft or the storage could not be reached, for one scheduled slot,
 * with no folder, count once. A computer that wakes briefly from sleep fails that way every 15 minutes.
 */
export class FailedAttemptLog {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Null for a repeated connection failure of one scheduled slot, which is counted already. */
  record(entry: Omit<FailedBackupAttempt, "at" | "runId"> & { at?: string; runId?: string }): FailedBackupAttempt | null {
    const tenantId = entry.tenantId.toLowerCase()
    const slot = entry.trigger === "scheduled" ? entry.slot : undefined
    const all = this.read()
    const own = all.filter((item) => item.tenantId === tenantId)
    // Only when the slot's latest record is a connection failure too: any other failure always counts.
    if (slot && entry.unreachable && own.find((item) => item.trigger === "scheduled" && item.slot === slot)?.unreachable) return null
    const attempt: FailedBackupAttempt = {
      at: entry.at ?? this.now().toISOString(),
      tenantId,
      // Attempts without a backup job get an id no folder can carry.
      runId: entry.runId ?? `refused-${randomUUID()}`,
      trigger: entry.trigger,
      ...(slot ? { slot } : {}),
      ...(entry.unreachable ? { unreachable: true } : {}),
      message: (entry.message.split("\n")[0] ?? "").slice(0, MAX_MESSAGE),
    }
    const others = all.filter((item) => item.tenantId !== tenantId)
    this.store.set(KEY, JSON.stringify([attempt, ...own.slice(0, MAX_FAILED_ATTEMPTS_PER_TENANT - 1), ...others]))
    return attempt
  }

  /**
   * Records a finished job that failed, with its run id, at the instant its folder name uses, so
   * the run falls in one period whether its folder or this record counts it. A cancelled job is
   * not a failure.
   */
  finished(job: BackupJob, request: BackupRequest): void {
    if (job.status !== "Failed") return
    const at = (job.backupFolder && parseBackupName(job.backupFolder)?.timestamp) || job.startTime
    this.record({ tenantId: job.tenantId, runId: job.id, at, trigger: request.trigger ?? "manual", slot: request.slot, unreachable: job.unreachable, message: job.exception ?? job.progressMessage })
  }

  /** Newest first, for one tenant. */
  list(tenantId: string): FailedBackupAttempt[] {
    return this.read().filter((entry) => entry.tenantId === tenantId.toLowerCase())
  }

  /** Entries older than FAILED_ATTEMPT_DAYS, or unreadable, are left out and pruned from the store. */
  private read(): FailedBackupAttempt[] {
    const cutoff = this.now().getTime() - FAILED_ATTEMPT_DAYS * 86_400_000
    let parsed: unknown
    try {
      parsed = JSON.parse(this.store.get(KEY) ?? "[]")
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    const kept = (parsed as FailedBackupAttempt[]).filter(
      (entry) => typeof entry?.at === "string" && Date.parse(entry.at) >= cutoff && typeof entry.tenantId === "string"
        && typeof entry.runId === "string" && typeof entry.message === "string",
    )
    if (kept.length < parsed.length) {
      // Reading never fails because the pruned list could not be saved; the next read prunes again.
      try {
        this.store.set(KEY, JSON.stringify(kept))
      } catch (error) {
        console.warn("[backup] Could not prune failed backup attempts:", error)
      }
    }
    return kept
  }
}

/**
 * Records a manual backup the plan guard refused (402), which never reaches the engine, for
 * the tenant the request names. Returns the guard's answer unchanged.
 */
export async function recordPlanRefusal(log: FailedAttemptLog, request: Request, refusal: Response | null): Promise<Response | null> {
  if (refusal?.status !== 402 || new URL(request.url).pathname.replace(/\/$/, "") !== "/api/backup/start") return refusal
  try {
    const body = (await request.clone().json()) as { tenantId?: unknown }
    const answer = (await refusal.clone().json()) as { error?: unknown }
    if (typeof body?.tenantId === "string" && body.tenantId) {
      log.record({ tenantId: body.tenantId, trigger: "manual", message: typeof answer?.error === "string" ? answer.error : "The plan does not include this backup." })
    }
  } catch (error) {
    console.warn("[backup] Could not record a refused backup:", error)
  }
  return refusal
}
