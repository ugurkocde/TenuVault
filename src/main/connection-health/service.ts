import { createHash } from "node:crypto"
import type { RunOutcomes } from "../../shared/backup-outcomes"
import { evaluateHealth, type HealthEvaluation, type ServiceChoice } from "../../shared/connection-health/evaluate"
import type { ConnectionHealthReport, ConnectionMode, ReaderObservation, Snapshot, TokenObservation } from "../../shared/connection-health/model"
import { runObservation } from "../../shared/connection-health/observe"
import { canBackUp, MODULES, type GrantedPermissions, type ModuleId } from "../../shared/services/modules"
import { observedTokenGrant } from "../auth/token-identity"
import type { KeyValueStore } from "../storage/secure-store"
import { signInFailure } from "./failure"
import { HealthStore, type ConnectionKey } from "./store"

/**
 * Why a check runs:
 * - launch: the app started, for the tenant the admin has open.
 * - signIn: the admin just signed in to the tenant.
 * - opened: a page that shows the state was opened.
 * - again: the admin asked to check again.
 * - beforeBackup, afterBackup: a backup of the tenant is about to start, or ended.
 */
export type CheckTrigger = "launch" | "signIn" | "opened" | "again" | "beforeBackup" | "afterBackup"

/** A trigger that comes again within this time of the last check answers from what that check found. */
export const CHECK_INTERVAL_MS = 60_000
/** How long a check waits for Microsoft's answer to one token request. */
export const CHECK_TIMEOUT_MS = 30_000

/**
 * The answer to a token request, or a timeout when none came in time. A request that never
 * answers would otherwise keep every later check of the tenant waiting behind it; it got no
 * answer, which is what the check then records. A late answer is dropped.
 */
function answered<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Microsoft did not answer the token request in time."), { name: "TimeoutError" })), CHECK_TIMEOUT_MS)
    timer.unref?.()
  })
  request.catch(() => undefined)
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer))
}

type ConnectionKind = "admin" | "reader" | "storage"

/** One marker per connection incarnation, including a change back to an earlier identity. */
interface ConnectionIdentity {
  tenant: string
  kind: ConnectionKind
  signature: string
  key: ConnectionKey
  account?: string
}

interface RunStart {
  identity: ConnectionIdentity
  permissionHeld?: Record<string, boolean | undefined>
}

export interface HealthHost {
  store: KeyValueStore
  now?: () => Date
  /** The app registration and the storage of a connected tenant; null for a tenant that is not connected. */
  tenant: (tenantId: string) => { clientId: string; storage: "local" | "azure"; storageId?: string } | null
  /** The ID of the account signed in to the tenant, never its name; null when nobody is. */
  account: (tenantId: string) => string | null
  settings: (tenantId: string) => Record<ModuleId, ServiceChoice>
  /**
   * Asks Microsoft for a new token of the signed-in admin, without any window. `fromCache` has to
   * be false for the answer to count: a token from the cache says nothing about now.
   */
  token: (tenantId: string, clientId: string, resource: "graph" | "storage") => Promise<{ accessToken: string; fromCache?: boolean; grantedScopes?: readonly string[] }>
  /** What this device knows about the tenant's Backup Reader; null when it has none. */
  reader: (tenantId: string) => { clientId: string; credential: string; facts: Omit<ReaderObservation, "at"> } | null
  /** Asks Microsoft for a new token of the Backup Reader; null when the reader may not be used now. */
  readerToken: (tenantId: string) => Promise<string | null>
  readerScheduled?: (tenantId: string) => boolean
  /** Called when what is known about a tenant changed. */
  changed?: (tenantId: string, connection?: ConnectionKind) => void
}

/**
 * Connection health of the connected tenants: runs the checks, keeps what they observed and works
 * out the report.
 *
 * A check asks Microsoft for a new token and records the answer. It never opens a sign-in window
 * and never asks the admin for anything, and nothing waits for it: a backup starts whether or not
 * its check has answered, and a check that fails is a recorded observation, not an error.
 */
export class ConnectionHealth {
  private readonly observations: HealthStore
  private readonly now: () => Date
  private readonly running = new Map<string, Promise<void>>()
  private readonly following = new Map<string, { identity: ConnectionIdentity; promise: Promise<void> }>()
  private readonly identities = new Map<string, ConnectionIdentity>()
  private readonly checkedAt = new Map<string, number>()
  private readonly runs = new Map<string, RunStart>()

  constructor(private readonly host: HealthHost) {
    this.now = host.now ?? (() => new Date())
    this.observations = new HealthStore(host.store, this.now)
  }

  /**
   * Checks the tenant's connection and returns the report. Triggers that follow each other are
   * settled here: one check runs per connection at a time and everyone who asks meanwhile gets its
   * result, and a trigger within a minute of the last check gets what that check found.
   *
   * The admin asking to check again, a new sign-in and a backup that failed always ask Microsoft,
   * because each of them means the answer may have changed. A check that was already running when
   * one of them came started before it, so it cannot answer for it: one more check follows.
   *
   * `reader` also asks for a new token of the Backup Reader. That happens only where the reader is
   * used anyway, before a scheduled backup that runs with it, and when the admin asks to check again.
   */
  check(tenantId: string, trigger: CheckTrigger, options: { reader?: boolean; failed?: boolean } = {}): Promise<ConnectionHealthReport> {
    const tenant = tenantId.toLowerCase()
    this.connectionsChanged(tenant)
    const connected = this.host.tenant(tenant)
    if (!connected) return Promise.reject(new Error("Connect this tenant first."))
    const always = trigger === "again" || trigger === "signIn" || (trigger === "afterBackup" && options.failed === true)
    const kinds: ConnectionKind[] = ["admin", ...(connected.storage === "azure" ? ["storage" as const] : []), ...(options.reader === true || trigger === "again" ? ["reader" as const] : [])]
    return Promise.all(kinds.map((kind) => {
      const identity = this.connection(tenant, kind)
      return identity ? this.checkConnection(identity, always) : undefined
    })).then(() => this.report(tenant))
  }

  private checkConnection(identity: ConnectionIdentity, always: boolean): Promise<void> {
    const lane = `${identity.tenant}|${identity.kind}`
    const running = this.running.get(lane)
    if (running && !always) return running
    if (running) {
      const queued = this.following.get(lane)
      if (queued?.identity === identity) return queued.promise
      const following = running.then(() => undefined, () => undefined).then(() => {
        if (this.following.get(lane)?.promise === following) this.following.delete(lane)
        if (this.unchanged(identity)) return this.start(identity)
      })
      this.following.set(lane, { identity, promise: following })
      return following
    }
    if (!always && this.now().getTime() - (this.checkedAt.get(lane) ?? -Infinity) < CHECK_INTERVAL_MS) return Promise.resolve()
    return this.start(identity)
  }

  private start(identity: ConnectionIdentity): Promise<void> {
    const lane = `${identity.tenant}|${identity.kind}`
    const check = this.observe(identity).then(() => {
      // The notice and debounce marker belong to the connection that asked, just like its answer.
      if (!this.unchanged(identity)) return
      this.checkedAt.set(lane, this.now().getTime())
      this.keepBaseline(identity.tenant)
      this.host.changed?.(identity.tenant, identity.kind)
    }).finally(() => {
      if (this.running.get(lane) === check) this.running.delete(lane)
    })
    this.running.set(lane, check)
    return check
  }

  /** What is known about the tenant now, from what was observed. Asks Microsoft nothing. */
  report(tenantId: string): ConnectionHealthReport {
    this.connectionsChanged(tenantId)
    const tenant = tenantId.toLowerCase()
    const { report, current, baseline } = this.evaluate(tenant)
    const key = this.adminKey(tenant)
    if (!key || !current || !baseline) return { ...report, acknowledgement: null }
    if (!current.account && this.host.account(tenant)) {
      if (baseline.replaces || !this.observations.connections(tenant).some((record) => record.mode === key.mode && record.clientId === key.clientId)) {
        this.observations.setSnapshot(key, baseline)
        if (baseline.replaces) this.observations.dropOthers(key)
      }
      return { ...report, acknowledgement: null }
    }
    this.observations.setSnapshot(key, baseline)
    if (baseline.replaces) this.observations.dropOthers(key)
    // Reading the same evidence again does not evict an earlier displayed report's receipt.
    const content = [key.owner, current.account, current.permissions, current.ready, current.acknowledgedLosses, baseline.found, baseline.carried, baseline.replaces]
    const canonical = JSON.stringify(content, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
    this.keepReaderBaseline(tenant, baseline)
    const id = createHash("sha256").update(canonical).digest("hex")
    this.observations.receipt(key, { id, snapshot: current, shown: baseline })
    return { ...report, acknowledgement: id }
  }

  /** Acknowledge only the report that was displayed, including its exact loss episodes. */
  acknowledge(tenantId: string, receipt: unknown): ConnectionHealthReport {
    if (typeof receipt !== "string" || !/^[a-f0-9]{64}$/.test(receipt)) throw new Error("Choose a connection health report to acknowledge.")
    const tenant = tenantId.toLowerCase()
    this.connectionsChanged(tenant)
    this.keepBaseline(tenant)
    const key = this.adminKey(tenant)
    if (key && this.observations.acknowledge(key, receipt)) {
      this.keepBaseline(tenant)
      this.host.changed?.(tenant)
    }
    return this.report(tenant)
  }

  /**
   * A backup run got its job. Whose sign-in it reads with is noted now, because that is whose run
   * it is: by the time it ends, another admin may be signed in, or the Backup Reader replaced.
   */
  runStarted(run: { id: string; authMode?: ConnectionMode }, request: { tenantId: string; clientId: string }): void {
    const tenant = request.tenantId.toLowerCase()
    this.connectionsChanged(tenant)
    const identity = this.connection(tenant, run.authMode === "app-only" ? "reader" : "admin")
    if (identity && (identity.kind === "reader" || identity.key.clientId === request.clientId.toLowerCase())) this.runs.set(run.id, { identity })
  }

  /**
   * Keeps how a backup run ended for each type, under the connection and the account it started
   * with. Nothing is kept of a run whose sign-in changed while it ran, or whose tenant was signed
   * out of or removed: what it read, or was refused, cannot be credited to anyone.
   */
  recordRun(outcomes: RunOutcomes, request: { tenantId: string; clientId: string }): void {
    const tenant = request.tenantId.toLowerCase()
    const started = this.runs.get(outcomes.runId)
    if (!started || started.identity.tenant !== tenant || started.identity.key.mode !== outcomes.authMode || !this.unchanged(started.identity)) return
    this.observations.recordRun(started.identity.key, runObservation(outcomes, started.identity.account, started.permissionHeld))
    this.keepBaseline(tenant)
    this.host.changed?.(tenant, started.identity.kind)
  }

  /** Permission names from tokens the engine already used, never another token request or a health check. */
  runToken(runId: string, granted: GrantedPermissions | undefined): void {
    const started = this.runs.get(runId)
    if (!started) return
    const held = Object.fromEntries(MODULES.flatMap((module) => module.areas.flatMap((area) => area.folders.map((folder) => [folder, granted ? canBackUp(folder, granted) : undefined]))))
    if (!started.permissionHeld) started.permissionHeld = held
    else for (const [folder, present] of Object.entries(held)) {
      if (started.permissionHeld[folder] !== present) started.permissionHeld[folder] = undefined
    }
  }

  /** The job of a backup run ended, with outcomes or without: its start is no longer needed. */
  runEnded(runId: string): void {
    this.runs.delete(runId)
  }

  /** The admin signed out of the tenant: what was observed for the account is dropped, and so is what a check under way still brings. */
  signedOut(tenantId: string): void {
    this.observations.signedOut(tenantId)
    this.forgetChecks(tenantId)
  }

  /** The tenant was removed from the app: everything observed for it is dropped, and so is what a check under way still brings. */
  forget(tenantId: string): void {
    this.observations.forget(tenantId)
    this.forgetChecks(tenantId)
  }

  private forgetChecks(tenantId: string): void {
    const tenant = tenantId.toLowerCase()
    for (const kind of ["admin", "reader", "storage"]) {
      const lane = `${tenant}|${kind}`
      this.identities.delete(lane)
      this.checkedAt.delete(lane)
      this.running.delete(lane)
      this.following.delete(lane)
    }
    for (const [runId, started] of this.runs) if (started.identity.tenant === tenant) this.runs.delete(runId)
  }

  /** Called synchronously at identity mutations, so changing and changing back cannot revive pending work. */
  connectionsChanged(tenantId: string): void {
    const tenant = tenantId.toLowerCase()
    for (const kind of ["admin", "reader", "storage"] as const) this.connection(tenant, kind)
  }

  /** The single definition of the identity of each connection. The same non-secret signature is persisted with stored evidence. */
  private connection(tenant: string, kind: ConnectionKind): ConnectionIdentity | null {
    const connected = this.host.tenant(tenant)
    const reader = kind === "reader" ? this.host.reader(tenant) : null
    const account = kind !== "reader" ? this.host.account(tenant) ?? undefined : undefined
    const clientId = (kind === "reader" ? reader?.clientId : connected?.clientId)?.toLowerCase()
    const lane = `${tenant}|${kind}`
    if (!connected || !clientId || (kind === "storage" && connected.storage !== "azure")) {
      this.identities.delete(lane)
      this.checkedAt.delete(lane)
      this.observations.activate(tenant, kind, null)
      return null
    }
    const signature = JSON.stringify([tenant, clientId, account, kind === "reader" ? reader!.credential : kind === "storage" ? connected.storageId ?? connected.storage : undefined])
    let identity = this.identities.get(lane)
    if (!identity || identity.signature !== signature) {
      identity = { tenant, kind, signature, key: { tenantId: tenant, clientId, mode: kind === "reader" ? "app-only" : "delegated" }, ...(account ? { account } : {}) }
      this.identities.set(lane, identity)
      this.checkedAt.delete(lane)
    }
    if (kind === "storage") {
      identity.key.storageOwner = signature
      identity.key.owner = this.connection(tenant, "admin")?.signature
    } else identity.key.owner = signature
    this.observations.activate(tenant, kind, identity.key)
    return identity
  }

  private unchanged(identity: ConnectionIdentity): boolean {
    return this.connection(identity.tenant, identity.kind) === identity
  }

  private adminKey(tenant: string): ConnectionKey | null {
    return this.connection(tenant, "admin")?.key ?? null
  }

  private async observe(identity: ConnectionIdentity): Promise<void> {
    const { tenant, key, kind, account } = identity
    let observation: TokenObservation
    try {
      if (kind === "reader") {
        const reader = this.host.reader(tenant)
        if (!reader || !this.unchanged(identity)) return
        this.observations.recordReader(key, { ...reader.facts, at: this.now().toISOString() })
        if (reader.facts.state !== "verified") return
        const token = await answered(this.host.readerToken(tenant))
        if (token === null) return
        observation = this.issued(token)
      } else {
        const token = await answered(this.host.token(tenant, key.clientId, kind === "admin" ? "graph" : "storage"))
        if (token.fromCache !== false) return
        observation = this.issued(token.accessToken, kind === "admin" ? token.grantedScopes : undefined)
      }
    } catch (error) {
      observation = { at: this.now().toISOString(), failure: signInFailure(error) }
    }
    if (kind !== "reader" && !account && !observation.failure) return
    if (this.unchanged(identity)) this.observations.recordToken(key, kind === "storage" ? "storage" : "graph", observation, account)
  }

  /** What a token Microsoft issued for a check shows: its permissions, as of now. */
  private issued(accessToken: string, grantedScopes?: readonly string[]): TokenObservation {
    const granted = observedTokenGrant(accessToken, grantedScopes)
    return { at: this.now().toISOString(), ...(granted ? { permissions: [...granted.permissions].sort() } : {}) }
  }

  private evaluate(tenant: string): HealthEvaluation {
    const connected = this.host.tenant(tenant)
    const reader = this.host.reader(tenant)
    const now = this.now()
    const connections = connected ? this.observations.connections(tenant) : []
    // Registration changes and reader-only backups need a tenant baseline without inventing an admin token.
    if (connected && connections.length > 0 && !connections.some((record) => record.mode === "delegated" && record.clientId === connected.clientId.toLowerCase())) {
      const account = this.host.account(tenant)
      connections.push({ clientId: connected.clientId, mode: "delegated", ...(account ? { account } : {}), runs: [], verified: {}, refused: {}, updatedAt: now.toISOString() })
    }
    return evaluateHealth(
      {
        tenantId: tenant,
        clientId: connected?.clientId ?? "",
        ...(reader?.clientId ? { readerClientId: reader.clientId } : {}),
        // Read from this device at the moment of the report, so a renewed or removed reader shows without a check.
        reader: reader ? { ...reader.facts, at: now.toISOString() } : null,
        readerScheduled: reader ? this.host.readerScheduled?.(tenant) : false,
        storage: connected?.storage ?? "local",
        settings: this.host.settings(tenant),
        connections,
      },
      now,
    )
  }

  /** Reader acknowledgements belong to the reader, independently of the admin's registration. */
  private keepReaderBaseline(tenant: string, baseline: Snapshot): void {
    const reader = this.connection(tenant, "reader")
    if (!reader) return
    const kept = this.observations.connections(tenant).find((record) => record.mode === "app-only" && record.clientId === reader.key.clientId)?.snapshot
    if (!kept) this.observations.setSnapshot(reader.key, { at: baseline.at, acknowledgedLosses: (baseline.acknowledgedLosses ?? []).filter((loss) => loss.mode === "app-only") })
  }

  /**
   * Keeps the snapshot later changes are compared with: a first one, or the earlier one with what
   * was learned for the first time. Once it names the registration it replaced, that one's record
   * has nothing left to say and goes.
   */
  private keepBaseline(tenant: string): void {
    const key = this.adminKey(tenant)
    const { baseline } = this.evaluate(tenant)
    if (!key || !baseline) return
    const kept = this.observations.connections(tenant).find((record) => record.mode === "delegated" && record.clientId.toLowerCase() === key.clientId.toLowerCase())?.snapshot
    if (JSON.stringify(kept) !== JSON.stringify(baseline)) this.observations.setSnapshot(key, baseline)
    if (baseline.replaces) this.observations.dropOthers(key)
    this.keepReaderBaseline(tenant, baseline)
  }
}

/**
 * The tenant the admin has open, from what the window saved: the list of tenants and the one that
 * is selected. Null when none is, so nothing is checked at launch.
 */
export function selectedTenant(tenants: string | null, selected: string | null): string | null {
  try {
    const list = JSON.parse(tenants ?? "[]") as Array<{ id?: unknown; credentials?: { tenantId?: unknown } }>
    const found = Array.isArray(list) ? list.find((tenant) => tenant?.id !== undefined && String(tenant.id) === selected) : undefined
    const tenantId = found?.credentials?.tenantId
    return typeof tenantId === "string" && tenantId ? tenantId : null
  } catch {
    return null
  }
}
