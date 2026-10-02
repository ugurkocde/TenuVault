import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The last handler registered per event, so events reach the newest Updates instance.
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>())
const emit = (event: string, ...args: unknown[]) => handlers.get(event)?.(...args)

const autoUpdater = vi.hoisted(() => ({
  current: null as string | null,
  get channel() {
    return this.current
  },
  // Like electron-updater, setting a channel also allows downgrades.
  set channel(value: string | null) {
    this.current = value
    this.allowDowngrade = true
  },
  allowPrerelease: false,
  allowDowngrade: false,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  logger: undefined as unknown,
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => void handlers.set(event, handler)),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn((_token?: unknown) => Promise.resolve<string[]>([])),
  quitAndInstall: vi.fn(),
  // NsisUpdater internals the signature check before installing uses.
  installerPath: "C:\\Users\\admin\\AppData\\Local\\tenuvault-updater\\pending\\TenuVault-Setup.exe" as string | null,
  verifySignature: vi.fn(async (_file: string): Promise<string | null> => null),
}))

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: vi.fn(() => "0.2.0"), on: (event: string, handler: (...args: unknown[]) => void) => void handlers.set(`app:${event}`, handler), quit: vi.fn() },
  systemPreferences: {},
}))
vi.mock("electron-updater", async (importOriginal) => {
  const original = await importOriginal<typeof import("electron-updater")>()
  return { default: { autoUpdater }, CancellationToken: original.CancellationToken }
})

const { Updates, installedBySetup, isNightly, SIGNATURE_CHECK_TIMEOUT_MS } = await import("../src/main/updates")
const { app } = await import("electron")
const { Preferences } = await import("../src/main/preferences")

function memoryStore() {
  const data = new Map<string, string>()
  return { get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => void data.set(key, value), delete: (key: string) => void data.delete(key) }
}

describe("nightly update preference", () => {
  it("defaults to the channel of the installed build and remembers the admin's choice", () => {
    const store = memoryStore()
    expect(new Preferences(store).get().nightlyUpdates).toBe(false)
    expect(new Preferences(store, { nightlyUpdates: isNightly("0.1.1-nightly.20260926181500") }).get().nightlyUpdates).toBe(true)
    new Preferences(store).set({ nightlyUpdates: false })
    expect(new Preferences(store, { nightlyUpdates: true }).get().nightlyUpdates).toBe(false)
  })

  it("does not store a default when another preference changes", () => {
    const store = memoryStore()
    new Preferences(store, { nightlyUpdates: true }).set({ retentionDays: 90 })
    expect(new Preferences(store).get()).toMatchObject({ nightlyUpdates: false, retentionDays: 90 })
  })

  it("rejects a value that is not a boolean", () => {
    expect(() => new Preferences(memoryStore()).set({ nightlyUpdates: "yes" as unknown as boolean })).toThrow()
  })

  it("accepts only known preferences with the right type", () => {
    const store = memoryStore()
    const preferences = new Preferences(store)
    preferences.set({ startAtLogin: true })
    expect(() => preferences.set({ startAtLogin: false, admin: true } as never)).toThrow("Unknown preference: admin.")
    expect(() => preferences.set(JSON.parse('{"__proto__": {"startAtLogin": false}}'))).toThrow("Unknown preference")
    expect(() => preferences.set({ keepRunningInTray: "no" } as never)).toThrow("Invalid value for keepRunningInTray.")
    expect(() => preferences.set({ retentionDays: "90" } as never)).toThrow()
    expect(() => preferences.set(null as never)).toThrow()
    expect(JSON.parse(store.get("app.preferences") ?? "{}")).toEqual({ startAtLogin: true })
  })
})

describe("update channel", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.assign(autoUpdater, { current: null, allowPrerelease: false, allowDowngrade: false })
    autoUpdater.checkForUpdates.mockReset()
    autoUpdater.downloadUpdate.mockReset().mockResolvedValue([])
    vi.mocked(app.getVersion).mockReturnValue("0.2.0")
  })
  afterEach(() => vi.useRealTimers())

  it("follows nightly prereleases when opted in and prevents ordinary stable downgrades", () => {
    const updates = new Updates(() => {})
    updates.configure(true, true)
    expect(autoUpdater).toMatchObject({ channel: "nightly", allowPrerelease: true, allowDowngrade: false })
    updates.configure(true, false)
    expect(autoUpdater).toMatchObject({ channel: "latest", allowPrerelease: false, allowDowngrade: false })
    updates.configure(false, false)
    vi.useRealTimers()
  })

  it("does not download what a check for the previous channel found, and checks the new channel", async () => {
    const updates = new Updates(() => {})
    updates.configure(true, false)
    expect(autoUpdater.autoDownload).toBe(false)
    let finish = () => {}
    autoUpdater.checkForUpdates.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    const stale = updates.check()
    await Promise.resolve()
    updates.configure(true, true)
    // The check for "latest" completes after the switch to nightly.
    emit("update-available", { version: "0.2.0" })
    finish()
    await stale
    await vi.waitFor(() => expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2))
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(updates.current().state).not.toBe("downloading")
    // Lets the follow-up check settle.
    await updates.check()

    // The check that follows is for nightly, and what it finds is downloaded.
    // Like electron-updater, update-available follows the request for the feed.
    autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
      await Promise.resolve()
      emit("update-available", { version: "0.2.1-nightly.20260930120000" })
    })
    await updates.check()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(updates.current()).toEqual({ state: "downloading", version: "0.2.1-nightly.20260930120000", percent: 0 })
    updates.configure(false, false)
  })

  it("discards a downloaded update from the old channel and checks the selected channel immediately", async () => {
    const updates = new Updates(() => {})
    updates.configure(true, false)
    emit("update-downloaded", { version: "0.2.0" })
    updates.configure(true, true)
    await updates.check()
    expect(updates.current().state).not.toBe("ready")
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(await updates.install()).toBe(false)
    updates.configure(false, false)
  })

  it("allows returning from an installed nightly to the current stable, including after restarting", async () => {
    vi.mocked(app.getVersion).mockReturnValue("0.2.1-nightly.20261002120000")
    const updates = new Updates(() => {})
    updates.configure(true, true)
    expect(autoUpdater.allowDowngrade).toBe(false)
    updates.configure(true, false)
    await updates.check()
    expect(autoUpdater).toMatchObject({ channel: "latest", allowPrerelease: false, allowDowngrade: true })
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    updates.configure(false, false)

    const restarted = new Updates(() => {})
    restarted.configure(true, false)
    expect(autoUpdater.allowDowngrade).toBe(true)
    restarted.configure(false, false)
    vi.mocked(app.getVersion).mockReturnValue("0.2.0")
  })

  it("cancels an old-channel download, ignores its late events, then downloads the selected stable", async () => {
    vi.mocked(app.getVersion).mockReturnValue("0.2.1-nightly.20261002120000")
    const updates = new Updates(() => {})
    updates.configure(true, true)
    let finish!: () => void
    autoUpdater.downloadUpdate.mockImplementationOnce(() => new Promise<never[]>((resolve) => {
      finish = () => resolve([])
    }))
    autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
      emit("update-available", { version: "0.2.1-nightly.20261002130000" })
    })
    await updates.check()
    const token = autoUpdater.downloadUpdate.mock.calls[0]?.[0] as unknown as { cancelled: boolean }
    updates.configure(true, false)
    expect(token.cancelled).toBe(true)
    emit("download-progress", { percent: 90 })
    emit("update-downloaded", { version: "0.2.1-nightly.20261002130000" })
    emit("error", new Error("cancelled old download"))
    expect(updates.current().state).toBe("idle")
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(await updates.install()).toBe(false)
    autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
      emit("update-available", { version: "0.2.0" })
    })
    finish()
    await updates.check()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(updates.current()).toEqual({ state: "downloading", version: "0.2.0", percent: 0 })
    emit("update-downloaded", { version: "0.2.0" })
    expect(updates.current()).toEqual({ state: "ready", version: "0.2.0" })
    updates.configure(false, false)
    vi.mocked(app.getVersion).mockReturnValue("0.2.0")
  })

  it("does not download when updates are off", async () => {
    const updates = new Updates(() => {})
    updates.configure(false, false)
    emit("update-available", { version: "0.2.0" })
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe("installing an update on Windows", () => {
  const platform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" })
    autoUpdater.quitAndInstall.mockClear()
    autoUpdater.verifySignature.mockClear()
  })
  afterEach(() => Object.defineProperty(process, "platform", { value: platform }))

  function ready() {
    const updates = new Updates(() => {})
    updates.configure(true, false)
    emit("update-downloaded", { version: "0.2.0" })
    return updates
  }

  it("checks the staged setup program's signature again before running it", async () => {
    const updates = ready()
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(await updates.install()).toBe(true)
    expect(autoUpdater.verifySignature).toHaveBeenCalledWith(autoUpdater.installerPath)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith()
    updates.configure(false, false)
  })

  it("does not run a setup program whose signature no longer verifies", async () => {
    const updates = ready()
    autoUpdater.verifySignature.mockResolvedValueOnce("not signed by the application owner")
    expect(await updates.install()).toBe(false)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(updates.current()).toEqual({ state: "error", message: "The downloaded update was not installed: not signed by the application owner" })
    updates.configure(false, false)
  })

  it("starts the installer once, and again after electron-updater reported an error", async () => {
    const updates = ready()
    const first = updates.install()
    expect(await updates.install()).toBe(false)
    expect(await first).toBe(true)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    // For example a setup program that could not be started; the download is still there.
    emit("error", new Error("spawn failed"))
    emit("update-downloaded", { version: "0.2.0" })
    expect(await updates.install()).toBe(true)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(2)
    updates.configure(false, false)
  })

  it("reports nothing started when the installer fails right away", async () => {
    const updates = ready()
    autoUpdater.quitAndInstall.mockImplementationOnce(() => emit("error", new Error("spawn failed")))
    expect(await updates.install()).toBe(false)
    updates.configure(false, false)
  })

  it("refuses the update and still quits when the signature check hangs", async () => {
    vi.useFakeTimers()
    try {
      const updates = ready()
      autoUpdater.verifySignature.mockReturnValueOnce(new Promise(() => {}))
      const result = updates.install(true)
      await vi.advanceTimersByTimeAsync(SIGNATURE_CHECK_TIMEOUT_MS)
      expect(await result).toBe(false)
      expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
      expect(updates.current()).toEqual({ state: "error", message: "The downloaded update was not installed: the signature check did not finish in time" })
      expect(app.quit).toHaveBeenCalled()
      updates.configure(false, false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("installs nothing when updates are turned off while the signature is checked", async () => {
    const updates = ready()
    let finish!: (value: string | null) => void
    autoUpdater.verifySignature.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    vi.mocked(app.quit).mockClear()
    const result = updates.install(true)
    updates.configure(false, false)
    finish(null)
    expect(await result).toBe(false)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(updates.current()).toEqual({ state: "disabled" })
    expect(app.quit).toHaveBeenCalled()
  })

  it("does not install a different channel's update after a signature check finishes", async () => {
    const updates = ready()
    let finish!: (value: string | null) => void
    autoUpdater.verifySignature.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const result = updates.install()
    updates.configure(true, true)
    // Even if the new channel becomes ready before the old signature check finishes.
    emit("update-downloaded", { version: "0.2.1-nightly.20261002120000" })
    finish(null)
    expect(await result).toBe(false)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    updates.configure(false, false)
  })

  it("installs nothing when updates are off", async () => {
    const updates = new Updates(() => {})
    updates.configure(false, false)
    expect(await updates.install()).toBe(false)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(autoUpdater.verifySignature).not.toHaveBeenCalled()
  })

  it("verifies before installing on quit", async () => {
    const updates = ready()
    const event = { preventDefault: vi.fn() }
    emit("app:before-quit", event)
    expect(event.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, false))
    expect(autoUpdater.verifySignature).toHaveBeenCalledTimes(1)
    updates.configure(false, false)
  })
})

describe("installing on quit on macOS", () => {
  it("stages only the selected ready update and lets Squirrel finish before quitting", async () => {
    const platform = process.platform
    Object.defineProperty(process, "platform", { value: "darwin" })
    try {
      autoUpdater.quitAndInstall.mockClear()
      vi.mocked(app.quit).mockClear()
      const updates = new Updates(() => {})
      updates.configure(true, false)
      expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
      emit("update-downloaded", { version: "0.2.1" })
      const event = { preventDefault: vi.fn() }
      emit("app:before-quit", event)
      await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith())
      expect(event.preventDefault).toHaveBeenCalled()
      expect(app.quit).not.toHaveBeenCalled()
      updates.configure(false, false)
    } finally {
      Object.defineProperty(process, "platform", { value: platform })
    }
  })
})

describe("installedBySetup", () => {
  it("is false for a Windows install without the setup program's uninstaller, such as the MSI", () => {
    const dir = mkdtempSync(join(tmpdir(), "tenuvault-install-"))
    const exe = join(dir, "TenuVault.exe")
    writeFileSync(exe, "")
    expect(installedBySetup(exe, "win32")).toBe(false)
    expect(installedBySetup(exe, "darwin")).toBe(true)
    writeFileSync(join(dir, "Uninstall TenuVault.exe"), "")
    expect(installedBySetup(exe, "win32")).toBe(true)
  })
})
