import type { TenantLicenseStatus } from "../../shared/ipc"

/**
 * Whether two tenants form a Pro pair for the actions Pro allows between two tenants (Sync,
 * Dev to Prod, custom baseline deploy): both are entitled and covered by this machine's key,
 * by the same organization license, or each by a Pro trial on this installation. A Pro trial
 * stands in for the two-tenant license it lets an admin try.
 */
export function sameLicense(tenants: readonly Pick<TenantLicenseStatus, "tenantId" | "entitled" | "source" | "displayKey">[], a: string, b: string): boolean {
  const first = tenants.find((t) => t.tenantId === a.toLowerCase())
  const second = tenants.find((t) => t.tenantId === b.toLowerCase())
  if (!first?.entitled || !second?.entitled || first.source !== second.source) return false
  return first.source === "key" || first.source === "trial" || (first.displayKey !== null && first.displayKey === second.displayKey)
}
