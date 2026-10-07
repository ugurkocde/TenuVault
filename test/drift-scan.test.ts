import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from '../src/main/api/next-server-shim'
import { POST as drift } from '../src/portal/app/api/detect-drifts/route'
import { selectBackupPair, DriftPairError, type BackupMetadata } from '../src/shared/intune/drift'
import { DriftJobs, driftScanRoutes, DriftJobError } from '../src/main/drift/jobs'
import { apiBody } from '../src/main/features/deps'
import { call, TENANT_A } from './feature-helpers'
import { memoryStore } from './helpers'
import { parseBackupName } from '../src/shared/intune/backup-names'
import { POST as listBackups } from '../src/portal/app/api/list-backups/route'
import { compareBackups, summarize } from '../src/shared/intune/backup-changes'
import { createAuditRecorder } from '../src/main/api/audit'
import { CANCELLED_HEADER, registerDriftScan } from '../src/portal/lib/drift/scan-hooks'
import type { DriftScanProgress } from '../src/shared/intune/drift'

afterEach(() => vi.unstubAllGlobals())

const OTHER_TENANT = '22222222-2222-2222-2222-222222222222'

describe('Backup pair selection', () => {
  const folders = [
    { name: 'backup-2026-09-26-120000', timestamp: '2026-09-26T12:00:00.000Z' },
    { name: 'backup-2026-09-25-120000', timestamp: '2026-09-25T12:00:00.000Z' },
    { name: 'backup-2026-09-24-120000', timestamp: '2026-09-24T12:00:00.000Z' },
    { name: 'backup-2026-09-23-120000', timestamp: '2026-09-23T12:00:00.000Z' },
    { name: 'backup-2026-09-22-120000', timestamp: '2026-09-22T12:00:00.000Z' },
    { name: 'backup-2026-09-21-120000', timestamp: '2026-09-21T12:00:00.000Z' },
  ]
  const metadata: Record<string, BackupMetadata | null> = {
    'backup-2026-09-26-120000': null, // still running
    'backup-2026-09-25-120000': { Status: 'CompletedWithWarnings', TenantId: TENANT_A },
    'backup-2026-09-24-120000': { Status: 'Success', TenantId: OTHER_TENANT },
    'backup-2026-09-23-120000': { Status: 'Success', TenantId: TENANT_A },
    'backup-2026-09-22-120000': { Status: 'Completed' }, // made before backups recorded their tenant
    'backup-2026-09-21-120000': { Status: 'Success', TenantId: TENANT_A },
  }
  const select = (pair: { baseline?: string; comparison?: string } = {}) => {
    const load = vi.fn(async (name: string) => metadata[name] ?? null)
    return { load, result: selectBackupPair({ folders, tenantId: TENANT_A.toUpperCase(), load, ...pair }) }
  }
  const refusal = async (pair: { baseline?: string; comparison?: string }) => {
    const error = await select(pair).result.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DriftPairError)
    return error as DriftPairError
  }

  it('defaults to the two newest complete backups of the tenant and stops reading once found', async () => {
    const { load, result } = select()
    const pair = await result
    expect(pair.comparison.name).toBe('backup-2026-09-23-120000')
    expect(pair.baseline.name).toBe('backup-2026-09-22-120000')
    expect(load).toHaveBeenCalledTimes(5)
  })

  it('compares exactly the pair asked for, including one that completed with warnings', async () => {
    const pair = await select({ baseline: 'backup-2026-09-21-120000', comparison: 'backup-2026-09-25-120000' }).result
    expect([pair.baseline.name, pair.comparison.name]).toEqual(['backup-2026-09-21-120000', 'backup-2026-09-25-120000'])
  })

  it('rejects a reversed pair, the same backup twice, or only one backup', async () => {
    expect(await refusal({ baseline: 'backup-2026-09-23-120000', comparison: 'backup-2026-09-21-120000' })).toMatchObject({ code: 'INVALID_PAIR', status: 400, message: expect.stringContaining('older') })
    expect(await refusal({ baseline: 'backup-2026-09-23-120000', comparison: 'backup-2026-09-23-120000' })).toMatchObject({ code: 'INVALID_PAIR' })
    expect(await refusal({ baseline: 'backup-2026-09-23-120000' })).toMatchObject({ code: 'INVALID_PAIR' })
  })

  it('rejects incomplete, missing and other tenants\' backups', async () => {
    expect(await refusal({ baseline: 'backup-2026-09-23-120000', comparison: 'backup-2026-09-26-120000' })).toMatchObject({ code: 'BACKUP_INCOMPLETE', status: 409 })
    expect(await refusal({ baseline: 'backup-2026-09-20-120000', comparison: 'backup-2026-09-23-120000' })).toMatchObject({ code: 'BACKUP_NOT_FOUND', status: 404 })
    expect(await refusal({ baseline: 'backup-2026-09-23-120000', comparison: 'backup-2026-09-24-120000' })).toMatchObject({ code: 'BACKUP_OTHER_TENANT', status: 403 })
  })

  it('looks past any number of newer failed backups, as the drift page does', async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ name: `backup-2026-09-${String(28 - i).padStart(2, '0')}-120000`, timestamp: `2026-09-${String(28 - i).padStart(2, '0')}T12:00:00.000Z` }))
    const load = async (name: string) => ({ Status: many.slice(-2).some(folder => folder.name === name) ? 'Success' : 'Failed' })
    const pair = await selectBackupPair({ folders: many, tenantId: TENANT_A, load })
    expect([pair.baseline.name, pair.comparison.name]).toEqual(['backup-2026-09-15-120000', 'backup-2026-09-16-120000'])
    // An explicit limit, as older callers send, still applies.
    await expect(selectBackupPair({ folders: many, tenantId: TENANT_A, load, limit: 10 })).rejects.toMatchObject({ code: 'INSUFFICIENT_BACKUPS' })
  })

  it('reports fewer than two complete backups as an unmet prerequisite', async () => {
    const load = async () => ({ Status: 'CompletedWithWarnings' })
    await expect(selectBackupPair({ folders, tenantId: TENANT_A, load })).rejects.toMatchObject({ code: 'INSUFFICIENT_BACKUPS', status: 409 })
  })
})

/** A storage account with backups, served the way the blob endpoints answer the route. */
interface FakeBackup { metadata: Record<string, unknown> | null; files: Record<string, unknown> }
function fakeStorage(backups: Record<string, FakeBackup>, options: { unreadable?: string[]; beforeRead?: (path: string) => Promise<void> | void } = {}) {
  const reads: string[] = []
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.pathname === '/api/revert-metadata') return Response.json({ reverts: {} })
    if (url.searchParams.get('delimiter')) return new Response(Object.keys(backups).map(name => `<BlobPrefix><Name>${name}/</Name></BlobPrefix>`).join(''))
    const prefix = url.searchParams.get('prefix')
    if (prefix) {
      // Every blob whose name starts with the prefix, as Azure lists them.
      const names = Object.entries(backups).flatMap(([backup, { files }]) => Object.keys(files).map(path => `${backup}/${path}`)).filter(name => name.startsWith(prefix))
      return new Response(names.map(name => `<Blob><Name>${name}</Name></Blob>`).join(''))
    }
    const [, , backup, ...rest] = url.pathname.split('/').map(decodeURIComponent)
    const path = rest.join('/')
    if (path === 'metadata.json') return backups[backup!]?.metadata ? Response.json(backups[backup!]!.metadata) : new Response('', { status: 404 })
    reads.push(`${backup}/${path}`)
    await options.beforeRead?.(`${backup}/${path}`)
    if (options.unreadable?.includes(`${backup}/${path}`)) return new Response('', { status: 403 })
    const content = backups[backup!]?.files[path]
    return content === undefined ? new Response('', { status: 404 }) : Response.json(content)
  })
  vi.stubGlobal('fetch', stub)
  return { reads, stub }
}

const OLD = 'backup-2026-09-22-120000'
const NEW = 'backup-2026-09-23-120000'
const policy = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, displayName: name, '@odata.type': '#microsoft.graph.windows10GeneralConfiguration', ...extra })

/** Two backups: A unchanged, B changed, C added, D deleted, E changed only in a volatile timestamp. */
function twoBackups(withItems: boolean): Record<string, FakeBackup> {
  const items = (entries: Record<string, { file: string; hash: string }>) => (withItems ? { Items: entries } : {})
  return {
    [NEW]: {
      metadata: { Status: 'Success', TenantId: TENANT_A, Trigger: 'scheduled', ...items({ 'DeviceConfigurations/a': { file: 'A.json', hash: 'ha' }, 'DeviceConfigurations/b': { file: 'B.json', hash: 'hb2' }, 'DeviceConfigurations/c': { file: 'C.json', hash: 'hc' }, 'DeviceConfigurations/e': { file: 'E.json', hash: 'he' } }) },
      files: {
        'DeviceConfigurations/A.json': policy('a', 'A', { passwordMinimumLength: 8 }),
        'DeviceConfigurations/B.json': policy('b', 'B', { passwordMinimumLength: 12, omaSettings: [{ displayName: 'Setting', omaUri: './x', value: 2 }] }),
        'DeviceConfigurations/C.json': policy('c', 'C'),
        'DeviceConfigurations/E.json': policy('e', 'E', { modifiedDateTime: '2026-09-23T00:00:00Z' }),
      },
    },
    [OLD]: {
      metadata: { Status: 'Success', TenantId: TENANT_A, Trigger: 'manual', ...items({ 'DeviceConfigurations/a': { file: 'A.json', hash: 'ha' }, 'DeviceConfigurations/b': { file: 'B.json', hash: 'hb1' }, 'DeviceConfigurations/d': { file: 'D.json', hash: 'hd' }, 'DeviceConfigurations/e': { file: 'E.json', hash: 'he' } }) },
      files: {
        'DeviceConfigurations/A.json': policy('a', 'A', { passwordMinimumLength: 8 }),
        'DeviceConfigurations/B.json': policy('b', 'B', { passwordMinimumLength: 8, omaSettings: [{ displayName: 'Setting', omaUri: './x', value: 1 }] }),
        'DeviceConfigurations/D.json': policy('d', 'D'),
        'DeviceConfigurations/E.json': policy('e', 'E', { modifiedDateTime: '2026-09-22T00:00:00Z' }),
      },
    },
  }
}

const request = (body: Record<string, unknown> = {}) => new NextRequest('http://tenuvault.internal/api/detect-drifts', { method: 'POST', body: JSON.stringify({ tenantId: TENANT_A, appId: 'app', clientSecret: 'test', storageAccountName: 'store', ...body }) })
const comparable = (drifts: any[]) => drifts.map(({ id: _id, detectedAt: _at, ...rest }) => rest).sort((a, b) => a.backupFile.localeCompare(b.backupFile))

describe('Drift scan', () => {
  it('skips items whose stored fingerprints match and finds the same drift as a full compare', async () => {
    const full = fakeStorage(twoBackups(false))
    const fullResponse = await drift(request())
    expect(fullResponse.status).toBe(200)
    const fullResult = await fullResponse.json()

    const skipping = fakeStorage(twoBackups(true))
    const skipResponse = await drift(request())
    expect(skipResponse.status).toBe(200)
    const skipResult = await skipResponse.json()

    expect(comparable(skipResult.drifts)).toEqual(comparable(fullResult.drifts))
    expect(skipResult.drifts.map((d: any) => `${d.changeType}:${d.configName}`).sort()).toEqual(['added:C', 'deleted:D', 'modified:B'])
    expect(skipResult.drifts.find((d: any) => d.configName === 'B').changes.map((c: any) => c.field).sort()).toEqual(['omaSettings[Setting].value', 'passwordMinimumLength'])
    // A and E have matching fingerprints, so neither copy is read.
    expect(skipping.reads.filter(path => /\/(A|E)\.json$/.test(path))).toEqual([])
    expect(full.reads.filter(path => /\/(A|E)\.json$/.test(path))).toHaveLength(4)
    expect(skipResult.stats).toEqual({ compared: 3, unchanged: 2 })
    expect(skipResult.summary).toMatchObject({ total: 3, added: 1, modified: 1, deleted: 1 })
    expect(skipResult.baseline).toEqual({ id: OLD, timestamp: '2026-09-22T12:00:00.000Z', trigger: 'manual', status: 'Success' })
    expect(skipResult.comparison).toMatchObject({ id: NEW, trigger: 'scheduled' })
  })

  it('reports an unreadable file as a warning instead of failing the scan', async () => {
    fakeStorage(twoBackups(true), { unreadable: [`${NEW}/DeviceConfigurations/B.json`] })
    const response = await drift(request())
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.warnings).toEqual([{ file: 'DeviceConfigurations/B.json', backup: NEW, message: expect.stringContaining('403') }])
    expect(result.drifts.map((d: any) => d.configName).sort()).toEqual(['C', 'D'])
  })

  it('lists each compared backup once and reports progress while checking and listing', async () => {
    const storage = fakeStorage(twoBackups(true))
    const progress: DriftScanProgress[] = []
    const unregister = registerDriftScan('scan-progress', { tenantId: TENANT_A, signal: new AbortController().signal, onProgress: (step) => void progress.push(step) })
    const response = await drift(request({ scanId: 'scan-progress' }))
    unregister()
    expect(response.status).toBe(200)
    expect((await response.json()).summary.total).toBe(3)

    // The container once for its backups, then each backup once. Listing every type folder of
    // both backups took 1 + 2 x 40 requests.
    const lists = storage.stub.mock.calls.map(([input]) => new URL(String(input))).filter(url => url.searchParams.get('comp') === 'list')
    expect(lists.map(url => url.searchParams.get('prefix'))).toEqual([null, `${NEW}/`, `${OLD}/`])

    // Found the backups, read both metadata files, listed both backups, then compared.
    expect(progress.slice(0, 7).map(step => `${step.phase} ${step.done}/${step.total}`)).toEqual([
      'checking 0/0', 'checking 1/0', 'checking 2/0', 'checking 3/0', 'listing 0/2', 'listing 1/2', 'listing 2/2',
    ])
    expect(progress[7]).toMatchObject({ phase: 'comparing', done: 0, total: 3 })
  })

  it('compares an explicit pair and refuses another tenant\'s backup', async () => {
    const backups = twoBackups(true)
    backups['backup-2026-09-21-120000'] = { metadata: { Status: 'Success', TenantId: OTHER_TENANT }, files: {} }
    fakeStorage(backups)
    const ok = await drift(request({ baseline: OLD, comparison: NEW }))
    expect(ok.status).toBe(200)
    expect((await ok.json()).baseline.id).toBe(OLD)
    const refused = await drift(request({ baseline: 'backup-2026-09-21-120000', comparison: NEW }))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'BACKUP_OTHER_TENANT' })
    const reversed = await drift(request({ baseline: NEW, comparison: OLD }))
    expect(reversed.status).toBe(400)
  })
})

describe('Drift item matching', () => {
  const meta = (items: Record<string, { file: string; hash: string }> | null) => ({ Status: 'Success', TenantId: TENANT_A, ...(items ? { Items: items } : {}) })

  it('reports a renamed item with the same Intune ID as modified, with the name and setting changes', async () => {
    const reads = fakeStorage({
      [NEW]: { metadata: meta({ 'ConfigurationPolicies/p1': { file: 'Login v3.8.json', hash: 'h2' } }), files: { 'ConfigurationPolicies/Login v3.8.json': { id: 'p1', name: 'Login v3.8', settings: [{ settingInstance: { settingDefinitionId: 'device_vendor_msft_policy_config_a_b', choiceSettingValue: { value: 'device_vendor_msft_policy_config_a_b_1', children: [] } } }] } } },
      [OLD]: { metadata: meta({ 'ConfigurationPolicies/p1': { file: 'Login v3.1.json', hash: 'h1' } }), files: { 'ConfigurationPolicies/Login v3.1.json': { id: 'p1', name: 'Login v3.1', settings: [{ settingInstance: { settingDefinitionId: 'device_vendor_msft_policy_config_a_b', choiceSettingValue: { value: 'device_vendor_msft_policy_config_a_b_0', children: [] } } }] } } },
    })
    const result = await (await drift(request())).json()
    expect(result.drifts).toHaveLength(1)
    expect(result.drifts[0]).toMatchObject({ changeType: 'modified', configName: 'Login v3.8', previousName: 'Login v3.1', configId: 'p1', backupFile: 'ConfigurationPolicies/Login v3.1.json', fromBackup: OLD })
    expect(result.drifts[0].changes.map((change: any) => change.field).sort()).toEqual(['name', 'settings[device_vendor_msft_policy_config_a_b].settingInstance.choiceSettingValue.value'])
    expect(result.summary).toMatchObject({ added: 0, modified: 1, deleted: 0 })
    expect(reads.reads).toHaveLength(2)
  })

  it('keeps a new ID that reuses a deleted item\'s file name as added and deleted', async () => {
    fakeStorage({
      [NEW]: { metadata: meta({ 'DeviceConfigurations/new': { file: 'A.json', hash: 'hn' } }), files: { 'DeviceConfigurations/A.json': policy('new', 'A') } },
      [OLD]: { metadata: meta({ 'DeviceConfigurations/old': { file: 'A.json', hash: 'ho' } }), files: { 'DeviceConfigurations/A.json': policy('old', 'A') } },
    })
    const result = await (await drift(request())).json()
    expect(result.drifts.map((d: any) => `${d.changeType}:${d.configId}`).sort()).toEqual(['added:new', 'deleted:old'])
  })

  it('matches by file name when a backup has no Items', async () => {
    fakeStorage({
      [NEW]: { metadata: meta({ 'DeviceConfigurations/a': { file: 'A.json', hash: 'h2' } }), files: { 'DeviceConfigurations/A.json': policy('a', 'A', { passwordMinimumLength: 12 }) } },
      [OLD]: { metadata: meta(null), files: { 'DeviceConfigurations/A.json': policy('a', 'A', { passwordMinimumLength: 8 }) } },
    })
    const result = await (await drift(request())).json()
    expect(result.drifts.map((d: any) => d.changeType)).toEqual(['modified'])
    expect(result.drifts[0].previousName).toBeUndefined()
  })

  it('reports an item whose file is missing from either backup as a warning, not as added or deleted', async () => {
    const items = { 'DeviceConfigurations/a': { file: 'A.json', hash: 'h1' }, 'DeviceConfigurations/b': { file: 'B.json', hash: 'h1' } }
    const changed = { 'DeviceConfigurations/a': { file: 'A.json', hash: 'h2' }, 'DeviceConfigurations/b': { file: 'B.json', hash: 'h2' } }
    fakeStorage({
      // A is missing from the comparison backup, B from the baseline.
      [NEW]: { metadata: meta(changed), files: { 'DeviceConfigurations/B.json': policy('b', 'B') } },
      [OLD]: { metadata: meta(items), files: { 'DeviceConfigurations/A.json': policy('a', 'A') } },
    })
    const result = await (await drift(request())).json()
    expect(result.drifts).toEqual([])
    expect(result.warnings).toEqual([
      { file: 'DeviceConfigurations/A.json', backup: NEW, message: expect.stringContaining('missing') },
      { file: 'DeviceConfigurations/B.json', backup: OLD, message: expect.stringContaining('missing') },
    ])
  })

  it('names the renamed newer file when it cannot be read', async () => {
    fakeStorage({
      [NEW]: { metadata: meta({ 'DeviceConfigurations/a': { file: 'A v2.json', hash: 'h2' } }), files: { 'DeviceConfigurations/A v2.json': policy('a', 'A v2') } },
      [OLD]: { metadata: meta({ 'DeviceConfigurations/a': { file: 'A v1.json', hash: 'h1' } }), files: { 'DeviceConfigurations/A v1.json': policy('a', 'A v1') } },
    }, { unreadable: [`${NEW}/DeviceConfigurations/A v2.json`] })
    const result = await (await drift(request())).json()
    expect(result.drifts).toEqual([])
    expect(result.warnings).toEqual([{ file: 'DeviceConfigurations/A v2.json', backup: NEW, message: expect.stringContaining('403') }])
  })

  it('agrees with the backup list counts for the same pair', async () => {
    const backups = twoBackups(true)
    fakeStorage(backups)
    const result = await (await drift(request())).json()
    const listed = summarize(compareBackups(backups[OLD]!.metadata as any, backups[NEW]!.metadata as any))
    expect({ added: result.summary.added, modified: result.summary.modified, removed: result.summary.deleted }).toEqual(listed)
  })
})

describe('Backup folder names', () => {
  const DAY_OLD = '2024-08-01'
  const UNDERSCORE_NEW = '2024-08-02_09-30-00_1722591000000'

  it('parses every format the backup list and drift detection share', () => {
    expect(parseBackupName('backup-2026-09-25-120000')).toEqual({ name: 'backup-2026-09-25-120000', timestamp: '2026-09-25T12:00:00.000Z', precision: 'second' })
    expect(parseBackupName('2026-09-25_12-00-00')).toMatchObject({ timestamp: '2026-09-25T12:00:00.000Z', precision: 'second' })
    expect(parseBackupName(UNDERSCORE_NEW)).toMatchObject({ timestamp: '2024-08-02T09:30:00.000Z' })
    expect(parseBackupName(DAY_OLD)).toEqual({ name: DAY_OLD, timestamp: DAY_OLD, precision: 'day' })
    for (const name of ['backup-2026-13-45-999999', 'tenant-metadata.json', 'backup-2026-09-25', '2026-09-25_12']) expect(parseBackupName(name)).toBeNull()
  })

  it('lists and compares legacy day-only and underscore backups alike', async () => {
    const backups: Record<string, FakeBackup> = {
      [UNDERSCORE_NEW]: { metadata: { Status: 'Success' }, files: { 'DeviceConfigurations/A.json': policy('a', 'A', { passwordMinimumLength: 12 }) } },
      [DAY_OLD]: { metadata: { Status: 'Success' }, files: { 'DeviceConfigurations/A.json': policy('a', 'A', { passwordMinimumLength: 8 }) } },
    }
    fakeStorage(backups)
    const listed = await (await listBackups(new NextRequest('http://tenuvault.internal/api/list-backups', { method: 'POST', body: JSON.stringify({ tenantId: TENANT_A, appId: 'app', clientSecret: 'test', storageAccountName: 'store', subscriptionId: 'local', resourceGroupName: 'local' }) }))).json()
    expect(listed.backups.map((backup: any) => [backup.id, backup.timestamp])).toEqual([[UNDERSCORE_NEW, '2024-08-02T09:30:00.000Z'], [DAY_OLD, DAY_OLD]])

    const byDefault = await (await drift(request())).json()
    expect([byDefault.baseline.id, byDefault.comparison.id]).toEqual([DAY_OLD, UNDERSCORE_NEW])
    expect(byDefault.drifts.map((d: any) => d.changeType)).toEqual(['modified'])
    expect((await drift(request({ baseline: DAY_OLD, comparison: UNDERSCORE_NEW }))).status).toBe(200)
  })

  it('lets the scan job start an explicit legacy pair', async () => {
    fakeStorage({})
    const jobs = new DriftJobs({ store: memoryStore(), tenant: () => ({ tenantId: TENANT_A, name: 'Contoso', clientId: 'app', storageAccountName: 'store' }), plan: async () => 'community', api: async () => Response.json({ error: 'x' }, { status: 500 }) })
    const job = await jobs.start(TENANT_A, { baseline: DAY_OLD, comparison: UNDERSCORE_NEW })
    expect(job).toMatchObject({ baseline: DAY_OLD, comparison: UNDERSCORE_NEW })
    await jobs.settled(job.jobId)
  })
})

describe('Drift scan jobs', () => {
  const setup = () => {
    const store = memoryStore()
    const notified: string[] = []
    const profile = { tenantId: TENANT_A, name: 'Contoso', clientId: 'app', storageAccountName: 'store' }
    const jobs = new DriftJobs({
      store,
      tenant: (id) => (id.toLowerCase() === TENANT_A ? profile : null),
      plan: async () => 'community',
      // The API host, reduced to the route: the tenant's credentials are filled in by apiBody.
      api: (path, tenantId, body) => drift(new NextRequest(`http://tenuvault.internal${path}`, { method: 'POST', body: JSON.stringify(apiBody(tenantId, { clientId: 'app', storageAccountName: 'store' }, body)) })),
      notify: (job) => void notified.push(job.status),
    })
    return { jobs, store, notified, profile }
  }

  /** Holds every policy read until released. */
  function gate() {
    let release!: () => void
    const opened = new Promise<void>(resolve => { release = resolve })
    let firstRead!: () => void
    const started = new Promise<void>(resolve => { firstRead = resolve })
    return { release, started, beforeRead: async () => { firstRead(); await opened } }
  }

  it('starts in the background, reports progress, runs once per tenant and saves the result', async () => {
    const reads = gate()
    fakeStorage(twoBackups(true), { beforeRead: reads.beforeRead })
    const { jobs, store, notified } = setup()

    const job = await jobs.start(TENANT_A)
    expect(job).toMatchObject({ status: 'running', tenantId: TENANT_A, baseline: null })
    await reads.started
    const running = jobs.list().find(entry => entry.jobId === job.jobId)!
    expect(running).toMatchObject({ phase: 'comparing', total: 3, detail: expect.stringContaining('of 3') })
    expect(running.percent).toBeGreaterThanOrEqual(10)

    // One scan per tenant: the default pair joins the running scan, another pair is refused.
    expect((await jobs.start(TENANT_A)).jobId).toBe(job.jobId)
    await expect(jobs.start(TENANT_A, { baseline: OLD, comparison: NEW })).rejects.toMatchObject({ status: 409 })

    reads.release()
    await jobs.settled(job.jobId)
    expect(jobs.list()[0]).toMatchObject({ status: 'completed', percent: 100, summary: { total: 3 } })
    expect(notified).toEqual(['completed'])
    const saved = jobs.result(TENANT_A)!
    expect(saved).toMatchObject({ tenantId: TENANT_A, jobId: job.jobId, baseline: { id: OLD }, comparison: { id: NEW } })
    expect(saved.drifts).toHaveLength(3)
    expect(store.values.has(`drift.result.v1.${TENANT_A}`)).toBe(true)
    expect(saved.storageAccountName).toBe('store')
  })

  it('moves the progress bar between listing the two backups', async () => {
    const storage = fakeStorage(twoBackups(true))
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    // The older backup's listing waits, so the scan stays between its two listings.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input)).searchParams.get('prefix') === `${OLD}/`) await held
      return storage.stub(input)
    }))
    const { jobs } = setup()
    const job = await jobs.start(TENANT_A)
    await vi.waitFor(() => expect(jobs.list()[0]).toMatchObject({ phase: 'listing', done: 1, total: 2 }))
    // Past checking (at most 5) and short of comparing (from 10).
    expect(jobs.list()[0]!.percent).toBe(8)
    release()
    await jobs.settled(job.jobId)
    expect(jobs.list()[0]).toMatchObject({ status: 'completed', percent: 100 })
  })

  it('does not show a result saved for the storage account the tenant used before', async () => {
    fakeStorage(twoBackups(true))
    const { jobs, profile } = setup()
    const job = await jobs.start(TENANT_A)
    await jobs.settled(job.jobId)
    expect(jobs.result(TENANT_A)).not.toBeNull()
    profile.storageAccountName = `tvlocal-${TENANT_A}`
    expect(jobs.result(TENANT_A)).toBeNull()
  })

  it('does not audit a scan the admin cancelled', async () => {
    const dispatch = vi.fn(async () => new Response('{}'))
    const record = createAuditRecorder(dispatch, () => null)
    const scan = new Request('http://tenuvault.internal/api/detect-drifts', { method: 'POST' })
    const body = JSON.stringify({ tenantId: TENANT_A, appId: 'app', clientSecret: 'x', storageAccountName: 'store' })
    record(scan, body, Response.json({ code: 'CANCELLED' }, { status: 409, headers: { [CANCELLED_HEADER]: '1' } }))
    expect(dispatch).not.toHaveBeenCalled()
    record(scan, body, Response.json({ drifts: [] }))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('stops reading backup files once cancelled and keeps the previous result', async () => {
    const reads = gate()
    // More changed items than are read at once, so the cancel lands with reads still to come.
    const files = (version: number) => Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`DeviceConfigurations/P${i}.json`, policy(`p${i}`, `P${i}`, { passwordMinimumLength: version })]))
    const storage = fakeStorage({
      [NEW]: { metadata: { Status: 'Success', TenantId: TENANT_A }, files: files(12) },
      [OLD]: { metadata: { Status: 'Success', TenantId: TENANT_A }, files: files(8) },
    }, { beforeRead: reads.beforeRead })
    const { jobs, store, notified } = setup()
    store.set(`drift.result.v1.${TENANT_A}`, JSON.stringify({ schemaVersion: 1, tenantId: TENANT_A, jobId: 'earlier', storageAccountName: 'store', drifts: [], baseline: { id: OLD }, comparison: { id: NEW } }))

    const job = await jobs.start(TENANT_A)
    await reads.started
    expect(jobs.cancel(TENANT_A, job.jobId).status).toBe('cancelled')
    const inFlight = storage.reads.length
    reads.release()
    await jobs.settled(job.jobId)

    // Reads already sent finish; no new file is read after the cancel.
    expect(inFlight).toBeLessThan(60)
    expect(storage.reads.length).toBe(inFlight)
    expect(storage.stub.mock.calls.some(([input]) => new URL(String(input)).pathname === '/api/revert-metadata')).toBe(false)
    expect(jobs.list()[0]).toMatchObject({ status: 'cancelled' })
    expect(jobs.result(TENANT_A)?.jobId).toBe('earlier')
    expect(notified).toEqual(['cancelled'])
  })

  it('records why a scan could not run', async () => {
    fakeStorage({ [NEW]: twoBackups(true)[NEW]! })
    const { jobs } = setup()
    const job = await jobs.start(TENANT_A)
    await jobs.settled(job.jobId)
    expect(jobs.list()[0]).toMatchObject({ status: 'failed', code: 'INSUFFICIENT_BACKUPS' })
    expect(jobs.result(TENANT_A)).toBeNull()
  })

  it('answers the drift-scan route actions', async () => {
    fakeStorage(twoBackups(true))
    const { jobs } = setup()
    const routes = driftScanRoutes(jobs)
    expect((await call(routes, '/api/drift-scan', { action: 'start', tenantId: OTHER_TENANT })).status).toBe(404)
    expect((await call(routes, '/api/drift-scan', { action: 'start', tenantId: TENANT_A, baseline: OLD })).status).toBe(400)
    const started = await call(routes, '/api/drift-scan', { action: 'start', tenantId: TENANT_A, baseline: OLD, comparison: NEW })
    expect(started).toMatchObject({ status: 200, body: { job: { status: 'running', baseline: OLD, comparison: NEW } } })
    await jobs.settled(started.body.job.jobId)
    expect((await call(routes, '/api/drift-scan', { action: 'jobs' })).body.jobs).toHaveLength(1)
    const result = await call(routes, '/api/drift-scan', { action: 'result', tenantId: TENANT_A })
    expect(result.body.result.summary.total).toBe(3)
    expect((await call(routes, '/api/drift-scan', { action: 'cancel', tenantId: TENANT_A, jobId: 'missing' })).status).toBe(404)
    expect(new DriftJobError('x').status).toBe(400)
  })
})
