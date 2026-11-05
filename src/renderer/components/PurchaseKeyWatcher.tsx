import { useState } from "react"
import { bridge } from "../lib/bridge"
import { useClipboardLicenseKey } from "../lib/clipboard-key"
import { useLicense } from "../lib/license"
import { clearCheckout, PURCHASE_WATCH_MS, useCheckoutOpenedAt } from "../lib/purchase"
import { toast } from "../lib/toast"

/**
 * After a checkout was opened from the app, the license key from the purchase email is used
 * as soon as the admin copies it and returns to TenuVault: it replaces the saved key (a trial
 * key, for example) or is saved when there is none. The key already saved is never offered
 * again (the main process filters it), so a copied trial key does nothing.
 */
export function PurchaseKeyWatcher() {
  const openedAt = useCheckoutOpenedAt()
  const { status, refresh } = useLicense()
  const [busy, setBusy] = useState(false)
  const active = openedAt !== null && Date.now() - openedAt < PURCHASE_WATCH_MS && status !== null && !busy
  useClipboardLicenseKey(active, (key) => {
    if (!status) return
    setBusy(true)
    const save = status.hasKey ? bridge.license.replaceKey(key) : bridge.license.setKey(key)
    void save
      .then((result) => {
        clearCheckout()
        toast(
          result.tenants.some((tenant) => tenant.entitled && tenant.source === "key")
            ? "Your new license is active."
            : "Your new license key is saved. It activates for a tenant when you sign in to it.",
          "success",
        )
      })
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : "The license key could not be saved. Paste it on the License page.", "error")
      })
      .finally(() => {
        setBusy(false)
        void refresh().catch(() => undefined)
      })
  })
  return null
}
