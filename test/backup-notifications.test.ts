import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import type { BrowserWindow } from "electron"
import { transformSync } from "esbuild"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NetworkUnreachableError } from "../src/main/api/network-error"
import { BackupEngine, type BackupJob } from "../src/main/backup/engine"
import { backupTenantLabel, notifyBackupFailure } from "../src/main/backup/notifications"
import { RefusalLog, refuseUnlicensedBackup } from "../src/main/backup/refusals"
import { BackupScheduler, reportsResult, runUnattended, scheduledResult, type ScheduledRunResult } from "../src/main/backup/scheduler"
import { isLocalAccount } from "../src/main/storage/blob-emulator"
import { localStorageAccountName } from "../src/shared/constants"
import type { BackupRefusal } from "../src/shared/ipc"
import { allows, PlanRequired } from "../src/shared/plans"
import { memoryStore } from "./helpers"

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
function unattendedFixture(getToken: () => Promise<string>) {
  const engine = new BackupEngine({ fetch: vi.fn(async () => new Response(null, { status: 201 })), getToken })
  const start = vi.spyOn(engine, "start")
  const source = index.slice(index.indexOf("const refusals ="), index.indexOf("const scheduler = new BackupScheduler"))
  const dependencies = {
    RefusalLog,
    appStore: { get: () => null, set: vi.fn() },
    mainWindow: null,
    tenantProfile: tenantProfileFixture({ name: tenant.name }),
    isLocalAccount,
    scheduler: { list: () => [] },
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
    runUnattended,
    reportsResult,
    scopes: { get: () => ({ scope: { excluded: [] } }) },
    accounts: { get: () => undefined },
    host: { dispatch: vi.fn(async (_request: Request) => new Response(null, { status: 200 })) },
    INTERNAL_API_ORIGIN: "http://tenuvault.internal",
    DELEGATED_CLIENT_SECRET: "",
    notifyFailure: (tenantId: string, name: string, message: string, trigger: Trigger) => notifyBackupFailure({ tenantId, name }, message, trigger, () => null),
    // Notification channel events are covered by the notifications suites; here they are inert.
    emitBackupOutcome: vi.fn(async () => ({ created: 0, localCreated: false })),
    featureDeps: {},
  }
  const run = new Function(...Object.keys(dependencies), transformSync(source, { loader: "ts" }).code + "\nreturn runScheduledBackup;")(
    ...Object.values(dependencies),
  ) as (tenantId: string, trigger: Trigger, afterFailure?: boolean) => Promise<ScheduledRunResult>
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
    expect(await automatic).toEqual({ status: "Cancelled", message: "Backup cancelled by you. This run is never offered as a complete backup." })
    expect(joined.status).toBe("Cancelled")
    expect(notifications.created).toEqual([])
    expect(dispatch).toHaveBeenCalledOnce()
    const request = dispatch.mock.calls[0]![0] as Request
    expect((await request.json()).logEntry).toMatchObject({ eventType: "BACKUP_CANCELLED", result: "PARTIAL", severity: "INFO" })
  })

  it("runs a scheduled backup of its own when the manual backup it joined is cancelled", async () => {
    const getToken = vi.fn().mockReturnValueOnce(new Promise<string>(() => {})).mockRejectedValue(new Error("Sign in to this tenant first."))
    const { run, start, engine } = unattendedFixture(getToken)
    const manual = engine.start({ tenantId: tenant.tenantId, clientId: "app", storageAccountName: localStorageAccountName(tenant.tenantId), trigger: "manual" })
    await vi.waitFor(() => expect(getToken).toHaveBeenCalled())
    const scheduled = run(tenant.tenantId, "scheduled")
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(start.mock.results[1]!.value).toBe(manual)
    engine.cancel(manual.id)
    // The slot's own backup ran and failed, so the scheduler retries it instead of recording a cancellation.
    expect(await scheduled).toEqual({ status: "Failed", message: "Sign in to this tenant first." })
    expect(start).toHaveBeenCalledTimes(3)
    expect(start.mock.results[2]!.value).not.toBe(manual)
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

  it("reports a scheduled failure to reach Microsoft once per slot, across restarts", async () => {
    let failure: Error = new NetworkUnreachableError("login.microsoftonline.com could not be reached.")
    const store = memoryStore()
    let now = new Date(2026, 9, 14, 10)
    const dispatches: Array<ReturnType<typeof vi.fn>> = []
    // A new process gets a new runner and scheduler on the same stored schedules.
    const start = () => {
      const fixture = unattendedFixture(async () => { throw failure })
      dispatches.push(fixture.dispatch)
      return { ...fixture, scheduler: new BackupScheduler(store, (tenantId, afterFailure) => fixture.run(tenantId, "scheduled", afterFailure), () => undefined, () => now) }
    }
    const titles = () => notifications.created.map((notification) => notification.title)
    const audits = () => dispatches.reduce((count, dispatch) => count + dispatch.mock.calls.length, 0)
    const tickAt = async (process: ReturnType<typeof start>, day: number, minute: number) => {
      now = new Date(2026, 9, day, 2, minute)
      await process.scheduler.tick()
    }
    let process = start()
    process.scheduler.set({ tenantId: tenant.tenantId, enabled: true, frequency: "daily", time: "02:00" })
    await tickAt(process, 15, 0)
    await tickAt(process, 15, 15)
    expect(titles()).toEqual(["Scheduled backup of Contoso failed"])
    expect(audits()).toBe(1)
    expect((await (dispatches[0]!.mock.calls[0]![0] as Request).json()).logEntry).toMatchObject({ eventType: "BACKUP_FAILED", result: "FAILURE" })
    process = start()
    await tickAt(process, 15, 30)
    expect(titles()).toHaveLength(1)
    expect(audits()).toBe(1)
    expect(process.scheduler.list()[0]).toMatchObject({ attempts: 0, lastStatus: "Failed" })
    // The next slot reports its first connection failure again.
    await tickAt(process, 16, 0)
    await tickAt(process, 16, 15)
    expect(titles()).toHaveLength(2)
    expect(audits()).toBe(2)
    // Counted failures, successes and tray backups are reported every time.
    const reached = failure
    failure = new Error("Sign in to this tenant first.")
    await tickAt(process, 16, 30)
    expect(titles()).toHaveLength(3)
    expect(audits()).toBe(3)
    failure = reached
    await process.run(tenant.tenantId, "tray")
    await process.run(tenant.tenantId, "tray")
    expect(titles().slice(3)).toEqual(["Tray backup of Contoso failed", "Tray backup of Contoso failed"])
    expect(audits()).toBe(5)
    expect(reportsResult(true, { status: "Failed", message: "Sign in to this tenant first." })).toBe(true)
    expect(reportsResult(true, { status: "Completed", message: "Done" })).toBe(true)
    expect(reportsResult(true, { status: "Failed", message: "Unreachable", unreachable: true })).toBe(false)
    expect(reportsResult(false, { status: "Failed", message: "Unreachable", unreachable: true })).toBe(true)
  })

  it("reports a connection failure after a restart during the first attempt of a slot that follows a failed slot", async () => {
    const failure = new NetworkUnreachableError("login.microsoftonline.com could not be reached.")
    let hang = false
    let hanging = 0
    const store = memoryStore()
    let now = new Date(2026, 9, 14, 10)
    const dispatches: Array<ReturnType<typeof vi.fn>> = []
    const start = () => {
      const fixture = unattendedFixture(() => hang ? (hanging++, new Promise<string>(() => {})) : Promise.reject(failure))
      dispatches.push(fixture.dispatch)
      return new BackupScheduler(store, (tenantId, afterFailure) => fixture.run(tenantId, "scheduled", afterFailure), () => undefined, () => now)
    }
    const audits = () => dispatches.reduce((count, dispatch) => count + dispatch.mock.calls.length, 0)
    let scheduler = start()
    scheduler.set({ tenantId: tenant.tenantId, enabled: true, frequency: "daily", time: "02:00" })
    now = new Date(2026, 9, 15, 2)
    await scheduler.tick()
    expect(notifications.created).toHaveLength(1)
    // The first attempt of the next slot never finishes: the process stops during it.
    hang = true
    now = new Date(2026, 9, 16, 2)
    void scheduler.tick()
    await vi.waitFor(() => expect(hanging).toBeGreaterThan(0))
    expect(scheduler.list()[0]).toMatchObject({ attempts: 1, attemptSlot: new Date(2026, 9, 16, 2).toISOString() })
    expect(scheduler.list()[0]!.lastStatus).toBeUndefined()
    expect(scheduler.list()[0]!.lastMessage).toBeUndefined()
    hang = false
    scheduler = start()
    now = new Date(2026, 9, 16, 2, 15)
    await scheduler.tick()
    expect(notifications.created).toHaveLength(2)
    expect(audits()).toBe(2)
    now = new Date(2026, 9, 16, 2, 30)
    await scheduler.tick()
    expect(notifications.created).toHaveLength(2)
    expect(audits()).toBe(2)
    // The attempt that never finished still counts toward today's budget.
    expect(scheduler.list()[0]).toMatchObject({ attempts: 1, lastStatus: "Failed", attemptSlot: new Date(2026, 9, 16, 2).toISOString() })
  })
})
