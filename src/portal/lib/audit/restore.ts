import { randomUUID } from 'node:crypto'
import { auditUserFromToken, mainAuditSink, type AuditSink } from '../../../main/api/audit-sink'
import { typeForFolder } from '../../../shared/intune/registry'
import { OMISSION_BLOCKER } from '../../../shared/intune/secret-omission'
import type { RestoreOutcome } from '../policies/graph-restore'
import { auditId } from './projection'
import { AuditEventType, AuditResult, AuditSeverity, type AuditJobItem, type AuditJobStage } from './types'

interface RestoreDestination {
  destination: string
  sourceTenantId?: string
  graphToken?: string
}

interface RestorePreparation extends RestoreDestination {
  sourceBackupId: string
  operationId: string
  runId: string
  action: string
}

function restoreBinding(sink: AuditSink, input: RestoreDestination) {
  const destination = sink.bind(input.destination)
  // The source binding routes the event to storage. The actor still belongs to the destination.
  const binding = destination ?? (input.sourceTenantId ? sink.bind(input.sourceTenantId) : undefined)
  if (!binding) return undefined
  const actor = input.graphToken ? auditUserFromToken(input.graphToken, input.destination) : undefined
  const user = actor ?? destination?.user ?? { id: 'unknown', email: '', name: 'Unknown user' }
  return { binding: { ...binding, user }, destinationTenantId: destination ? undefined : input.destination }
}

export async function recordRestorePreparationFailure(input: RestorePreparation, cancelled = false): Promise<void> {
  const sink = mainAuditSink()
  if (!sink) return
  const target = restoreBinding(sink, input)
  if (!target) return
  await sink.record(target.binding, {
    eventType: AuditEventType.RESTORE_FAILED, action: input.action,
    resource: { type: 'backup', id: input.sourceBackupId, name: 'Restore backup' },
    result: AuditResult.FAILURE, severity: cancelled ? AuditSeverity.INFO : AuditSeverity.ERROR,
    job: {
      operationId: input.operationId, runId: input.runId, stage: 'terminal', producer: 'desktop',
      sourceBackupId: input.sourceBackupId, destinationTenantId: target.destinationTenantId,
      status: cancelled ? 'cancelled' : 'failed', counts: {}, reason: 'RESTORE_PREPARATION_FAILED',
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
    skipped: result?.error === OMISSION_BLOCKER ? 'RESTORE_VALUES_OMITTED' : 'RESTORE_SKIPPED', failed: 'WRITE_FAILED', uncertain: 'WRITE_UNCONFIRMED',
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
  sourceBackupId: string
  items: AuditJobItem[]
  operationId: string
  runId?: string
  eventId?: string
  correlation?: import('../../../main/api/audit-sink').RestoreCorrelation
  stage?: AuditJobStage
  action: string
  eventType?: AuditEventType
} & RestoreDestination) {
  const sink = mainAuditSink()
  try {
    if (!sink) return undefined
    const target = restoreBinding(sink, input)
    if (!target) return undefined
    return sink.begin(target.binding, {
      eventType: input.eventType ?? AuditEventType.RESTORE_COMPLETED, action: input.action,
      resource: { type: 'backup', id: input.sourceBackupId, name: 'Restore backup' },
      job: { operationId: input.operationId, runId: input.runId ?? randomUUID(), stage: input.stage ?? 'terminal',
        producer: 'desktop', status: 'uncertain', sourceBackupId: input.sourceBackupId,
        destinationTenantId: target.destinationTenantId, counts: {}, items: input.items },
    }, { eventId: input.eventId, correlation: input.correlation })
  } catch {
    console.warn('[audit] Restore audit could not be started')
    return undefined
  }
}
