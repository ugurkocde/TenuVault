import { PublicClientApplication } from "@azure/msal-node"
import { fetchNetworkClient } from "./network-client"
import { ERROR_PAGE, firstSignInError, page, SignInCancelledError } from "./msal"
import { isGuid, isMicrosoftLoginUrl } from "../../shared/security"
import { provisionRegistration } from "./registration-provisioning"
import type { RegistrationResult, SetupProgress } from "../../shared/ipc"

export class AppRegistrationSetup {
  private cancelWaiting?: () => void
  private running = false
  constructor(private readonly host: {
    fetch: typeof fetch
    openBrowser: (url: string) => Promise<void>
    checkTenant: (tenant: string) => Promise<unknown>
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
        successTemplate: page("Signed in", "Signed in. TenuVault is now setting up the app registration. You can close this tab and return to TenuVault."),
        errorTemplate: ERROR_PAGE,
      })
      // A late browser answer after cancellation is never used and its memory cache is cleared.
      void interactive.finally(() => { if (cancelled) app.clearCache() }).catch(() => undefined)
      const result = await Promise.race([interactive, cancellation]).catch(error => { throw firstSignInError(error) })
      this.cancelWaiting = undefined
      if (!result.account?.tenantId || !result.account.username || !result.accessToken) throw new Error("Microsoft did not return the tenant, user name and access token. Nothing was changed.")
      return await provisionRegistration({
        fetch: this.host.fetch, token: result.accessToken,
        tenantId: result.account.tenantId.toLowerCase(), username: result.account.username,
        checkTenant: this.host.checkTenant, progress: this.host.progress,
      })
    } finally {
      this.cancelWaiting = undefined
      this.running = false
      await app.clearCache()
    }
  }
}
