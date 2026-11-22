import { MAX_BACKUP_ARCHIVE_BYTES } from '../../shared/constants'
import { readJsonCapped } from '../../shared/capped-body'
import { AuditEventType, AuditResult, AuditSeverity, type AuditUser, type AuditJobStatus, type AuditLogEntry } from '~/lib/audit/types'
import type { AuditSink } from '../api/audit-sink'
import type { BackupJob, BackupRequest, RunTokens } from './engine'
import { retryableStatus } from '../graph-retry'

export function checkpointBackupAudit(
  sink: Pick<AuditSink, 'checkpointBackup'>,
  job: BackupJob,
  request: BackupRequest,
  tokens: RunTokens,
  admin: AuditUser,
  producerVersion: string,
): void {
  const { binding, input, stamp } = backupAudit(job, request, tokens, admin, producerVersion)
  sink.checkpointBackup(binding, input, stamp)
}

/** The engine calls this once per physical run, before any notification throttling. */
export async function recordBackupAudit(
  sink: Pick<AuditSink, 'record'>,
  job: BackupJob,
  request: BackupRequest,
  tokens: RunTokens,
  admin: AuditUser,
  producerVersion: string,
): Promise<void> {
  const { binding, input, stamp } = backupAudit(job, request, tokens, admin, producerVersion)
  return sink.record(binding, input, stamp)
}

export function backupAudit(job: BackupJob, request: BackupRequest, tokens: RunTokens, admin: AuditUser, producerVersion: string) {
  const reader = tokens.mode === 'app-only'
  const user = reader ? { id: tokens.auditUser?.id ?? tokens.registrationId ?? 'unknown', email: '', name: 'Backup Reader service principal' } : tokens.auditUser ?? admin
  const warnings = (job.results?.warnings ?? 0) > 0 || (job.failures ?? 0) > 0
  const status: AuditJobStatus = job.commitUnconfirmed || job.status === 'Running' || job.status === 'Queued' ? 'uncertain' : job.status === 'Cancelled' ? 'cancelled' : job.status === 'Failed' ? 'failed' : warnings ? 'warnings' : 'completed'
  const reason = status === 'uncertain' ? 'WRITE_UNCONFIRMED' : status === 'cancelled' ? 'BACKUP_CANCELLED' : status === 'warnings' ? 'BACKUP_WARNINGS'
    : status === 'failed' ? job.unreachable ? 'BACKUP_UNREACHABLE' : 'BACKUP_FAILED' : undefined
  const binding = { tenantId: job.tenantId, storageAccountName: job.storageAccountName, user }
  const input = {
    eventType: status === 'cancelled' ? AuditEventType.BACKUP_CANCELLED : status === 'failed' ? AuditEventType.BACKUP_FAILED : AuditEventType.BACKUP_COMPLETED,
    action: 'Complete backup', resource: { type: 'backup' as const, id: job.backupFolder ?? job.id, name: 'Complete backup' },
    result: status === 'completed' ? AuditResult.SUCCESS : status === 'failed' ? AuditResult.FAILURE : AuditResult.PARTIAL,
    severity: status === 'completed' || status === 'cancelled' ? AuditSeverity.INFO : status === 'failed' ? AuditSeverity.ERROR : AuditSeverity.WARNING,
    job: { operationId: job.id, runId: job.id, stage: 'terminal' as const, producer: reader ? 'backup-reader' as const : 'desktop' as const, status,
      trigger: request.trigger ?? 'manual', registrationId: reader ? tokens.registrationId : undefined, producerVersion, reason,
      counts: { saved: job.totalPolicies, failures: job.failures },
    },
  }
  return { binding, input, stamp: { id: job.id, timestamp: job.endTime ?? job.startTime } }
}

type BackupManifest = {
  RunId?: string; TenantId?: string; Status?: string; RunStatus?: string; RunCounts?: { saved?: number; failures?: number }; AuthMode?: string; CompletedAt?: string; CompanionBackup?: string;
  ItemCounts?: Record<string, number | undefined> & { TotalPolicies?: number }; Failures?: number; MaskedSecretItems?: unknown[];
}
type ManifestStatus = 'completed' | 'warnings' | 'failed' | 'cancelled' | 'uncertain'
const RANK: Record<ManifestStatus, number> = { completed: 0, warnings: 1, cancelled: 2, failed: 3, uncertain: 4 }
/** A run's own committed manifest, or null when absent, unparseable or from another run. */
async function runManifest(entry: AuditLogEntry, response: Response): Promise<BackupManifest | null> {
  if (response.status === 0 || response.status === 408 || retryableStatus(response.status)) {
    throw new Error('Backup audit manifest is temporarily unavailable')
  }
  if (!response.ok) return null
  const parsed = await readJsonCapped(response, MAX_BACKUP_ARCHIVE_BYTES)
  if (parsed.kind !== 'json' || !parsed.value || typeof parsed.value !== 'object') return null
  const manifest = parsed.value as BackupManifest
  const authMode = entry.job?.producer === 'backup-reader' ? 'app-only' : 'delegated'
  return manifest.RunId === entry.job?.runId && manifest.TenantId === entry.user.tenantId && manifest.AuthMode === authMode ? manifest : null
}
const manifestStatus = (manifest: BackupManifest): ManifestStatus => manifest.Status === 'Success' ? manifest.MaskedSecretItems?.length ? 'warnings' : 'completed'
  : manifest.Status === 'CompletedWithWarnings' ? 'warnings' : manifest.Status === 'Failed' ? 'failed'
    : manifest.Status === 'Cancelled' ? 'cancelled' : 'uncertain'

/**
 * Confirm an interrupted run from its own committed manifest under the original binding. A run
 * split across an ordinary and a large backup commits two manifests: both must be terminal, the
 * worse status wins and the totals add up. A start checkpoint names the ordinary folder before a
 * large-only run switches to its large folder, so `read` also tries that folder. A failed or
 * cancelled ordinary half whose large half was never committed confirms its own status.
 */
export async function reconcileBackupAudit(entry: AuditLogEntry, readManifest: () => Promise<Response>, read?: (folder: string) => Promise<Response>): Promise<AuditLogEntry> {
  let folder = entry.resource.id
  let manifest = await runManifest(entry, await readManifest())
  const large = folder.replace(/^backup-(?=\d)/, 'backup-large-')
  if (!manifest && read && large !== folder) {
    manifest = await runManifest(entry, await read(large))
    if (manifest) folder = large
  }
  if (!manifest) return entry
  let status = manifestStatus(manifest)
  if (status === 'uncertain') return entry
  let saved = manifest.ItemCounts?.TotalPolicies, failures = manifest.Failures, completedAt = time(manifest.CompletedAt)
  if (manifest.CompanionBackup !== undefined) {
    if (typeof manifest.CompanionBackup !== 'string' || !read) return entry
    const response = await read(manifest.CompanionBackup)
    const companion = await runManifest(entry, response)
    if (!companion) {
      // Only an ordinary half can confirm a run whose large half was never committed: its final
      // manifest names the status the run ended with, or the half itself failed or was cancelled.
      if (response.status !== 404 || folder.startsWith('backup-large-')) return entry
      const reported = typeof manifest.RunStatus === 'string' ? manifestStatus({ ...manifest, Status: manifest.RunStatus }) : 'uncertain'
      if (reported !== 'uncertain') {
        status = reported
        // The run's own totals include a large half that saved items but never committed its manifest.
        if (typeof manifest.RunCounts?.saved === 'number') saved = manifest.RunCounts.saved
        if (typeof manifest.RunCounts?.failures === 'number') failures = manifest.RunCounts.failures
      } else if (status !== 'failed' && status !== 'cancelled') return entry
    } else {
      const other = manifestStatus(companion)
      if (other === 'uncertain') return entry
      // Without the run's own status, an explicit cancellation of either half ends the run as cancelled.
      if (status === 'cancelled' || other === 'cancelled') status = 'cancelled'
      else if (RANK[other] > RANK[status]) status = other
      const add = (a?: number, b?: number) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
      saved = add(saved, companion.ItemCounts?.TotalPolicies); failures = add(failures, companion.Failures)
      const companionCompleted = time(companion.CompletedAt)
      if (companionCompleted && (!completedAt || companionCompleted > completedAt)) completedAt = companionCompleted
      // The run's last manifest names the status the engine reported. Older ones follow its rule:
      // a failed half next to saved items completes with warnings.
      const final = [manifest, companion].find(half => typeof half.RunStatus === 'string')
      if (final) {
        const run = manifestStatus({ ...final, Status: final.RunStatus })
        if (run !== 'uncertain') status = run
        // The run's own totals count each failure once, as the live record does.
        if (typeof final.RunCounts?.saved === 'number') saved = final.RunCounts.saved
        if (typeof final.RunCounts?.failures === 'number') failures = final.RunCounts.failures
      } else if (status === 'failed' && savedObjects(manifest) + savedObjects(companion) > 0) status = 'warnings'
    }
  }
  return {
    ...entry, timestamp: completedAt ?? entry.timestamp,
    resource: { ...entry.resource, id: folder },
    eventType: status === 'failed' ? AuditEventType.BACKUP_FAILED : status === 'cancelled' ? AuditEventType.BACKUP_CANCELLED : AuditEventType.BACKUP_COMPLETED,
    result: status === 'completed' ? AuditResult.SUCCESS : status === 'failed' ? AuditResult.FAILURE : AuditResult.PARTIAL,
    severity: status === 'failed' ? AuditSeverity.ERROR : status === 'warnings' ? AuditSeverity.WARNING : AuditSeverity.INFO,
    job: { ...entry.job!, status,
      reason: status === 'warnings' ? 'BACKUP_WARNINGS' : status === 'failed' ? 'BACKUP_FAILED' : status === 'cancelled' ? 'BACKUP_CANCELLED' : undefined,
      counts: { saved, failures },
    },
  }
}
/** Saved objects of every type, as the engine counts them for the run status. */
const savedObjects = (manifest: BackupManifest) => {
  const types = Object.entries(manifest.ItemCounts ?? {}).filter(([folder, count]) => folder !== 'TotalPolicies' && typeof count === 'number')
  return types.length ? types.reduce((sum, [, count]) => sum + (count as number), 0) : manifest.ItemCounts?.TotalPolicies ?? 0
}
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
