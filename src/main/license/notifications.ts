import { Notification, type BrowserWindow } from "electron"

export function notifyTenantTrial(name: string, ended: boolean, openWindow: () => BrowserWindow | null): boolean {
  if (!Notification.isSupported()) return false
  const notification = new Notification({
    title: ended ? "Your Pro trial ended" : "Your Pro trial ends tomorrow",
    body: `Your Pro trial for ${name} ${ended ? "has ended" : "ends tomorrow"}. Open TenuVault to get Pro, extend the trial or ask for an invoice.`,
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
