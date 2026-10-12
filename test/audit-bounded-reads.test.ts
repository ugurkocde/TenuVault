import { afterEach, expect, it, vi } from 'vitest'
import { AuditStorageService, AUDIT_READ_CONCURRENCY } from '../src/portal/lib/audit/storage'
import { AuditEventType, AuditResult, AuditSeverity, type AuditLogEntry } from '../src/portal/lib/audit/types'
import { POST as logsRoute } from '../src/portal/app/api/audit/logs/route'
import { POST as statsRoute } from '../src/portal/app/api/audit/stats/route'
import { POST as exportRoute } from '../src/portal/app/api/audit/export/route'
import { NextRequest } from '../src/main/api/next-server-shim'
const tenantId = '11111111-1111-1111-1111-111111111111'
const dates = { startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-01T23:59:59.999Z') }
const service = () => new AuditStorageService({ storageAccountName: 'bounded-store', accessToken: 'test' })
const entry = (number: number, timestamp = new Date(Date.parse('2026-10-01T12:00:00Z') + number * 1000).toISOString()): AuditLogEntry => ({
  id: `id-${String(number).padStart(3, '0')}`, timestamp, eventType: AuditEventType.BACKUP_COMPLETED, severity: AuditSeverity.INFO,
  user: { id: 'user', email: 'admin@example.com', name: 'Admin', tenantId }, action: 'Backup',
  resource: { type: 'backup', id: 'backup', name: 'Backup' }, result: AuditResult.SUCCESS, context: { ipAddress: '', userAgent: 'test' },
})
afterEach(() => vi.unstubAllGlobals())

function fixture(indexed = true, tied = false) {
  let active = 0, maximum = 0, reads = 0, listings = 0
  const events = Array.from({ length: 100 }, (_, number) => entry(number, tied ? '2026-10-01T12:00:00Z' : undefined))
  const names = events.map(event => `2026/10/01/audit-log-20261001-event-${event.id}.json`)
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    active++; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 0))
    active--
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.searchParams.get('comp') === 'list') {
      listings++
      if (!url.searchParams.get('prefix')!.includes('20261001')) return new Response('<Blobs />')
      return new Response(events.map((event, index) => `<Blob><Name>${names[index]}</Name><Properties><Etag>v1</Etag></Properties>${indexed ? `<Metadata><audit_timestamp>${event.timestamp}</audit_timestamp><audit_entries>1</audit_entries></Metadata>` : ''}</Blob>`).join(''))
    }
    reads++
    return Response.json({ entries: [events[names.indexOf(url.pathname.slice('/audit-logs/'.length))]] })
  })
  vi.stubGlobal('fetch', fetcher)
  return { events, stats: () => ({ maximum, reads, listings }) }
}

it.each([false, true])('reads only the requested newest events from timestamp metadata (tied=%s)', async tied => {
  const world = fixture(true, tied)
  const result = await service().queryLogs({ ...dates, tenantId, limit: 20 })
  const expected = [...world.events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.id.localeCompare(b.id)).slice(0, 20)
  expect(result).toEqual(expected)
  expect(world.stats().reads).toBe(20)
  expect(world.stats().maximum).toBeLessThanOrEqual(AUDIT_READ_CONCURRENCY)
  expect(await service().queryLogs({ ...dates, tenantId, limit: 20 })).toEqual(expected)
  expect(world.stats().reads).toBe(20)
})

it('preserves timestamp ordering, filters, offsets and complete exports', async () => {
  const world = fixture()
  const page = await service().queryLogs({ ...dates, tenantId, limit: 5, offset: 10 })
  expect(page.map(event => event.id)).toEqual(world.events.slice(85, 90).reverse().map(event => event.id))
  expect(world.stats().reads).toBe(15)
  expect(await service().queryLogs({ ...dates, limit: 1, userEmails: ['nobody@example.com'] })).toEqual([])
  expect(await service().queryAllLogs({ ...dates, limit: 1 })).toHaveLength(100)
  expect(world.stats().maximum).toBeLessThanOrEqual(AUDIT_READ_CONCURRENCY)
})

it('bounds legacy reads and reuses unchanged daily files without truncating exports', async () => {
  const world = fixture(false)
  expect(await service().queryLogs({ ...dates, limit: 20 })).toHaveLength(20)
  expect(world.stats().reads).toBe(100)
  expect(world.stats().maximum).toBeLessThanOrEqual(AUDIT_READ_CONCURRENCY)
  expect(await service().queryLogs({ ...dates, limit: 20 })).toHaveLength(20)
  expect(world.stats().reads).toBe(100)
  expect(await service().queryAllLogs(dates)).toHaveLength(100)
})

it.each([
  { startDate: new Date('1970-01-01'), endDate: new Date('2026-10-01') },
  { startDate: new Date('invalid'), endDate: dates.endDate },
  { startDate: dates.endDate, endDate: dates.startDate },
])('rejects invalid or excessive date ranges before listing or reading', async filter => {
  const world = fixture()
  await expect(service().queryAllLogs(filter)).rejects.toThrow('at most 90 days')
  expect(world.stats()).toEqual({ maximum: 0, reads: 0, listings: 0 })
})

it('returns an actionable 400 from logs, stats and export for a range longer than 90 days', async () => {
  fixture()
  const filter = { startDate: '1970-01-01', endDate: '2026-10-01' }
  for (const [route, extra] of [[logsRoute, { filter }], [statsRoute, { filter }], [exportRoute, { exportOptions: { format: 'json', filter } }]] as const) {
    const response = await route(new NextRequest('http://tenuvault.internal/api/audit/test', { method: 'POST', body: JSON.stringify({ tenantId, appId: 'app', clientSecret: 'test', storageAccountName: 'bounded-store', ...extra }) }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('at most 90 days')
  }
})

it('preserves valid event IDs that themselves contain the event path delimiter', async () => {
  const event = { ...entry(0), id: 'old-event-key' }
  const name = `2026/10/01/audit-log-20261001-event-${event.id}.json`
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.searchParams.get('comp') === 'list') return new Response(url.searchParams.get('prefix')!.includes('20261001')
      ? `<Blob><Name>${name}</Name><Metadata><audit_timestamp>${event.timestamp}</audit_timestamp><audit_entries>1</audit_entries></Metadata></Blob>` : '<Blobs />')
    return Response.json({ entries: [event] })
  }))
  expect(await service().queryLogs({ ...dates, limit: 1 })).toEqual([event])
})
