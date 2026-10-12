import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../src/portal/app/api/list-backups/route'
import { NextRequest } from '../src/main/api/next-server-shim'
import { useDashboardStats } from '../src/portal/hooks/dashboard/useDashboardStats'
import { allows } from '../src/shared/plans'

const state = vi.hoisted(() => ({ plans: ['community', 'pro'], tenants: [
  { id: 1, name: 'First', credentials: { tenantId: 'first', appId: 'app', clientSecret: 'test' }, resources: { subscriptionId: 'local', resourceGroupName: 'local', storageAccountName: 'store' } },
  { id: 2, name: 'Second', credentials: { tenantId: 'second', appId: 'app', clientSecret: 'test' }, resources: { subscriptionId: 'local', resourceGroupName: 'local', storageAccountName: 'store' } },
] }))
vi.mock('~/contexts/TenantContext', () => ({ useTenants: () => state.tenants }))
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options }))
vi.mock('@desktop/lib/bridge', () => ({ bridge: { schedules: { list: async () => [] } } }))
vi.mock('@desktop/lib/license', () => ({
  useLicense: () => ({ status: {} }),
  tenantLicense: (_status: unknown, id: string) => state.plans[state.tenants.findIndex(tenant => tenant.credentials.tenantId === id)],
  tenantPlan: (plan: string) => plan,
}))
const args = { tenantId: 'summary-tenant', appId: 'app', clientSecret: 'test', subscriptionId: 'local', resourceGroupName: 'local', storageAccountName: 'summary-store' }
const request = (summary: boolean) => new NextRequest('http://tenuvault.internal/api/list-backups', { method: 'POST', body: JSON.stringify({ ...args, summary }) })
afterEach(() => vi.unstubAllGlobals())
beforeEach(() => { state.plans = ['community', 'pro'] })

describe('dashboard summary inventory', () => {
  it('preserves every descriptor and reads unchanged metadata once without per-backup listings', async () => {
    const folders = ['backup-2026-10-01-020000', '2026-09-20', 'backup-2026-09-15-020000', 'backup-2026-10-02-020000']
    const blobs: Record<string, object> = {
      [`${folders[0]}/metadata.json`]: { Status: 'Success', TenantId: args.tenantId, DurationSeconds: 12, Scope: { Excluded: [] } },
      [`${folders[0]}/DeviceConfigurations/A.json`]: {},
      [`${folders[1]}/metadata.json`]: { status: 'failed', timestamp: '2026-09-20T12:00:00Z', duration: '47s' },
      [`${folders[1]}/AppProtectionPolicies/B.json`]: {},
      [`${folders[2]}/ConditionalAccess/C.json`]: {},
      [`${folders[3]}/metadata.json`]: { Status: 'Success', TenantId: 'another-tenant' },
    }
    let version = 1
    const xml = (name: string) => `<Blob><Name>${name}</Name><Properties><Content-Length>${JSON.stringify(blobs[name]).length}</Content-Length><Etag>${version}</Etag></Properties></Blob>`
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
      if (url.searchParams.has('delimiter')) return new Response(folders.map(folder => `<BlobPrefix><Name>${folder}/</Name></BlobPrefix>`).join(''))
      if (url.searchParams.get('comp') === 'list') return new Response(Object.keys(blobs).filter(name => name.startsWith(url.searchParams.get('prefix') ?? '')).map(xml).join(''))
      const name = url.pathname.replace('/intune-backups/', '')
      return name in blobs ? Response.json(blobs[name]) : new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetcher)
    const full = await (await POST(request(false))).json()
    fetcher.mockClear()
    expect(await (await POST(request(true))).json()).toEqual(full)
    const listingCalls = () => fetcher.mock.calls.filter(([input]) => new URL(String(input)).searchParams.get('comp') === 'list')
    expect(listingCalls()).toHaveLength(1)
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('metadata.json'))).toHaveLength(3)
    fetcher.mockClear()
    expect(await (await POST(request(true))).json()).toEqual(full)
    expect(listingCalls()).toHaveLength(1)
    expect(fetcher.mock.calls).toHaveLength(2)
    version++
    blobs[`${folders[0]}/metadata.json`] = { Status: 'CompletedWithWarnings', TenantId: args.tenantId }
    const changed = await (await POST(request(true))).json()
    expect(changed.backups[0].status).toBe('CompletedWithWarnings')
  })

  it('requests summaries and audits only tenants whose plan includes auditLog', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/audit/') ? Response.json({ data: [] }) : Response.json({ backups: [] }))
    vi.stubGlobal('fetch', fetcher)
    const query = useDashboardStats() as unknown as { queryFn: () => Promise<unknown>; queryKey: unknown[]; refetchInterval: number }
    await query.queryFn()
    expect(query.refetchInterval).toBe(30000)
    const backups = fetcher.mock.calls.filter(([url]) => String(url) === '/api/list-backups') as unknown as [string, RequestInit][]
    expect(backups).toHaveLength(2)
    expect(backups.every(([, init]) => JSON.parse(String(init.body)).summary === true)).toBe(true)
    const audits = fetcher.mock.calls.filter(([url]) => String(url) === '/api/audit/logs') as unknown as [string, RequestInit][]
    expect(audits).toHaveLength(1)
    expect(JSON.parse(String(audits[0]![1].body))).toMatchObject({ tenantId: 'second', filter: { limit: 20 } })
    expect(allows('community', 'auditLog')).toBe(false)
    state.plans = ['pro', 'pro']
    const upgraded = useDashboardStats() as unknown as { queryKey: unknown[] }
    expect(upgraded.queryKey).not.toEqual(query.queryKey)
  })
})


it('uses saved drift timestamps through the bridge without an audit event, including Community and selected tenants', async () => {
  const times: Record<string, string> = { first: '2026-10-10T12:00:00Z', second: '2026-10-11T14:00:00Z' }
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/drift-scan') {
      const body = JSON.parse(String(init?.body))
      expect(body.action).toBe('result')
      return Response.json({ result: { lastScan: times[body.tenantId] } })
    }
    return String(input).includes('/audit/') ? Response.json({ data: [] }) : Response.json({ backups: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  const query = (id?: number) => useDashboardStats('7d', id) as unknown as { queryFn: () => Promise<{ lastDriftCheck: { time: Date; succeeded: boolean } | null }> }
  expect((await query(1).queryFn()).lastDriftCheck).toEqual({ time: new Date(times.first!), succeeded: true })
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/audit/'))).toBe(false)
  expect((await query().queryFn()).lastDriftCheck).toEqual({ time: new Date(times.second!), succeeded: true })
  times.first = 'invalid'
  expect((await query(1).queryFn()).lastDriftCheck).toBeNull()
  fetcher.mockImplementation(async input => String(input) === '/api/drift-scan' ? new Response(null, { status: 503 }) : Response.json({ backups: [] }))
  expect((await query(1).queryFn()).lastDriftCheck).toBeNull()
})
