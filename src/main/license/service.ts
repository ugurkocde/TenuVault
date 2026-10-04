import { createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto"
import type { LicenseStatus, TenantLicenseStatus } from "../../shared/ipc"
import type { Plan } from "../../shared/plans"
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
 * is used. The service decides whether the key covers another tenant (Pro: one, MSP: the
 * subscription quantity) and limits each tenant to five installations.
 */

interface Entitlement {
  v: 1
  sub: string
  act: string
  plan: "pro" | "msp"
  tenantId: string
  installId: string
  tenants: number
  status: "granted"
  iat: number
  exp: number
}

// An activation either comes from this machine's license key, or, with source "tenant",
// from the organization license the key holder shared with the tenant; those are checked
// with a Microsoft ID token and the key never reaches this machine.
interface StoredActivation {
  activationId: string
  token: string
  source?: "tenant"
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
  activations: Record<string, StoredActivation>
  seen?: number
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
  /** Ed25519 public key (SPKI PEM) that verifies entitlement tokens. */
  publicKey: string
  /** Origin of the licensing service, such as https://tenuvault.com. */
  apiBase: string
  appVersion: string
  platform?: string
  idToken?: IdTokenProvider
  clientId?: ClientIdProvider
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
  ) {
    super(message)
    this.name = "LicenseDenied"
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
// A Community tenant is checked for a new license (a key or an organization license) at
// most this often, unless the admin asks.
export const COMMUNITY_RECHECK_MS = 6 * 60 * 60_000
// Refusals that mean the license ended, so the tenant falls back to Community.
const LAPSED = new Set(["not_found", "revoked", "disabled", "expired", "tenant_not_licensed", "activation_mismatch"])

export const communityLimit = (tenantId: string) =>
  `TenuVault Community covers one tenant, and it is used for tenant ${tenantId}. Add a Pro or MSP license on the License page to use more tenants.`

export const LICENSE_REQUIRED =
  "A TenuVault license is required for this tenant. Add your license key on the License page, or buy Pro or MSP."

const REASONS: Record<string, string> = {
  invalid_key: "This license key is not valid for TenuVault.",
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

// How far the clock may move back (an NTP correction, a restored VM snapshot, a time zone
// or RTC mix-up) before cached tokens stop counting offline. A larger rollback could
// otherwise keep an expired token alive indefinitely; this bounds that to two days past expiry.
export const CLOCK_TOLERANCE_MS = 48 * 60 * 60_000
// The high-water mark is written at most this often outside other saves.
const SEEN_PERSIST_MS = 60 * 60_000
// Token requests arrive in bursts. After a failed activation the same error is returned
// for this long instead of calling the licensing service again; user actions skip it.
export const FAILURE_COOLDOWN_MS = 60_000

const STATE_KEY = "license.state"
const INSTALL_ID_KEY = "license.installId"
// Left behind by the offline TV1 license keys this service replaced.
const LEGACY_KEYS = ["license.key", "license.trialStartedAt", "license.lastSeenAt", "license.tenants"]

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Time and status checks for a token whose signature already verified.
export function entitlementCurrent(payload: Pick<Entitlement, "exp" | "status">, now: number, seen: number): boolean {
  return (
    payload.status === "granted" &&
    Number.isFinite(payload.exp) &&
    payload.exp * 1000 > now &&
    seen - now <= CLOCK_TOLERANCE_MS
  )
}

function decodeToken(token: string, publicKey: KeyObject): Entitlement | null {
  const [body, signature, extra] = token.split(".")
  if (!body || !signature || extra !== undefined) return null
  try {
    if (!verify(null, Buffer.from(body), publicKey, Buffer.from(signature, "base64url"))) return null
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Entitlement
    return payload.v === 1 ? payload : null
  } catch {
    return null
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class LicenseService {
  private state: StoredLicense | null = null
  private installId = ""
  private loaded = false
  private savedSeen = 0
  private message: string | null = null
  private offline = false
  private readonly messages = new Map<string, string>()
  private readonly failures = new Map<string, { error: unknown; until: number }>()
  private readonly pending = new Map<string, Promise<void>>()
  // Community tenants, until their next check for a license.
  private readonly community = new Map<string, number>()
  private readonly publicKey: KeyObject
  private readonly fetchImpl: typeof fetch
  private readonly idToken: IdTokenProvider
  private readonly clientId: ClientIdProvider

  constructor(private readonly options: LicenseServiceOptions) {
    this.publicKey = createPublicKey(options.publicKey)
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.idToken = options.idToken ?? (async () => null)
    this.clientId = options.clientId ?? (() => null)
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
        if (!Number.isFinite(this.state.seen)) delete this.state.seen
        this.savedSeen = this.state.seen ?? 0
        return
      }
      console.warn("[license] Stored license ignored: invalid format")
    } catch {
      console.warn("[license] Stored license ignored: invalid JSON")
    }
  }

  // Refuses to write the key in plaintext: without OS encryption the license lives in
  // memory only and must be entered again after a restart.
  private save(): void {
    if (this.options.persist) {
      if (this.state) this.options.store.set(STATE_KEY, JSON.stringify(this.state))
      else this.options.store.delete(STATE_KEY)
      this.savedSeen = this.state?.seen ?? 0
    }
    this.options.onChange?.()
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
    const payload = decodeToken(entry.token, this.publicKey)
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
  ): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.apiBase}/api/desktop-license/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      this.offline = true
      console.warn(`[license] Licensing service unreachable (${action})`)
      const code = error instanceof Error ? error.message.match(/\bERR_[A-Z_]+\b/)?.[0] : undefined
      const host = new URL(this.options.apiBase).host
      const guidance = code && /CERT|SSL/.test(code)
        ? `Ask IT to check this device's trusted certificates and HTTPS inspection for ${host}.`
        : code && /PROXY|TUNNEL|PAC_/.test(code)
          ? `Check this device's proxy settings and ask IT to allow HTTPS requests to ${host}.`
          : error instanceof Error && (error.name === "TimeoutError" || /TIMED_OUT/.test(code ?? ""))
            ? "The request timed out. Check your connection and retry."
            : `Check your connection and ask IT to allow HTTPS requests to ${host}.`
      throw new Error(`The licensing service could not be reached. ${guidance}${code ? ` (${code})` : ""}`)
    }
    // A proxy or captive portal can answer with an HTML 401/403 page. It is
    // not a license refusal and must never remove a cached activation.
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
    const data: unknown = contentType === "application/json" ? await response.json().catch(() => null) : null
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      this.offline = true
      throw new Error("The licensing service returned an unexpected response. Check for a firewall block or network sign-in page and retry.")
    }
    const result = data as Record<string, unknown>
    const deactivating = action === "deactivate" || (action === "tenant" && "action" in body && body.action === "deactivate")
    const validSuccess = deactivating
      ? result.success === true
      : typeof result.token === "string" && typeof result.activationId === "string"
    if (response.ok && !validSuccess) {
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

  // Stores the activation the service returned, after verifying its token.
  private accept(tenantId: string, data: Record<string, unknown>, source: "key" | "tenant"): void {
    if (typeof data.token !== "string" || typeof data.activationId !== "string") {
      throw new Error("The licensing service returned an invalid response.")
    }
    const hadState = this.state !== null
    this.state ??= { activations: {} }
    // Verify the new token before it replaces the cached one: a response that fails
    // verification must not cost a still valid activation. A mark ahead of both the clock
    // and the server's issue time came from a clock that once ran ahead, so it comes down
    // to the later of the two.
    const previous = this.state.activations[tenantId]
    const previousSeen = this.state.seen
    const issued = (decodeToken(data.token, this.publicKey)?.iat ?? NaN) * 1000
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
      ...(source === "tenant"
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
      throw new Error("The license token could not be verified.")
    }
    this.message = null
    this.messages.delete(tenantId)
    this.failures.delete(tenantId)
    this.save()
  }

  private async activate(tenantId: string): Promise<void> {
    if (!this.state?.key) throw new Error("Enter a license key first.")
    const data = await this.call("activate", {
      key: this.state.key,
      installId: this.installId,
      tenantId,
      os: this.platform,
      appVersion: this.options.appVersion,
      ...(await this.sharingFields(tenantId)),
    })
    this.accept(tenantId, data, "key")
  }

  // A request to the organization license route. Throws when no ID token for the tenant
  // can be had silently.
  private async tenantCall(
    tenantId: string,
    action: "activate" | "refresh" | "deactivate",
    entry?: StoredActivation,
    token?: string,
  ): Promise<Record<string, unknown>> {
    const idToken = token ?? (await this.idToken(tenantId))
    if (!idToken) throw new NoIdToken()
    return this.call("tenant", {
      idToken,
      installId: this.installId,
      os: this.platform,
      appVersion: this.options.appVersion,
      action,
      ...(entry ? { activationId: entry.activationId } : {}),
      ...(entry?.licenseKeyId ? { licenseKeyId: entry.licenseKeyId } : {}),
    })
  }

  private async activateTenant(tenantId: string): Promise<void> {
    this.accept(tenantId, await this.tenantCall(tenantId, "activate"), "tenant")
  }

  // Activates with this machine's key, and falls back to the tenant's organization license
  // when there is no key or the key is refused for this tenant. A tenant without an
  // organization license, or that cannot be checked for one without a sign-in, reports the
  // key's refusal, or that a license is needed.
  private async activateAny(tenantId: string): Promise<void> {
    if (!this.state?.key) {
      await this.activateTenant(tenantId).catch((error: unknown) => {
        throw error instanceof NoIdToken ? new Error(LICENSE_REQUIRED) : error
      })
      return
    }
    try {
      await this.activate(tenantId)
    } catch (keyError) {
      if (!(keyError instanceof LicenseDenied)) throw keyError
      await this.activateTenant(tenantId).catch((error: unknown) => {
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
  private async refresh(tenantId: string, share?: boolean): Promise<void> {
    const entry = this.state?.activations[tenantId]
    if (!this.state || !entry) return
    try {
      if (entry.source === "tenant") {
        const idToken = await this.idToken(tenantId)
        if (!idToken) return
        this.accept(tenantId, await this.tenantCall(tenantId, "refresh", entry, idToken), "tenant")
        return
      }
      if (!this.state.key) throw new Error("Enter a license key first.")
      const shareWithTenant = share ?? entry.shared
      const data = await this.call("refresh", {
        key: this.state.key,
        activationId: entry.activationId,
        installId: this.installId,
        tenantId,
        ...(await this.sharingFields(tenantId, shareWithTenant)),
        ...(shareWithTenant === undefined ? {} : { shareWithTenant }),
      })
      this.accept(tenantId, data, "key")
    } catch (error) {
      if (error instanceof LicenseDenied) {
        delete this.state.activations[tenantId]
        this.save()
      }
      this.messages.set(tenantId, errorText(error))
      throw error
    }
  }

  /** Refreshes every cached activation. Network failures keep the cached token until it expires; a confirmed refusal drops it. */
  async refreshAll(): Promise<void> {
    this.load()
    for (const tenantId of Object.keys(this.state?.activations ?? {})) {
      await this.refresh(tenantId).catch(() => undefined)
    }
    this.options.onChange?.()
  }

  /** The key holder lets the tenant's other admins use the license, or stops. */
  async setShared(tenantId: string, share: boolean): Promise<void> {
    this.load()
    const tenant = tenantId.toLowerCase()
    const entry = this.state?.activations[tenant]
    if (!this.state?.key || !entry || entry.source === "tenant") {
      throw new Error("Only the machine that holds the license key can change sharing.")
    }
    await this.refresh(tenant, share)
    if (share && this.state?.activations[tenant]?.shareNeedsSignIn) {
      throw new Error("Sign in to this tenant again to share the license with it.")
    }
    if (this.state?.activations[tenant]?.shared !== share) {
      throw new Error("The sharing setting could not be saved. Please try again later.")
    }
  }

  /**
   * Saves the key and activates it for the given signed-in tenants that are not licensed
   * yet. Without such tenants the key is only saved and activates when a tenant is used.
   * When every activation fails the key is not kept and the first error is thrown.
   */
  async setKey(key: string, tenantIds: string[]): Promise<void> {
    this.load()
    const trimmed = key.trim()
    if (!/^[\x21-\x7e]{8,128}$/.test(trimmed)) throw new Error("Enter a valid license key.")
    const previous = this.state
    // Organization license activations do not depend on the key and stay.
    if (
      previous?.key &&
      previous.key !== trimmed &&
      Object.values(previous.activations).some((entry) => !entry.source)
    ) {
      throw new Error("Deactivate this machine before entering a different license key.")
    }
    this.state = {
      key: trimmed,
      activations: { ...previous?.activations },
      ...(previous?.seen !== undefined ? { seen: previous.seen } : {}),
    }
    const targets = [...new Set(tenantIds.map((id) => id.toLowerCase()))].filter((id) => !this.valid(id))
    let activated = 0
    let firstError: unknown = null
    for (const tenant of targets) {
      this.failures.delete(tenant)
      try {
        await this.activate(tenant)
        activated++
      } catch (error) {
        firstError ??= error
        this.messages.set(tenant, errorText(error))
      }
    }
    if (targets.length > 0 && activated === 0) {
      this.state = previous
      for (const tenant of targets) this.messages.delete(tenant)
      this.options.onChange?.()
      throw firstError
    }
    this.message = tenantIds.length === 0 ? "Sign in to a tenant to activate the license for it." : null
    this.save()
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
    const valid = this.valid(tenant)
    if (valid) {
      this.keepSeen()
      return valid.plan
    }
    if (options.retry) {
      this.failures.delete(tenant)
      this.community.delete(tenant)
    }
    if ((this.community.get(tenant) ?? 0) > Date.now()) return "community"
    try {
      const failure = this.failures.get(tenant)
      if (failure && failure.until > Date.now()) throw failure.error
      let pending = this.pending.get(tenant)
      if (!pending) {
        pending = this.entitle(tenant).finally(() => this.pending.delete(tenant))
        this.pending.set(tenant, pending)
      }
      await pending
      return this.valid(tenant)?.plan ?? "community"
    } catch (error) {
      if (!this.lapsedOrUnlicensed(tenant, error)) throw error
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

  private useCommunity(tenant: string): Plan {
    const owner = this.options.store.get(COMMUNITY_KEY)
    if (owner && owner !== tenant) throw new Error(communityLimit(owner))
    if (owner !== tenant) this.options.store.set(COMMUNITY_KEY, tenant)
    const first = !this.community.has(tenant)
    this.community.set(tenant, Date.now() + COMMUNITY_RECHECK_MS)
    this.messages.delete(tenant)
    this.failures.delete(tenant)
    if (first) this.options.onChange?.()
    return "community"
  }

  /** The tenant's plan as far as it is known without a network call, or null when it is not licensed. */
  plan(tenantId: string): Plan | null {
    this.load()
    const tenant = tenantId.toLowerCase()
    const payload = this.valid(tenant)
    if (payload) return payload.plan
    return this.options.store.get(COMMUNITY_KEY) === tenant ? "community" : null
  }

  private async entitle(tenant: string): Promise<void> {
    try {
      if (this.state?.activations[tenant]) {
        // A refused refresh drops the activation (for example after it was released in
        // the customer portal); try one fresh activation.
        await this.refresh(tenant).catch((error: unknown) => {
          if (!(error instanceof LicenseDenied)) throw error
          return this.activateAny(tenant)
        })
      } else {
        await this.activateAny(tenant)
      }
      if (!this.valid(tenant)) {
        throw new Error(
          this.state?.activations[tenant]?.source === "tenant"
            ? "Sign in to this tenant again to check your organization's license."
            : "The license is not valid for this tenant.",
        )
      }
    } catch (caught) {
      // Without a key and an organization license there is nothing to fix but adding a
      // key, which the License page already asks for.
      const error =
        caught instanceof LicenseDenied && caught.reason === "tenant_not_licensed" ? new Error(LICENSE_REQUIRED) : caught
      if (error === caught) this.messages.set(tenant, errorText(error))
      else this.messages.delete(tenant)
      this.failures.set(tenant, { error, until: Date.now() + FAILURE_COOLDOWN_MS })
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
    this.messages.delete(tenant)
    this.failures.delete(tenant)
    this.community.delete(tenant)
    // Removing the Community tenant frees the free plan for another tenant.
    if (this.options.store.get(COMMUNITY_KEY) === tenant) {
      this.options.store.delete(COMMUNITY_KEY)
      this.options.onChange?.()
    }
    const entry = this.state?.activations[tenant]
    if (!this.state || !entry) return
    try {
      if (entry.source === "tenant") await this.tenantCall(tenant, "deactivate", entry)
      else if (this.state.key) await this.call("deactivate", { key: this.state.key, activationId: entry.activationId })
    } catch (error) {
      if (!(error instanceof LicenseDenied) && entry.source !== "tenant") {
        this.options.onChange?.()
        throw error
      }
      if (!(error instanceof LicenseDenied)) {
        console.warn(`[license] Organization license activation for ${tenant} not released: ${errorText(error)}`)
      }
    }
    delete this.state.activations[tenant]
    this.save()
  }

  /** Releases every activation of this machine and forgets the key. */
  async deactivate(): Promise<void> {
    this.load()
    if (!this.state) return
    let failure: unknown = null
    for (const [tenantId, entry] of Object.entries(this.state.activations)) {
      try {
        if (entry.source === "tenant") await this.tenantCall(tenantId, "deactivate", entry)
        else if (this.state.key) await this.call("deactivate", { key: this.state.key, activationId: entry.activationId })
        delete this.state.activations[tenantId]
      } catch (error) {
        // An organization license activation needs a sign-in to release, so, as in
        // releaseTenant, it is forgotten rather than blocking the key's deactivation.
        if (error instanceof LicenseDenied) delete this.state.activations[tenantId]
        else if (entry.source === "tenant") {
          console.warn(`[license] Organization license activation for ${tenantId} not released: ${errorText(error)}`)
          delete this.state.activations[tenantId]
        } else failure = error
      }
    }
    if (failure) {
      this.save()
      throw failure
    }
    this.state = null
    this.message = null
    this.messages.clear()
    this.failures.clear()
    this.save()
  }

  /** The license state for the signed-in tenants plus every tenant with a stored activation. */
  status(signedInTenantIds: string[]): LicenseStatus {
    this.load()
    const signedIn = new Set(signedInTenantIds.map((id) => id.toLowerCase()))
    const tenantIds = [...new Set([...signedIn, ...Object.keys(this.state?.activations ?? {})])]
    const communityTenant = this.options.store.get(COMMUNITY_KEY)
    let keyToken: Entitlement | null = null
    const tenants = tenantIds.map((tenantId): TenantLicenseStatus => {
      const entry = this.state?.activations[tenantId]
      const payload = this.valid(tenantId)
      const source = payload && entry ? (entry.source ?? "key") : null
      if (payload && source === "key" && (!keyToken || payload.iat > keyToken.iat)) keyToken = payload
      return {
        tenantId,
        signedIn: signedIn.has(tenantId),
        activated: Boolean(entry),
        entitled: payload !== null,
        source,
        plan: payload?.plan ?? (communityTenant === tenantId ? "community" : null),
        tenants: payload?.tenants ?? null,
        expiresAt: payload ? new Date(payload.exp * 1000).toISOString() : null,
        shared: source === "key" ? (entry?.shared ?? null) : null,
        shareNeedsSignIn: source === "key" && Boolean(entry?.shareNeedsSignIn),
        displayKey: source === "tenant" ? (entry?.displayKey ?? null) : null,
        message: payload ? null : (this.messages.get(tenantId) ?? null),
      }
    })
    this.keepSeen()
    const key = this.state?.key
    const latest = keyToken as Entitlement | null
    return {
      hasKey: Boolean(key),
      keyHint: key ? `****${key.slice(-4)}` : null,
      persisted: this.options.persist,
      offline: this.offline,
      message: this.message,
      plan: latest?.plan ?? null,
      tenantLimit: latest?.tenants ?? null,
      communityTenantId: communityTenant ?? null,
      tenants,
    }
  }
}
