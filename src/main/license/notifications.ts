import { trialEndWhen } from "../../shared/trial-notices"
import { Notification, type BrowserWindow } from "electron"

export function runTrialNotificationCheck(check: () => void): void {
  try { check() } catch (error) { console.warn("[license] Trial notification check failed:", error) }
}

export function notifyTenantTrial(name: string, ended: boolean, openWindow: () => BrowserWindow | null, end = Date.now() + 86400_000, canExtend = true): boolean {
  if (!Notification.isSupported()) return false
  const when = trialEndWhen(end)
  const date = new Date(end).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
  const actions = canExtend ? "get Pro, extend the trial or ask for an invoice" : "get Pro or ask for an invoice"
  const notification = new Notification({
    title: ended ? "Your Pro trial ended" : `Your Pro trial ends ${when}`,
    body: `Your Pro trial for ${name} ${ended ? `ended on ${date}` : `ends ${when}`}. Open TenuVault to ${actions}.`,
  })
  notification.on("click", () => {
    const window = openWindow()
    if (!window) return
    const navigate = () => {
      if (window.isDestroyed()) return
      void window.webContents.executeJavaScript('location.hash = "/license"').catch((error: unknown) => console.warn(String(error)))
    }
    if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", navigate)
    else navigate()
  })
  notification.show()
  return true
}
