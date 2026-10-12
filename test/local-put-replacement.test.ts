import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
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
