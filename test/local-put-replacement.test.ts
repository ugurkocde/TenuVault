import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import * as fileSystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalBlobStore } from '../src/main/storage/local-blob-store'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it.each(['external', 'concurrent'] as const)('keeps listing metadata consistent with the stored body after %s replacement between publication and stat', async writer => {
  const root = mkdtempSync(join(tmpdir(), 'tv-put-replacement-')); roots.push(root)
  const keys = [randomBytes(32)]
  const store = new LocalBlobStore(root, keys)
  const other = writer === 'external' ? new LocalBlobStore(root, keys) : store
  const account = 'account', container = 'intune-backups', name = 'backup-one/Policies/A.json'
  await store.createContainer(account, container)
  await store.list(account, container)
  const published = deferred(), replaced = deferred()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fileSystem.rename).mockImplementationOnce(async (...args) => {
    await actual.rename(...args)
    published.resolve()
    await replaced.promise
  })
  const firstBody = Buffer.from('{}')
  const first = store.put(account, container, name, firstBody, 'application/json', false, { writer: 'first' })
  await published.promise
  const replacementBody = Buffer.from('{"replacement":true,"items":[1,2,3]}')
  const metadata = { writer: 'replacement', revision: '2' }
  try {
    await other.put(account, container, name, replacementBody, 'application/json', false, metadata)
  } finally {
    replaced.resolve()
  }
  const written = await first
  const fresh = await new LocalBlobStore(root, keys).get(account, container, name)
  expect(fresh.data).toEqual(replacementBody)
  expect(fresh.blob).toMatchObject({ size: replacementBody.byteLength, metadata, etag: expect.any(String) })
  for (let read = 0; read < 2; read++) expect(await store.list(account, container)).toEqual([fresh.blob])
  expect(await store.get(account, container, name)).toEqual(fresh)
  expect(written).toMatchObject({ size: firstBody.byteLength, metadata: { writer: 'first' } })
  expect(written.etag).not.toBe(fresh.blob.etag)
})

it.each(['external', 'concurrent'] as const)('keeps the legacy physical filename for an immediate overwrite after %s replacement is detected', async writer => {
  const root = mkdtempSync(join(tmpdir(), 'tv-legacy-put-replacement-')); roots.push(root)
  const keys = [randomBytes(32)]
  const legacy = new LocalBlobStore(root, keys, 1)
  const store = new LocalBlobStore(root, keys)
  const other = writer === 'external' ? new LocalBlobStore(root, keys) : store
  const account = 'account', container = 'intune-backups', name = 'backup-one/Policies/A.json'
  await legacy.createContainer(account, container)
  const original = await legacy.put(account, container, name, Buffer.from('{"legacy":true}'), 'application/json')
  const dir = join(root, account, container)
  const legacyFile = readdirSync(dir)[0]!
  expect(readFileSync(join(dir, legacyFile)).subarray(0, 4).toString()).toBe('TVB1')
  await store.list(account, container)
  const readIndex = vi.spyOn(store as unknown as { readIndex: () => Promise<unknown> }, 'readIndex')
  const published = deferred(), replaced = deferred()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fileSystem.rename).mockImplementationOnce(async (...args) => {
    await actual.rename(...args)
    published.resolve()
    await replaced.promise
  })
  const first = store.put(account, container, name, Buffer.from('{}'), 'application/json', false, { writer: 'first' })
  await published.promise
  let replacement: Awaited<ReturnType<LocalBlobStore['put']>>
  try {
    replacement = await other.put(account, container, name, Buffer.from('{"replacement":true}'), 'application/json', false, { writer: 'replacement' })
  } finally {
    replaced.resolve()
  }
  const written = await first
  expect(written.etag).not.toBe(replacement.etag)
  // No listing or get may repair the cache before this next mutation.
  const finalBody = Buffer.from('{"final":true,"items":[1,2,3]}')
  const latest = await store.put(account, container, name, finalBody, 'application/json', false, { writer: 'final' })
  expect(readIndex).not.toHaveBeenCalled()
  expect(await store.list(account, container)).toEqual([latest])
  expect(readdirSync(dir)).toEqual([legacyFile])
  expect(readFileSync(join(dir, legacyFile)).subarray(0, 4).toString()).toBe('TVB2')
  expect(latest.created).toEqual(original.created)
  expect(await store.get(account, container, name)).toEqual({ blob: latest, data: finalBody })
})
