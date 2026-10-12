import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as fileSystem from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { IncompleteInventoryError, LocalBlobStore } from '../src/main/storage/local-blob-store'
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat), rename: vi.fn(actual.rename) }
})
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('retains the decrypted index across sequential and concurrent prefix listings and notices external replacements', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-index-cache-')); roots.push(root)
  const keys = [randomBytes(32)]
  const store = new LocalBlobStore(root, keys)
  await store.createContainer('account', 'intune-backups')
  const put = (target: LocalBlobStore, name: string, value: string) => target.put('account', 'intune-backups', name, Buffer.from(value), 'application/json')
  await put(store, 'backup-one/Policies/A.json', '{}')
  await put(store, 'backup-two/Policies/B.json', '{}')
  await put(store, 'backup-one/metadata.json', '{"Items":{"Policies/a":{"file":"A.json"}}}')
  await store.list('account', 'intune-backups')
  const readIndex = vi.spyOn(store as unknown as { readIndex: () => Promise<unknown> }, 'readIndex')
  for (let tick = 0; tick < 3; tick++) expect((await store.list('account', 'intune-backups', 'backup-one/')).map(blob => blob.name)).toEqual(['backup-one/Policies/A.json', 'backup-one/metadata.json'])
  await Promise.all(Array.from({ length: 20 }, () => store.list('account', 'intune-backups', 'backup-two/')))
  expect(readIndex).not.toHaveBeenCalled()
  await put(new LocalBlobStore(root, keys), 'backup-two/Policies/B.json', '{"changed":true}')
  expect((await store.list('account', 'intune-backups', 'backup-two/'))[0]?.size).toBe(16)
  expect(readIndex).toHaveBeenCalledTimes(1)
  await store.delete('account', 'intune-backups', 'backup-two/Policies/B.json')
  expect(await store.list('account', 'intune-backups', 'backup-two/')).toEqual([])
  expect(readIndex).toHaveBeenCalledTimes(2)
})

it('checks only the selected file after warming a large inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-selective-cache-')); roots.push(root)
  const store = new LocalBlobStore(root, [randomBytes(32)])
  await store.createContainer('account', 'intune-backups')
  for (let number = 0; number < 40; number++) await store.put('account', 'intune-backups', `backup-one/Policies/${number}.json`, Buffer.from('{}'), 'application/json')
  await store.list('account', 'intune-backups')
  const stat = vi.mocked(fileSystem.stat)
  stat.mockClear()
  expect((await store.get('account', 'intune-backups', 'backup-one/Policies/0.json')).data.toString()).toBe('{}')
  expect(stat.mock.calls).toHaveLength(2)
})


it('keeps a put visible when publication finishes during an inventory rebuild', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-index-race-')); roots.push(root)
  const store = new LocalBlobStore(root, [randomBytes(32)])
  await store.createContainer('account', 'intune-backups')
  await store.list('account', 'intune-backups')
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }
  const publicationReady = deferred(), publish = deferred(), inventoryReady = deferred(), finishInventory = deferred()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fileSystem.rename).mockImplementationOnce(async (...args) => {
    publicationReady.resolve()
    await publish.promise
    return actual.rename(...args)
  })
  const pendingPut = store.put('account', 'intune-backups', 'backup-new/Policies/New.json', Buffer.from('{}'), 'application/json')
  await publicationReady.promise
  const internal = store as unknown as { readIndex: (...args: string[]) => Promise<Map<string, unknown>> }
  const read = internal.readIndex.bind(store)
  vi.spyOn(internal, 'readIndex').mockImplementationOnce(async (...args) => {
    const entries = await read(...args) // readdir has run while the new blob is still temporary.
    inventoryReady.resolve()
    await finishInventory.promise
    return entries
  })
  const pendingList = store.list('account', 'intune-backups')
  await inventoryReady.promise
  publish.resolve()
  await pendingPut
  finishInventory.resolve()
  await pendingList
  expect((await store.list('account', 'intune-backups')).map(blob => blob.name)).toEqual(['backup-new/Policies/New.json'])
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function freezeDirectoryStamp(store: LocalBlobStore) {
  vi.spyOn(store as unknown as { directoryStamp: (dir: string) => Promise<string> }, 'directoryStamp').mockResolvedValue('coarse-directory-stamp')
}

it('reconciles external additions and removals with an unchanged directory stamp while reusing unchanged headers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-coarse-index-')); roots.push(root)
  const keys = [randomBytes(32)]
  const store = new LocalBlobStore(root, keys)
  const other = new LocalBlobStore(root, keys)
  await store.createContainer('account', 'intune-backups')
  await store.put('account', 'intune-backups', 'backup-one/Policies/A.json', Buffer.from('{}'), 'application/json')
  freezeDirectoryStamp(store)
  await store.list('account', 'intune-backups')
  const decrypt = vi.spyOn(store as unknown as { decrypt: (...args: unknown[]) => Buffer }, 'decrypt')
  await other.put('account', 'intune-backups', 'backup-two/Policies/B.json', Buffer.from('{"new":true}'), 'application/json')
  expect((await store.list('account', 'intune-backups')).map(blob => blob.name)).toEqual(['backup-one/Policies/A.json', 'backup-two/Policies/B.json'])
  expect(decrypt).toHaveBeenCalledTimes(1)
  await other.delete('account', 'intune-backups', 'backup-one/Policies/A.json')
  expect((await store.list('account', 'intune-backups')).map(blob => blob.name)).toEqual(['backup-two/Policies/B.json'])
  expect(decrypt).toHaveBeenCalledTimes(1)
})

it('rejects an external duplicate with an unchanged directory stamp on the next listing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-coarse-duplicate-')); roots.push(root)
  const store = new LocalBlobStore(root, [randomBytes(32)], 1)
  await store.createContainer('account', 'intune-backups')
  await store.put('account', 'intune-backups', 'backup-one/Policies/A.json', Buffer.from('{}'), 'application/json')
  freezeDirectoryStamp(store)
  await store.list('account', 'intune-backups')
  const dir = join(root, 'account', 'intune-backups')
  const file = readdirSync(dir)[0]!
  // TVB1 permits another file name, so both headers authenticate as the same blob.
  const duplicate = `${file === '0'.repeat(40) + '.tvb' ? '1'.repeat(40) : '0'.repeat(40)}.tvb`
  copyFileSync(join(dir, file), join(dir, duplicate))
  await expect(store.list('account', 'intune-backups')).rejects.toBeInstanceOf(IncompleteInventoryError)
})

async function pausedInventoryCheck() {
  const root = mkdtempSync(join(tmpdir(), 'tv-paused-index-')); roots.push(root)
  const keys = [randomBytes(32)]
  const store = new LocalBlobStore(root, keys)
  const other = new LocalBlobStore(root, keys)
  const account = 'account', container = 'intune-backups'
  const a = 'backup-one/Policies/A.json', b = 'backup-one/Policies/B.json'
  await store.createContainer(account, container)
  await store.put(account, container, a, Buffer.from('{}'), 'application/json')
  await store.put(account, container, b, Buffer.from('{}'), 'application/json')
  freezeDirectoryStamp(store)
  await store.list(account, container)
  await other.list(account, container)
  const internal = store as unknown as { entries: (...args: string[]) => Promise<Map<string, { file: string }>> }
  const entries = await internal.entries(account, container)
  const aPath = join(root, account, container, entries.get(a)!.file)
  const bPath = join(root, account, container, entries.get(b)!.file)
  const aChecked = deferred(), ready = deferred(), release = deferred()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let pause = true
  vi.mocked(fileSystem.stat).mockImplementation(async (...args) => {
    const info = await actual.stat(...args)
    if (String(args[0]) === aPath) aChecked.resolve()
    if (String(args[0]) === bPath && pause) {
      pause = false
      ready.resolve()
      await release.promise
    }
    return info
  })
  const pendingList = store.list(account, container)
  await Promise.all([aChecked.promise, ready.promise])
  return { store, other, account, container, a, pendingList, release }
}

it('refreshes size and ETag after get invalidates a paused check that already inspected the replaced file', async () => {
  const { store, other, account, container, a, pendingList, release } = await pausedInventoryCheck()
  const replacement = await other.put(account, container, a, Buffer.from('{"replacement":true}'), 'application/json')
  const requested = deferred()
  const internal = store as unknown as { checkedEntries: (...args: string[]) => Promise<unknown> }
  const check = internal.checkedEntries.bind(store)
  vi.spyOn(internal, 'checkedEntries').mockImplementation((...args) => {
    const result = check(...args)
    requested.resolve()
    return result
  })
  const pendingGet = store.get(account, container, a)
  await requested.promise
  try {
    const { blob, data } = await pendingGet
    expect(data.toString()).toBe('{"replacement":true}')
    expect(blob).toMatchObject({ size: replacement.size, etag: replacement.etag })
  } finally {
    release.resolve()
    await pendingList
  }
})

it.each(['addition', 'replacement'])('starts a fresh listing check after an external %s while an earlier check is paused', async (publication) => {
  const { store, other, account, container, a, pendingList, release } = await pausedInventoryCheck()
  const name = publication === 'addition' ? 'backup-two/Policies/C.json' : a
  const published = await other.put(account, container, name, Buffer.from('{"published":true}'), 'application/json')
  const pendingNextList = store.list(account, container)
  release.resolve()
  expect(await pendingNextList).toContainEqual(expect.objectContaining({ name, size: published.size, etag: published.etag }))
  await pendingList
})


it.each([[1, false], [8, false], [1, true], [8, true]] as const)('rebuilds once after 64 own puts with %s concurrent writes and one listing (existing backup=%s)', async (concurrency, existing) => {
  const root = mkdtempSync(join(tmpdir(), 'tv-write-index-')); roots.push(root)
  const store = new LocalBlobStore(root, [randomBytes(32)])
  await store.createContainer('account', 'intune-backups')
  if (existing) {
    await store.put('account', 'intune-backups', 'backup-earlier/Policies/Old.json', Buffer.from('{}'), 'application/json')
    await store.put('account', 'intune-backups', 'backup-earlier/metadata.json', Buffer.from('{"Items":{"Policies/old":{"file":"Old.json"}}}'), 'application/json')
    await store.list('account', 'intune-backups')
  }
  const readIndex = vi.spyOn(store as unknown as { readIndex: () => Promise<unknown> }, 'readIndex')
  const items: Record<string, { file: string }> = {}
  for (let offset = 0; offset < 64; offset += concurrency) {
    await Promise.all(Array.from({ length: concurrency }, (_, index) => {
      const number = offset + index
      items[`Policies/${number}`] = { file: `${number}.json` }
      return store.put('account', 'intune-backups', `backup-one/Policies/${number}.json`, Buffer.from('{}'), 'application/json')
    }))
  }
  await store.put('account', 'intune-backups', 'backup-one/metadata.json', Buffer.from(JSON.stringify({ Items: items })), 'application/json')
  expect(readIndex).not.toHaveBeenCalled()
  expect(await store.list('account', 'intune-backups')).toHaveLength(existing ? 67 : 65)
  expect(readIndex).toHaveBeenCalledTimes(1)
})

it.each(['addition', 'removal', 'replacement'])('reconciles an external %s during an own write before the next listing', async publication => {
  const root = mkdtempSync(join(tmpdir(), 'tv-write-reconcile-')); roots.push(root)
  const keys = [randomBytes(32)]
  const store = new LocalBlobStore(root, keys)
  const other = new LocalBlobStore(root, keys)
  const account = 'account', container = 'intune-backups'
  const externalName = 'backup-one/Policies/External.json'
  const ownName = 'backup-one/Policies/Own.json'
  await store.createContainer(account, container)
  await store.put(account, container, externalName, Buffer.from('{}'), 'application/json')
  freezeDirectoryStamp(store)
  await store.list(account, container)
  await other.list(account, container)
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const newName = publication === 'addition' ? 'backup-two/Policies/New.json' : externalName
  let published: { size: number; etag?: string } | undefined
  vi.mocked(fileSystem.rename).mockImplementationOnce(async (...args) => {
    await actual.rename(...args)
    if (publication === 'removal') await other.delete(account, container, externalName)
    else published = await other.put(account, container, newName, Buffer.from('{"external":true}'), 'application/json')
  })
  await store.put(account, container, ownName, Buffer.from('{}'), 'application/json')
  const listed = await store.list(account, container)
  expect(listed).toContainEqual(expect.objectContaining({ name: ownName }))
  if (publication === 'removal') expect(listed.some(blob => blob.name === externalName)).toBe(false)
  else expect(listed).toContainEqual(expect.objectContaining({ name: newName, size: published!.size, etag: published!.etag }))
})


it('updates the cached inventory across own deletes and still rejects a missing manifest item', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-delete-index-')); roots.push(root)
  const store = new LocalBlobStore(root, [randomBytes(32)])
  const account = 'account', container = 'intune-backups'
  const manifest = 'backup-one/metadata.json'
  await store.createContainer(account, container)
  for (let number = 0; number < 8; number++) await store.put(account, container, `backup-one/Policies/${number}.json`, Buffer.from('{}'), 'application/json')
  await store.put(account, container, manifest, Buffer.from('{"Items":{"Policies/0":{"file":"0.json"}}}'), 'application/json')
  await store.list(account, container)
  const readIndex = vi.spyOn(store as unknown as { readIndex: () => Promise<unknown> }, 'readIndex')
  for (let number = 1; number < 8; number++) await store.delete(account, container, `backup-one/Policies/${number}.json`)
  expect(readIndex).not.toHaveBeenCalled()
  expect(await store.list(account, container)).toHaveLength(2)
  expect(readIndex).toHaveBeenCalledTimes(1)
  await store.delete(account, container, 'backup-one/Policies/0.json')
  await expect(store.get(account, container, manifest)).rejects.toThrow('manifest are missing')
  await expect(store.list(account, container)).rejects.toThrow('manifest are missing')
})
