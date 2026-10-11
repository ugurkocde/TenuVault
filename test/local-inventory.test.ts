import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { BlobAlreadyExistsError, IncompleteInventoryError, LocalBlobStore } from '../src/main/storage/local-blob-store'
import { handleLocalBlobRequest } from '../src/main/storage/blob-emulator'
import { NextRequest } from '../src/main/api/next-server-shim'
import { POST as listBackups } from '../src/portal/app/api/list-backups/route'
import { POST as listContents } from '../src/portal/app/api/list-backup-contents/route'
import { STATUS_LABEL, statusKind } from '../src/portal/components/backup/types'
const account = 'tvlocal-test'
const container = 'intune-backups'
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tv-inventory-')); roots.push(root)
  const key = randomBytes(32)
  const store = new LocalBlobStore(root, [key])
  await store.createContainer(account, container)
  await store.put(account, container, 'backup-test/Policies/one.json', Buffer.from('{}'), 'application/json')
  return { root, key, store, dir: join(root, account, container) }
}
it('reports wrong keys alongside the healthy inventory through the blob API', async () => {
  const { root, dir } = await setup()
  const response = await handleLocalBlobRequest(new LocalBlobStore(root, [randomBytes(32)]), new Request(`https://${account}.blob.core.windows.net/${container}?restype=container&comp=list&delimiter=/`))
  expect(response.status).toBe(200)
  const xml = await response.text()
  expect(xml).toContain('<Blobs></Blobs>')
  expect(xml).toContain(`<File>${readdirSync(dir)[0]}</File>`)
  expect(xml).toContain('Import its recovery key')
})
it.each(['truncated header', 'invalid header', 'unreadable file'])('keeps healthy blobs usable alongside a %s and reports its filename', async (damage) => {
  const { store, dir } = await setup()
  const file = 'damaged.tvb'
  if (damage === 'unreadable file') mkdirSync(join(dir, file))
  else writeFileSync(join(dir, file), damage === 'invalid header' ? 'invalid header' : 'TVB1')
  expect((await store.list(account, container)).map(blob => blob.name)).toEqual(['backup-test/Policies/one.json'])
  expect((await store.get(account, container, 'backup-test/Policies/one.json')).data.toString()).toBe('{}')
  await store.put(account, container, 'backup-test/Policies/two.json', Buffer.from('{"two":true}'), 'application/json')
  expect((await store.list(account, container)).map(blob => blob.name)).toEqual(['backup-test/Policies/one.json', 'backup-test/Policies/two.json'])
  expect((await store.inventory(account, container)).damagedFiles).toEqual([{ file, name: undefined, reason: expect.any(String) }])
  await expect(store.delete(account, container, 'backup-test/Policies/two.json')).rejects.toBeInstanceOf(IncompleteInventoryError)
  expect(await store.list(account, container)).toHaveLength(2)
  expect(readdirSync(dir)).toContain(file)
})
it('excludes corrupt headers even after warming the inventory cache', async () => {
  const { store, dir } = await setup()
  expect(await store.list(account, container)).toHaveLength(1)
  writeFileSync(join(dir, readdirSync(dir)[0]!), 'corrupt')
  await expect(store.get(account, container, 'backup-test/Policies/one.json')).rejects.toBeInstanceOf(IncompleteInventoryError)
  expect(await store.list(account, container)).toEqual([])
  expect((await store.inventory(account, container)).damagedFiles[0]?.reason).toBe('Invalid backup header')
})
it.each(['truncated', 'tampered'])('excludes a %s body without blocking healthy sibling blobs', async (damage) => {
  const { store, dir } = await setup()
  const file = readdirSync(dir)[0]!
  await store.put(account, container, 'backup-test/Policies/two.json', Buffer.from('{}'), 'application/json')
  const bytes = readFileSync(join(dir, file))
  if (damage === 'tampered') bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
  writeFileSync(join(dir, file), damage === 'truncated' ? bytes.subarray(0, 6 + bytes.readUInt16BE(4) + 10) : bytes)
  expect((await store.list(account, container)).map(blob => blob.name)).toEqual(['backup-test/Policies/two.json'])
  expect((await store.get(account, container, 'backup-test/Policies/two.json')).data.toString()).toBe('{}')
  expect((await store.inventory(account, container)).damagedFiles).toEqual([{ file, name: 'backup-test/Policies/one.json', reason: expect.stringMatching(/body/) }])
})
it.each(['missing', 'damaged', 'tampered', 'duplicate'])('blocks reads of the affected backup when a manifest-listed file is %s', async (damage) => {
  const { store, root, key, dir } = await setup()
  const policyFile = readdirSync(dir)[0]!
  await store.put(account, container, 'backup-test/metadata.json', Buffer.from(JSON.stringify({ Items: { 'Policies/id': { file: 'one.json', hash: 'hash' } } })), 'application/json')
  await store.put(account, container, 'backup-healthy/metadata.json', Buffer.from('{}'), 'application/json')
  expect(await store.list(account, container)).toHaveLength(3)
  if (damage === 'missing') rmSync(join(dir, policyFile))
  else if (damage === 'duplicate') copyFileSync(join(dir, policyFile), join(dir, 'conflict.tvb'))
  else {
    const bytes = readFileSync(join(dir, policyFile))
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    writeFileSync(join(dir, policyFile), damage === 'damaged' ? bytes.subarray(0, 4) : bytes)
  }
  await expect(store.get(account, container, 'backup-test/metadata.json')).rejects.toThrow('manifest are missing or damaged')
  const fresh = new LocalBlobStore(root, [key])
  await expect(fresh.get(account, container, 'backup-test/metadata.json')).rejects.toThrow('manifest are missing or damaged')
  await expect(fresh.get(account, container, 'backup-test/Policies/one.json')).rejects.toThrow('manifest are missing or damaged')
  expect((await store.list(account, container)).map(blob => blob.name)).toEqual(['backup-healthy/metadata.json', 'backup-test/metadata.json'])
  expect((await store.get(account, container, 'backup-healthy/metadata.json')).data.toString()).toBe('{}')
  await store.put(account, container, 'backup-new/metadata.json', Buffer.from('{}'), 'application/json')
  await expect(store.delete(account, container, 'backup-healthy/metadata.json')).rejects.toBeInstanceOf(IncompleteInventoryError)
  await expect(store.delete(account, container, 'backup-test/metadata.json')).rejects.toBeInstanceOf(IncompleteInventoryError)
  const blocked = await handleLocalBlobRequest(store, new Request(`https://${account}.blob.core.windows.net/${container}?restype=container&comp=list&prefix=backup-test/`))
  expect(blocked.status).toBe(500)
  expect(blocked.headers.get('x-ms-error-code')).toBe('IncompleteInventory')
})
it('refuses a direct delete beside new damage despite a warm cache, then succeeds after recovery', async () => {
  const { store, dir } = await setup()
  const name = 'backup-test/Policies/one.json'
  const file = readdirSync(dir)[0]!
  const original = readFileSync(join(dir, file))
  expect(await store.list(account, container)).toHaveLength(1)
  writeFileSync(join(dir, 'damaged.tvb'), 'TVB1')
  await expect(store.delete(account, container, name)).rejects.toThrow('Cannot delete local backup files while the container has damaged files or unavailable backups')
  expect(readFileSync(join(dir, file))).toEqual(original)
  const response = await handleLocalBlobRequest(store, new Request(`https://${account}.blob.core.windows.net/${container}/${name}`, { method: 'DELETE' }))
  expect(response.status).toBe(500)
  expect(response.headers.get('x-ms-error-code')).toBe('IncompleteInventory')
  expect(await response.text()).toContain('Cannot delete local backup files')
  rmSync(join(dir, 'damaged.tvb'))
  await store.delete(account, container, name)
  expect(readdirSync(dir)).toEqual([])
})
it.each(['target changed', 'target replaced', 'new damage', 'sibling changed'])('refuses deletion when %s after the fresh scan', async (change) => {
  const { store, dir } = await setup()
  const file = readdirSync(dir)[0]!
  await store.put(account, container, 'backup-test/Policies/two.json', Buffer.from('{}'), 'application/json')
  const sibling = readdirSync(dir).find(candidate => candidate !== file)!
  const internal = store as unknown as { readIndex: (dir: string, account: string, container: string) => Promise<unknown> }
  const readIndex = internal.readIndex.bind(store)
  vi.spyOn(internal, 'readIndex').mockImplementationOnce(async (...args) => {
    const inventory = await readIndex(...args)
    if (change === 'target replaced') {
      copyFileSync(join(dir, file), join(dir, 'replacement.tmp'))
      renameSync(join(dir, 'replacement.tmp'), join(dir, file))
    } else writeFileSync(join(dir, change === 'target changed' ? file : change === 'sibling changed' ? sibling : 'damaged.tvb'), 'TVB1')
    return inventory
  })
  await expect(store.delete(account, container, 'backup-test/Policies/one.json')).rejects.toThrow('files changed during the fresh inventory check')
  expect(readdirSync(dir)).toContain(file)
  expect(readdirSync(dir)).toContain(sibling)
})
it('does not share an in-flight listing scan for deletion', async () => {
  const { store, dir } = await setup()
  const internal = store as unknown as { readIndex: (dir: string, account: string, container: string) => Promise<unknown> }
  const readIndex = internal.readIndex.bind(store)
  let scanned!: () => void
  const ready = new Promise<void>(resolve => { scanned = resolve })
  let resume!: () => void
  const held = new Promise<void>(resolve => { resume = resolve })
  const scans = vi.spyOn(internal, 'readIndex').mockImplementationOnce(async (...args) => {
    const inventory = await readIndex(...args)
    scanned()
    await held
    return inventory
  })
  const listing = store.list(account, container)
  try {
    await ready
    writeFileSync(join(dir, 'damaged.tvb'), 'TVB1')
    await expect(store.delete(account, container, 'backup-test/Policies/one.json')).rejects.toBeInstanceOf(IncompleteInventoryError)
    expect(scans).toHaveBeenCalledTimes(2)
    expect(readdirSync(dir)).toHaveLength(2)
  } finally {
    resume()
    await listing
  }
})
it('returns the inventory error when a manifest-listed header is damaged between the contents listing and metadata read', async () => {
  const { store, dir } = await setup()
  const before = new Set(readdirSync(dir))
  await store.put(account, container, 'backup-test/DeviceConfigurations/A.json', Buffer.from('{}'), 'application/json')
  const file = readdirSync(dir).find(candidate => !before.has(candidate))!
  await store.put(account, container, 'backup-test/metadata.json', Buffer.from(JSON.stringify({ Items: { 'DeviceConfigurations/id': { file: 'A.json' } } })), 'application/json')
  let injected = false
  let metadataBlocked = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    const response = await handleLocalBlobRequest(store, request)
    if (url.searchParams.get('comp') === 'list') {
      expect(response.status).toBe(200)
      expect(await response.clone().text()).toContain('backup-test/DeviceConfigurations/A.json')
      writeFileSync(join(dir, file), 'TVB1')
      injected = true
    } else if (url.pathname.endsWith('/metadata.json')) metadataBlocked = response.headers.get('x-ms-error-code') === 'IncompleteInventory'
    return response
  }))
  const response = await listContents(new NextRequest('http://tenuvault.internal/api/list-backup-contents', { method: 'POST', body: JSON.stringify({ tenantId: 'test', appId: 'app', clientSecret: 'test', storageAccountName: account, subscriptionId: 'local', resourceGroupName: 'local', backupId: 'backup-test' }) }))
  expect(injected).toBe(true)
  expect(metadataBlocked).toBe(true)
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ code: 'IncompleteInventory', error: expect.stringContaining('manifest are missing or damaged') })
})
it('shares one inventory reread between listings made together, and each still sees earlier changes', async () => {
  const { store, root, key } = await setup()
  const rereads = vi.spyOn(store as unknown as { readIndex: () => Promise<unknown> }, 'readIndex')
  const together = await Promise.all(Array.from({ length: 6 }, () => store.list(account, container)))
  expect(together.map(list => list.length)).toEqual([1, 1, 1, 1, 1, 1])
  expect(rereads).toHaveBeenCalledTimes(1)

  // A listing made while a reread runs waits for the next one, so it sees a file written meanwhile.
  const first = store.list(account, container)
  await new LocalBlobStore(root, [key]).put(account, container, 'backup-test/Policies/two.json', Buffer.from('{}'), 'application/json')
  expect(await store.list(account, container)).toHaveLength(2)
  await first
})
it.each([null, [], { 'Policies/id': {} }, { 'Policies/id': { file: '../one.json' } }])('blocks only the backup with an invalid authenticated manifest: %j', async (items) => {
  const { store } = await setup()
  await store.put(account, container, 'backup-test/metadata.json', Buffer.from(JSON.stringify({ Items: items })), 'application/json')
  await store.put(account, container, 'backup-healthy/metadata.json', Buffer.from('{}'), 'application/json')
  await expect(store.get(account, container, 'backup-test/Policies/one.json')).rejects.toThrow('Invalid backup inventory manifest')
  expect((await store.get(account, container, 'backup-healthy/metadata.json')).data.toString()).toBe('{}')
  expect(await store.list(account, container)).toHaveLength(3)
  await expect(store.delete(account, container, 'backup-test/metadata.json')).rejects.toThrow('Invalid backup inventory manifest')
  await expect(store.delete(account, container, 'backup-healthy/metadata.json')).rejects.toBeInstanceOf(IncompleteInventoryError)
})
it('excludes both duplicate files deterministically while other blobs still list', async () => {
  const { store, root, key, dir } = await setup()
  const file = readdirSync(dir)[0]!
  const duplicate = 'conflict.tvb'
  copyFileSync(join(dir, file), join(dir, duplicate))
  await store.put(account, container, 'backup-test/Policies/two.json', Buffer.from('{}'), 'application/json')
  expect((await store.list(account, container)).map(blob => blob.name)).toEqual(['backup-test/Policies/two.json'])
  const damaged = [{ file, name: 'backup-test/Policies/one.json', reason: 'Duplicate blob name' }, { file: duplicate, name: 'backup-test/Policies/one.json', reason: 'Duplicate blob name' }].sort((a, b) => a.file.localeCompare(b.file))
  expect((await store.inventory(account, container)).damagedFiles).toEqual(damaged)
  expect((await new LocalBlobStore(root, [key]).inventory(account, container)).damagedFiles).toEqual(damaged)
  await expect(store.put(account, container, 'backup-test/Policies/one.json', Buffer.from('replace'), 'application/json', true)).rejects.toBeInstanceOf(BlobAlreadyExistsError)
  await expect(new LocalBlobStore(root, [randomBytes(32), key]).put(account, container, 'backup-test/Policies/one.json', Buffer.from('replace'), 'application/json', true)).rejects.toBeInstanceOf(BlobAlreadyExistsError)
})
it('keeps create-only writes from replacing a damaged file encrypted with an older key', async () => {
  const { root, key, dir } = await setup()
  const file = readdirSync(dir)[0]!
  writeFileSync(join(dir, file), 'corrupt')
  const store = new LocalBlobStore(root, [randomBytes(32), key])
  await expect(store.put(account, container, 'backup-test/Policies/one.json', Buffer.from('replacement'), 'application/json', true)).rejects.toBeInstanceOf(BlobAlreadyExistsError)
  expect(readdirSync(dir)).toEqual([file])
  expect(readFileSync(join(dir, file)).toString()).toBe('corrupt')
})
it.each([false, true])('syncs a complete file before resolving put (createOnly=%s)', async (createOnly) => {
  const { store, root, key, dir } = await setup()
  const probe = await open(join(root, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  const original = prototype.sync
  const synced: string[] = []
  vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
    const directory = (await this.stat()).isDirectory()
    synced.push(directory ? 'directory' : 'file')
    expect(readdirSync(dir).filter(file => file.endsWith('.tvb'))).toHaveLength(directory ? 2 : 1)
    await original.call(this)
  })
  const data = randomBytes(256 * 1024)
  await store.put(account, container, 'backup-new/Policies/complete.json', data, 'application/json', createOnly)
  expect(synced).toEqual(process.platform === 'win32' ? ['file'] : ['file', 'directory'])
  expect((await new LocalBlobStore(root, [key]).get(account, container, 'backup-new/Policies/complete.json')).data).toEqual(data)
  expect(readdirSync(dir).every(file => file.endsWith('.tvb'))).toBe(true)
})
it('keeps the original blob and cleans up its temp file if syncing fails', async () => {
  const { store, root, key, dir } = await setup()
  const probe = await open(join(root, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  vi.spyOn(prototype, 'sync').mockRejectedValueOnce(new Error('sync failed'))
  await expect(store.put(account, container, 'backup-test/Policies/one.json', Buffer.from('replacement'), 'application/json')).rejects.toThrow('sync failed')
  expect((await new LocalBlobStore(root, [key]).get(account, container, 'backup-test/Policies/one.json')).data.toString()).toBe('{}')
  expect(readdirSync(dir)).toHaveLength(1)
})
it.each(['missing', 'damaged', 'duplicate', 'damaged metadata', 'damaged metadata header', 'damaged metadata only'])('lists only the affected backup as unavailable for %s files', async (damage) => {
  const { store, dir } = await setup()
  const affected = 'backup-2026-09-24-020000'
  const healthy = 'backup-2026-09-25-020000'
  const before = new Set(readdirSync(dir))
  await store.put(account, container, `${affected}/Policies/one.json`, Buffer.from('{}'), 'application/json')
  const policyFile = readdirSync(dir).find(file => !before.has(file))!
  const beforeMetadata = new Set(readdirSync(dir))
  await store.put(account, container, `${affected}/metadata.json`, Buffer.from(JSON.stringify({ Status: 'Success', Items: { 'Policies/id': { file: 'one.json' } } })), 'application/json')
  const metadataFile = readdirSync(dir).find(file => !beforeMetadata.has(file))!
  await store.put(account, container, `${healthy}/metadata.json`, Buffer.from('{"Status":"Success"}'), 'application/json')
  if (damage === 'missing') rmSync(join(dir, policyFile))
  else if (damage === 'duplicate') copyFileSync(join(dir, policyFile), join(dir, 'conflict.tvb'))
  else {
    const path = join(dir, damage.startsWith('damaged metadata') ? metadataFile : policyFile)
    const bytes = readFileSync(path)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    writeFileSync(path, damage === 'damaged metadata header' ? bytes.subarray(0, 4) : bytes)
    if (damage === 'damaged metadata only') rmSync(join(dir, policyFile))
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    return handleLocalBlobRequest(store, request)
  }))
  const response = await listBackups(new NextRequest('http://tenuvault.internal/api/list-backups', { method: 'POST', body: JSON.stringify({ tenantId: 'test', appId: 'app', clientSecret: 'test', storageAccountName: account, subscriptionId: 'local', resourceGroupName: 'local' }) }))
  expect(response.status).toBe(200)
  const { backups, damagedFiles, completenessUnknown, retentionPaused } = await response.json()
  expect(backups).toHaveLength(2)
  expect(backups[0]).toMatchObject({ id: healthy, status: damage === 'damaged metadata header' ? 'unavailable' : 'Success', changes: null })
  expect(completenessUnknown).toBe(damage === 'damaged metadata header')
  expect(retentionPaused).toBe(true)
  expect(backups[1]).toMatchObject({ id: affected, status: 'unavailable', error: expect.stringMatching(/missing|damaged|authenticated|encrypted/) })
  expect(STATUS_LABEL[statusKind(backups[1].status)]).toBe('Unavailable')
  if (damage !== 'missing') expect(damagedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ file: damage.startsWith('damaged metadata') ? metadataFile : policyFile })]))
})
