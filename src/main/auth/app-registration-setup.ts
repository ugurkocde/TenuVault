import { executionMetadata } from "../api/execution-metadata"
import { GRAPH_CLI_CLIENT_ID } from "../../shared/tenant-connection"
import { accessTokenDigest, tokenIdentity } from "./token-identity"
import { PublicClientApplication } from "@azure/msal-node"
import { fetchNetworkClient } from "./network-client"
import { ERROR_PAGE, firstSignInError, page, SIGN_IN_TIMEOUT_MS, SignInCancelledError, SignInTimeoutError } from "./msal"
import { isGuid, isMicrosoftLoginUrl } from "../../shared/security"
import { CREATE_BY_HAND } from "../../shared/app-registration"
import { namedSignInCode, signInErrorRow } from "../../shared/sign-in-errors"
import { provisionRegistration } from "./registration-provisioning"
import { checkedOnboardingChoice } from "../../shared/services/onboarding"
import { loopbackSignIn } from "./loopback-sign-in"
import type { RegistrationResult, SetupProgress } from "../../shared/ipc"
import { diagnosticCode, signInResult, type SetupEventInput } from "../setup-diagnostics/events"

/**
 * Microsoft's refusals of the setup sign-in, in words that fit this step: the account declined
 * the approval of Microsoft Graph Command Line Tools, or may not give it.
 */
export function setupSignInError(error: unknown): unknown {
  if (error instanceof SignInCancelledError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/Nothing was changed\.$/.test(message)) return error
  const code = namedSignInCode(message)
  const nothingChanged = (text: string) => new Error(/Nothing was changed\.$/.test(text) ? text : `${text} Nothing was changed.`)
  // The setup signs in through Microsoft's app, not through the tenant's TenuVault app
  // registration, so the error table words a refusal of the app itself for this step.
  const setup = signInErrorRow(code)?.setup
  if (setup && setup !== "firstSignIn") return nothingChanged(setup)
  // Refusals about the tenant, the account and Conditional Access read the same for every sign-in.
  if (setup === "firstSignIn" || !code) {
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

/** How long the setup waits for the sign-in in the browser, as long as the first sign-in does. */
export const SETUP_SIGN_IN_TIMEOUT_MS = SIGN_IN_TIMEOUT_MS
export { SignInTimeoutError }

/** How the provisioning ended, as the `registration` setup diagnostics event reports it. */
export function registrationEvent(outcome: { result: RegistrationResult } | { error: unknown; phase: SetupProgress["phase"]; cancelled: boolean }): SetupEventInput {
  if ("result" in outcome) {
    const { result } = outcome
    return { name: "registration", props: { result: result.missingConsent.length ? "missing_consent" : !result.ready ? "not_ready" : result.reused ? "reused" : "created" } }
  }
  if (outcome.cancelled) return { name: "registration", props: { result: "cancelled", phase: outcome.phase } }
  return { name: "registration", props: { result: "failed", phase: outcome.phase, code: diagnosticCode(outcome.error) } }
}

export class AppRegistrationSetup {
  private cancelWaiting?: () => void
  /** The Microsoft sign-in address the waiting setup sign-in opened, kept only while it waits. */
  private link: string | null = null
  private controller?: AbortController
  private running = false
  constructor(private readonly host: {
    fetch: typeof fetch
    openBrowser: (url: string) => Promise<void>
    progress: (progress: SetupProgress) => void
    /** How the setup sign-in and the provisioning ended, for setup diagnostics. */
    report?: (event: SetupEventInput) => void
    checkNewTenant?: (tenantId: string) => void
  }) {}

  cancel(): void { this.controller?.abort(); this.cancelWaiting?.() }

  /**
   * Stops waiting for the setup sign-in in the browser only, for Try again. Returns whether it was
   * waiting; once the sign-in is over, the provisioning that follows is left alone.
   */
  cancelSignIn(): boolean {
    if (!this.cancelWaiting) return false
    this.cancelWaiting()
    return true
  }

  /** The Microsoft sign-in address of the setup sign-in waiting for the browser, or null. */
  signInLink(): string | null { return this.link }

  /**
   * Creates or finds the app registration. `choice` names the services, areas and access levels to
   * ask permissions for; without it the setup asks for what it always has.
   */
  async create(options?: { tenant?: string; choice?: unknown }): Promise<RegistrationResult> {
    if (this.running) throw new Error("Setup is already running.")
    if (options?.tenant !== undefined && (typeof options.tenant !== "string" || options.tenant.length > 253 || options.tenant !== "" && !isGuid(options.tenant) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(options.tenant))) throw new Error("Enter a valid tenant ID or domain.")
    // Checked before anyone signs in, so a choice the manifest does not know never reaches Microsoft.
    const choice = options?.choice === undefined ? undefined : checkedOnboardingChoice(options.choice)
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    // No cache plugin or logger. This client and its privileged tokens live only for this run.
    const app = new PublicClientApplication({
      auth: { clientId: GRAPH_CLI_CLIENT_ID, authority: `https://login.microsoftonline.com/${encodeURIComponent(options?.tenant || "organizations")}` },
      system: { networkClient: fetchNetworkClient(this.host.fetch) },
    })
    // The browser wait of this run. Ending it closes the sign-in's own listener, so a browser tab
    // finished later reaches nothing and no code is redeemed.
    const waiting = new AbortController()
    this.cancelWaiting = () => waiting.abort(new SignInCancelledError())
    // When Microsoft shows an error page of its own (admin approval needed, a blocked app,
    // Conditional Access), nothing returns to the app. Stop waiting after a while and say so.
    const deadline = setTimeout(() => waiting.abort(new SignInTimeoutError(`The sign-in in the browser was not completed within 15 minutes. If Microsoft said that you need admin approval, use "Someone else is the admin?". If it said that Microsoft Graph Command Line Tools is blocked, disabled or not assigned to you, or a Conditional Access policy blocks it, the setup script is blocked too: ${CREATE_BY_HAND} in the Entra admin center. Nothing was changed.`)), SETUP_SIGN_IN_TIMEOUT_MS)
    try {
      this.host.progress({ phase: "signingIn" })
      const result = await loopbackSignIn({
        app,
        scopes: ["https://graph.microsoft.com/Application.ReadWrite.All", "https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All"],
        prompt: "select_account",
        openBrowser: url => {
          if (!isMicrosoftLoginUrl(url)) throw new Error("Microsoft returned an unexpected sign-in address.")
          this.link = url
          return this.host.openBrowser(url)
        },
        successPage: page("Go back to TenuVault", "You are signed in. TenuVault is setting up the app registration and continues there. You can close this tab."),
        errorPage: ERROR_PAGE,
        signal: waiting.signal,
        // The browser answered and the code is redeemed now: the wait is over.
        onAnswer: () => {
          clearTimeout(deadline)
          this.link = null
          this.cancelWaiting = undefined
          this.host.progress({ phase: "signingIn", completing: true })
        },
      }).then(result => {
        // A cancel of the whole setup while the code was redeemed: nothing is created.
        if (controller.signal.aborted) throw new SignInCancelledError()
        return result
      }).finally(() => { this.link = null }).catch(error => {
        const result = signInResult(error)
        this.host.report?.({ name: "setup_signin", props: { result, ...(result === "failed" ? { code: diagnosticCode(error) } : {}) } })
        throw setupSignInError(error)
      })
      clearTimeout(deadline)
      this.cancelWaiting = undefined
      if (!result.account?.tenantId || !result.account.username || !result.accessToken) {
        this.host.report?.({ name: "setup_signin", props: { result: "failed", code: "other" } })
        throw new Error("Microsoft did not return the tenant, user name and access token. Nothing was changed.")
      }
      this.host.report?.({ name: "setup_signin", props: { result: "ok" } })
      let phase: SetupProgress["phase"] = "registration"
      try {
        const tenantId = result.account.tenantId.toLowerCase()
        const identity = tokenIdentity(result.accessToken)
        if ((result.tenantId && result.tenantId.toLowerCase() !== tenantId) ||
          (isGuid(options?.tenant) && options.tenant.toLowerCase() !== tenantId) ||
          (identity.decoded && (identity.tenantId !== tenantId || identity.clientId !== GRAPH_CLI_CLIENT_ID))) {
          throw new Error("Microsoft returned a setup sign-in for a different tenant or app. Nothing was changed.")
        }
        this.host.checkNewTenant?.(tenantId)
        const registrationSetup = { tenantId, clientId: GRAPH_CLI_CLIENT_ID, tokenDigest: accessTokenDigest(result.accessToken) }
        const registration = await executionMetadata.run({ registrationSetup }, () => provisionRegistration({
          fetch: this.host.fetch, token: result.accessToken,
          tenantId, username: result.account!.username,
          progress: (progress) => { phase = progress.phase; this.host.progress(progress) }, signal: controller.signal,
          ...(choice ? { choice } : {}),
        }))
        this.host.report?.(registrationEvent({ result: registration }))
        return registration
      } catch (error) {
        this.host.report?.(registrationEvent({ error, phase, cancelled: controller.signal.aborted }))
        throw error
      }
    } finally {
      clearTimeout(deadline)
      this.link = null
      this.cancelWaiting = undefined
      this.controller = undefined
      this.running = false
      await app.clearCache()
    }
  }
}
