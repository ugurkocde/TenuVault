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
 * Every backup count the Dashboard shows, from one tenant's backups in storage and its attempts
 * that failed without saving a backup. `stored` counts every backup in storage, of any status and
 * age. The rest count the period from `since` up to `until`: successful backups, failed ones
 * (failed, completed with warnings, incomplete, and the failed attempts), and running ones, which
 * are the live jobs when `running` is given. The success rate is null when nothing finished.
 */
export function backupSummary(backups: Backup[], failedAttempts: Array<{ timestamp: Date }>, period: { since: Date; until?: Date; running?: number }) {
  const inPeriod = <T extends { timestamp: Date }>(item: T) => item.timestamp >= period.since && (!period.until || item.timestamp < period.until)
  const recent = backups.filter(inPeriod)
  const successful = recent.filter((item) => item.status === 'success').length
  const failed = recent.filter((item) => ['failed', 'partial', 'incomplete'].includes(item.status)).length + failedAttempts.filter(inPeriod).length
  const finished = successful + failed
  return { stored: backups.length, successful, failed, finished,
    inProgress: period.running ?? recent.filter((item) => item.status === 'running').length,
    successRate: finished ? successful / finished * 100 : null }
}
