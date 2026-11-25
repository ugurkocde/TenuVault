import type { TenantLicenseStatus } from "../../shared/ipc"

/** Single-target Copy to Tenants, Dev to Prod and custom baseline deploy accept any two entitled Pro or MSP tenants. */
export function proPair(tenants: readonly Pick<TenantLicenseStatus, "tenantId" | "entitled" | "plan">[], a: string, b: string): boolean {
  return [a, b].every((id) => {
    const tenant = tenants.find((entry) => entry.tenantId.toLowerCase() === id.toLowerCase())
    return tenant?.entitled === true && (tenant.plan === "pro" || tenant.plan === "msp")
  })
}
