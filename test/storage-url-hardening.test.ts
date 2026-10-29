import { mkdtempSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blobPath, isGraphId, isGuid, isSafeArchivePath } from '../src/shared/security'
import { assertStorageAccountName } from '../src/shared/storage-account'
import { resolveStep } from '../src/shared/intune/restore-plan'
import { readObject } from '../src/shared/intune/read'
import { typeForFolder, type Item, type Step } from '../src/shared/intune/registry'
import { readLive, type GraphCall } from '../src/portal/lib/policies/graph-restore'
import { AuditStorageService } from '../src/portal/lib/audit/storage'
import { BackupEngine } from '../src/main/backup/engine'
import { handleLocalBlobRequest, localAccountFromUrl } from '../src/main/storage/blob-emulator'
import { LocalBlobStore } from '../src/main/storage/local-blob-store'
import { localStorageAccountName } from '../src/shared/constants'
import { NextRequest } from '../src/main/api/next-server-shim'
import { POST as loadMetadata } from '../src/portal/app/api/tenant-metadata/load/route'
import { POST as saveMetadata } from '../src/portal/app/api/tenant-metadata/save/route'
import { POST as checkMetadata } from '../src/portal/app/api/tenant-metadata/check/route'
import { POST as deleteMetadata } from '../src/portal/app/api/tenant-metadata/delete/route'
import { POST as auditLog } from '../src/portal/app/api/audit/log/route'
import { POST as auditLogs } from '../src/portal/app/api/audit/logs/route'
import { POST as auditStats } from '../src/portal/app/api/audit/stats/route'
import { POST as auditExport } from '../src/portal/app/api/audit/export/route'
import { POST as auditCleanup } from '../src/portal/app/api/audit/cleanup/route'
import { POST as listBackupContents } from '../src/portal/app/api/list-backup-contents/route'
import { POST as downloadBackup } from '../src/portal/app/api/download-backup/route'
import { POST as revertPolicy } from '../src/portal/app/api/revert-policy/route'

const TENANT = '11111111-1111-1111-1111-111111111111'
const CLIENT = '22222222-2222-2222-2222-222222222222'
const credentials = { appId: 'app', clientSecret: 'test', storageAccountName: 'store' }
const post = (url: string, body: unknown) => new NextRequest(`http://tenuvault.internal${url}`, { method: 'POST', body: JSON.stringify(body) })

afterEach(() => vi.unstubAllGlobals())

/** Records every request and answers token requests; storage answers come from `storage`. */
function stubFetch(storage: (url: URL, init?: RequestInit) => Response = () => new Response(null, { status: 404 })) {
  const calls: Array<{ url: string; method: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url: String(input), method: init?.method ?? 'GET' })
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token' })
    return storage(url, init)
  }))
  return calls
}

describe('shared path helpers', () => {
  it('recognises tenant GUIDs only', () => {
    expect(isGuid(TENANT)).toBe(true)
    expect(isGuid(TENANT.toUpperCase())).toBe(true)
    for (const value of ['contoso.onmicrosoft.com', `${TENANT}/..`, `../${TENANT}`, '', 42, undefined]) expect(isGuid(value)).toBe(false)
  })
  it.each([
    'a3c6f0e2-1b2c-4d5e-8f90-123456789abc',
    '7192bb9f-ffa6-4f50-9176-7603cd9450d6_DefaultLimit',
    '7192bb9f-ffa6-4f50-9176-7603cd9450d6_Windows10EnrollmentCompletionPageConfiguration',
    'T_a3c6f0e2-1b2c-4d5e-8f90-123456789abc',
    '0',
    '12',
    'dc1',
  ])('accepts the Graph ID shape %s', (id) => expect(isGraphId(id)).toBe(true))
  it.each(['', 'a/b', 'x?y=1', 'x#y', '../x', 'a..b', "a')", 'a b', '%2e%2e', '__proto__', 'a'.repeat(257)])('rejects the Graph ID %s', (id) => {
    expect(isGraphId(id)).toBe(false)
  })
  it('encodes blob names per path segment and rejects dot segments', () => {
    expect(blobPath('backup-1/DeviceConfigurations/Win: A%B?#.json')).toBe('backup-1/DeviceConfigurations/Win%3A%20A%25B%3F%23.json')
    expect(blobPath('a b/c')).toBe('a%20b/c')
    for (const name of ['../x', 'a/../b', 'a/./b', '.', '..']) expect(() => blobPath(name)).toThrow('Invalid blob name')
  })
  it('accepts only relative archive paths without dot segments', () => {
    for (const name of ['DeviceConfigurations/A.json', 'metadata.json', 'Folder/Policy..v2.json']) expect(isSafeArchivePath(name)).toBe(true)
    for (const name of ['../evil.json', 'a/../../evil.json', 'a\\..\\evil.json', '/etc/passwd', '\\\\server\\share', 'C:/Windows/evil.dll', 'c:evil', './a', '']) expect(isSafeArchivePath(name)).toBe(false)
  })
})

describe('storage account names in credential-bearing URLs', () => {
  it.each(['store', 'contoso123'])('accepts the Azure account name %s', (name) => expect(() => assertStorageAccountName(name)).not.toThrow())
  it.each(['evil.example#', 'evil.example', 'a_b', 'Store', 'ab', '', 'a'.repeat(25), 42, undefined])('rejects %s before it can become a URL host', (name) => {
    expect(() => assertStorageAccountName(name)).toThrow('Invalid storage account name.')
  })
  it('validates the account name in the Backup Reader storage check before the reader token is used', () => {
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    const check = main.slice(main.indexOf('const testReader'), main.indexOf('const requireReaderPlan'))
    expect(check.indexOf('assertStorageAccountName(profile.storageAccountName)')).toBeGreaterThan(-1)
    expect(check.indexOf('assertStorageAccountName(profile.storageAccountName)')).toBeLessThan(check.indexOf('await tokens.storage()'))
    expect(check.indexOf('assertStorageAccountName(profile.storageAccountName)')).toBeLessThan(check.indexOf('blob.core.windows.net'))
  })
})

describe('tenant GUID validation', () => {
  const routes: Array<[string, (request: NextRequest) => Promise<Response>, Record<string, unknown>]> = [
    ['tenant-metadata/load', loadMetadata, {}],
    ['tenant-metadata/save', saveMetadata, { metadata: { domain: 'contoso.com' } }],
    ['tenant-metadata/check', checkMetadata, {}],
    ['tenant-metadata/delete', deleteMetadata, {}],
    ['audit/log', auditLog, { user: { id: 'a', name: 'A', email: 'a@example.com' }, logEntry: { action: 'x' } }],
    ['audit/logs', auditLogs, {}],
    ['audit/stats', auditStats, {}],
    ['audit/export', auditExport, { exportOptions: { format: 'json' } }],
    ['audit/cleanup', auditCleanup, {}],
  ]
  it.each(routes.flatMap(([name, route, extra]) => ['evil.test/x?', '../other', 'contoso.onmicrosoft.com'].map((tenantId) => [name, route, extra, tenantId] as const)))(
    '%s returns 400 for tenant %s before any request', async (_name, route, extra, tenantId) => {
      const calls = stubFetch()
      const response = await route(post('/api/x', { tenantId, ...credentials, ...extra }))
      expect(response.status).toBe(400)
      expect(calls).toEqual([])
    })
  it('builds metadata blob and token URLs from a valid tenant GUID', async () => {
    const calls = stubFetch(() => new Response(null, { status: 404 }))
    const response = await loadMetadata(post('/api/tenant-metadata/load', { tenantId: TENANT, ...credentials }))
    expect(response.status).toBe(200)
    expect(calls.map((call) => call.url)).toEqual([
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      `https://store.blob.core.windows.net/tenant-metadata/${TENANT}/metadata.json`,
    ])
  })
})

describe('backup routes', () => {
  it.each(['../tenant-metadata', 'backup-1/../../x', '/backup-1', ''])('rejects backup ID %s', async (backupId) => {
    const calls = stubFetch()
    for (const route of [listBackupContents, downloadBackup]) {
      const response = await route(post('/api/x', { tenantId: TENANT, ...credentials, subscriptionId: 's', resourceGroupName: 'r', backupId }))
      expect(response.status).toBe(400)
    }
    expect(calls).toEqual([])
  })
  it('encodes the backup ID in listing prefixes and blob paths', async () => {
    const calls = stubFetch((url) => url.searchParams.get('comp') === 'list' ? new Response('<EnumerationResults><Blobs></Blobs></EnumerationResults>') : new Response(null, { status: 404 }))
    await listBackupContents(post('/api/list-backup-contents', { tenantId: TENANT, ...credentials, subscriptionId: 's', resourceGroupName: 'r', backupId: 'imported backup#1' }))
    const storage = calls.filter((call) => call.url.includes('blob.core.windows.net'))
    expect(new URL(storage[0]!.url).searchParams.get('prefix')).toBe('imported backup#1/')
    expect(storage[1]!.url).toBe('https://store.blob.core.windows.net/intune-backups/imported%20backup%231/metadata.json')
  })
  it('refuses to build an archive with entries that escape the extraction folder', async () => {
    const calls = stubFetch((url) => url.searchParams.get('comp') === 'list'
      ? new Response('<Blobs><Blob><Name>backup-1/DeviceConfigurations/A.json</Name></Blob><Blob><Name>backup-1/../../evil.json</Name></Blob></Blobs>')
      : Response.json({}))
    const response = await downloadBackup(post('/api/download-backup', { tenantId: TENANT, ...credentials, backupId: 'backup-1' }))
    expect(response.status).toBe(502)
    expect((await response.json()).error).toContain('not a safe archive path')
    expect(calls.some((call) => call.url.includes('evil'))).toBe(false)
  })
  it.each(['../x', 'a/b', "a')", '__proto__'])('revert-policy rejects policy ID %s', async (policyId) => {
    const calls = stubFetch()
    const response = await revertPolicy(post('/api/revert-policy', { tenantId: TENANT, ...credentials, action: 'revert', policyId, policyType: 'DeviceConfigurations', backupPath: 'backup-2026-09-01-020000/DeviceConfigurations/A.json' }))
    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })
})

describe('audit storage blob names', () => {
  const service = () => new AuditStorageService({ storageAccountName: 'store', accessToken: 'test' })
  it('encodes listed names and never deletes outside the audit container', async () => {
    const old = 'Mon, 01 Jan 2024 00:00:00 GMT'
    const blob = (name: string) => `<Blob><Name>${name}</Name><Properties><Last-Modified>${old}</Last-Modified></Properties></Blob>`
    const calls = stubFetch((url, init) => url.searchParams.get('comp') === 'list'
      ? new Response(`<Blobs>${blob('2024/01/01/a b&amp;c.json')}${blob('../intune-backups/backup-1/metadata.json')}${blob('2024/..')}${blob('2024/../2026/09/29/recent.json')}</Blobs>`)
      : init?.method === 'DELETE' ? new Response(null, { status: 202 }) : Response.json({ entries: [{ user: { tenantId: TENANT } }] }))
    await service().cleanupOldLogs(TENANT)
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual(['https://store.blob.core.windows.net/audit-logs/2024/01/01/a%20b%26c.json'])
  })
  it('deletes only files of this tenant, reads every listing page and reports failures', async () => {
    const old = 'Mon, 01 Jan 2024 00:00:00 GMT'
    const blob = (name: string) => `<Blob><Name>${name}</Name><Properties><Last-Modified>${old}</Last-Modified></Properties></Blob>`
    const OTHER = '22222222-2222-2222-2222-222222222222'
    const files: Record<string, unknown[]> = {
      '/audit-logs/2024/01/01/mine.json': [{ user: { tenantId: TENANT.toUpperCase() } }],
      '/audit-logs/2024/01/01/other.json': [{ user: { tenantId: OTHER } }],
      '/audit-logs/2024/01/01/mixed.json': [{ user: { tenantId: TENANT } }, { user: { tenantId: OTHER } }],
      '/audit-logs/2024/01/01/unowned.json': [{ user: {} }],
      '/audit-logs/2024/01/02/mine-page-two.json': [{ user: { tenantId: TENANT } }],
    }
    let failDelete = false
    const calls = stubFetch((url, init) => {
      if (url.searchParams.get('comp') === 'list') {
        return url.searchParams.get('marker')
          ? new Response(`<Blobs>${blob('2024/01/02/mine-page-two.json')}</Blobs><NextMarker />`)
          : new Response(`<Blobs>${Object.keys(files).slice(0, 4).map((path) => blob(path.slice('/audit-logs/'.length))).join('')}</Blobs><NextMarker>page-2</NextMarker>`)
      }
      if (init?.method === 'DELETE') return new Response(null, { status: failDelete ? 403 : 202 })
      return Response.json({ entries: files[url.pathname] })
    })
    expect(await service().cleanupOldLogs(TENANT, 90)).toEqual({ deleted: 2, kept: 3 })
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname)).toEqual(['/audit-logs/2024/01/01/mine.json', '/audit-logs/2024/01/02/mine-page-two.json'])
    failDelete = true
    await expect(service().cleanupOldLogs(TENANT, 90)).rejects.toThrow(/could not be deleted \(403\)/)
    const response = await auditCleanup(post('/api/audit/cleanup', { tenantId: TENANT, ...credentials, retentionDays: 90 }))
    expect(response.status).toBe(500)
    expect((await response.json()).error).toContain('could not be deleted')
    expect((await auditCleanup(post('/api/audit/cleanup', { tenantId: TENANT, ...credentials, retentionDays: 1 }))).status).toBe(400)
  })
  it('skips listed names with dot segments instead of reading another blob', async () => {
    const calls = stubFetch((url) => url.searchParams.get('comp') === 'list'
      ? new Response('<Blobs><Blob><Name>../intune-backups/backup-1/metadata.json</Name></Blob><Blob><Name>2026/../2026/09/24/other.json</Name></Blob></Blobs>')
      : Response.json({ entries: [] }))
    await service().queryAllLogs({ startDate: new Date('2026-09-24T00:00:00'), endDate: new Date('2026-09-24T12:00:00') })
    expect(calls.some((call) => call.url.includes('intune-backups') || call.url.includes('other.json'))).toBe(false)
  })
})

describe('restore step IDs', () => {
  const step: Step = { method: 'POST', path: 'deviceManagement/x/{id}/assign?note={id}', body: { text: 'keep {id}', 'roleDefinition@odata.bind': "https://graph.microsoft.com/beta/deviceManagement/roleDefinitions('{id}')" }, kind: 'assignments' }
  it('substitutes the ID into the path and binds only', () => {
    expect(resolveStep(step, 'abc_DefaultLimit')).toEqual({ ...step, path: 'deviceManagement/x/abc_DefaultLimit/assign?note={id}', body: { text: 'keep {id}', 'roleDefinition@odata.bind': "https://graph.microsoft.com/beta/deviceManagement/roleDefinitions('abc_DefaultLimit')" } })
  })
  it.each(['../x', 'a/b', 'a?b', "a')", ''])('rejects the created ID %s', (id) => {
    expect(() => resolveStep(step, id)).toThrow('invalid object ID')
  })
})

describe('Graph IDs in extras and secret paths', () => {
  it('encodes IDs returned by Graph as single path segments', async () => {
    const paths: string[] = []
    const reader = {
      get: async (path: string): Promise<Item> => {
        paths.push(path)
        if (path.includes('getOmaSettingPlainTextValue')) return { value: 'plain' }
        return { id: 'dc 1', omaSettings: [{ isEncrypted: true, secretReferenceValueId: "ref'/x" }] }
      },
      list: async (path: string): Promise<Item[]> => {
        paths.push(path)
        return [{ id: 'assignment/1' }]
      },
    }
    await readObject(typeForFolder('DeviceConfigurations')!, 'dc 1', reader)
    expect(paths.at(-1)).toBe("deviceManagement/deviceConfigurations/dc%201/getOmaSettingPlainTextValue(secretReferenceValueId='ref''%2Fx')")
    paths.length = 0
    await readObject(typeForFolder('RoleDefinitions')!, 'role/1', reader)
    expect(paths).toContain('deviceManagement/roleDefinitions/role%2F1/roleAssignments')
    expect(paths).toContain('deviceManagement/roleAssignments/assignment%2F1')
  })
})

describe('pagination guards', () => {
  const policies = typeForFolder('ConfigurationPolicies')!
  const live = (next: (count: number) => string): GraphCall => {
    let count = 0
    return async (_method, path) => {
      const body: Item = path.includes('?$expand=') ? { id: 'p1', settings: [], 'settings@odata.nextLink': next(count) } : { value: [], '@odata.nextLink': next(++count) }
      return { status: 200, body }
    }
  }
  it('stops a restore read on a repeated nextLink', async () => {
    await expect(readLive(live(() => 'https://graph.microsoft.com/beta/page'), policies, 'p1')).rejects.toThrow('repeated continuation link')
  })
  it('stops a restore read after the page cap', async () => {
    await expect(readLive(live((count) => `https://graph.microsoft.com/beta/page?n=${count}`), policies, 'p1')).rejects.toThrow('did not finish after 5000 pages')
  })

  async function backupWithListing(listing: (marker: string) => string, graph?: (url: URL) => Response) {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'tv-hardening-')), [randomBytes(32)])
    const account = localStorageAccountName(TENANT)
    const requested: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      requested.push(url.href)
      if (localAccountFromUrl(url)) {
        if (url.searchParams.get('comp') === 'list' && url.searchParams.get('prefix') === 'backup-') return new Response(listing(url.searchParams.get('marker') ?? ''))
        return handleLocalBlobRequest(store, request)
      }
      if (graph) return graph(url)
      return Response.json(url.pathname.split('/').length <= 4 ? { value: [] } : { id: 'x' })
    }) as typeof fetch
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => 'token', retentionDays: () => 30, now: () => new Date('2026-09-24T12:00:00Z') })
    const { id } = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account })
    for (let i = 0; i < 2000; i++) {
      const job = engine.get(id)!
      if (job.status !== 'Running') return { job, requested }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('backup did not finish')
  }
  it('stops a storage listing on a repeated marker', async () => {
    const { job } = await backupWithListing(() => '<EnumerationResults><Blobs></Blobs><NextMarker>same</NextMarker></EnumerationResults>')
    expect(job.log.join('\n')).toContain('Could not remove old backups: Storage returned a repeated continuation marker')
  })
  it('stops a storage listing after the page cap', async () => {
    const { job, requested } = await backupWithListing((marker) => `<EnumerationResults><Blobs></Blobs><NextMarker>m${Number(marker.slice(1) || 0) + 1}</NextMarker></EnumerationResults>`)
    expect(job.log.join('\n')).toContain('Could not remove old backups: Storage listing did not finish after 10000 pages')
    expect(requested.filter((url) => url.includes('prefix=backup-')).length).toBe(10_000)
  }, 60_000)
  it('rejects expanded-collection nextLinks on another origin', async () => {
    const { job, requested } = await backupWithListing(() => '<EnumerationResults><Blobs></Blobs></EnumerationResults>', (url) => {
      if (url.pathname === '/beta/deviceManagement/configurationPolicies') return Response.json({ value: [{ id: 'sc1', name: 'A' }] })
      if (url.pathname === '/beta/deviceManagement/configurationPolicies/sc1') return Response.json({ id: 'sc1', name: 'A', settings: [], 'settings@odata.nextLink': 'https://graph.microsoft.com.evil.test/beta/x' })
      return Response.json(url.pathname.split('/').length <= 4 ? { value: [] } : { id: 'x' })
    })
    expect(job.log.join('\n')).toContain('Invalid Graph continuation link')
    expect(requested.some((url) => url.includes('evil.test'))).toBe(false)
  })
})
