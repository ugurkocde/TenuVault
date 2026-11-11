import { organizationLicenseRefusal } from "../../shared/trial-notices"
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { LicenseStatus, TenantLicenseStatus } from "../../shared/ipc"
import { planLabel, type Plan } from "../../shared/plans"
import { bridge } from "./bridge"
import { refreshInternalCisBenchmarks } from "./internal-cis"

interface LicenseContextValue {
  status: LicenseStatus | null
  /**
   * Lowercase ids of the tenants an admin is signed in to in this app, read from the account store,
   * or undefined until it was read. Saved tenant profiles keep their credentials after a sign-out,
   * so having credentials does not mean being signed in.
   */
  signedInTenantIds: ReadonlySet<string> | undefined
  error: string | null
  refresh: () => Promise<void>
}

const LicenseContext = createContext<LicenseContextValue | null>(null)
const LICENSE_STATUS_TIMEOUT_MS = 30 * 1000

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signedInTenantIds, setSignedInTenantIds] = useState<ReadonlySet<string> | undefined>(undefined)
  const refreshing = useRef(false)
  const hasLoaded = useRef(false)
  const pendingStatus = useRef<LicenseStatus | null>(null)
  const attempt = useRef(0)

  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    pendingStatus.current = null
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
      if (attempt.current === currentAttempt) {
        hasLoaded.current = true
        setStatus(pendingStatus.current ?? nextStatus)
        pendingStatus.current = null
        void refreshInternalCisBenchmarks()
      }
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
    const unsubscribe = bridge.license.onChanged((nextStatus) => {
      if (!hasLoaded.current) { pendingStatus.current = nextStatus; return }
      setStatus(nextStatus)
      void refreshInternalCisBenchmarks()
    })
    // Tokens expire offline; keep the view current while the app stays open.
    const timer = setInterval(() => void refresh().catch(() => {}), 5 * 60 * 1000)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [refresh])

  // Main sends a new status after every sign-in and sign-out, so the account store is read again
  // with each one. A failed read counts no account as signed in, which leaves the status's own
  // signedIn flags to decide.
  useEffect(() => {
    if (!status) return
    let current = true
    Promise.resolve()
      .then(() => bridge.auth.accounts())
      .then(
        (accounts) => { if (current) setSignedInTenantIds(new Set(accounts.map((account) => account.tenantId.toLowerCase()))) },
        () => { if (current) setSignedInTenantIds(new Set()) },
      )
    return () => { current = false }
  }, [status])

  return <LicenseContext.Provider value={{ status, signedInTenantIds, error, refresh }}>{children}</LicenseContext.Provider>
}

export function useLicense(): LicenseContextValue {
  const value = useContext(LicenseContext)
  if (!value) throw new Error("useLicense must be used inside LicenseProvider")
  return value
}

export function planName(plan: Plan | null): string {
  return planLabel(plan ?? "pro")
}

export function tenantPlanName(tenant: TenantLicenseStatus): string {
  return tenant.entitled && tenant.trial ? "Pro trial" : planName(tenant.plan)
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

/**
 * Tenant trials are on, no key is saved, and no signed-in tenant without a license can start
 * a trial any more: each one had its trial, or this computer reached its trial limit. Buying
 * Pro is then the way forward, not another trial.
 */
export function trialUsedUp(status: LicenseStatus): boolean {
  if (!status.tenantTrialsEnabled || status.hasKey) return false
  const open = status.tenants.filter((tenant) => tenant.signedIn && !tenant.entitled)
  return open.length > 0 && open.every((tenant) => organizationLicenseRefusal(tenant) || (tenant.trialRefusalPermanent ?? Boolean(tenant.trialRefusal)))
}

/** Signed-in tenants the license does not cover right now. */
export function unlicensedTenants(status: LicenseStatus): TenantLicenseStatus[] {
  return status.tenants.filter((tenant) => tenant.signedIn && !tenantPlan(tenant))
}

export function savedKeyNotNeededHere(status: LicenseStatus): boolean {
  const signedIn = status.tenants.filter(tenant => tenant.signedIn)
  return status.hasKey && !status.trial && status.keyState === "pending"
    && signedIn.some(tenant => tenant.entitled && tenant.source === "tenant")
    && signedIn.every(tenant => tenant.entitled)
}

/** Community is a plan state; only a failed key or uncovered signed-in tenant is inactive. */
export function licenseChipState(status: LicenseStatus): { label: string; tone: "neutral" | "inactive" | "trial"; daysLeft?: number } {
  const trial = status.tenants.filter(t => t.entitled && t.source === "trial").sort((a, b) => Date.parse(a.trialEndsAt ?? a.validUntil ?? "") - Date.parse(b.trialEndsAt ?? b.validUntil ?? ""))[0]
  if (trial) {
    const days = trialDaysLeft({ trial: true, trialEndsAt: trial.trialEndsAt ?? trial.validUntil ?? status.trialEndsAt }) ?? 0
    return { label: "Pro trial", tone: "trial", daysLeft: days }
  }
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

/** Active paid coverage takes precedence over the saved key's separate outcome. */
export function licensePageTitle(status: LicenseStatus): string {
  if (status.plan && status.trial) return "Pro trial active"
  if (status.plan) return `${planName(status.plan)} plan active`
  if (status.tenants.some((tenant) => tenant.entitled && tenant.plan !== "community")) {
    return "Licensed through your organization"
  }
  if (isUnlicensed(status)) return "Add your license"
  if (status.keyState === "failed") return "License key inactive"
  if (status.keyState === "pending") return "License key saved"
  return "Organization license inactive"
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

/**
 * Warn from 30 days before key expiry, including an expired key with a current offline token.
 * validUntil leaves out trial keys, which get the trial reminders instead.
 */
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
  const tenant = id ? status?.tenants.find((tenant) => tenant.tenantId === id) : undefined
  return tenant?.plan === "community" && status?.communityChoicePendingTenantIds?.includes(tenant.tenantId)
    ? { ...tenant, plan: null }
    : tenant
}

/** The plan of one tenant, or null while the license is loading or does not cover it. */
export function useTenantPlan(tenantId: string | undefined): Plan | null {
  const { status } = useLicense()
  return tenantPlan(tenantLicense(status, tenantId))
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The in-app trial reminders: day 20 and day 27 of the 30 day trial, 10 and 3 days before it ends. */
export const TRIAL_REMINDER_DAYS_LEFT = [10, 3] as const

/** Whole days left in the trial, rounded up, or null when this machine has no running trial. */
export function trialDaysLeft(status: Pick<LicenseStatus, "trial" | "trialEndsAt">, now = Date.now()): number | null {
  if (!status.trial || !status.trialEndsAt) return null
  const end = Date.parse(status.trialEndsAt)
  if (!Number.isFinite(end) || end <= now) return null
  return Math.ceil((end - now) / DAY_MS)
}

/**
 * The trial reminder due now, or null. A reminder shows from its day until the trial ends or
 * the admin dismisses it; a dismissal before the day-27 reminder does not hide that one.
 */
export function trialReminder(
  status: Pick<LicenseStatus, "trial" | "trialEndsAt"> & Partial<Pick<LicenseStatus, "tenants">>,
  dismissedAt: string | undefined,
  now = Date.now(),
): { stage: "day-20" | "day-27"; daysLeft: number; endsAt: string; tenantTrial?: boolean; tenantId?: string } | null {
  const candidates = status.tenants?.filter(tenant => tenant.entitled && tenant.trial).map(tenant => ({
    endsAt: tenant.trialEndsAt ?? tenant.validUntil,
    tenantId: tenant.source === "trial" ? tenant.tenantId : undefined,
    tenantTrial: tenant.source === "trial",
  })) ?? []
  if (!candidates.length && status.trial && status.trialEndsAt) candidates.push({ endsAt: status.trialEndsAt, tenantTrial: false, tenantId: undefined })
  for (const candidate of candidates.sort((a, b) => Date.parse(a.endsAt ?? "") - Date.parse(b.endsAt ?? ""))) {
    if (!candidate.endsAt) continue
    const daysLeft = trialDaysLeft({ trial: true, trialEndsAt: candidate.endsAt }, now)
    if (daysLeft === null) continue
    const end = Date.parse(candidate.endsAt)
    const started = (candidate.tenantTrial ? [5, 1] : TRIAL_REMINDER_DAYS_LEFT).filter(days => end - days * DAY_MS <= now)
    const days = started[started.length - 1]
    if (days === undefined) continue
    const dismissed = dismissedAt ? Date.parse(dismissedAt) : NaN
    if (Number.isFinite(dismissed) && dismissed >= end - days * DAY_MS && dismissed <= now) continue
    return { stage: days === 3 || days === 1 ? "day-27" : "day-20", daysLeft, endsAt: candidate.endsAt, ...(candidate.tenantTrial ? { tenantTrial: true, tenantId: candidate.tenantId } : {}) }
  }
  return null
}

/**
 * The notice that this machine's trial ended, or null. It shows from the end until the admin
 * dismisses it, and returns 30 days after a dismissal, like the Community notice.
 */
export function trialEndedNotice(
  status: Pick<LicenseStatus, "trialEndedAt">,
  dismissedAt: string | undefined,
  now = Date.now(),
): { endedAt: string } | null {
  const endedAt = status.trialEndedAt
  if (!endedAt) return null
  const end = Date.parse(endedAt)
  if (!Number.isFinite(end) || end > now) return null
  const dismissed = dismissedAt ? Date.parse(dismissedAt) : NaN
  if (Number.isFinite(dismissed) && dismissed >= end && dismissed <= now && now - dismissed < 30 * DAY_MS) return null
  return { endedAt }
}


export function inactiveTenantNotice(tenants: TenantLicenseStatus[]): string {
  if (!tenants.every((tenant) => tenant.coverageEnded)) return "Open License for details."
  return tenants.length === 1 ? "Backups of this tenant are kept. Add a license to use it again." : "Backups of these tenants are kept. Add a license to use them again."
}
