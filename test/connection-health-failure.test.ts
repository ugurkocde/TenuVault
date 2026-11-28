import { InteractionRequiredAuthError, ServerError } from "@azure/msal-node"
import { describe, expect, it } from "vitest"
import { BackupReaderError } from "../src/main/auth/backup-reader"
import { SignInRequiredError } from "../src/main/auth/msal"
import { NetworkUnreachableError, ProxyAuthRequiredError } from "../src/main/api/network-error"
import { signInFailure } from "../src/main/connection-health/failure"
import { signInState } from "../src/shared/connection-health/evaluate"
import { SIGN_IN_ERRORS } from "../src/shared/sign-in-errors"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "33333333-3333-3333-3333-333333333333"

/** A refused silent request as MSAL builds it from Microsoft's answer: the OAuth error, the description and the error number. */
const interaction = (errorNo: string, error = "interaction_required", description = "") => new InteractionRequiredAuthError(error, "correlation", description, undefined, undefined, undefined, undefined, errorNo)
const server = (error: string, errorNo?: string, status?: number, description = "") => new ServerError(error, "correlation", description, undefined, errorNo, status)

describe("the class and code of a failed token request", () => {
  it.each(SIGN_IN_ERRORS.map((row) => [row.code, row.class] as const))("takes %s from Microsoft's error number, as a %s refusal", (code, errorClass) => {
    expect(signInFailure(server("invalid_grant", code.slice(6)))).toEqual({ class: errorClass, code })
    expect(signInFailure(interaction(code.slice(6)))).toEqual({ class: errorClass, code })
  })

  it("reads Microsoft's error number, never the message", () => {
    // The text names another code and other words than the answer carries: the answer decides.
    const error = interaction("50076", "interaction_required", "AADSTS700016: Application was not found. Your session has ended. The app registration is disabled.")
    expect(signInFailure(error)).toEqual({ class: "mfa", code: "AADSTS50076" })
  })

  it("finds no code in a message alone", () => {
    expect(signInFailure(new Error("AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication."))).toEqual({ class: "unknown" })
    expect(signInFailure(new Error("Your session has ended. Sign in again to continue."))).toEqual({ class: "unknown" })
    expect(signInFailure("AADSTS53003")).toEqual({ class: "unknown" })
    expect(signInFailure(null)).toEqual({ class: "unknown" })
  })

  it("takes the error number as a number too, as Microsoft's answer carries it", () => {
    const error = Object.assign(new Error("refused"), { errorCode: "invalid_grant", errorNo: 50173 })
    expect(signInFailure(error)).toEqual({ class: "session", code: "AADSTS50173" })
  })

  it("keeps what the app's own sign-in error carries of Microsoft's answer", () => {
    const refused = new SignInRequiredError(TENANT, CLIENT, "Microsoft needs you to sign in again as admin@contoso.com for Microsoft Graph (interaction_required, AADSTS53003).", undefined, interaction("53003"))
    expect(refused).toMatchObject({ errorNo: "53003", errorCode: "interaction_required" })
    expect(signInFailure(refused)).toEqual({ class: "conditionalAccess", code: "AADSTS53003" })
    // The number is on the error, so a message that says something else changes nothing.
    expect(signInFailure(new SignInRequiredError(TENANT, CLIENT, "AADSTS50076", undefined, interaction("70043")))).toEqual({ class: "session", code: "AADSTS70043" })
  })

  it("is a sign-in that ended when nobody is signed in, or the session is gone", () => {
    expect(signInFailure(new SignInRequiredError(TENANT, CLIENT, "You are not signed in to this tenant. Sign in to continue."))).toEqual({ class: "session" })
    expect(signInFailure(new SignInRequiredError(TENANT, CLIENT, "Your session for admin@contoso.com has ended. Sign in again to continue."))).toEqual({ class: "session" })
  })

  it("asks for a sign-in when Microsoft asks for interaction with a code it has no row for, and keeps the code", () => {
    expect(signInFailure(interaction("50199"))).toEqual({ class: "session", code: "AADSTS50199" })
    expect(signInState(signInFailure(interaction("50199")))).toBe("signInNeeded")
    expect(signInFailure(server("invalid_grant", "9002341"))).toEqual({ class: "session", code: "AADSTS9002341" })
  })

  it.each([
    [server("consent_required"), "consent"],
    [server("invalid_client", undefined, 429), "throttled"],
    [server("temporarily_unavailable"), "unavailable"],
    [server("server_error", undefined, 503), "unavailable"],
    [server("login_required"), "session"],
    [server("invalid_client", "999999"), "unknown"],
    [server("unauthorized_client"), "unknown"],
  ] as const)("classes %o as %s when it has no row", (error, failureClass) => {
    expect(signInFailure(error).class).toBe(failureClass)
  })

  it("takes the code MSAL's own throttling reports for a request it did not send again", () => {
    // MSAL answers from its throttling cache with the error numbers as the error code.
    expect(signInFailure(server("50196"))).toEqual({ class: "throttled", code: "AADSTS50196" })
    expect(signInFailure(server("90055 50196"))).toEqual({ class: "throttled", code: "AADSTS90055" })
  })

  it.each([
    [Object.assign(new Error("network_error: Network request failed"), { errorCode: "network_error" })],
    [Object.assign(new Error("no network"), { errorCode: "no_network_connectivity" })],
    [new NetworkUnreachableError("login.microsoftonline.com could not be reached.")],
    [new ProxyAuthRequiredError()],
    [Object.assign(new Error("The operation timed out"), { name: "TimeoutError" })],
    [new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND login.microsoftonline.com"), { code: "ENOTFOUND" }) })],
  ])("is unreachable when the request got no answer (%o)", (error) => {
    expect(signInFailure(error)).toEqual({ class: "unreachable" })
  })

  it("does not take words about the network for a connection failure", () => {
    expect(signInFailure(new Error("fetch failed"))).toEqual({ class: "unknown" })
    expect(signInFailure(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toEqual({ class: "unknown" })
  })

  it("names a Backup Reader that Microsoft refused by Microsoft's code, and one its own checks refused as that", () => {
    const refused = new BackupReaderError("Microsoft refused the Backup Reader (AADSTS700027). Microsoft does not know this certificate.", { cause: server("invalid_client", "700027") })
    expect(signInFailure(refused)).toEqual({ class: "credential", code: "AADSTS700027" })
    expect(signInFailure(new BackupReaderError("The Backup Reader is missing permissions or their admin consent: DeviceManagementApps.Read.All."))).toEqual({ class: "readerCheck" })
    // A code without a row stays with the reader's refusal.
    expect(signInFailure(new BackupReaderError("Microsoft refused the Backup Reader (AADSTS999999).", { cause: server("invalid_client", "999999") }))).toEqual({ class: "readerCheck", code: "AADSTS999999" })
  })

  it("follows a chain of causes only a few levels deep", () => {
    let error: Error = server("invalid_grant", "50173")
    for (let depth = 0; depth < 4; depth++) error = new Error("wrapped", { cause: error })
    expect(signInFailure(error)).toEqual({ class: "session", code: "AADSTS50173" })
    for (let depth = 0; depth < 4; depth++) error = new Error("wrapped", { cause: error })
    expect(signInFailure(error)).toEqual({ class: "unknown" })
  })
})
