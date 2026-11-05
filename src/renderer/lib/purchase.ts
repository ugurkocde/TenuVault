import { useSyncExternalStore } from "react"
import type { LicenseStatus } from "../../shared/ipc"
import { bridge } from "./bridge"
import { isUnlicensed } from "./license"

/**
 * Buying from the app: the checkout opens in the browser, and the license key arrives in the
 * purchase email. The key is picked up from the clipboard when the admin copies it from that
 * email and returns to TenuVault (PurchaseKeyWatcher): within PURCHASE_WATCH_MS of opening a
 * checkout here, and on the License page while a trial key is saved.
 */

/** How long after opening a checkout a copied key is picked up. */
export const PURCHASE_WATCH_MS = 6 * 60 * 60 * 1000

const STORAGE_KEY = "tenuvault-checkout-opened-at"
const listeners = new Set<() => void>()

// Kept across a restart within the watch window: buyers often close the app while paying.
function stored(): number | null {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(value) && value > 0 && Date.now() - value < PURCHASE_WATCH_MS ? value : null
  } catch {
    return null
  }
}

let openedAt: number | null = stored()
let opening: Promise<void> | null = null

function remember(value: number | null) {
  openedAt = value
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    /* Only within this session then. */
  }
  notify()
}

function notify() {
  for (const listener of listeners) listener()
}

/** When a checkout was last opened, within the watch window, or null. */
export function checkoutOpenedAt(): number | null {
  return openedAt
}

export function subscribeCheckout(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Stops picking up copied keys, for example once the new key is active. */
export function clearCheckout(): void {
  remember(null)
}

export function useCheckoutOpenedAt(): number | null {
  return useSyncExternalStore(subscribeCheckout, checkoutOpenedAt)
}

/** The no-card trial of this machine runs or has ended: its owner has tried Pro. */
export function trialUsed(status: LicenseStatus | null | undefined): boolean {
  return Boolean(status && (status.trial || status.trialEndedAt))
}

/**
 * Opens the checkout that asks for payment right away. Trial users chose after a month of use,
 * so their checkout opens on yearly; monthly is on the same page.
 */
export function openCheckout(
  source: string,
  options: { plan?: "pro" | "msp"; status?: LicenseStatus | null } = {},
): Promise<void> {
  // A trial checkout waits for the licensing service before the browser opens; repeated
  // clicks meanwhile do not open more checkouts.
  opening ??= bridge.license
    .open("checkout", {
      source,
      ...(options.plan ? { plan: options.plan } : {}),
      ...(trialUsed(options.status) ? { interval: "yearly" as const } : {}),
    })
    .then(() => remember(Date.now()))
    .finally(() => {
      opening = null
    })
  return opening
}

/**
 * What a plan prompt offers: the no-card trial while the machine has no license and the
 * feature is in Pro, the checkout once the trial was used (its owner has tried Pro and the
 * pricing page would only offer the trial again), otherwise the plans page.
 */
export function planPromptAction(
  status: LicenseStatus | null | undefined,
  plan: "pro" | "msp",
): "trial" | "checkout" | "plans" {
  if (!status) return "plans"
  if (plan === "pro" && isUnlicensed(status)) return "trial"
  if (trialUsed(status)) return "checkout"
  return "plans"
}
