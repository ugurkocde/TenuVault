import type { LicenseStatus } from "../../shared/ipc"
import { allows, FEATURE_PLAN, type Feature, type Plan } from "../../shared/plans"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { tenantLicense, tenantPlan, useLicense } from "./license"

/**
 * The plan that applies to the selected tenant, shared by every sidebar plan badge (CIS Benchmarks
 * among them) and the CIS Benchmarks page so they cannot disagree.
 * - A signed-in tenant the license status lists as signed in: its own plan, or null when it cannot be used.
 * - A signed-in tenant the status does not list as signed in yet, a tenant whose sign-in is not known
 *   yet, or a status that is still loading: undefined, meaning the plan is not known yet.
 * - No tenant selected, or a selected tenant that is not signed in: the plan of this machine. A saved
 *   tenant profile keeps its credentials after a sign-out, and the status can list a stored
 *   activation for it with signedIn false, so neither counts as a sign-in. A tenant is signed in when
 *   the status lists it as signed in or the account store has it.
 *
 * This only decides what the page explains. Loading CIS content still needs a signed-in tenant whose
 * own plan includes it.
 */
export function selectedTenantPlan(status: LicenseStatus | null, tenantId: string | undefined, signedInTenantIds: ReadonlySet<string> | undefined): Plan | null | undefined {
  if (!status) return undefined
  if (!tenantId) return status.plan
  const license = tenantLicense(status, tenantId)
  if (license?.signedIn) return tenantPlan(license)
  // Signed in according to the account store, or not known yet: the status will catch up.
  if (!signedInTenantIds || signedInTenantIds.has(tenantId.toLowerCase())) return undefined
  return status.plan
}

/** {@link selectedTenantPlan} for the selected tenant and the current license status. */
export function useSelectedTenantPlan(): Plan | null | undefined {
  const { selectedTenant } = useSelectedTenant()
  const { status, signedInTenantIds } = useLicense()
  return selectedTenantPlan(status, selectedTenant?.credentials?.tenantId, signedInTenantIds)
}

/**
 * Whether a tenant on this computer has a plan that includes the feature, the rule of the Settings
 * sections for paid features. Undefined while that is not known: the license status is loading, or a
 * signed-in tenant is not listed as signed in by the status yet (its plan may still include it), or
 * the account store is not read yet.
 */
export function anyTenantIncludes(status: LicenseStatus | null, signedInTenantIds: ReadonlySet<string> | undefined, feature: Feature): boolean | undefined {
  if (!status) return undefined
  const included = status.tenants.some((tenant) => {
    const plan = tenantPlan(tenant)
    return plan !== null && allows(plan, feature)
  })
  if (included) return true
  if (!signedInTenantIds) return undefined
  if ([...signedInTenantIds].some((tenantId) => !tenantLicense(status, tenantId)?.signedIn)) return undefined
  return false
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
