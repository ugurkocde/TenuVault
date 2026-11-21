import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { AuditStorageService } from '../src/portal/lib/audit/storage'
import { AuditEventType, AuditSeverity, AuditResult, type AuditLogEntry } from '../src/portal/lib/audit/types'
import { LocalBlobStore } from '../src/main/storage/local-blob-store'
import { handleLocalBlobRequest } from '../src/main/storage/blob-emulator'
const roots: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const entry = (id: string): AuditLogEntry => ({ id, timestamp: '2026-09-26T12:00:00Z', eventType: AuditEventType.BACKUP_COMPLETED, severity: AuditSeverity.INFO,
  user: { id: 'admin', name: 'Admin', email: 'admin@example.com' }, action: `Backup ${id}`, resource: { type: 'backup', id, name: 'Backup' }, result: AuditResult.SUCCESS, context: { ipAddress: '', userAgent: 'test' } })
it('preserves concurrent writers across separate local store instances and makes retries idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-audit-')); roots.push(root)
  const keys = [randomBytes(32)]
  const account = 'tvlocal-test'
  await new LocalBlobStore(root, keys).createContainer(account, 'audit-logs')
  // Every request gets a separate store instance, as separate installations do.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => handleLocalBlobRequest(new LocalBlobStore(root, keys), new Request(input, init)))
  const service = () => new AuditStorageService({ storageAccountName: account, accessToken: '' })
  await Promise.all(Array.from({ length: 20 }, (_, i) => service().writeLog(entry(String(i)))))
  await Promise.all([service().writeLog(entry('same')), service().writeLog(entry('same'))])
  const logs = await service().queryAllLogs({ startDate: new Date('2026-09-26T00:00:00Z'), endDate: new Date('2026-09-26T23:59:59Z') })
  expect(logs).toHaveLength(21)
  expect(new Set(logs.map((log) => log.id)).size).toBe(21)
  await expect(service().writeLog({ ...entry('same'), action: 'Download backup' })).rejects.toThrow('already exists')
})
it('uses a conditional immutable PUT and never reads or overwrites the shared daily file', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 201 })); vi.stubGlobal('fetch', fetch)
  await new AuditStorageService({ storageAccountName: 'store', accessToken: 'test' }).writeLog(entry('one'))
  expect(fetch).toHaveBeenCalledTimes(2)
  const [url, options] = fetch.mock.calls[1] as unknown as [string, RequestInit]
  expect(url).toContain('-event-one.json')
  expect(new Headers(options.headers).get('if-none-match')).toBe('*')
})
