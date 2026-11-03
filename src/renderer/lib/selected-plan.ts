import type { LicenseStatus } from "../../shared/ipc"
import { allows, FEATURE_PLAN, type Feature, type Plan } from "../../shared/plans"
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

/**
 * The feature whose plan badge an entry for several paid features shows, or null for no badge.
 * No badge while the plan is not known yet (undefined), or when the plan includes at least one of
 * the features. Otherwise the feature of the lowest plan that includes any of them, so the badge
 * names the cheapest way in. A plan that cannot be used (null) includes none of them.
 */
export function entryBadgeFeature(plan: Plan | null | undefined, features: readonly Feature[]): Feature | null {
  if (plan === undefined || features.length === 0) return null
  if (plan !== null && features.some((feature) => allows(plan, feature))) return null
  return features.find((feature) => FEATURE_PLAN[feature] === "pro") ?? features[0]!
}
