import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { app, systemPreferences } from "electron"
import electronUpdater, { CancellationToken } from "electron-updater"
import type { UpdateStatus } from "../shared/ipc"

const { autoUpdater } = electronUpdater
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * True when an administrator disabled automatic updates for managed deployments:
 *   Windows: DWORD DisableAutoUpdate = 1 under HKLM or HKCU\SOFTWARE\Policies\TenuVault
 *   macOS:   managed preference DisableAutoUpdate = true for com.tenuvault.desktop
 */
export async function updatesDisabledByPolicy(): Promise<boolean> {
  if (process.platform === "darwin") return systemPreferences.getUserDefault("DisableAutoUpdate", "boolean") === true
  if (process.platform !== "win32") return false
  // By absolute path, so a reg.exe earlier on PATH or in the working directory is never run.
  const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe")
  for (const hive of ["HKLM", "HKCU"]) {
    try {
      const { stdout } = await promisify(execFile)(reg, ["query", `${hive}\\SOFTWARE\\Policies\\TenuVault`, "/v", "DisableAutoUpdate"])
      if (/DisableAutoUpdate\s+REG_DWORD\s+0x0*1\b/i.test(stdout)) return true
    } catch {
      // Key or value not present.
    }
  }
  return false
}

/**
 * False for a Windows build that the setup program (NSIS) did not install, such as the per-machine
 * MSI: updates are setup programs, so updating it would install a second, per-user copy next to
 * it. Only the setup program places "Uninstall TenuVault.exe" beside the executable; the MSI
 * and a per-machine NSIS install share the Program Files location, so the path alone cannot tell.
 */
export function installedBySetup(execPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return true
  return existsSync(join(dirname(execPath), `Uninstall ${basename(execPath, ".exe")}.exe`))
}

/**
 * On Windows, checks the downloaded setup program's signature again right before it runs: it
 * waited in a folder the user can write to, and a per-machine install runs it elevated. Uses the
 * check electron-updater ran after the download (publisherName from app-update.yml). Returns
 * why the check failed, or null.
 */
async function stagedSetupRejected(): Promise<string | null> {
  if (process.platform !== "win32") return null
  // Both exist on electron-updater's NsisUpdater, but are not part of its public typings.
  const updater = autoUpdater as unknown as { installerPath: string | null; verifySignature(file: string): Promise<string | null> }
  // Without a file quitAndInstall reports the error itself.
  if (!updater.installerPath) return null
  let timer: NodeJS.Timeout | undefined
  // The check runs PowerShell; a hang would otherwise hold a quit (or a Windows shutdown) forever.
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("the signature check did not finish in time"), SIGNATURE_CHECK_TIMEOUT_MS)
  })
  try {
    return await Promise.race([updater.verifySignature(updater.installerPath), timeout])
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
  }
}

/** How long the signature check of a staged update may take before the update is refused. */
export const SIGNATURE_CHECK_TIMEOUT_MS = 30_000

/** Nightly builds carry versions such as 0.1.1-nightly.20260926181500 (earlier ones 0.1.1-nightly.20260926.42). */
export function isNightly(version: string): boolean {
  return /-nightly\.\d{8}(\d{6}|\.\d+)$/.test(version)
}

/** Downloads updates from the public GitHub releases in the background; installs on quit or restart. */
export class Updates {
  private status: UpdateStatus = { state: "idle" }
  private timer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  // Bumped when the channel changes, so a check still running for the previous channel is recognised.
  private generation = 0
  private checking: { generation: number; done: Promise<void> } | null = null
  private downloading: { generation: number; token: CancellationToken; done: Promise<void> } | null = null
  private installing = false
  private quitAfterInstallError = false

  constructor(private readonly notify: (status: UpdateStatus) => void) {
    // Downloads start from update-available, only for a check of the current channel.
    autoUpdater.autoDownload = false
    // Only install the selected channel's ready update. On macOS this also keeps Squirrel
    // from staging an update before the user has finished choosing the channel.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = null
    autoUpdater.on("checking-for-update", () => {
      if (this.currentActivity()) this.set({ state: "checking" })
    })
    autoUpdater.on("update-not-available", () => {
      if (this.currentActivity()) this.set({ state: "not-available" })
    })
    autoUpdater.on("download-progress", (p) => {
      if (this.currentActivity()) this.set({ state: "downloading", version: this.version, percent: Math.round(p.percent) })
    })
    autoUpdater.on("update-available", (info) => {
      // electron-updater emits this before returning the check, so this.checking is still the check.
      if (!this.enabled || this.checking?.generation !== this.generation) return
      this.version = info.version
      this.set({ state: "downloading", version: info.version, percent: 0 })
      // Failures also arrive as error events.
      const download = { generation: this.generation, token: new CancellationToken(), done: Promise.resolve() }
      this.downloading = download
      download.done = Promise.resolve()
        .then(() => autoUpdater.downloadUpdate(download.token))
        .then(() => {}, () => {})
        .finally(() => {
          if (this.downloading === download) this.downloading = null
        })
    })
    autoUpdater.on("update-downloaded", (info) => {
      if (this.currentActivity()) this.set({ state: "ready", version: info.version })
    })
    autoUpdater.on("error", (error) => {
      const quitAfterError = this.quitAfterInstallError
      if (!this.currentActivity() && !quitAfterError) return
      // Also reports a setup program that could not be started, so installing may be tried again.
      this.installing = false
      this.quitAfterInstallError = false
      this.set({ state: "error", message: error.message })
      if (quitAfterError) app.quit()
    })
    app.on("before-quit", (event) => {
      if (!this.enabled || this.status.state !== "ready" || this.installing) return
      event.preventDefault()
      void this.install(true)
    })
  }

  private version = ""
  private enabled = false
  private nightly: boolean | null = null

  current(): UpdateStatus {
    return this.status
  }

  /** Starts or stops background checks and picks the release channel. Development builds never update. */
  configure(enabled: boolean, nightly: boolean): void {
    const channelChanged = this.nightly !== null && nightly !== this.nightly
    this.useChannel(nightly)
    if (this.timer) clearInterval(this.timer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.timer = null
    this.startupTimer = null
    this.enabled = enabled && app.isPackaged
    if (!this.enabled) {
      this.set({ state: "disabled" })
      return
    }
    if (this.status.state === "disabled") this.set({ state: "idle" })
    // A check still running for the previous channel is followed right away by one for this channel.
    if (channelChanged) void this.check()
    else this.startupTimer = setTimeout(() => void this.check(), 15 * 1000)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  async check(): Promise<UpdateStatus> {
    // electron-updater hands out a running check again, even one for the previous channel, so
    // that one has to settle before this channel is checked.
    while ((this.checking && this.checking.generation !== this.generation) ||
           (this.downloading && this.downloading.generation !== this.generation)) {
      await Promise.all([this.checking?.done, this.downloading?.done])
    }
    if (!this.enabled || this.status.state === "ready" || this.downloading) return this.status
    if (!this.checking) {
      const generation = this.generation
      const checking = { generation, done: Promise.resolve().then(() => this.run(generation)) }
      this.checking = checking
      void checking.done.finally(() => {
        if (this.checking === checking) this.checking = null
      })
    }
    await this.checking.done
    return this.status
  }

  private async run(generation: number): Promise<void> {
    if (!this.enabled || generation !== this.generation) return
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      if (generation === this.generation) this.set({ state: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Restarts into a downloaded update, or with `onQuit` installs it silently while quitting. False when nothing was installed. */
  async install(onQuit = false): Promise<boolean> {
    if (!this.enabled || this.status.state !== "ready" || this.installing) return false
    this.installing = true
    const generation = this.generation
    const rejected = await stagedSetupRejected()
    // Updates may have been turned off while the check ran; then nothing is installed.
    if (!this.enabled || this.status.state !== "ready" || generation !== this.generation) {
      this.installing = false
      if (onQuit) app.quit()
      return false
    }
    if (rejected !== null) {
      this.installing = false
      this.set({ state: "error", message: `The downloaded update was not installed: ${rejected}` })
      if (onQuit) app.quit()
      return false
    }
    if (!onQuit) {
      autoUpdater.quitAndInstall()
      // An installer that fails to start reports an error right away, which clears installing.
      return this.installing
    }
    // macOS must let Squirrel fetch the selected update before quitting.
    if (process.platform === "darwin") {
      this.quitAfterInstallError = true
      autoUpdater.quitAndInstall()
      return this.installing
    }
    // Quits like quitAndInstall does after starting the setup program, and also when it could not.
    autoUpdater.quitAndInstall(true, false)
    setImmediate(() => app.quit())
    return true
  }

  /**
   * Nightly follows the nightly feed (nightly.yml on prereleases), stable only stable releases
   * (latest.yml). A nightly install returning to stable may install the current stable even
   * when it is older. Stable installs and ordinary nightly updates never downgrade.
   */
  private useChannel(nightly: boolean): void {
    if (nightly === this.nightly) return
    this.nightly = nightly
    this.generation++
    this.downloading?.token.cancel()
    autoUpdater.channel = nightly ? "nightly" : "latest"
    autoUpdater.allowPrerelease = nightly
    // Setting a channel also allows downgrades.
    autoUpdater.allowDowngrade = !nightly && isNightly(app.getVersion())
    // A ready or partially downloaded update from the other channel must never install.
    this.set({ state: "idle" })
  }

  private currentActivity(): boolean {
    return this.enabled &&
      (!this.checking || this.checking.generation === this.generation) &&
      (!this.downloading || this.downloading.generation === this.generation)
  }

  private set(status: UpdateStatus): void {
    // Events from a check that was running when updates were turned off are ignored.
    if (!this.enabled && status.state !== "disabled") return
    this.status = status
    this.notify(status)
  }
}
