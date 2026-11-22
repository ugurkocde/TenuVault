import { projectEntry } from './projection'
import type { KeyValueStore } from '../../../main/storage/secure-store'
import { AuditEventType, AuditSeverity, AuditResult, type AuditLogEntry } from './types'

const KEY = 'audit.pending-events'
let store: KeyValueStore | undefined
let memory: Record<string, AuditLogEntry[]> = {}
/** Desktop startup supplies its encrypted SecureStore. Tokens are never queued. */
export function setAuditOutboxStore(value?: KeyValueStore): void { store = value; memory = {} }
function read(): Record<string, AuditLogEntry[]> {
  const value: unknown = store ? JSON.parse(store.get(KEY) ?? '{}') : memory
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Audit retry queue cannot be read')
  return value as Record<string, AuditLogEntry[]>
}
function write(value: Record<string, AuditLogEntry[]>): void {
  for (const [account, entries] of Object.entries(value)) value[account] = entries.map(projectEntry)
  if (store) store.set(KEY, JSON.stringify(value))
  else memory = value
}
export function auditOutboxIsDurable(): boolean { return !!store }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string')
const optionalStrings = (value: Record<string, unknown>, fields: string[]) => fields.every(field => value[field] === undefined || typeof value[field] === 'string')
function validEntry(entry: unknown): entry is AuditLogEntry {
  if (!record(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp)) || !Object.values(AuditEventType).includes(entry.eventType as AuditEventType) || !Object.values(AuditSeverity).includes(entry.severity as AuditSeverity) || !Object.values(AuditResult).includes(entry.result as AuditResult) || typeof entry.action !== 'string') return false
  if (!record(entry.user) || !['id', 'email', 'name'].every(field => typeof (entry.user as Record<string, unknown>)[field] === 'string') || !optionalStrings(entry.user, ['tenantId']) || (entry.user.roles !== undefined && !strings(entry.user.roles))) return false
  if (!record(entry.resource) || !['tenant', 'backup', 'schedule', 'policy', 'configuration', 'user'].includes(String(entry.resource.type)) || typeof entry.resource.id !== 'string' || typeof entry.resource.name !== 'string' || !optionalStrings(entry.resource, ['parentId', 'parentType'])) return false
  if (!record(entry.context) || typeof entry.context.ipAddress !== 'string' || typeof entry.context.userAgent !== 'string' || !optionalStrings(entry.context, ['sessionId', 'correlationId', 'requestId'])) return false
  if (entry.duration !== undefined && (typeof entry.duration !== 'number' || !Number.isFinite(entry.duration) || entry.duration < 0)) return false
  if (entry.tags !== undefined && !strings(entry.tags)) return false
  if (entry.details !== undefined) {
    if (!record(entry.details)) return false
    const { changes, error, metadata } = entry.details
    if (changes !== undefined && (!Array.isArray(changes) || changes.some(change => !record(change) || typeof change.field !== 'string' || !('oldValue' in change) || !('newValue' in change)))) return false
    if (error !== undefined && (!record(error) || typeof error.code !== 'string' || typeof error.message !== 'string' || !optionalStrings(error, ['stack']))) return false
    if (metadata !== undefined && !record(metadata)) return false
  }
  return true
}
export function pendingEvents(account: string): AuditLogEntry[] { const value = read()[account]; if (value === undefined) return []; if (!Array.isArray(value) || value.some(entry => !validEntry(entry))) throw new Error('Audit retry queue cannot be read'); return value }
export function queuedAccounts(): string[] { return Object.keys(read()) }
export function queueEvent(account: string, entry: AuditLogEntry): void {
  const pending = read()
  const entries = pending[account] ?? []
  const queued = entries.find(item => item.id === entry.id)
  if (queued) {
    if (JSON.stringify(projectEntry(queued)) !== JSON.stringify(projectEntry(entry))) throw new Error('An audit event with this ID already exists in the outbox')
    return
  }
  if (entries.length >= 10000) throw new Error('Audit retry queue is full. Restore storage access before recording more events.')
  write({ ...pending, [account]: [...entries, entry] })
}
export function acknowledgeEvents(account: string, ids: ReadonlySet<string>): void {
  if (!ids.size) return
  const pending = read()
  write({ ...pending, [account]: (pending[account] ?? []).filter((entry) => !ids.has(entry.id)) })
}
export function acknowledgeEvent(account: string, id: string): void { acknowledgeEvents(account, new Set([id])) }
