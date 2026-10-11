import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron"
import trayIcon from "../../resources/tray.png?asset"
import trayTemplate from "../../resources/trayTemplate.png?asset"

export interface TrayActions {
  open: () => void
  backUpAll: () => void
  nextBackup: () => string | null
  quit: () => void
}

export function trayMenuTemplate(actions: TrayActions, backgroundRunnerInstalled: boolean): MenuItemConstructorOptions[] {
  const next = actions.nextBackup()
  return [
    { label: "Open TenuVault", click: () => actions.open() },
    { label: "Back up all tenants now", click: () => actions.backUpAll() },
    { type: "separator" },
    { label: next ? `Next backup: ${next}` : "No scheduled backups", enabled: false },
    { type: "separator" },
    ...(backgroundRunnerInstalled ? [{ label: "Background restart may reopen TenuVault within five minutes", enabled: false }] : []),
    { label: `Quit ${app.getName()}`, click: () => actions.quit() },
  ]
}

/** System tray (Windows) or menu bar (macOS) icon that keeps scheduled backups running. */
export class AppTray {
  private tray: Tray | null = null
  private backgroundRunnerInstalled = false
  /** False when the icon image could not be loaded (for example a packaging mistake). */
  iconLoaded = false

  constructor(private readonly actions: TrayActions) {}

  setBackgroundRunnerInstalled(installed: boolean): void {
    this.backgroundRunnerInstalled = installed
    this.refresh()
  }

  create(): void {
    if (this.tray) return
    const image = nativeImage.createFromPath(process.platform === "darwin" ? trayTemplate : trayIcon)
    this.iconLoaded = !image.isEmpty()
    if (process.platform === "darwin") image.setTemplateImage(true)
    this.tray = new Tray(image)
    this.tray.setToolTip("TenuVault")
    this.tray.on("click", () => this.actions.open())
    this.refresh()
  }

  /** Rebuilds the menu, for example when schedules change. */
  refresh(): void {
    if (!this.tray) return
    this.tray.setContextMenu(
      Menu.buildFromTemplate(trayMenuTemplate(this.actions, this.backgroundRunnerInstalled)),
    )
  }
}
