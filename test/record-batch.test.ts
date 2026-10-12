import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TenantRecords } from '../src/main/features/records'
import { DOMAINS } from '../src/main/features/domains'
import { SecureStore, type Cipher } from '../src/main/storage/secure-store'
import { TENANT_A } from './feature-helpers'
import { memoryStore } from './helpers'
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

it.each(['callback', 'list', 'get'])('keeps evidence and history unchanged when an outer batch catches a failed inner %s mutation', (source) => {
  const store = memoryStore()
  const records = new TenantRecords(store, () => new Date('2026-10-12T12:00:00Z'))
  const domain = DOMAINS.healthFindings
  type Finding = { evidence: { details: { count: number } } }
  let id!: string
  let expected: unknown
  records.batch(() => {
    id = records.create<Finding>(domain, TENANT_A, { evidence: { details: { count: 1 } } }, meta).id
    records.update<Finding>(domain, TENANT_A, id, current => ({ ...current, evidence: { details: { count: 2 } } }), meta)
    expected = structuredClone(records.get<Finding>(domain, TENANT_A, id))
    expect(() => records.batch(() => {
      if (source === 'callback') {
        records.update<Finding>(domain, TENANT_A, id, current => {
          current.evidence.details.count = 99
          throw new Error('failed nested update')
        }, meta)
      } else {
        const current = source === 'list' ? records.list<Finding>(domain, TENANT_A)[0]! : records.get<Finding>(domain, TENANT_A, id)!
        current.evidence.details.count = 99
        current.history[0]!.snapshot.evidence!.details.count = 99
        throw new Error('failed nested update')
      }
    })).toThrow('failed nested update')
    expect(records.get(domain, TENANT_A, id)).toEqual(expected)
    records.create(DOMAINS.healthReviews, TENANT_A, { kind: 'committed outer batch' }, meta)
  })
  expect(new TenantRecords(store).get(domain, TENANT_A, id)).toEqual(expected)
  expect(records.list(DOMAINS.healthReviews, TENANT_A)).toHaveLength(1)
})

it('snapshots mutable callback inputs and detaches returned records from staged evidence and history', () => {
  const records = new TenantRecords(memoryStore(), () => new Date('2026-10-12T12:00:00Z'))
  const domain = DOMAINS.healthFindings
  type Finding = { evidence: { details: { count: number } } }
  let id!: string
  records.batch(() => {
    const input = { evidence: { details: { count: 1 } } }
    const created = records.create<Finding>(domain, TENANT_A, input, meta)
    id = created.id
    input.evidence.details.count = 90
    created.evidence.details.count = 91
    created.history[0]!.snapshot.evidence!.details.count = 92
    let callbackInput!: Finding
    const updated = records.update<Finding>(domain, TENANT_A, id, current => {
      callbackInput = current
      current.evidence.details.count = 2
      return current
    }, meta)!
    callbackInput.evidence.details.count = 93
    updated.evidence.details.count = 94
    updated.history[0]!.snapshot.evidence!.details.count = 95
  })
  const stored = records.get<Finding>(domain, TENANT_A, id)!
  expect(stored.evidence.details.count).toBe(2)
  expect(stored.history.map(revision => revision.snapshot.evidence?.details.count)).toEqual([1, 2])
})


it('rejects an async callback without publishing its staged writes or leaving an unhandled rejection', async () => {
  const store = memoryStore()
  const records = new TenantRecords(store)
  const write = vi.spyOn(store, 'setMany')
  const callback = vi.fn(async () => {
    records.create(DOMAINS.healthFindings, TENANT_A, { number: 1 }, meta)
    throw new Error('async callback failed')
  })
  expect(() => records.batch(callback)).toThrow('Record batches must finish synchronously')
  const pending = callback.mock.results[0]!.value as Promise<never>
  // The batch refuses the promise synchronously, so handle its rejection in the same turn.
  void pending.catch(() => undefined)
  await expect(pending).rejects.toThrow('async callback failed')
  expect(write).not.toHaveBeenCalled()
  expect(records.list(DOMAINS.healthFindings, TENANT_A)).toEqual([])
})

it('merges a successful nested batch into the parent single setMany write', () => {
  const store = memoryStore()
  const records = new TenantRecords(store)
  const write = vi.spyOn(store, 'setMany')
  records.batch(() => {
    records.create(DOMAINS.healthReviews, TENANT_A, { kind: 'parent' }, meta)
    records.batch(() => records.create(DOMAINS.healthFindings, TENANT_A, { number: 1 }, meta))
    expect(records.list(DOMAINS.healthReviews, TENANT_A)).toHaveLength(1)
    expect(records.list(DOMAINS.healthFindings, TENANT_A)).toHaveLength(1)
    expect(write).not.toHaveBeenCalled()
  })
  expect(write).toHaveBeenCalledTimes(1)
  const [changes] = write.mock.calls[0]!
  const saved = Object.values(changes).map(value => JSON.parse(value))
  expect(saved).toHaveLength(2)
  expect(saved).toContainEqual([expect.objectContaining({ kind: 'parent' })])
  expect(saved).toContainEqual([expect.objectContaining({ number: 1 })])
  const fresh = new TenantRecords(store)
  expect(fresh.list(DOMAINS.healthReviews, TENANT_A)).toHaveLength(1)
  expect(fresh.list(DOMAINS.healthFindings, TENANT_A)).toHaveLength(1)
})
