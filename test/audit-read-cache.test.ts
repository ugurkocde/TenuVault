import { afterEach, expect, it, vi } from 'vitest'
import { AuditStorageService } from '../src/portal/lib/audit/storage'
import { AuditEventType, AuditResult, AuditSeverity, type AuditLogEntry } from '../src/portal/lib/audit/types'
import { MetadataCache, MAX_METADATA_CACHE_BYTES } from '../src/portal/lib/storage/metadata-cache'

const account = 'audit-cache-store'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture(payloadBytes: number) {
  const files = new Map<number, { version: number; entries: AuditLogEntry[] }>()
  const reads: number[] = []
  const cacheRead = vi.spyOn(MetadataCache.prototype, 'read')
  const name = (day: number) => `2026/10/${String(day).padStart(2, '0')}/audit-log-202610${String(day).padStart(2, '0')}.json`
  const save = (day: number, version = 1) => {
    files.set(day, { version, entries: [{
      id: `day-${day}`, timestamp: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`,
      eventType: AuditEventType.BACKUP_COMPLETED, severity: AuditSeverity.INFO,
      user: { id: 'user', email: 'admin@example.com', name: 'Admin', tenantId: 'tenant' },
      action: `Revision ${version}`, resource: { type: 'backup', id: 'backup', name: 'Backup' },
      result: AuditResult.SUCCESS, context: { ipAddress: '', userAgent: 'test' },
      details: { payload: 'x'.repeat(payloadBytes) },
    }] })
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.searchParams.get('comp') === 'list') {
      return new Response([...files].filter(([day]) => name(day).startsWith(url.searchParams.get('prefix')!))
        .map(([day, file]) => `<Blob><Name>${name(day)}</Name><Properties><Etag>v${file.version}</Etag></Properties></Blob>`).join(''))
    }
    const day = [...files.keys()].find(day => url.pathname === `/audit-logs/${name(day)}`)!
    reads.push(day)
    return Response.json({ entries: files.get(day)!.entries })
  }))
  const query = (day: number) => new AuditStorageService({ storageAccountName: account, accessToken: 'test' })
    .queryAllLogs({ startDate: new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`), endDate: new Date(`2026-10-${String(day).padStart(2, '0')}T23:59:59.999Z`) })
  return { files, reads, save, query, name, cache: () => cacheRead.mock.contexts[0] as MetadataCache<AuditLogEntry[]> }
}

it('replaces forty ETag revisions of one daily file instead of retaining every version', async () => {
  const world = fixture(1024 * 1024)
  for (let version = 1; version <= 40; version++) {
    world.save(1, version)
    expect((await world.query(1))[0]!.action).toBe(`Revision ${version}`)
    expect(world.cache().bytes).toBeLessThan(2 * 1024 * 1024)
  }
  expect(world.reads).toHaveLength(40)
  await world.query(1)
  expect(world.reads).toHaveLength(40)
  const file = world.files.get(1)!
  expect(world.cache().bytes).toBe(Buffer.byteLength(JSON.stringify([account, world.name(1)])) + Buffer.byteLength('v40') + Buffer.byteLength(JSON.stringify(file.entries)))
  world.save(1, 1)
  expect((await world.query(1))[0]!.action).toBe('Revision 1')
  expect(world.reads).toHaveLength(41)
})

it('bounds audit reads to 32 MiB and evicts the least recently used file', async () => {
  const world = fixture(10 * 1024 * 1024)
  for (const day of [1, 4, 7, 10]) world.save(day)
  for (const day of [1, 4, 7]) await world.query(day)
  expect(world.cache().bytes).toBeGreaterThan(30 * 1024 * 1024)
  await world.query(1)
  await world.query(10)
  expect(world.cache().bytes).toBeLessThanOrEqual(MAX_METADATA_CACHE_BYTES)
  await world.query(1)
  expect(world.reads).toEqual([1, 4, 7, 10])
  await world.query(4)
  expect(world.reads).toEqual([1, 4, 7, 10, 4])
  expect(world.cache().bytes).toBeLessThanOrEqual(MAX_METADATA_CACHE_BYTES)
})
