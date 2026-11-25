import { namedSignInCode, signInErrorRow } from "../../shared/sign-in-errors"
import { GRAPH_CLI_NEXT_STEP, GRAPH_CLI_UNAVAILABLE } from "../../shared/tenant-connection"
import { ConnectionSwitchError } from "./switch-failure"

const CONDITIONS: Record<string, string> = {
  consent_required: "This account has no existing grant for Microsoft Graph Command Line Tools.",
  interaction_required: "Microsoft requires another sign-in step or approval.",
  login_required: "Sign in to Microsoft with one work account in your browser, then try Start now again.",
  AADSTS90095: "This tenant requires administrator approval.",
  AADSTS500011: "Microsoft Graph is unavailable in this tenant.",
  AADSTS65001: "This account has no existing grant for Microsoft Graph Command Line Tools.",
  AADSTS65004: "Microsoft's consent request was declined.",
  AADSTS90094: "Microsoft requires administrator consent.",
  AADSTS700016: "Microsoft Graph Command Line Tools is unavailable in this tenant.",
  AADSTS7000218: "Microsoft rejected the public-client sign-in.",
}

export function graphCliSignInFailure(detail: string, code = namedSignInCode(detail)): ConnectionSwitchError {
  const known = code && (CONDITIONS[code] ?? signInErrorRow(code)?.meaning)
  if (code && known) return new ConnectionSwitchError(code, `${GRAPH_CLI_UNAVAILABLE} ${known} (${code}) ${GRAPH_CLI_NEXT_STEP}`)
  return new ConnectionSwitchError("unavailable", `${GRAPH_CLI_UNAVAILABLE} ${GRAPH_CLI_NEXT_STEP}`)
}
