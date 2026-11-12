import type { BackupResults, BackupTypeResult } from "../../shared/backup-results"

export interface BackupJobDisplay {
  status: string
  progress: number
  progressMessage: string
  startTime?: string
  endTime?: string
  exception?: string
  output?: string
  results?: BackupResults
  isComplete: boolean
  isSuccessful: boolean
  pollError?: string
}

interface BackupJobLike {
  status: string
  progress: number
  progressMessage: string
  startTime?: string
  endTime?: string
  exception?: string
  output?: string
  results?: BackupResults
  isComplete: boolean
  isSuccessful: boolean
  pollError?: string
}

/** Converts a tracked backup job to the status shape progress views display. */
export function toBackupJobDisplay(job: BackupJobLike): BackupJobDisplay {
  return {
    status: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    startTime: job.startTime,
    endTime: job.endTime,
    exception: job.exception,
    output: job.output,
    results: job.results,
    isComplete: job.isComplete,
    isSuccessful: job.isSuccessful,
    pollError: job.pollError,
  }
}

/**
 * Chooses what a progress view shows: the live tracked job while it exists, then the
 * finished snapshot taken when it completed, then any local placeholder. The snapshot
 * keeps a completed job completed after the store removes it.
 */
export function resolveBackupJobDisplay(
  tracked: BackupJobDisplay | null,
  snapshot: BackupJobDisplay | null,
  fallback: BackupJobDisplay | null,
): BackupJobDisplay | null {
  return tracked ?? snapshot ?? fallback
}

/**
 * What a tenant's disabled backup button says while its backup waits or runs. Queued jobs wait
 * for another tenant's backup; running jobs show their live progress. Without a tracked job
 * (for example a backup started elsewhere) the button only knows a backup is under way.
 */
export function backupButtonLabel(job: { status: string; progress: number } | undefined): string {
  if (!job) return "Backup running..."
  if (job.status === "Queued") return "Backup queued..."
  return `Backing up... ${job.progress}%`
}

export type BackupJobPhase = "running" | "queued" | "completed" | "failed" | "cancelled"

/**
 * The one phase a job counts as in the floating panel. A job that has not started
 * work yet is queued, whether the engine says so in its status or only in its
 * progress message ("Waiting for another backup to finish...").
 */
export function backupJobPhase(job: { status: string; progress: number; progressMessage: string; isComplete: boolean; isSuccessful: boolean }): BackupJobPhase {
  if (job.isComplete) {
    if (job.isSuccessful) return "completed"
    return /cancel/i.test(job.status) ? "cancelled" : "failed"
  }
  if (/queue/i.test(job.status)) return "queued"
  if (job.progress <= 0 && /waiting|queued/i.test(job.progressMessage)) return "queued"
  return "running"
}

/** Header summary for the floating panel, such as "1 running · 1 queued" or "Done". */
export function backupActivitySummary(jobs: readonly { status: string; progress: number; progressMessage: string; isComplete: boolean; isSuccessful: boolean }[]): string {
  const phases = jobs.map(backupJobPhase)
  const running = phases.filter((phase) => phase === "running").length
  const queued = phases.filter((phase) => phase === "queued").length
  const failed = phases.filter((phase) => phase === "failed").length
  const parts: string[] = []
  if (running > 0) parts.push(`${running} running`)
  if (queued > 0) parts.push(`${queued} queued`)
  if (failed > 0) parts.push(`${failed} failed`)
  return parts.length > 0 ? parts.join(" · ") : "Done"
}

/** A backup job is polled only while it is incomplete and has no recorded poll error. */
export function isBackupJobPollable(job: { isComplete: boolean; pollError?: string }): boolean {
  return !job.isComplete && !job.pollError
}

/** What a backup's results section shows, worked out from the engine's per type results. */
export interface BackupResultsSummary {
  /**
   * Policy types with a row, in registry order: saved (some may have failed), being backed up, or,
   * once the job has ended, stopped part way. Inventory such as Autopilot devices is in `inventory`.
   */
  rows: BackupTypeResult[]
  /** Policy types with at least one object saved. */
  typesBackedUp: number
  /** Types still being listed while the job runs. */
  pending: number
  empty: BackupTypeResult[]
  skipped: BackupTypeResult[]
  unreadable: BackupTypeResult[]
  /** Types where some objects could not be saved. */
  partial: BackupTypeResult[]
  policies: number
  inventory: Array<{ label: string; count: number }>
  warnings: string[]
  info: string[]
}

/** `finished` once the job has ended: a type it never finished then counts as stopped, not running. */
export function summarizeBackupResults(results: BackupResults, finished = false): BackupResultsSummary {
  const types = results.types
  const policyTypes = types.filter((type) => !type.inventory)
  return {
    rows: policyTypes.filter((type) => (type.state === "saved" && (type.saved > 0 || type.failed > 0)) || (type.state === "reading" && (type.found ?? 0) > 0)),
    typesBackedUp: policyTypes.filter((type) => type.saved > 0).length,
    pending: finished ? 0 : types.filter((type) => type.state === "reading" && type.found === undefined).length,
    empty: types.filter((type) => type.state === "empty" || (type.state === "saved" && type.saved === 0 && type.failed === 0)),
    skipped: types.filter((type) => type.state === "skipped"),
    unreadable: types.filter((type) => type.state === "unreadable"),
    partial: types.filter((type) => type.failed > 0),
    policies: results.totalPolicies ?? policyTypes.reduce((sum, type) => sum + type.saved, 0),
    inventory: types.filter((type) => type.inventory && type.saved > 0).map((type) => ({ label: type.label, count: type.saved })),
    warnings: results.notices.filter((notice) => notice.level === "warning").map((notice) => notice.message),
    info: results.notices.filter((notice) => notice.level === "info").map((notice) => notice.message),
  }
}

/** A completed backup with warnings: the engine's count, or its message for a job without results. */
export function completedWithWarnings(job: { isComplete: boolean; isSuccessful: boolean; progressMessage: string; results?: BackupResults }): boolean {
  if (!job.isComplete || !job.isSuccessful) return false
  return job.results?.warnings !== undefined ? job.results.warnings > 0 : /with \d+ warnings?/.test(job.progressMessage)
}

/** A type label as a row heading: "compliance policies" becomes "Compliance policies". */
export function typeHeading(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** "5s", "2m 5s"; empty when the job has not started. */
export function formatBackupDuration(startTime?: string, endTime?: string, now = Date.now()): string {
  if (!startTime) return ""
  const seconds = Math.max(0, Math.round(((endTime ? new Date(endTime).getTime() : now) - new Date(startTime).getTime()) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
