import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import type { LicenseStatus, TenantLicenseStatus } from "../../shared/ipc"
import { planLabel, type Plan } from "../../shared/plans"
import { bridge } from "./bridge"

interface LicenseContextValue {
  status: LicenseStatus | null
  error: string | null
  refresh: () => Promise<void>
}

const LicenseContext = createContext<LicenseContextValue | null>(null)

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await bridge.license.status())
      setError(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      console.error("Could not load license status:", error)
      throw error
    }
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
    const unsubscribe = bridge.license.onChanged(setStatus)
    // Tokens expire offline; keep the view current while the app stays open.
    const timer = setInterval(() => void refresh().catch(() => {}), 5 * 60 * 1000)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [refresh])

  return <LicenseContext.Provider value={{ status, error, refresh }}>{children}</LicenseContext.Provider>
}

export function useLicense(): LicenseContextValue {
  const value = useContext(LicenseContext)
  if (!value) throw new Error("useLicense must be used inside LicenseProvider")
  return value
}

export function planName(plan: Plan | null): string {
  return planLabel(plan ?? "pro")
}

/** The plan a tenant works under right now: its license, Community, or null when it cannot be used. */
export function tenantPlan(tenant: TenantLicenseStatus | undefined): Plan | null {
  if (!tenant) return null
  if (tenant.entitled) return tenant.plan
  return tenant.plan === "community" ? "community" : null
}

/** No key on this machine and no tenant licensed through its organization. */
export function isUnlicensed(status: LicenseStatus): boolean {
  return !status.hasKey && !status.tenants.some((tenant) => tenant.activated)
}

/** A Pro or MSP license covers this machine or one of its tenants; Community does not count. */
export function hasPaidLicense(status: LicenseStatus): boolean {
  return status.plan !== null || status.tenants.some((tenant) => tenant.entitled && tenant.plan !== "community")
}

/** Signed-in tenants the license does not cover right now. */
export function unlicensedTenants(status: LicenseStatus): TenantLicenseStatus[] {
  return status.tenants.filter((tenant) => tenant.signedIn && !tenantPlan(tenant))
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/**
 * The license state of a tenant profile. Undefined only for a tenant that is not signed in
 * and was never checked on this machine, such as one connected by an older version; it is
 * checked at its next sign-in.
 */
export function tenantLicense(status: LicenseStatus | null, tenantId: string | undefined): TenantLicenseStatus | undefined {
  const id = tenantId?.toLowerCase()
  return id ? status?.tenants.find((tenant) => tenant.tenantId === id) : undefined
}

/** The plan of one tenant, or null while the license is loading or does not cover it. */
export function useTenantPlan(tenantId: string | undefined): Plan | null {
  const { status } = useLicense()
  return tenantPlan(tenantLicense(status, tenantId))
}
