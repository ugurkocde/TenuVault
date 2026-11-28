import type { FailureClass, SignInFailure } from "../../shared/connection-health/model"
import { signInErrorRow } from "../../shared/sign-in-errors"

/**
 * What a failed token request is, for connection health: its class and Microsoft's code.
 *
 * It reads only what the sign-in boundary keeps as structure: the class of the error (its name),
 * Microsoft's error number and OAuth error as MSAL reports them (`errorNo`, `errorCode`) and the
 * HTTP status. It never reads a message, so a text that names a code, or words that sound like a
 * cause, change nothing here. The error an admin sees is worded elsewhere, from the same table.
 */

/** MSAL's own codes for a token request that got no answer. */
const NO_ANSWER = new Set(["network_error", "no_network_connectivity", "endpoints_resolution_error", "openid_config_error"])
/** The classes of this app's errors for a request that got no answer. */
const NO_ANSWER_NAMES = new Set(["NetworkUnreachableError", "ProxyAuthRequiredError", "TimeoutError"])
/** OAuth errors that ask for the admin: Microsoft's reference says to send an interactive request for these. */
const ASKS_FOR_SIGN_IN = new Set(["interaction_required", "login_required", "invalid_grant"])

/** In the order one fact outweighs another when an error and its causes say several things. */
const WEIGHT: readonly FailureClass[] = ["consent", "throttled", "unavailable", "unreachable", "readerCheck", "session"]

/** Microsoft's error number: `errorNo`, or an `errorCode` that is only numbers, as MSAL's own throttling reports one. */
function microsoftNumber(error: { errorNo?: unknown; errorCode?: unknown }): string | undefined {
  const number = typeof error.errorNo === "number" || typeof error.errorNo === "string" ? String(error.errorNo) : undefined
  if (number && /^\d{4,9}$/.test(number)) return number
  return typeof error.errorCode === "string" ? /^(\d{4,9})( \d{4,9})*$/.exec(error.errorCode)?.[1] : undefined
}

/** What one error of the chain says by its class, its OAuth error and its status. */
function classOf(error: { name?: unknown; errorCode?: unknown; status?: unknown; cause?: unknown }): FailureClass | undefined {
  const oauth = typeof error.errorCode === "string" ? error.errorCode : ""
  if (oauth === "consent_required") return "consent"
  if (error.status === 429) return "throttled"
  if (oauth === "temporarily_unavailable" || (typeof error.status === "number" && error.status >= 500 && error.status <= 599)) return "unavailable"
  if (NO_ANSWER.has(oauth) || (typeof error.name === "string" && NO_ANSWER_NAMES.has(error.name))) return "unreachable"
  // A connection failure as Node reports it: a system error code on the cause, such as ENOTFOUND.
  const system = error.cause && typeof error.cause === "object" ? (error.cause as { code?: unknown }).code : undefined
  if (typeof system === "string" && /^E[A-Z0-9_]+$/.test(system)) return "unreachable"
  if (error.name === "BackupReaderError") return "readerCheck"
  if (error.name === "SignInRequiredError" || error.name === "InteractionRequiredAuthError" || ASKS_FOR_SIGN_IN.has(oauth)) return "session"
  return undefined
}

export function signInFailure(error: unknown): SignInFailure {
  let code: string | undefined
  const said = new Set<FailureClass>()
  let current: unknown = error
  // An error wraps the one before it (a Backup Reader refusal wraps Microsoft's answer), a few levels at most.
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const number = microsoftNumber(current)
    if (number && !code) code = `AADSTS${number}`
    const found = classOf(current)
    if (found) said.add(found)
    current = (current as { cause?: unknown }).cause
  }
  const row = signInErrorRow(code)
  if (row) return { class: row.class, code: row.code }
  return { class: WEIGHT.find((candidate) => said.has(candidate)) ?? "unknown", ...(code ? { code } : {}) }
}
