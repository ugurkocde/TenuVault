import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { AuditStorageService } from '../src/portal/lib/audit/storage'
import { auditDateFilter, defaultAuditDateRange } from '../src/portal/lib/audit/date-range'
import { queueEvent, setAuditOutboxStore } from '../src/portal/lib/audit/outbox'
import { AuditEventType, AuditSeverity, AuditResult, type AuditLogEntry } from '../src/portal/lib/audit/types'
import { POST as queryLogs } from '../src/portal/app/api/audit/logs/route'
import { POST as exportLogs } from '../src/portal/app/api/audit/export/route'
import { POST as getStats } from '../src/portal/app/api/audit/stats/route'
import { NextRequest } from '../src/main/api/next-server-shim'
import { LocalBlobStore } from '../src/main/storage/local-blob-store'
import { handleLocalBlobRequest } from '../src/main/storage/blob-emulator'

const TENANT = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = 'tvlocal-audit-window'
const entry = (id: string, timestamp = new Date().toISOString()): AuditLogEntry => ({
  id, timestamp, eventType: AuditEventType.BACKUP_COMPLETED, severity: AuditSeverity.INFO,
  user: { id: 'admin', name: 'Admin', email: 'admin@example.com', tenantId: TENANT },
  action: `Backup ${id}`, resource: { type: 'backup', id, name: 'Backup' }, result: AuditResult.SUCCESS,
  context: { ipAddress: '', userAgent: 'test' },
})

function utcPath(date: Date): string {
  const day = date.toISOString().slice(0, 10)
  return `${day.replaceAll('-', '/')}/audit-log-${day.replaceAll('-', '')}`
}

export function auditDateWindowTests(zone: string, originalTZ: string | undefined) {
  const roots: string[] = []
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    setAuditOutboxStore()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  afterAll(() => {
    if (originalTZ === undefined) delete process.env.TZ
    else process.env.TZ = originalTZ
  })

  async function setup() {
    const root = mkdtempSync(join(tmpdir(), 'tv-audit-window-'))
    roots.push(root)
    const store = new LocalBlobStore(root, [randomBytes(32)])
    await store.createContainer(ACCOUNT, 'audit-logs')
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (new URL(request.url).hostname === 'login.microsoftonline.com') return Promise.resolve(Response.json({ access_token: 'test' }))
      return handleLocalBlobRequest(store, request)
    })
    const service = new AuditStorageService({ storageAccountName: ACCOUNT, accessToken: '' })
    const request = (path: string, options: object) => new NextRequest(`http://tenuvault.internal/api/audit/${path}`, {
      method: 'POST', body: JSON.stringify({ tenantId: TENANT, appId: 'app', clientSecret: 'test', storageAccountName: ACCOUNT, ...options }),
    })
    return { store, service, request }
  }

  describe(`audit date windows in ${zone}`, () => {
    it.each([
      '2026-01-15T00:30:00', '2026-01-15T23:30:00',
      '2026-07-15T00:30:00', '2026-07-15T23:30:00',
    ])('returns an event written now at %s through logs, stats and export', async (clock) => {
      expect(process.env.TZ).toBe(zone)
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(clock))
      const { store, service, request } = await setup()
      const now = entry('now')
      await service.writeLog(now)
      expect((await store.list(ACCOUNT, 'audit-logs')).map(blob => blob.name)).toEqual([`${utcPath(new Date())}-event-now.json`])

      const range = defaultAuditDateRange()
      expect(range.endDate).toBe(clock.slice(0, 10))
      expect(range.startDate).toBe(`${clock.slice(0, 7)}-09`)
      const filter = auditDateFilter(range)
      expect(new Date(filter.startDate!).getHours()).toBe(0)
      expect(new Date(filter.endDate!).getHours()).toBe(23)
      expect(new Date(filter.endDate!).getMilliseconds()).toBe(999)

      const logs = await queryLogs(request('logs', { filter }))
      expect(logs.status).toBe(200)
      const data = await logs.json()
      expect(data.data.map((log: AuditLogEntry) => log.id)).toEqual(['now'])
      expect(data.filter).toMatchObject(filter)
      const stats = await getStats(request('stats', { filter }))
      expect(stats.status).toBe(200)
      expect((await stats.json()).data.totalEvents).toBe(1)
      const exported = await exportLogs(request('export', { exportOptions: { format: 'json', filter } }))
      expect(exported.status).toBe(200)
      expect((await exported.json()).logs.map((log: AuditLogEntry) => log.id)).toEqual(['now'])
    })

    it.each(['2026-01-15T12:00:00', zone === 'America/New_York' ? '2026-03-10T12:00:00' : '2026-10-06T12:00:00'])('defaults to seven local calendar days including today at %s', async (clock) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(clock))
      const { service, request } = await setup()
      const sixDaysAgo = new Date()
      sixDaysAgo.setDate(sixDaysAgo.getDate() - 6)
      sixDaysAgo.setHours(0, 0, 0, 0)
      const sevenDaysAgo = new Date(sixDaysAgo)
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 1)
      sevenDaysAgo.setHours(23, 59, 59, 999)
      await service.writeLog(entry('seven-days-ago', sevenDaysAgo.toISOString()))
      await service.writeLog(entry('six-days-ago', sixDaysAgo.toISOString()))
      await service.writeLog(entry('now'))

      const filter = auditDateFilter(defaultAuditDateRange())
      expect(filter.startDate).toBe(sixDaysAgo.toISOString())
      const expectedIds = ['now', 'six-days-ago']
      expect((await service.queryAllLogs({})).map(log => log.id)).toEqual(expectedIds)
      for (const dates of [filter, {}]) {
        const logs = await queryLogs(request('logs', { filter: dates }))
        expect(logs.status).toBe(200)
        expect((await logs.json()).data.map((log: AuditLogEntry) => log.id)).toEqual(expectedIds)
        const exported = await exportLogs(request('export', { exportOptions: { format: 'json', filter: dates } }))
        expect(exported.status).toBe(200)
        expect((await exported.json()).logs.map((log: AuditLogEntry) => log.id)).toEqual(expectedIds)
      }
      const stats = await getStats(request('stats', { filter }))
      expect(stats.status).toBe(200)
      expect((await stats.json()).data.totalEvents).toBe(2)
    })

    it('counts an upgrade retry in local and UTC day files once before pagination, stats and export', async () => {
      const { store, service, request } = await setup()
      const timestamp = new Date(zone === 'America/New_York' ? '2026-01-15T23:30:00' : '2026-01-15T00:30:00').toISOString()
      const retry = entry('retry', timestamp)
      const legacyPath = '2026/01/15/audit-log-20260115-event-retry.json'
      const currentPath = `${utcPath(new Date(timestamp))}-event-retry.json`
      expect(currentPath).not.toBe(legacyPath)
      await store.put(ACCOUNT, 'audit-logs', legacyPath,
        new TextEncoder().encode(JSON.stringify({ entries: [retry] })), 'application/json')
      queueEvent(ACCOUNT, retry)
      expect(await service.retryPending()).toBe(0)
      expect((await store.list(ACCOUNT, 'audit-logs')).map(blob => blob.name).sort()).toEqual([legacyPath, currentPath].sort())

      const filter = auditDateFilter({ startDate: '2026-01-15', endDate: '2026-01-15' })
      expect(await service.queryAllLogs({ startDate: new Date(filter.startDate!), endDate: new Date(filter.endDate!) })).toEqual([retry])
      for (const offset of [0, 1]) {
        const logs = await queryLogs(request('logs', { filter: { ...filter, limit: 1, offset } }))
        expect(logs.status).toBe(200)
        const data = await logs.json()
        expect(data.count).toBe(offset === 0 ? 1 : 0)
        expect(data.data.map((log: AuditLogEntry) => log.id)).toEqual(offset === 0 ? ['retry'] : [])
      }
      const stats = await getStats(request('stats', { filter }))
      expect(stats.status).toBe(200)
      expect((await stats.json()).data).toMatchObject({
        totalEvents: 1, eventsByType: { BACKUP_COMPLETED: 1 }, eventsByResult: { SUCCESS: 1 }, topUsers: [{ count: 1 }],
      })
      const json = await exportLogs(request('export', { exportOptions: { format: 'json', filter } }))
      expect(json.status).toBe(200)
      expect((await json.json()).logs.map((log: AuditLogEntry) => log.id)).toEqual(['retry'])
      const csv = await exportLogs(request('export', { exportOptions: { format: 'csv', filter } }))
      expect(csv.status).toBe(200)
      const lines = (await csv.text()).split('\r\n')
      expect(lines).toHaveLength(7)
      expect(lines[6]).toContain(timestamp)
    })

    it.each([-1, 1])('finds an older local-date file %s day from its timestamp', async (offset) => {
      const { store, service } = await setup()
      const timestamp = '2026-01-15T12:00:00.000Z'
      const legacyDate = new Date(timestamp)
      legacyDate.setUTCDate(legacyDate.getUTCDate() + offset)
      await store.put(ACCOUNT, 'audit-logs', `${utcPath(legacyDate)}.json`,
        new TextEncoder().encode(JSON.stringify({ entries: [entry('legacy', timestamp)] })), 'application/json')
      expect((await service.queryAllLogs({ startDate: new Date(timestamp), endDate: new Date(timestamp) })).map(log => log.id)).toEqual(['legacy'])
    })

    it.each(['2026-01-15', ...(zone === 'America/New_York' ? ['2026-03-08', '2026-11-01'] : ['2026-04-05', '2026-10-04'])])('filters full local days on %s before pagination and aggregation', async (day) => {
      const { service, request } = await setup()
      const filter = auditDateFilter({ startDate: day, endDate: day })
      const start = Date.parse(filter.startDate!)
      const end = Date.parse(filter.endDate!)
      for (const [id, time] of [['before', start - 1], ['start', start], ['end', end], ['after', end + 1]] as const) {
        await service.writeLog(entry(id, new Date(time).toISOString()))
      }
      const logs = await queryLogs(request('logs', { filter: { ...filter, limit: 1, offset: 1 } }))
      expect(logs.status).toBe(200)
      expect((await logs.json()).data.map((log: AuditLogEntry) => log.id)).toEqual(['start'])
      const stats = await getStats(request('stats', { filter }))
      expect(stats.status).toBe(200)
      expect((await stats.json()).data.totalEvents).toBe(2)
      const exported = await exportLogs(request('export', { exportOptions: { format: 'json', filter } }))
      expect(exported.status).toBe(200)
      expect((await exported.json()).logs.map((log: AuditLogEntry) => log.id)).toEqual(['end', 'start'])
    })
  })
}
