import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TenantRecords, RECORD_RETENTION } from '../src/main/features/records'
import { DOMAINS } from '../src/main/features/domains'
import { SecureStore, type Cipher } from '../src/main/storage/secure-store'
import { memoryStore } from './helpers'
import { TENANT_A, TENANT_B } from './feature-helpers'
const meta = { actor: null, reason: 'Test record' }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('defines retention for every domain and prunes only the oldest records of the written tenant and domain', () => {
  expect(Object.keys(RECORD_RETENTION).sort()).toEqual(Object.values(DOMAINS).sort())
  const store = memoryStore()
  let clock = new Date('2026-01-01T00:00:00Z')
  const records = new TenantRecords(store, () => clock)
  const other = records.create(DOMAINS.scoreSnapshots, TENANT_B, { number: -1 }, meta)
  const anotherDomain = records.create(DOMAINS.promotions, TENANT_A, { number: -2 }, meta)
  const oldest = records.create(DOMAINS.scoreSnapshots, TENANT_A, { number: 0 }, meta)
  records.batch(() => {
    for (let number = 1; number < RECORD_RETENTION[DOMAINS.scoreSnapshots]!; number++) {
      clock = new Date(clock.getTime() + 1000)
      records.create(DOMAINS.scoreSnapshots, TENANT_A, { number }, meta)
    }
  })
  clock = new Date(clock.getTime() + 1000)
  records.update<{ number: number }>(DOMAINS.scoreSnapshots, TENANT_A, oldest.id, value => value, meta)
  clock = new Date(clock.getTime() + 1000)
  records.create(DOMAINS.scoreSnapshots, TENANT_A, { number: 365 }, meta)
  const kept = records.list<{ number: number }>(DOMAINS.scoreSnapshots, TENANT_A)
  expect(kept).toHaveLength(365)
  expect(kept.map(record => record.number)).not.toContain(1)
  expect(records.get(DOMAINS.scoreSnapshots, TENANT_A, oldest.id)?.history).toHaveLength(2)
  expect(records.get(DOMAINS.scoreSnapshots, TENANT_B, other.id)).toEqual(other)
  expect(records.get(DOMAINS.promotions, TENANT_A, anotherDomain.id)).toEqual(anotherDomain)
})

it('prunes existing over-limit domains on update and uses insertion order for tied timestamps', () => {
  const store = memoryStore()
  const records = new TenantRecords(store, () => new Date('2026-01-01'))
  const first = records.create(DOMAINS.scoreSnapshots, TENANT_A, { number: 0 }, meta)
  const raw = Array.from({ length: 370 }, (_, number) => ({ ...first, id: String(number), number }))
  store.set(`records.v1.${DOMAINS.scoreSnapshots}.${TENANT_A}`, JSON.stringify(raw))
  records.update<{ number: number }>(DOMAINS.scoreSnapshots, TENANT_A, '369', value => value, meta)
  expect(records.list<{ number: number }>(DOMAINS.scoreSnapshots, TENANT_A).map(record => record.number)).toEqual(Array.from({ length: 365 }, (_, number) => number + 5))
})

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
