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

/** Confirm an interrupted run from its own committed manifest under the original binding. */
export async function reconcileBackupAudit(entry: AuditLogEntry, readManifest: () => Promise<Response>): Promise<AuditLogEntry> {
  const response = await readManifest()
  if (response.status === 0 || response.status === 408 || retryableStatus(response.status)) {
    throw new Error('Backup audit manifest is temporarily unavailable')
  }
  if (!response.ok) return entry
  const parsed = await readJsonCapped(response, MAX_BACKUP_ARCHIVE_BYTES)
  if (parsed.kind !== 'json' || !parsed.value || typeof parsed.value !== 'object') return entry
  const manifest = parsed.value as {
    RunId?: string; TenantId?: string; Status?: string; AuthMode?: string; CompletedAt?: string;
    ItemCounts?: { TotalPolicies?: number }; Failures?: number; MaskedSecretItems?: unknown[];
  }
  const authMode = entry.job?.producer === 'backup-reader' ? 'app-only' : 'delegated'
  if (manifest.RunId !== entry.job?.runId || manifest.TenantId !== entry.user.tenantId || manifest.AuthMode !== authMode) return entry
  const status = manifest.Status === 'Success' ? manifest.MaskedSecretItems?.length ? 'warnings' : 'completed'
    : manifest.Status === 'CompletedWithWarnings' ? 'warnings' : manifest.Status === 'Failed' ? 'failed'
      : manifest.Status === 'Cancelled' ? 'cancelled' : 'uncertain'
  if (status === 'uncertain') return entry
  const timestamp = typeof manifest.CompletedAt === 'string' && Number.isFinite(Date.parse(manifest.CompletedAt))
    ? new Date(manifest.CompletedAt).toISOString() : entry.timestamp
  return {
    ...entry, timestamp,
    eventType: status === 'failed' ? AuditEventType.BACKUP_FAILED : status === 'cancelled' ? AuditEventType.BACKUP_CANCELLED : AuditEventType.BACKUP_COMPLETED,
    result: status === 'completed' ? AuditResult.SUCCESS : status === 'failed' ? AuditResult.FAILURE : AuditResult.PARTIAL,
    severity: status === 'failed' ? AuditSeverity.ERROR : status === 'warnings' ? AuditSeverity.WARNING : AuditSeverity.INFO,
    job: { ...entry.job!, status,
      reason: status === 'warnings' ? 'BACKUP_WARNINGS' : status === 'failed' ? 'BACKUP_FAILED' : status === 'cancelled' ? 'BACKUP_CANCELLED' : undefined,
      counts: { saved: manifest.ItemCounts?.TotalPolicies, failures: manifest.Failures },
    },
  }
}
