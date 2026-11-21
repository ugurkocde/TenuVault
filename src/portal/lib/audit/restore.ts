import { randomUUID } from 'node:crypto'
import { auditUserFromToken, mainAuditSink } from '../../../main/api/audit-sink'
import { typeForFolder } from '../../../shared/intune/registry'
import type { RestoreOutcome } from '../policies/graph-restore'
import { auditId } from './projection'
import { AuditEventType, AuditResult, AuditSeverity, type AuditJobItem, type AuditJobStage } from './types'

export async function recordRestorePreparationFailure(input: {
  destination: string
  graphToken?: string
  sourceBackupId: string
  operationId: string
  runId: string
  action: string
}): Promise<void> {
  const sink = mainAuditSink()
  const binding = sink?.bind(input.destination)
  if (!binding || !sink) return
  const user = input.graphToken && auditUserFromToken(input.graphToken, input.destination)
  await sink.record(user ? { ...binding, user } : binding, {
    eventType: AuditEventType.RESTORE_FAILED, action: input.action,
    resource: { type: 'backup', id: input.sourceBackupId, name: 'Restore backup' },
    result: AuditResult.FAILURE, severity: AuditSeverity.ERROR,
    job: {
      operationId: input.operationId, runId: input.runId, stage: 'terminal', producer: 'desktop',
      sourceBackupId: input.sourceBackupId, status: 'failed', counts: {}, reason: 'RESTORE_PREPARATION_FAILED',
    },
  })
}

export function restoreAuditItem(path: string, result?: RestoreOutcome, sourceId?: string): AuditJobItem {
  const folder = path.split('/')[1] ?? ''
  const outcome = !result ? 'unattempted' : result.approval ? 'pending' : result.partial && (result.auditApplied?.length || !result.auditPlanned) ? 'partial'
    : result.action === 'skipped' ? 'skipped' : !result.success ? result.auditUncertain ? 'uncertain' : 'failed'
      : result.action ?? 'uncertain'
  const reason = {
    unattempted: 'NOT_ATTEMPTED', pending: 'AWAITING_INTUNE_APPROVAL', partial: 'WRITE_PARTIAL',
    skipped: 'RESTORE_SKIPPED', failed: 'WRITE_FAILED', uncertain: 'WRITE_UNCONFIRMED',
    created: undefined, updated: undefined, unchanged: undefined,
  }[outcome]
  return {
    folder: typeForFolder(folder)?.folder ?? (folder === 'DeviceCompliancePolicies' ? 'CompliancePolicies' : 'Policy'),
    sourceId: result?.auditSourceId ?? sourceId ?? auditId(path), targetId: result?.policyId, outcome, reason,
    planned: result?.auditPlanned, applied: result?.auditApplied, steps: result?.auditSteps,
    approval: result?.auditApprover ?? (result?.approvalId ? { system: 'intune', requestId: result.approvalId } : undefined),
  }
}

export function beginRestoreAudit(input: {
  destination: string
  graphToken?: string
  sourceBackupId: string
  items: AuditJobItem[]
  operationId: string
  runId?: string
  eventId?: string
  correlation?: import('../../../main/api/audit-sink').RestoreCorrelation
  stage?: AuditJobStage
  action: string
  eventType?: AuditEventType
}) {
  const sink = mainAuditSink()
  try {
    const binding = sink?.bind(input.destination)
    if (!binding || !sink) return undefined
    const user = input.graphToken ? auditUserFromToken(input.graphToken, input.destination) : undefined
    return sink.begin(user ? { ...binding, user } : binding, {
      eventType: input.eventType ?? AuditEventType.RESTORE_COMPLETED, action: input.action,
      resource: { type: 'backup', id: input.sourceBackupId, name: 'Restore backup' },
      job: { operationId: input.operationId, runId: input.runId ?? randomUUID(), stage: input.stage ?? 'terminal',
        producer: 'desktop', status: 'uncertain', sourceBackupId: input.sourceBackupId, counts: {}, items: input.items },
    }, { eventId: input.eventId, correlation: input.correlation })
  } catch {
    console.warn('[audit] Restore audit could not be started')
    return undefined
  }
}
