import { expect, it, vi } from 'vitest'
import { MetadataCache, MAX_METADATA_CACHE_BYTES } from '../src/portal/lib/storage/metadata-cache'

it('enforces the 32 MiB budget for full manifests even with only two entries', async () => {
  const cache = new MetadataCache<{ Items: object }>(() => true)
  expect(MAX_METADATA_CACHE_BYTES).toBe(32 * 1024 * 1024)
  const manifest = { Items: { 'ConfigurationPolicies/id': { hash: 'hash', file: 'Policy.json', payload: 'x'.repeat(17 * 1024 * 1024) } } }
  const load = vi.fn(async () => manifest)
  await cache.read('first', 'v1', load)
  expect(cache.bytes).toBeGreaterThan(17 * 1024 * 1024)
  await cache.read('second', 'v1', load)
  expect(cache.bytes).toBeLessThanOrEqual(MAX_METADATA_CACHE_BYTES)
  await cache.read('second', 'v1', load)
  expect(load).toHaveBeenCalledTimes(2)
  await cache.read('first', 'v1', load)
  expect(load).toHaveBeenCalledTimes(3)
  expect(cache.bytes).toBeLessThanOrEqual(MAX_METADATA_CACHE_BYTES)
})

it('evicts by least recent use and replaces invalidated metadata within the byte budget', async () => {
  const cache = new MetadataCache<{ data: string }>(() => true, 1000)
  const load = vi.fn(async () => ({ data: 'x'.repeat(300) }))
  for (const key of ['one', 'two', 'three']) await cache.read(key, 'v1', load)
  await cache.read('one', 'v1', load)
  await cache.read('four', 'v1', load)
  await cache.read('one', 'v1', load)
  expect(load).toHaveBeenCalledTimes(4)
  await cache.read('two', 'v1', load)
  expect(load).toHaveBeenCalledTimes(5)
  await cache.read('one', 'v2', load)
  expect(load).toHaveBeenCalledTimes(6)
  expect(cache.bytes).toBeLessThanOrEqual(1000)
  await cache.read('huge', 'v1', async () => ({ data: 'x'.repeat(2000) }))
  expect(cache.bytes).toBeLessThanOrEqual(1000)
})

it('does not retain failures or resurrect an evicted in-flight load', async () => {
  const cache = new MetadataCache<{ ok: boolean; data?: string }>(value => value.ok, 1000)
  const unavailable = vi.fn(async () => ({ ok: false }))
  await cache.read('missing', 'v1', unavailable)
  await cache.read('missing', 'v1', unavailable)
  expect(unavailable).toHaveBeenCalledTimes(2)
  let resolve!: (value: { ok: boolean; data: string }) => void
  const pending = cache.read('one', 'v1', () => new Promise(done => { resolve = done }))
  await cache.read('one', 'v2', async () => ({ ok: true, data: 'x'.repeat(300) }))
  const bytes = cache.bytes
  resolve({ ok: true, data: 'x'.repeat(2000) })
  await pending
  expect(cache.bytes).toBe(bytes)
  await expect(cache.read('failed', 'v1', async () => { throw new Error('unavailable') })).rejects.toThrow('unavailable')
  expect(cache.bytes).toBe(bytes)
})
