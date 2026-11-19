import { afterEach, expect, it, vi } from 'vitest'
import { POST } from '../src/portal/app/api/list-backups/route'
import { NextRequest } from '../src/main/api/next-server-shim'
const args = { tenantId: 'tenant', appId: 'app', clientSecret: 'test', storageAccountName: 'store', subscriptionId: 'local', resourceGroupName: 'local' }
afterEach(() => vi.unstubAllGlobals())
function fixture(metadata: () => Response, listingStatus = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.pathname.endsWith('.tenuvault-owner.json')) return new Response(null, { status: 404 })
    if (url.pathname.endsWith('metadata.json')) return metadata()
    if (url.searchParams.get('delimiter')) return new Response('<Blobs><BlobPrefix><Name>2026-09-20/</Name></BlobPrefix><BlobPrefix><Name>backup-2026-09-21-020000/</Name></BlobPrefix></Blobs>')
    if (listingStatus !== 200) return new Response('', { status: listingStatus })
    const prefix = url.searchParams.get('prefix')
    return new Response(`<Blobs><Blob><Name>${prefix}DeviceConfigurations/a.json</Name><Properties><Content-Length>123</Content-Length></Properties></Blob><Blob><Name>${prefix}metadata.json</Name><Properties><Content-Length>77</Content-Length></Properties></Blob></Blobs>`)
  }))
}
const request = () => new NextRequest('http://tenuvault.internal/api/list-backups', { method: 'POST', body: JSON.stringify(args) })
it('reads actual legacy metadata and blob sizes alongside modern folders', async () => {
  fixture(() => Response.json({ status: 'failed', duration: '47s', runbookVersion: '1.2.3', timestamp: '2026-09-20T14:32:10Z' }))
  const { backups } = await (await POST(request())).json()
  expect(backups).toHaveLength(2)
  expect(backups[1]).toMatchObject({ id: '2026-09-20', status: 'failed', duration: '47s', runbookVersion: '1.2.3', timestamp: '2026-09-20T14:32:10Z', size: 200, type: null, totalPolicies: 1 })
})
it.each(['missing', 'unreadable', 'malformed'])('shows unknown fields for %s legacy metadata', async (kind) => {
  fixture(() => kind === 'malformed' ? new Response('bad json') : new Response('', { status: kind === 'missing' ? 404 : 403 }))
  const { backups } = await (await POST(request())).json()
  expect(backups[1]).toMatchObject({ status: 'unknown', timestamp: '2026-09-20', timestampPrecision: 'day', duration: null, runbookVersion: null, type: null, size: 200 })
  if (kind !== 'missing') expect(backups[1].error).toMatch(/metadata/)
})
it('reports inaccessible legacy folders instead of silently omitting them', async () => {
  fixture(() => new Response('', { status: 404 }), 403)
  const response = await POST(request())
  expect(response.status).toBe(500)
  expect((await response.json()).error).toContain('inventory is unavailable')
})

it('preserves the historical app-protection and conditional-access folder counts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.pathname.endsWith('.tenuvault-owner.json')) return new Response(null, { status: 404 })
    if (url.pathname.endsWith('metadata.json')) return new Response(null, { status: 404 })
    if (url.searchParams.get('delimiter')) return new Response('<BlobPrefix><Name>2026-09-20/</Name></BlobPrefix>')
    return new Response(['AppProtectionPolicies', 'ConditionalAccess'].map((folder) => `<Blob><Name>2026-09-20/${folder}/a.json</Name><Content-Length>10</Content-Length></Blob>`).join(''))
  }))
  const { backups } = await (await POST(request())).json()
  expect(backups[0]).toMatchObject({ totalPolicies: 2, policies: { appProtectionPolicies: 1, conditionalAccess: 1 } })
})
