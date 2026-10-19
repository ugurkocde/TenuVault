import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from '../src/main/api/next-server-shim'
import { POST as revertPolicy } from '../src/portal/app/api/revert-policy/route'
import { POST as revertMetadata } from '../src/portal/app/api/revert-metadata/route'
import { compareObjects, POST as detectDrifts } from '../src/portal/app/api/detect-drifts/route'

const A = 'AAAAAAAA-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const LEGACY = 'metadata/revert-history.json'
const historyOf = (tenant: string) => `metadata/${tenant.toLowerCase()}/revert-history.json`
const credentials = { appId: 'app', clientSecret: 'placeholder', storageAccountName: 'shared' }
const post = (path: string, body: unknown) => new NextRequest(`http://tenuvault.internal${path}`, { method: 'POST', body: JSON.stringify(body) })

const OLDER = 'backup-2026-09-22-120000'
const NEWER = 'backup-2026-09-23-120000'
const B_BACKUP = 'backup-2026-09-21-120000'
const UNPLACED = 'backup-2026-09-20-120000'
const policy = (value: string) => ({ id: 'p1', displayName: 'Firewall', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [{ displayName: 'Setting', value }] })

/** One shared intune-backups container: blobs by name, with ETags and Azure's conditional writes. */
function stubContainer(seed: Record<string, unknown>, unreadable?: string) {
  const blobs = new Map<string, { body: string; etag: number }>(Object.entries(seed).map(([name, body]) => [name, { body: JSON.stringify(body), etag: 1 }]))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token' })
    if (url.hostname === 'graph.microsoft.com') return Response.json({ id: 'copy' }, { status: 201 })
    if (url.pathname === '/api/revert-metadata') return revertMetadata(new NextRequest(url, { method: 'POST', body: init!.body as string }))
    if (url.searchParams.get('comp') === 'list') {
      const prefix = url.searchParams.get('prefix')
      if (!prefix) return new Response([OLDER, NEWER].map(name => `<BlobPrefix><Name>${name}/</Name></BlobPrefix>`).join(''))
      return new Response([...blobs.keys()].filter(name => name.startsWith(prefix) && name.endsWith('.json') && !name.endsWith('/metadata.json')).map(name => `<Blob><Name>${name}</Name></Blob>`).join(''))
    }
    const name = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/')
    if (name === unreadable) return new Response('busy', { status: 503 })
    const blob = blobs.get(name)
    if ((init?.method ?? 'GET') === 'GET') return blob ? new Response(blob.body, { headers: { etag: `"${blob.etag}"` } }) : new Response('missing', { status: 404 })
    const headers = init!.headers as Record<string, string>
    if (headers['If-Match'] && (!blob || headers['If-Match'] !== `"${blob.etag}"`)) return new Response('ConditionNotMet', { status: 412 })
    if (headers['If-None-Match'] === '*' && blob) return new Response('BlobAlreadyExists', { status: 409 })
    blobs.set(name, { body: String(init!.body), etag: (blob?.etag ?? 0) + 1 })
    return new Response(null, { status: 201 })
  }))
  return { read: (name: string) => blobs.has(name) ? JSON.parse(blobs.get(name)!.body) : undefined }
}

const backups = {
  [`${OLDER}/metadata.json`]: { TenantId: A, Status: 'Success' },
  [`${NEWER}/metadata.json`]: { TenantId: A, Status: 'Success' },
  [`${B_BACKUP}/metadata.json`]: { TenantId: B, Status: 'Success' },
  [`${OLDER}/DeviceConfigurations/Firewall.json`]: policy('old'),
  [`${NEWER}/DeviceConfigurations/Firewall.json`]: policy('new'),
  [`${B_BACKUP}/DeviceConfigurations/Firewall.json`]: policy('old'),
}
const entry = (fromBackup: string, extra: Record<string, unknown> = {}) => ({ timestamp: '2026-09-22T18:00:00.000Z', action: 'revert', fromBackup, policyName: 'Firewall', policyType: 'deviceConfiguration', status: 'success', ...extra })
const restore = (tenantId: string, policyId: string, backup: string) => revertPolicy(post('/api/revert-policy', { tenantId, ...credentials, action: 'restore', policyId, policyType: 'deviceConfiguration', backupPath: `${backup}/DeviceConfigurations/Firewall.json` }))
const historyFor = async (tenantId: string) => (await revertMetadata(post('/api/revert-metadata', { tenantId, ...credentials }))).json()

afterEach(() => vi.unstubAllGlobals())

describe('Revert history per tenant', () => {
  it('keeps the histories of two tenants in one container apart', async () => {
    const container = stubContainer(backups)
    expect((await restore(A, 'p1', OLDER)).status).toBe(200)
    expect((await restore(B, 'p2', B_BACKUP)).status).toBe(200)

    expect(Object.keys(container.read(historyOf(A)).reverts)).toEqual(['p1'])
    expect(Object.keys(container.read(historyOf(B)).reverts)).toEqual(['p2'])
    expect(container.read(LEGACY)).toBeUndefined()
    expect(Object.keys((await historyFor(A)).reverts)).toEqual(['p1'])
    expect(Object.keys((await historyFor(B)).reverts)).toEqual(['p2'])
  })

  it('refuses a tenant ID that is not a GUID', async () => {
    stubContainer(backups)
    expect((await revertMetadata(post('/api/revert-metadata', { tenantId: '../other', ...credentials }))).status).toBe(400)
  })

  it('reads only the entries of the old shared file whose backup names the tenant', async () => {
    stubContainer({
      ...backups,
      [`${UNPLACED}/metadata.json`]: { Status: 'Success' },
      [LEGACY]: { reverts: {
        p1: [entry(OLDER), entry(B_BACKUP)],
        p2: [entry(`${B_BACKUP}/DeviceConfigurations/Firewall.json`)],
        p3: [entry(UNPLACED), entry('backup-2026-01-01-000000')],
        p4: [entry('ignored', { fromBackup: undefined, toBackup: NEWER })],
      } },
    })
    expect(await historyFor(A)).toEqual({ reverts: { p1: [entry(OLDER)], p4: [entry('ignored', { fromBackup: undefined, toBackup: NEWER })] } })
    expect(await historyFor(B)).toEqual({ reverts: { p1: [entry(B_BACKUP)], p2: [entry(`${B_BACKUP}/DeviceConfigurations/Firewall.json`)] } })
  })

  it('starts a tenant history with its own legacy entries and leaves the shared file alone', async () => {
    const legacy = { reverts: { p1: [entry(OLDER), entry(B_BACKUP)] } }
    const container = stubContainer({ ...backups, [LEGACY]: legacy })
    expect((await restore(A, 'p9', OLDER)).status).toBe(200)

    const history = container.read(historyOf(A))
    expect(history.reverts.p1).toEqual([entry(OLDER)])
    expect(history.reverts.p9).toHaveLength(1)
    expect(container.read(LEGACY)).toEqual(legacy)
    // With its own history in place, the tenant no longer reads the shared file.
    expect(Object.keys((await historyFor(A)).reverts).sort()).toEqual(['p1', 'p9'])
    expect(await historyFor(B)).toEqual({ reverts: { p1: [entry(B_BACKUP)] } })
  })

  it('does not start a tenant history when the shared file cannot be read', async () => {
    const container = stubContainer({ ...backups, [LEGACY]: { reverts: {} } }, LEGACY)
    expect((await restore(A, 'p9', OLDER)).status).toBe(200)
    expect(container.read(historyOf(A))).toBeUndefined()
  })
})

describe('Revert drift detection', () => {
  const changes = compareObjects(policy('old'), policy('new'))
  const revert = (fromBackup: string) => entry(fromBackup, { changesReverted: changes.map(change => ({ field: change.field, oldValue: change.oldValue, revertedTo: change.newValue })) })
  const scan = async () => {
    const response = await detectDrifts(post('/api/detect-drifts', { tenantId: A, ...credentials }))
    expect(response.status).toBe(200)
    const { drifts } = await response.json()
    expect(drifts).toHaveLength(1)
    return drifts[0]
  }

  it("ignores another tenant's revert of the same policy", async () => {
    stubContainer({ ...backups, [LEGACY]: { reverts: { p1: [revert(B_BACKUP)] } }, [historyOf(B)]: { reverts: { p1: [revert(B_BACKUP)] } } })
    const drift = await scan()
    expect(drift.isRevertDrift).toBeUndefined()
    expect(drift.revertHistory).toBeUndefined()
  })

  it("uses the tenant's own revert history", async () => {
    stubContainer({ ...backups, [historyOf(A)]: { reverts: { p1: [revert(OLDER)] } }, [historyOf(B)]: { reverts: {} } })
    const drift = await scan()
    expect(drift).toMatchObject({ isRevertDrift: true, revertTimestamp: '2026-09-22T18:00:00.000Z' })
  })
})
