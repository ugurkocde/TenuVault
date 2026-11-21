import { AuditEventType, AuditResult, AuditSeverity, type AuditUser } from '~/lib/audit/types'
import type { AuditSink } from '../api/audit-sink'
import type { BackupJob, BackupRequest, RunTokens } from './engine'

/** The engine calls this once per physical run, before any notification throttling. */
export function recordBackupAudit(
  sink: Pick<AuditSink, 'record'>,
  job: BackupJob,
  request: BackupRequest,
  tokens: RunTokens,
  admin: AuditUser,
  producerVersion: string,
): Promise<void> {
  const reader = tokens.mode === 'app-only'
  const user = reader ? { id: tokens.auditUser?.id ?? tokens.registrationId ?? 'unknown', email: '', name: 'Backup Reader service principal' } : tokens.auditUser ?? admin
  const warnings = (job.results?.warnings ?? 0) > 0 || (job.failures ?? 0) > 0
  const status = job.status === 'Cancelled' ? 'cancelled' : job.status === 'Failed' ? 'failed' : warnings ? 'warnings' : 'completed'
  const reason = status === 'cancelled' ? 'BACKUP_CANCELLED' : status === 'warnings' ? 'BACKUP_WARNINGS'
    : status === 'failed' ? job.unreachable ? 'BACKUP_UNREACHABLE' : 'BACKUP_FAILED' : undefined
  return sink.record({ tenantId: job.tenantId, storageAccountName: job.storageAccountName, user }, {
    eventType: status === 'cancelled' ? AuditEventType.BACKUP_CANCELLED : status === 'failed' ? AuditEventType.BACKUP_FAILED : AuditEventType.BACKUP_COMPLETED,
    action: 'Complete backup', resource: { type: 'backup', id: job.backupFolder ?? job.id, name: 'Complete backup' },
    result: status === 'completed' ? AuditResult.SUCCESS : status === 'failed' ? AuditResult.FAILURE : AuditResult.PARTIAL,
    severity: status === 'completed' || status === 'cancelled' ? AuditSeverity.INFO : status === 'failed' ? AuditSeverity.ERROR : AuditSeverity.WARNING,
    job: { operationId: job.id, runId: job.id, stage: 'terminal', producer: reader ? 'backup-reader' : 'desktop', status,
      trigger: request.trigger ?? 'manual', registrationId: reader ? tokens.registrationId : undefined, producerVersion, reason,
      counts: { saved: job.totalPolicies, failures: job.failures },
    },
  }, { id: job.id, timestamp: job.endTime ?? job.startTime })
}
