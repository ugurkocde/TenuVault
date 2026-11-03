import type { LicenseStatus } from "../../shared/ipc"
import type { Plan } from "../../shared/plans"
import { tenantLicense, tenantPlan, useLicense } from "./license"

/**
 * The plan that applies to the selected tenant, shared by the CIS Benchmarks sidebar entry and the
 * CIS Benchmarks page so the two cannot disagree.
 * - A signed-in tenant the license status lists: its own plan, or null when it cannot be used.
 * - A signed-in tenant the status does not list yet, or a status that is still loading: undefined,
 *   meaning the plan is not known yet.
 * - No tenant selected, or a selected tenant that is not signed in: the plan of this machine.
 *
 * This only decides what the page explains. Loading CIS content still needs a signed-in tenant whose
 * own plan includes it.
 */
export function selectedTenantPlan(status: LicenseStatus | null, signedInTenantId: string | undefined): Plan | null | undefined {
  if (!status) return undefined
  if (!signedInTenantId) return status.plan
  const license = tenantLicense(status, signedInTenantId)
  return license ? tenantPlan(license) : undefined
}

/** {@link selectedTenantPlan} for the current license status. */
export function useSelectedTenantPlan(signedInTenantId: string | undefined): Plan | null | undefined {
  const { status } = useLicense()
  return selectedTenantPlan(status, signedInTenantId)
}
