import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as fileSystem from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalBlobStore } from '../src/main/storage/local-blob-store'
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
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
