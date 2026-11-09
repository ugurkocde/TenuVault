import type { Feature } from "../../shared/plans"
import { HUBS } from "../features/hubs"
import { entryBadgeFeature, useSelectedTenantPlan } from "../lib/selected-plan"
import { PlanBadge } from "./UpgradeNote"

/** The paid features behind each sidebar entry that opens a paid screen: a hub's tabs, the audit log or Sync. */
export const NAV_PLAN_FEATURES: Readonly<Record<string, readonly Feature[]>> = {
  "/portal/audit": ["auditLog"],
  "/portal/sync": ["sync"],
  ...Object.fromEntries(HUBS.map((hub) => [`/portal/${hub.id}`, hub.tabs.map((tab) => tab.feature)])),
}

/**
 * The plan badge of a link to a paid screen, in the sidebar or on a page. It follows the plan of the selected tenant, resolved like the
 * CIS Benchmarks entry and page (`useSelectedTenantPlan`), and shows only when that plan includes
 * none of the link's features. No badge while the plan is not known yet. The link keeps working:
 * the screen behind it explains the plan.
 */
export function NavPlanBadge({ features, className }: { features: readonly Feature[]; className?: string }) {
  const feature = entryBadgeFeature(useSelectedTenantPlan(), features)
  return feature ? <PlanBadge feature={feature} className={className} /> : null
}
