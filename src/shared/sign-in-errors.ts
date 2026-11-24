/**
 * Microsoft's sign-in error codes that TenuVault knows, one row each: what kind of refusal the code
 * is, the connection state it leads to, a link to Microsoft's description of it, and what a first
 * sign-in, the setup and the Backup Reader say about it.
 *
 * It is the only place a code gets a meaning. The first sign-in and "sign in again" (main/auth/msal),
 * the setup (main/auth/app-registration-setup), the Backup Reader (main/auth/backup-reader) and
 * connection health (shared/connection-health) all read it.
 *
 * Every row was checked against Microsoft's reference of authentication and authorization error
 * codes (https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes) and
 * against Microsoft's error lookup page, which that reference names as the place for the current
 * description. A code the two describe differently has no row. AADSTS900023, AADSTS7000229,
 * AADSTS700024 and AADSTS70044 are on the lookup page only. Microsoft warns that codes change over
 * time, so a code without a row is never guessed at: it is shown with its number.
 */

import { CONSENT_ROLES_TEXT, CREATE_BY_HAND } from "./sign-in-words"

/**
 * What kind of refusal a code is, which says who can end it:
 * - session: the sign-in ended; the admin signs in again.
 * - mfa: Microsoft asks for multifactor authentication or another challenge; the admin completes it.
 * - conditionalAccess: a Conditional Access policy refused the device, the location or the app.
 * - consent: the app registration lacks a permission or its consent.
 * - registration: the app registration is missing or set up wrongly.
 * - application: the registration's enterprise application is turned off or missing.
 * - assignment: the account is not assigned to the application.
 * - account: the account is disabled or locked, or Microsoft blocked its sign-in.
 * - tenant: the tenant or the account is not the one the sign-in was meant for.
 * - credential: Microsoft does not accept the Backup Reader's certificate.
 * - throttled: Microsoft asks to slow down.
 * - unavailable: Microsoft's sign-in service failed in passing.
 */
export type SignInErrorClass =
  | "session"
  | "mfa"
  | "conditionalAccess"
  | "consent"
  | "registration"
  | "application"
  | "assignment"
  | "account"
  | "tenant"
  | "credential"
  | "throttled"
  | "unavailable"

/** The connection state a refused sign-in leads to. */
export type SignInErrorState =
  | "signInNeeded"
  | "mfaRequired"
  | "blockedByConditionalAccess"
  | "consentMissing"
  /**
   * Microsoft found no application with this client ID in the tenant the request went to. That is
   * all the code proves: the app registration may have been removed, it may never have been
   * installed or consented to in this tenant, or the request went to another tenant than the one
   * it is registered in. It is never to be shown as "deleted".
   */
  | "registrationNotFoundInTenant"
  | "registrationMisconfigured"
  | "applicationDisabled"
  | "servicePrincipalMissing"
  | "notAssigned"
  | "accountDisabled"
  /**
   * The account is locked after too many failed sign-ins, or Microsoft blocked the sign-in because
   * of the address it came from. Microsoft answers both with one code on purpose, so the state
   * keeps both readings and is shown with the code; the tenant's sign-in log tells them apart.
   */
  | "accountLockedOrBlocked"
  | "wrongTenantOrAccount"
  | "throttled"
  | "unreachable"
  /** Microsoft does not accept the Backup Reader's credential. An expired certificate is told by the certificate's own date, never by a code. */
  | "refused"

export interface SignInErrorRow {
  /** The code as Microsoft writes it, such as AADSTS50076. */
  code: string
  class: SignInErrorClass
  state: SignInErrorState
  /** Microsoft's description of the code. */
  link: string
  /** What Microsoft's reference says the code means, in a few words. */
  meaning: string
  /** What a first sign-in says; the code follows in brackets. */
  firstSignIn?: string
  /**
   * The app registration lacks the permission or its admin consent for the resource that was asked
   * for, which signing in again cannot fix. The message names that resource (see missingPermissionError).
   */
  noConsent?: true
  /**
   * What the setup says, before "Nothing was changed.". The setup signs in through Microsoft Graph
   * Command Line Tools, so a refusal of the app is about that app, not about the tenant's
   * registration. "firstSignIn" where the code reads the same for every sign-in.
   */
  setup?: string
  /** What the Backup Reader adds when the code is a refusal no retry can fix. */
  handoff?: true
  suggestReader?: true
  readerGuidance?: "certificate" | "renewal" | "conditionalAccess"
  reader?: string
}

/** Microsoft's own page for one code, as its error reference links to it. */
const lookup = (code: string) => `https://login.microsoftonline.com/error?code=${code.replace("AADSTS", "")}`

const TOOLS = "Microsoft Graph Command Line Tools, the Microsoft app that the setup and the setup script sign in through"
const setupNotApproved = (code: string) => `Microsoft did not let this account approve the setup (${code}). Sign in with a ${CONSENT_ROLES_TEXT}, or use "Someone else is the admin?".`
// The setup script signs in through the same app, so only the manual route gets around it.
const setupToolsRefused = (code: string) => `This tenant does not let your account sign in to ${TOOLS} (${code}). Ask your Entra administrator to allow it for your account, or ${CREATE_BY_HAND} in the Entra admin center.`

type Row = Omit<SignInErrorRow, "link">

const ROWS: readonly Row[] = [
  // The sign-in ended.
  { code: "AADSTS50173", class: "session", state: "signInNeeded", meaning: "The grant was revoked, for example after a password change or reset." },
  { code: "AADSTS700082", class: "session", state: "signInNeeded", meaning: "The refresh token expired because it was not used for a long time." },
  { code: "AADSTS70008", class: "session", state: "signInNeeded", meaning: "The authorization code or refresh token expired or was revoked." },
  { code: "AADSTS50133", class: "session", state: "signInNeeded", meaning: "The session is no longer valid after a password expiry or change." },
  { code: "AADSTS50132", class: "session", state: "signInNeeded", meaning: "The session is not valid or has expired." },
  { code: "AADSTS50089", class: "session", state: "signInNeeded", meaning: "The flow token expired." },
  { code: "AADSTS70043", class: "session", state: "signInNeeded", meaning: "The refresh token expired under a Conditional Access sign-in frequency." },
  { code: "AADSTS70044", suggestReader: true, class: "session", state: "signInNeeded", meaning: "The session expired under a Conditional Access sign-in frequency." },
  { code: "AADSTS50055", class: "session", state: "signInNeeded", meaning: "The password has expired." },

  // Multifactor authentication or another challenge.
  {
    code: "AADSTS50076", suggestReader: true, handoff: true, class: "mfa", state: "mfaRequired", meaning: "Multifactor authentication is required for the resource.",
    firstSignIn: "Microsoft asks for multifactor authentication for this sign-in, because of a Conditional Access policy, per-user MFA or a new location, and it was not completed. Sign in again and complete the MFA prompt in the browser. If no prompt appears, ask your Entra administrator to check the sign-in logs in the Entra admin center.",
  },
  {
    code: "AADSTS50079", suggestReader: true, handoff: true, class: "mfa", state: "mfaRequired", meaning: "The account has to register for multifactor authentication, or a federated provider has to supply the claim.",
    firstSignIn: "Microsoft requires multifactor authentication for this sign-in, because of a Conditional Access policy, per-user MFA or a new location, and your account cannot complete it yet. If your account is managed in Entra ID, register your security info at https://mysignins.microsoft.com/security-info and sign in again. If your account signs in through another identity provider (a federated account), that provider must supply the MFA claim: ask your administrator to set it up.",
  },
  { code: "AADSTS50074", class: "mfa", state: "mfaRequired", meaning: "Strong authentication is required and the challenge was not passed." },
  { code: "AADSTS50072", class: "mfa", state: "mfaRequired", meaning: "The account has to enroll for multifactor authentication." },
  { code: "AADSTS50078", class: "mfa", state: "mfaRequired", meaning: "The multifactor authentication that was presented has expired." },
  { code: "AADSTS50158", class: "mfa", state: "mfaRequired", meaning: "An external security challenge, such as another MFA provider or terms of use, was not satisfied." },

  // Conditional Access.
  {
    code: "AADSTS53000", handoff: true, class: "conditionalAccess", state: "blockedByConditionalAccess", meaning: "Conditional Access requires a compliant device.",
    firstSignIn: "Conditional Access requires a compliant or registered device. Use a browser that passes the device identity, such as Microsoft Edge signed in to your work profile, as the default browser and try again.",
    setup: "firstSignIn",
  },
  {
    code: "AADSTS53001", handoff: true, class: "conditionalAccess", state: "blockedByConditionalAccess", meaning: "Conditional Access requires a domain-joined device.",
    firstSignIn: "Conditional Access requires a domain-joined device. Use a browser that passes the device identity, such as Microsoft Edge signed in to your work profile, as the default browser and try again.",
    setup: "firstSignIn",
  },
  { code: "AADSTS53002", class: "conditionalAccess", state: "blockedByConditionalAccess", meaning: "Conditional Access requires an approved app." },
  {
    code: "AADSTS53003", readerGuidance: "conditionalAccess", handoff: true, class: "conditionalAccess", state: "blockedByConditionalAccess", meaning: "Conditional Access policies blocked the token.",
    firstSignIn: "Conditional Access blocked this sign-in. Check the sign-in logs in the Entra admin center for the policy, or sign in from a device and location it allows.",
    // A Conditional Access refusal may be about the device or the location, which the manual
    // route does not get around either, so the message names both ways on.
    setup: `Conditional Access blocked the sign-in to ${TOOLS} (AADSTS53003). Check the sign-in logs in the Entra admin center for the policy that applied. If it asks for a compliant device or an allowed location, sign in from one and select Try again. If it blocks Microsoft Graph Command Line Tools, ${CREATE_BY_HAND} in the Entra admin center.`,
    reader: "Conditional Access for workload identities blocked the Backup Reader from this location.",
  },
  { code: "AADSTS50131", class: "conditionalAccess", state: "blockedByConditionalAccess", meaning: "A Conditional Access decision failed the request, such as a device state or a security policy." },

  // Permissions and consent.
  {
    code: "AADSTS65001", handoff: true, class: "consent", state: "consentMissing", meaning: "No user or administrator has consented to the application.",
    noConsent: true,
    setup: setupNotApproved("AADSTS65001"),
  },
  { code: "AADSTS650057", class: "consent", state: "consentMissing", meaning: "The resource is not among the permissions the app registration asks for.", noConsent: true },
  {
    code: "AADSTS65004", class: "consent", state: "consentMissing", meaning: "The consent was declined.",
    firstSignIn: "The consent was declined in the browser. Sign in again and accept, or ask an administrator to run the setup script, which grants admin consent.",
    setup: `You declined Microsoft's request to approve Microsoft Graph Command Line Tools (AADSTS65004). Select Try again and accept it, or use "Someone else is the admin?".`,
  },
  {
    code: "AADSTS90094", handoff: true, class: "consent", state: "consentMissing", meaning: "Administrator consent is required.",
    firstSignIn: `Administrator consent is required: this tenant does not let your account grant the permissions the TenuVault app registration asks for. Ask a ${CONSENT_ROLES_TEXT} to grant admin consent for it, or send them the setup instructions.`,
    setup: setupNotApproved("AADSTS90094"),
  },

  // The app registration.
  {
    code: "AADSTS700016", class: "registration", state: "registrationNotFoundInTenant", meaning: "No application with this identifier was found in the tenant the request went to: it is not installed or consented to there, the identifier is wrong, or the request went to the wrong tenant.",
    firstSignIn: "No app registration with this client ID exists in this tenant. Check the Application (client) id, and that the tenant is the one the app registration was created in. If it was created a moment ago, wait a minute and sign in again.",
    setup: setupToolsRefused("AADSTS700016"),
    reader: "No app registration with this application ID exists in the tenant.",
  },
  {
    code: "AADSTS50011", class: "registration", state: "registrationMisconfigured", meaning: "The redirect URI does not match one configured for the application.",
    firstSignIn: "The app registration has no http://localhost redirect URI for mobile and desktop applications. Run the setup script again, or add the redirect URI as the setup guide describes.",
  },
  {
    code: "AADSTS7000218", class: "registration", state: "registrationMisconfigured", meaning: "The request must carry a client secret or assertion, so the application is not set up as a public client.",
    firstSignIn: "The app registration asks for a client secret, which happens when http://localhost is registered for the Web platform. In the Entra admin center, open the app registration > Authentication and add http://localhost under Mobile and desktop applications instead, or run the setup script again.",
  },

  // Its enterprise application.
  {
    code: "AADSTS7000112", class: "application", state: "applicationDisabled", meaning: "The application is disabled: its service principal in the tenant is turned off.",
    setup: setupToolsRefused("AADSTS7000112"),
    reader: "The Backup Reader app registration is disabled.",
  },
  {
    code: "AADSTS7000229", class: "application", state: "servicePrincipalMissing", meaning: "The application has no service principal in the tenant.",
    reader: "The Backup Reader app registration has no service principal in the tenant. Run the setup script again.",
  },

  // The account.
  {
    code: "AADSTS50105", class: "assignment", state: "notAssigned", meaning: "The account is not assigned to the application.",
    firstSignIn: "Your account is not assigned to the TenuVault app registration. Ask your Entra administrator to add you to the group that may sign in.",
    setup: setupToolsRefused("AADSTS50105"),
  },
  { code: "AADSTS50057", class: "account", state: "accountDisabled", meaning: "The user account is disabled." },
  { code: "AADSTS50053", class: "account", state: "accountLockedOrBlocked", meaning: "The account is locked after too many failed sign-ins, or the sign-in was blocked because it came from an address with malicious activity. One code stands for both." },

  // The wrong tenant or account.
  {
    code: "AADSTS50020", class: "tenant", state: "wrongTenantOrAccount", meaning: "The account comes from another identity provider and does not exist in the tenant.",
    firstSignIn: "This account does not belong to the tenant. Sign in with an admin account of this tenant.",
    setup: "firstSignIn",
  },
  { code: "AADSTS50034", class: "tenant", state: "wrongTenantOrAccount", meaning: "The account does not exist in the tenant's directory." },
  { code: "AADSTS90072", class: "tenant", state: "wrongTenantOrAccount", meaning: "The external account does not exist in the tenant it signed in to." },
  {
    code: "AADSTS90002", class: "tenant", state: "wrongTenantOrAccount", meaning: "The tenant was not found.",
    firstSignIn: "Microsoft does not know this tenant. Check the tenant ID or domain, for example contoso.onmicrosoft.com.",
    setup: "firstSignIn",
  },
  {
    code: "AADSTS900023", class: "tenant", state: "wrongTenantOrAccount", meaning: "The tenant identifier is neither a tenant ID nor a domain.",
    firstSignIn: "This is not a valid tenant ID or domain. Use the tenant ID of your tenant, or a domain such as contoso.onmicrosoft.com.",
    setup: "firstSignIn",
  },

  // Microsoft asks to slow down, or its service failed in passing.
  { code: "AADSTS50196", class: "throttled", state: "throttled", meaning: "Microsoft stopped a loop of the same token request." },
  { code: "AADSTS90055", class: "throttled", state: "throttled", meaning: "Too many requests came from the tenant." },
  { code: "AADSTS90033", class: "unavailable", state: "unreachable", meaning: "A transient error: Microsoft's directory service was not available." },
  { code: "AADSTS90006", class: "unavailable", state: "unreachable", meaning: "A transient error: a service was temporarily unavailable." },
  { code: "AADSTS90090", class: "unavailable", state: "unreachable", meaning: "A transient error: a service was temporarily unavailable." },
  { code: "AADSTS90024", class: "unavailable", state: "unreachable", meaning: "A transient error: a request budget was exceeded." },

  // The Backup Reader's certificate.
  {
    code: "AADSTS700027", readerGuidance: "certificate", class: "credential", state: "refused", meaning: "The client assertion failed signature validation: Microsoft does not accept the certificate that signed it.",
    reader: "Microsoft does not know this certificate. Upload the exported certificate with the setup script, then verify again.",
  },
  // Microsoft words this code for client secret keys, so it does not prove that the certificate expired.
  {
    code: "AADSTS7000222", readerGuidance: "renewal", class: "credential", state: "refused", meaning: "The client secret keys that were provided for the application have expired.",
    reader: "The certificate has expired. Create a renewal certificate in Settings and upload it.",
  },
  // May pass on a retry, for example after a clock correction, so the Backup Reader keeps trying.
  { code: "AADSTS700024", class: "credential", state: "refused", meaning: "The client assertion is outside its valid time range." },
]

export const SIGN_IN_ERRORS: readonly SignInErrorRow[] = ROWS.map((row) => ({ ...row, link: lookup(row.code) }))

const BY_CODE = new Map(SIGN_IN_ERRORS.map((row) => [row.code, row]))

/** The row of a code, or undefined for a code TenuVault has no meaning for. */
export function signInErrorRow(code: string | undefined): SignInErrorRow | undefined {
  return code ? BY_CODE.get(code) : undefined
}

/** Microsoft's description of a code, also for one without a row. */
export function signInErrorLink(code: string): string {
  return lookup(code)
}

/**
 * The first Microsoft error code a sign-in error's text names. A browser sign-in answers with a
 * description only, so the first sign-in, the setup and the Backup Reader find the code in it.
 */
export function namedSignInCode(text: string): string | undefined {
  return /AADSTS\d+/.exec(text)?.[0]
}

/** A fixed code for logs. The sign-in description may include the admin's username. */
export function signInLogCode(text: string): string | undefined {
  const code = namedSignInCode(text)
  if (code && /^AADSTS\d{4,8}$/.test(code)) return code
  let error: unknown
  try { error = JSON.parse(text)?.error } catch { return }
  if (typeof error === "string" && [
    "access_denied", "consent_required", "interaction_required", "invalid_client", "invalid_grant", "invalid_request",
    "invalid_scope", "login_required", "server_error", "temporarily_unavailable", "unauthorized_client",
  ].includes(error)) return error
}

/** Compatibility export, derived from the one error table. */
export const HANDOFF_SIGN_IN_CODES: readonly string[] = SIGN_IN_ERRORS.filter(row => row.handoff).map(row => row.code)
