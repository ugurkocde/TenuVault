import { csvCell } from '../../../shared/security'
import { REDACTED, redactSecrets, redactText } from '../../../shared/compliance/export'
import { projectEntry } from './projection'
import { AuditResult, type AuditLogEntry, type AuditLogFilter } from './types'

/**
 * Raw export of TenuVault's own operation history (Pro and MSP). Pure: the routes read the
 * entries, this module decides what leaves the device and how it is described.
 */

/** Shown on the audit page and at the top of every export. */
export const OWN_OPERATION_NOTICE = 'TenuVault own-operation history: actions TenuVault producers recorded for this tenant. It is not a complete Microsoft tenant audit and does not show activity from the Intune admin center, other tools or other administrators. Use the Microsoft Entra and Intune audit logs for that.'

/** Legacy events may still contain data from old writers. Export only known detail fields. */
export function redactAuditEntry(entry: AuditLogEntry): AuditLogEntry {
  return projectEntry(redactSecrets(entry))
}

/** Verified, failed, partial or unknown: an entry without a recorded result stays unknown. */
export function outcomeLabel(result: unknown): 'Succeeded' | 'Failed' | 'Partial' | 'Unknown' {
  return result === AuditResult.SUCCESS ? 'Succeeded' : result === AuditResult.FAILURE ? 'Failed' : result === AuditResult.PARTIAL ? 'Partial' : 'Unknown'
}

/** The admin who acted, or a plain statement that it was not recorded. */
export function actorLabel(entry: AuditLogEntry): string {
  const { name, email } = entry.user ?? {}
  const known = (value: unknown) => typeof value === 'string' && value && !/^(unknown|unknown user|system)$/i.test(value) && value !== 'system@tenuvault.com'
  if (known(name) && known(email) && name !== email) return `${name} <${email}>`
  if (known(email)) return String(email)
  if (known(name)) return String(name)
  return 'Not recorded'
}

/**
 * Only entries of the requested tenant. Entries record their tenant from this release on;
 * older entries without one are kept, because they come from the tenant's own storage.
 */
export function entriesForTenant(entries: AuditLogEntry[], tenantId: string): AuditLogEntry[] {
  const tenant = tenantId.toLowerCase()
  return entries.filter(entry => !entry.user?.tenantId || entry.user.tenantId.toLowerCase() === tenant)
}

export interface AuditExportMeta {
  tenantId: string
  exportedAt: string
  filter: AuditLogFilter
  /** Events recorded on this device that are not yet in storage, or null when unknown. */
  pendingCount: number | null
}

function pendingNote(pending: number | null): string {
  if (pending === null) return 'Events waiting to be saved could not be counted; this export may be incomplete.'
  return pending ? `${pending} recorded events are still waiting to be saved to storage and are not in this export.` : 'No recorded events were waiting to be saved.'
}

/** JSON export: notice, provenance and the redacted entries. */
export function auditExportJSON(entries: AuditLogEntry[], meta: AuditExportMeta): string {
  return JSON.stringify({
    notice: OWN_OPERATION_NOTICE,
    tenantId: meta.tenantId.toLowerCase(),
    exportedAt: meta.exportedAt,
    filter: {
      startDate: meta.filter.startDate, endDate: meta.filter.endDate,
      eventTypes: meta.filter.eventTypes, severities: meta.filter.severities, results: meta.filter.results,
      sortBy: meta.filter.sortBy, sortOrder: meta.filter.sortOrder,
    },
    completeness: pendingNote(meta.pendingCount),
    redaction: `Tokens, credentials, secrets, policy payloads and stack traces are replaced with ${REDACTED} or omitted.`,
    count: entries.length,
    logs: entries.map(redactAuditEntry),
  }, null, 2)
}

/** CSV export: notice rows, then one row per operation. */
export function auditExportCSV(entries: AuditLogEntry[], meta: AuditExportMeta): string {
  const rows: unknown[][] = [
    ['Notice', OWN_OPERATION_NOTICE],
    ['Tenant', meta.tenantId.toLowerCase()],
    ['Exported', meta.exportedAt],
    ['Completeness', pendingNote(meta.pendingCount)],
    [],
    ['Timestamp', 'Operation', 'Event type', 'Actor', 'Affected scope', 'Outcome', 'Severity', 'Correlation ID', 'Details'],
    ...entries.map(redactAuditEntry).map(entry => [
      entry.timestamp, entry.action, entry.eventType, actorLabel(entry),
      `${entry.resource?.type ?? 'unknown'}: ${entry.resource?.name ?? 'Unknown'}${entry.resource?.id ? ` (${entry.resource.id})` : ''}`,
      entry.job?.status ?? outcomeLabel(entry.result), entry.severity, entry.context?.correlationId ?? '', entry.job || entry.details ? JSON.stringify({ ...entry.details, job: entry.job }) : '',
    ]),
  ]
  return rows.map(row => row.map(cell => csvCell(typeof cell === 'string' ? redactText(cell) : cell)).join(',')).join('\r\n')
}
