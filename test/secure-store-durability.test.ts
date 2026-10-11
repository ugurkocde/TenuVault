import * as fs from 'node:fs'
import { fsyncSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SecureStore, type Cipher } from '../src/main/storage/secure-store'

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync) }
})

const originalOpenSync = fs.openSync
const roots: string[] = []
const cipher: Cipher = {
  encrypt: text => Buffer.from(text).reverse(),
  decrypt: bytes => Buffer.from(bytes).reverse().toString(),
}
afterEach(() => {
  vi.mocked(fsyncSync).mockRestore()
  vi.mocked(renameSync).mockClear()
  vi.restoreAllMocks()
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

it.each(['backup.keyring', 'new.key'])('preserves disk and cached app state when syncing %s fails', (key) => {
  const root = mkdtempSync(join(tmpdir(), 'tv-state-sync-')); roots.push(root)
  const path = join(root, 'state.bin')
  const store = new SecureStore(path, cipher)
  store.set('backup.keyring', 'original-keyring')
  const original = readFileSync(path)
  const previous = store.get(key)
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('sync failed') })
  expect(() => store.set(key, 'replacement')).toThrow('sync failed')
  expect(readFileSync(path)).toEqual(original)
  expect(store.get(key)).toBe(previous)
  expect(new SecureStore(path, cipher).get('backup.keyring')).toBe('original-keyring')
  expect(readdirSync(root)).toEqual(['state.bin'])
  store.set('license.key', 'saved-license')
  const fresh = new SecureStore(path, cipher)
  expect(fresh.get(key)).toBe(previous)
  expect(fresh.get('backup.keyring')).toBe('original-keyring')
  expect(fresh.get('license.key')).toBe('saved-license')
})

it.skipIf(process.platform === 'win32')('keeps published app state successful and warns once when directory sync fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-state-sync-')); roots.push(root)
  const path = join(root, 'state.bin')
  const store = new SecureStore(path, cipher)
  store.set('backup.keyring', 'original-keyring')
  const sync = vi.mocked(fsyncSync)
  const original = sync.getMockImplementation()!
  sync.mockClear()
  vi.mocked(renameSync).mockClear()
  sync.mockImplementationOnce(original).mockImplementationOnce(() => {
    throw Object.assign(new Error('directory sync failed'), { code: 'EIO' })
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(() => store.set('backup.keyring', 'replacement')).not.toThrow()
  expect(sync).toHaveBeenCalledTimes(2)
  expect(sync.mock.invocationCallOrder[1]).toBeGreaterThan(vi.mocked(renameSync).mock.invocationCallOrder[0]!)
  expect(store.get('backup.keyring')).toBe('replacement')
  expect(new SecureStore(path, cipher).get('backup.keyring')).toBe('replacement')
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(`Failed to sync directory ${root}: EIO`)
  expect(readdirSync(root)).toEqual(['state.bin'])
})

it('flushes deletions after opening an existing store', () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-state-sync-')); roots.push(root)
  const path = join(root, 'state.bin')
  const store = new SecureStore(path, cipher)
  store.set('backup.keyring', 'original-keyring')
  store.set('license.key', 'saved-license')
  const reopened = new SecureStore(path, cipher)
  reopened.open()
  reopened.delete('license.key')
  const fresh = new SecureStore(path, cipher)
  expect(fresh.get('backup.keyring')).toBe('original-keyring')
  expect(fresh.get('license.key')).toBeNull()
})

it('keeps a key in memory and on disk when the flush of its deletion fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-state-sync-')); roots.push(root)
  const path = join(root, 'state.bin')
  const store = new SecureStore(path, cipher)
  store.set('backup.keyring', 'original-keyring')
  store.set('license.key', 'saved-license')
  const original = readFileSync(path)
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('sync failed') })
  expect(() => store.delete('license.key')).toThrow('sync failed')
  expect(readFileSync(path)).toEqual(original)
  expect(store.get('license.key')).toBe('saved-license')
  store.set('other.key', 'later')
  const fresh = new SecureStore(path, cipher)
  expect(fresh.get('license.key')).toBe('saved-license')
  expect(fresh.get('other.key')).toBe('later')
  expect(readdirSync(root)).toEqual(['state.bin'])
})

it('syncs the parents of directories it creates before writing the first state file', () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-state-sync-')); roots.push(root)
  const path = join(root, 'nested', 'deeper', 'state.bin')
  const opened: string[] = []
  const open = vi.spyOn(fs, 'openSync').mockImplementation((...args) => { opened.push(String(args[0])); return originalOpenSync(...args) })
  new SecureStore(path, cipher).set('key', 'value')
  open.mockRestore()
  const sync = vi.mocked(fsyncSync)
  if (process.platform === 'win32') {
    expect(sync).toHaveBeenCalledTimes(1)
  } else {
    // Parents of the two new directories, then the file, then the file's directory.
    expect(sync).toHaveBeenCalledTimes(4)
    expect(opened.slice(0, 2)).toEqual([root, join(root, 'nested')])
    expect(sync.mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(renameSync).mock.invocationCallOrder[0]!)
  }
  expect(new SecureStore(path, cipher).get('key')).toBe('value')
})

it('still writes the state file when syncing a new directory parent fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-state-sync-')); roots.push(root)
  const path = join(root, 'nested', 'state.bin')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw Object.assign(new Error('sync failed'), { code: 'EIO' }) })
  new SecureStore(path, cipher).set('key', 'value')
  if (process.platform !== 'win32') expect(warn).toHaveBeenCalledWith(`Failed to sync directory ${root}: EIO`)
  expect(new SecureStore(path, cipher).get('key')).toBe('value')
})
