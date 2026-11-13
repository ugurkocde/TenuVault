import { basename, join } from "node:path"
import { lstat, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { AppCaptureProgress, AppSourceState, RecoveryDeviceStatus, AppSourcesBridge, IntuneAppDetails, IntuneAppScript } from "../../shared/app-sources/types"
import { AppSourceStore, sourceTenant } from "./store"

export interface AppSourceHost {
  assignments?: (tenant: string, appId: string) => ReturnType<AppSourcesBridge["assignments"]>
  capture?: (tenant: string, appId: string, jobId: string, store: AppSourceStore, signal: AbortSignal, progress: (value: AppCaptureProgress) => void) => Promise<void>
  ensureKeys?: () => void
  knownTenant: (tenant: string) => boolean
  folder: (tenant: string) => string
  setFolder: (tenant: string, folder: string) => void
  keys: () => Buffer[]
  exportJournalFolder?: () => string
  pickFolder: (current: string) => Promise<string | null>
  confirmNewStore: (tenant: string) => Promise<boolean>
  pickExport: (fileName: string) => Promise<string | null>
  checkDevice: (tenant: string) => Promise<RecoveryDeviceStatus>
  signIn: (tenant: string) => Promise<void>
  details: (tenant: string, appId: string) => Promise<IntuneAppDetails>
  printDetails: (details: IntuneAppDetails) => Promise<boolean>
  downloadScript: (script: IntuneAppScript) => Promise<boolean>
  apps: (tenant: string) => ReturnType<AppSourcesBridge["apps"]>
}

/** Local actions are free for every configured tenant and need no live token. */
export class AppSourceService {
  private readonly jobs = new Map<string, { tenant: string; abort: AbortController; progress?: AppCaptureProgress }>()
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
  private async job(raw: unknown, operation: unknown, action: (tenant: string, signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
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
  capture(raw: unknown, operation: unknown, app: unknown): Promise<boolean> {
    const appId = sourceTenant(app)
    return this.job(raw, operation, async (tenant, signal) => {
      if (!this.host.capture) throw new Error("Installer capture requires the Windows capture helper.")
      const store = this.store(tenant)
      if ((await store.list(tenant)).unreadableSources) throw new Error("Import the matching recovery key before creating a backup in this folder.")
      signal.throwIfAborted()
      this.host.ensureKeys?.()
      const id = sourceTenant(operation)
      await this.host.capture(tenant, appId, id, store, signal, value => {
        const job = this.jobs.get(id)
        if (job?.tenant === tenant) job.progress = value
      })
      return true
    })
  }
  captureProgress(raw: unknown, operation: unknown): AppCaptureProgress | null {
    const tenant = this.tenant(raw), job = this.jobs.get(sourceTenant(operation))
    return job?.tenant === tenant ? job.progress ?? null : null
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
  signIn(raw: unknown): Promise<void> { return this.host.signIn(this.tenant(raw)) }
  apps(raw: unknown) {
    const tenant = this.tenant(raw), pending = this.appLoads.get(tenant)
    if (pending) return pending
    const load = Promise.resolve().then(() => this.host.apps(tenant)).finally(() => this.appLoads.delete(tenant))
    this.appLoads.set(tenant, load)
    return load
  }
  /** Used on process shutdown; disk journals reconcile interrupted operations on the next list. */
  close(): void { for (const job of this.jobs.values()) job.abort.abort() }
}

export const newSourceOperation = randomUUID
