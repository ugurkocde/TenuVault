import { Notification, type BrowserWindow } from "electron"
import type { BackupRefusal } from "../../shared/ipc"

/** Failed unattended backups open the affected tenant's schedule, including after the window was closed. */
export function notifyBackupFailure(
  tenant: { tenantId: string; name: string },
  message: string,
  trigger: BackupRefusal["trigger"],
  openWindow: () => BrowserWindow | null,
): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: `${trigger === "tray" ? "Tray" : "Scheduled"} backup of ${tenant.name} failed`,
    body: message,
  })
  notification.on("click", () => {
    const window = openWindow()
    if (!window) return
    const route = `/portal/backup?tab=schedule&tenant=${encodeURIComponent(tenant.tenantId)}`
    const navigate = () => {
      if (window.isDestroyed()) return
      void window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}`).catch((error: unknown) => console.warn(String(error)))
    }
    if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", navigate)
    else navigate()
  })
  notification.show()
}
