import type { Plan } from "../../shared/plans"

/**
 * The plan of an App Backup restore destination other than the installer's source tenant, as already
 * on record on this installation: the same cached entitlement and Community choice the license status
 * shows. It is a read only: no licensing request, no activation, no trial and no Community choice, so a
 * refused or cancelled restore leaves the license state as it was and sends nothing to tenuvault.com.
 * A tenant with no plan on record has none, and the restore asks for a plan.
 */
export function restoreDestinationPlan(license: { plan: (tenantId: string) => Plan | null }): (tenantId: string) => Promise<Plan | null> {
  return async (tenantId) => license.plan(tenantId)
}
