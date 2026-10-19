import { afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from '../src/main/api/next-server-shim'
import { POST as restore } from '../src/portal/app/api/restore-backup/route'
import { POST as preview } from '../src/portal/app/api/restore-preview/route'
const credentials = { tenantId: 'tenant', appId: 'app', clientSecret: 'secret', storageAccountName: 'store', backupId: 'backup-1' }
afterEach(() => vi.unstubAllGlobals())
it('returns a client error for malformed mappings before authentication or writes', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const response = await restore(new NextRequest('https://tenuvault.internal/api/restore-backup', { method: 'POST', body: JSON.stringify({ ...credentials, dependencyMappings: {} }) }))
  expect(response.status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
})
it('keeps healthy preview items available when another snapshot is malformed', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('login.microsoftonline.com')) return Response.json({ access_token: 'token' })
    return Response.json(url.endsWith('bad.json') ? null : { id: 'category', displayName: 'Healthy' }, { headers: { 'x-tenuvault-authenticated': 'true' } })
  }))
  const response = await preview(new NextRequest('https://tenuvault.internal/api/restore-preview', { method: 'POST', body: JSON.stringify({ ...credentials, paths: ['backup-1/DeviceCategories/bad.json', 'backup-1/DeviceCategories/good.json'] }) }))
  expect(response.status).toBe(200)
  const data = await response.json()
  expect(data.items[0]).toMatchObject({ live: 'error', blocker: expect.any(String) })
  expect(data.items[1]).toMatchObject({ name: 'Healthy' })
  expect(data.items[1].blocker).toBeUndefined()
})

it.each([[404, 400], [403, 500]])('reports mapped-target status %s as HTTP %s before any writes', async (status, expected) => {
  const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes('login.microsoftonline.com') ? Response.json({ access_token: 'token' })
    : String(input).includes('.blob.core.windows.net') ? new Response('', { status: 404 })
    : Response.json({ error: { message: 'Target unavailable' } }, { status }))
  vi.stubGlobal('fetch', fetcher)
  const response = await restore(new NextRequest('https://tenuvault.internal/api/restore-backup', { method: 'POST', body: JSON.stringify({
    ...credentials, restoreType: 'selective', selectedPolicies: [{ path: 'backup-1/Apps/app.json' }],
    targetTenants: [{ tenantId: '22222222-2222-2222-2222-222222222222', appId: '33333333-3333-3333-3333-333333333333' }],
    dependencyMappings: [{ folder: 'Apps', sourceId: '44444444-4444-4444-4444-444444444444', targetId: '55555555-5555-5555-5555-555555555555' }], confirmMappings: true,
  }) }))
  expect(response.status).toBe(expected)
  expect(fetcher.mock.calls.filter(([input]) => String(input).includes('graph.microsoft.com'))).toHaveLength(1)
})
