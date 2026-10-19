import { afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from '../src/main/api/next-server-shim'
import { POST as drift } from '../src/portal/app/api/detect-drifts/route'
import { POST as download } from '../src/portal/app/api/download-backup/route'
import { POST as contents } from '../src/portal/app/api/list-backup-contents/route'
import { listBlobPages } from '../src/portal/lib/storage/list'

const args = { tenantId: 'tenant', appId: 'app', clientSecret: 'test', storageAccountName: 'store', subscriptionId: 'local', resourceGroupName: 'local', backupId: 'backup-2026-09-25-120000' }
const request = () => new NextRequest('http://tenuvault.internal/api/test', { method: 'POST', body: JSON.stringify(args) })
afterEach(() => vi.unstubAllGlobals())

it('does not call an incomplete snapshot a clean drift scan', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.searchParams.get('comp') === 'list') return new Response('<BlobPrefix><Name>backup-2026-09-25-120000/</Name></BlobPrefix><BlobPrefix><Name>backup-2026-09-24-120000/</Name></BlobPrefix>')
    return Response.json({ Status: 'CompletedWithWarnings' })
  }))
  const response = await drift(request())
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'INSUFFICIENT_BACKUPS', error: expect.stringContaining('two complete backups') })
})

it('fails a drift scan when a policy listing cannot be read', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.pathname.endsWith('/metadata.json')) return Response.json({ Status: 'Success' })
    if (url.searchParams.get('delimiter')) return new Response('<BlobPrefix><Name>backup-2026-09-25-120000/</Name></BlobPrefix><BlobPrefix><Name>backup-2026-09-24-120000/</Name></BlobPrefix>')
    return new Response('', { status: 403 })
  }))
  const response = await drift(request())
  expect(response.status).toBe(500)
  expect((await response.json()).error).toContain('403')
})

it('does not return a successful ZIP when a backup file is unreadable', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.searchParams.get('comp') === 'list') return new Response(`<Blobs><Blob><Name>${args.backupId}/one.json</Name></Blob><Blob><Name>${args.backupId}/two.json</Name></Blob></Blobs>`)
    if (url.pathname.endsWith('metadata.json') || url.pathname.endsWith('.tenuvault-owner.json')) return new Response('', { status: 404 })
    return url.pathname.endsWith('one.json') ? Response.json({ policy: 'one' }) : new Response('', { status: 403 })
  }))
  const response = await download(request())
  expect(response.status).toBe(502)
  expect((await response.json()).error).toContain('1 backup files')
})

it('lists selectable policies from every page and decodes escaped filenames', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.pathname.endsWith('metadata.json')) return Response.json({ Status: 'Success' })
    const second = url.searchParams.get('marker') === 'next&part'
    return new Response(`<Blobs><Blob><Name>${args.backupId}/DeviceConfigurations/${second ? 'Two' : 'A&amp;B'}.json</Name><Properties><Content-Length>10</Content-Length></Properties></Blob></Blobs><NextMarker>${second ? '' : 'next&amp;part'}</NextMarker>`)
  }))
  const response = await contents(request())
  expect(response.status).toBe(200)
  const { content } = await response.json()
  expect(content.groups.map((g: { folder: string }) => g.folder)).toEqual(['DeviceConfigurations'])
  expect(content.groups[0].policies.map((p: {name: string}) => p.name)).toEqual(['A&B.json', 'Two.json'])
})

it('rejects repeated continuation markers instead of hanging forever', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<NextMarker>repeat</NextMarker>')))
  await expect(listBlobPages('https://store.blob.core.windows.net/intune-backups?comp=list', 'test')).rejects.toThrow('repeated')
})

it('reports an unmet prerequisite rather than zero drift when only one backup exists', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    return new Response('<BlobPrefix><Name>backup-2026-09-25-120000/</Name></BlobPrefix>')
  }))
  const response = await drift(request())
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'INSUFFICIENT_BACKUPS' })
})

it('stops a download when storage repeats the continuation marker', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).hostname === 'login.microsoftonline.com'
    ? Response.json({ access_token: 'test' }) : new Response('<NextMarker>repeat</NextMarker>')))
  const response = await download(request())
  expect(response.status).toBe(500)
  expect((await response.json()).error).toContain('repeated continuation marker')
})
