import { randomUUID } from "node:crypto"
import type { KeyValueStore } from "../storage/secure-store"

/** One entry of a record's append-only history. */
export interface RecordRevision<T> {
  at: string
  /** The signed-in admin, or null when unknown (for example a scheduled review). */
  actor: string | null
  /** Why the record changed, as the admin or the workflow stated it. */
  reason: string
  /**
   * The record as it was after this change, without its history. When `partial` is set, it
   * holds only the top-level fields this change set, and `removed` names the fields it deleted;
   * `resolveHistory` rebuilds the full record of every revision. Revisions stored before
   * partial snapshots existed are complete.
   */
  snapshot: Partial<T>
  partial?: true
  removed?: string[]
}

type FullRevision<T> = Omit<RecordRevision<T>, "snapshot" | "partial" | "removed"> & { snapshot: T }

/** Every revision with the full record as it was after that change, oldest first. */
export function resolveHistory<T>(history: RecordRevision<T>[]): FullRevision<T>[] {
  let state = {} as T
  return history.map(({ partial, removed, snapshot, ...revision }) => {
    if (!partial) state = snapshot as T
    else {
      const next = { ...state, ...snapshot } as Record<string, unknown>
      for (const key of removed ?? []) delete next[key]
      state = next as T
    }
    return { ...revision, snapshot: state }
  })
}

/** The top-level fields that differ between two versions of a record, and the ones removed. */
function delta(before: Record<string, unknown>, after: Record<string, unknown>): { changes: Record<string, unknown>; removed: string[] } {
  const changes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after)) {
    if (value !== undefined && JSON.stringify(value) !== JSON.stringify(before[key])) changes[key] = value
  }
  const removed = Object.keys(before).filter((key) => before[key] !== undefined && after[key] === undefined)
  return { changes, removed }
}

export interface StoredRecord {
  id: string
  tenantId: string
  createdAt: string
  updatedAt: string
}

export type Stored<T> = T & StoredRecord & { history: RecordRevision<T & StoredRecord>[] }

/**
 * Scope for records that belong to no single tenant, such as an MSP's reusable golden
 * standards. They must never contain tenant evidence.
 */
export const SHARED_SCOPE = "shared"

/** Most records a tenant keeps per domain; the oldest closed records are dropped first by callers. */
export const MAX_RECORDS = 2000
/** History entries kept per record. */
export const MAX_REVISIONS = 200

/**
 * Local records of the roadmap workflows (findings, change sets, promotions and so on),
 * one encrypted list per tenant and domain.
 *
 * Keys are `records.v1.<domain>.<tenant>`, so one tenant's records are never read while
 * working on another: every call names its tenant and a record ID from another tenant is
 * simply not found. Updates never rewrite history, they append a revision with the actor
 * and reason. The first revision holds the whole record; later ones hold only the fields they
 * changed, so frequent progress updates of a large record do not copy it again each time. Nothing here is deleted by a plan change; only `remove` deletes, and callers
 * use it only for records the admin explicitly discards.
 */
export class TenantRecords {
  private staged: Map<string, Stored<unknown>[]> | null = null
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list<T>(domain: string, tenantId: string): Stored<T>[] {
    return structuredClone(this.readRecords<T>(domain, tenantId))
  }

  private readRecords<T>(domain: string, tenantId: string): Stored<T>[] {
    const key = this.key(domain, tenantId)
    const staged = this.staged?.get(key)
    if (staged) return [...staged] as Stored<T>[]
    const raw = this.store.get(key)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as Stored<T>[]) : []
    } catch {
      return []
    }
  }

  get<T>(domain: string, tenantId: string, id: string): Stored<T> | null {
    return this.list<T>(domain, tenantId).find((record) => record.id === id) ?? null
  }

  /** Stores a new record with a fresh ID and its first revision. */
  create<T extends object>(domain: string, tenantId: string, value: T, meta: { actor: string | null; reason: string }): Stored<T> {
    const records = this.readRecords<T>(domain, tenantId)
    if (records.length >= MAX_RECORDS) throw new Error("This tenant has too many stored records of this kind. Close or export older ones first.")
    const at = this.now().toISOString()
    const base = { ...structuredClone(value), id: randomUUID(), tenantId: tenantId.toLowerCase(), createdAt: at, updatedAt: at } as T & StoredRecord
    const record: Stored<T> = { ...base, history: [{ at, actor: meta.actor, reason: meta.reason, snapshot: structuredClone(base) }] }
    this.save(domain, tenantId, [...records, record])
    return structuredClone(record)
  }

  /**
   * Changes a record and appends a revision. `change` returns the new value; the ID, tenant
   * and creation time cannot be changed. Returns null when the record does not exist.
   */
  update<T extends object>(
    domain: string,
    tenantId: string,
    id: string,
    change: (current: T & StoredRecord) => T,
    meta: { actor: string | null; reason: string },
  ): Stored<T> | null {
    const records = this.readRecords<T>(domain, tenantId)
    const index = records.findIndex((record) => record.id === id)
    const current = records[index]
    if (!current) return null
    const { history, ...plain } = current
    const at = this.now().toISOString()
    // A caller that spreads a stored record back in must not nest its history in the snapshot.
    const { history: _nested, ...changed } = change(structuredClone(plain) as T & StoredRecord) as T & { history?: unknown }
    const next = { ...structuredClone(changed), id: current.id, tenantId: current.tenantId, createdAt: current.createdAt, updatedAt: at } as T & StoredRecord
    const { changes, removed } = delta(plain as Record<string, unknown>, next as Record<string, unknown>)
    let revisions: RecordRevision<T & StoredRecord>[] = [...history, { at, actor: meta.actor, reason: meta.reason, snapshot: structuredClone(changes) as Partial<T & StoredRecord>, partial: true, ...(removed.length ? { removed } : {}) }]
    if (revisions.length > MAX_REVISIONS) {
      // The oldest kept revision becomes complete again, so the kept history still resolves.
      const first = resolveHistory(revisions)[revisions.length - MAX_REVISIONS]!
      revisions = [first, ...revisions.slice(-MAX_REVISIONS + 1)]
    }
    const updated: Stored<T> = { ...next, history: revisions }
    records[index] = updated
    this.save(domain, tenantId, records)
    return structuredClone(updated)
  }

  /** Deletes one record. Only for records the admin explicitly discards. */
  remove(domain: string, tenantId: string, id: string): boolean {
    const records = this.readRecords(domain, tenantId)
    const kept = records.filter((record) => record.id !== id)
    if (kept.length === records.length) return false
    this.save(domain, tenantId, kept)
    return true
  }

  /** Synchronous scan writes share one durable flush. Failed batches leave no staged changes. */
  batch<T>(run: () => T): T {
    const parent = this.staged
    this.staged = parent ? structuredClone(parent) : new Map()
    try {
      const result = run()
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Record batches must finish synchronously")
      if (!parent) {
        const changes = Object.fromEntries([...this.staged].map(([key, records]) => [key, JSON.stringify(records)]))
        if (this.store.setMany) this.store.setMany(changes)
        else if (Object.keys(changes).length > 1) throw new Error("This store cannot write several records at once, so the batch was not saved.")
        else for (const [key, value] of Object.entries(changes)) this.store.set(key, value)
      } else {
        for (const [key, records] of this.staged) parent.set(key, records)
      }
      return result
    } finally {
      this.staged = parent
    }
  }

  private save<T>(domain: string, tenantId: string, records: Stored<T>[]): void {
    const key = this.key(domain, tenantId)
    if (this.staged) this.staged.set(key, records as Stored<unknown>[])
    else this.store.set(key, JSON.stringify(records))
  }

  private key(domain: string, tenantId: string): string {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(domain)) throw new Error(`Invalid record domain ${domain}`)
    if (tenantId !== SHARED_SCOPE && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tenantId)) throw new Error("Invalid tenant")
    return `records.v1.${domain}.${tenantId.toLowerCase()}`
  }
}
