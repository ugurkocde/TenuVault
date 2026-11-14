import { basename, join } from "node:path"
import { lstat, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { AppDeviceCode, AppDeviceSignInStatus, AppRestoreProgress, AppRestoreReview, AppRestoreResult, AppCaptureProgress, AppSourceState, CapturedAppSource, RecoveryDeviceStatus, AppSourcesBridge, IntuneAppDetails, IntuneAppScript } from "../../shared/app-sources/types"
import { restoreBody, snapshotHash, type AppRestoreSnapshot } from "../app-backup/restore-snapshot"
import { AppSourceStore, sourceTenant } from "./store"

export interface AppSourceHost {
  signInWithDeviceCode?: (tenant: string, onCode: (code: AppDeviceCode) => void, signal: AbortSignal) => Promise<void>
  restore?: (store: AppSourceStore, source: CapturedAppSource, snapshot: AppRestoreSnapshot, target: string, name: string, signal: AbortSignal, progress: (value: AppRestoreProgress) => void) => Promise<AppRestoreResult>
  loadRestoreSettings?: (tenant: string, appId: string) => Promise<AppRestoreSnapshot>
  assignments?: (tenant: string, appId: string) => ReturnType<AppSourcesBridge["assignments"]>
  capture?: (tenant: string, appId: string, jobId: string, store: AppSourceStore, signal: AbortSignal, progress: (value: AppCaptureProgress) => void) => Promise<CapturedAppSource>
  ensureKeys?: () => void
  knownTenant: (tenant: string) => boolean
  folder: (tenant: string) => string
  setFolder: (tenant: string, folder: string) => void
  keys: () => Buffer[]
  exportJournalFolder?: () => string
  pickFolder: (current: string) => Promise<string | null>
  confirmNewStore: (tenant: string) => Promise<boolean>
  pickExport: (fileName: string) => Promise<string | null>
  openFolder: (folder: string) => Promise<void>
  checkDevice: (tenant: string) => Promise<RecoveryDeviceStatus>
  signIn: (tenant: string) => Promise<void>
  details: (tenant: string, appId: string) => Promise<IntuneAppDetails>
  printDetails: (details: IntuneAppDetails) => Promise<boolean>
  downloadScript: (script: IntuneAppScript) => Promise<boolean>
  apps: (tenant: string) => ReturnType<AppSourcesBridge["apps"]>
}

/** Local actions are free for every configured tenant and need no live token. */
export class AppSourceService {
  private readonly deviceSignIns = new Map<string, { abort: AbortController; ready: Promise<AppDeviceCode>; state: AppDeviceSignInStatus }>()
  private readonly jobs = new Map<string, { tenant: string; abort: AbortController; progress?: AppCaptureProgress; restoreProgress?: AppRestoreProgress }>()
  private readonly deviceChecks = new Map<string, Promise<RecoveryDeviceStatus>>()
  private readonly appLoads = new Map<string, ReturnType<AppSourcesBridge["apps"]>>()
  private readonly assignmentChecks = new Map<string, ReturnType<AppSourcesBridge["assignments"]>>()
  constructor(private readonly host: AppSourceHost) {}
  private tenant(raw: unknown): string {
    const id = sourceTenant(raw)
    if (!this.host.knownTenant(id)) throw new Error("This tenant is no longer configured.")
    return id
  }
  private store(tenant: string): AppSourceStore {
    return new AppSourceStore(this.host.folder(tenant), () => {
      const keys = this.host.keys()
      if (!keys.length) throw new Error("Import the matching recovery key to read this source store.")
      return keys
    }, this.host.exportJournalFolder?.())
  }
  async list(raw: unknown): Promise<AppSourceState> {
    const tenant = this.tenant(raw)
    return { storeName: basename(this.host.folder(tenant)), ...await this.store(tenant).list(tenant) }
  }
  async chooseStore(raw: unknown): Promise<boolean> {
    const tenant = this.tenant(raw)
    if (this.jobs.size) throw new Error("Finish or cancel the source operation before changing its store.")
    const folder = await this.host.pickFolder(this.host.folder(tenant))
    if (!folder) return false
    if (this.jobs.size) throw new Error("A source operation started while the folder picker was open. Retry after it finishes.")
    this.tenant(tenant)
    if (basename(folder).toLowerCase() === tenant) throw new Error("Choose the source store's parent folder, which contains the tenant folders, rather than this tenant's folder.")
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === "manifest.tvm") throw new Error("Choose the source store's root folder, rather than an individual stored package.")
      if (entry.isDirectory() && /^[a-f0-9-]{36}$/i.test(entry.name)) {
        try {
          await lstat(join(folder, entry.name, "manifest.tvm"))
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error }
        throw new Error("Choose the source store's parent folder, which contains the tenant folders, rather than a folder of stored packages.")
      }
    }
    let existingTenant = false
    try {
      const candidate = await lstat(join(folder, tenant))
      if (!candidate.isDirectory() || candidate.isSymbolicLink()) throw new Error("The selected source store's tenant folder must be a regular directory.")
      existingTenant = true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (!existingTenant && !await this.host.confirmNewStore(tenant)) return false
    // Probe readability without creating directories or requiring a key to reconnect.
    await new AppSourceStore(folder, () => this.host.keys()).list(tenant)
    if (this.jobs.size) throw new Error("A source operation started while the folder was checked. Retry after it finishes.")
    this.tenant(tenant)
    this.host.setFolder(tenant, folder)
    return true
  }
  private async job<T>(raw: unknown, operation: unknown, action: (tenant: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const tenant = this.tenant(raw), id = sourceTenant(operation)
    if (this.jobs.size) throw new Error("A source operation is already running. Finish or cancel it first.")
    const control = new AbortController()
    this.jobs.set(id, { tenant, abort: control })
    try { return await action(tenant, control.signal) }
    catch (error) {
      if (control.signal.aborted) throw new Error("Source operation cancelled.")
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A file with that name already exists. Choose a new name; existing files are preserved.")
      throw error
    } finally { this.jobs.delete(id) }
  }
  capture(raw: unknown, operation: unknown, app: unknown): Promise<CapturedAppSource> {
    const appId = sourceTenant(app)
    return this.job(raw, operation, async (tenant, signal) => {
      if (!this.host.capture) throw new Error("Installer capture requires the Windows capture helper.")
      const store = this.store(tenant)
      if ((await store.list(tenant)).unreadableSources) throw new Error("Import the matching recovery key before creating a backup in this folder.")
      signal.throwIfAborted()
      this.host.ensureKeys?.()
      const id = sourceTenant(operation)
      return this.host.capture(tenant, appId, id, store, signal, value => {
        const job = this.jobs.get(id)
        if (job?.tenant === tenant) job.progress = value
      })
    })
  }
  captureProgress(raw: unknown, operation: unknown): AppCaptureProgress | null {
    const tenant = this.tenant(raw), job = this.jobs.get(sourceTenant(operation))
    return job?.tenant === tenant ? job.progress ?? null : null
  }
  async restoreReview(raw: unknown, source: unknown): Promise<AppRestoreReview> {
    const tenant = this.tenant(raw), id = sourceTenant(source), store = this.store(tenant)
    const captured = await store.capturedSource(tenant, id), snapshot = await store.configuration(tenant, id)
    if (!snapshot) return { settingsHash: null, observedAt: null, currentSettings: false, name: captured.appName, version: null, publisher: null, installCommand: null, uninstallCommand: null, runAs: null, detectionRules: 0, requirementRules: 0, blocker: null }
    let blocker: string | null = null
    try { restoreBody(snapshot, captured.appName) } catch (error) { blocker = error instanceof Error ? error.message : "These app settings cannot be restored." }
    const app = snapshot.app, text = (key: string) => typeof app[key] === "string" ? app[key] as string : null
    const rules = Array.isArray(app.rules) ? app.rules as Record<string, unknown>[] : []
    const experience = app.installExperience as Record<string, unknown> | null
    return { settingsHash: snapshotHash(snapshot), observedAt: snapshot.observedAt, currentSettings: snapshot.origin === "current-settings", name: text("displayName") || captured.appName, version: text("displayVersion"), publisher: text("publisher"), installCommand: text("installCommandLine"), uninstallCommand: text("uninstallCommandLine"), runAs: typeof experience?.runAsAccount === "string" ? experience.runAsAccount : null, detectionRules: rules.filter(r => r.ruleType === "detection").length, requirementRules: rules.filter(r => r.ruleType === "requirement").length, blocker }
  }
  async loadRestoreSettings(raw: unknown, source: unknown): Promise<AppRestoreReview> {
    const tenant = this.tenant(raw), id = sourceTenant(source), store = this.store(tenant)
    if (this.jobs.size) throw new Error("Finish the current installer operation before loading restore settings.")
    const captured = await store.capturedSource(tenant, id)
    if (!await store.configuration(tenant, id)) {
      if (!this.host.loadRestoreSettings) throw new Error("Source settings cannot be loaded in this build.")
      const settings = await this.host.loadRestoreSettings(tenant, captured.receipt.appId)
      this.tenant(tenant)
      if (this.jobs.size) throw new Error("An installer operation started. Retry after it finishes.")
      await store.saveConfiguration(tenant, id, settings)
    }
    return this.restoreReview(tenant, id)
  }
  restore(raw: unknown, operation: unknown, source: unknown, target: unknown, name: unknown, settingsHash: unknown): Promise<AppRestoreResult> {
    const destination = this.tenant(target), sourceId = sourceTenant(source), operationId = sourceTenant(operation)
    if (typeof name !== "string" || typeof settingsHash !== "string" || !/^[a-f0-9]{64}$/.test(settingsHash)) return Promise.reject(new Error("Review the app settings and destination before restoring."))
    return this.job(raw, operation, async (tenant, signal) => {
      const store = this.store(tenant), captured = await store.capturedSource(tenant, sourceId), snapshot = await store.configuration(tenant, sourceId)
      if (!snapshot || snapshotHash(snapshot) !== settingsHash) throw new Error("The app settings changed. Review them before restoring.")
      if (!this.host.restore) throw new Error("App restore is unavailable in this build.")
      restoreBody(snapshot, name); this.tenant(destination)
      return this.host.restore(store, captured, snapshot, destination, name, signal, value => {
        const job = this.jobs.get(operationId)
        if (job?.tenant === tenant) job.restoreProgress = value
      })
    })
  }
  restoreProgress(raw: unknown, operation: unknown): AppRestoreProgress | null {
    const tenant = this.tenant(raw), job = this.jobs.get(sourceTenant(operation))
    return job?.tenant === tenant ? job.restoreProgress ?? null : null
  }
  export(raw: unknown, operation: unknown, source: unknown): Promise<boolean> {
    if (typeof source !== "string") return Promise.reject(new Error("Select a stored source."))
    return this.job(raw, operation, async (tenant, signal) => {
      const store = this.store(tenant), listed = await store.list(tenant)
      const item = listed.sources.find(row => row.id === source)
      if (!item) throw new Error("This source does not belong to the selected tenant or cannot be read.")
      const destination = await this.host.pickExport(item.fileName)
      signal.throwIfAborted()
      if (!destination) return false
      this.tenant(tenant)
      await store.export(tenant, item.id, destination, signal)
      return true
    })
  }
  async openFolder(raw: unknown, source: unknown): Promise<void> {
    const tenant = this.tenant(raw), id = sourceTenant(source)
    const folder = await this.store(tenant).sourceDirectory(tenant, id)
    this.tenant(tenant)
    await this.host.openFolder(folder)
  }
  cancel(raw: unknown, operation: unknown): void {
    const tenant = this.tenant(raw), id = sourceTenant(operation)
    const job = this.jobs.get(id)
    if (job?.tenant === tenant) job.abort.abort()
  }
  checkDevice(raw: unknown): Promise<RecoveryDeviceStatus> {
    const tenant = this.tenant(raw), pending = this.deviceChecks.get(tenant)
    if (pending) return pending
    const check = Promise.resolve().then(() => this.host.checkDevice(tenant)).finally(() => { this.deviceChecks.delete(tenant) })
    this.deviceChecks.set(tenant, check)
    return check
  }
  details(raw: unknown, app: unknown): Promise<IntuneAppDetails> {
    return this.host.details(this.tenant(raw), sourceTenant(app))
  }
  assignments(raw: unknown, app: unknown): ReturnType<AppSourcesBridge["assignments"]> {
    const tenant = this.tenant(raw), appId = sourceTenant(app), key = `${tenant}/${appId}`
    const pending = this.assignmentChecks.get(key)
    if (pending) return pending
    if (!this.host.assignments) return Promise.reject(new Error("Assignment checks are unavailable in this build."))
    if (this.assignmentChecks.size >= 8) return Promise.reject(new Error("Assignment checks are busy. Wait a moment and recheck."))
    const check = Promise.resolve().then(() => this.host.assignments!(tenant, appId)).then(value => { this.tenant(tenant); return value }).finally(() => { this.assignmentChecks.delete(key) })
    this.assignmentChecks.set(key, check)
    return check
  }
  async printDetails(raw: unknown, app: unknown): Promise<boolean> {
    const tenant = this.tenant(raw), id = sourceTenant(app)
    const details = await this.host.details(tenant, id)
    this.tenant(tenant)
    return this.host.printDetails(details)
  }
  async downloadScript(raw: unknown, app: unknown, scriptId: unknown): Promise<boolean> {
    const tenant = this.tenant(raw), id = sourceTenant(app)
    if (typeof scriptId !== "string" || !/^[a-f0-9]{64}$/.test(scriptId)) throw new Error("Select an available app script.")
    const details = await this.host.details(tenant, id)
    this.tenant(tenant)
    const script = details.scripts.find(item => item.id === scriptId)
    if (!script || script.content === null) throw new Error("This script changed or is unavailable. Refresh app details and retry.")
    return this.host.downloadScript(script)
  }
  deviceSignIn(raw: unknown): Promise<AppDeviceCode> {
    const tenant = this.tenant(raw), pending = this.deviceSignIns.get(tenant)
    if (pending?.state.status === "waiting") return pending.ready
    if (!this.host.signInWithDeviceCode) return Promise.reject(new Error("Device-code sign-in is unavailable in this build."))
    const abort = new AbortController()
    let resolveCode!: (value: AppDeviceCode) => void, rejectCode!: (error: unknown) => void, offered = false
    const ready = new Promise<AppDeviceCode>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
    const entry = { abort, ready, state: { status: "waiting" } as AppDeviceSignInStatus }
    this.deviceSignIns.set(tenant, entry)
    abort.signal.addEventListener("abort", () => rejectCode(new Error("Microsoft device sign-in cancelled.")), { once: true })
    void Promise.resolve().then(() => { abort.signal.throwIfAborted(); return this.host.signInWithDeviceCode!(tenant, code => { this.tenant(tenant); abort.signal.throwIfAborted(); offered = true; resolveCode(code) }, abort.signal) }).then(() => {
      if (!offered) throw new Error("Microsoft did not provide a device sign-in code.")
      this.tenant(tenant); abort.signal.throwIfAborted(); entry.state = { status: "completed" }
    }).catch(error => {
      const message = abort.signal.aborted ? "Microsoft device sign-in cancelled." : error instanceof Error ? error.message : "Microsoft device sign-in failed."
      entry.state = { status: "failed", error: message }; rejectCode(new Error(message))
    })
    return ready
  }
  deviceSignInStatus(raw: unknown): AppDeviceSignInStatus | null {
    const tenant = this.tenant(raw), entry = this.deviceSignIns.get(tenant)
    return entry ? { ...entry.state } : null
  }
  cancelDeviceSignIn(raw: unknown): void {
    const tenant = this.tenant(raw), entry = this.deviceSignIns.get(tenant)
    if (entry?.state.status === "waiting") { entry.abort.abort(); entry.state = { status: "failed", error: "Microsoft device sign-in cancelled." } }
  }
  signIn(raw: unknown): Promise<void> { return this.host.signIn(this.tenant(raw)) }
  apps(raw: unknown) {
    const tenant = this.tenant(raw), pending = this.appLoads.get(tenant)
    if (pending) return pending
    const load = Promise.resolve().then(() => this.host.apps(tenant)).finally(() => this.appLoads.delete(tenant))
    this.appLoads.set(tenant, load)
    return load
  }
  /** Used on process shutdown; disk journals reconcile interrupted operations on the next list. */
  close(): void { for (const job of this.jobs.values()) job.abort.abort(); for (const entry of this.deviceSignIns.values()) entry.abort.abort() }
}

export const newSourceOperation = randomUUID
