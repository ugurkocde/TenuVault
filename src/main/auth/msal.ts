import { signedInTenant } from "./onboarding-tenant"
import {
  InteractionRequiredAuthError,
  LogLevel,
  PublicClientApplication,
  ServerError,
  type AccountInfo,
  type AuthenticationResult,
  type ICachePlugin,
} from "@azure/msal-node"
import type { SignedInAccount } from "../../shared/ipc"
import { captureTokenActor } from "../api/execution-metadata"
import { RESOURCE_SCOPES } from "../../shared/constants"
import { FIRST_SIGN_IN_TIMEOUT_MESSAGE } from "../../shared/app-registration"
import { ConnectionSwitchError } from "./switch-failure"
import { namedSignInCode, oauthSignInCode, signInLogCode, signInErrorRow } from "../../shared/sign-in-errors"
import { isGuid, isMicrosoftLoginUrl, normalizeGuid } from "../../shared/security"
import { fetchNetworkClient, msalTokenGrants, type TokenGrant } from "./network-client"
import { loopbackSignIn } from "./loopback-sign-in"
import { deviceCodeSignIn } from "./device-code-sign-in"
import { SETUP_HELPER_CLIENT_ID, TENUVAULT_CLIENT_ID } from "../../shared/tenant-connection"
import { accessTokenClaims, sharedTokenScopes, tokenIdentity } from "./token-identity"
import { AZURE_STORAGE_PACKS, missingPackScopes, resourcePackScopes, resourceScopes, type PermissionPack } from "../../shared/services/permission-packs"
import { consentIssue } from "./pack-consent"
import type { PackConsentCode } from "../../shared/pack-consent"
import type { StoredAccount } from "./stores"
import type { StagedSignIn } from "./tenant-connections"
import type { AppDeviceCode } from "../../shared/app-sources/types"

export interface AuthHost {
  /**
   * The fetch MSAL token traffic must use (in production the bridged Chromium fetch), so it
   * follows the system proxy and OS certificate store like the rest of the app. Required, so
   * no construction path can fall back to whatever fetch MSAL happens to pick up.
   */
  fetch: typeof fetch
  /** Encrypted per-client MSAL cache persistence. */
  cachePlugin: (clientId: string) => ICachePlugin
  authorizeInteractive?: (tenantId: string) => void
  sharedScopes?: (tenantId: string, scope: string, freshHealth: boolean) => Promise<string[]>
  authorizeConnection?: (tenantId: string, clientId: string, scope: string) => void
  authorizeSilentToken?: (tenantId: string, clientId: string, scope: string) => Promise<void>
  authorizeIssuedToken?: (tenantId: string, clientId: string, scope: string, result: AuthenticationResult & TokenGrant) => void
  /** Opens the system browser for the loopback sign-in flow. */
  openBrowser: (url: string) => Promise<void>
  /** Stores which account belongs to which tenant profile. */
  accountStore: {
    get: (tenantId: string) => SignedInAccount & { homeAccountId: string } | null
    set: (account: SignedInAccount & { homeAccountId: string }) => void
    delete: (tenantId: string) => void
    list: () => SignedInAccount[]
  }
}

type AcquiredToken = AuthenticationResult & TokenGrant

export type SilentTokenResult = AcquiredToken & {
  cachedAccount: Pick<AccountInfo, "homeAccountId" | "tenantId" | "localAccountId" | "username" | "name" | "idTokenClaims"> | null
}

function accountForTenant(account: AccountInfo, tenantId: string) {
  const tenant = normalizeGuid(tenantId)
  if (typeof account.tenantId === "string" && normalizeGuid(account.tenantId) === tenant) return account
  const profile = [...(account.tenantProfiles?.values() ?? [])].find(profile => normalizeGuid(profile.tenantId) === tenant)
  return profile ? { ...profile, homeAccountId: account.homeAccountId } : null
}

/**
 * The admin must sign in again (no cached account, expired session, or Conditional
 * Access asks for step-up). Background API calls never open a sign-in window; the UI
 * shows a prompt and calls `reauthenticate` when the admin agrees.
 */
export class SignInRequiredError extends Error {
  // Account-specific text is for the banner and must stay out of error messages and inspection.
  readonly #prompt: string
  get prompt(): string { return this.#prompt }

  /**
   * Microsoft's error number and OAuth error of a refused silent request, as MSAL reports them.
   * Connection health reads these; the message is worded for the admin and is never parsed.
   */
  declare readonly errorNo?: string
  declare readonly errorCode?: string

  constructor(
    readonly tenantId: string,
    readonly clientId: string,
    reason: string,
    /** The resource scope that needs the sign-in, so signing in again requests that scope. */
    readonly scope: string = RESOURCE_SCOPES.graph,
    /** Microsoft's refusal behind it, when there was one. */
    refusal?: SilentRefusal,
  ) {
    const code = silentRefusalCode(refusal)
    super(`${resourceName(scope)} (${code ?? "sign_in_required"}). Sign in again to this tenant.`)
    this.name = "SignInRequiredError"
    this.#prompt = reason
    if (code) this.errorNo = code.slice("AADSTS".length)
    const oauth = oauthSignInCode(refusal?.errorCode)
    if (oauth) this.errorCode = oauth
  }
}

const RESOURCE_NAMES: Record<string, string> = {
  [RESOURCE_SCOPES.graph]: "Microsoft Graph",
  [RESOURCE_SCOPES.management]: "Azure Service Management",
  [RESOURCE_SCOPES.storage]: "Azure Storage",
}

/** Whether `scope` is one of the resource scopes TenuVault signs in for. */
export function isResourceScope(scope: unknown): scope is string {
  return typeof scope === "string" && Object.hasOwn(RESOURCE_NAMES, scope)
}

export function requireOwnReauthenticationClient(clientId: string): void {
  if (normalizeGuid(clientId) === SETUP_HELPER_CLIENT_ID) throw new Error("Microsoft Graph Command Line Tools is only used by the setup helper and cannot be used to sign in.")
  if (normalizeGuid(clientId) === TENUVAULT_CLIENT_ID) throw new Error("Choose TenuVault app in the sign-in method settings.")
}

function resourceName(scope: string): string {
  return isResourceScope(scope) ? RESOURCE_NAMES[scope]! : "Microsoft"
}

type SilentRefusal = { errorNo?: unknown; errorCode?: unknown; errorMessage?: string; subError?: unknown }

function silentRefusalCode(refusal?: SilentRefusal): string | undefined {
  const number = refusal?.errorNo
  if ((typeof number === "number" || typeof number === "string") && /^\d{4,9}$/.test(String(number))) return `AADSTS${number}`
  const code = refusal?.errorCode
  if (typeof code === "string") {
    if (/^AADSTS\d{4,9}$/.test(code)) return code
    const numeric = /^(\d{4,9})( \d{4,9})*$/.exec(code)
    if (numeric) return `AADSTS${numeric[1]}`
  }
  return /\bAADSTS\d{4,9}\b/.exec(refusal?.errorMessage ?? "")?.[0]
}

/**
 * Message for a silent token request Microsoft refused. It names the resource and the AADSTS
 * code, because a refusal for one resource (such as AADSTS65001, no consent for Azure Storage)
 * can persist while signing in to Microsoft Graph succeeds.
 */
export function signInAgainMessage(username: string, scope: string, error: SilentRefusal): string {
  const codes = [oauthSignInCode(error.errorCode), silentRefusalCode(error)].filter(Boolean)
  const resource = isResourceScope(scope) ? RESOURCE_NAMES[scope] : undefined
  return `Microsoft needs you to sign in again as ${username}${resource ? ` for ${resource}` : ""}${codes.length ? ` (${codes.join(", ")})` : ""}.`
}

/**
 * An actionable error when the app registration lacks the permission (AADSTS650057) or admin
 * consent (AADSTS65001) for `scope`, which signing in again cannot fix; null otherwise.
 */
export function missingPermissionError(scope: string, error: unknown): Error | null {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.match(/AADSTS\d+\b/g)?.find((named) => signInErrorRow(named)?.noConsent)
  if (!code || !isResourceScope(scope)) return null
  const resource = RESOURCE_NAMES[scope]
  // Microsoft Graph has several delegated permissions; the Azure resources have user_impersonation.
  const permission = scope === RESOURCE_SCOPES.graph ? "Microsoft Graph permissions listed in the setup guide" : `${resource} user_impersonation permission`
  return new Error(
    `The app registration has no admin consent for ${resource} (${code}). Add the ${permission} to the app registration, grant admin consent, and sign in again.`,
  )
}

/** Thrown when the admin cancels a sign-in that is waiting for the browser. */
export class SignInCancelledError extends Error {
  constructor() {
    super("Sign-in cancelled.")
    this.name = "SignInCancelledError"
  }
}

/** How long a sign-in waits for the browser. Microsoft's own error pages never come back to the app. */
export const SIGN_IN_TIMEOUT_MS = 15 * 60_000

/** A sign-in in the browser did not come back in time. Setup diagnostics report it as `timeout`. */
export class SignInTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SignInTimeoutError"
  }
}

/** A failed first sign-in the app explains in its own words, so setup diagnostics can tell it from an unexplained one. */
export class ExplainedSignInError extends Error {}

/**
 * An actionable error for a failed first sign-in to a tenant: missing consent, a wrong client or
 * tenant ID, a misconfigured app registration or a Conditional Access block. Other errors are
 * returned unchanged.
 */
export function firstSignInError(error: unknown): unknown {
  const consent = missingPermissionError(RESOURCE_SCOPES.graph, error)
  if (consent) return new ExplainedSignInError(consent.message)
  const message = error instanceof Error ? error.message : String(error)
  const code = namedSignInCode(message)
  const explained = signInErrorRow(code)?.firstSignIn
  if (explained) return new ExplainedSignInError(`${explained} (${code})`)
  if (/access_denied|user_cancelled|user_canceled|authentication_canceled/i.test(message) && !code) return new ExplainedSignInError("The sign-in was cancelled in the browser. Sign in again to continue.")
  return error
}

// The licensing service accepts ID tokens issued within the last 15 minutes. Entra
// backdates iat by five minutes, so an older cached token is renewed.
const ID_TOKEN_MAX_AGE_MS = 10 * 60_000

/** Issue time (ms) of a JWT, read without verification: the licensing service verifies the token, the app only decides whether to renew it. */
export function isFreshIdToken(token: string): boolean {
  const issued = idTokenIssuedAt(token)
  return issued !== null && Date.now() - issued < ID_TOKEN_MAX_AGE_MS
}

export function idTokenIssuedAt(token: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { iat?: unknown }
    return typeof claims.iat === "number" ? claims.iat * 1000 : null
  } catch {
    return null
  }
}

// A ring that draws itself, then the tick (or the cross). Inline, because the page is served
// from this computer with nothing else to load. People who prefer reduced motion get it drawn.
const MARKS = {
  success: { color: "#16a34a", tint: "#dcfce7", path: "M15 27l7.5 7.5L37.5 19", length: 33 },
  error: { color: "#dc2626", tint: "#fee2e2", path: "M18 18l16 16M34 18L18 34", length: 46 },
} as const
const MARK_STYLE = `.mark{display:block;margin:0 auto 1.1rem;animation:pop .35s .85s ease-out both}
.ring{stroke-dasharray:151;stroke-dashoffset:151;animation:draw .55s ease-out forwards,fill .3s .5s ease-out forwards}
.sign{stroke-dashoffset:var(--length);animation:draw .35s .5s ease-out forwards}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes fill{to{fill:var(--tint)}}
@keyframes pop{50%{transform:scale(1.08)}}
@media (prefers-reduced-motion:reduce){.mark,.ring,.sign{animation:none}.ring,.sign{stroke-dashoffset:0}.ring{fill:var(--tint)}}`

/** The page the browser shows when a sign-in comes back to this computer. The texts are fixed, never user input. */
export function page(title: string, message: string, kind: keyof typeof MARKS = "success"): string {
  const mark = MARKS[kind]
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${MARK_STYLE}</style></head>
<body style="font-family:Segoe UI,system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a">
<main style="max-width:34rem;margin:1rem;padding:2.25rem 2.5rem;background:#fff;border-radius:1rem;box-shadow:0 1px 3px rgba(15,23,42,.15);text-align:center">
<svg class="mark" viewBox="0 0 52 52" width="76" height="76" aria-hidden="true" style="--tint:${mark.tint};--length:${mark.length}"><circle class="ring" cx="26" cy="26" r="24" fill="transparent" stroke="${mark.color}" stroke-width="3"/><path class="sign" d="${mark.path}" fill="none" stroke="${mark.color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${mark.length}"/></svg>
<h1 style="font-size:1.6rem;margin:0 0 .6rem">${title}</h1><p style="margin:0;line-height:1.5;color:#334155">${message}</p></main></body></html>`
}

// The headline is what the admin has to do next, because the browser is in front at this point.
const SUCCESS_PAGE = page("Go back to TenuVault", "You are signed in. You can close this tab.")
export const ERROR_PAGE = page("Sign-in failed", "Go back to TenuVault for details. You can close this tab.", "error")

/**
 * Delegated Microsoft Entra sign-in for the admin using the app.
 *
 * Tenants are accessed with public client app registrations (no client secret). Tokens are requested as the signed-in admin, so Conditional
 * Access, MFA and device compliance policies apply exactly as they do for the
 * Intune portal. Sign-in always opens the system browser, on Windows as on macOS, so
 * the admin can use a separate admin account rather than the one signed in to the
 * operating system. Device-based policies are satisfied by a browser that passes the
 * device identity (see the Conditional Access supported browsers).
 */
export class AuthManager {
  private readonly apps = new Map<string, PublicClientApplication>()
  /**
   * The Microsoft sign-in address the waiting first sign-in opened, so the admin can copy it into
   * another browser. Kept only while that sign-in waits.
   */
  private link: { url: string; owner: object } | null = null
  /** Rejects the first sign-ins (signIn) waiting for the browser, for cancelInteractive. */
  private readonly cancels = new Map<(error: Error) => void, string>()
  private readonly interactive = new Map<string, Promise<AcquiredToken>>()
  private readonly tokenGrants = new WeakMap<PublicClientApplication, ReturnType<typeof msalTokenGrants>>()
  private readonly interactiveControls = new Map<object, { tenant: string; controller: AbortController }>()

  constructor(private readonly host: AuthHost) {}

  /**
   * Interactive sign-in used when a tenant is added. `tenant` may be a tenant id or
   * a verified domain; the returned account always carries the tenant id.
   */
  async signIn(tenant: string, clientId: string, options?: {
    loginHint?: string
    /** Called when the browser has answered and the code is being redeemed: the browser step is over. */
    onBrowserDone?: () => void
    stage?: (clientId: string) => { cache: ICachePlugin; beforeSave: (tenantId: string) => void }
  }): Promise<SignedInAccount> {
    if (normalizeGuid(clientId) === SETUP_HELPER_CLIENT_ID) throw new Error("Microsoft Graph Command Line Tools is only used by the setup helper and cannot be used to sign in.")
    if (normalizeGuid(clientId) === TENUVAULT_CLIENT_ID) throw new Error("Choose TenuVault app in the sign-in method settings.")
    this.host.authorizeInteractive?.(tenant)
    if (options?.stage) clientId = normalizeGuid(clientId)
    const staged = options?.stage?.(clientId)
    const stagedApp = staged && this.createApp(clientId, staged.cache, true)
    const result = await this.acquireInteractive(clientId, tenant, RESOURCE_SCOPES.graph, options?.loginHint ? undefined : "select_account", options?.loginHint, true, options?.onBrowserDone, stagedApp).catch((error: unknown) => {
      throw firstSignInError(error)
    })
    const account = result.account
    if (!account) throw new Error("Microsoft did not return an account for this sign-in.")

    const signedIn = {
      tenantId: signedInTenant(tenant, result),
      clientId,
      username: account.username,
      name: account.name,
      homeAccountId: account.homeAccountId,
    }
    this.host.authorizeInteractive?.(signedIn.tenantId)
    this.host.authorizeConnection?.(signedIn.tenantId, clientId, RESOURCE_SCOPES.graph)
    staged?.beforeSave(signedIn.tenantId)
    this.host.accountStore.set(signedIn)
    return { tenantId: signedIn.tenantId, clientId, username: signedIn.username, name: signedIn.name }
  }

  /** Sign in without publishing either the profile or the token cache. */
  async stageSignIn(tenant: string, clientId: string, cache: ICachePlugin): Promise<Pick<StagedSignIn, "account" | "accessToken" | "grantedScopes">> {
    const result = await this.acquireInteractive(clientId, tenant, RESOURCE_SCOPES.graph, "select_account", undefined, true, undefined, this.createApp(clientId, cache, true)).catch((error: unknown) => {
      const description = error instanceof Error ? error.message : ""
      const known = signInErrorRow(namedSignInCode(description))
      if (known) {
        const safe = firstSignInError(new Error(known.code)) as Error
        throw new ConnectionSwitchError(known.code, safe.message === known.code ? `${known.meaning} (${known.code})` : safe.message)
      }
      if (error instanceof SignInCancelledError || /\b(access_denied|user_cancelled|user_canceled|authentication_canceled)\b/i.test(description)) {
        throw new ConnectionSwitchError("cancelled", "Sign-in cancelled. Sign in again to continue.")
      }
      if (error instanceof SignInTimeoutError) throw new ConnectionSwitchError("timeout", FIRST_SIGN_IN_TIMEOUT_MESSAGE)
      throw new ConnectionSwitchError("switch_failed")
    })
    const account = result.account
    if (!account) throw new ConnectionSwitchError("no_account", "Microsoft did not return an account for this sign-in.")
    return {
      account: { tenantId: signedInTenant(tenant, result), clientId, username: account.username, name: account.name, homeAccountId: account.homeAccountId },
      accessToken: result.accessToken, grantedScopes: result.grantedScopes,
    }
  }

  /** Keep the account and cache staged until the selected packs are confirmed for this tenant. */
  async stageTenuVaultSignIn(tenant: string, cache: ICachePlugin, packs: readonly PermissionPack[], onboarding = false): Promise<Pick<StagedSignIn, "account" | "accessToken" | "graphScopes" | "grantedScopes" | "idToken" | "missingOnboardingScopes">> {
    const app = this.createApp(TENUVAULT_CLIENT_ID, cache, true)
    const graphScopes = resourcePackScopes(packs, "graph")
    try {
      const result = await this.acquireInteractive(TENUVAULT_CLIENT_ID, tenant, resourceScopes("graph", graphScopes), "select_account", undefined, true, undefined, app)
      const actualTenant = signedInTenant(tenant, result)
      const account = result.account!
      const identity = tokenIdentity(result.accessToken)
      if (identity.decoded && (identity.tenantId !== actualTenant || identity.clientId !== TENUVAULT_CLIENT_ID)) {
        throw new ConnectionSwitchError("switch_failed", "Microsoft returned an access token that could not be verified for this tenant and app. Sign in again.")
      }
      const missingOnboardingScopes = missingPackScopes(graphScopes, sharedTokenScopes(result.accessToken, result.grantedScopes))
      if (!onboarding && missingOnboardingScopes.length) {
        throw new ConnectionSwitchError("AADSTS65001", "Some selected Microsoft Graph permissions are still missing. Review the packs and check again. (AADSTS65001)")
      }
      for (const pack of packs.filter(pack => pack.resource !== "graph")) {
        const scopes = resourceScopes(pack.resource, pack.scopes)
        let token: AuthenticationResult | null
        try {
          token = await app.acquireTokenSilent({ account, scopes, authority: authority(actualTenant), forceRefresh: true })
        } catch (error) {
          const issue = consentIssue(error instanceof Error ? error.message : "")
          throw new ConnectionSwitchError((issue?.code as PackConsentCode | undefined) ?? "AADSTS65001",
            `${pack.label}: ${issue?.message ?? "Check the approved permissions for this resource and try again."}`)
        }
        const identity = token && tokenIdentity(token.accessToken)
        if (!token?.accessToken || !matchesSelectedAccount(account, token) ||
          (identity?.decoded && (identity.tenantId !== actualTenant || identity.clientId !== TENUVAULT_CLIENT_ID)) ||
          missingPackScopes(pack.scopes, sharedTokenScopes(token.accessToken, this.tokenGrants.get(app)?.forResult(token).grantedScopes)).length) {
          throw new ConnectionSwitchError("AADSTS65001", `${pack.label} approval is still needed. Review the pack and check again.`)
        }
      }
      return {
        account: { tenantId: actualTenant, clientId: TENUVAULT_CLIENT_ID, username: account.username, name: account.name, homeAccountId: account.homeAccountId },
        accessToken: result.accessToken, graphScopes, grantedScopes: result.grantedScopes, idToken: result.idToken,
        ...(missingOnboardingScopes.length && { missingOnboardingScopes }),
      }
    } catch (error) {
      throw sharedSignInFailure(error, false)
    }
  }

  /** Check a fresh delegated token for just the selected pack, without saving the account. */
  async signInForPack(tenant: string, cache: ICachePlugin, pack: PermissionPack, checkOnly: boolean, homeAccountId?: string): Promise<void> {
    const app = this.createApp(TENUVAULT_CLIENT_ID, cache, true)
    try {
      const result = await this.acquireInteractive(TENUVAULT_CLIENT_ID, tenant, resourceScopes(pack.resource, pack.scopes),
        checkOnly ? "none" : "select_account", undefined, true, undefined, app)
      if (!result.account || normalizeGuid(result.account.tenantId) !== normalizeGuid(tenant)) throw new ConnectionSwitchError("wrong_tenant", "Sign in with an account from this tenant.")
      if (homeAccountId !== undefined && result.account.homeAccountId !== homeAccountId) {
        throw new ConnectionSwitchError("wrong_account", "Microsoft signed in with a different account. Use the account selected in TenuVault to verify Azure storage.")
      }
      const identity = tokenIdentity(result.accessToken)
      if (identity.decoded && (identity.tenantId !== normalizeGuid(tenant) || identity.clientId !== TENUVAULT_CLIENT_ID)) {
        throw new ConnectionSwitchError("switch_failed", "Microsoft returned an access token that could not be verified for this tenant and app. Sign in again.")
      }
      const scopes = sharedTokenScopes(result.accessToken, result.grantedScopes)
      if (missingPackScopes(pack.scopes, scopes).length) throw new ConnectionSwitchError("AADSTS65001", `${pack.label} approval is still needed. (AADSTS65001)`)
    } catch (error) {
      throw sharedSignInFailure(error, checkOnly)
    }
  }

  /** Use only the named Azure pack and the account already selected for this connection. */
  async azureStorageToken(stored: StoredAccount, cache: ICachePlugin, resource: "management" | "storage"): Promise<string> {
    const pack = AZURE_STORAGE_PACKS.find(pack => pack.resource === resource)!
    const app = this.createApp(TENUVAULT_CLIENT_ID, cache, true)
    const cached = await this.findAccount(app, stored.homeAccountId)
    const account = cached && accountForTenant(cached, stored.tenantId)
    if (!cached || !account) throw new Error("Sign in to the TenuVault app again.")
    try {
      const result = await app.acquireTokenSilent({ account: cached, scopes: resourceScopes(resource, pack.scopes), authority: authority(stored.tenantId), forceRefresh: true })
      const identity = tokenIdentity(result?.accessToken ?? "")
      const sameConnection = !identity.decoded || (identity.tenantId === stored.tenantId && identity.clientId === TENUVAULT_CLIENT_ID)
      if (sameConnection && result?.accessToken && matchesSelectedAccount(account, result) &&
        !missingPackScopes(pack.scopes, sharedTokenScopes(result.accessToken, this.tokenGrants.get(app)?.forResult(result).grantedScopes)).length) {
        return result.accessToken
      }
    } catch {
      // This operation never opens a browser. The pack dialog owns interactive consent.
    }
    throw new Error(`Check the ${pack.label} permission pack again with your signed-in account.`)
  }

  /** Force a silent acquisition in a disposable cache. This never opens a consent prompt. */
  async temporaryGraphToken(tenant: string, cache: ICachePlugin, scopes: readonly string[]): Promise<SilentTokenResult> {
    const stored = this.host.accountStore.get(tenant)
    if (stored?.clientId !== TENUVAULT_CLIENT_ID) throw new Error("Sign in to the TenuVault app in this tenant.")
    const app = this.createApp(TENUVAULT_CLIENT_ID, cache, true)
    const account = await this.findAccount(app, stored.homeAccountId)
    if (!account) throw new Error("Sign in to the TenuVault app again.")
    const result = await app.acquireTokenSilent({ account, scopes: resourceScopes("graph", scopes), authority: authority(tenant), forceRefresh: true })
    if (!result || this.host.accountStore.get(tenant)?.homeAccountId !== stored.homeAccountId) throw new Error("The signed-in account changed.")
    const acquisition = { ...result, ...this.tokenGrants.get(app)?.forResult(result) }
    if (missingPackScopes(scopes, sharedTokenScopes(result.accessToken, acquisition.grantedScopes)).length) throw new Error("Microsoft has not issued the temporary permissions.")
    const cachedAccount = accountForTenant(account, tenant)
    if (!cachedAccount) throw new Error("The signed-in account does not belong to this tenant.")
    return { ...acquisition, cachedAccount }
  }

  private async connectionScopes(tenant: string, clientId: string, scope: string, freshHealth = false): Promise<string[]> {
    if (normalizeGuid(clientId) === SETUP_HELPER_CLIENT_ID) {
      throw new Error("Microsoft Graph Command Line Tools is only used by the setup helper and cannot be used to sign in.")
    }
    if (normalizeGuid(clientId) === TENUVAULT_CLIENT_ID) {
      if (!this.host.sharedScopes) throw new Error("TenuVault app sign-in is unavailable.")
      return this.host.sharedScopes(tenant, scope, freshHealth)
    }
    return [scope]
  }

  async signOut(tenantId: string): Promise<void> {
    const stored = this.host.accountStore.get(tenantId)
    this.host.accountStore.delete(tenantId)
    if (!stored) return
    // MSAL signs an account out of every tenant at once, and the refresh token is shared across
    // tenants, so it cannot sign out of one alone. Keep the cache while another connected tenant
    // uses the same account and app registration; the removed tenant has no profile left to use it.
    const shared = this.host.accountStore.list().some((other) => {
      const profile = this.host.accountStore.get(other.tenantId)
      return profile && normalizeGuid(profile.clientId) === normalizeGuid(stored.clientId) && profile.homeAccountId === stored.homeAccountId
    })
    if (shared) return
    const app = this.app(stored.clientId)
    const account = await this.findAccount(app, stored.homeAccountId)
    if (account) await app.signOut({ account })
  }

  accounts(): SignedInAccount[] {
    return this.host.accountStore.list()
  }

  /** Reads the signed-in tenant identity from the same local MSAL account used for tokens. */
  async cachedAccountIdentity(tenantId: string): Promise<{ tenantId: string; clientId: string; userId: string }> {
    const tenant = normalizeGuid(tenantId), stored = this.host.accountStore.get(tenant)
    const account = stored ? await this.findAccount(this.app(stored.clientId), stored.homeAccountId) : null
    const profile = account && accountForTenant(account, tenant)
    if (!stored || normalizeGuid(stored.tenantId) !== tenant || !profile?.localAccountId) throw new Error("Sign in to this tenant before managing saved directory restores.")
    return { tenantId: profile.tenantId, clientId: stored.clientId, userId: profile.localAccountId }
  }

  /**
   * Returns an access token for `scope` in `tenantId` from the cache or with the refresh
   * token. Throws SignInRequiredError when the admin has to sign in again.
   */
  async getAccessToken(tenantId: string, clientId: string, scope: string, forceRefresh = false, authorize?: () => Promise<void>): Promise<SilentTokenResult> {
    this.host.authorizeConnection?.(tenantId, clientId, scope)
    // A registration switch during authorization must not change the account for this acquisition.
    const stored = this.host.accountStore.get(normalizeGuid(tenantId))
    if (!stored || normalizeGuid(stored.clientId) !== normalizeGuid(clientId)) {
      throw new SignInRequiredError(tenantId, clientId, "You are not signed in to this tenant. Sign in to continue.", scope)
    }

    const app = this.app(stored.clientId)
    if (this.host.authorizeSilentToken) await this.host.authorizeSilentToken(tenantId, clientId, scope)
    if (authorize) await authorize()
    const scopes = await this.connectionScopes(tenantId, clientId, scope)
    const account = await this.findAccount(app, stored.homeAccountId)
    if (!account) {
      throw new SignInRequiredError(tenantId, clientId, `Your session for ${stored.username} has ended. Sign in again to continue.`, scope)
    }
    // A refresh can return a bearer without returning an ID token or an account.
    const profile = accountForTenant(account, tenantId)
    const cachedAccount = profile ? { ...profile } : null
    try {
      const result = await app.acquireTokenSilent({ account, scopes, authority: authority(tenantId), forceRefresh })
      if (result) {
        const acquisition = { ...result, ...this.tokenGrants.get(app)?.forResult(result) }
        this.host.authorizeIssuedToken?.(tenantId, clientId, scope, acquisition)
        // The request is attributed to the account this token was issued for.
        captureTokenActor({ username: result.account?.username || account.username || stored.username, name: result.account?.name ?? account.name ?? undefined })
        return { ...acquisition, cachedAccount }
      }
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        throw new SignInRequiredError(tenantId, clientId, signInAgainMessage(stored.username, scope, error), scope, error)
      }
      if (error instanceof ServerError) {
        // MSAL includes the provider's description, which can identify the account.
        const code = silentRefusalCode(error)
        const oauth = oauthSignInCode(error.errorCode) ?? "token_request_failed"
        const guidance = signInErrorRow(code)?.firstSignIn ?? "Try again."
        throw new ServerError(oauth, "", `${resourceName(scope)} token request failed${code ? ` (${code})` : ""}. ${guidance}`, undefined, code?.slice("AADSTS".length), error.status)
      }
      throw error
    }
    throw new SignInRequiredError(tenantId, clientId, "Sign in again to continue.", scope)
  }

  /**
   * A recent Microsoft ID token of the admin signed in to `tenantId`, for the organization
   * license checks, or null when none can be had without user interaction. Its audience is
   * the tenant's app registration.
   */
  async getIdToken(tenantId: string): Promise<string | null> {
    const stored = this.host.accountStore.get(normalizeGuid(tenantId))
    if (!stored) return null
    const app = this.app(stored.clientId)
    const account = await this.findAccount(app, stored.homeAccountId).catch(() => null)
    if (!account) return null
    for (const forceRefresh of [false, true]) {
      try {
        const result = await app.acquireTokenSilent({
          account,
          scopes: await this.connectionScopes(tenantId, stored.clientId, RESOURCE_SCOPES.graph),
          authority: authority(tenantId),
          forceRefresh,
        })
        if (!result?.idToken) return null
        if (isFreshIdToken(result.idToken)) return result.idToken
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * Interactive sign-in for an existing tenant profile, pre-filled with its account. It asks
   * for `scope`, the resource that needed the sign-in, so Microsoft can show the consent or
   * Conditional Access step that resource requires instead of succeeding for Graph alone.
   */
  async reauthenticate(tenantId: string, clientId: string, scope: string = RESOURCE_SCOPES.graph): Promise<SignedInAccount> {
    requireOwnReauthenticationClient(clientId)
    this.host.authorizeInteractive?.(tenantId)
    if (!isResourceScope(scope)) throw new Error("Unknown sign-in scope.")
    this.host.authorizeConnection?.(tenantId, clientId, scope)
    const stored = this.host.accountStore.get(normalizeGuid(tenantId))
    const result = await this.acquireInteractive(clientId, tenantId, scope, undefined, stored?.username).catch((error: unknown) => {
      throw missingPermissionError(scope, error) ?? error
    })
    const account = result.account
    if (!account) throw new Error("Microsoft did not return an account for this sign-in.")
    const actualTenant = signedInTenant(tenantId, result)
    this.host.authorizeInteractive?.(tenantId)
    const signedIn = {
      tenantId: actualTenant,
      clientId,
      username: account.username,
      name: account.name,
      homeAccountId: account.homeAccountId,
    }
    this.host.authorizeConnection?.(tenantId, clientId, scope)
    this.host.accountStore.set(signedIn)
    return { tenantId: signedIn.tenantId, clientId, username: signedIn.username, name: signedIn.name }
  }

  private async findAccount(app: PublicClientApplication, homeAccountId: string): Promise<AccountInfo | null> {
    const accounts = await app.getAllAccounts()
    return accounts.find((account) => account.homeAccountId === homeAccountId) ?? null
  }

  async signInWithDeviceCode(tenant: string, clientId: string, onCode: (code: AppDeviceCode) => void, signal: AbortSignal): Promise<void> {
    this.host.authorizeInteractive?.(tenant)
    this.host.authorizeConnection?.(tenant, clientId, RESOURCE_SCOPES.graph)
    if (normalizeGuid(clientId) === SETUP_HELPER_CLIENT_ID) throw new Error("Microsoft Graph Command Line Tools is only used by the setup helper and cannot be used to sign in.")
    if (normalizeGuid(clientId) === TENUVAULT_CLIENT_ID) throw new Error("Sign in to the TenuVault app in the system browser.")
    // End this tenant's waiting browser attempts.
    for (const entry of this.interactiveControls.values()) if (normalizeGuid(entry.tenant) === normalizeGuid(tenant)) entry.controller.abort(new SignInCancelledError())
    const result = await deviceCodeSignIn(tenant, request => this.app(clientId).acquireTokenByDeviceCode(request), onCode, signal)
    signal.throwIfAborted()
    const account = result.account!
    this.host.authorizeInteractive?.(tenant)
    this.host.authorizeConnection?.(tenant, clientId, RESOURCE_SCOPES.graph)
    this.host.accountStore.set({ tenantId: signedInTenant(tenant, result), clientId, username: account.username, name: account.name, homeAccountId: account.homeAccountId })
  }

  /** One interactive prompt per tenant, scope, prompt and account hint at a time; parallel callers share it. */
  private acquireInteractive(
    clientId: string,
    tenant: string,
    scope: string | string[],
    prompt?: string,
    loginHint?: string,
    cancellable = false,
    onBrowserDone?: () => void,
    stagedApp?: PublicClientApplication,
  ): Promise<AcquiredToken> {
    const key = `${clientId}|${normalizeGuid(tenant)}|${scope}|${prompt ?? ""}|${loginHint ?? ""}|${stagedApp ? "staged" : "normal"}`
    const pending = this.interactive.get(key)
    if (pending) return pending

    // The app runs the browser sign-in itself (loopback-sign-in.ts), so ending an attempt closes
    // its listener: a browser tab finished later reaches nothing and no code is redeemed. Only the
    // first sign-in can be cancelled, so a reauthentication started elsewhere keeps waiting.
    const owner = {}
    const controller = new AbortController()
    this.interactiveControls.set(owner, { tenant, controller })
    const cancel = (error: Error) => controller.abort(error)
    const ended = () => {
      this.interactiveControls.delete(owner)
      clearTimeout(deadline)
      if (this.link?.owner === owner) this.link = null
      this.cancels.delete(cancel)
    }
    if (cancellable) this.cancels.set(cancel, key)
    // The first sign-in stops waiting after a while, like the setup sign-in.
    const deadline = cancellable ? setTimeout(() => cancel(new SignInTimeoutError(FIRST_SIGN_IN_TIMEOUT_MESSAGE)), SIGN_IN_TIMEOUT_MS) : undefined
    const app = stagedApp ?? this.app(clientId)
    const promise = loopbackSignIn({
      app,
      scopes: typeof scope === "string" ? [scope] : scope,
      authority: authority(tenant),
      ...(prompt ? { prompt } : {}),
      ...(loginHint ? { loginHint } : {}),
      openBrowser: (url) => {
        if (!isMicrosoftLoginUrl(url)) throw new Error("Microsoft returned an unexpected sign-in address.")
        if (cancellable) this.link = { url, owner }
        return this.host.openBrowser(url)
      },
      successPage: SUCCESS_PAGE,
      errorPage: ERROR_PAGE,
      signal: controller.signal,
      // The browser answered: the code is redeemed now, and a cancel or timeout no longer applies.
      onAnswer: () => {
        ended()
        onBrowserDone?.()
      },
    }).then(result => ({ ...result, ...this.tokenGrants.get(app)?.forResult(result) })).finally(() => {
      ended()
      if (this.interactive.get(key) === promise) this.interactive.delete(key)
    })
    this.interactive.set(key, promise)
    return promise
  }

  /** The Microsoft sign-in address of the first sign-in waiting for the browser, or null. */
  signInLink(): string | null {
    return this.link?.url ?? null
  }

  /**
   * Stops waiting for the first sign-ins open in the browser; they fail with SignInCancelledError.
   * Returns whether one was waiting. A sign-in whose browser step has ended is no longer waiting,
   * so a late cancel leaves it, and the license check after it, alone.
   */
  cancelInteractive(): boolean {
    const pending = [...this.cancels]
    this.cancels.clear()
    for (const [cancel, key] of pending) {
      this.interactive.delete(key)
      cancel(new SignInCancelledError())
    }
    return pending.length > 0
  }

  private app(clientId: string): PublicClientApplication {
    let app = this.apps.get(clientId)
    if (!app) {
      app = this.createApp(clientId, this.host.cachePlugin(clientId))
      this.apps.set(clientId, app)
    }
    return app
  }

  private createApp(clientId: string, cache: ICachePlugin, staged = false): PublicClientApplication {
    const grants = msalTokenGrants()
    const app = new PublicClientApplication({
      auth: { clientId, authority: authority("organizations") },
      cache: { cachePlugin: cache },
      system: {
        networkClient: fetchNetworkClient(this.host.fetch, grants.observe),
        loggerOptions: {
          logLevel: LogLevel.Warning,
          piiLoggingEnabled: false,
          loggerCallback: (_level, message) => { if (!staged) console.log("[msal]", signInLogCode(message) ?? "sign_in_warning") },
        },
      },
    })
    this.tokenGrants.set(app, grants)
    return app
  }
}

/** Refreshes can omit identity fields. Compare the ones Microsoft supplied to the selected account. */
function matchesSelectedAccount(account: Pick<AccountInfo, "tenantId" | "homeAccountId" | "localAccountId" | "idTokenClaims">, result: AuthenticationResult): boolean {
  const matches = (value: unknown, expected: string | undefined) =>
    value === undefined || value === "" || value === expected ||
    (isGuid(value) && isGuid(expected) && normalizeGuid(value) === normalizeGuid(expected))
  const tenant = account.tenantId
  const oid = account.localAccountId || account.idTokenClaims?.oid
  const sub = account.idTokenClaims?.sub
  const returned = result.account
  if (returned && (returned.homeAccountId !== account.homeAccountId || !matches(returned.tenantId, tenant) ||
    !matches(returned.localAccountId, oid))) return false
  if (!matches(result.tenantId, tenant) || (!matches(result.uniqueId, oid) && !matches(result.uniqueId, sub))) return false
  for (const claims of [result.idTokenClaims as AccountInfo["idTokenClaims"], returned?.idTokenClaims]) {
    if (!matches(claims?.tid, tenant) || !matches(claims?.oid, oid) || !matches(claims?.sub, sub) ||
      !matches(claims?.aud, TENUVAULT_CLIENT_ID)) return false
  }
  return matches(accessTokenClaims(result.accessToken)?.oid, oid)
}

function authority(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`
}

function sharedSignInFailure(error: unknown, checkOnly: boolean): ConnectionSwitchError {
  if (error instanceof ConnectionSwitchError) return error
  if (error instanceof SignInCancelledError) return new ConnectionSwitchError("cancelled", "Sign-in cancelled. Sign in again to continue.")
  if (error instanceof SignInTimeoutError) return new ConnectionSwitchError("timeout", FIRST_SIGN_IN_TIMEOUT_MESSAGE)
  const detail = error instanceof Error ? error.message : ""
  const issue = consentIssue(detail)
  if (issue) return new ConnectionSwitchError(issue.code as PackConsentCode, `${issue.message} (${issue.code})`)
  if (checkOnly && (error instanceof InteractionRequiredAuthError || /login_required|interaction_required|AADSTS50058/i.test(detail))) {
    return new ConnectionSwitchError("sign_in_required", "Microsoft needs you to sign in. Select Sign in to continue.")
  }
  return new ConnectionSwitchError("switch_failed", "The TenuVault app sign-in could not be completed. Try again.")
}
