import { CommunityChoicePendingError, CommunityLimitError } from "../../shared/plan-errors"
import type { Plan } from "../../shared/plans"

/**
 * The plan of an App Backup restore destination other than the installer's source tenant, from the
 * license service's entitlement check. A tenant outside every license and the Community allowance has
 * none, so the restore asks for a plan instead of showing the Community tenant choice. Other failures,
 * such as an unreachable licensing service, stay errors. Restores into the source tenant never ask.
 */
export function restoreDestinationPlan(requireEntitlement: (tenantId: string, options: { retry: boolean }) => Promise<Plan>): (tenantId: string) => Promise<Plan | null> {
  return async (tenantId) => {
    try { return await requireEntitlement(tenantId, { retry: true }) }
    catch (error) { if (error instanceof CommunityLimitError || error instanceof CommunityChoicePendingError) return null; throw error }
  }
}
