import { MAX_FOLDER_REFUSALS, RUN_MAX_AGE_MS, type ConnectionMode, type ConnectionRecord, type FolderRefusal, type PermissionChange, type ReaderObservation, type RunObservation, type SignInFailure, type Snapshot, type TokenObservation } from "../../shared/connection-health/model"
import { carryChanges, keepEvidence } from "../../shared/connection-health/observe"
import { MODULES, type ModuleId } from "../../shared/services/modules"
import type { KeyValueStore } from "../storage/secure-store"

/**
 * The observations connection health is worked out from, in the encrypted app state: one value per
 * tenant, holding a record per connection (app registration and sign-in mode).
 *
 * Versioned: a value of another version, or one that cannot be read, counts as nothing observed and
 * is replaced by the next observation. Nothing is migrated, because an observation is only worth
 * what Microsoft said recently, and the next check says it again.
 *
 * Bounded: a tenant keeps a few connections, a connection its last few runs and, per folder, its
 * last read and two refusals since, and every list has a cap, so the app state does not grow with
 * use. What is stored is listed in
 * shared/connection-health/model: never a token, a secret, an account name or an error message.
 */

export const HEALTH_STORE_VERSION = 1
/** Connections kept per tenant: the admin's and the Backup Reader's, and an earlier one of each. */
export const MAX_CONNECTIONS = 4
/**
 * Runs kept per connection: they show what the last backups said about each type. Lost access does
 * not go by them but by what the record keeps per folder, so it does not matter which types the
 * last backups selected.
 */
export const MAX_RUNS = 5
/** The most entries any list or map of a record holds. */
export const MAX_ENTRIES = 600

const KEY = "connectionHealth."

export interface ConnectionKey {
  tenantId: string
  clientId: string
  mode: ConnectionMode
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown, max = 200): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined)
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((entry) => text(entry) ?? []).slice(0, MAX_ENTRIES) : [])
const time = (value: unknown): string | undefined => {
  const at = text(value, 40)
  return at && Number.isFinite(Date.parse(at)) ? at : undefined
}

function failureOf(value: unknown): SignInFailure | undefined {
  if (!isRecord(value)) return undefined
  const failed = text(value.class, 40)
  const code = text(value.code, 20)
  return failed ? { class: failed as SignInFailure["class"], ...(code ? { code } : {}) } : undefined
}

function tokenOf(value: unknown): TokenObservation | undefined {
  if (!isRecord(value)) return undefined
  const at = time(value.at)
  if (!at) return undefined
  const failure = failureOf(value.failure)
  return { at, ...(Array.isArray(value.permissions) ? { permissions: texts(value.permissions) } : {}), ...(failure ? { failure } : {}) }
}

const isCause = (value: unknown): value is FolderRefusal["cause"] => value === "permission" || value === "role" || value === "license"

function runOf(value: unknown): RunObservation | undefined {
  if (!isRecord(value)) return undefined
  const runId = text(value.runId)
  const at = time(value.at)
  const trigger = value.trigger === "scheduled" || value.trigger === "tray" ? value.trigger : "manual"
  if (!runId || !at) return undefined
  const account = text(value.account)
  const refused = (Array.isArray(value.refused) ? value.refused : []).flatMap((entry): RunObservation["refused"] => {
    const folder = isRecord(entry) ? text(entry.folder) : undefined
    if (!folder || !isRecord(entry) || !isCause(entry.cause)) return []
    const code = text(entry.code, 80)
    return [{ folder, cause: entry.cause, ...(typeof entry.permissionHeld === "boolean" ? { permissionHeld: entry.permissionHeld } : {}), ...(typeof entry.status === "number" ? { status: entry.status } : {}), ...(code ? { code } : {}) }]
  })
  const excluded = (Array.isArray(value.excluded) ? value.excluded : []).flatMap((entry): RunObservation["excluded"] => {
    const folder = isRecord(entry) ? text(entry.folder) : undefined
    return folder && isRecord(entry) && (entry.cause === "reader" || entry.cause === "signedIn") ? [{ folder, cause: entry.cause }] : []
  })
  return { runId, at, trigger, status: text(value.status, 40) ?? "", ...(account ? { account } : {}), read: texts(value.read), refused: refused.slice(0, MAX_ENTRIES), unread: texts(value.unread), excluded: excluded.slice(0, MAX_ENTRIES) }
}

function refusalsOf(value: unknown): ConnectionRecord["refused"] {
  if (!isRecord(value)) return {}
  const folders = Object.entries(value).flatMap(([folder, entries]): Array<[string, FolderRefusal[]]> => {
    const refusals = (Array.isArray(entries) ? entries : []).flatMap((entry): FolderRefusal[] => {
      const runId = isRecord(entry) ? text(entry.runId) : undefined
      const at = isRecord(entry) ? time(entry.at) : undefined
      return runId && at && isRecord(entry) && isCause(entry.cause) ? [{ runId, at, cause: entry.cause, ...(typeof entry.permissionHeld === "boolean" ? { permissionHeld: entry.permissionHeld } : {}) }] : []
    })
    return text(folder) && refusals.length ? [[folder, refusals.slice(0, MAX_FOLDER_REFUSALS)]] : []
  })
  return Object.fromEntries(folders.slice(0, MAX_ENTRIES))
}

function readerOf(value: unknown): ReaderObservation | undefined {
  if (!isRecord(value)) return undefined
  const at = time(value.at)
  const notAfter = time(value.notAfter)
  if (!at || !notAfter || (value.state !== "pending" && value.state !== "verified")) return undefined
  const change = isRecord(value.roleChange) ? time(value.roleChange.at) : undefined
  return {
    at,
    state: value.state,
    notAfter,
    verifiedAt: time(value.verifiedAt) ?? null,
    verifiedRoles: Array.isArray(value.verifiedRoles) ? texts(value.verifiedRoles) : null,
    roleChange: change && isRecord(value.roleChange) ? { added: texts(value.roleChange.added), removed: texts(value.roleChange.removed), at: change } : null,
  }
}

const SERVICES = new Set<unknown>(MODULES.map((module) => module.id))

function changesOf(value: unknown): PermissionChange[] {
  const changes = (Array.isArray(value) ? value : []).flatMap((entry): PermissionChange[] => {
    if (!isRecord(entry)) return []
    const foundAt = time(entry.foundAt)
    const origin = { ...(foundAt ? { foundAt } : {}), ...(entry.earlierSignIn === true ? { earlierSignIn: true as const } : {}) }
    if (entry.kind === "permissionsAdded" || entry.kind === "permissionsRemoved") return Array.isArray(entry.permissions) ? [{ kind: entry.kind, permissions: texts(entry.permissions), ...origin }] : []
    const area = text(entry.area)
    return entry.kind === "becameReady" && SERVICES.has(entry.service) ? [{ kind: "becameReady", service: entry.service as ModuleId, ...origin, ...(area ? { area } : {}) }] : []
  })
  return changes.slice(0, MAX_ENTRIES)
}

function snapshotOf(value: unknown): Snapshot | undefined {
  if (!isRecord(value)) return undefined
  const at = time(value.at)
  if (!at) return undefined
  const account = text(value.account)
  const found = changesOf(value.found)
  const carried = changesOf(value.carried).map((change): PermissionChange => ({ ...change, earlierSignIn: true, foundAt: change.foundAt ?? at }))
  const ready = isRecord(value.ready) ? Object.fromEntries(Object.entries(value.ready).filter(([area, present]) => text(area) && typeof present === "boolean").slice(0, MAX_ENTRIES)) : undefined
  const replaced = isRecord(value.replaces) ? text(value.replaces.clientId) : undefined
  return {
    at,
    ...(account ? { account } : {}),
    ...(Array.isArray(value.permissions) ? { permissions: texts(value.permissions) } : {}),
    ...(ready ? { ready: ready as Record<string, boolean> } : {}),
    ...(Array.isArray(value.lost) ? { lost: texts(value.lost) } : {}),
    ...(replaced && isRecord(value.replaces) ? { replaces: { clientId: replaced, ...(Array.isArray(value.replaces.permissions) ? { permissions: texts(value.replaces.permissions) } : {}) } } : {}),
    ...(found.length ? { found } : {}),
    ...(carried.length ? { carried } : {}),
  }
}

/** A stored record with every part checked; a part that does not read is left out, never guessed. */
function recordOf(value: unknown): ConnectionRecord | undefined {
  if (!isRecord(value)) return undefined
  const clientId = text(value.clientId)
  const updatedAt = time(value.updatedAt)
  if (!clientId || !updatedAt || (value.mode !== "delegated" && value.mode !== "app-only")) return undefined
  const account = text(value.account)
  const graph = tokenOf(value.graph)
  const storage = tokenOf(value.storage)
  const reader = readerOf(value.reader)
  const snapshot = snapshotOf(value.snapshot)
  const verified = isRecord(value.verified) ? Object.entries(value.verified).flatMap(([folder, at]): Array<[string, string]> => (text(folder) && time(at) ? [[folder, at as string]] : [])).slice(0, MAX_ENTRIES) : []
  const record: ConnectionRecord = {
    clientId,
    mode: value.mode,
    ...(account ? { account } : {}),
    ...(graph ? { graph } : {}),
    ...(storage ? { storage } : {}),
    ...(reader ? { reader } : {}),
    runs: (Array.isArray(value.runs) ? value.runs : []).flatMap((run) => runOf(run) ?? []).slice(-MAX_RUNS),
    verified: Object.fromEntries(verified),
    refused: refusalsOf(value.refused),
    ...(snapshot ? { snapshot } : {}),
    updatedAt,
  }
  // Earlier values kept only runs and last reads. Recover their bounded evidence without trusting
  // unvalidated data or crediting another admin's runs to the current account.
  if (value.refused === undefined) {
    for (const run of [...record.runs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      if (record.mode === "app-only" || run.account === record.account) keepEvidence(record, run)
    }
    record.verified = Object.fromEntries(Object.entries(record.verified).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, MAX_ENTRIES))
    record.refused = Object.fromEntries(Object.entries(record.refused).filter(([folder]) => Object.hasOwn(record.verified, folder)).slice(0, MAX_ENTRIES))
  }
  return record
}

export class HealthStore {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every connection record kept for the tenant. */
  connections(tenantId: string): ConnectionRecord[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(this.store.get(KEY + tenantId.toLowerCase()) ?? "null")
    } catch {
      return []
    }
    if (!isRecord(parsed) || parsed.version !== HEALTH_STORE_VERSION || !Array.isArray(parsed.connections)) return []
    return parsed.connections.flatMap((record) => recordOf(record) ?? []).slice(0, MAX_CONNECTIONS)
  }

  /**
   * Keeps what a token request made for a check was answered with. `account` is the admin it was
   * made for: an answer for another admin than the record's starts the record over for them.
   */
  recordToken(key: ConnectionKey, resource: "graph" | "storage", observation: TokenObservation, account?: string): void {
    this.change(key, true, (record) => {
      this.ownedBy(record, account)
      record[resource] = { ...observation, ...(observation.permissions ? { permissions: observation.permissions.slice(0, MAX_ENTRIES) } : {}) }
    })
  }

  /**
   * Keeps how a run ended. A run that is already kept is not kept twice, whatever it says the
   * second time: two refusals have to come from two runs.
   */
  recordRun(key: ConnectionKey, run: RunObservation): void {
    this.change(key, true, (record) => {
      this.ownedBy(record, run.account)
      if (record.runs.some((kept) => kept.runId === run.runId)) return
      record.runs = [...record.runs, run].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_RUNS)
      keepEvidence(record, run)
      // The folders read longest ago go first when there are more than the record may hold.
      const kept = Object.entries(record.verified).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, MAX_ENTRIES)
      record.verified = Object.fromEntries(kept)
    })
  }

  recordReader(key: ConnectionKey, observation: ReaderObservation): void {
    this.change(key, true, (record) => {
      record.reader = observation
    })
  }

  setSnapshot(key: ConnectionKey, snapshot: Snapshot): void {
    this.change(key, false, (record) => {
      record.snapshot = snapshot
    })
  }

  /** Drops the tenant's other records of the same sign-in mode, once what they knew is in this one's snapshot. */
  dropOthers(key: ConnectionKey): void {
    const records = this.connections(key.tenantId)
    const kept = records.filter((record) => record.mode !== key.mode || sameId(record.clientId, key.clientId))
    if (kept.length !== records.length) this.write(key.tenantId, kept, kept.find((record) => record.mode === key.mode))
  }

  /**
   * The admin signed out of the tenant: everything observed for the account goes, and so does the
   * Backup Reader, which is removed with the sign-in. What stays is what the registration had, so a
   * tenant that comes back with another registration is told what that one lacks, and the changes
   * of its permissions that nobody looked at yet, which hold whoever signs in next.
   */
  signedOut(tenantId: string): void {
    const kept = this.connections(tenantId).flatMap((record): ConnectionRecord[] => {
      if (record.mode !== "delegated") return []
      const permissions = record.graph?.permissions ?? record.snapshot?.permissions
      const snapshot = record.snapshot
      const carried = carryChanges(snapshot)
      if (!permissions && !snapshot?.replaces && !carried.length) return []
      return [{
        clientId: record.clientId,
        mode: record.mode,
        runs: [],
        verified: {},
        refused: {},
        snapshot: { at: snapshot?.at ?? record.updatedAt, ...(permissions ? { permissions } : {}), ...(snapshot?.replaces ? { replaces: snapshot.replaces } : {}), ...(carried.length ? { carried } : {}) },
        updatedAt: record.updatedAt,
      }]
    })
    this.write(tenantId, kept)
  }

  /** The tenant was removed from the app. */
  forget(tenantId: string): void {
    this.store.delete(KEY + tenantId.toLowerCase())
  }

  /**
   * Makes the record the given admin's. What was observed for another admin says nothing about
   * this one: their token answers, their runs and what those runs read or were refused are dropped.
   */
  private ownedBy(record: ConnectionRecord, account: string | undefined): void {
    if (record.mode !== "delegated" || !account || record.account === account) return
    record.account = account
    delete record.graph
    delete record.storage
    record.runs = record.runs.filter((run) => run.account === account)
    record.verified = {}
    record.refused = {}
    for (const run of record.runs) keepEvidence(record, run)
  }

  private change(key: ConnectionKey, observed: boolean, apply: (record: ConnectionRecord) => void): void {
    const records = this.connections(key.tenantId)
    let record = records.find((candidate) => candidate.mode === key.mode && sameId(candidate.clientId, key.clientId))
    if (!record) {
      record = { clientId: key.clientId.toLowerCase(), mode: key.mode, runs: [], verified: {}, refused: {}, updatedAt: this.now().toISOString() }
      records.push(record)
    }
    apply(record)
    if (observed) record.updatedAt = this.now().toISOString()
    this.write(key.tenantId, records, record)
  }

  /** Writes the tenant's records without what has expired, and without the records used longest ago beyond the cap. */
  private write(tenantId: string, records: ConnectionRecord[], current?: ConnectionRecord): void {
    const oldest = this.now().getTime() - RUN_MAX_AGE_MS
    for (const record of records) {
      record.runs = record.runs.filter((run) => Date.parse(run.at) >= oldest)
      record.verified = Object.fromEntries(Object.entries(record.verified).filter(([, at]) => Date.parse(at) >= oldest))
      // A refusal says something only next to the read it came after, so it goes with that read.
      record.refused = Object.fromEntries(Object.entries(record.refused).flatMap(([folder, refusals]): Array<[string, FolderRefusal[]]> => {
        const kept = refusals.filter((refusal) => Date.parse(refusal.at) >= oldest)
        return record.verified[folder] && kept.length ? [[folder, kept]] : []
      }))
    }
    const kept = records
      .filter((record) => record === current || Date.parse(record.updatedAt) >= oldest)
      .sort((a, b) => (a === current ? -1 : b === current ? 1 : Date.parse(b.updatedAt) - Date.parse(a.updatedAt)))
      .slice(0, MAX_CONNECTIONS)
    if (!kept.length) return this.store.delete(KEY + tenantId.toLowerCase())
    this.store.set(KEY + tenantId.toLowerCase(), JSON.stringify({ version: HEALTH_STORE_VERSION, connections: kept }))
  }
}
