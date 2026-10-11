import { afterEach, expect, it, vi } from 'vitest'
import { AuditStorageService } from '../src/portal/lib/audit/storage'
import { AuditEventType, AuditResult, AuditSeverity, type AuditLogEntry } from '../src/portal/lib/audit/types'
import { POST as exportLogs } from '../src/portal/app/api/audit/export/route'
import { NextRequest } from '../src/main/api/next-server-shim'

afterEach(() => vi.unstubAllGlobals())
const service = () => new AuditStorageService({ storageAccountName: 'store', accessToken: 'test' })
const filter = { startDate: new Date('2026-09-24T00:00:00'), endDate: new Date('2026-09-25T23:59:59') }
function fixture() {
  const entries: AuditLogEntry[] = Array.from({ length: 240 }, (_, i) => ({
    id: String(i), timestamp: `2026-09-${i < 120 ? '24' : '25'}T12:00:00Z`,
    eventType: AuditEventType.BACKUP_COMPLETED, severity: AuditSeverity.INFO,
    user: { id: 'user', email: 'admin@example.com', name: 'Admin' }, action: `Backup ${i}`,
    resource: { type: 'backup', id: 'backup', name: 'Backup' }, result: AuditResult.SUCCESS,
    context: { ipAddress: '', userAgent: 'test' },
  }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.searchParams.get('comp') === 'list') {
      if (!/202609(24|25)/.test(url.searchParams.get('prefix')!)) return new Response('<Blobs />')
      const day = url.searchParams.get('prefix')!.includes('20260924') ? 0 : 1
      const page = url.searchParams.get('marker') ? 1 : 0
      return new Response(`<Blobs><Blob><Name>${day}-${page}.json</Name></Blob></Blobs><NextMarker>${page ? '' : 'next&amp;page'}</NextMarker>`)
    }
    const [day, page] = url.pathname.split('/').at(-1)!.split('-').map(Number.parseFloat)
    const start = day! * 120 + page! * 60
    return Response.json({ entries: entries.slice(start, start + 60) })
  }))
  return entries
}
it('reads all listing pages and days for statistics while preserving UI pagination', async () => {
  fixture()
  expect(await service().queryAllLogs({ ...filter, limit: 1, offset: 100 })).toHaveLength(240)
  expect(await service().queryLogs(filter)).toHaveLength(100)
  expect(await service().queryLogs({ ...filter, offset: 200, limit: 50 })).toHaveLength(40)
  const stats = await service().getStats({ ...filter, limit: 1, offset: 100 })
  expect(stats.totalEvents).toBe(240)
  expect(stats.eventsByResult.SUCCESS).toBe(240)
  expect(stats.topUsers[0]?.count).toBe(240)
})
it.each(['json', 'csv'])('exports every matching record as %s', async (format) => {
  fixture()
  const response = await exportLogs(new NextRequest('http://tenuvault.internal/api/audit/export', {
    method: 'POST', body: JSON.stringify({ tenantId: '11111111-1111-1111-1111-111111111111', appId: 'app', clientSecret: 'test', storageAccountName: 'store', exportOptions: { format, filter } }),
  }))
  expect(response.status).toBe(200)
  if (format === 'json') expect((await response.json()).logs).toHaveLength(240)
  else expect((await response.text()).split('\n')).toHaveLength(246)
})
it.each([404, 503])('does not export a truncated result when a continuation page returns %s', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).searchParams.get('marker')
    ? new Response('', { status }) : new Response('<NextMarker>next</NextMarker>')))
  await expect(service().queryAllLogs(filter)).rejects.toThrow(String(status))
})
