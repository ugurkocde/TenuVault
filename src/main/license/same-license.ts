import type { TenantLicenseStatus } from "../../shared/ipc"

/** Shared license coverage for Pro custom baseline deployment. Two Pro trials also qualify. */
export function sameLicense(tenants: readonly Pick<TenantLicenseStatus, "tenantId" | "entitled" | "source" | "displayKey">[], a: string, b: string): boolean {
  const first = tenants.find((t) => t.tenantId === a.toLowerCase())
  const second = tenants.find((t) => t.tenantId === b.toLowerCase())
  if (!first?.entitled || !second?.entitled || first.source !== second.source) return false
  return first.source === "key" || first.source === "trial" || (first.displayKey !== null && first.displayKey === second.displayKey)
}

/** Single-target Copy to Tenants and Dev to Prod accept any two entitled Pro or MSP tenants. */
export function proPair(tenants: readonly Pick<TenantLicenseStatus, "tenantId" | "entitled" | "plan">[], a: string, b: string): boolean {
  return [a, b].every((id) => {
    const tenant = tenants.find((entry) => entry.tenantId.toLowerCase() === id.toLowerCase())
    return tenant?.entitled === true && (tenant.plan === "pro" || tenant.plan === "msp")
  })
}
