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
    return Response.json({ policy: 'x' })
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

it('downloads a listing that is exactly at the limit', async () => {
  const bodyFetches = stubListing(blob(`${args.backupId}/DeviceConfigurations/A.json`, MAX / 2) + blob(`${args.backupId}/metadata.json`, MAX / 2))
  const response = await download(request())
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/zip')
  expect(bodyFetches).toHaveLength(2)
})

it('excludes directory and ownership marker blobs from the size cap and the archive', async () => {
  const bodyFetches = stubListing(blob(`${args.backupId}/DeviceConfigurations/`, MAX + 1) + blob(`${args.backupId}/.tenuvault-owner.json`, MAX + 1) + blob(`${args.backupId}/DeviceConfigurations/A.json`, 10))
  const response = await download(request())
  expect(response.status).toBe(200)
  expect(bodyFetches).toEqual([`/intune-backups/${args.backupId}/DeviceConfigurations/A.json`])
})
