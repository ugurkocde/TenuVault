import type { LicenseStatus } from "../../shared/ipc"
import { allows } from "../../shared/plans"
import { tenantLicense, tenantPlan } from "./license"

/**
 * What the plan on record for an App Backup restore destination means for the restore, by the same
 * rule as the main process, which reads only the plan already on record:
 * - included: the installer's source tenant (free on every plan), or a tenant with Pro, MSP or an
 *   active Pro trial on record.
 * - excluded: another tenant with Community or no plan on record.
 * - unknown: the license status has not loaded yet.
 */
export type RestoreDestinationPlan = "included" | "excluded" | "unknown"

export function restoreDestinationPlan(status: LicenseStatus | null, sourceTenantId: string, targetTenantId: string): RestoreDestinationPlan {
  if (sourceTenantId.toLowerCase() === targetTenantId.toLowerCase()) return "included"
  if (!status) return "unknown"
  const plan = tenantPlan(tenantLicense(status, targetTenantId))
  return plan !== null && allows(plan, "appRestoreOtherTenant") ? "included" : "excluded"
}
