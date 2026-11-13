import { TRIAL_USED_MESSAGE } from "../../shared/constants"
import type { LicenseStatus } from "../../shared/ipc"

/**
 * Whether the dashboard offers the opt-in Pro trial for a tenant. It reads only the license
 * status the app already has: the tenant is on Community with nothing else covering it, tenant
 * trials are available, this installation never had a trial for it and has trials left, and the
 * admin has not dismissed the card for it. The trial service still decides; a refusal hides it.
 */
export function trialOfferEligible(status: LicenseStatus | null | undefined, tenantId: string, hiddenTenantIds: readonly string[]): boolean {
  const id = tenantId.toLowerCase()
  if (!id || !status || status.hasKey || status.tenantTrialsEnabled !== true || status.tenantTrialInstallLimit) return false
  if (hiddenTenantIds.includes(id)) return false
  const tenant = status.tenants.find(t => t.tenantId === id)
  if (!tenant?.signedIn || tenant.plan !== "community") return false
  // A license key, an organization license or a saved activation covers it.
  if (tenant.entitled || tenant.activated || tenant.source !== null) return false
  // A trial ran, runs, or can be resumed on this installation.
  if (tenant.trial || tenant.trialEndsAt || tenant.trialCanResume || tenant.trialResumeUntil) return false
  // The trial service refused it before, or the tenant already used its trial elsewhere.
  if (tenant.trialRefusal || tenant.message === TRIAL_USED_MESSAGE) return false
  return true
}

/**
 * After a start failed: the trial service's refusal text when it refused this tenant, which hides
 * the card for good, or null for a failure worth retrying (no network, a timeout).
 */
export function trialOfferRefusal(after: LicenseStatus | null | undefined, tenantId: string): string | null {
  const tenant = after?.tenants.find(t => t.tenantId === tenantId.toLowerCase())
  if (tenant?.trialRefusal) return tenant.trialRefusal
  if (tenant?.message === TRIAL_USED_MESSAGE) return TRIAL_USED_MESSAGE
  return null
}
