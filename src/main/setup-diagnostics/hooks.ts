import { ExplainedSignInError } from "../auth/msal"
import type { BackupJob } from "../backup/engine"
import { LICENSE_REQUIRED, LicenseDenied } from "../license/service"
import { CommunityChoicePendingError, CommunityLimitError } from "../../shared/plan-errors"
import type { Plan } from "../../shared/plans"
import { diagnosticCode, reasonCode, signInResult, type SetupEventInput } from "./events"

/** How the first sign-in to the tenant's own app registration ended. */
export function signInEvent(error: unknown): SetupEventInput {
  const result = signInResult(error)
  if (result === "cancelled") return { name: "signin", props: { result } }
  return { name: "signin", props: { result, code: diagnosticCode(error), explained: error instanceof ExplainedSignInError } }
}

/** Whether a reported event is a setup error the app shows, which the reminder next to it may offer to share. */
export function isSetupError(event: SetupEventInput): boolean {
  const result = event.props?.result ?? event.props?.outcome
  // A reused registration without the consent TenuVault needs is shown as a problem too; one Microsoft is still publishing is not.
  return result === "failed" || result === "timeout" || result === "refused" || result === "unreachable" || result === "missing_consent"
}

/** The first license decision for a tenant that was checked: its plan, and why no trial started when it is on Community. */
export function licenseEvent(plan: Plan, source: string | null | undefined, trialSkipReason: string | undefined): SetupEventInput {
  if (source === "trial") return { name: "license", props: { outcome: "trial_started" } }
  if (plan !== "community") return { name: "license", props: { outcome: "licensed" } }
  return { name: "license", props: { outcome: "community", ...(trialSkipReason ? { reason: reasonCode(trialSkipReason) } : {}) } }
}

/**
 * A license check that did not let the tenant in: a refusal with its reason, or a service that could
 * not be reached. Null when the admin only has to choose the Community tenant, which is no refusal.
 */
export function licenseFailureEvent(error: unknown): SetupEventInput | null {
  if (error instanceof CommunityChoicePendingError) return null
  const refused = (reason: string): SetupEventInput => ({ name: "license", props: { outcome: "refused", reason: reasonCode(reason) } })
  if (error instanceof LicenseDenied) return refused(error.reason)
  if (error instanceof CommunityLimitError) return refused("community_limit")
  const message = error instanceof Error ? error.message : String(error)
  if (message === LICENSE_REQUIRED) return refused("tenant_not_licensed")
  if (/licensing service could not be reached|licensing service is busy/.test(message)) return { name: "license", props: { outcome: "unreachable" } }
  return refused("other")
}

/** How the first backup ended, with a closed class for a failure, never its message. */
export function firstBackupEvent(job: Pick<BackupJob, "status" | "failures" | "progressMessage" | "exception" | "unreachable">): SetupEventInput {
  if (job.status === "Cancelled") return { name: "first_backup", props: { result: "failed", errorClass: "cancelled" } }
  if (job.status === "Completed") {
    const partial = Boolean(job.failures) || /completed with \d+ warnings?/i.test(job.progressMessage)
    return { name: "first_backup", props: { result: partial ? "partial" : "ok" } }
  }
  const message = `${job.exception ?? ""} ${job.progressMessage}`
  const errorClass = job.unreachable
    ? "network"
    : /\b429\b|throttl/i.test(message)
      ? "throttled"
      : /\b40[13]\b|forbidden|unauthorized|permission|consent|not authorized/i.test(message)
        ? "permission"
        : /storage|blob|container|folder|disk|ENOSPC|EACCES|EPERM/i.test(message)
          ? "storage"
          : "other"
  return { name: "first_backup", props: { result: "failed", errorClass } }
}
