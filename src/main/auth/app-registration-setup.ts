import { PublicClientApplication } from "@azure/msal-node"
import { fetchNetworkClient } from "./network-client"
import { ERROR_PAGE, firstSignInError, page, SignInCancelledError } from "./msal"
import { isGuid, isMicrosoftLoginUrl } from "../../shared/security"
import { CONSENT_ROLES_TEXT, CREATE_BY_HAND } from "../../shared/app-registration"
import { provisionRegistration } from "./registration-provisioning"
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
  const code = /AADSTS\d+/.exec(message)?.[0]
  const nothingChanged = (text: string) => new Error(/Nothing was changed\.$/.test(text) ? text : `${text} Nothing was changed.`)
  if (code === "AADSTS65004") {
    return nothingChanged(`You declined Microsoft's request to approve Microsoft Graph Command Line Tools (${code}). Select Try again and accept it, or use "Someone else is the admin?".`)
  }
  if (code && ["AADSTS65001", "AADSTS90094"].includes(code)) {
    return nothingChanged(`Microsoft did not let this account approve the setup (${code}). Sign in with a ${CONSENT_ROLES_TEXT}, or use "Someone else is the admin?".`)
  }
  // The setup signs in through Microsoft's app, not through the tenant's TenuVault app
  // registration, so a refusal of the app itself is about Microsoft Graph Command Line Tools.
  // The setup script signs in through the same app, so only the manual route gets around it.
  if (code && ["AADSTS700016", "AADSTS7000112", "AADSTS50105"].includes(code)) {
    return nothingChanged(`This tenant does not let your account sign in to Microsoft Graph Command Line Tools, the Microsoft app that the setup and the setup script sign in through (${code}). Ask your Entra administrator to allow it for your account, or ${CREATE_BY_HAND} in the Entra admin center.`)
  }
  if (code === "AADSTS53003") {
    // A Conditional Access refusal may be about the device or the location, which the manual
    // route does not get around either, so the message names both ways on.
    return nothingChanged(`Conditional Access blocked the sign-in to Microsoft Graph Command Line Tools, the Microsoft app that the setup and the setup script sign in through (${code}). Check the sign-in logs in the Entra admin center for the policy that applied. If it asks for a compliant device or an allowed location, sign in from one and select Try again. If it blocks Microsoft Graph Command Line Tools, ${CREATE_BY_HAND} in the Entra admin center.`)
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

const SHARED_SIGN_IN_CODES = new Set(["AADSTS90002", "AADSTS900023", "AADSTS50020", "AADSTS53000", "AADSTS53001"])

/** How long the setup waits for the sign-in in the browser. Microsoft's own error pages never come back to the app. */
export const SETUP_SIGN_IN_TIMEOUT_MS = 15 * 60_000

/** The setup sign-in in the browser did not come back in time. */
export class SignInTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SignInTimeoutError"
  }
}

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
  private controller?: AbortController
  private running = false
  constructor(private readonly host: {
    fetch: typeof fetch
    openBrowser: (url: string) => Promise<void>
    progress: (progress: SetupProgress) => void
    /** How the setup sign-in and the provisioning ended, for setup diagnostics. */
    report?: (event: SetupEventInput) => void
  }) {}

  cancel(): void { this.controller?.abort(); this.cancelWaiting?.() }

  async create(options?: { tenant?: string }): Promise<RegistrationResult> {
    if (this.running) throw new Error("Setup is already running.")
    if (options?.tenant !== undefined && (typeof options.tenant !== "string" || options.tenant.length > 253 || options.tenant !== "" && !isGuid(options.tenant) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(options.tenant))) throw new Error("Enter a valid tenant ID or domain.")
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    // No cache plugin or logger. This client and its privileged tokens live only for this run.
    const app = new PublicClientApplication({
      auth: { clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e", authority: `https://login.microsoftonline.com/${encodeURIComponent(options?.tenant || "organizations")}` },
      system: { networkClient: fetchNetworkClient(this.host.fetch) },
    })
    let cancelled = false
    let abandon: (error: Error) => void = () => undefined
    const cancellation = new Promise<never>((_resolve, reject) => {
      abandon = (error) => { cancelled = true; reject(error) }
      this.cancelWaiting = () => abandon(new SignInCancelledError())
    })
    // When Microsoft shows an error page of its own (admin approval needed, a blocked app,
    // Conditional Access), nothing returns to the app. Stop waiting after a while and say so.
    const deadline = setTimeout(() => abandon(new SignInTimeoutError(`The sign-in in the browser was not completed within 15 minutes. If Microsoft said that you need admin approval, use "Someone else is the admin?". If it said that Microsoft Graph Command Line Tools is blocked, disabled or not assigned to you, or a Conditional Access policy blocks it, the setup script is blocked too: ${CREATE_BY_HAND} in the Entra admin center. Nothing was changed.`)), SETUP_SIGN_IN_TIMEOUT_MS)
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
        successTemplate: page("Go back to TenuVault", "You are signed in. TenuVault is setting up the app registration and continues there. You can close this tab."),
        errorTemplate: ERROR_PAGE,
      })
      // A late browser answer after cancellation is never used and its memory cache is cleared.
      void interactive.finally(() => { if (cancelled) app.clearCache() }).catch(() => undefined)
      const result = await Promise.race([interactive, cancellation]).catch(error => {
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
        const registration = await provisionRegistration({
          fetch: this.host.fetch, token: result.accessToken,
          tenantId: result.account.tenantId.toLowerCase(), username: result.account.username,
          progress: (progress) => { phase = progress.phase; this.host.progress(progress) }, signal: controller.signal,
        })
        this.host.report?.(registrationEvent({ result: registration }))
        return registration
      } catch (error) {
        this.host.report?.(registrationEvent({ error, phase, cancelled: controller.signal.aborted }))
        throw error
      }
    } finally {
      clearTimeout(deadline)
      this.cancelWaiting = undefined
      this.controller = undefined
      this.running = false
      await app.clearCache()
    }
  }
}
