import { basename, join } from "node:path"
import { lstat, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { AppSourceState, RecoveryDeviceStatus } from "../../shared/app-sources/types"
import { AppSourceStore, sourceTenant } from "./store"

export interface AppSourceHost {
  knownTenant: (tenant: string) => boolean
  folder: (tenant: string) => string
  setFolder: (tenant: string, folder: string) => void
  keys: () => Buffer[]
  exportJournalFolder?: () => string
  ensureKeys: () => void
  authorizeAttach: (tenant: string) => Promise<void>
  pickFolder: (current: string) => Promise<string | null>
  pickPackage: () => Promise<string | null>
  pickExport: (fileName: string) => Promise<string | null>
  checkDevice: (tenant: string) => Promise<RecoveryDeviceStatus>
}

/** Local actions use configured tenant identity, never a live token or an entitlement bypass. */
export class AppSourceService {
  private readonly jobs = new Map<string, { tenant: string; abort: AbortController }>()
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
  attach(raw: unknown, operation: unknown, appName: unknown): Promise<boolean> {
    if (typeof appName !== "string" || appName.length > 200) return Promise.reject(new Error("Enter an app name of at most 200 characters."))
    return this.job(raw, operation, async (tenant, signal) => {
      await this.host.authorizeAttach(tenant)
      const file = await this.host.pickPackage()
      signal.throwIfAborted()
      if (!file) return false
      this.tenant(tenant); await this.host.authorizeAttach(tenant)
      const existing = await this.store(tenant).list(tenant)
      if (existing.unreadableSources) throw new Error("Import the matching recovery key before adding packages to this source store.")
      this.host.ensureKeys()
      await this.store(tenant).attach(tenant, file, appName, signal)
      return true
    })
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
  checkDevice(raw: unknown): Promise<RecoveryDeviceStatus> { return this.host.checkDevice(this.tenant(raw)) }
  /** Used on process shutdown; disk journals reconcile interrupted operations on the next list. */
  close(): void { for (const job of this.jobs.values()) job.abort.abort() }
}

export const newSourceOperation = randomUUID
