import { PublicClientApplication } from "@azure/msal-node"
import { fetchNetworkClient } from "./network-client"
import { ERROR_PAGE, firstSignInError, page, SignInCancelledError } from "./msal"
import { isGuid, isMicrosoftLoginUrl } from "../../shared/security"
import { CONSENT_ROLES } from "../../shared/app-registration"
import { provisionRegistration } from "./registration-provisioning"
import type { RegistrationResult, SetupProgress } from "../../shared/ipc"

/**
 * Microsoft's refusals of the setup sign-in, in words that fit this step: the account declined
 * the approval of Microsoft Graph Command Line Tools, or may not give it.
 */
export function setupSignInError(error: unknown): unknown {
  if (error instanceof SignInCancelledError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = /AADSTS\d+/.exec(message)?.[0]
  const nothingChanged = (text: string) => new Error(/Nothing was changed\.$/.test(text) ? text : `${text} Nothing was changed.`)
  if (code && ["AADSTS65004", "AADSTS65001", "AADSTS90094"].includes(code)) {
    return nothingChanged(`Microsoft did not let this account approve the setup (${code}). Sign in with a ${CONSENT_ROLES.slice(0, -1).join(", ")} or ${CONSENT_ROLES.at(-1)}, or use "Someone else is the admin?".`)
  }
  // The setup signs in through Microsoft's app, not through the tenant's TenuVault app
  // registration, so a refusal of the app itself is about Microsoft Graph Command Line Tools.
  if (code && ["AADSTS700016", "AADSTS7000112", "AADSTS50105"].includes(code)) {
    return nothingChanged(`This tenant does not allow your account to use Microsoft Graph Command Line Tools, the Microsoft sign-in app the setup goes through (${code}). Ask your Entra administrator to allow it, or use "Use the setup script instead" and create the app registration by hand as the setup guide describes.`)
  }
  // Refusals about the tenant, the account and Conditional Access read the same for every sign-in.
  if (code && SHARED_SIGN_IN_CODES.has(code) || !code) {
    const mapped = firstSignInError(error)
    return nothingChanged(mapped instanceof Error ? mapped.message : String(mapped))
  }
  return nothingChanged(message)
}

/**
 * The account the sign-in after a setup may be completed as without the account picker: only for
 * the registration that setup just returned and the account that ran it. Anything else gets the
 * picker, so a request from the renderer cannot choose an account by itself.
 */
export function setupLoginHint(expected: { tenantId: string; clientId: string; username: string } | null, tenant: unknown, clientId: unknown, loginHint: unknown): string | undefined {
  if (!expected || typeof tenant !== "string" || typeof clientId !== "string" || typeof loginHint !== "string") return undefined
  return loginHint === expected.username && clientId.toLowerCase() === expected.clientId.toLowerCase() && tenant.toLowerCase() === expected.tenantId.toLowerCase() ? expected.username : undefined
}

const SHARED_SIGN_IN_CODES = new Set(["AADSTS90002", "AADSTS900023", "AADSTS50020", "AADSTS53000", "AADSTS53001", "AADSTS53003"])

export class AppRegistrationSetup {
  private cancelWaiting?: () => void
  private running = false
  constructor(private readonly host: {
    fetch: typeof fetch
    openBrowser: (url: string) => Promise<void>
    progress: (progress: SetupProgress) => void
  }) {}

  cancel(): void { this.cancelWaiting?.() }

  async create(options?: { tenant?: string }): Promise<RegistrationResult> {
    if (this.running) throw new Error("Setup is already running.")
    if (options?.tenant !== undefined && (typeof options.tenant !== "string" || options.tenant.length > 253 || options.tenant !== "" && !isGuid(options.tenant) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(options.tenant))) throw new Error("Enter a valid tenant ID or domain.")
    this.running = true
    // No cache plugin or logger. This client and its privileged tokens live only for this run.
    const app = new PublicClientApplication({
      auth: { clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e", authority: `https://login.microsoftonline.com/${encodeURIComponent(options?.tenant || "organizations")}` },
      system: { networkClient: fetchNetworkClient(this.host.fetch) },
    })
    let cancelled = false
    const cancellation = new Promise<never>((_resolve, reject) => {
      this.cancelWaiting = () => { cancelled = true; reject(new SignInCancelledError()) }
    })
    try {
      this.host.progress({ phase: "signingIn" })
      const interactive = app.acquireTokenInteractive({
        scopes: ["https://graph.microsoft.com/Application.ReadWrite.All", "https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All"],
        prompt: "select_account",
        openBrowser: url => {
          if (cancelled) throw new SignInCancelledError()
          if (!isMicrosoftLoginUrl(url)) throw new Error("Microsoft returned an unexpected sign-in address.")
          return this.host.openBrowser(url)
        },
        successTemplate: page("Signed in", "TenuVault is now setting up the app registration. You can close this tab and return to TenuVault."),
        errorTemplate: ERROR_PAGE,
      })
      // A late browser answer after cancellation is never used and its memory cache is cleared.
      void interactive.finally(() => { if (cancelled) app.clearCache() }).catch(() => undefined)
      const result = await Promise.race([interactive, cancellation]).catch(error => { throw setupSignInError(error) })
      this.cancelWaiting = undefined
      if (!result.account?.tenantId || !result.account.username || !result.accessToken) throw new Error("Microsoft did not return the tenant, user name and access token. Nothing was changed.")
      return await provisionRegistration({
        fetch: this.host.fetch, token: result.accessToken,
        tenantId: result.account.tenantId.toLowerCase(), username: result.account.username,
        progress: this.host.progress,
      })
    } finally {
      this.cancelWaiting = undefined
      this.running = false
      await app.clearCache()
    }
  }
}
