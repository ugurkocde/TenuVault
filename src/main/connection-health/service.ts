import type { RunOutcomes } from "../../shared/backup-outcomes"
import { evaluateHealth, type HealthEvaluation, type ServiceChoice } from "../../shared/connection-health/evaluate"
import type { ConnectionHealthReport, ReaderObservation } from "../../shared/connection-health/model"
import { runObservation } from "../../shared/connection-health/observe"
import type { ModuleId } from "../../shared/services/modules"
import { grantedPermissions } from "../../shared/services/token"
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

export interface HealthHost {
  store: KeyValueStore
  now?: () => Date
  /** The app registration and the storage of a connected tenant; null for a tenant that is not connected. */
  tenant: (tenantId: string) => { clientId: string; storage: "local" | "azure" } | null
  /** The ID of the account signed in to the tenant, never its name; null when nobody is. */
  account: (tenantId: string) => string | null
  settings: (tenantId: string) => Record<ModuleId, ServiceChoice>
  /**
   * Asks Microsoft for a new token of the signed-in admin, without any window. `fromCache` has to
   * be false for the answer to count: a token from the cache says nothing about now.
   */
  token: (tenantId: string, clientId: string, resource: "graph" | "storage") => Promise<{ accessToken: string; fromCache?: boolean }>
  /** What this device knows about the tenant's Backup Reader; null when it has none. */
  reader: (tenantId: string) => { clientId: string; facts: Omit<ReaderObservation, "at"> } | null
  /** Asks Microsoft for a new token of the Backup Reader; null when the reader may not be used now. */
  readerToken: (tenantId: string) => Promise<string | null>
  /** Called when what is known about a tenant changed. */
  changed?: (tenantId: string) => void
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
  private readonly running = new Map<string, Promise<ConnectionHealthReport>>()
  /** The check that follows the running one, for triggers that must not be answered by a check that started before them. */
  private readonly following = new Map<string, Promise<ConnectionHealthReport>>()
  private readonly checkedAt = new Map<string, number>()

  constructor(private readonly host: HealthHost) {
    this.now = host.now ?? (() => new Date())
    this.observations = new HealthStore(host.store, this.now)
  }

  /**
   * Checks the tenant's connection and returns the report. Triggers that follow each other are
   * settled here: one check runs per tenant at a time and everyone who asks meanwhile gets its
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
    const reader = options.reader === true || trigger === "again"
    const lane = `${tenant}|${reader ? "reader" : "admin"}`
    const always = trigger === "again" || trigger === "signIn" || (trigger === "afterBackup" && options.failed === true)
    // A check that also asks the Backup Reader answers for one that would not have.
    const running = this.running.get(lane) ?? (reader ? undefined : this.running.get(`${tenant}|reader`))
    if (running && !always) return running
    if (running) {
      const following = this.following.get(lane) ?? running.then(() => undefined, () => undefined).then(() => {
        this.following.delete(lane)
        return this.start(lane, tenant, reader)
      })
      this.following.set(lane, following)
      return following
    }
    const last = Math.max(this.checkedAt.get(`${tenant}|reader`) ?? -Infinity, reader ? -Infinity : (this.checkedAt.get(lane) ?? -Infinity))
    if (!always && this.now().getTime() - last < CHECK_INTERVAL_MS) return Promise.resolve(this.report(tenant))
    return this.start(lane, tenant, reader)
  }

  private start(lane: string, tenant: string, reader: boolean): Promise<ConnectionHealthReport> {
    const check = this.observe(tenant, reader).finally(() => {
      if (this.running.get(lane) === check) this.running.delete(lane)
    })
    this.running.set(lane, check)
    return check
  }

  /** What is known about the tenant now, from what was observed. Asks Microsoft nothing. */
  report(tenantId: string): ConnectionHealthReport {
    return this.evaluate(tenantId.toLowerCase()).report
  }

  /**
   * The changes were looked at: the state as it is now is what later changes are compared with.
   * A replaced registration is no longer named after this.
   */
  acknowledge(tenantId: string): ConnectionHealthReport {
    const tenant = tenantId.toLowerCase()
    const key = this.adminKey(tenant)
    const { current } = this.evaluate(tenant)
    if (key && current) {
      this.observations.setSnapshot(key, current)
      this.observations.dropOthers(key)
      this.host.changed?.(tenant)
    }
    return this.report(tenant)
  }

  /** Keeps how a backup run ended for each type, under the connection that ran it. */
  recordRun(outcomes: RunOutcomes, request: { tenantId: string; clientId: string }): void {
    const tenant = request.tenantId.toLowerCase()
    const reader = outcomes.authMode === "app-only" ? this.host.reader(tenant) : null
    if (outcomes.authMode === "app-only" && !reader?.clientId) return
    const key: ConnectionKey = reader ? { tenantId: tenant, clientId: reader.clientId, mode: "app-only" } : { tenantId: tenant, clientId: request.clientId, mode: "delegated" }
    this.observations.recordRun(key, runObservation(outcomes, this.host.account(tenant) ?? undefined))
    this.keepBaseline(tenant)
    this.host.changed?.(tenant)
  }

  /** The admin signed out of the tenant: what was observed for the account is dropped. */
  signedOut(tenantId: string): void {
    this.observations.signedOut(tenantId)
    this.forgetChecks(tenantId)
  }

  /** The tenant was removed from the app: everything observed for it is dropped. */
  forget(tenantId: string): void {
    this.observations.forget(tenantId)
    this.forgetChecks(tenantId)
  }

  private forgetChecks(tenantId: string): void {
    for (const lane of ["admin", "reader"]) this.checkedAt.delete(`${tenantId.toLowerCase()}|${lane}`)
  }

  private adminKey(tenant: string): ConnectionKey | null {
    const connected = this.host.tenant(tenant)
    return connected && { tenantId: tenant, clientId: connected.clientId, mode: "delegated" }
  }

  private async observe(tenant: string, reader: boolean): Promise<ConnectionHealthReport> {
    const connected = this.host.tenant(tenant)
    if (!connected) throw new Error("Connect this tenant first.")
    const key: ConnectionKey = { tenantId: tenant, clientId: connected.clientId, mode: "delegated" }
    await Promise.all([
      this.observeToken(key, "graph"),
      connected.storage === "azure" ? this.observeToken(key, "storage") : undefined,
      reader ? this.observeReader(tenant) : undefined,
    ])
    this.checkedAt.set(`${tenant}|${reader ? "reader" : "admin"}`, this.now().getTime())
    this.keepBaseline(tenant)
    this.host.changed?.(tenant)
    return this.report(tenant)
  }

  /**
   * One token request for a check, and what came of it. The time kept is when the answer came
   * back, never a time from inside the token. A token MSAL took from its cache was not issued for
   * this check, so nothing is kept for it and the last real answer stands.
   */
  private async observeToken(key: ConnectionKey, resource: "graph" | "storage"): Promise<void> {
    const account = this.host.account(key.tenantId) ?? undefined
    try {
      const token = await answered(this.host.token(key.tenantId, key.clientId, resource))
      if (token.fromCache !== false) return
      const granted = grantedPermissions(token.accessToken)
      this.observations.recordToken(key, resource, { at: this.now().toISOString(), ...(granted ? { permissions: [...granted.permissions].sort() } : {}) }, account)
    } catch (error) {
      this.observations.recordToken(key, resource, { at: this.now().toISOString(), failure: signInFailure(error) }, account)
    }
  }

  /** The Backup Reader's facts on this device, and for a verified reader the answer to a new token request. */
  private async observeReader(tenant: string): Promise<void> {
    const reader = this.host.reader(tenant)
    if (!reader?.clientId) return
    const key: ConnectionKey = { tenantId: tenant, clientId: reader.clientId, mode: "app-only" }
    this.observations.recordReader(key, { ...reader.facts, at: this.now().toISOString() })
    if (reader.facts.state !== "verified") return
    try {
      const token = await answered(this.host.readerToken(tenant))
      if (token === null) return
      const granted = grantedPermissions(token)
      this.observations.recordToken(key, "graph", { at: this.now().toISOString(), ...(granted ? { permissions: [...granted.permissions].sort() } : {}) })
    } catch (error) {
      this.observations.recordToken(key, "graph", { at: this.now().toISOString(), failure: signInFailure(error) })
    }
  }

  private evaluate(tenant: string): HealthEvaluation {
    const connected = this.host.tenant(tenant)
    const reader = this.host.reader(tenant)
    const now = this.now()
    return evaluateHealth(
      {
        tenantId: tenant,
        clientId: connected?.clientId ?? "",
        ...(reader?.clientId ? { readerClientId: reader.clientId } : {}),
        // Read from this device at the moment of the report, so a renewed or removed reader shows without a check.
        reader: reader ? { ...reader.facts, at: now.toISOString() } : null,
        storage: connected?.storage ?? "local",
        settings: this.host.settings(tenant),
        connections: connected ? this.observations.connections(tenant) : [],
      },
      now,
    )
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
