import { EventEmitter } from "node:events"
import type { BrowserWindow } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { notifyBackupFailure } from "../src/main/backup/notifications"

const notifications = vi.hoisted(() => ({ supported: true, created: [] as Array<{ title: string; body: string; click: () => void; show: ReturnType<typeof vi.fn<() => void>> }> }))
vi.mock("electron", () => ({
  Notification: class {
    static isSupported() { return notifications.supported }
    entry: typeof notifications.created[number]
    constructor(options: { title: string; body: string }) {
      this.entry = { ...options, click: () => undefined, show: vi.fn() }
      notifications.created.push(this.entry)
    }
    on(_event: string, callback: () => void) { this.entry.click = callback }
    show() { this.entry.show() }
  },
}))

const tenant = { tenantId: "11111111-1111-1111-1111-111111111111", name: "Contoso" }
const routeScript = `location.hash = ${JSON.stringify(`/portal/backup?tab=schedule&tenant=${tenant.tenantId}`)}`
function windowFixture(loading = false) {
  const webContents = Object.assign(new EventEmitter(), {
    isLoadingMainFrame: () => loading,
    executeJavaScript: vi.fn(async () => undefined),
  })
  const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  return { window, webContents }
}

beforeEach(() => { notifications.created = []; notifications.supported = true })

describe("backup failure notifications", () => {
  it.each(["scheduled", "tray"] as const)("names the %s trigger and opens the affected schedule on click", (trigger) => {
    const { window, webContents } = windowFixture()
    const openWindow = vi.fn(() => window)
    notifyBackupFailure(tenant, "Sign in to this tenant first.", trigger, openWindow)
    const notification = notifications.created[0]!
    expect(notification.title).toBe(`${trigger === "tray" ? "Tray" : "Scheduled"} backup of Contoso failed`)
    expect(notification.body).toBe("Sign in to this tenant first.")
    expect(notification.show).toHaveBeenCalledOnce()
    expect(openWindow).not.toHaveBeenCalled()
    notification.click()
    expect(openWindow).toHaveBeenCalledOnce()
    expect(webContents.executeJavaScript).toHaveBeenCalledWith(routeScript)
  })

  it("waits for a recreated window to finish loading before navigating", () => {
    const { window, webContents } = windowFixture(true)
    notifyBackupFailure(tenant, "Storage unavailable.", "scheduled", () => window)
    notifications.created[0]!.click()
    expect(webContents.executeJavaScript).not.toHaveBeenCalled()
    webContents.emit("did-finish-load")
    expect(webContents.executeJavaScript).toHaveBeenCalledWith(routeScript)
    webContents.emit("did-finish-load")
    expect(webContents.executeJavaScript).toHaveBeenCalledOnce()
  })

  it("ignores a window closed while loading and an unavailable window", () => {
    const { window, webContents } = windowFixture(true)
    notifyBackupFailure(tenant, "Storage unavailable.", "tray", () => window)
    notifications.created[0]!.click()
    window.isDestroyed = () => true
    webContents.emit("did-finish-load")
    expect(webContents.executeJavaScript).not.toHaveBeenCalled()
    notifyBackupFailure(tenant, "Storage unavailable.", "tray", () => null)
    expect(() => notifications.created[1]!.click()).not.toThrow()
  })

  it("does not create a notification when the platform does not support it", () => {
    notifications.supported = false
    notifyBackupFailure(tenant, "Storage unavailable.", "scheduled", vi.fn())
    expect(notifications.created).toEqual([])
  })
})
