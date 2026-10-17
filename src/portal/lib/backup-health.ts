export type BackupState = 'success' | 'failed' | 'partial' | 'running' | 'incomplete' | 'unknown'
export function normalizeBackupStatus(backup: { status?: unknown; properties?: { status?: unknown }; result?: unknown }): BackupState {
  const raw = [backup.status, backup.properties?.status, backup.result].find((value) => typeof value === 'string' && value.trim().length > 0)
  switch (typeof raw === 'string' ? raw.trim().toLowerCase() : '') {
    case 'success': case 'succeeded': case 'completed': return 'success'
    case 'failed': case 'error': return 'failed'
    case 'partial': case 'partiallycompleted': case 'completedwithwarnings': case 'warning': return 'partial'
    case 'running': case 'inprogress': case 'queued': return 'running'
    case 'incomplete': return 'incomplete'
    default: return 'unknown'
  }
}
interface Backup { status: BackupState; timestamp: Date }
export function latestComplete<T extends Backup>(backups: T[]): T | null {
  return backups.filter((item) => item.status === 'success' && Number.isFinite(item.timestamp.getTime()))
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0] ?? null
}
export function backupHealth(backups: Backup[], now: Date, unavailable = false): 'healthy' | 'warning' | 'critical' {
  if (unavailable) return 'warning'
  const latest = latestComplete(backups)
  if (!latest) return backups.some((item) => ['failed', 'partial', 'incomplete'].includes(item.status)) ? 'critical' : 'warning'
  const age = (now.getTime() - latest.timestamp.getTime()) / 3_600_000
  if (age < 0) return 'warning'
  return age < 24 ? 'healthy' : age < 48 ? 'warning' : 'critical'
}
/**
 * Every backup count the Dashboard shows, from one tenant's backups in storage and its failed
 * attempts. `stored` counts every backup in storage, of any status and age. The rest count the
 * period from `since` up to `until`: successful backups, failed ones (failed, completed with
 * warnings, incomplete, and the failed attempts), and running ones. The success rate is null when
 * nothing finished. `latestStatus` is the newest backup's status, read the same way.
 *
 * The Dashboard counts runs. Each backup run counts once: by its folder when storage holds one for
 * it, otherwise by its attempt record. A folder without a manifest is running only while a live job
 * of `live` (the run ids of unfinished jobs, when known) wrote it; otherwise it counts as failed
 * when it matches a failed attempt, and as incomplete when not. Running counts the live jobs.
 */
export function backupSummary(backups: Array<Backup & { runId?: string | null }>, failedAttempts: Array<{ timestamp: Date; runId?: string }>, period: { since: Date; until?: Date; live?: string[] }) {
  const inPeriod = <T extends { timestamp: Date }>(item: T) => item.timestamp >= period.since && (!period.until || item.timestamp < period.until)
  const stored = new Set(backups.map((item) => item.runId).filter((id) => !!id))
  const failedRuns = new Set(failedAttempts.map((attempt) => attempt.runId).filter((id) => !!id))
  const live = period.live ? new Set(period.live) : null
  const statusOf = (item: Backup & { runId?: string | null }): BackupState => {
    if (item.status !== 'running') return item.status
    if (item.runId && failedRuns.has(item.runId)) return 'failed'
    return !live || (item.runId && live.has(item.runId)) ? 'running' : 'incomplete'
  }
  const recent = backups.filter(inPeriod).map(statusOf)
  const unsaved = failedAttempts.filter((attempt) => !attempt.runId || !stored.has(attempt.runId))
  const successful = recent.filter((status) => status === 'success').length
  const failed = recent.filter((status) => ['failed', 'partial', 'incomplete'].includes(status)).length + unsaved.filter(inPeriod).length
  const finished = successful + failed
  const newest = backups.reduce<(typeof backups)[number] | null>((best, item) => !best || item.timestamp > best.timestamp ? item : best, null)
  return { stored: backups.length, successful, failed, finished,
    inProgress: live ? live.size : recent.filter((status) => status === 'running').length,
    successRate: finished ? successful / finished * 100 : null,
    latestStatus: newest ? statusOf(newest) : null }
}
