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
 * Confirm an interrupted run from its own committed manifest under the original binding.
 *
 * A standalone run (ordinary or large) is confirmed by its own terminal manifest. A start
 * checkpoint names the ordinary folder before a large-only run switches to its large folder, so
 * `read` also tries that folder.
 *
 * A split run (an ordinary and a large half) is confirmed only by the ordinary half's final
 * manifest, which records the status and totals the run ended with. Nothing is inferred from the
 * halves: an early or stopped manifest leaves the record uncertain, and the large half is never read.
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
  let saved = manifest.ItemCounts?.TotalPolicies, failures = manifest.Failures
  if (manifest.CompanionBackup !== undefined) {
    if (folder.startsWith('backup-large-') || typeof manifest.RunStatus !== 'string') return entry
    status = manifestStatus({ ...manifest, Status: manifest.RunStatus })
    saved = typeof manifest.RunCounts?.saved === 'number' ? manifest.RunCounts.saved : undefined
    failures = typeof manifest.RunCounts?.failures === 'number' ? manifest.RunCounts.failures : undefined
  }
  if (status === 'uncertain') return entry
  return {
    ...entry, timestamp: time(manifest.CompletedAt) ?? entry.timestamp,
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
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
