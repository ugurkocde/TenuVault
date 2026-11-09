import { afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from '../src/main/api/next-server-shim'
import { POST as download } from '../src/portal/app/api/download-backup/route'
import { createBridgedFetch } from '../src/main/api/fetch-bridge'
import { withNetworkErrors } from '../src/main/api/network-error'
import { legacyAzureReader } from '../src/main/storage/azure-seal'
import { DELEGATED_CLIENT_SECRET, MAX_BACKUP_ARCHIVE_BYTES, MAX_BACKUP_ARCHIVE_FILES, MAX_BACKUP_ARCHIVE_TOTAL_BYTES } from '../src/shared/constants'
import { endlessBody } from './helpers'

const args = { tenantId: 'tenant', appId: 'app', clientSecret: 'test', storageAccountName: 'store', backupId: 'backup-2026-09-25-120000' }
const request = () => new NextRequest('http://tenuvault.internal/api/download-backup', { method: 'POST', body: JSON.stringify(args) })
/** The total a download may hold; one file, such as metadata.json, may hold at most MAX_BACKUP_ARCHIVE_BYTES. */
const MAX = MAX_BACKUP_ARCHIVE_TOTAL_BYTES

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
  expect((await response.json()).error).toContain('128 MiB')
  expect(bodyFetches).toEqual([])
})

it('refuses a listing over the file count cap when lengths are unavailable', async () => {
  const names = Array.from({ length: MAX_BACKUP_ARCHIVE_FILES + 1 }, (_, i) => blob(`${args.backupId}/DeviceConfigurations/P${i}.json`)).join('')
  const bodyFetches = stubListing(names)
  const response = await download(request())
  expect(response.status).toBe(413)
  expect((await response.json()).error).toContain(String(MAX_BACKUP_ARCHIVE_FILES))
  expect(bodyFetches).toEqual([])
})

it('refuses when a fetched body exceeds the limit its listing size understated', async () => {
  const listing = blob(`${args.backupId}/metadata.json`, 20) + blob(`${args.backupId}/DeviceConfigurations/A.json`)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.searchParams.get('comp') === 'list') return new Response(`<Blobs>${listing}</Blobs>`)
    if (url.pathname.endsWith('/metadata.json')) return Response.json({ TenantId: args.tenantId })
    // No content length in the listing, and the body itself is over the cap for one file.
    return new Response(new Uint8Array(MAX_BACKUP_ARCHIVE_BYTES + 1))
  }))
  const response = await download(request())
  expect(response.status).toBe(413)
  expect((await response.json()).error).toContain('32 MiB per file')
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

it('stops an oversized metadata stream at the cap through the production fetch bridge and legacy reader', async () => {
  const big = endlessBody(40, new TextEncoder().encode('{"TenantId":"'))
  const policyReads: string[] = []
  const network = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.searchParams.get('comp') === 'list') return new Response(`<Blobs>${blob(`${args.backupId}/metadata.json`)}${blob(`${args.backupId}/DeviceConfigurations/A.json`, 10)}</Blobs>`)
    if (url.pathname.endsWith('/metadata.json')) return new Response(big.body)
    // The ownership check also asks for the marker; this backup has none.
    if (url.pathname.endsWith('/.tenuvault-owner.json')) return new Response('', { status: 404 })
    policyReads.push(url.pathname)
    return Response.json({ policy: 'x' })
  })
  const bridge = createBridgedFetch({
    dispatch: async () => new Response(),
    getDelegatedToken: async () => ({ accessToken: 'storage-token', expiresOn: null }),
    fetch: legacyAzureReader(withNetworkErrors(network), () => [Buffer.alloc(32, 4)]),
  })
  vi.stubGlobal('fetch', bridge)
  const response = await download(new NextRequest('http://tenuvault.internal/api/download-backup', { method: 'POST', body: JSON.stringify({ ...args, tenantId: '11111111-1111-1111-1111-111111111111', storageAccountName: 'contoso', clientSecret: DELEGATED_CLIENT_SECRET }) }))
  expect({ status: response.status, policyReads }).toEqual({ status: 413, policyReads: [] })
  expect(big.pulled()).toBeLessThan(40)
})
