export interface BackupJobDisplay {
  status: string
  progress: number
  progressMessage: string
  startTime?: string
  endTime?: string
  exception?: string
  output?: string
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

/** A backup job is polled only while it is incomplete and has no recorded poll error. */
export function isBackupJobPollable(job: { isComplete: boolean; pollError?: string }): boolean {
  return !job.isComplete && !job.pollError
}
