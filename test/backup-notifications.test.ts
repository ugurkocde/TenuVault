import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import type { BrowserWindow } from "electron"
import { transformSync } from "esbuild"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NetworkUnreachableError } from "../src/main/api/network-error"
import { BackupEngine, type BackupJob } from "../src/main/backup/engine"
import { backupTenantLabel, notifyBackupFailure } from "../src/main/backup/notifications"
import { RefusalLog, refuseUnlicensedBackup } from "../src/main/backup/refusals"
import { reportsResult, scheduledResult } from "../src/main/backup/scheduler"
import { isLocalAccount } from "../src/main/storage/blob-emulator"
import { localStorageAccountName } from "../src/shared/constants"
import type { BackupRefusal } from "../src/shared/ipc"
import { allows, PlanRequired } from "../src/shared/plans"

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
const index = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8")
type Trigger = BackupRefusal["trigger"]
type Profile = { name: string; clientId: string; storageAccountName: string }

function tenantProfileFixture(metadata: { name?: string; domain?: string }) {
  const source = index.slice(index.indexOf("const tenantProfile ="), index.indexOf("const connectedTenantIds ="))
  const store = { get: () => JSON.stringify([{
    ...metadata,
    credentials: { tenantId: tenant.tenantId, appId: "app" },
    resources: { storageAccountName: localStorageAccountName(tenant.tenantId) },
  }]) }
  return new Function("appStore", "RENDERER_STORAGE_PREFIX", "backupTenantLabel", transformSync(source, { loader: "ts" }).code + "\nreturn tenantProfile;")(
    store, "", backupTenantLabel,
  ) as (tenantId: string) => Profile
}

// Exercise the main-process runner with the real engine, without starting Electron.
function unattendedFixture(getToken: () => Promise<string>, schedules: () => Array<{ tenantId: string; frequency: string; attemptSlot?: string }> = () => []) {
  const engine = new BackupEngine({ fetch: vi.fn(async () => new Response(null, { status: 201 })), getToken })
  const start = vi.spyOn(engine, "start")
  const source = index.slice(index.indexOf("const refusals ="), index.indexOf("const scheduler = new BackupScheduler"))
  const dependencies = {
    RefusalLog,
    appStore: { get: () => null, set: vi.fn() },
    mainWindow: null,
    tenantProfile: tenantProfileFixture({ name: tenant.name }),
    isLocalAccount,
    scheduler: { list: schedules },
    PlanRequired,
    allows,
    license: { requireEntitlement: async () => "msp" },
    refuseUnlicensedBackup,
    waitForJob: async (job: BackupJob) => {
      await vi.waitFor(() => {
        expect(job.status).not.toBe("Running")
        expect(job.endTime).toBeDefined()
      })
      return job
    },
    engine,
    scheduledResult,
    reportsResult,
    scopes: { get: () => ({ scope: { excluded: [] } }) },
    accounts: { get: () => undefined },
    host: { dispatch: vi.fn(async (_request: Request) => new Response(null, { status: 200 })) },
    INTERNAL_API_ORIGIN: "http://tenuvault.internal",
    DELEGATED_CLIENT_SECRET: "",
    notifyFailure: (tenantId: string, name: string, message: string, trigger: Trigger) => notifyBackupFailure({ tenantId, name }, message, trigger, () => null),
  }
  const run = new Function(...Object.keys(dependencies), transformSync(source, { loader: "ts" }).code + "\nreturn runScheduledBackup;")(
    ...Object.values(dependencies),
  ) as (tenantId: string, trigger: Trigger) => Promise<{ status: string; message: string }>
  return { run, start, engine, dispatch: dependencies.host.dispatch }
}

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
  it.each([
    { metadata: { name: "Contoso", domain: "contoso.onmicrosoft.com" }, label: "Contoso" },
    { metadata: { domain: "contoso.onmicrosoft.com" }, label: "contoso.onmicrosoft.com" },
    { metadata: { name: "  ", domain: " contoso.onmicrosoft.com " }, label: "contoso.onmicrosoft.com" },
    { metadata: {}, label: "this tenant" },
    { metadata: { name: "  ", domain: "  " }, label: "this tenant" },
    { metadata: { name: tenant.tenantId, domain: "contoso.onmicrosoft.com" }, label: "contoso.onmicrosoft.com" },
    { metadata: { name: tenant.tenantId, domain: tenant.tenantId }, label: "this tenant" },
  ])("uses $label instead of an ID for the tenant label", ({ metadata, label }) => {
    const profile = tenantProfileFixture(metadata)(tenant.tenantId)
    expect(profile.name).toBe(label)
    notifyBackupFailure({ tenantId: tenant.tenantId, ...metadata }, "Sign in to this tenant first.", "scheduled", () => null)
    notifyBackupFailure({ tenantId: tenant.tenantId, name: profile.name }, "Sign in to this tenant first.", "scheduled", () => null)
    for (const notification of notifications.created) {
      expect(notification.title).toBe(`Scheduled backup of ${label} failed`)
      expect(notification.title).not.toContain(tenant.tenantId)
      expect(notification.body).toBe("Sign in to this tenant first.")
      expect(notification.body).not.toContain(tenant.tenantId)
    }
  })

  it("preserves an ID already present in the reported error message", () => {
    const message = `Sign in to tenant ${tenant.tenantId} first.`
    notifyBackupFailure({ tenantId: tenant.tenantId }, message, "scheduled", () => null)
    expect(notifications.created[0]!.title).toBe("Scheduled backup of this tenant failed")
    expect(notifications.created[0]!.body).toBe(message)
  })

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

describe("unattended backup notifications", () => {
  it.each(["scheduled", "tray"] as const)("records cancellation without a failure notification when the user joins a %s job", async trigger => {
    const getToken = vi.fn(() => new Promise<string>(() => {}))
    const { run, start, engine, dispatch } = unattendedFixture(getToken)
    const automatic = run(tenant.tenantId, trigger)
    await vi.waitFor(() => expect(getToken).toHaveBeenCalled())
    const joined = engine.start({ tenantId: tenant.tenantId, clientId: "app", storageAccountName: localStorageAccountName(tenant.tenantId), trigger: "manual" })
    expect(joined).toBe(start.mock.results[0]!.value)
    engine.cancel(joined.id)
    expect(await automatic).toEqual({ status: "Cancelled", message: "Backup cancelled by you. No manifest was written for this run." })
    expect(joined.status).toBe("Cancelled")
    expect(notifications.created).toEqual([])
    expect(dispatch).toHaveBeenCalledOnce()
    const request = dispatch.mock.calls[0]![0] as Request
    expect((await request.json()).logEntry).toMatchObject({ eventType: "BACKUP_CANCELLED", result: "PARTIAL", severity: "INFO" })
  })

  it.each([["tray", "scheduled"], ["scheduled", "tray"]] as const)("notifies once for the originating %s job when %s joins it", async (original, joining) => {
    let rejectToken!: (reason: Error) => void
    const token = new Promise<string>((_resolve, reject) => { rejectToken = reject })
    const getToken = vi.fn(() => token)
    const { run, start } = unattendedFixture(getToken)
    const first = run(tenant.tenantId, original)
    await vi.waitFor(() => expect(getToken).toHaveBeenCalled())
    const second = run(tenant.tenantId, joining)
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(start.mock.results[1]!.value).toBe(start.mock.results[0]!.value)
    rejectToken(new Error("Sign in to this tenant first."))
    expect(await Promise.all([first, second])).toEqual([
      { status: "Failed", message: "Sign in to this tenant first." },
      { status: "Failed", message: "Sign in to this tenant first." },
    ])
    expect(notifications.created.map((notification) => notification.title)).toEqual([
      `${original === "tray" ? "Tray" : "Scheduled"} backup of Contoso failed`,
    ])
  })

  it("notifies for each distinct sequential job for the same tenant", async () => {
    const { run, start } = unattendedFixture(async () => { throw new Error("Sign in to this tenant first.") })
    await run(tenant.tenantId, "tray")
    await run(tenant.tenantId, "scheduled")
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.results[1]!.value.id).not.toBe(start.mock.results[0]!.value.id)
    expect(notifications.created.map((notification) => notification.title)).toEqual([
      "Tray backup of Contoso failed",
      "Scheduled backup of Contoso failed",
    ])
  })

  it("reports a scheduled failure to reach Microsoft once per slot", async () => {
    let attemptSlot = "2026-10-15T00:00:00.000Z"
    let failure: Error = new NetworkUnreachableError("login.microsoftonline.com could not be reached.")
    const { run, dispatch } = unattendedFixture(async () => { throw failure }, () => [{ tenantId: tenant.tenantId, frequency: "weekly", attemptSlot }])
    const titles = () => notifications.created.map((notification) => notification.title)
    expect(await run(tenant.tenantId, "scheduled")).toMatchObject({ status: "Failed", unreachable: true })
    await run(tenant.tenantId, "scheduled")
    expect(titles()).toEqual(["Scheduled backup of Contoso failed"])
    expect(dispatch).toHaveBeenCalledOnce()
    expect((await (dispatch.mock.calls[0]![0] as Request).json()).logEntry).toMatchObject({ eventType: "BACKUP_FAILED", result: "FAILURE" })
    // Tray backups are reported every time.
    await run(tenant.tenantId, "tray")
    await run(tenant.tenantId, "tray")
    expect(titles()).toEqual(["Scheduled backup of Contoso failed", "Tray backup of Contoso failed", "Tray backup of Contoso failed"])
    expect(dispatch).toHaveBeenCalledTimes(3)
    // A counted failure in the same slot is still reported.
    const reached = failure
    failure = new Error("Sign in to this tenant first.")
    await run(tenant.tenantId, "scheduled")
    expect(titles()).toHaveLength(4)
    expect(dispatch).toHaveBeenCalledTimes(4)
    // The next slot reports its first connection failure again.
    failure = reached
    attemptSlot = "2026-10-22T00:00:00.000Z"
    await run(tenant.tenantId, "scheduled")
    await run(tenant.tenantId, "scheduled")
    expect(titles()).toHaveLength(5)
    expect(dispatch).toHaveBeenCalledTimes(5)
  })
})
