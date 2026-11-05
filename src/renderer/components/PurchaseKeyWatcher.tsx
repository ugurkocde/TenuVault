import { useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import type { LicenseStatus } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { useClipboardLicenseKey } from "../lib/clipboard-key"
import { useLicense } from "../lib/license"
import { clearCheckout, PURCHASE_WATCH_MS, trialUsed, useCheckoutOpenedAt } from "../lib/purchase"
import { toast } from "../lib/toast"

/**
 * Whether a key copied now is taken as the purchased key. Only while the saved key is a trial
 * key (running or ended) or there is none, so a paid key is never swapped for some other
 * copied key. Within the watch window after a checkout opened here, and on the License page
 * while a trial key is saved (its text says so). Without a key, the License page's own
 * clipboard check handles that page.
 */
export function watchesPurchaseKey(
  status: LicenseStatus | null,
  openedAt: number | null,
  pathname: string,
  now = Date.now(),
): boolean {
  if (!status) return false
  const recent = openedAt !== null && now - openedAt < PURCHASE_WATCH_MS
  if (!status.hasKey) return recent && pathname !== "/license"
  if (!trialUsed(status)) return false
  return recent || pathname === "/license"
}

/**
 * The license key from the purchase email is used as soon as the admin copies it and returns
 * to TenuVault: it replaces the trial key, or is saved when there is none. The main process
 * never returns the key already saved, so a copied trial key does nothing. A key that cannot
 * be saved is not tried again, and the pickup after a checkout stops, so the admin enters it on
 * the License page instead of seeing the same error on every return.
 */
export function PurchaseKeyWatcher() {
  const openedAt = useCheckoutOpenedAt()
  const { status, refresh } = useLicense()
  const { pathname } = useLocation()
  const [busy, setBusy] = useState(false)
  const refused = useRef<string | null>(null)
  useClipboardLicenseKey(!busy && watchesPurchaseKey(status, openedAt, pathname), (key) => {
    if (!status || key === refused.current) return
    setBusy(true)
    const save = status.hasKey ? bridge.license.replaceKey(key) : bridge.license.setKey(key)
    void save
      .then((result) => {
        toast(
          result.tenants.some((tenant) => tenant.entitled && tenant.source === "key")
            ? "Your new license is active."
            : "Your new license key is saved. It activates for a tenant when you sign in to it.",
          "success",
        )
      })
      .catch((error: unknown) => {
        refused.current = key
        const reason = error instanceof Error ? error.message : "The license key could not be saved."
        toast(`${reason} Enter the key on the License page.`, "error")
      })
      .finally(() => {
        clearCheckout()
        setBusy(false)
        void refresh().catch(() => undefined)
      })
  })
  return null
}
