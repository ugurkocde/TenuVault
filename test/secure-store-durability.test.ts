import { fsyncSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SecureStore, type Cipher } from '../src/main/storage/secure-store'

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync) }
})

const roots: string[] = []
const cipher: Cipher = {
  encrypt: text => Buffer.from(text).reverse(),
  decrypt: bytes => Buffer.from(bytes).reverse().toString(),
}
afterEach(() => {
  vi.mocked(fsyncSync).mockRestore()
  vi.mocked(renameSync).mockClear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('syncs app state before rename and its directory afterwards, then reopens the complete keyring', () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-state-sync-')); roots.push(root)
  const path = join(root, 'state.bin')
  const value = JSON.stringify({ current: 'current-backup-key', previous: ['older-backup-key'] })
  new SecureStore(path, cipher).set('backup.keyring', value)
  const sync = vi.mocked(fsyncSync)
  const rename = vi.mocked(renameSync)
  expect(sync).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 2)
  expect(sync.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]!)
  if (process.platform !== 'win32') expect(sync.mock.invocationCallOrder[1]).toBeGreaterThan(rename.mock.invocationCallOrder[0]!)
  expect(new SecureStore(path, cipher).get('backup.keyring')).toBe(value)
  expect(readdirSync(root)).toEqual(['state.bin'])
})

it('preserves existing app state and removes the temp file when syncing fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-state-sync-')); roots.push(root)
  const path = join(root, 'state.bin')
  const store = new SecureStore(path, cipher)
  store.set('backup.keyring', 'original-keyring')
  const original = readFileSync(path)
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('sync failed') })
  expect(() => store.set('backup.keyring', 'replacement')).toThrow('sync failed')
  expect(readFileSync(path)).toEqual(original)
  expect(new SecureStore(path, cipher).get('backup.keyring')).toBe('original-keyring')
  expect(readdirSync(root)).toEqual(['state.bin'])
})
