import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TenantRecords } from '../src/main/features/records'
import { DOMAINS } from '../src/main/features/domains'
import { SecureStore, type Cipher } from '../src/main/storage/secure-store'
import { TENANT_A } from './feature-helpers'
const meta = { actor: null, reason: 'Test record' }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('persists a 300-finding batch across domains with one encryption and no delayed writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-record-batch-')); roots.push(root)
  const path = join(root, 'workspace.bin')
  const cipher: Cipher = { encrypt: vi.fn(text => Buffer.from(text).reverse()), decrypt: bytes => Buffer.from(bytes).reverse().toString() }
  const store = new SecureStore(path, cipher)
  const records = new TenantRecords(store)
  records.batch(() => {
    records.create(DOMAINS.healthReviews, TENANT_A, { kind: 'run' }, meta)
    for (let number = 0; number < 300; number++) records.create(DOMAINS.healthFindings, TENANT_A, { number }, meta)
    expect(records.list(DOMAINS.healthFindings, TENANT_A)).toHaveLength(300)
  })
  expect(cipher.encrypt).toHaveBeenCalledTimes(1)
  const fresh = new TenantRecords(new SecureStore(path, cipher))
  expect(fresh.list(DOMAINS.healthFindings, TENANT_A)).toHaveLength(300)
  expect(fresh.list(DOMAINS.healthReviews, TENANT_A)).toHaveLength(1)
  const original = readFileSync(path)
  expect(() => records.batch(() => { records.create(DOMAINS.healthFindings, TENANT_A, { number: 301 }, meta); throw new Error('failed scan') })).toThrow('failed scan')
  expect(readFileSync(path)).toEqual(original)
  vi.mocked(cipher.encrypt).mockImplementationOnce(() => { throw new Error('encryption unavailable') })
  expect(() => records.batch(() => records.create(DOMAINS.healthFindings, TENANT_A, { number: 302 }, meta))).toThrow('encryption unavailable')
  expect(readFileSync(path)).toEqual(original)
  expect(records.list(DOMAINS.healthFindings, TENANT_A)).toHaveLength(300)
})

it('refuses a multi-key batch before writing when the store has no atomic setMany', () => {
  const values = new Map<string, string>()
  const store = { get: (key: string) => values.get(key) ?? null, set: vi.fn((key: string, value: string) => { values.set(key, value) }), delete: (key: string) => { values.delete(key) } }
  const records = new TenantRecords(store)
  expect(() => records.batch(() => {
    records.create(DOMAINS.healthReviews, TENANT_A, { kind: 'run' }, meta)
    records.create(DOMAINS.healthFindings, TENANT_A, { number: 1 }, meta)
  })).toThrow('batch was not saved')
  expect(store.set).not.toHaveBeenCalled()
  expect(values.size).toBe(0)
  records.batch(() => records.create(DOMAINS.healthFindings, TENANT_A, { number: 2 }, meta))
  expect(store.set).toHaveBeenCalledTimes(1)
})
