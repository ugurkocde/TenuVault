import type { PackConsentCode } from "../../shared/pack-consent"
import type { GRAPH_CLI_BROWSER_SIGN_IN_REQUIRED } from "../../shared/tenant-connection"
import type { SignInErrorRow } from "../../shared/sign-in-errors"

type SwitchFailureCode = "invalid_request" | "conflict" | "unavailable" | "wrong_tenant" |
  "wrong_client" | "wrong_account" | "no_account" | "cancelled" | "timeout" | "switch_failed" | "sign_in_required" | typeof GRAPH_CLI_BROWSER_SIGN_IN_REQUIRED | PackConsentCode | SignInErrorRow["code"]

export class ConnectionSwitchError extends Error {
  constructor(readonly code: SwitchFailureCode, message = "The app registration could not be changed. Try again.") {
    super(message)
  }
}
