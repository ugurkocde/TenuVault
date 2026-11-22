import { isGraphPropertyName } from './graph-property-schema'
import { sha256Hex } from '../../../shared/notifications/envelope'
import { isGuid } from '../../../shared/security'
import { redactText } from '../../../shared/compliance/export'
import { type AuditApproval, type AuditChange, type AuditDetails, type AuditJob, type AuditJobItem, type AuditLogEntry, getEventTypeDisplay } from './types'

const fixedFields = new Set([
  'displayName', 'name', 'description', 'roleScopeTagIds', 'assignments', 'settings', 'definitionValues',
  'scheduledActionsForRule', 'platforms', 'technologies', 'templateReference', 'priority', 'isAssigned',
  'state', 'conditions', 'grantControls', 'sessionControls', 'requirements', 'rules', 'relationships',
  'installCommandLine', 'uninstallCommandLine', 'installExperience', 'returnCodes', 'publisher',
  'committedContentVersion', 'metadata', 'content', 'allowedCombinations', 'localizedNotificationMessages',
  'omaSettings', 'settingInstance', 'deviceComplianceScheduledActionForRules', 'scheduledActions', 'deviceName', 'groupTag', 'userPrincipalName', 'enrollmentStatusScreenSettings', 'settingsDelta',
])

const fixedReasons = new Set([
  'WRITE_FAILED', 'WRITE_UNCONFIRMED', 'WRITE_PARTIAL', 'RESTORE_SKIPPED', 'RESTORE_PREPARATION_FAILED', 'AWAITING_INTUNE_APPROVAL',
  'NOT_ATTEMPTED', 'PROCESS_INTERRUPTED', 'BACKUP_FAILED', 'BACKUP_WARNINGS', 'BACKUP_UNREACHABLE',
  'BACKUP_CANCELLED', 'FOLDER_CLAIM_FAILED', 'GRAPH_START_FAILED', 'GRAPH_LIST_FAILED', 'APP_RESTORE_FAILED',
  'APPROVAL_COMPLETION_REFUSED', 'RECONCILE_REQUIRED', 'CHANGE_SET_APPLY_FAILED', 'BASELINE_CREATION_FAILED', 'OIB_FAILED', 'RESTORE_FAILED',
])
const numericDetails = [
  'statusCode', 'restoredCount', 'partialCount', 'failedCount', 'approvalCount', 'skippedCount',
  'unchangedCount', 'duration', 'undone', 'notUndone', 'created', 'updated', 'skipped', 'failed',
  'attempt', 'operations', 'verified', 'uncertain', 'pending', 'deleted',
]
const enums: Record<string, readonly string[]> = {
  source: ['desktop', 'desktop-frameworks', 'desktop-oib', 'desktop-change-sets', 'schedule', 'desktop-governance'],
  method: ['POST'],
  path: ['/api/backup/start', '/api/download-backup'],
  status: ['Completed', 'Failed', 'PartiallyCompleted', 'AwaitingApproval', 'applied', 'partial', 'failed'],
  workflow: ['promotion', 'baseline-upgrade', 'standard-adoption', 'custom-baseline', 'cis-remediation', 'sync'],
  link: ["/portal/changes", "/portal/changes/promotion", "/portal/changes/baseline-upgrades", "/portal/sync", "/portal/baselines", "/portal/frameworks", "/portal/governance/customizations", "/portal/governance/standards", "/portal/governance/hygiene", "/portal/reports"],
  kind: ['apply', 'rollback'],
  decision: ['created', 'revised', 'reopened', 'acknowledged', 'false-positive'],
}
const stableDetails = ['runId', 'backupId', 'backupFolder', 'originRecordId', 'changeSetId', 'rollbackOf', 'recordId', 'adoptionId']
const fixedActions = new Set([
  'Start backup', 'Download backup', 'Complete backup', 'Restore backup in place', 'Restore backup as policy copies',
  'Restore submitted for approval', 'Complete approved restore item', 'Approval request withdrawn',
  'Revert policy to the backed-up version in place', 'Restore policy as an unassigned copy', 'Restore app backup',
  'Create unassigned baseline policy', 'Undo OpenIntuneBaseline run', 'Reset OpenIntuneBaseline policy drift',
  'Deploy OpenIntuneBaseline policies', 'Apply change set', 'Roll back change set', 'Approve change set',
  'Reject change set', 'Document customization', 'Revise customization', 'Retire customization',
  'Start standard adoption', 'Decide standard exceptions', 'Mark hygiene finding as false positive',
  'Acknowledge hygiene finding', 'Reopen hygiene finding', 'Send change report',
])

export function auditId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  if (isGuid(value) || /^(?:desktop-|app-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    || /^(?:backup-(?:large-)?)?\d{4}-?\d{2}-?\d{2}(?:[T_-][0-9Z_.-]+)?$/.test(value)
    || /^sha256-[a-f0-9]{64}$/.test(value)) return value
  return 'sha256-' + sha256Hex(value)
}

// Only a coarse input bound for catalog lookups. Syntax alone never authorizes persistence.
export const settingId = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 220 && /^(?:device|user)_[a-z0-9][a-z0-9_.-]+$/i.test(value)

const identity = (value: unknown) => typeof value === 'string' && ![...value].some(char => char.charCodeAt(0) < 32)
  ? redactText(value).slice(0, 200) : undefined
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined

function changes(value: AuditChange[] | undefined) {
  return Array.isArray(value) ? value.slice(0, 160).flatMap(change =>
    change && ['create', 'update', 'assign', 'publish'].includes(change.operation)
      ? [{ operation: change.operation,
          field: fixedFields.has(change.field ?? '') || isGraphPropertyName(change.field ?? '') ? change.field : undefined,
          ...(change.catalogVerified === true && settingId(change.settingDefinitionId)
            ? { settingDefinitionId: change.settingDefinitionId, catalogVerified: true as const } : {}),
        }]
      : []) : undefined
}

function approval(value: AuditApproval | undefined): AuditApproval | undefined {
  if (!value || !['intune', 'tenuvault'].includes(value.system)) return undefined
  return {
    system: value.system, requestId: auditId(value.requestId), decisionAt: value.system === 'tenuvault' ? time(value.decisionAt) : undefined,
    principalId: auditId(value.principalId), applicationId: auditId(value.applicationId),
    displayName: identity(value.displayName), upn: identity(value.upn),
    justificationPresent: value.justificationPresent === true || undefined,
  }
}

const outcomes = ['created', 'updated', 'unchanged', 'skipped', 'failed', 'partial', 'pending', 'unattempted', 'uncertain'] as const

export function projectItem(item: AuditJobItem): AuditJobItem {
  return {
    folder: /^[A-Za-z]{1,50}$/.test(item.folder) ? item.folder : 'Policy',
    sourceId: auditId(item.sourceId), targetId: auditId(item.targetId),
    outcome: outcomes.includes(item.outcome) ? item.outcome : 'uncertain',
    reason: fixedReasons.has(item.reason ?? '') ? item.reason : undefined,
    planned: changes(item.planned), applied: changes(item.applied), verified: changes(item.verified),
    approval: approval(item.approval),
    steps: Array.isArray(item.steps) ? item.steps.slice(0, 1000).filter(step =>
      step && ['content', 'assignments'].includes(step.kind) &&
      ['applied', 'failed', 'uncertain', 'pending', 'unattempted'].includes(step.outcome)
    ).map(({ kind, outcome }) => ({ kind, outcome })) : undefined,
  }
}

export function projectJob(job: AuditJob): AuditJob {
  const counts: AuditJob['counts'] = {}
  for (const key of [...outcomes, 'saved', 'failures'] as const) {
    const count = job.counts?.[key]
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) counts[key] = count
  }
  return {
    operationId: auditId(job.operationId) ?? 'unknown', runId: auditId(job.runId) ?? 'unknown',
    stage: ['terminal', 'approval-submit', 'approval-attempt', 'approval-complete', 'approval-withdraw', 'policy'].includes(job.stage) ? job.stage : 'terminal',
    producer: ['desktop', 'backup-reader', 'cloud-runbook'].includes(job.producer) ? job.producer : 'desktop',
    status: ['completed', 'warnings', 'failed', 'cancelled', 'pending', 'uncertain'].includes(job.status) ? job.status : 'uncertain',
    sourceBackupId: auditId(job.sourceBackupId), registrationId: auditId(job.registrationId),
    destinationTenantId: isGuid(job.destinationTenantId) ? job.destinationTenantId.toLowerCase() : undefined,
    producerPrincipalId: auditId(job.producerPrincipalId),
    deliveredByPrincipalId: auditId(job.deliveredByPrincipalId),
    trigger: job.trigger && ['manual', 'scheduled', 'tray', 'unknown'].includes(job.trigger) ? job.trigger : undefined,
    producerVersion: /^\d+\.\d+\.\d+$/.test(job.producerVersion ?? '') ? job.producerVersion : undefined,
    reason: fixedReasons.has(job.reason ?? '') ? job.reason : undefined,
    counts, items: Array.isArray(job.items) ? job.items.map(projectItem) : undefined,
    detailsIncomplete: job.detailsIncomplete === true || undefined,
    detailPages: Number.isSafeInteger(job.detailPages) && job.detailPages! > 0 ? job.detailPages : undefined,
  }
}

export function projectDetails(input?: AuditDetails): AuditDetails | undefined {
  if (!input) return undefined
  const safe: AuditDetails = {}
  for (const key of numericDetails) if (Number.isSafeInteger(input[key]) && input[key] >= 0) safe[key] = input[key]
  for (const key of ['backupSkipped', 'assigned', 'assignedToPilotGroup']) if (typeof input[key] === 'boolean') safe[key] = input[key]
  for (const [key, values] of Object.entries(enums)) if (values.includes(input[key])) safe[key] = input[key]
  for (const key of stableDetails) if (input[key]) safe[key] = auditId(input[key])
  if (input.error) safe.error = { code: fixedReasons.has(input.error.code) ? input.error.code : 'OPERATION_FAILED', message: 'Operation failed' }
  return safe
}

/** Writable fields only. The outbox, transport and logger all use this projection. */
export function projectEntry(entry: AuditLogEntry): AuditLogEntry {
  const action = fixedActions.has(entry.action) ? entry.action : getEventTypeDisplay(entry.eventType)
  return {
    id: /^[a-zA-Z0-9-]{1,128}$/.test(entry.id) ? entry.id : auditId(entry.id) ?? "unknown", timestamp: entry.timestamp, eventType: entry.eventType, severity: entry.severity, result: entry.result,
    user: {
      id: identity(entry.user.id) ?? 'unknown', email: identity(entry.user.email) ?? '',
      name: identity(entry.user.name) ?? 'Unknown user', tenantId: entry.user.tenantId,
    },
    action,
    resource: { type: entry.resource.type, id: auditId(entry.resource.id) ?? 'unknown', name: action },
    context: { ipAddress: 'unknown', userAgent: entry.job?.producer === 'cloud-runbook' ? 'TenuVault Cloud Backup' : 'TenuVault Desktop', correlationId: auditId(entry.context?.correlationId) },
    job: entry.job ? projectJob(entry.job) : undefined,
    details: projectDetails(entry.details),
    duration: typeof entry.duration === 'number' && Number.isFinite(entry.duration) ? entry.duration : undefined,
  }
}
