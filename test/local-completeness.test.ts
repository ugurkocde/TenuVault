import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalBlobStore } from '../src/main/storage/local-blob-store'
import { handleLocalBlobRequest } from '../src/main/storage/blob-emulator'
import { NextRequest } from '../src/main/api/next-server-shim'
import { POST as listBackups } from '../src/portal/app/api/list-backups/route'
import { POST as download } from '../src/portal/app/api/download-backup/route'
import { POST as drift } from '../src/portal/app/api/detect-drifts/route'
import { POST as preview } from '../src/portal/app/api/restore-preview/route'
import { POST as changes } from '../src/portal/app/api/backup-changes/route'
import { POST as contents } from '../src/portal/app/api/list-backup-contents/route'
import { POST as restore } from '../src/portal/app/api/restore-backup/route'

const account = 'tvlocal-test'
const container = 'intune-backups'
const folders = ['backup-2026-09-23-020000', 'backup-2026-09-24-020000', 'backup-2026-09-25-020000']
const args = { tenantId: 'test', appId: 'app', clientSecret: 'test', storageAccountName: account, subscriptionId: 'local', resourceGroupName: 'local' }
const roots: string[] = []
const request = (body: object = {}) => new NextRequest('http://tenuvault.internal/api/test', { method: 'POST', body: JSON.stringify({ ...args, ...body }) })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'tv-completeness-')); roots.push(root)
  const key = randomBytes(32)
  const store = new LocalBlobStore(root, [key])
  const dir = join(root, account, container)
  await store.createContainer(account, container)
  const files = new Map<string, string>()
  const put = async (name: string, data: object) => {
    const before = new Set(readdirSync(dir))
    await store.put(account, container, name, Buffer.from(JSON.stringify(data)), 'application/json')
    files.set(name, readdirSync(dir).find(file => !before.has(file))!)
  }
  for (const folder of folders) {
    await put(`${folder}/DeviceConfigurations/A.json`, { id: 'a', displayName: 'A', value: 1 })
    await put(`${folder}/metadata.json`, { Status: 'Success', TenantId: 'test', ...(legacy && folder === folders[0] ? {} : { Items: { 'DeviceConfigurations/a': { file: 'A.json', hash: 'same' } } }) })
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.pathname === '/api/revert-metadata') return Response.json({ reverts: {} })
    return handleLocalBlobRequest(store, req)
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  return { root, key, store, dir, files }
}

async function completeOperations(folder: string) {
  const baseline = folder === folders[0] ? folders[0] : folders[1]
  const comparison = folder === folders[0] ? folders[1] : folders[2]
  return [
    await download(request({ backupId: folder })),
    await drift(request({ baseline, comparison })),
    await preview(request({ backupId: folder, paths: [`${folder}/DeviceConfigurations/A.json`] })),
    await changes(request({ backupId: folder })),
  ]
}

it.each(['legacy policy header', 'manifest header'])('pauses complete operations across the container for a truncated %s until removal', async (damage) => {
  const { store, dir, files } = await setup(damage === 'legacy policy header')
  const affected = folders[0]!
  const name = `${affected}/${damage === 'manifest header' ? 'metadata.json' : 'DeviceConfigurations/A.json'}`
  const file = files.get(name)!
  writeFileSync(join(dir, file), readFileSync(join(dir, file)).subarray(0, 4))
  const inventory = await store.inventory(account, container)
  expect(inventory.completenessUnknown).toBe(true)
  expect(inventory.retentionPaused).toBe(true)
  expect(inventory.damagedFiles).toEqual([expect.objectContaining({ file, name: undefined })])
  // Low-level reads and new writes stay usable, even while complete operations are paused.
  expect((await store.get(account, container, `${folders[2]}/DeviceConfigurations/A.json`)).data.toString()).toContain('"id":"a"')
  await store.put(account, container, 'backup-new/metadata.json', Buffer.from('{}'), 'application/json')
  expect((await store.list(account, container)).some(blob => blob.name === 'backup-new/metadata.json')).toBe(true)
  const history = await listBackups(request())
  expect(history.status).toBe(200)
  expect(await history.json()).toMatchObject({ completenessUnknown: true, retentionPaused: true, damagedFiles: [{ file, reason: 'Truncated backup header', ownershipUnknown: true }] })
  for (const folder of folders) {
    for (const response of await completeOperations(folder)) {
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ code: 'IncompleteInventory', error: expect.stringContaining('IncompleteInventory') })
    }
  }
  // A caller cannot bypass completeness by dropping its prefix or changing the delimiter.
  for (const query of ['', '&prefix=backup-&delimiter=/', '&prefix=backup-&delimiter=-']) {
    const response = await handleLocalBlobRequest(store, new Request(`https://${account}.blob.core.windows.net/${container}?restype=container&comp=list${query}`))
    expect(response.headers.get('x-ms-error-code')).toBe('IncompleteInventory')
  }
  rmSync(join(dir, file))
  expect(await store.inventory(account, container)).toMatchObject({ completenessUnknown: false, retentionPaused: false, damagedFiles: [] })
  expect(await (await listBackups(request())).json()).toMatchObject({ completenessUnknown: false, retentionPaused: false, damagedFiles: [] })
  for (const response of await completeOperations(folders[2]!)) expect(response.status).toBe(200)
})

it.each(['truncated header', 'duplicate body'])('attributes a %s through its readable manifest and leaves other backups usable', async (damage) => {
  const { store, dir, files } = await setup()
  const name = `${folders[0]}/DeviceConfigurations/A.json`
  const file = files.get(name)!
  if (damage === 'truncated header') writeFileSync(join(dir, file), 'TVB1')
  else copyFileSync(join(dir, file), join(dir, 'conflict.tvb'))
  const inventory = await store.inventory(account, container)
  expect(inventory).toMatchObject({ completenessUnknown: false, retentionPaused: true })
  expect(inventory.damagedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ file, name })]))
  for (const response of await completeOperations(folders[2]!)) expect(response.status).toBe(200)
  for (const response of [await download(request({ backupId: folders[0] })), await preview(request({ backupId: folders[0], paths: [] })), await changes(request({ backupId: folders[0] }))]) {
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'IncompleteInventory' })
  }
})

it('shows damage and unknown ownership when an unreadable metadata header leaves history empty', async () => {
  const { store, dir, files } = await setup()
  const keep = files.get(`${folders[0]}/metadata.json`)!
  for (const file of readdirSync(dir)) if (file !== keep) rmSync(join(dir, file))
  writeFileSync(join(dir, keep), 'TVB1')
  expect(await store.list(account, container)).toEqual([])
  const history = await listBackups(request())
  expect(history.status).toBe(200)
  expect(await history.json()).toEqual({ backups: [], damagedFiles: [{ file: keep, reason: 'Truncated backup header', ownershipUnknown: true }], completenessUnknown: true, retentionPaused: true })
})

it('returns the inventory error and recovery reason from contents and full restore when a header is truncated', async () => {
  const { dir, files } = await setup(true)
  writeFileSync(join(dir, files.get(`${folders[0]}/DeviceConfigurations/A.json`)!), 'TVB1')
  for (const response of [await contents(request({ backupId: folders[2] })), await restore(request({ backupId: folders[2], restoreType: 'full' }))]) {
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'IncompleteInventory', error: expect.stringContaining('Remove or recover the reported files') })
  }
  expect(vi.mocked(fetch).mock.calls.some(([input, init]) => new Request(input, init).method === 'POST' && new URL(new Request(input, init).url).hostname === 'graph.microsoft.com')).toBe(false)
})

it('preserves newline-containing damaged filenames in history diagnostics', async () => {
  const { dir } = await setup()
  const file = 'conflict\ncopy.tvb'
  writeFileSync(join(dir, file), 'TVB1')
  const history = await listBackups(request())
  expect(history.status).toBe(200)
  expect(await history.json()).toMatchObject({ damagedFiles: [{ file, reason: 'Truncated backup header', ownershipUnknown: true }], completenessUnknown: true, retentionPaused: true })
})
