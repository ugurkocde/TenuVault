import { useEffect, useState } from "react"
import { TRIAL_USED_MESSAGE } from "../../shared/constants"
import type { LicenseStatus } from "../../shared/ipc"
import { bridge } from "./bridge"
import { tenantLicense } from "./license"

/**
 * Whether the dashboard offers the opt-in Pro trial for a tenant. It reads only the license
 * status the app already has: the tenant is on Community with nothing else covering it, tenant
 * trials are available, this installation never had a trial for it and has trials left, and the
 * admin has not dismissed the card for it. The trial service still decides; a refusal hides it.
 */
export function trialOfferEligible(status: LicenseStatus | null | undefined, tenantId: string, hiddenTenantIds: readonly string[]): boolean {
  const id = tenantId.toLowerCase()
  if (!id || !status || status.hasKey || status.tenantTrialsEnabled !== true || status.tenantTrialInstallLimit) return false
  if (hiddenTenantIds.includes(id)) return false
  // While the admin still has to choose which tenant stays on Community, no tenant is offered a trial.
  if ((status.communityChoicePendingTenantIds?.length ?? 0) > 0) return false
  const tenant = tenantLicense(status, id)
  if (!tenant?.signedIn || tenant.plan !== "community") return false
  // A license key, an organization license or a saved activation covers it.
  if (tenant.entitled || tenant.activated || tenant.source !== null) return false
  // A trial ran, runs, or can be resumed on this installation.
  if (tenant.trial || tenant.trialEndsAt || tenant.trialCanResume || tenant.trialResumeUntil) return false
  // The trial service refused it before, or the tenant already used its trial elsewhere.
  if (tenant.trialRefusal || tenant.message === TRIAL_USED_MESSAGE) return false
  return true
}

/**
 * After a start failed: the trial service's refusal text when it refused this tenant, which hides
 * the card for good, or null for a failure worth retrying (no network, a timeout).
 */
export function trialOfferRefusal(after: LicenseStatus | null | undefined, tenantId: string): string | null {
  const tenant = after?.tenants.find(t => t.tenantId === tenantId.toLowerCase())
  if (tenant?.trialRefusal) return tenant.trialRefusal
  if (tenant?.message === TRIAL_USED_MESSAGE) return TRIAL_USED_MESSAGE
  return null
}

// Every mounted reader of the hidden list (the card and the Community banner) follows a change.
const listeners = new Set<(ids: string[]) => void>()

/** The tenants whose trial card is hidden, from the app preferences, or null until they are read. */
export function useTrialOfferHidden(): string[] | null {
  const [hidden, setHidden] = useState<string[] | null>(null)
  useEffect(() => {
    let active = true
    const listener = (ids: string[]) => { if (active) setHidden(ids) }
    listeners.add(listener)
    void bridge.preferences.get().then(
      preferences => { if (active) setHidden(current => current ?? preferences.trialOfferHiddenTenantIds ?? []) },
      // Without the saved dismissals the card stays hidden rather than coming back.
      () => {},
    )
    return () => { active = false; listeners.delete(listener) }
  }, [])
  return hidden
}

/** Hides the trial card for a tenant for good. Readers update at once; the save follows. */
export async function hideTrialOffer(tenantId: string, shown: readonly string[] | null): Promise<void> {
  const id = tenantId.toLowerCase()
  if (shown && !shown.includes(id)) for (const listener of listeners) listener([...shown, id])
  const saved = (await bridge.preferences.get()).trialOfferHiddenTenantIds ?? []
  const next = saved.includes(id) ? saved : [...saved, id]
  if (next !== saved) await bridge.preferences.set({ trialOfferHiddenTenantIds: next })
  for (const listener of listeners) listener(next)
}
