import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { LicenseStatus, TenantLicenseStatus } from "../../shared/ipc"
import { planLabel, type Plan } from "../../shared/plans"
import { bridge } from "./bridge"

interface LicenseContextValue {
  status: LicenseStatus | null
  error: string | null
  refresh: () => Promise<void>
}

const LicenseContext = createContext<LicenseContextValue | null>(null)
const LICENSE_STATUS_TIMEOUT_MS = 30 * 1000

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refreshing = useRef(false)
  const attempt = useRef(0)

  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    const currentAttempt = ++attempt.current
    setError(null)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const nextStatus = await Promise.race([
        bridge.license.status(),
        new Promise<LicenseStatus>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The license check did not respond. Try again.")), LICENSE_STATUS_TIMEOUT_MS)
        }),
      ])
      if (attempt.current === currentAttempt) setStatus(nextStatus)
    } catch (error) {
      if (attempt.current === currentAttempt) setError(error instanceof Error ? error.message : String(error))
      console.error("Could not load license status:", error)
      throw error
    } finally {
      clearTimeout(timer)
      if (attempt.current === currentAttempt) refreshing.current = false
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

/** Community is a plan state; only a failed key or uncovered signed-in tenant is inactive. */
export function licenseChipState(status: LicenseStatus): { label: string; tone: "neutral" | "inactive" } {
  if (status.plan) return { label: planName(status.plan), tone: "neutral" }
  if (status.tenants.some((tenant) => tenant.entitled && tenant.plan !== "community")) {
    return { label: "Organization", tone: "neutral" }
  }
  if (status.keyState === "failed" || unlicensedTenants(status).length > 0) {
    return { label: "Inactive", tone: "inactive" }
  }
  if (status.keyState === "pending") return { label: "Key saved", tone: "neutral" }
  return { label: "Community", tone: "neutral" }
}

/** A Community notice returns 30 days after it was dismissed on this machine. */
export function communityBannerVisible(dismissedAt: string | undefined, now = Date.now()): boolean {
  if (!dismissedAt) return true
  const dismissed = Date.parse(dismissedAt)
  return !Number.isFinite(dismissed) || dismissed > now || now - dismissed >= 30 * 24 * 60 * 60 * 1000
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" })
}

/** Warn from 30 days before key expiry, including an expired key with a current offline token. */
export function licenseExpiryWarning(status: Pick<LicenseStatus, "validUntil">, now = Date.now()): "expiring" | "expired" | null {
  if (!status.validUntil) return null
  const expiry = Date.parse(status.validUntil)
  if (!Number.isFinite(expiry) || expiry > now + 30 * 24 * 60 * 60 * 1000) return null
  return expiry <= now ? "expired" : "expiring"
}

/** The earliest cached verification that runs out within two days while the licensing service is unreachable, or null. */
export function offlineDeadline(status: Pick<LicenseStatus, "offline" | "tenants">, now = Date.now()): string | null {
  if (!status.offline) return null
  const soon = now + 2 * 24 * 60 * 60 * 1000
  const expiring = status.tenants.filter((t) => t.entitled && t.expiresAt && Date.parse(t.expiresAt) < soon).map((t) => t.expiresAt!).sort()
  return expiring[0] ?? null
}

/** The tenant whose license expires first, so the warning can say whose license it is. */
export function earliestExpiringTenant(status: Pick<LicenseStatus, "validUntil" | "tenants">): TenantLicenseStatus | null {
  if (!status.validUntil) return null
  return status.tenants.find((t) => t.validUntil === status.validUntil) ?? null
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
