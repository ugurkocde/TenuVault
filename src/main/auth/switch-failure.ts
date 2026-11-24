import type { PackConsentCode } from "../../shared/pack-consent"
import type { SignInErrorRow } from "../../shared/sign-in-errors"

type SwitchFailureCode = "invalid_request" | "conflict" | "unavailable" | "wrong_tenant" |
  "wrong_client" | "no_account" | "cancelled" | "timeout" | "switch_failed" | "sign_in_required" | PackConsentCode | SignInErrorRow["code"]

export class ConnectionSwitchError extends Error {
  constructor(readonly code: SwitchFailureCode, message = "The app registration could not be changed. Try again.") {
    super(message)
  }
}
