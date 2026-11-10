import { readTenantTrials, TENANT_TRIAL_STATE_KEY, type StoredTenantTrial, type TrialTally } from "./tenant-trial-state"
import { CommunityChoicePendingError, CommunityLimitError } from "../../shared/plan-errors"
import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto"
import type { LicenseStatus, TenantLicenseStatus } from "../../shared/ipc"
import { TRIAL_USED_MESSAGE } from "../../shared/constants"
import { FEATURE_PLAN, type Feature, type Plan } from "../../shared/plans"
import { networkFailure } from "../api/network-error"
import type { KeyValueStore } from "../storage/secure-store"

/**
 * Online activated, offline verified licensing.
 *
 * The app never talks to Polar. It calls the TenuVault licensing service
 * (`<apiBase>/api/desktop-license/{activate,refresh,deactivate,tenant}`), which checks the
 * license key with Polar and answers with an entitlement token signed with Ed25519. The
 * token is bound to one tenant and to this installation, verified offline with the public
 * key built into the app, refreshed every few hours and honoured offline until it expires.
 *
 * TenuVault works with several tenants at once, so every tenant gets its own activation:
 * one Polar activation per (installation, tenant) pair, created the first time the tenant
 * is used. The service decides whether the key covers another tenant (Pro: two tenants,
 * MSP: the subscription quantity) and limits each tenant to five installations.
 */

interface Entitlement {
  v: 1 | 2
  sub: string
  act: string
  plan: "pro" | "msp"
  tenantId: string
  installId: string
  tenants: number
  status: "granted"
  iat: number
  exp: number
  /** Version 2: license key expiry in Unix seconds, absent for renewing subscriptions. */
  keyExp?: number
  /** Version 2: the key is a no-card trial key. */
  trial?: true
  /** Server-issued internal CIS claim for a validated internal license on an allowlisted installation. It enables Build Kit import only. */
  cis?: "internal"
}

// An activation either comes from this machine's license key, or, with source "tenant",
// from the organization license the key holder shared with the tenant; those are checked
// with a Microsoft ID token and the key never reaches this machine.
interface StoredActivation {
  activationId: string
  token: string
  source?: "tenant" | "trial"
  canEnd?: boolean
  // Key activations: whether the service last confirmed the license as shared with the
  // tenant's other admins.
  shared?: boolean
  // Key activations: the service could not share the license because the request lacked
  // a fresh sign-in to the tenant.
  shareNeedsSignIn?: true
  // Tenant activations: the masked key, for display.
  displayKey?: string
  // Tenant activations: the Polar id of that key (never the key itself), so the
  // activation can be released after the tenant stops sharing it.
  licenseKeyId?: string
}

// One activation per tenant, keyed by lowercase tenant id. seen is the latest wall clock
// time (ms) the app has observed.
interface StoredLicense {
  key?: string
  /** Last confirmed key refusal, retained when a tenant falls back to Community. */
  keyFailure?: string
  activations: Record<string, StoredActivation>
  seen?: number
  /**
   * The latest entitlement token of this machine's no-card trial key. Kept after the trial
   * ends and its activations are dropped, so Buy Pro can create the checkout for the trial's
   * customer and the app can say the trial ended. Removed once a key that is not a trial key
   * is activated.
   */
  trialToken?: string
  /**
   * Activations of keys this machine replaced, still to be released, one entry per replaced
   * key. Written together with the new key, before anything is released, so a crash or failed
   * write during a key replacement always leaves either the previous key with its activations
   * or the new key with its own on disk. Releasing is retried after the next refresh until the
   * service confirms it.
   */
  pendingRelease?: { key: string; activationIds: string[] }[]
}

/** A recent Microsoft ID token for the tenant, or null when none can be had silently. */
export type IdTokenProvider = (tenantId: string) => Promise<string | null>
/** The app registration client ID the tenant is signed in with, or null when it is not signed in. */
export type ClientIdProvider = (tenantId: string) => string | null

export interface LicenseServiceOptions {
  /** The app's encrypted store (SecureStore). */
  store: KeyValueStore
  /** False when OS encryption is unavailable: the license then lives in memory only. */
  persist: boolean
  /**
   * Ed25519 public keys (SPKI PEM) that verify entitlement tokens: the current key, and during
   * a signing key rotation the other key as well (see the rotation runbook in
   * docs/release-setup.md). A token signed by any of them verifies.
   */
  publicKey: string | readonly string[]
  /** Origin of the licensing service, such as https://www.tenuvault.com. */
  apiBase: string
  appVersion: string
  platform?: string
  idToken?: IdTokenProvider
  clientId?: ClientIdProvider
  /** Whether the tenant is still saved or has a new sign-in being added. */
  tenantPresent?: (tenantId: string) => boolean
  connectedTenantIds?: () => string[]
  initialTenantIds?: string[]
  fetch?: typeof fetch
  /** Called after the stored license or a tenant's license message changed. */
  onChange?: () => void
}

// The licensing service refused (HTTP 403). Anything else, including 5xx and network
// errors, is treated as "unreachable" and never drops a cached token.
export class LicenseDenied extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly trialUnavailable = false,
  ) {
    super(message)
    this.name = "LicenseDenied"
  }
}

// A request whose key, activation or tenant no longer matches cannot write state.
class StaleLicenseRequest extends Error {
  constructor() {
    super("The license state changed. Retry the request.")
  }
}

// No Microsoft ID token for the tenant could be had without user interaction.
class NoIdToken extends Error {
  constructor() {
    super("Sign in to this tenant again to check your organization's license.")
  }
}

// Community is free for one tenant: the first tenant used without a license.
const COMMUNITY_KEY = "license.communityTenant"
const COMMUNITY_ELIGIBILITY_KEY = "license.communityEligibility"
// A Community tenant is checked for a new license (a key or an organization license) at
// most this often, unless the admin asks.
export const COMMUNITY_RECHECK_MS = 6 * 60 * 60_000
// Refusals that mean the license ended, so the tenant falls back to Community.
const LAPSED = new Set(["not_found", "revoked", "disabled", "expired", "tenant_not_licensed", "activation_mismatch"])

export const communityLimit = (tenantId: string) =>
  `TenuVault Community covers one tenant, and it is used for tenant ${tenantId}. Add a Pro or MSP license on the License page to use more tenants.`

export const LICENSE_REQUIRED =
  "A TenuVault license is required for this tenant. Add your license key on the License page, or start a free trial."

const TRIAL_REASONS: Record<string, string> = {
  used: "This tenant already had a Pro trial.",
  licensed: "This tenant already has an organization license.",
  install_limit: "This installation has already started its available tenant trials.",
  disabled: "Tenant trials are currently unavailable.",
  app_update_required: "Update TenuVault to start a tenant trial.",
  not_starter: "Only the installation that started this trial can end it.",
}

const REASONS: Record<string, string> = {
  invalid_key: "This license key is not valid for TenuVault.",
  trial_used: TRIAL_USED_MESSAGE,
  not_found:
    "This license key is not valid, or it has been revoked or has expired. Check your subscription in the customer portal.",
  revoked: "This license has been revoked. Check your subscription.",
  disabled: "This license key has been disabled.",
  expired: "This license key has expired.",
  tenant_limit:
    "This license already covers its maximum number of tenants. Upgrade, or remove a tenant from TenuVault on the machine that uses it.",
  install_limit:
    "This tenant already has 5 active installations. Deactivate one in the app or the customer portal.",
  activation_limit:
    "This license has no activations left. Deactivate an installation in the customer portal.",
  activation_mismatch:
    "This installation is no longer activated. It activates again the next time the tenant is used.",
  tenant_not_licensed: "Your organization has no license for this tenant.",
}

/** The refusal reasons this app knows (test/fixtures/license-contract.json lists the service's). */
export const LICENSE_REFUSAL_REASONS: readonly string[] = Object.keys(REASONS)

// How far the clock may move back (an NTP correction, a restored VM snapshot, a time zone
// or RTC mix-up) before cached tokens stop counting offline. A larger rollback could
// otherwise keep an expired token alive indefinitely; this bounds that to two days past expiry.
export const CLOCK_TOLERANCE_MS = 48 * 60 * 60_000
// The high-water mark is written at most this often outside other saves.
const SEEN_PERSIST_MS = 60 * 60_000
// Token requests arrive in bursts. After a failed activation the same error is returned
// for this long instead of calling the licensing service again; user actions skip it.
export const FAILURE_COOLDOWN_MS = 60_000

// One licensing request may wait this long for an answer. Activation on the service makes
// several sequential Polar calls (each allowed 10 seconds there, inside a 60 second route
// budget), so a 20 second desktop deadline used to abandon slow but healthy first activations
// that then completed on the server. 45 seconds covers the realistic slow path; the service
// keeps its end-to-end activation work inside this budget, and a retry with the same
// installation reuses an activation the server already created.
export const LICENSE_REQUEST_TIMEOUT_MS = 45_000

// The licensing service limits requests per IP address. Several admins behind one corporate
// NAT, or an MSP activating many tenants, can reach that limit, and the service then answers
// 429 with Retry-After. A request waits that long and retries, at most this many times and
// only while the wait is short, so a throttled batch completes without anyone entering the
// key again and a background refresh never hangs on a long wait.
export const THROTTLE_RETRIES = 2
export const THROTTLE_MAX_WAIT_MS = 20_000

const STATE_KEY = "license.state"
// Tenants removed from the app whose activation could not be released yet. Persisted
// beside the state so a restart cannot make the retained token usable again.
const REMOVED_TENANTS_KEY = "license.removedTenants"
const INSTALL_ID_KEY = "license.installId"
// Left behind by the offline TV1 license keys this service replaced.
const LEGACY_KEYS = ["license.key", "license.trialStartedAt", "license.lastSeenAt", "license.tenants"]

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Time and status checks for a token whose signature already verified.
export function entitlementCurrent(
  payload: Pick<Entitlement, "exp" | "status"> & Partial<Pick<Entitlement, "v" | "keyExp" | "trial">>,
  now: number,
  seen: number,
): boolean {
  return (
    payload.status === "granted" &&
    Number.isFinite(payload.exp) &&
    payload.exp * 1000 > now &&
    // A trial ends at its key expiry, also offline: a token refreshed in its last 14 days
    // must not carry Pro past day 30. Paid keys keep the offline grace of their token.
    !(payload.v === 2 && payload.trial === true && typeof payload.keyExp === "number" && payload.keyExp * 1000 <= now) &&
    seen - now <= CLOCK_TOLERANCE_MS
  )
}

function decodeToken(token: string, publicKeys: readonly KeyObject[]): Entitlement | null {
  try {
    // Stored state is only shape-checked on load, so a token can in principle be a non-string
    // here; that must read as "not valid", never throw into a license check.
    if (typeof token !== "string") return null
    const [body, signature, extra] = token.split(".")
    if (!body || !signature || extra !== undefined) return null
    const signed = Buffer.from(body)
    const signatureBytes = Buffer.from(signature, "base64url")
    if (!publicKeys.some((publicKey) => verify(null, signed, publicKey, signatureBytes))) return null
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Entitlement
    if (payload.v !== 1 && payload.v !== 2) return null
    // A renewing subscription has no key expiry: the server omits the field or sends null.
    if (payload.v === 2 && payload.keyExp === null) delete payload.keyExp
    if (payload.v === 2 && payload.keyExp !== undefined && (
      !Number.isFinite(payload.keyExp) || !Number.isFinite(new Date(payload.keyExp * 1000).getTime())
    )) return null
    if (payload.v === 2 && payload.trial !== undefined && payload.trial !== true) return null
    if (payload.v === 1) delete payload.trial
    if (payload.cis !== undefined && payload.cis !== "internal") return null
    return payload
  } catch {
    return null
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const TOKEN_SIGNATURE_PROBLEM =
  "The license could not be verified: it was not signed by the TenuVault licensing service this app trusts. Update TenuVault to the latest version and retry. If this keeps happening, a proxy or security product may be changing licensing responses."

const clockDate = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"

/**
 * Why a token is not usable here, in words the admin can act on: a wrong signer (an outdated
 * app, or something rewriting responses) is told apart from this computer's clock, since both
 * used to read as "could not be verified" and only the clock is fixed on the machine. The clock
 * is judged only for a token the service has just issued (fresh): a cached token that expired
 * after two weeks offline looks the same as a clock two weeks ahead. Null when nothing is wrong
 * with the token itself.
 */
export function tokenProblem(
  token: string,
  publicKeys: readonly KeyObject[],
  expected: { tenantId: string; installId: string; activationId: string },
  now: number,
  fresh: boolean,
): string | null {
  const payload = decodeToken(token, publicKeys)
  if (!payload) return TOKEN_SIGNATURE_PROBLEM
  if (payload.status !== "granted" || !Number.isFinite(payload.exp)) return TOKEN_SIGNATURE_PROBLEM
  if (!fresh) return null
  // A fresh token is valid for 14 days from the service's clock, so one that reads as expired
  // already says this computer's clock is at least that far ahead. A clock behind the service
  // does not block activation: tokens carry no not-before time.
  if (payload.exp * 1000 <= now) {
    return `This computer's clock is ahead: it shows ${clockDate(now)}, but the license was issued on ${clockDate(payload.iat * 1000)}. Set the correct date and time, then retry.`
  }
  if (payload.tenantId !== expected.tenantId || payload.installId !== expected.installId || payload.act !== expected.activationId) {
    return "The licensing service answered for a different tenant or installation. Retry; if this keeps happening, contact support."
  }
  return null
}

// Retry-After in milliseconds: delay seconds or an HTTP date. Null when absent or unreadable.
function retryAfterMs(value: string | null): number | null {
  if (!value) return null
  const text = value.trim()
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

export const TRIAL_END_NOTICE_DAYS = 60

export class LicenseService {
  private state: StoredLicense | null = null
  private trialPolicy: NonNullable<LicenseStatus["tenantTrialPolicy"]> = {}
  private trialsEnabled = false
  private healthCheckedAt = 0
  private healthCheck: Promise<void> | null = null
  private healthRetryAt = 0
  private healthFailures = 0
  private trialRecords: Record<string, StoredTenantTrial> = {}
  private keyMutation: Promise<void> | null = null
  private readonly tenantMutations = new Map<string, Promise<void>>()
  private readonly removedTenants = new Map<string, object>()
  private installId = ""
  private loaded = false
  private savedSeen = 0
  private message: string | null = null
  private offline = false
  private readonly messages = new Map<string, string>()
  private readonly failures = new Map<string, { error: unknown; until: number; key?: string }>()
  // Community tenants, until their next check for a license.
  private readonly community = new Map<string, number>()
  private readonly communityEligibility = new Map<string, string>()
  private readonly coverageEnds = new Map<string, number>()
  private readonly publicKeys: readonly KeyObject[]
  private readonly fetchImpl: typeof fetch
  private readonly idToken: IdTokenProvider
  private readonly clientId: ClientIdProvider

  constructor(private readonly options: LicenseServiceOptions) {
    const pems = typeof options.publicKey === "string" ? [options.publicKey] : options.publicKey
    if (pems.length === 0) throw new Error("A license verification key is required.")
    this.publicKeys = pems.map((pem) => createPublicKey(pem))
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.idToken = options.idToken ?? (async () => null)
    this.clientId = options.clientId ?? (() => null)
    this.trialRecords = readTenantTrials(options.store, options.initialTenantIds ?? options.connectedTenantIds?.() ?? [])
    this.saveTrials()
  }

  private saveTrials(): void {
    if (!this.options.persist) return
    if (Object.keys(this.trialRecords).length) this.options.store.set(TENANT_TRIAL_STATE_KEY, JSON.stringify(this.trialRecords))
    else this.options.store.delete(TENANT_TRIAL_STATE_KEY)
  }

  async checkTrialHealth(): Promise<void> {
    this.load()
    if (this.state?.key || Object.values(this.state?.activations ?? {}).some(entry => entry.source !== "trial")) return
    if (this.healthCheck) return this.healthCheck
    if (Date.now() < this.healthRetryAt || (this.healthCheckedAt && Date.now() - this.healthCheckedAt < COMMUNITY_RECHECK_MS)) return
    this.healthCheck = (async () => {
      try {
        const response = await this.fetchImpl(`${this.options.apiBase}/api/desktop-license/health`, { signal: AbortSignal.timeout(10_000), redirect: "error" })
        const data = await response.json()
        if (!response.ok || data?.tenantTrials?.ok !== true || typeof data.tenantTrials.enabled !== "boolean") throw new Error("Trial health is unavailable.")
        this.trialPolicy = {}
        for (const field of ["days", "extensionDays", "extensionWindowDays", "extensionGraceDays"] as const) {
          const value = data.tenantTrials[field]
          if (Number.isInteger(value) && value > 0 && value <= 365) this.trialPolicy[field] = value
        }
        this.trialsEnabled = data.tenantTrials.enabled === true
        this.healthCheckedAt = Date.now()
        this.healthRetryAt = 0
        this.healthFailures = 0
      } catch {
        this.trialsEnabled = false
        this.healthCheckedAt = 0
        this.healthFailures++
        this.healthRetryAt = Date.now() + Math.min(30 * 60_000, 2 * 60_000 * 2 ** Math.min(this.healthFailures - 1, 4))
      }
      this.options.onChange?.()
      if (this.trialsEnabled) void this.retryPendingTrials()
    })().finally(() => { this.healthCheck = null })
    return this.healthCheck
  }

  private async retryPendingTrials(): Promise<void> {
    for (const tenant of Object.keys(this.trialRecords)) {
      if (this.tenantPresent(tenant) && this.trialRecords[tenant]?.firstConnectedAt && !this.trialRecords[tenant]?.stopped) {
        await this.mutate([tenant], true, () => this.tryAutomaticTrial(tenant)).catch(() => undefined)
      }
    }
  }

  private clearTrialRefusal(tenant: string): void {
    const record = this.trialRecords[tenant]
    if (!record || ["used", "install_limit"].includes(record.refusalReason ?? "")) return
    delete record.refusal
    delete record.refusalReason
    delete record.refusalAt
    delete record.refusalVersion
  }

  private trialRefusal(tenant: string): string | undefined {
    const record = this.trialRecords[tenant]
    if (!record?.refusal) return undefined
    if (!["used", "install_limit"].includes(record.refusalReason ?? "") &&
      (record.refusalVersion !== this.options.appVersion || Date.now() - (record.refusalAt ?? 0) >= COMMUNITY_RECHECK_MS)) {
      this.clearTrialRefusal(tenant)
      this.saveTrials()
    }
    return record.refusal
  }

  private pruneTrialContacts(): void {
    let changed = false
    for (const record of Object.values(this.trialRecords)) {
      const payload = record.token ? decodeToken(record.token, this.publicKeys) : null
      const end = record.endedAt ?? record.trialEndsAt ?? (payload?.keyExp ? payload.keyExp * 1000 : undefined)
      if (record.email && end !== undefined && Date.now() > end + 14 * 86400_000) { delete record.email; changed = true }
    }
    if (changed) this.saveTrials()
  }

  private trialEnd(tenant: string): string | null {
    const record = this.trialRecords[tenant]
    const payload = record?.token ? decodeToken(record.token, this.publicKeys) : null
    return payload?.keyExp ? new Date((record?.endedAt ?? payload.keyExp * 1000)).toISOString() : null
  }

  private canExtendTrial(tenant: string): boolean {
    const record = this.trialRecords[tenant]
    const end = this.trialEnd(tenant)
    const remaining = end ? Date.parse(end) - Date.now() : NaN
    return Boolean(!this.state?.key && record?.activationId && !record.extended && !record.endedAt &&
      (!this.state?.activations[tenant] || this.state.activations[tenant]?.source === "trial") && remaining <= (this.trialsEnabled ? this.trialPolicy.extensionWindowDays ?? 5 : 5) * 86400_000 && remaining >= -(this.trialsEnabled ? this.trialPolicy.extensionGraceDays ?? 14 : 14) * 86400_000)
  }

  trialUsagePeriod(tenant: string): { since: number; until: number } | null {
    this.load()
    if (!this.trialsEnabled || this.state?.key) return null
    const record = this.trialRecords[tenant]
    const entry = this.state?.activations[tenant]
    if (entry && entry.source !== "trial") return null
    const payload = record?.token ? decodeToken(record.token, this.publicKeys) : null
    if (!record || !payload?.keyExp) return null
    if (record.trialFirstSeenAt === undefined) { record.trialFirstSeenAt = Date.now(); this.saveTrials() }
    const serverStart = this.trialPolicy.days && (!record.extended || this.trialPolicy.extensionDays)
      ? payload.keyExp * 1000 - (this.trialPolicy.days + (record.extended ? this.trialPolicy.extensionDays! : 0)) * 86400_000 : record.trialFirstSeenAt
    return { since: Math.max(record.trialFirstSeenAt, serverStart), until: record.endedAt ?? payload.keyExp * 1000 }
  }

  trialUsageTally(tenant: string): TrialTally {
    return this.trialUsagePeriod(tenant) ? { ...this.trialRecords[tenant]?.tally } : {}
  }

  /** TenuVault keeps a short tally of Pro features used during the trial on this computer to show it in the trial notices. It is never sent. */
  recordTrialUsage(tenantId: string, feature: Feature): void {
    this.load()
    const tenant = tenantId.toLowerCase()
    if (!this.trialsEnabled || this.state?.key || FEATURE_PLAN[feature] !== "pro" || this.state?.activations[tenant]?.source !== "trial" || !this.valid(tenant) || !this.tenantPresent(tenant)) return
    const record = this.trialRecords[tenant]
    if (!record) return
    const fields: Partial<Record<Feature, keyof TrialTally>> = { dailySchedule: "dailyBackups", azureStorage: "azureBackups", fullRestore: "fullRestores", replaceRestore: "fullRestores", restoreAssignments: "fullRestores", driftRevert: "driftReverts" }
    const field = fields[feature]
    if (!field) return
    record.tally ??= {}
    record.tally[field] = Math.min(Number.MAX_SAFE_INTEGER, (record.tally[field] ?? 0) + 1)
    try { this.saveTrials() } catch { /* A tally never changes a completed action. */ }
  }

  notifyTrials(notify: (tenantId: string, ended: boolean, end: number, canExtend: boolean) => boolean): void {
    this.load()
    if (!this.trialsEnabled || this.state?.key) return
    for (const [tenant, record] of Object.entries(this.trialRecords)) {
      if (!this.tenantPresent(tenant) || record.endedAt) continue
      const entry = this.state?.activations[tenant]
      if (entry && entry.source !== "trial") continue
      const end = Date.parse(this.trialEnd(tenant) ?? "")
      if (!Number.isFinite(end) || end - Date.now() > 86400_000) continue
      const ended = end <= Date.now()
      if (ended && Date.now() - end > TRIAL_END_NOTICE_DAYS * 86400_000) continue
      const field = ended ? "endedNoticeEnd" : "dayNoticeEnd"
      if (record[field] === end) continue
      if (notify(tenant, ended, end, this.canExtendTrial(tenant))) {
        record[field] = end
        this.saveTrials()
      }
    }
  }

  private rememberTrial(tenant: string, data: Record<string, unknown>): void {
    this.trialRecords[tenant] = { ...this.trialRecords[tenant], stopped: true, trialFirstSeenAt: this.trialRecords[tenant]?.trialFirstSeenAt ?? Date.now(), trialEndsAt: Number(data.keyExp) * 1000, activationId: String(data.activationId), token: String(data.token), canEnd: data.canEnd === true }
    this.saveTrials()
    this.community.delete(tenant)
  }

  private async tryAutomaticTrial(tenant: string): Promise<void> {
    const record = this.trialRecords[tenant]
    if (!record?.firstConnectedAt || record.stopped) return
    if (Date.now() - record.firstConnectedAt > 72 * 3600_000) { record.stopped = true; this.saveTrials(); return }
    if (this.state?.key || this.state?.activations[tenant]) { record.stopped = true; this.saveTrials(); return }
    if (record.lastAttemptAt && Date.now() - record.lastAttemptAt < FAILURE_COOLDOWN_MS) return
    if (this.trialsEnabled) {
      record.lastAttemptAt = Date.now()
      this.saveTrials()
      try {
        await this.activateTenant(tenant)
        record.stopped = true
        this.saveTrials()
        return
      } catch (error) {
        if (!(error instanceof LicenseDenied) || error.reason !== "tenant_not_licensed") return
      }
      await this.startTenantTrialCurrent(tenant, "auto")
    }
  }

  async startTenantTrial(tenantId: string): Promise<void> {
    this.load()
    const tenant = tenantId.toLowerCase()
    return this.mutate([tenant], true, async () => {
      await this.checkTrialHealth()
      if (!this.trialsEnabled) throw new Error("Tenant trials are currently unavailable. Try again later.")
      if (this.state?.key || this.state?.activations[tenant]) throw new Error("Check the saved license before starting a trial.")
      try { await this.activateTenant(tenant); return } catch (error) {
        if (!(error instanceof LicenseDenied) || error.reason !== "tenant_not_licensed") throw error
      }
      await this.startTenantTrialCurrent(tenant, "opt-in")
    })
  }

  private async startTenantTrialCurrent(tenant: string, source: "auto" | "opt-in"): Promise<void> {
    if (this.state?.key || this.state?.activations[tenant]) return
    const current = this.requestGuard(tenant)
    try {
      const data = await this.tenantCall(tenant, "start_trial", current, undefined, undefined, { source })
      const payload = typeof data.token === "string" ? decodeToken(data.token, this.publicKeys) : null
      if (!this.usableActivation(tenant, data) || data.source !== "trial" || data.trial !== true || typeof data.canEnd !== "boolean" || payload?.trial !== true || payload.plan !== "pro" || !payload.sub.startsWith("trial:") || payload.keyExp !== data.keyExp) {
        throw new LicenseDenied("A Pro trial is unavailable for this tenant.", "unknown_action")
      }
      this.accept(tenant, data, "trial")
      this.rememberTrial(tenant, data)
    } catch (error) {
      if (error instanceof LicenseDenied) {
        this.trialRecords[tenant] = { ...this.trialRecords[tenant], stopped: ["used", "licensed", "install_limit"].includes(error.reason), refusal: error.message, refusalReason: error.reason, refusalAt: Date.now(), refusalVersion: this.options.appVersion }
        if (["disabled", "app_update_required", "unknown_action"].includes(error.reason)) {
          this.trialsEnabled = false
          this.healthCheckedAt = 0
          this.healthRetryAt = Date.now() + 2 * 60_000
        }
        this.saveTrials()
      }
      if (source === "opt-in") throw error
    }
  }

  async tenantTrialAction(tenantId: string, action: "extend_trial" | "end_trial" | "trial_contact" | "acknowledge", email?: string): Promise<void> {
    this.load()
    const tenant = tenantId.toLowerCase()
    return this.mutate([tenant], true, async () => {
      const record = this.trialRecords[tenant]
      if (!record?.activationId) throw new Error("No tenant trial is saved.")
      if (action === "acknowledge") { if (this.valid(tenant)) record.acknowledged = true; else record.endedAcknowledged = true; this.saveTrials(); this.options.onChange?.(); return }
      if (action === "end_trial" && !record.canEnd) throw new Error("Only the installation that started this trial can end it.")
      if (action === "extend_trial" && !this.canExtendTrial(tenant)) throw new Error("This trial cannot be extended now.")
      const current = this.requestGuard(tenant)
      try {
        const data = await this.tenantCall(tenant, action, current, { activationId: record.activationId }, undefined, email === undefined ? {} : { email })
        if (action === "extend_trial") {
          this.accept(tenant, data, "trial")
          this.rememberTrial(tenant, data)
          this.trialRecords[tenant]!.extended = true
        } else if (action === "end_trial") {
          this.confirmCommunity(tenant)
          if (this.state) delete this.state.activations[tenant]
          record.endedAcknowledged = true
          record.endedAt = Date.now()
          record.stopped = true
          this.save()
          this.community.delete(tenant)
          try { this.useCommunity(tenant) } catch (error) { if (!(error instanceof CommunityChoicePendingError) && !(error instanceof CommunityLimitError)) throw error }
        } else record.email = email
      } catch (error) {
        if (action === "extend_trial" && error instanceof LicenseDenied && error.trialUnavailable && error.reason === "used") {
          record.extended = true
          this.saveTrials()
          throw new Error("This trial cannot be extended.")
        }
        throw error
      } finally { this.saveTrials(); this.options.onChange?.() }
    })
  }

  private get platform(): string {
    return this.options.platform ?? process.platform
  }

  // The proof of the tenant the service needs to share the license with it: the app
  // registration and a fresh sign-in to it. Not needed to stop sharing. Without it the
  // service still licenses this machine but leaves the sharing unchanged.
  private async sharingFields(tenantId: string, share?: boolean): Promise<{ clientId?: string; idToken?: string }> {
    const clientId = this.clientId(tenantId)?.toLowerCase()
    if (share === false || !clientId || !guidPattern.test(clientId)) return {}
    const idToken = await this.idToken(tenantId)
    return idToken ? { clientId, idToken } : { clientId }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const { store } = this.options
    for (const key of LEGACY_KEYS) if (store.get(key) !== null) store.delete(key)

    const stored = store.get(INSTALL_ID_KEY)?.trim() ?? ""
    if (guidPattern.test(stored)) {
      this.installId = stored
    } else {
      this.installId = randomUUID()
      store.set(INSTALL_ID_KEY, this.installId)
    }
    if (!this.options.persist) return

    try {
      const eligible: unknown = JSON.parse(store.get(COMMUNITY_ELIGIBILITY_KEY) ?? "{}")
      if (eligible && typeof eligible === "object" && !Array.isArray(eligible)) {
        for (const [id, key] of Object.entries(eligible)) {
          if (guidPattern.test(id) && typeof key === "string" && /^(none|[a-f0-9]{64})$/.test(key)) this.communityEligibility.set(id, key)
        }
      }
    } catch { /* A damaged local marker must not grant coverage or break a license check. */ }
    const removed = store.get(REMOVED_TENANTS_KEY)
    if (removed) {
      try {
        const parsed = JSON.parse(removed) as unknown
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry === "string" && guidPattern.test(entry.toLowerCase())) {
              this.removedTenants.set(entry.toLowerCase(), {})
            }
          }
        }
      } catch {
        /* A corrupt marker list must not break licensing; activations stay bound to this installation. */
      }
    }

    const text = store.get(STATE_KEY)
    if (!text) return
    // Only the reason is logged, never the content.
    try {
      const parsed = JSON.parse(text) as Partial<StoredLicense> | null
      if (
        parsed &&
        (parsed.key === undefined || typeof parsed.key === "string") &&
        typeof parsed.activations === "object" &&
        parsed.activations !== null
      ) {
        this.state = parsed as StoredLicense
        // Keep only well-formed activations under their lowercase tenant id. A damaged entry
        // must read as "not licensed" for that tenant, never break every license check.
        const activations: Record<string, StoredActivation> = {}
        for (const [tenantId, entry] of Object.entries(this.state.activations)) {
          if (
            entry &&
            typeof entry === "object" &&
            typeof entry.activationId === "string" &&
            entry.activationId !== "" &&
            typeof entry.token === "string" &&
            entry.token !== "" &&
            (entry.source === undefined || entry.source === "tenant" || entry.source === "trial")
          ) {
            activations[tenantId.toLowerCase()] = entry
          } else {
            console.warn("[license] Stored activation dropped: invalid entry")
          }
        }
        this.state.activations = activations
        if (typeof this.state.keyFailure !== "string" || !Object.hasOwn(REASONS, this.state.keyFailure)) delete this.state.keyFailure
        if (!Number.isFinite(this.state.seen)) delete this.state.seen
        if (typeof this.state.trialToken !== "string") delete this.state.trialToken
        const pending: unknown = this.state.pendingRelease
        const releases = Array.isArray(pending)
          ? pending.filter((entry: Partial<{ key: unknown; activationIds: unknown }> | null) =>
            entry && typeof entry.key === "string" && entry.key !== "" &&
            Array.isArray(entry.activationIds) && entry.activationIds.length > 0 &&
            entry.activationIds.every((id) => typeof id === "string" && id !== "")) as NonNullable<StoredLicense["pendingRelease"]>
          : []
        if (releases.length > 0) this.state.pendingRelease = releases
        else delete this.state.pendingRelease
        this.savedSeen = this.state.seen ?? 0
        return
      }
      console.warn("[license] Stored license ignored: invalid format")
    } catch {
      console.warn("[license] Stored license ignored: invalid JSON")
    }
  }

  // Reserve all chains together, so a key reset can wait for tenant checks without
  // holding one mutex while acquiring another. This machine has one saved key slot.
  private mutate<T>(tenants: string[], key: boolean, action: () => Promise<T>): Promise<T> {
    const ids = [...new Set(tenants)]
    const preceding = ids.map((id) => this.tenantMutations.get(id) ?? Promise.resolve())
    if (key && this.keyMutation) preceding.push(this.keyMutation)
    const result = Promise.all(preceding).then(action)
    const tail = result.then(() => undefined, () => undefined)
    if (key) this.keyMutation = tail
    for (const id of ids) this.tenantMutations.set(id, tail)
    void tail.then(() => {
      if (this.keyMutation === tail) this.keyMutation = null
      for (const id of ids) if (this.tenantMutations.get(id) === tail) this.tenantMutations.delete(id)
    })
    return result
  }

  private tenantPresent(tenantId: string): boolean {
    return !this.removedTenants.has(tenantId.toLowerCase()) && (this.options.tenantPresent?.(tenantId) ?? true)
  }

  private persistRemovedTenants(): void {
    if (!this.options.persist) return
    try {
      const removed = [...this.removedTenants.keys()]
      if (removed.length > 0) this.options.store.set(REMOVED_TENANTS_KEY, JSON.stringify(removed))
      else this.options.store.delete(REMOVED_TENANTS_KEY)
    } catch {
      /* The in-memory marker still applies for this session. */
    }
  }

  // Bind writes to the actual saved key and activation, independently of other tenants.
  // Releases also work after removal, while activation and Community writes require presence.
  private requestGuard(tenantId: string, requirePresent = true): () => boolean {
    const key = this.state?.key
    const activationId = this.state?.activations[tenantId]?.activationId
    return () => key === this.state?.key && activationId === this.state?.activations[tenantId]?.activationId &&
      (!requirePresent || this.tenantPresent(tenantId))
  }

  private assertCurrent(current: () => boolean): void {
    if (!current()) throw new StaleLicenseRequest()
  }

  // Refuses to write the key in plaintext: without OS encryption the license lives in
  // memory only and must be entered again after a restart.
  private save(): void {
    if (this.options.persist) {
      if (this.state) this.options.store.set(STATE_KEY, JSON.stringify(this.state))
      else this.options.store.delete(STATE_KEY)
      this.savedSeen = this.state?.seen ?? 0
    }
    this.notify()
  }

  // Only a failed write is a failed save: a listener that throws must not make a caller undo
  // state that is already on disk, or interrupt a rollback.
  private notify(): void {
    try {
      this.options.onChange?.()
    } catch (error) {
      console.warn(`[license] Change notification failed: ${errorText(error)}`)
    }
  }

  // Advances the high-water mark of observed time and returns the current time.
  private observe(): number {
    const now = Date.now()
    if (this.state && now > (this.state.seen ?? 0)) this.state.seen = now
    return now
  }

  // Persists the mark now and then, so a restart with a clock set back still sees it.
  // Failures only cost precision.
  private keepSeen(): void {
    const seen = this.state?.seen ?? 0
    if (!this.options.persist || seen - this.savedSeen < SEEN_PERSIST_MS) return
    try {
      this.options.store.set(STATE_KEY, JSON.stringify(this.state))
      this.savedSeen = seen
    } catch {
      /* best effort */
    }
  }

  private valid(tenantId: string | null): Entitlement | null {
    if (!tenantId || !this.state) return null
    const tenant = tenantId.toLowerCase()
    const entry = this.state.activations[tenant]
    if (!entry) return null
    const payload = decodeToken(entry.token, this.publicKeys)
    const now = this.observe()
    if (
      !payload ||
      !entitlementCurrent(payload, now, this.state.seen ?? now) ||
      payload.tenantId !== tenant ||
      payload.installId !== this.installId ||
      payload.act !== entry.activationId
    ) {
      return null
    }
    return payload
  }

  /** Accepts only licensing responses; network intermediaries must not revoke cached access. */
  private async call(
    action: "activate" | "refresh" | "deactivate" | "tenant",
    body: object,
    current: () => boolean,
  ): Promise<Record<string, unknown>> {
    this.assertCurrent(current)
    let response: Response
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetchImpl(`${this.options.apiBase}/api/desktop-license/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          // The body carries the license key or a Microsoft ID token: a 307 or
          // 308 redirect would replay it to whatever origin the response names.
          redirect: "error",
          signal: AbortSignal.timeout(LICENSE_REQUEST_TIMEOUT_MS),
        })
        this.assertCurrent(current)
      } catch (error) {
        this.assertCurrent(current)
        this.offline = true
        console.warn(`[license] Licensing service unreachable (${action})`)
        const { code, guidance } = networkFailure(error, new URL(this.options.apiBase).host)
        throw new Error(`The licensing service could not be reached. ${guidance}${code ? ` (${code})` : ""}`)
      }
      if (response.status !== 429) break
      const wait = retryAfterMs(response.headers.get("retry-after"))
      if (wait === null || wait > THROTTLE_MAX_WAIT_MS || attempt >= THROTTLE_RETRIES) {
        this.assertCurrent(current)
        this.offline = true
        console.warn(`[license] ${action} throttled`)
        const after = wait === null ? "a minute"
          : wait < 60_000 ? `${Math.max(1, Math.ceil(wait / 1000))} seconds`
            : `${Math.ceil(wait / 60_000)} minutes`
        throw new Error(`The licensing service is busy with many requests from your network. Try again in ${after}.`)
      }
      await response.body?.cancel().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, wait))
      this.assertCurrent(current)
    }
    // A proxy or captive portal can answer with an HTML 401/403 page. It is
    // not a license refusal and must never remove a cached activation.
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
    const data: unknown = contentType === "application/json" ? await response.json().catch(() => null) : null
    this.assertCurrent(current)
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      this.offline = true
      throw new Error("The licensing service returned an unexpected response. Check for a firewall block or network sign-in page and retry.")
    }
    const result = data as Record<string, unknown>
    const trialAction = action === "tenant" && ["start_trial", "extend_trial", "end_trial", "trial_contact"].includes(String((body as Record<string, unknown>).action))
    if (trialAction && response.status === 400) {
      this.trialsEnabled = false
      throw new LicenseDenied("Tenant trials require an updated licensing service.", "unknown_action")
    }
    if (trialAction && response.status === 403 && result.error === "trial_unavailable") {
      const reason = typeof result.reason === "string" ? result.reason : "unavailable"
      throw new LicenseDenied(TRIAL_REASONS[reason] ?? "A Pro trial is unavailable for this tenant.", reason, true)
    }
    const deactivating = action === "deactivate" || (action === "tenant" && ["deactivate", "end_trial", "trial_contact"].includes(String((body as Record<string, unknown>).action)))
    const validSuccess = deactivating
      ? result.success === true
      : typeof result.token === "string" && typeof result.activationId === "string"
    if (response.ok && !validSuccess) {
      if (trialAction) throw new LicenseDenied("A Pro trial is unavailable for this tenant.", "unknown_action")
      this.offline = true
      throw new Error("The licensing service returned an invalid response. Check for a firewall block or network sign-in page and retry.")
    }
    const reason = typeof result.reason === "string" ? result.reason.slice(0, 40) : undefined
    if ((response.status === 401 && reason !== "invalid_token") ||
      (response.status === 403 && (!reason || !Object.hasOwn(REASONS, reason)))) {
      this.offline = true
      throw new Error("The licensing service could not confirm this request. Check your network or proxy and retry.")
    }
    // Like a network failure, any refusal other than 403 and 401 means the service could
    // not answer the request.
    this.offline = !response.ok && response.status !== 403 && response.status !== 401
    if (!response.ok) console.warn(`[license] ${action} answered ${response.status}${reason ? ` (${reason})` : ""}`)
    if (response.status === 403) {
      throw new LicenseDenied(REASONS[reason ?? ""] ?? "The license was not accepted.", reason ?? "")
    }
    // The organization license route could not verify the Microsoft sign-in.
    if (response.status === 401) {
      throw new Error("Your Microsoft sign-in could not be verified by the licensing service. Sign in again and retry.")
    }
    if (!response.ok) {
      throw new Error(
        reason === "tenant_quantity_unknown"
          ? "The tenant quantity of this subscription could not be read. Please try again later or contact support."
          : "The licensing service is unavailable. Please try again later.",
      )
    }
    return result
  }

  // Stores the activation the service returned, after verifying its token. persist false leaves
  // writing the state to the caller, which saves several activations at once.
  private accept(tenantId: string, data: Record<string, unknown>, source: "key" | "tenant" | "trial", persist = true): void {
    if (typeof data.token !== "string" || typeof data.activationId !== "string") {
      throw new Error("The licensing service returned an invalid response.")
    }
    if (source === "trial") {
      const payload = decodeToken(data.token, this.publicKeys)
      if (data.source !== "trial" || data.trial !== true || typeof data.canEnd !== "boolean" || payload?.v !== 2 || payload.trial !== true || payload.plan !== "pro" || !payload.sub.startsWith("trial:") || payload.keyExp !== data.keyExp || !/^trial-[a-f0-9]{32}$/.test(data.activationId)) throw new Error("The licensing service returned an invalid trial response.")
    }
    const hadState = this.state !== null
    this.state ??= { activations: {} }
    // Verify the new token before it replaces the cached one: a response that fails
    // verification must not cost a still valid activation. A mark ahead of both the clock
    // and the server's issue time came from a clock that once ran ahead, so it comes down
    // to the later of the two.
    const previous = this.state.activations[tenantId]
    const previousSeen = this.state.seen
    const issued = (decodeToken(data.token, this.publicKeys)?.iat ?? NaN) * 1000
    const now = Date.now()
    this.state.seen = Math.min(previousSeen ?? now, Number.isFinite(issued) ? Math.max(now, issued) : now)
    // shared is left out of a response when the service could not update it, and is false
    // without sharing being changed when the request lacked a sign-in; either way the last
    // confirmed value stands.
    const shareNeedsSignIn = data.sharedReason === "sign_in_required"
    const shared =
      typeof data.shared === "boolean" && !shareNeedsSignIn
        ? data.shared
        : previous?.source === undefined
          ? previous?.shared
          : undefined
    this.state.activations[tenantId] = {
      activationId: data.activationId,
      token: data.token,
      ...(source === "trial" ? { source, canEnd: data.canEnd === true } : source === "tenant"
        ? {
            source,
            ...(typeof data.displayKey === "string" ? { displayKey: data.displayKey.slice(0, 20) } : {}),
            ...(typeof data.licenseKeyId === "string" && guidPattern.test(data.licenseKeyId)
              ? { licenseKeyId: data.licenseKeyId }
              : {}),
          }
        : {
            ...(shared !== undefined ? { shared } : {}),
            ...(shareNeedsSignIn ? { shareNeedsSignIn: true as const } : {}),
          }),
    }
    if (!this.valid(tenantId)) {
      if (!hadState) this.state = null
      else {
        if (previous) this.state.activations[tenantId] = previous
        else delete this.state.activations[tenantId]
        this.state.seen = previousSeen
      }
      throw new Error(this.problemOf(tenantId, data.token, data.activationId))
    }
    this.message = null
    this.clearTrialRefusal(tenantId)
    const previousTrial = this.trialRecords[tenantId]
    if (source !== "trial" && previousTrial?.activationId) {
      previousTrial.trialEndsAt ??= previousTrial.token ? (decodeToken(previousTrial.token, this.publicKeys)?.keyExp ?? 0) * 1000 : undefined
      delete previousTrial.token
      delete previousTrial.activationId
      previousTrial.refusal = TRIAL_REASONS.used
      previousTrial.refusalReason = "used"
      previousTrial.stopped = true
      this.saveTrials()
    }
    if (source === "trial" && this.options.store.get(COMMUNITY_KEY) === tenantId) this.options.store.delete(COMMUNITY_KEY)
    if (source === "key") {
      delete this.state.keyFailure
      const payload = decodeToken(data.token, this.publicKeys)
      if (payload?.v === 2 && payload.trial === true && typeof payload.keyExp === "number") {
        const kept = this.state.trialToken ? decodeToken(this.state.trialToken, this.publicKeys) : null
        if (!kept || kept.sub !== payload.sub || kept.iat <= payload.iat) this.state.trialToken = data.token
      } else {
        delete this.state.trialToken
      }
    }
    this.messages.delete(tenantId)
    this.failures.delete(tenantId)
    if (this.communityEligibility.delete(tenantId)) this.persistCommunityEligibility()
    if (persist) this.save()
  }

  private clearTrialKeyRefusals(): void {
    for (const [tenant, failure] of this.failures) if (failure.error instanceof LicenseDenied && failure.error.reason === "trial_used") {
      this.failures.delete(tenant)
      this.messages.delete(tenant)
    }
  }

  private async activate(tenantId: string): Promise<void> {
    if (!this.state?.key) throw new Error("Enter a license key first.")
    const refusal = this.failures.get(tenantId)
    if (refusal?.error instanceof LicenseDenied && refusal.error.reason === "trial_used" && refusal.key === this.state.key && refusal.until > Date.now()) throw refusal.error
    const current = this.requestGuard(tenantId)
    const key = this.state.key
    const data = await this.call("activate", {
      key,
      installId: this.installId,
      tenantId,
      os: this.platform,
      appVersion: this.options.appVersion,
      ...(await this.sharingFields(tenantId)),
    }, current).catch((error: unknown) => {
      if (error instanceof LicenseDenied && error.reason === "trial_used" && current()) this.failures.set(tenantId, { error, until: Date.now() + FAILURE_COOLDOWN_MS, key })
      throw error
    })
    this.assertCurrent(current)
    this.accept(tenantId, data, "key")
  }

  // A request to the organization license route. Throws when no ID token for the tenant
  // can be had silently.
  private async tenantCall(
    tenantId: string,
    action: "activate" | "refresh" | "deactivate" | "start_trial" | "extend_trial" | "end_trial" | "trial_contact",
    current: () => boolean,
    entry?: Pick<StoredActivation, "activationId" | "licenseKeyId">,
    token?: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const idToken = token ?? (await this.idToken(tenantId))
    this.assertCurrent(current)
    if (!idToken) throw new NoIdToken()
    return this.call("tenant", {
      idToken,
      installId: this.installId,
      os: this.platform,
      appVersion: this.options.appVersion,
      action,
      ...extra,
      ...(entry ? { activationId: entry.activationId } : {}),
      ...(entry?.licenseKeyId ? { licenseKeyId: entry.licenseKeyId } : {}),
    }, current)
  }

  private async activateTenant(tenantId: string): Promise<void> {
    const current = this.requestGuard(tenantId)
    const data = await this.tenantCall(tenantId, "activate", current)
    this.assertCurrent(current)
    this.accept(tenantId, data, "tenant")
  }

  // Activates with this machine's key, and falls back to the tenant's organization license
  // when there is no key or the key is refused for this tenant. A tenant without an
  // organization license, or that cannot be checked for one without a sign-in, reports the
  // key's refusal, or that a license is needed.
  private async activateAny(tenantId: string): Promise<void> {
    const current = this.requestGuard(tenantId)
    if (!this.state?.key) {
      await this.activateTenant(tenantId).catch((error: unknown) => {
        this.assertCurrent(current)
        throw error instanceof NoIdToken ? new Error(LICENSE_REQUIRED) : error
      })
      return
    }
    try {
      await this.activate(tenantId)
    } catch (keyError) {
      this.assertCurrent(current)
      if (!(keyError instanceof LicenseDenied)) throw keyError
      if (this.state?.key && keyError.reason !== "trial_used") {
        this.state.keyFailure = keyError.reason
        this.save()
      }
      await this.activateTenant(tenantId).catch((error: unknown) => {
        this.assertCurrent(current)
        throw (error instanceof LicenseDenied && error.reason === "tenant_not_licensed") || error instanceof NoIdToken
          ? keyError
          : error
      })
    }
  }

  // share, for a key activation, asks the service to share the license with the tenant or
  // stop; otherwise the last confirmed choice is sent again, or nothing so the service
  // applies the plan's default. A tenant activation without an ID token keeps its cached
  // token until it expires.
  private async replaceTrialWithKey(tenant: string): Promise<boolean> {
    if (!this.state?.key || this.state.activations[tenant]?.source !== "trial") return false
    const keyTokens = Object.entries(this.state.activations).filter(([, entry]) => !entry.source).map(([id]) => this.valid(id)).filter((payload): payload is Entitlement => payload !== null)
    const latest = keyTokens.sort((a, b) => b.iat - a.iat)[0]
    if (latest && keyTokens.length >= latest.tenants) return false
    try { await this.activate(tenant); return true } catch (error) {
      if (error instanceof StaleLicenseRequest) throw error
      return false
    }
  }

  private async refreshCurrent(tenantId: string, share?: boolean): Promise<void> {
    const entry = this.state?.activations[tenantId]
    if (!this.state || !entry) return
    const current = this.requestGuard(tenantId)
    const key = this.state.key
    try {
      if (entry.source === "trial" && await this.replaceTrialWithKey(tenantId)) return
      if (entry.source === "tenant" || entry.source === "trial") {
        const idToken = await this.idToken(tenantId)
        this.assertCurrent(current)
        if (!idToken) return
        if (entry.source === "trial") {
          try { await this.activateTenant(tenantId); return } catch (error) {
            if (error instanceof StaleLicenseRequest) throw error
          }
        }
        const data = await this.tenantCall(tenantId, "refresh", current, entry, idToken)
        this.assertCurrent(current)
        this.accept(tenantId, data, entry.source)
        if (entry.source === "trial") this.rememberTrial(tenantId, data)
        return
      }
      if (!key) throw new Error("Enter a license key first.")
      const shareWithTenant = share ?? entry.shared
      const data = await this.call("refresh", {
        key,
        activationId: entry.activationId,
        installId: this.installId,
        tenantId,
        // Lets the service send version 2 tokens to apps that read them.
        appVersion: this.options.appVersion,
        ...(await this.sharingFields(tenantId, shareWithTenant)),
        ...(shareWithTenant === undefined ? {} : { shareWithTenant }),
      }, current)
      this.assertCurrent(current)
      this.accept(tenantId, data, "key")
    } catch (error) {
      this.assertCurrent(current)
      if (error instanceof LicenseDenied && error.reason !== "trial_used") {
        if (LAPSED.has(error.reason)) this.confirmCommunity(tenantId)
        if (!entry.source) this.state.keyFailure = error.reason
        delete this.state.activations[tenantId]
        this.clearTrialRefusal(tenantId)
        this.saveTrials()
        this.save()
      }
      this.messages.set(tenantId, errorText(error))
      throw error
    }
  }

  /** Refreshes every cached activation. Network failures keep the cached token until it expires; a confirmed refusal drops it. */
  async refreshAll(): Promise<void> {
    this.load()
    for (const tenantId of Object.keys(this.state?.activations ?? {})) this.coverageEndedAt(tenantId)
    const key = this.state?.key
    const entries = Object.entries(this.state?.activations ?? {}).sort(([, a], [, b]) => Number(a.source === "trial") - Number(b.source === "trial"))
    for (const [tenantId, entry] of entries) {
      await this.mutate([tenantId], Boolean(key) || entry.source !== "tenant", async () => {
        this.assertCurrent(() => key === this.state?.key && this.tenantPresent(tenantId))
        // A preceding refresh may have refused and removed this activation. A queued
        // check can validate the same saved key again, but cannot restore a reset key.
        if (!this.state?.activations[tenantId] && entry.source !== "tenant" && key && this.state?.keyFailure) {
          await this.activateAny(tenantId)
          return
        }
        await this.refreshCurrent(tenantId)
      }).catch(() => undefined)
    }
    // After the refreshes, and outside the key mutation: releasing a replaced key's activations
    // must never hold up license checks of the tenants in use.
    await this.releasePrevious()
    this.pruneTrialContacts()
    const pendingTrials = Object.keys(this.trialRecords).filter(tenant => this.trialRecords[tenant]?.firstConnectedAt && !this.trialRecords[tenant]?.stopped && this.tenantPresent(tenant))
    if (pendingTrials.length) {
      void this.checkTrialHealth().catch(() => undefined)
      await this.retryPendingTrials()
    }
    this.options.onChange?.()
  }

  /** The key holder lets the tenant's other admins use the license, or stops. */
  async setShared(tenantId: string, share: boolean): Promise<void> {
    this.load()
    const tenant = tenantId.toLowerCase()
    return this.mutate([tenant], true, async () => {
      const entry = this.state?.activations[tenant]
      if (!this.state?.key || !entry || entry.source === "tenant") {
        throw new Error("Only the machine that holds the license key can change sharing.")
      }
      await this.refreshCurrent(tenant, share)
      if (share && this.state?.activations[tenant]?.shareNeedsSignIn) {
        throw new Error("Sign in to this tenant again to share the license with it.")
      }
      if (this.state?.activations[tenant]?.shared !== share) {
        throw new Error("The sharing setting could not be saved. Please try again later.")
      }
    })
  }

  /**
   * Saves the key and activates it for the given signed-in tenants that are not licensed
   * yet. Without such tenants the key is only saved and activates when a tenant is used.
   * When every activation fails the first error is thrown. Tenant-specific trial_used
   * refusals keep the key for another tenant; other failures restore the previous state.
   */
  async setKey(key: string, tenantIds: string[]): Promise<void> {
    this.load()
    const trimmed = key.trim()
    if (!/^[\x21-\x7e]{8,128}$/.test(trimmed)) throw new Error("Enter a valid license key.")
    const tenants = [...new Set(tenantIds.map((id) => id.toLowerCase()))]
    return this.mutate([...this.tenantMutations.keys(), ...Object.keys(this.state?.activations ?? {}), ...tenants], true, async () => {
      const previous = this.state
      // Organization license activations do not depend on the key and stay.
      if (
        previous?.key &&
        previous.key !== trimmed &&
        Object.values(previous.activations).some((entry) => !entry.source)
      ) {
        throw new Error("Deactivate this machine before entering a different license key.")
      }
      if (previous?.key !== trimmed) this.clearTrialKeyRefusals()
      this.state = {
        key: trimmed,
        ...(previous?.key === trimmed && previous.keyFailure ? { keyFailure: previous.keyFailure } : {}),
        ...(previous?.key === trimmed && previous.trialToken ? { trialToken: previous.trialToken } : {}),
        activations: { ...previous?.activations },
        ...(previous?.seen !== undefined ? { seen: previous.seen } : {}),
        ...(previous?.pendingRelease ? { pendingRelease: previous.pendingRelease } : {}),
      }
      const targets = tenants.filter((id) => this.tenantPresent(id) && (!this.valid(id) || this.state?.activations[id]?.source === "trial"))
      let activated = 0
      let firstError: unknown = null
      for (const tenant of targets) {
        this.failures.delete(tenant)
        try {
          await this.activate(tenant)
          this.assertCurrent(() => this.state?.key === trimmed && this.tenantPresent(tenant))
          activated++
        } catch (error) {
          this.assertCurrent(() => this.state?.key === trimmed)
          firstError ??= error
          if (this.tenantPresent(tenant) && !(error instanceof StaleLicenseRequest)) {
            if (error instanceof LicenseDenied && error.reason !== "trial_used") this.state.keyFailure = error.reason
            this.messages.set(tenant, errorText(error))
          }
        }
      }
      for (const tenant of Object.keys(this.state.activations).filter(id => this.state?.activations[id]?.source === "trial" && !targets.includes(id))) {
        if (await this.replaceTrialWithKey(tenant)) activated++
      }
      if (targets.length > 0 && activated === 0) {
        if (targets.every(tenant => {
          const error = this.failures.get(tenant)?.error
          return error instanceof LicenseDenied && error.reason === "trial_used"
        })) {
          this.save()
          throw firstError
        }
        const keyFailure = this.state.keyFailure
        this.assertCurrent(() => this.state?.key === trimmed)
        this.state = previous
        for (const tenant of targets) this.messages.delete(tenant)
        if (this.state?.key === trimmed && keyFailure) {
          this.state.keyFailure = keyFailure
          this.save()
        } else this.options.onChange?.()
        throw firstError
      }
      this.assertCurrent(() => this.state?.key === trimmed)
      this.message = tenantIds.length === 0 && activated === 0 ? "Sign in to a tenant to activate the license for it." : null
      this.save()
    })
  }

  /**
   * Replaces this machine's key with another one, such as a trial key with the paid key.
   * The new key is activated for the signed-in tenants while the current key and its
   * activations stay in place. Only once the service accepted the new key for at least one
   * tenant are the current key's activations released and the new key saved. A refused key
   * changes nothing, and the first error is thrown.
   */
  async replaceKey(key: string, tenantIds: string[]): Promise<void> {
    this.load()
    const trimmed = key.trim()
    if (!/^[\x21-\x7e]{8,128}$/.test(trimmed)) throw new Error("Enter a valid license key.")
    const previousKey = this.state?.key
    if (!previousKey || previousKey === trimmed) return this.setKey(trimmed, tenantIds)
    const signedIn = [...new Set(tenantIds.map((id) => id.toLowerCase()))]
    return this.mutate([...this.tenantMutations.keys(), ...Object.keys(this.state?.activations ?? {}), ...signedIn], true, async () => {
      const unchanged = () => this.state?.key === previousKey
      this.assertCurrent(unchanged)
      // Read after queued tenant work finished, so a key activation it added is covered too.
      // Every tenant the current key covers here must be covered by the new key, or the
      // swap would cost it its license. Signed-in tenants are activated as well, except
      // those already licensed, for example through their organization, which stay as
      // they are.
      const keyTenants = Object.entries(this.state?.activations ?? {})
        .filter(([tenantId, entry]) => !entry.source && this.tenantPresent(tenantId))
        .map(([tenantId]) => tenantId)
      const targets = [
        ...keyTenants,
        ...signedIn.filter((id) => !keyTenants.includes(id) && this.tenantPresent(id) && !this.valid(id)),
      ]
      if (targets.length === 0) throw new Error("Sign in to a tenant to switch to the new license key.")
      // The sharing choice each tenant has with the current key. The new key's activations are
      // staged without touching sharing (shareWithTenant false only removes a mapping of the new
      // key itself), so a refused swap leaves every tenant's sharing exactly as it was; the
      // choice is carried over and published once the swap is saved.
      const choices = new Map(targets.map((tenant) => {
        const entry = this.state?.activations[tenant]
        return [tenant, entry && !entry.source ? entry.shared : undefined] as const
      }))
      const accepted: { tenant: string; data: Record<string, unknown> }[] = []
      const errors = new Map<string, unknown>()
      for (const tenant of targets) {
        try {
          const answer = await this.call("activate", {
            key: trimmed,
            installId: this.installId,
            tenantId: tenant,
            os: this.platform,
            appVersion: this.options.appVersion,
            shareWithTenant: false,
          }, unchanged)
          // Keep the tenant's sharing choice, not the staged answer's.
          const { shared: _staged, sharedReason: _reason, ...data } = answer
          const choice = choices.get(tenant)
          if (choice !== undefined) data.shared = choice
          accepted.push({ tenant, data })
          // The same checks accept() applies, made before anything is released, so an
          // unusable answer costs nothing.
          if (!this.usableActivation(tenant, data)) {
            throw new Error(typeof data.token === "string" && typeof data.activationId === "string"
              ? this.problemOf(tenant, data.token, data.activationId)
              : "The licensing service returned an invalid response.")
          }
        } catch (error) {
          if (error instanceof StaleLicenseRequest) throw error
          errors.set(tenant, error)
        }
      }
      this.assertCurrent(unchanged)
      const covered = new Set(accepted.filter(({ tenant }) => !errors.has(tenant)).map(({ tenant }) => tenant))
      const uncovered = keyTenants.find((tenant) => !covered.has(tenant))
      if (covered.size === 0 || uncovered) {
        // Nothing changes: release what the new key was given, and report why.
        for (const { data } of accepted) {
          if (typeof data.activationId !== "string") continue
          await this.call("deactivate", { key: trimmed, activationId: data.activationId }, unchanged).catch((error: unknown) => {
            if (error instanceof StaleLicenseRequest) throw error
            console.warn(`[license] New key activation ${data.activationId} not released: ${errorText(error)}`)
          })
        }
        throw (uncovered ? errors.get(uncovered) : undefined) ?? errors.values().next().value
          ?? new Error("The new license key does not cover every tenant on this machine. Your current license is unchanged.")
      }
      const previous = this.state!
      // The new key and its activations are saved first, together with the previous key's
      // activations still to be released, and only then is anything released. A crash or a
      // failed write before the save leaves the previous key and all of its activations in
      // place; after it, the new key is saved and the release is retried on the next refresh.
      // Organization license activations do not depend on the key and stay.
      const activations = Object.fromEntries(Object.entries(previous.activations).filter(([, entry]) => (entry.source === "tenant" || entry.source === "trial")))
      // Releases still pending from earlier replacements are kept, so a key replaced twice before
      // its activations could be released is still released later.
      const release = [
        ...(previous.pendingRelease ?? []).filter((entry) => entry.key === previousKey).flatMap((entry) => entry.activationIds),
        ...Object.values(previous.activations).filter((entry) => !entry.source).map((entry) => entry.activationId),
      ]
      const pendingRelease = [
        ...(previous.pendingRelease ?? []).filter((entry) => entry.key !== previousKey),
        ...(release.length > 0 ? [{ key: previousKey, activationIds: [...new Set(release)] }] : []),
      ]
      this.state = {
        key: trimmed,
        activations,
        ...(previous.seen !== undefined ? { seen: previous.seen } : {}),
        ...(pendingRelease.length > 0 ? { pendingRelease } : {}),
      }
      try {
        for (const { tenant, data } of accepted) if (covered.has(tenant)) this.accept(tenant, data, "key", false)
        this.save()
      } catch (error) {
        // Nothing was released yet, so the previous key still holds every activation it had.
        this.state = previous
        this.notify()
        for (const { data } of accepted) {
          if (typeof data.activationId !== "string") continue
          await this.call("deactivate", { key: trimmed, activationId: data.activationId }, unchanged).catch((release: unknown) => {
            console.warn(`[license] New key activation ${data.activationId} not released: ${errorText(release)}`)
          })
        }
        throw new Error(`The new license key could not be saved. Your current license is unchanged. ${errorText(error)}`)
      }
      this.message = null
      this.clearTrialKeyRefusals()
      // Publish the carried sharing choice for the new key. A tenant that shared moves its
      // organization license to the new key here; until this succeeds (it is retried with every
      // refresh) the tenant's admins keep the previous key's sharing.
      for (const tenant of covered) {
        if (choices.get(tenant) !== true || !this.state?.activations[tenant]) continue
        await this.refreshCurrent(tenant, true).catch((error: unknown) => {
          if (error instanceof StaleLicenseRequest) throw error
          console.warn(`[license] Sharing for ${tenant} not moved to the new key yet: ${errorText(error)}`)
        })
      }
      await this.releasePrevious()
      for (const tenant of Object.keys(this.state?.activations ?? {})) await this.replaceTrialWithKey(tenant)
    })
  }

  /**
   * Releases the activations of replaced keys that are still bound to this machine. A release
   * the service confirms, or refuses because the activation no longer exists, is done. The first
   * other failure ends the attempt and keeps it and everything after it for the next one, so a
   * service that cannot be reached costs one request, not one per activation. Never throws.
   */
  private async releasePrevious(): Promise<void> {
    const pending = this.state?.pendingRelease
    if (!pending) return
    const key = this.state?.key
    const current = () => this.state?.key === key && this.state?.pendingRelease === pending
    const remaining: NonNullable<StoredLicense["pendingRelease"]> = []
    let stopped = false
    for (const entry of pending) {
      const left: string[] = []
      for (const activationId of entry.activationIds) {
        if (stopped) {
          left.push(activationId)
          continue
        }
        try {
          await this.call("deactivate", { key: entry.key, activationId }, current)
        } catch (error) {
          if (error instanceof StaleLicenseRequest) return
          if (!(error instanceof LicenseDenied)) {
            // The replaced key stays bound to that activation until it is released here or in the
            // customer portal; it no longer licenses anything on this machine.
            console.warn(`[license] Previous key activation ${activationId} not released: ${errorText(error)}`)
            left.push(activationId)
            stopped = true
          }
        }
      }
      if (left.length > 0) remaining.push({ key: entry.key, activationIds: left })
    }
    if (!current() || !this.state) return
    if (remaining.length > 0) this.state.pendingRelease = remaining
    else delete this.state.pendingRelease
    try {
      this.save()
    } catch {
      /* The release is retried; releasing an activation twice is harmless. */
    }
  }

  // The reason a token for the tenant is not usable, for an error message.
  private problemOf(tenantId: string, token: string, activationId: string): string {
    return tokenProblem(token, this.publicKeys, { tenantId, installId: this.installId, activationId }, Date.now(), true) ??
      "The license could not be verified. Retry activation on the License page."
  }

  // Whether accept() would take this activation response for the tenant.
  private usableActivation(tenant: string, data: Record<string, unknown>): boolean {
    if (typeof data.token !== "string" || typeof data.activationId !== "string") return false
    const payload = decodeToken(data.token, this.publicKeys)
    const now = this.observe()
    return Boolean(
      payload &&
      entitlementCurrent(payload, now, now) &&
      payload.tenantId === tenant &&
      payload.installId === this.installId &&
      payload.act === data.activationId,
    )
  }

  /**
   * Resolves when the tenant may be used, and throws with the reason otherwise. Called
   * before every token request and every local backup access, so it answers from the
   * cached token when it can. Otherwise it activates on first use, or refreshes an
   * expired token when the licensing service is reachable. retry skips the pause after
   * a recent failure, for actions the admin started.
   */
  async requireEntitlement(tenantId: string, options: { retry?: boolean } = {}): Promise<Plan> {
    this.load()
    const tenant = tenantId.toLowerCase()
    if (!guidPattern.test(tenant)) throw new Error("TenuVault licenses tenants by their tenant ID. Sign in to the tenant again.")
    // An explicit retry after release can check this tenant again. Requests already queued
    // during removal remain cancelled and cannot admit it through this path.
    if (options.retry && this.removedTenants.has(tenant) && !this.tenantMutations.has(tenant)) {
      return this.checkNewTenant(tenant, options)
    }
    return this.mutate([tenant], Boolean(this.state?.key || this.keyMutation), () => this.requireCurrent(tenant, options))
  }

  /**
   * For the rollback of a change set applied while the tenant was licensed (features/recovery.ts):
   * the tenant's plan, or null when its license ended and Community covers another tenant.
   * Every other refusal still throws, so a removed tenant or a malformed tenant ID is never used.
   */
  async requireRecovery(tenantId: string): Promise<Plan | null> {
    try {
      return await this.requireEntitlement(tenantId)
    } catch (error) {
      if (error instanceof CommunityLimitError) return null
      throw error
    }
  }

  /** Checks explicit tenant use or a new sign-in after an earlier removal. */
  async checkNewTenant(tenantId: string, options: { retry?: boolean } = { retry: true }): Promise<Plan> {
    this.load()
    const tenant = tenantId.toLowerCase()
    if (!guidPattern.test(tenant)) throw new Error("TenuVault licenses tenants by their tenant ID. Sign in to the tenant again.")
    const removal = this.removedTenants.get(tenant)
    return this.mutate([tenant], Boolean(this.state?.key || this.keyMutation), async () => {
      // A removal requested after this sign-in check must still take precedence.
      this.assertCurrent(() => this.removedTenants.get(tenant) === removal)
      this.removedTenants.delete(tenant)
      this.persistRemovedTenants()
      if (!this.trialRecords[tenant]) {
        this.trialRecords[tenant] = { firstConnectedAt: Date.now(), stopped: Boolean(this.state?.key || this.state?.activations[tenant] || this.options.store.get(COMMUNITY_KEY) === tenant) }
        this.saveTrials()
      }
      void this.checkTrialHealth().catch(() => undefined)
      await this.tryAutomaticTrial(tenant)
      return this.requireCurrent(tenant, options)
    })
  }

  private async requireCurrent(tenant: string, options: { retry?: boolean }): Promise<Plan> {
    this.assertCurrent(() => this.tenantPresent(tenant))
    const valid = this.valid(tenant)
    if (valid) {
      this.keepSeen()
      return valid.plan
    }
    if (options.retry) {
      this.failures.delete(tenant)
      this.community.delete(tenant)
    }
    if (this.trialRecords[tenant]?.firstConnectedAt && !this.trialRecords[tenant]?.stopped) {
      void this.checkTrialHealth().catch(() => undefined)
      await this.tryAutomaticTrial(tenant)
      const started = this.valid(tenant)
      if (started) return started.plan
    }
    if ((this.community.get(tenant) ?? 0) > Date.now()) return "community"
    this.coverageEndedAt(tenant)
    const key = this.state?.key
    const current = () => key === this.state?.key && this.tenantPresent(tenant)
    try {
      const failure = this.failures.get(tenant)
      if (failure && failure.until > Date.now() && (!(failure.error instanceof LicenseDenied) || failure.error.reason !== "trial_used" || failure.key === key)) throw failure.error
      await this.entitle(tenant)
      this.assertCurrent(current)
      const plan = this.valid(tenant)?.plan
      if (plan) return plan
      throw new Error("The license is not valid for this tenant.")
    } catch (error) {
      this.assertCurrent(current)
      if (error instanceof LicenseDenied && error.reason === "trial_used" && this.options.store.get(COMMUNITY_KEY) === tenant) return "community"
      if (error instanceof StaleLicenseRequest || !this.lapsedOrUnlicensed(tenant, error)) throw error
      this.confirmCommunity(tenant)
      return this.useCommunity(tenant)
    }
  }

  /**
   * Whether a failed license check leaves the tenant without a paid license: no key and no
   * activation for it (even offline, so the free plan works without a network), or a
   * confirmed refusal that means the license ended. An unreachable service with a key keeps
   * the error, so a paying tenant is never quietly downgraded.
   */
  private lapsedOrUnlicensed(tenant: string, error: unknown): boolean {
    if (error instanceof Error && error.message === LICENSE_REQUIRED) return true
    if (error instanceof LicenseDenied) return LAPSED.has(error.reason)
    return !this.state?.key && !this.state?.activations[tenant]
  }

  coverageEndedAt(tenantId: string): number | undefined {
    this.load()
    const tenant = tenantId.toLowerCase()
    const key = `license.coverageEnd.${tenant}`
    const entry = this.state?.activations[tenant]
    const payload = entry ? decodeToken(entry.token, this.publicKeys) : null
    if (payload) {
      const endedAt = (payload.v === 2 && typeof payload.keyExp === "number" ? Math.min(payload.exp, payload.keyExp) : payload.exp) * 1000
      if (!Number.isFinite(endedAt) || !Number.isFinite(new Date(endedAt).getTime())) return undefined
      this.coverageEnds.set(tenant, endedAt)
      try {
        if (this.options.persist && this.options.store.get(key) !== String(endedAt)) this.options.store.set(key, String(endedAt))
      } catch { console.warn("[license] Could not save the coverage end.") }
      return endedAt
    }
    try {
      const saved = Number(this.options.store.get(key))
      if (saved > 0 && Number.isFinite(new Date(saved).getTime()) && !this.coverageEnds.has(tenant)) this.coverageEnds.set(tenant, saved)
    } catch { /* Keep the date in memory if the store is temporarily unavailable. */ }
    return this.coverageEnds.get(tenant)
  }

  private communityKeyIdentity(): string {
    return this.state?.key ? createHash("sha256").update(this.state.key).digest("hex") : "none"
  }

  private persistCommunityEligibility(): void {
    if (!this.options.persist) return
    try {
      if (this.communityEligibility.size) this.options.store.set(COMMUNITY_ELIGIBILITY_KEY, JSON.stringify(Object.fromEntries(this.communityEligibility)))
      else this.options.store.delete(COMMUNITY_ELIGIBILITY_KEY)
    } catch { console.warn("[license] Could not save Community eligibility.") }
  }

  private confirmCommunity(tenant: string): void {
    if (!this.state?.key && !this.state?.activations[tenant]) return
    const identity = this.communityKeyIdentity()
    if (this.communityEligibility.get(tenant) === identity) return
    this.communityEligibility.set(tenant, identity)
    this.persistCommunityEligibility()
    this.options.onChange?.()
  }

  private communityEligible(tenant: string): boolean {
    const entry = this.state?.activations[tenant]
    if (!entry) return !this.state?.key || this.communityEligibility.get(tenant) === this.communityKeyIdentity()
    const payload = entry ? decodeToken(entry.token, this.publicKeys) : null
    return Boolean(payload?.v === 2 && payload.trial === true && typeof payload.keyExp === "number" && payload.keyExp * 1000 <= Date.now()
      && payload.tenantId === tenant && payload.installId === this.installId && payload.act === entry?.activationId)
  }

  private uncoveredTenants(): string[] {
    return [...new Set((this.options.connectedTenantIds?.() ?? []).map((id) => id.toLowerCase()))]
      .filter((id) => guidPattern.test(id) && this.tenantPresent(id) && !this.valid(id))
  }

  private coverageEnded(tenant: string): boolean {
    const entry = this.state?.activations[tenant]
    if (entry) return this.communityEligible(tenant)
    if (this.communityEligibility.get(tenant) === this.communityKeyIdentity()) return true
    if (this.state?.key) return false
    const end = this.coverageEndedAt(tenant)
    return this.communityEligibility.has(tenant) || (end !== undefined && end <= Date.now())
  }

  communityPendingTenants(): string[] {
    this.load()
    if (this.options.store.get(COMMUNITY_KEY)) return []
    const uncovered = this.uncoveredTenants()
    return uncovered.length > 1 && uncovered.some((id) => this.coverageEnded(id)) ? uncovered : []
  }

  communityChoices(): string[] {
    return this.communityPendingTenants().filter((id) => this.communityEligible(id))
  }

  chooseCommunity(tenantId: string): void {
    const tenant = tenantId.toLowerCase()
    if (!this.communityChoices().includes(tenant)) throw new Error("Choose a connected tenant without license coverage.")
    this.options.store.set(COMMUNITY_KEY, tenant)
    this.useCommunity(tenant)
    this.options.onChange?.()
  }

  private useCommunity(tenant: string): Plan {
    this.assertCurrent(() => this.tenantPresent(tenant))
    const owner = this.options.store.get(COMMUNITY_KEY)
    if (!owner && this.communityPendingTenants().length) throw new CommunityChoicePendingError()
    if (owner && owner !== tenant) {
      const existing = this.options.connectedTenantIds?.().some((id) => id.toLowerCase() === tenant) ?? false
      throw new CommunityLimitError(owner, communityLimit(owner) + (existing ? " Backups of this tenant are kept. Add a license to use it again." : ""), existing)
    }
    if (owner !== tenant) this.options.store.set(COMMUNITY_KEY, tenant)
    const first = !this.community.has(tenant)
    this.community.set(tenant, Date.now() + COMMUNITY_RECHECK_MS)
    this.messages.delete(tenant)
    this.failures.delete(tenant)
    if (first) this.options.onChange?.()
    return "community"
  }

  /**
   * The tenant's plan as far as it is known without a network call, or null when it is not
   * licensed. A tenant that was removed has no plan, like entitlementToken, even while an
   * activation it could not release is still stored.
   */
  plan(tenantId: string): Plan | null {
    this.load()
    const tenant = tenantId.toLowerCase()
    if (!this.tenantPresent(tenant)) return null
    const payload = this.valid(tenant)
    if (payload) return payload.plan
    return this.options.store.get(COMMUNITY_KEY) === tenant ? "community" : null
  }

  private async entitle(tenant: string): Promise<void> {
    const key = this.state?.key
    const current = () => key === this.state?.key && this.tenantPresent(tenant)
    try {
      if (this.state?.activations[tenant]) {
        // A refused refresh drops the activation (for example after it was released in
        // the customer portal); try one fresh activation.
        await this.refreshCurrent(tenant).catch((error: unknown) => {
          if (!(error instanceof LicenseDenied)) throw error
          return this.activateAny(tenant)
        })
      } else {
        await this.activateAny(tenant)
      }
      this.assertCurrent(current)
      if (!this.valid(tenant)) {
        throw new Error(
          this.state?.activations[tenant]?.source === "tenant"
            ? "Sign in to this tenant again to check your organization's license."
            : "The license is not valid for this tenant.",
        )
      }
    } catch (caught) {
      this.assertCurrent(current)
      if (caught instanceof StaleLicenseRequest) throw caught
      // Without a key and an organization license there is nothing to fix but adding a
      // key, which the License page already asks for.
      const error =
        caught instanceof LicenseDenied && caught.reason === "tenant_not_licensed" ? new Error(LICENSE_REQUIRED) : caught
      if (error === caught) this.messages.set(tenant, errorText(error))
      else this.messages.delete(tenant)
      this.failures.set(tenant, { error, until: Date.now() + FAILURE_COOLDOWN_MS, ...(error instanceof LicenseDenied && error.reason === "trial_used" ? { key } : {}) })
      this.options.onChange?.()
      throw error
    }
  }

  /** Retries activation for the given tenants after a failed attempt. Never throws. */
  async retry(tenantIds: string[]): Promise<void> {
    for (const tenant of tenantIds) {
      await this.requireEntitlement(tenant, { retry: true }).catch(() => undefined)
    }
  }

  /**
   * Releases the tenant's activation when the tenant is removed from the app, which frees
   * its tenant slot on the key. A key activation the service could not release stays, so
   * the next attempt can release it; an organization license activation needs a sign-in
   * to release, so it is forgotten here and counts against the tenant's installations
   * until it is released in the customer portal.
   */
  async releaseTenant(tenantId: string): Promise<void> {
    this.load()
    const tenant = tenantId.toLowerCase()
    // An idempotent release of an unknown activation must not block first use. Only
    // existing coverage or outstanding checks need to be cancelled for this tenant.
    if (this.tenantMutations.has(tenant) || this.state?.activations[tenant] ||
      this.options.store.get(COMMUNITY_KEY) === tenant || this.community.has(tenant)) {
      this.removedTenants.set(tenant, {})
      this.persistRemovedTenants()
    }
    return this.mutate([tenant], false, async () => {
      this.messages.delete(tenant)
      this.failures.delete(tenant)
      delete this.trialRecords[tenant]
      this.saveTrials()
      this.community.delete(tenant)
      if (this.communityEligibility.delete(tenant)) this.persistCommunityEligibility()
      // Removing the Community tenant frees the free plan for another tenant.
      if (this.options.store.get(COMMUNITY_KEY) === tenant) {
        this.options.store.delete(COMMUNITY_KEY)
        this.options.onChange?.()
      }
      const entry = this.state?.activations[tenant]
      if (!this.state || !entry) return
      const current = this.requestGuard(tenant, false)
      const key = this.state.key
      try {
        if (entry.source === "trial") { delete this.state.activations[tenant]; this.save(); return }
        if (entry.source === "tenant") await this.tenantCall(tenant, "deactivate", current, entry)
        else if (key) await this.call("deactivate", { key, activationId: entry.activationId }, current)
      } catch (error) {
        this.assertCurrent(current)
        if (!(error instanceof LicenseDenied) && entry.source !== "tenant") {
          this.options.onChange?.()
          throw error
        }
        if (!(error instanceof LicenseDenied)) {
          console.warn(`[license] Organization license activation for ${tenant} not released: ${errorText(error)}`)
        }
      }
      this.assertCurrent(current)
      delete this.state.activations[tenant]
      this.save()
    })
  }

  /** Releases every activation of this machine and forgets the key. */
  async deactivate(): Promise<void> {
    this.load()
    return this.mutate([...this.tenantMutations.keys(), ...Object.keys(this.state?.activations ?? {})], true, async () => {
      if (!this.state) { this.trialRecords = {}; this.saveTrials(); this.options.onChange?.(); return }
      // A replaced key's activations are released first. One that cannot be released keeps the
      // machine's state, its record included, so the release is not forgotten.
      await this.releasePrevious()
      let failure: unknown = this.state?.pendingRelease
        ? new Error("A license key this machine used before could not be released. Check your network and try again.")
        : null
      const key = this.state.key
      for (const [tenantId, entry] of Object.entries(this.state.activations)) {
        const current = this.requestGuard(tenantId, false)
        try {
          if (entry.source === "trial") { delete this.state.activations[tenantId]; continue }
          if (entry.source === "tenant") await this.tenantCall(tenantId, "deactivate", current, entry)
          else if (key) await this.call("deactivate", { key, activationId: entry.activationId }, current)
          this.assertCurrent(current)
          delete this.state.activations[tenantId]
        } catch (error) {
          this.assertCurrent(current)
          // An organization license activation needs a sign-in to release, so, as in
          // releaseTenant, it is forgotten rather than blocking the key's deactivation.
          if (error instanceof LicenseDenied) delete this.state.activations[tenantId]
          else if (entry.source === "tenant") {
            console.warn(`[license] Organization license activation for ${tenantId} not released: ${errorText(error)}`)
            delete this.state.activations[tenantId]
          } else failure = error
        }
      }
      this.assertCurrent(() => key === this.state?.key)
      if (failure) {
        this.save()
        throw failure
      }
      this.state = null
      this.trialRecords = {}
      this.saveTrials()
      this.message = null
      this.messages.clear()
      this.failures.clear()
      this.save()
    })
  }

  /**
   * Whether any currently valid entitlement on this machine carries the server-issued
   * internal CIS claim. The licensing service issues the claim only to allowlisted
   * internal installations. It enables Build Kit import, internal testing tooling;
   * CIS Benchmarks itself follows the tenant's plan.
   */
  cisInternal(): boolean {
    this.load()
    if (!this.state) return false
    return Object.keys(this.state.activations).some(
      (tenantId) => this.tenantPresent(tenantId) && this.valid(tenantId)?.cis === "internal",
    )
  }

  /**
   * The stored entitlement token for one tenant, only when it is currently valid for
   * this installation and the tenant is still present. Used as the bearer credential
   * for the CIS content delivery service, which re-verifies it server-side.
   */
  entitlementToken(tenantId: string): string | null {
    this.load()
    const tenant = tenantId.toLowerCase()
    if (!this.tenantPresent(tenant)) return null
    if (!this.valid(tenant)) return null
    return this.state?.activations[tenant]?.token ?? null
  }

  /**
   * The newest entitlement token of this machine's trial key, also after the trial ended, or
   * null. It names the trial's customer for Buy Pro; it never carries the key itself.
   */
  trialCheckoutToken(): string | null {
    return this.newestTrialToken()?.token ?? null
  }

  private newestTrialToken(): { token: string; keyExp: number } | null {
    this.load()
    if (!this.state) return null
    let best: { token: string; iat: number; keyExp: number } | null = null
    const candidates = [
      this.state.trialToken,
      ...Object.values(this.trialRecords).map(record => record.token),
      ...Object.values(this.state.activations).filter((entry) => !entry.source).map((entry) => entry.token),
    ]
    for (const token of candidates) {
      if (!token) continue
      const payload = decodeToken(token, this.publicKeys)
      if (payload?.v !== 2 || payload.trial !== true || typeof payload.keyExp !== "number") continue
      if (!best || payload.iat > best.iat) best = { token, iat: payload.iat, keyExp: payload.keyExp }
    }
    return best
  }

  // When the saved trial key ended, while no license of any kind covers a tenant here.
  private trialEndedAt(covered: boolean): string | null {
    if (covered) return null
    const keyExp = this.newestTrialToken()?.keyExp
    if (keyExp === undefined || keyExp * 1000 > Date.now()) return null
    return new Date(keyExp * 1000).toISOString()
  }

  /** Whether this is the saved license key, so a copied key is not offered again. */
  isSavedKey(key: string): boolean {
    this.load()
    return Boolean(this.state?.key) && this.state?.key === key.trim()
  }

  /** The license state for the signed-in tenants plus every tenant with a stored activation. */
  status(signedInTenantIds: string[]): LicenseStatus {
    this.load()
    this.pruneTrialContacts()
    const signedIn = new Set(signedInTenantIds.map((id) => id.toLowerCase()))
    const tenantIds = [...new Set([...signedIn, ...Object.keys(this.state?.activations ?? {})])]
    const communityTenant = this.options.store.get(COMMUNITY_KEY)
    let keyToken: Entitlement | null = null
    let validUntil: string | null = null
    const tenants = tenantIds.map((tenantId): TenantLicenseStatus => {
      const entry = this.state?.activations[tenantId]
      this.coverageEndedAt(tenantId)
      const payload = this.valid(tenantId)
      const source = payload && entry ? (entry.source ?? "key") : null
      if (payload && source === "key" && (!keyToken || payload.iat > keyToken.iat)) keyToken = payload
      const tenantValidUntil = payload?.v === 2 && typeof payload.keyExp === "number"
        ? new Date(payload.keyExp * 1000).toISOString()
        : null
      const tenantTrial = payload?.v === 2 && payload.trial === true && tenantValidUntil !== null
      // A trial key's end is reported as trialEndsAt; validUntil stays with the other
      // licenses, so their expiry warning is not hidden behind the trial.
      if (tenantValidUntil && !tenantTrial && (!validUntil || Date.parse(tenantValidUntil) < Date.parse(validUntil))) {
        validUntil = tenantValidUntil
      }
      return {
        tenantId,
        signedIn: signedIn.has(tenantId),
        activated: Boolean(entry),
        coverageEnded: !payload && this.coverageEnded(tenantId),
        entitled: payload !== null,
        source,
        plan: payload?.plan ?? (communityTenant === tenantId ? "community" : null),
        tenants: payload?.tenants ?? null,
        expiresAt: payload ? new Date(payload.exp * 1000).toISOString() : null,
        validUntil: tenantValidUntil,
        trial: tenantTrial,
        trialEndsAt: tenantTrial ? tenantValidUntil : !payload ? this.trialEnd(tenantId) : null,
        canEnd: entry?.source === "trial" && entry.canEnd === true,
        trialRefusalPermanent: ["used", "install_limit"].includes(this.trialRecords[tenantId]?.refusalReason ?? "") || Boolean(!payload && this.trialRecords[tenantId]?.activationId && Date.parse(this.trialEnd(tenantId) ?? "") <= Date.now()),
        trialRefusal: this.trialRefusal(tenantId) ?? (!payload && this.trialRecords[tenantId]?.activationId && Date.parse(this.trialEnd(tenantId) ?? "") <= Date.now() ? TRIAL_REASONS.used : undefined),
        trialAcknowledged: tenantTrial ? this.trialRecords[tenantId]?.acknowledged : this.trialRecords[tenantId]?.endedAcknowledged,
        trialEmail: this.trialRecords[tenantId]?.email,
        trialUsageRevision: Object.values(this.trialRecords[tenantId]?.tally ?? {}).reduce((sum, value) => sum + value, 0),
        trialExtensionUnavailable: Boolean(this.trialRecords[tenantId]?.extended || this.trialRecords[tenantId]?.endedAt),
        trialExtensionAvailableAt: !this.state?.key && (!entry || entry.source === "trial") && this.trialsEnabled && this.trialRecords[tenantId]?.activationId && !this.trialRecords[tenantId]?.extended && !this.trialRecords[tenantId]?.endedAt && this.trialEnd(tenantId)
          ? new Date(Date.parse(this.trialEnd(tenantId)!) - (this.trialPolicy.extensionWindowDays ?? 5) * 86400_000).toISOString() : undefined,
        trialCanExtend: this.canExtendTrial(tenantId),
        shared: source === "key" ? (entry?.shared ?? null) : null,
        shareNeedsSignIn: source === "key" && Boolean(entry?.shareNeedsSignIn),
        displayKey: source === "tenant" ? (entry?.displayKey ?? null) : null,
        message: payload ? null : (this.messages.get(tenantId) ?? null),
      }
    })
    this.keepSeen()
    const key = this.state?.key
    const latest = (keyToken ?? tenants.filter(t => t.source === "trial").map(t => this.valid(t.tenantId)).sort((a, b) => (a?.keyExp ?? 0) - (b?.keyExp ?? 0))[0] ?? null) as Entitlement | null
    const latestTrial = latest?.v === 2 && latest.trial === true && typeof latest.keyExp === "number"
    // A saved key activation whose token was not signed by the trusted key says so (an app
    // update or a rewriting proxy is the fix, not a retry); otherwise it asks for a retry.
    const keyEntry = Object.entries(this.state?.activations ?? {}).find(([, entry]) => !entry.source)
    const keyMessage = !key || keyToken ? null
      : this.state?.keyFailure ? (REASONS[this.state.keyFailure] ?? null)
        : keyEntry
          ? (tokenProblem(keyEntry[1].token, this.publicKeys, { tenantId: keyEntry[0], installId: this.installId, activationId: keyEntry[1].activationId }, Date.now(), false) ??
            "The saved license could not be verified. Retry activation on the License page.")
          : null
    const keyState: LicenseStatus["keyState"] = !key ? "none" : keyToken ? "active" : keyMessage ? "failed" : "pending"
    return {
      tenantTrialPolicy: this.trialPolicy,
      tenantTrialsEnabled: this.trialsEnabled,
      hasKey: Boolean(key),
      keyState,
      keyMessage,
      keyHint: key ? `****${key.slice(-4)}` : null,
      persisted: this.options.persist,
      offline: this.offline,
      message: this.message,
      plan: latest?.plan ?? null,
      tenantLimit: latest?.tenants ?? null,
      trial: latestTrial,
      trialEndsAt: latestTrial ? new Date(latest!.keyExp! * 1000).toISOString() : null,
      trialEndedAt: this.trialEndedAt(latest !== null || tenants.some((tenant) => tenant.entitled)),
      validUntil,
      communityTenantId: communityTenant ?? null,
      communityChoiceTenantIds: this.communityChoices(),
      communityChoicePendingTenantIds: this.communityPendingTenants(),
      tenants,
    }
  }
}
