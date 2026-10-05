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

export interface AuthHost {
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
  return new Error(
    `The app registration has no admin consent for ${resource} (${code}). Add the ${resource} user_impersonation permission to the app registration, grant admin consent, and sign in again.`,
  )
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
  private readonly interactive = new Map<string, Promise<AuthenticationResult>>()

  constructor(private readonly host: AuthHost) {}

  /**
   * Interactive sign-in used when a tenant is added. `tenant` may be a tenant id or
   * a verified domain; the returned account always carries the tenant id.
   */
  async signIn(tenant: string, clientId: string): Promise<SignedInAccount> {
    const result = await this.acquireInteractive(clientId, tenant, RESOURCE_SCOPES.graph, "select_account")
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
      throw new SignInRequiredError(tenantId, clientId, "You are not signed in to this tenant. Sign in to continue.")
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
  ): Promise<AuthenticationResult> {
    const key = `${clientId}|${tenant.toLowerCase()}|${scope}|${prompt ?? ""}|${loginHint ?? ""}`
    const pending = this.interactive.get(key)
    if (pending) return pending

    const request: InteractiveRequest = {
      scopes: [scope],
      authority: authority(tenant),
      openBrowser: this.host.openBrowser,
      successTemplate: SUCCESS_PAGE,
      errorTemplate: ERROR_PAGE,
      ...(prompt ? { prompt } : {}),
      ...(loginHint ? { loginHint } : {}),
    }
    const promise = this.app(clientId)
      .acquireTokenInteractive(request)
      .finally(() => this.interactive.delete(key))
    this.interactive.set(key, promise)
    return promise
  }

  private app(clientId: string): PublicClientApplication {
    let app = this.apps.get(clientId)
    if (!app) {
      app = new PublicClientApplication({
        auth: { clientId, authority: authority("organizations") },
        cache: { cachePlugin: this.host.cachePlugin(clientId) },
        system: {
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
