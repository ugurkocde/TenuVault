import {
  InteractionRequiredAuthError,
  LogLevel,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type ICachePlugin,
  type InteractiveRequest,
} from "@azure/msal-node"
import type { SignedInAccount } from "../../shared/ipc"
import { RESOURCE_SCOPES } from "../../shared/constants"
import { fetchNetworkClient } from "./network-client"

export interface AuthHost {
  /**
   * The fetch MSAL token traffic must use (in production the bridged Chromium fetch), so it
   * follows the system proxy and OS certificate store like the rest of the app. Required, so
   * no construction path can fall back to whatever fetch MSAL happens to pick up.
   */
  fetch: typeof fetch
  /** Encrypted per-client MSAL cache persistence. */
  cachePlugin: (clientId: string) => ICachePlugin
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

/**
 * The admin must sign in again (no cached account, expired session, or Conditional
 * Access asks for step-up). Background API calls never open a sign-in window; the UI
 * shows a prompt and calls `reauthenticate` when the admin agrees.
 */
export class SignInRequiredError extends Error {
  constructor(
    readonly tenantId: string,
    readonly clientId: string,
    reason: string,
    /** The resource scope that needs the sign-in, so signing in again requests that scope. */
    readonly scope: string = RESOURCE_SCOPES.graph,
  ) {
    super(reason)
    this.name = "SignInRequiredError"
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

/**
 * Message for a silent token request Microsoft refused. It names the resource and the AADSTS
 * code, because a refusal for one resource (such as AADSTS65001, no consent for Azure Storage)
 * can persist while signing in to Microsoft Graph succeeds.
 */
export function signInAgainMessage(username: string, scope: string, error: { errorCode?: string; errorMessage?: string }): string {
  const codes = [error.errorCode, /AADSTS\d+/.exec(error.errorMessage ?? "")?.[0]].filter(Boolean)
  const resource = isResourceScope(scope) ? RESOURCE_NAMES[scope] : undefined
  return `Microsoft needs you to sign in again as ${username}${resource ? ` for ${resource}` : ""}${codes.length ? ` (${codes.join(", ")})` : ""}.`
}

/**
 * An actionable error when the app registration lacks the permission (AADSTS650057) or admin
 * consent (AADSTS65001) for `scope`, which signing in again cannot fix; null otherwise.
 */
export function missingPermissionError(scope: string, error: unknown): Error | null {
  const message = error instanceof Error ? error.message : String(error)
  const code = /AADSTS(650057|65001)\b/.exec(message)?.[0]
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

/** Microsoft's refusals of a first sign-in that the admin can fix, with what to do. */
const FIRST_SIGN_IN_ERRORS: Record<string, string> = {
  AADSTS700016: "No app registration with this client ID exists in this tenant. Check the Application (client) id the setup script printed, and that the tenant is the one the script ran in.",
  AADSTS90002: "Microsoft does not know this tenant. Check the tenant ID or domain, for example contoso.onmicrosoft.com.",
  AADSTS900023: "This is not a valid tenant ID or domain. Use the Tenant id the setup script printed, or a domain such as contoso.onmicrosoft.com.",
  AADSTS50011: "The app registration has no http://localhost redirect URI for mobile and desktop applications. Run the setup script again, or add the redirect URI as the setup guide describes.",
  AADSTS7000218: "The app registration asks for a client secret, which happens when http://localhost is registered for the Web platform. In the Entra admin center, open the app registration > Authentication and add http://localhost under Mobile and desktop applications instead, or run the setup script again.",
  AADSTS50020: "This account does not belong to the tenant. Sign in with an admin account of this tenant.",
  AADSTS50105: "Your account is not assigned to the TenuVault app registration. Ask your Entra administrator to add you to the group that may sign in.",
  AADSTS53000: "Conditional Access requires a compliant or registered device. Use a browser that passes the device identity, such as Microsoft Edge signed in to your work profile, as the default browser and try again.",
  AADSTS53001: "Conditional Access requires a domain-joined device. Use a browser that passes the device identity, such as Microsoft Edge signed in to your work profile, as the default browser and try again.",
  AADSTS53003: "Conditional Access blocked this sign-in. Check the sign-in logs in the Entra admin center for the policy, or sign in from a device and location it allows.",
  AADSTS65004: "The consent was declined in the browser. Sign in again and accept, or ask an administrator to run the setup script, which grants admin consent.",
}

/**
 * An actionable error for a failed first sign-in to a tenant: missing consent, a wrong client or
 * tenant ID, a misconfigured app registration or a Conditional Access block. Other errors are
 * returned unchanged.
 */
export function firstSignInError(error: unknown): unknown {
  const consent = missingPermissionError(RESOURCE_SCOPES.graph, error)
  if (consent) return consent
  const message = error instanceof Error ? error.message : String(error)
  const code = /AADSTS\d+/.exec(message)?.[0]
  if (code && FIRST_SIGN_IN_ERRORS[code]) return new Error(`${FIRST_SIGN_IN_ERRORS[code]} (${code})`)
  if (/access_denied/i.test(message) && !code) return new Error("The sign-in was cancelled in the browser. Sign in again to continue.")
  return error
}

// The licensing service accepts ID tokens issued within the last 15 minutes. Entra
// backdates iat by five minutes, so an older cached token is renewed.
const ID_TOKEN_MAX_AGE_MS = 10 * 60_000

/** Issue time (ms) of a JWT, read without verification: the licensing service verifies the token, the app only decides whether to renew it. */
export function idTokenIssuedAt(token: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { iat?: unknown }
    return typeof claims.iat === "number" ? claims.iat * 1000 : null
  } catch {
    return null
  }
}

const SUCCESS_PAGE = page("Signed in to TenuVault", "You can close this tab and return to TenuVault.")
const ERROR_PAGE = page("Sign-in failed", "Return to TenuVault for details. You can close this tab.")

function page(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f8fafc;color:#0f172a">
<div style="text-align:center"><h1 style="font-size:1.5rem">${title}</h1><p>${message}</p></div></body></html>`
}

/**
 * Delegated Microsoft Entra sign-in for the admin using the app.
 *
 * Every tenant is accessed with the customer's own public client app registration
 * (no client secret). Tokens are requested as the signed-in admin, so Conditional
 * Access, MFA and device compliance policies apply exactly as they do for the
 * Intune portal. Sign-in always opens the system browser, on Windows as on macOS, so
 * the admin can use a separate admin account rather than the one signed in to the
 * operating system. Device-based policies are satisfied by a browser that passes the
 * device identity (see the Conditional Access supported browsers).
 */
export class AuthManager {
  private readonly apps = new Map<string, PublicClientApplication>()
  /** Rejects the first sign-ins (signIn) waiting for the browser, for cancelInteractive. */
  private readonly cancels = new Map<(error: Error) => void, string>()
  private readonly interactive = new Map<string, Promise<AuthenticationResult>>()

  constructor(private readonly host: AuthHost) {}

  /**
   * Interactive sign-in used when a tenant is added. `tenant` may be a tenant id or
   * a verified domain; the returned account always carries the tenant id.
   */
  async signIn(tenant: string, clientId: string): Promise<SignedInAccount> {
    const result = await this.acquireInteractive(clientId, tenant, RESOURCE_SCOPES.graph, "select_account", undefined, true).catch((error: unknown) => {
      throw firstSignInError(error)
    })
    const account = result.account
    if (!account) throw new Error("Microsoft did not return an account for this sign-in.")

    const signedIn = {
      tenantId: account.tenantId.toLowerCase(),
      clientId,
      username: account.username,
      name: account.name,
      homeAccountId: account.homeAccountId,
    }
    this.host.accountStore.set(signedIn)
    return { tenantId: signedIn.tenantId, clientId, username: signedIn.username, name: signedIn.name }
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
      return profile?.clientId === stored.clientId && profile.homeAccountId === stored.homeAccountId
    })
    if (shared) return
    const app = this.app(stored.clientId)
    const account = await this.findAccount(app, stored.homeAccountId)
    if (account) await app.signOut({ account })
  }

  accounts(): SignedInAccount[] {
    return this.host.accountStore.list()
  }

  /**
   * Returns an access token for `scope` in `tenantId` from the cache or with the refresh
   * token. Throws SignInRequiredError when the admin has to sign in again.
   */
  async getAccessToken(tenantId: string, clientId: string, scope: string, forceRefresh = false): Promise<AuthenticationResult> {
    const stored = this.host.accountStore.get(tenantId.toLowerCase())
    if (!stored || stored.clientId !== clientId) {
      throw new SignInRequiredError(tenantId, clientId, "You are not signed in to this tenant. Sign in to continue.", scope)
    }

    const app = this.app(clientId)
    const account = await this.findAccount(app, stored.homeAccountId)
    if (!account) {
      throw new SignInRequiredError(tenantId, clientId, `Your session for ${stored.username} has ended. Sign in again to continue.`, scope)
    }
    try {
      const result = await app.acquireTokenSilent({ account, scopes: [scope], authority: authority(tenantId), forceRefresh })
      if (result) return result
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        throw new SignInRequiredError(tenantId, clientId, signInAgainMessage(stored.username, scope, error), scope)
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
    const stored = this.host.accountStore.get(tenantId.toLowerCase())
    if (!stored) return null
    const app = this.app(stored.clientId)
    const account = await this.findAccount(app, stored.homeAccountId).catch(() => null)
    if (!account) return null
    for (const forceRefresh of [false, true]) {
      try {
        const result = await app.acquireTokenSilent({
          account,
          scopes: [RESOURCE_SCOPES.graph],
          authority: authority(tenantId),
          forceRefresh,
        })
        if (!result?.idToken) return null
        const issued = idTokenIssuedAt(result.idToken)
        if (issued !== null && Date.now() - issued < ID_TOKEN_MAX_AGE_MS) return result.idToken
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
    if (!isResourceScope(scope)) throw new Error("Unknown sign-in scope.")
    const stored = this.host.accountStore.get(tenantId.toLowerCase())
    const result = await this.acquireInteractive(clientId, tenantId, scope, undefined, stored?.username).catch((error: unknown) => {
      throw missingPermissionError(scope, error) ?? error
    })
    const account = result.account
    if (!account) throw new Error("Microsoft did not return an account for this sign-in.")
    if (account.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
      throw new Error("You signed in to a different tenant. Sign in with an account from this tenant.")
    }
    const signedIn = {
      tenantId: tenantId.toLowerCase(),
      clientId,
      username: account.username,
      name: account.name,
      homeAccountId: account.homeAccountId,
    }
    this.host.accountStore.set(signedIn)
    return { tenantId: signedIn.tenantId, clientId, username: signedIn.username, name: signedIn.name }
  }

  private async findAccount(app: PublicClientApplication, homeAccountId: string): Promise<AccountInfo | null> {
    const accounts = await app.getAllAccounts()
    return accounts.find((account) => account.homeAccountId === homeAccountId) ?? null
  }

  /** One interactive prompt per tenant, scope, prompt and account hint at a time; parallel callers share it. */
  private acquireInteractive(
    clientId: string,
    tenant: string,
    scope: string,
    prompt?: string,
    loginHint?: string,
    cancellable = false,
  ): Promise<AuthenticationResult> {
    const key = `${clientId}|${tenant.toLowerCase()}|${scope}|${prompt ?? ""}|${loginHint ?? ""}`
    const pending = this.interactive.get(key)
    if (pending) return pending

    // MSAL opens the browser after a few awaits; a sign-in cancelled before then never opens it.
    let cancelledEarly = false
    const request: InteractiveRequest = {
      scopes: [scope],
      authority: authority(tenant),
      openBrowser: (url) => cancelledEarly ? Promise.reject(new SignInCancelledError()) : this.host.openBrowser(url),
      successTemplate: SUCCESS_PAGE,
      errorTemplate: ERROR_PAGE,
      ...(prompt ? { prompt } : {}),
      ...(loginHint ? { loginHint } : {}),
    }
    // MSAL cannot abort a loopback sign-in, so a cancel stops waiting for it instead. A browser
    // tab finished later only fills the token cache; its result is never used. Only the first
    // sign-in can be cancelled, so a reauthentication started elsewhere keeps waiting.
    let cancel: (error: Error) => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = (error) => {
        cancelledEarly = true
        reject(error)
      }
    })
    if (cancellable) this.cancels.set(cancel, key)
    const interactive = this.app(clientId).acquireTokenInteractive(request)
    const promise = (cancellable ? Promise.race([interactive, cancelled]) : interactive)
      .finally(() => {
        this.cancels.delete(cancel)
        if (this.interactive.get(key) === promise) this.interactive.delete(key)
      })
    this.interactive.set(key, promise)
    return promise
  }

  /** Stops waiting for the first sign-ins open in the browser; they fail with SignInCancelledError. */
  cancelInteractive(): void {
    const pending = [...this.cancels]
    this.cancels.clear()
    for (const [cancel, key] of pending) {
      this.interactive.delete(key)
      cancel(new SignInCancelledError())
    }
  }

  private app(clientId: string): PublicClientApplication {
    let app = this.apps.get(clientId)
    if (!app) {
      app = new PublicClientApplication({
        auth: { clientId, authority: authority("organizations") },
        cache: { cachePlugin: this.host.cachePlugin(clientId) },
        system: {
          networkClient: fetchNetworkClient(this.host.fetch),
          loggerOptions: {
            logLevel: LogLevel.Warning,
            piiLoggingEnabled: false,
            loggerCallback: (_level, message) => console.log(`[msal] ${message}`),
          },
        },
      })
      this.apps.set(clientId, app)
    }
    return app
  }
}

function authority(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`
}
