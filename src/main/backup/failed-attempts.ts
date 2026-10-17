import type { FailedBackupAttempt } from "../../shared/ipc"
import type { KeyValueStore } from "../storage/secure-store"
import type { BackupJob, BackupTrigger } from "./engine"

const KEY = "backup.failedAttempts"
/** The log keeps the most recent attempts across all tenants. */
export const MAX_FAILED_ATTEMPTS = 500
/** Twice the longest Dashboard period, so the period before it can be compared too. */
export const FAILED_ATTEMPT_DAYS = 60
const MAX_MESSAGE = 200

/**
 * Backup attempts that failed without saving a backup folder, for example a sign-in that
 * failed, a license refusal, a Graph list that failed before the folder was claimed, or another
 * backup of the tenant that was already running. Storage has no trace of them, so the Dashboard
 * reads them from this log, kept in the app's encrypted store on this device, to count them as
 * failed. An attempt that wrote a folder is not recorded: its folder is counted instead.
 */
export class FailedAttemptLog {
  /** Tenants whose last backup ended because Microsoft or the storage could not be reached. */
  private readonly unreachable = new Set<string>()

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(entry: Omit<FailedBackupAttempt, "at">): FailedBackupAttempt {
    const attempt: FailedBackupAttempt = {
      at: this.now().toISOString(),
      tenantId: entry.tenantId.toLowerCase(),
      trigger: entry.trigger,
      message: (entry.message.split("\n")[0] ?? "").slice(0, MAX_MESSAGE),
    }
    const cutoff = this.now().getTime() - FAILED_ATTEMPT_DAYS * 86_400_000
    const kept = this.read().filter((item) => Date.parse(item.at) >= cutoff)
    this.store.set(KEY, JSON.stringify([attempt, ...kept].slice(0, MAX_FAILED_ATTEMPTS)))
    return attempt
  }

  /**
   * Records a finished job that failed without claiming its backup folder. A computer that wakes
   * briefly from sleep fails with the same connection error every 15 minutes, so a failure because
   * Microsoft or the storage could not be reached is recorded once, until a backup of the tenant
   * ends another way.
   */
  finished(job: BackupJob, trigger: BackupTrigger): void {
    const tenantId = job.tenantId.toLowerCase()
    const repeated = job.unreachable === true && this.unreachable.has(tenantId)
    if (job.status === "Failed" && job.unreachable) this.unreachable.add(tenantId)
    else this.unreachable.delete(tenantId)
    if (job.status !== "Failed" || job.folderClaimed || repeated) return
    this.record({ tenantId, trigger, message: job.exception ?? job.progressMessage })
  }

  /** Newest first, for one tenant. */
  list(tenantId: string): FailedBackupAttempt[] {
    return this.read().filter((entry) => entry.tenantId === tenantId.toLowerCase())
  }

  private read(): FailedBackupAttempt[] {
    try {
      const parsed: unknown = JSON.parse(this.store.get(KEY) ?? "[]")
      return Array.isArray(parsed)
        ? (parsed as FailedBackupAttempt[]).filter(
            (entry) => typeof entry?.at === "string" && Number.isFinite(Date.parse(entry.at)) && typeof entry.tenantId === "string" && typeof entry.message === "string",
          )
        : []
    } catch {
      return []
    }
  }
}
