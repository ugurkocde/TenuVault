import { signInErrorRow } from "../../shared/sign-in-errors"
import { GRAPH_CLI_BROWSER_SIGN_IN_MESSAGE, GRAPH_CLI_BROWSER_SIGN_IN_REQUIRED, GRAPH_CLI_NEXT_STEP, GRAPH_CLI_UNAVAILABLE } from "../../shared/tenant-connection"
import { ConnectionSwitchError } from "./switch-failure"

const CONDITIONS: Record<string, string> = {
  consent_required: "This account has no existing grant for Microsoft Graph Command Line Tools.",
  AADSTS900941: "Microsoft requires administrator consent.",
  AADSTS90095: "This tenant requires administrator approval.",
  AADSTS500011: "Microsoft Graph is unavailable in this tenant.",
  AADSTS65001: "This account has no existing grant for Microsoft Graph Command Line Tools.",
  AADSTS65004: "Microsoft's consent request was declined.",
  AADSTS90094: "Microsoft requires administrator consent.",
  AADSTS700016: "Microsoft Graph Command Line Tools is unavailable in this tenant.",
  AADSTS7000218: "Microsoft rejected the public-client sign-in.",
}

export function graphCliSignInFailure(aadsts?: string, oauth?: string, subError?: unknown): ConnectionSwitchError {
  const row = signInErrorRow(aadsts)
  const consentCode = row?.class === "consent" || aadsts === "AADSTS90095" || aadsts === "AADSTS900941" ? aadsts : undefined
  const consent = consentCode ?? (oauth === "consent_required" || subError === "consent_required" ? "consent_required" : undefined)
  const code = consent ?? aadsts ?? oauth
  if (!consent && (aadsts === "AADSTS50058" || oauth === "login_required" || oauth === "account_selection_required" ||
    (oauth === "interaction_required" && (!row || row.class === "session" || row.class === "mfa")))) {
    return new ConnectionSwitchError(GRAPH_CLI_BROWSER_SIGN_IN_REQUIRED, GRAPH_CLI_BROWSER_SIGN_IN_MESSAGE)
  }
  const known = code && (CONDITIONS[code] ?? row?.meaning)
  if (code && known) return new ConnectionSwitchError(code, `${GRAPH_CLI_UNAVAILABLE} ${known} (${code}) ${GRAPH_CLI_NEXT_STEP}`)
  return new ConnectionSwitchError("unavailable", `${GRAPH_CLI_UNAVAILABLE} ${GRAPH_CLI_NEXT_STEP}`)
}
