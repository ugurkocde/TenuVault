import type { LicenseStatus } from "../../shared/ipc"
import { allows } from "../../shared/plans"
import { tenantLicense, tenantPlan } from "./license"

/**
 * What the plan of an App Backup restore destination means for the restore:
 * - included: the installer's source tenant (free on every plan), or a tenant whose plan includes appRestoreOtherTenant.
 * - excluded: another tenant whose current plan, Community among them, does not include it.
 * - uncovered: another tenant with no plan yet and no key on this machine that includes it. An
 *   organization license can still cover it on first use, so the main process decides.
 * - unknown: the license status is loading, or this machine's key can cover the tenant on first use.
 */
export type RestoreDestinationPlan = "included" | "excluded" | "uncovered" | "unknown"

export function restoreDestinationPlan(status: LicenseStatus | null, sourceTenantId: string, targetTenantId: string): RestoreDestinationPlan {
  if (sourceTenantId.toLowerCase() === targetTenantId.toLowerCase()) return "included"
  if (!status) return "unknown"
  const plan = tenantPlan(tenantLicense(status, targetTenantId))
  if (plan !== null) return allows(plan, "appRestoreOtherTenant") ? "included" : "excluded"
  return status.plan !== null && allows(status.plan, "appRestoreOtherTenant") ? "unknown" : "uncovered"
}
