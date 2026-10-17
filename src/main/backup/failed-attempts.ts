import type { FailedBackupAttempt } from "../../shared/ipc"
import type { KeyValueStore } from "../storage/secure-store"
import type { BackupJob, BackupRequest } from "./engine"

const KEY = "backup.failedAttempts"
/** The log keeps each tenant's most recent attempts. */
export const MAX_FAILED_ATTEMPTS_PER_TENANT = 200
/** Twice the longest Dashboard period, so the period before it can be compared too. */
export const FAILED_ATTEMPT_DAYS = 60
const MAX_MESSAGE = 200

/**
 * Backup attempts that failed without saving a backup folder, for example a sign-in that
 * failed, a license or plan refusal, a Graph list that failed before the folder was claimed, or
 * another backup of the tenant that was already running. Storage has no trace of them, so the
 * Dashboard reads them from this log, kept in the app's encrypted store on this device, to count
 * them as failed. An attempt that wrote a folder, or may have, is not recorded: storage counts it.
 *
 * Manual and tray attempts always count. Retries of one scheduled slot count once: a computer
 * that wakes briefly from sleep fails the same slot every 15 minutes.
 */
export class FailedAttemptLog {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Null when the scheduled slot already has a failed attempt. */
  record(entry: Omit<FailedBackupAttempt, "at">): FailedBackupAttempt | null {
    const tenantId = entry.tenantId.toLowerCase()
    const slot = entry.trigger === "scheduled" ? entry.slot : undefined
    const all = this.read()
    const own = all.filter((item) => item.tenantId === tenantId)
    if (slot && own.some((item) => item.trigger === "scheduled" && item.slot === slot)) return null
    const attempt: FailedBackupAttempt = {
      at: this.now().toISOString(),
      tenantId,
      trigger: entry.trigger,
      ...(slot ? { slot } : {}),
      message: (entry.message.split("\n")[0] ?? "").slice(0, MAX_MESSAGE),
    }
    const others = all.filter((item) => item.tenantId !== tenantId)
    this.store.set(KEY, JSON.stringify([attempt, ...own.slice(0, MAX_FAILED_ATTEMPTS_PER_TENANT - 1), ...others]))
    return attempt
  }

  /** Records a finished job that failed without claiming its backup folder. */
  finished(job: BackupJob, request: BackupRequest): void {
    if (job.status !== "Failed" || job.folderClaimed || job.folderUnknown) return
    this.record({ tenantId: job.tenantId, trigger: request.trigger ?? "manual", slot: request.slot, message: job.exception ?? job.progressMessage })
  }

  /** Newest first, for one tenant. */
  list(tenantId: string): FailedBackupAttempt[] {
    return this.read().filter((entry) => entry.tenantId === tenantId.toLowerCase())
  }

  /** Entries older than FAILED_ATTEMPT_DAYS are left out, whether or not a write has pruned them yet. */
  private read(): FailedBackupAttempt[] {
    const cutoff = this.now().getTime() - FAILED_ATTEMPT_DAYS * 86_400_000
    try {
      const parsed: unknown = JSON.parse(this.store.get(KEY) ?? "[]")
      return Array.isArray(parsed)
        ? (parsed as FailedBackupAttempt[]).filter(
            (entry) => typeof entry?.at === "string" && Date.parse(entry.at) >= cutoff && typeof entry.tenantId === "string" && typeof entry.message === "string",
          )
        : []
    } catch {
      return []
    }
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
