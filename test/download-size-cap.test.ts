import { afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from '../src/main/api/next-server-shim'
import { POST as download } from '../src/portal/app/api/download-backup/route'

const args = { tenantId: 'tenant', appId: 'app', clientSecret: 'test', storageAccountName: 'store', backupId: 'backup-2026-09-25-120000' }
const request = () => new NextRequest('http://tenuvault.internal/api/download-backup', { method: 'POST', body: JSON.stringify(args) })
const MAX = 32 * 1024 * 1024

const blob = (name: string, size?: number) => `<Blob><Name>${name}</Name>${size === undefined ? '' : `<Properties><Content-Length>${size}</Content-Length></Properties>`}</Blob>`

function stubListing(listing: string) {
  const bodyFetches: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.searchParams.get('comp') === 'list') return new Response(`<Blobs>${listing}</Blobs>`)
    bodyFetches.push(url.pathname)
    // Blobs that are not listed do not exist.
    if (!listing.includes(`<Name>${decodeURIComponent(url.pathname.replace('/intune-backups/', ''))}</Name>`)) return new Response('', { status: 404 })
    return Response.json(url.pathname.endsWith('/metadata.json') || url.pathname.endsWith('/.tenuvault-owner.json') ? { TenantId: args.tenantId } : { policy: 'x' })
  }))
  return bodyFetches
}

afterEach(() => vi.unstubAllGlobals())

it('refuses an over-limit listing before fetching any file body', async () => {
  const bodyFetches = stubListing(blob(`${args.backupId}/DeviceConfigurations/A.json`, MAX + 1))
  const response = await download(request())
  expect(response.status).toBe(413)
  expect((await response.json()).error).toContain('32 MiB')
  expect(bodyFetches).toEqual([])
})

it('refuses a listing over the file count cap when lengths are unavailable', async () => {
  const names = Array.from({ length: 5001 }, (_, i) => blob(`${args.backupId}/DeviceConfigurations/P${i}.json`)).join('')
  const bodyFetches = stubListing(names)
  const response = await download(request())
  expect(response.status).toBe(413)
  expect((await response.json()).error).toContain('5000')
  expect(bodyFetches).toEqual([])
})

it('refuses when a fetched body exceeds the limit its listing size understated', async () => {
  const listing = blob(`${args.backupId}/metadata.json`, 20) + blob(`${args.backupId}/DeviceConfigurations/A.json`)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.searchParams.get('comp') === 'list') return new Response(`<Blobs>${listing}</Blobs>`)
    if (url.pathname.endsWith('/metadata.json')) return Response.json({ TenantId: args.tenantId })
    // No content length in the listing, and the body itself is over the cap.
    return new Response(new Uint8Array(MAX + 1))
  }))
  const response = await download(request())
  expect(response.status).toBe(413)
  expect((await response.json()).error).toContain('32 MiB')
})

it('downloads a listing that is exactly at the limit', async () => {
  const bodyFetches = stubListing(blob(`${args.backupId}/DeviceConfigurations/A.json`, MAX / 2) + blob(`${args.backupId}/metadata.json`, MAX / 2))
  const response = await download(request())
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/zip')
  // metadata.json is read once for the ownership check, then both files for the archive.
  expect(bodyFetches[0]).toBe(`/intune-backups/${args.backupId}/metadata.json`)
  expect(bodyFetches).toHaveLength(3)
})

it('excludes directory and ownership marker blobs from the size cap and the archive', async () => {
  const bodyFetches = stubListing(blob(`${args.backupId}/DeviceConfigurations/`, MAX + 1) + blob(`${args.backupId}/.tenuvault-owner.json`, MAX + 1) + blob(`${args.backupId}/DeviceConfigurations/A.json`, 10))
  const response = await download(request())
  expect(response.status).toBe(200)
  // Without metadata, the ownership marker is read to place the backup; it is not archived.
  expect(bodyFetches).toEqual([
    `/intune-backups/${args.backupId}/metadata.json`,
    `/intune-backups/${args.backupId}/.tenuvault-owner.json`,
    `/intune-backups/${args.backupId}/DeviceConfigurations/A.json`,
  ])
})

it('refuses oversized metadata during the ownership check without reading it whole', async () => {
  const listing = blob(`${args.backupId}/metadata.json`) + blob(`${args.backupId}/DeviceConfigurations/A.json`, 10)
  const chunk = new Uint8Array(1024 * 1024)
  let pulled = 0
  const policyReads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.searchParams.get('comp') === 'list') return new Response(`<Blobs>${listing}</Blobs>`)
    if (url.pathname.endsWith('/.tenuvault-owner.json')) return new Response('', { status: 404 })
    if (!url.pathname.endsWith('/metadata.json')) {
      policyReads.push(url.pathname)
      return Response.json({ policy: 'x' })
    }
    // 40 MiB with no content length, streamed so the reader has to stop at the cap.
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 40) return controller.close()
        pulled++
        controller.enqueue(chunk)
      },
    }))
  }))
  const response = await download(request())
  expect(response.status).toBe(413)
  expect((await response.json()).error).toContain('32 MiB')
  expect(pulled).toBeLessThan(40)
  expect(policyReads).toEqual([])
})
