export type BackupState = 'success' | 'failed' | 'cancelled' | 'partial' | 'running' | 'incomplete' | 'unknown'
export function normalizeBackupStatus(backup: { status?: unknown; properties?: { status?: unknown }; result?: unknown }): BackupState {
  const raw = [backup.status, backup.properties?.status, backup.result].find((value) => typeof value === 'string' && value.trim().length > 0)
  switch (typeof raw === 'string' ? raw.trim().toLowerCase() : '') {
    case 'success': case 'succeeded': case 'completed': return 'success'
    case 'failed': case 'error': return 'failed'
    case 'cancelled': return 'cancelled'
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
  // A cancelled backup gives no protection, but it is not a failure either.
  if (!latest) return backups.some((item) => ['failed', 'partial', 'incomplete'].includes(item.status)) ? 'critical' : 'warning'
  const age = (now.getTime() - latest.timestamp.getTime()) / 3_600_000
  if (age < 0) return 'warning'
  return age < 24 ? 'healthy' : age < 48 ? 'warning' : 'critical'
}
/**
 * Every backup count the Dashboard shows, from one tenant's backups in storage and its failed
 * attempts. `stored` counts every backup in storage, of any status and age. Successful and failed
 * count the period from `since` up to `until`: failed holds failed backups, backups completed with
 * warnings, incomplete ones and the failed attempts. A backup the user cancelled is not a result:
 * it counts in `stored` only, never in successful, failed or the success rate. The success rate is
 * null when nothing finished.
 *
 * The Dashboard counts runs. Each backup run counts once: by its folder when storage holds one for
 * it, otherwise by its attempt record. A folder without a manifest is failed when its run id
 * matches a failed attempt. Otherwise it is running while `live` (the run ids of the app's
 * unfinished jobs, less those whose manifest or failure record is already saved) holds its run id,
 * or for six hours after it started, since another device may
 * be running it or the app restarted mid run; after that it is incomplete. Running counts the live
 * jobs and the other running folders, once per run, and `latestStatus` (the Last backup chip) is
 * running whenever that count is above zero, so the two always agree.
 */
export function backupSummary(backups: Array<Backup & { runId?: string | null }>, failedAttempts: Array<{ timestamp: Date; runId?: string }>, period: { since: Date; until?: Date; live?: string[] }) {
  const inPeriod = <T extends { timestamp: Date }>(item: T) => item.timestamp >= period.since && (!period.until || item.timestamp < period.until)
  const stored = new Set(backups.map((item) => item.runId).filter((id) => !!id))
  const failedRuns = new Set(failedAttempts.map((attempt) => attempt.runId).filter((id) => !!id))
  // A run that already wrote its manifest or its failure record has finished, even while the engine still reports it.
  const finishedRuns = new Set([...backups.filter((item) => item.runId && ['success', 'failed', 'cancelled', 'partial'].includes(item.status)).map((item) => item.runId), ...failedRuns])
  const live = new Set((period.live ?? []).filter((id) => !finishedRuns.has(id)))
  // The list says running for a folder without a manifest that started less than six hours ago, and incomplete after that.
  const statusOf = (item: Backup & { runId?: string | null }): BackupState => {
    if ((item.status !== 'running' && item.status !== 'incomplete') || !item.runId) return item.status
    return failedRuns.has(item.runId) ? 'failed' : live.has(item.runId) ? 'running' : item.status
  }
  const recent = backups.filter(inPeriod).map(statusOf)
  const unsaved = failedAttempts.filter((attempt) => !attempt.runId || !stored.has(attempt.runId))
  const successful = recent.filter((status) => status === 'success').length
  const failed = recent.filter((status) => ['failed', 'partial', 'incomplete'].includes(status)).length + unsaved.filter(inPeriod).length
  const finished = successful + failed
  const elsewhere = backups.filter((item) => statusOf(item) === 'running' && !(item.runId && live.has(item.runId))).length
  const inProgress = live.size + elsewhere
  const newest = backups.reduce<(typeof backups)[number] | null>((best, item) => !best || item.timestamp > best.timestamp ? item : best, null)
  return { stored: backups.length, successful, failed, finished, inProgress,
    successRate: finished ? successful / finished * 100 : null,
    latestStatus: inProgress > 0 ? 'running' as const : newest ? statusOf(newest) : null }
}
