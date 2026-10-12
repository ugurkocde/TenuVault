import { afterEach, expect, it, vi } from 'vitest'
import { AuditStorageService } from '../src/portal/lib/audit/storage'
import { setAuditOutboxStore, pendingEvents } from '../src/portal/lib/audit/outbox'
import { AuditEventType, AuditSeverity, AuditResult, type AuditLogEntry, DESKTOP_AUDIT_EVENT_TYPES } from '../src/portal/lib/audit/types'
import { memoryStore } from './helpers'
import { POST as logEvent } from '../src/portal/app/api/audit/log/route'
import { NextRequest } from '../src/main/api/next-server-shim'
const entry: AuditLogEntry = { id: 'one', timestamp: '2026-09-26T12:00:00Z', eventType: AuditEventType.BACKUP_COMPLETED, severity: AuditSeverity.INFO, user: { id: 'admin', name: 'Admin', email: 'admin@example.com' }, action: 'Backup', resource: { type: 'backup', id: 'one', name: 'Backup' }, result: AuditResult.SUCCESS, context: { ipAddress: '', userAgent: 'test' } }
const service = () => new AuditStorageService({ storageAccountName: 'store', accessToken: 'token-must-not-persist' })
afterEach(() => { vi.unstubAllGlobals(); setAuditOutboxStore() })
it('persists failed events across service restarts and retries without storing access tokens', async () => {
  const store = memoryStore(); setAuditOutboxStore(store)
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => new Response(null, { status: init?.method === 'HEAD' ? 200 : 503 })))
  await expect(service().writeLog(entry)).rejects.toThrow('queued')
  expect(service().pendingCount()).toBe(1)
  expect(store.get('audit.pending-events')).not.toContain('token-must-not-persist')
  setAuditOutboxStore(store)
  expect(service().pendingCount()).toBe(1)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })))
  expect(await service().retryPending()).toBe(0)
})
it.each([403, 503])('does not present inaccessible history (%s) as empty', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async (input) => new URL(String(input)).searchParams.get('comp') === 'list'
    ? new Response('<Blob><Name>2026/09/26/audit-log-20260926-event-one.json</Name></Blob>') : new Response(null, { status })))
  await expect(service().queryAllLogs({ startDate: new Date('2026-09-26'), endDate: new Date('2026-09-26') })).rejects.toThrow('unavailable')
})
it('does not replace history when container access fails', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 503 })); vi.stubGlobal('fetch', fetch)
  await expect(service().writeLog(entry)).rejects.toThrow('unavailable')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(service().pendingCount()).toBe(1)
})
it('queues a route event before authentication failure and returns an error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
  const response = await logEvent(new NextRequest('http://tenuvault.internal/api/audit/log', { method: 'POST', body: JSON.stringify({ tenantId: '11111111-1111-1111-1111-111111111111', appId: 'app', clientSecret: 'test', storageAccountName: 'store', user: entry.user, logEntry: entry }) }))
  expect(response.status).toBe(500)
  expect(pendingEvents('store')).toHaveLength(1)
})
it('returns pending counts even when authentication prevents reading history', async () => {
  const { POST } = await import('../src/portal/app/api/audit/logs/route')
  const { queueEvent } = await import('../src/portal/lib/audit/outbox')
  queueEvent('store', entry)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
  const response = await POST(new NextRequest('http://tenuvault.internal/api/audit/logs', { method: 'POST', body: JSON.stringify({ tenantId: '11111111-1111-1111-1111-111111111111', appId: 'app', clientSecret: 'test', storageAccountName: 'store' }) }))
  expect(response.status).toBe(500)
  expect(await response.json()).toMatchObject({ pendingCount: 1, pendingDurable: false })
})
it('batches retry acknowledgements and limits work per refresh', async () => {
  const { queueEvent } = await import('../src/portal/lib/audit/outbox')
  const store = memoryStore()
  const set = vi.spyOn(store, 'set')
  setAuditOutboxStore(store)
  for (let i = 0; i < 101; i++) queueEvent('store', { ...entry, id: `event-${i}` })
  set.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })))
  expect(await service().retryPending()).toBe(1)
  expect(set).toHaveBeenCalledTimes(1)
})
it('rejects renderer-fabricated audit events before the route can queue them', async () => {
  const { ApiHost } = await import('../src/main/api/host')
  const route = vi.fn(() => Response.json({ success: true }))
  const host = new ApiHost({ routes: { '/api/audit/log': { POST: route } } })
  for (const path of ['/api/audit/log', '/api/other/../audit/log/']) {
    expect((await host.handleIpc({ path, method: 'POST', headers: {}, body: new TextEncoder().encode('{}') })).status).toBe(403)
  }
  expect(route).not.toHaveBeenCalled()
})
it.each(['{', '{"store":{}}', 'null', '{"store":[{"id":"partial"}]}', JSON.stringify({ store: [{ ...entry, timestamp: 'not-a-date' }] }), JSON.stringify({ store: [{ ...entry, user: null }] })])('reports an unreadable outbox with unknown pending count: %s', async raw => {
  const { POST } = await import('../src/portal/app/api/audit/logs/route')
  const store = memoryStore(); store.set('audit.pending-events', raw); setAuditOutboxStore(store)
  expect(() => pendingEvents('store')).toThrow()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
  const response = await POST(new NextRequest('http://tenuvault.internal/api/audit/logs', { method: 'POST', body: JSON.stringify({ tenantId: '11111111-1111-1111-1111-111111111111', appId: 'app', clientSecret: 'test', storageAccountName: 'store' }) }))
  expect(response.status).toBe(500)
  expect(await response.json()).toMatchObject({ pendingCount: null, pendingDurable: true })
})

it.each(Object.values(AuditEventType).filter(type => !DESKTOP_AUDIT_EVENT_TYPES.includes(type)))('keeps queued legacy %s events readable even when hidden from filters', eventType => {
  const legacy = { ...entry, eventType, severity: AuditSeverity.CRITICAL }
  const store = memoryStore()
  store.set('audit.pending-events', JSON.stringify({ store: [legacy] }))
  setAuditOutboxStore(store)
  expect(pendingEvents('store')).toEqual([legacy])
})
