export enum AuditEventType {
  // Authentication Events
  AUTH_LOGIN = 'AUTH_LOGIN',
  AUTH_LOGOUT = 'AUTH_LOGOUT',
  AUTH_FAILED = 'AUTH_FAILED',
  AUTH_TOKEN_REFRESH = 'AUTH_TOKEN_REFRESH',
  
  // Tenant Events
  TENANT_CREATED = 'TENANT_CREATED',
  TENANT_UPDATED = 'TENANT_UPDATED',
  TENANT_DELETED = 'TENANT_DELETED',
  TENANT_SELECTED = 'TENANT_SELECTED',
  
  // Backup Events
  BACKUP_STARTED = 'BACKUP_STARTED',
  BACKUP_COMPLETED = 'BACKUP_COMPLETED',
  BACKUP_FAILED = 'BACKUP_FAILED',
  BACKUP_CANCELLED = 'BACKUP_CANCELLED',
  BACKUP_DOWNLOADED = 'BACKUP_DOWNLOADED',
  
  // Restore Events
  RESTORE_STARTED = 'RESTORE_STARTED',
  RESTORE_COMPLETED = 'RESTORE_COMPLETED',
  RESTORE_FAILED = 'RESTORE_FAILED',
  
  // Schedule Events
  SCHEDULE_CREATED = 'SCHEDULE_CREATED',
  SCHEDULE_UPDATED = 'SCHEDULE_UPDATED',
  SCHEDULE_DELETED = 'SCHEDULE_DELETED',
  SCHEDULE_ENABLED = 'SCHEDULE_ENABLED',
  SCHEDULE_DISABLED = 'SCHEDULE_DISABLED',
  SCHEDULE_TRIGGERED = 'SCHEDULE_TRIGGERED',
  
  // Policy Events
  POLICY_CREATED = 'POLICY_CREATED',
  POLICY_REVERTED = 'POLICY_REVERTED',
  POLICY_RESTORED = 'POLICY_RESTORED',
  POLICY_DRIFT_DETECTED = 'POLICY_DRIFT_DETECTED',

  // Change Set Events
  CHANGE_SET_APPLIED = 'CHANGE_SET_APPLIED',
  CHANGE_SET_ROLLED_BACK = 'CHANGE_SET_ROLLED_BACK',
  
  // Configuration Events
  CONFIG_UPDATED = 'CONFIG_UPDATED',
  CONFIG_EXPORTED = 'CONFIG_EXPORTED',
  
  // Security Events
  SECURITY_PERMISSION_DENIED = 'SECURITY_PERMISSION_DENIED',
  SECURITY_SUSPICIOUS_ACTIVITY = 'SECURITY_SUSPICIOUS_ACTIVITY',
  SECURITY_API_KEY_CREATED = 'SECURITY_API_KEY_CREATED',
  SECURITY_API_KEY_REVOKED = 'SECURITY_API_KEY_REVOKED',
}

export enum AuditSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

// Keep the full enums for stored entries and the retry queue. Filters list desktop emissions only.
export const DESKTOP_AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  AuditEventType.BACKUP_STARTED,
  AuditEventType.BACKUP_COMPLETED,
  AuditEventType.BACKUP_FAILED,
  AuditEventType.BACKUP_CANCELLED,
  AuditEventType.BACKUP_DOWNLOADED,
  AuditEventType.RESTORE_COMPLETED,
  AuditEventType.RESTORE_FAILED,
  AuditEventType.POLICY_CREATED,
  AuditEventType.POLICY_REVERTED,
  AuditEventType.POLICY_RESTORED,
  AuditEventType.POLICY_DRIFT_DETECTED,
  AuditEventType.CHANGE_SET_APPLIED,
  AuditEventType.CHANGE_SET_ROLLED_BACK,
]

export const DESKTOP_AUDIT_SEVERITIES: readonly AuditSeverity[] = [
  AuditSeverity.INFO,
  AuditSeverity.WARNING,
  AuditSeverity.ERROR,
]

export enum AuditResult {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  PARTIAL = 'PARTIAL',
}

export interface AuditUser {
  id: string
  email: string
  name: string
  tenantId?: string
  roles?: string[]
}

export interface AuditResource {
  type: 'tenant' | 'backup' | 'schedule' | 'policy' | 'configuration' | 'user'
  id: string
  name: string
  parentId?: string
  parentType?: string
}

export interface AuditContext {
  ipAddress: string
  userAgent: string
  sessionId?: string
  correlationId?: string
  requestId?: string
}

export interface AuditDetails {
  [key: string]: any
  changes?: Array<{
    field: string
    oldValue: any
    newValue: any
  }>
  error?: {
    code: string
    message: string
    stack?: string
  }
  metadata?: Record<string, any>
}

export interface AuditLogEntry {
  id: string
  timestamp: string
  eventType: AuditEventType
  severity: AuditSeverity
  user: AuditUser
  action: string
  resource: AuditResource
  result: AuditResult
  context: AuditContext
  details?: AuditDetails
  duration?: number // in milliseconds
  tags?: string[]
}

export interface AuditLogFilter {
  /** Only this tenant's entries; entries recorded before tenants were stamped are kept. */
  tenantId?: string
  startDate?: Date
  endDate?: Date
  eventTypes?: AuditEventType[]
  severities?: AuditSeverity[]
  userIds?: string[]
  userEmails?: string[]
  resourceTypes?: string[]
  resourceIds?: string[]
  results?: AuditResult[]
  searchQuery?: string
  ipAddress?: string
  tags?: string[]
  limit?: number
  offset?: number
  sortBy?: 'timestamp' | 'eventType' | 'severity' | 'user' | 'result'
  sortOrder?: 'asc' | 'desc'
}

export interface AuditLogStats {
  totalEvents: number
  eventsByType: Record<AuditEventType, number>
  eventsBySeverity: Record<AuditSeverity, number>
  eventsByResult: Record<AuditResult, number>
  eventsByHour: Array<{ hour: string; count: number }>
  topUsers: Array<{ user: AuditUser; count: number }>
  topResources: Array<{ resource: AuditResource; count: number }>
  recentFailures: AuditLogEntry[]
  securityEvents: AuditLogEntry[]
}

export interface AuditExportOptions {
  format: 'json' | 'csv' | 'pdf'
  filter: AuditLogFilter
  includeDetails?: boolean
  timezone?: string
}

// Helper type for creating audit log entries
export interface CreateAuditLogInput {
  eventType: AuditEventType
  action: string
  resource: AuditResource
  details?: AuditDetails
  severity?: AuditSeverity
  result?: AuditResult
  duration?: number
  tags?: string[]
}

// Type guards
export function isAuthEvent(eventType: AuditEventType): boolean {
  return eventType.startsWith('AUTH_')
}

export function isTenantEvent(eventType: AuditEventType): boolean {
  return eventType.startsWith('TENANT_')
}

export function isBackupEvent(eventType: AuditEventType): boolean {
  return eventType.startsWith('BACKUP_')
}

export function isScheduleEvent(eventType: AuditEventType): boolean {
  return eventType.startsWith('SCHEDULE_')
}

export function isPolicyEvent(eventType: AuditEventType): boolean {
  return eventType.startsWith('POLICY_')
}

export function isSecurityEvent(eventType: AuditEventType): boolean {
  return eventType.startsWith('SECURITY_')
}

// Severity helpers
export function getDefaultSeverity(eventType: AuditEventType): AuditSeverity {
  if (eventType.includes('FAILED') || eventType.includes('DENIED')) {
    return AuditSeverity.ERROR
  }
  if (eventType.includes('SECURITY') || eventType.includes('SUSPICIOUS')) {
    return AuditSeverity.WARNING
  }
  if (eventType.includes('DELETED') || eventType.includes('REVOKED')) {
    return AuditSeverity.WARNING
  }
  return AuditSeverity.INFO
}

// Event type display helpers
export function getEventTypeDisplay(eventType: AuditEventType): string {
  return eventType
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ')
}

export function getEventTypeIcon(eventType: AuditEventType): string {
  if (isAuthEvent(eventType)) return 'shield'
  if (isTenantEvent(eventType)) return 'building2'
  if (isBackupEvent(eventType)) return 'database'
  if (isScheduleEvent(eventType)) return 'calendar'
  if (isPolicyEvent(eventType)) return 'git-compare'
  if (isSecurityEvent(eventType)) return 'alert-triangle'
  return 'activity'
}

export function getEventTypeColor(eventType: AuditEventType): string {
  if (eventType.includes('FAILED') || eventType.includes('ERROR')) return 'red'
  if (eventType.includes('WARNING') || eventType.includes('SUSPICIOUS')) return 'orange'
  if (eventType.includes('SECURITY')) return 'purple'
  if (eventType.includes('SUCCESS') || eventType.includes('COMPLETED')) return 'green'
  return 'blue'
}
