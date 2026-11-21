import { DirectoryPrincipalMappings } from "./directory-principal-mappings"
import { DirectoryPendingPublications } from "./directory-pending-publications"
import { captureDirectoryExecutionActor } from "../api/execution-metadata"
import { directoryPagePrefix, directoryObjectState } from "./directory-object-state"
import { DirectoryThrottledError, persistDirectoryRetry } from "./directory-retry"
import { directory9bIO } from "./directory-9b-io"
import { applicationObjectStep, applicationRelationshipSteps } from "./directory-9b-plan"
import { DIRECTORY_9B_FOLDERS, applicationAdmission, applicationReview, requireApplicationRestoreAccess } from "./directory-9b"
import type { ModuleSettings } from "../services/settings"
import type { GuardedStep } from "./guarded-run"
import { randomUUID, createHash } from "node:crypto"
import { INTUNE_TYPES, type Item } from "../../shared/intune/registry"
import { canBackUp } from "../../shared/services/modules"
import { grantedPermissions } from "../../shared/services/token"
import { referenceMatches, REFERENCE_SCAN_EXCLUDED } from "./reference-scanner"
import { isGuid } from "../../shared/security"
import { directoryObjectId } from "../../shared/intune/entra-directory"
import { directoryPageUnresolved } from "../../shared/intune/directory-page-state"
import { RestoreSafetyError, RestoreWriteDeferredError } from "../../shared/intune/restore-guards"
import { relationPath, LARGE_SHARD_ITEMS } from "../../shared/large-backup"
import type { PartitionedRestoreStore } from "../storage/directory-restore-store"
import { directory9aIO, directoryAdmission } from "./directory-9a-io"
import { directoryObjectStep, directoryRelationshipSteps, mappedDirectoryIds } from "./directory-9a-plan"
import { approveDirectory, directoryReview, type DirectoryReview } from "./directory-9a"
import { directoryMappedId, executeDirectoryBatches } from "./directory-9a-batches"
import { isRestorePersistenceError, GuardedRunJournal, restoreFingerprint, type GuardedRun } from "./guarded-run"
import { resolveRestoreActor, type RecoveryAccounts } from "./safety-resolvers"
import { safetyReader } from "./safety-reader"
import { requireRestoreActor } from "./restore-actor"
import type { RestoreConnection } from "./service"
import type { IdentityRestoreRequest } from "./dispatch"

export interface DirectoryOptions { stage: "object" | "relationships"; exactMembers: boolean; exactOwners: boolean; previousRunId?: string }
export interface DirectoryPage { inventory?: { id: string; count: number; offset: number; targetId: string; principalMappings?: { parts: number; fingerprint: string } }; run: GuardedRun; rows: Array<{ key: string; review: DirectoryReview }>; more: boolean; options: DirectoryOptions; selection?: string[] }
const fail = (message: string): never => { throw new RestoreSafetyError(message) }
const key = (tenant: string, id: string) => `restore.directory.review.${tenant.toLowerCase()}.${id}`
/** Owned backup readers are supplied by the authenticated route, never by the renderer. */
export class DirectoryRestoreService {
  private readonly pending = new DirectoryPendingPublications(() => this.now())
  private readonly running = new Map<string, AbortController>()
  constructor(private readonly store: PartitionedRestoreStore, private readonly recovery: RecoveryAccounts, private readonly connection: (tenant: string) => Promise<RestoreConnection>, private readonly fetchImpl: typeof fetch = fetch, private readonly protectedAppIds: (tenant: string) => readonly string[] = () => [], private readonly settings?: Pick<ModuleSettings, "get">, private readonly now: () => number = () => Date.now()) {}
  private async context(tenant: string, onThrottled?: (retryAt: number) => void, validatedConnection?: RestoreConnection) {
    const connection = validatedConnection ?? await this.connection(tenant)
    if (connection.tenantId.toLowerCase() !== tenant.toLowerCase()) fail("The connection belongs to another tenant.")
    requireRestoreActor(connection.token, { ...connection, recoveryAccountIds: [] })
    const actorFetch: typeof fetch = async (input, init) => {
      const response = await this.fetchImpl(input, init)
      if (response.status === 429) {
        const error = new DirectoryThrottledError(response)
        onThrottled?.(error.retryAt!)
        throw error
      }
      return response
    }
    const actor = await resolveRestoreActor(safetyReader(connection.token, actorFetch), connection, this.recovery.get(tenant), ["identity-references"])
    const io = directory9aIO(connection.token, actor, async (step) => {
      // The admitted subset cannot remove directory roles or change account state. Group
      // relationships are restricted again at transport to static, nonprivileged user links.
      const principals = [step.targetId ?? step.sourceId]
      if (step.directory?.principalId) principals.push(step.directory.principalId)
      return { complete: true, principals, applications: [] }
    }, this.fetchImpl, (mappings, signal) => {
      const granted = grantedPermissions(connection.token)
      // Unrelated policy reads are advisory and never add a permission to directory restore.
      if (!granted || INTUNE_TYPES.some(type => type.restoreSafety !== "identity" && !type.singleton && !type.staticIds && !REFERENCE_SCAN_EXCLUDED.has(type.folder) && !canBackUp(type.folder, granted))) throw new Error("Reference scan read access is unavailable")
      return referenceMatches(connection.token, mappings, async (input, init) => {
        const response = await this.fetchImpl(input, init)
        if (response.status === 429) onThrottled?.(new DirectoryThrottledError(response).retryAt!)
        return response
      }, { signal })
    }, undefined, undefined, true, onThrottled)
    const applicationIO = directory9bIO(connection.token, actor, this.fetchImpl, () => this.protectedAppIds(tenant), () => this.settings?.get(tenant).entra, undefined, onThrottled)
    for (const adapter of [io, applicationIO]) {
      adapter.now = this.now
      adapter.persistRetry = (_step, journal, coordinator, retryAt) => this.persistRetry(tenant, retryAt, journal, coordinator)
      adapter.persistConfirmed = (_step, save) => this.pending.forTenant(tenant).retain(save)
    }
    return { actor, io, applicationIO }
  }
  private persistRetry(tenant: string, retryAt: number, journal: () => void, coordinator: () => void) {
    this.pending.forTenant(tenant).retain(() => persistDirectoryRetry(journal, coordinator), retryAt)
  }
  private async pageConnection(page: DirectoryPage) {
    this.pending.forTenant(page.run.tenant).flush()
    const connection = await this.connection(page.run.tenant)
    requireRestoreActor(connection.token, { ...connection, recoveryAccountIds: [] })
    if (connection.tenantId.toLowerCase() !== page.run.tenant.toLowerCase() || connection.tenantId.toLowerCase() !== page.run.actor.tenantId.toLowerCase() || connection.userId.toLowerCase() !== page.run.actor.userId.toLowerCase() || connection.clientId.toLowerCase() !== page.run.actor.clientId.toLowerCase()) fail("Use the admin and connection that reviewed this page.")
    captureDirectoryExecutionActor(connection)
    return connection
  }
  private requireAccess(tenant: string, folder: string) {
    const setting = this.settings?.get(tenant).entra
    if (DIRECTORY_9B_FOLDERS.includes(folder)) return requireApplicationRestoreAccess(setting)
    const area = folder === "Users" ? "usersAndDevices" : "groups"
    if (!setting?.enabled || setting.access !== "restore" || setting.areas[area] !== true) fail(`Enable Entra ID and the ${folder} area with Backup and restore access before restoring.`)
  }
  private load(tenant: string, id: string): DirectoryPage {
    if (!isGuid(id)) fail("Select a saved directory preview.")
    const raw = this.store.get(key(tenant, id))
    if (!raw) fail("This directory preview is unavailable.")
    return JSON.parse(raw!)
  }
  private save(page: DirectoryPage) { this.store.set(key(page.run.tenant, page.run.id), JSON.stringify(page)) }
  async prepare(tenant: string, request: IdentityRestoreRequest, options: DirectoryOptions, read: (path: string) => Promise<unknown>) {
    this.pending.forTenant(tenant).flush()
    try { return await this.preparePage(tenant, request, options, read) }
    catch (error) {
      if (isRestorePersistenceError(error)) throw error
      if (error instanceof RestoreWriteDeferredError && error.retryAt !== undefined) {
        const folder = request.path.split("/")[1]!, sourceId = String(request.snapshot.id)
        if (directoryObjectId(folder, sourceId)) {
          const step = { folder, sourceId }
          const retryAt = error.retryAt
          this.persistRetry(tenant, retryAt, () => {}, () => directoryObjectState(this.store, tenant, "").recordThrottle(step, retryAt))
        }
      }
      throw error
    }
  }
  private async preparePage(tenant: string, request: IdentityRestoreRequest, options: DirectoryOptions, read: (path: string) => Promise<unknown>) {
    const folder = request.path.split("/")[1]
    if (DIRECTORY_9B_FOLDERS.includes(folder ?? "")) return this.prepareApplications(tenant, request, options, read)
    if (!["Users", "Groups"].includes(folder ?? "") || request.origin !== "restore") fail("Directory restore requires an owned same-tenant backup.")
    this.requireAccess(tenant, folder!)
    const snapshot = request.snapshot, sourceId = snapshot.id
    if (!isGuid(sourceId)) fail("The directory source ID is missing.")
    const { actor, io } = await this.context(tenant, retryAt => this.recordSourceThrottle(tenant, folder!, sourceId as string, retryAt))
    directoryObjectState(this.store, tenant, "").recoverMappings([{ folder: folder!, sourceId: sourceId as string }])
    const mapped = directoryMappedId(this.store, tenant, folder!, sourceId as string)
    const object = await directoryObjectStep(folder as "Users" | "Groups", snapshot, io, undefined, mapped)
    // Account state has no live enabling/disabling evidence. Profile restores leave it untouched.
    if (folder === "Users" && object.directory?.action === "update") { delete object.desired.accountEnabled; object.properties = Object.keys(object.desired) }
    if (object.directory?.action === "update") {
      const allowed = folder === "Users" ? ["displayName"] : ["description"]
      object.desired = Object.fromEntries(Object.entries(object.desired).filter(([name]) => allowed.includes(name)))
      object.properties = Object.keys(object.desired)
    } else if (object.directory?.action === "create" && folder === "Users") {
      object.desired = Object.fromEntries(Object.entries(object.desired).filter(([name]) => ["displayName", "mailNickname", "userPrincipalName", "accountEnabled"].includes(name)))
      object.properties = Object.keys(object.desired)
    }
    const run: GuardedRun = { version: 1, id: randomUUID(), tenant, actor, origin: "restore", source: { path: request.path, fingerprint: restoreFingerprint(snapshot) }, entries: [], mappings: [] }
    let inventory: DirectoryPage["inventory"]
    if (options.previousRunId) {
      const previous = this.load(tenant, options.previousRunId)
      if (folder !== "Groups" || options.stage !== "relationships" || previous.run.source?.path !== request.path || previous.run.source.fingerprint !== run.source!.fingerprint || previous.options.exactMembers !== options.exactMembers || previous.options.exactOwners !== options.exactOwners || previous.run.actor.userId !== actor.userId || previous.run.actor.clientId !== actor.clientId) fail("Continue the original group's relationship preview and exact choices.")
      if (!previous.inventory) fail("Preview this group again to create its relationship inventory.")
      if (this.view(previous).unresolved) fail("Resolve or discard this saved page before previewing the next page.")
      inventory = { ...previous.inventory!, offset: previous.inventory!.offset + previous.run.entries.length }
      if (inventory.targetId !== object.targetId) fail("The restored group mapping changed. Preview its relationships again.")
    }
    const page: DirectoryPage = { run, rows: [], more: false, options }
    let steps: AsyncIterable<typeof object> = (async function* () {})()
    if (options.stage === "object") steps = (async function* () { yield object })()
    else if (!inventory) {
      if (object.directory?.action !== "update") fail("Restore the directory object before reviewing its relationships.")
      const target = object.targetId!
      const principalMappings = new DirectoryPrincipalMappings(this.store, tenant, run.id)
      const mapPrincipal = async (id: string) => principalMappings.capture(id)
      const saved = async function* (kind: "members" | "owners") {
        const declaration = snapshot[kind] as Item | undefined
        if (declaration?.format !== "sorted-id-shards-v1" || declaration.complete !== true || !Number.isSafeInteger(declaration.count) || Number(declaration.count) < 0 || Number(declaration.count) > 500_000 || declaration.shards !== Math.ceil(Number(declaration.count) / LARGE_SHARD_ITEMS) || typeof declaration.hash !== "string") fail("The saved relationship inventory is incomplete.")
        const hash = createHash("sha256")
        let previous = ""
        for (let part = 0; part < Number(declaration!.shards); part++) {
          const ids = await read(request.path.split("/")[0] + "/" + relationPath(folder!, sourceId as string, kind, part))
          if (!Array.isArray(ids) || ids.length !== Math.min(LARGE_SHARD_ITEMS, Number(declaration!.count) - part * LARGE_SHARD_ITEMS)) fail("Invalid relationship shard.")
          for (const id of ids as string[]) {
            if (!isGuid(id) || id.toLowerCase() <= previous) fail("Invalid relationship identity order.")
            previous = id.toLowerCase(); hash.update(JSON.stringify(id) + "\n"); yield id
          }
        }
        if (hash.digest("hex") !== declaration!.hash) fail("The saved relationship fingerprint did not match.")
      }
      const empty = async function* () {}
      steps = directoryRelationshipSteps(folder as "Users" | "Groups", sourceId as string, target, snapshot, io, {
        members: { saved: folder === "Groups" ? mappedDirectoryIds(saved("members"), async id => principalMappings.capture(id, true)) : empty(), current: folder === "Groups" ? mappedDirectoryIds(io.ids(target, "members"), async id => { principalMappings.capture(id); return id }) : empty() },
        owners: { saved: folder === "Groups" ? mappedDirectoryIds(saved("owners"), mapPrincipal) : empty(), current: folder === "Groups" ? mappedDirectoryIds(io.ids(target, "owners"), async id => { principalMappings.capture(id); return id }) : empty() },
        exactMembers: options.exactMembers, exactOwners: options.exactOwners, mapPrincipal, savedIdsAreTargets: true,
      }, false)
      // Persist the complete immutable difference once, with at most 50 unresolved rows per record.
      // Cursoring over these records happens before any per-row Graph resolution on later pages.
      inventory = { id: run.id, count: 0, offset: 0, targetId: target }
      let chunk: typeof object[] = [], part = 0
      const inventoryKey = (part: number) => `restore.directory.inventory.${tenant.toLowerCase()}.${run.id}.${part}`
      try {
        for await (const step of steps) {
          if (++inventory.count > 1_000_000) fail("The directory difference limit was reached.")
          chunk.push(step)
          if (chunk.length === 50) { this.store.set(inventoryKey(part++), JSON.stringify(chunk)); chunk = [] }
        }
        if (chunk.length) this.store.set(inventoryKey(part++), JSON.stringify(chunk))
        inventory.principalMappings = principalMappings.finish()
      } catch (error) {
        principalMappings.discard()
        for (let index = 0; index < part; index++) this.store.delete(inventoryKey(index))
        throw error
      }
    }
    if (inventory) {
      const raw = this.store.get(`restore.directory.inventory.${tenant.toLowerCase()}.${inventory.id}.${inventory.offset / 50}`)
      if (!raw && inventory.offset < inventory.count) fail("The saved relationship difference is unavailable. Preview again.")
      const chunk: typeof object[] = raw ? JSON.parse(raw!) : []
      steps = (async function* () { yield* chunk })()
      page.inventory = inventory
      page.more = inventory.offset + chunk.length < inventory.count
    }
    const principalValidation = inventory?.principalMappings ? new DirectoryPrincipalMappings(this.store, tenant, inventory.id) : undefined
    for await (const step of steps) {
      if (page.rows.length === 50) { page.more = true; break }
      const current = await io.read(step, step.targetId)
      step.preview = restoreFingerprint(current)
      let review: DirectoryReview
      try { review = await io.review(step, current); principalValidation?.validate(inventory!.principalMappings!, step) }
      catch (error) {
        if (isRestorePersistenceError(error)) throw error
        if (!(error instanceof RestoreWriteDeferredError)) throw error
        if (error.retryAt !== undefined) {
          const retryAt = error.retryAt
          this.persistRetry(tenant, retryAt, () => {}, () => directoryObjectState(this.store, tenant, "").recordThrottle(step, retryAt))
        }
        review = directoryReview(step, { ...(current?.resource as Item | undefined), ...current }, (current?.principal as Item | null) ?? null, actor, false)
        review.blocker = error.message
      }
      if (step.operation !== "create" && !review.changes.length) review.blocker ??= "This row already matches the desired state. No write is needed."
      const blocker = directoryAdmission(step)
      if (blocker) review.blocker ??= blocker
      page.rows.push({ key: step.key, review }); run.entries.push({ step, state: "pending" })
    }
    this.save(page)
    return this.view(page)
  }
  private async prepareApplications(tenant: string, request: IdentityRestoreRequest, options: DirectoryOptions, read: (path: string) => Promise<unknown>) {
    if (request.origin !== "restore") fail("Application access requires an owned same-tenant backup. Imported grants and cross-tenant restores are refused.")
    requireApplicationRestoreAccess(this.settings?.get(tenant).entra)
    const folder = request.path.split("/")[1]!, snapshot = request.snapshot
    const sourceId = request.path.split("/")[2]?.replace(/\.json$/, "")
    if (!directoryObjectId(folder, sourceId) || !directoryObjectId(folder, snapshot.id) || (folder === "OAuth2PermissionGrants" ? sourceId !== snapshot.id : sourceId!.toLowerCase() !== String(snapshot.id).toLowerCase())) fail("The selected backup filename does not match the saved application object ID.")
    const { actor, applicationIO: io } = await this.context(tenant, retryAt => this.recordSourceThrottle(tenant, folder, sourceId!, retryAt))
    const readSource = async (sourceFolder: string, id: string): Promise<Item> => {
      if (!["ServicePrincipals", "Applications"].includes(sourceFolder) || !isGuid(id)) fail("Invalid saved app reference.")
      const item = await read(`${request.path.split("/")[0]}/${sourceFolder}/${id}.json`)
      if (!item || typeof item !== "object" || Array.isArray(item)) fail("The saved app reference is unavailable.")
      return item as Item
    }
    directoryObjectState(this.store, tenant, "").recoverMappings([{ folder, sourceId: String(snapshot.id) }])
    const object = await applicationObjectStep(folder, snapshot, io, readSource, directoryMappedId(this.store, tenant, folder, String(snapshot.id)))
    const run: GuardedRun = { version: 1, id: randomUUID(), tenant, actor, origin: "restore", source: { path: request.path, fingerprint: restoreFingerprint(snapshot) }, entries: [], mappings: [] }
    const page: DirectoryPage = { run, rows: [], more: false, options }
    let steps: GuardedStep[] = []
    if (options.stage === "object") steps = [object]
    else {
      if (folder === "OAuth2PermissionGrants" || object.directory?.action !== "update") fail("Restore the app object before reviewing its relationships.")
      if (options.exactMembers || options.exactOwners) fail("Application relationships are adds only. Exact removal is not admitted.")
      let inventory: NonNullable<DirectoryPage["inventory"]>
      if (options.previousRunId) {
        const previous = this.load(tenant, options.previousRunId)
        if (!previous.inventory || previous.run.source?.path !== request.path || previous.run.source.fingerprint !== run.source!.fingerprint || previous.run.actor.userId !== actor.userId || previous.run.actor.clientId !== actor.clientId || previous.inventory.targetId !== object.targetId) fail("Continue the original application's relationship preview.")
        if (this.view(previous).unresolved) fail("Resolve or discard this saved page before previewing the next page.")
        inventory = { ...previous.inventory!, offset: previous.inventory!.offset + previous.run.entries.length }
      } else {
        inventory = { id: run.id, count: 0, offset: 0, targetId: object.targetId! }
        let chunk: GuardedStep[] = [], part = 0
        try {
          for await (const step of applicationRelationshipSteps(request.path, snapshot, object.targetId!, io, read, readSource)) {
            if (++inventory.count > 1_000_000) fail("The application difference limit was reached.")
            chunk.push(step)
            if (chunk.length === 50) { this.store.set(`restore.directory.inventory.${tenant.toLowerCase()}.${run.id}.${part++}`, JSON.stringify(chunk)); chunk = [] }
          }
          if (chunk.length) this.store.set(`restore.directory.inventory.${tenant.toLowerCase()}.${run.id}.${part++}`, JSON.stringify(chunk))
        } catch (error) {
          for (let index = 0; index < part; index++) this.store.delete(`restore.directory.inventory.${tenant.toLowerCase()}.${run.id}.${index}`)
          throw error
        }
      }
      const raw = this.store.get(`restore.directory.inventory.${tenant.toLowerCase()}.${inventory.id}.${inventory.offset / 50}`)
      if (!raw && inventory.offset < inventory.count) fail("The application relationship inventory is unavailable.")
      steps = raw ? JSON.parse(raw) : []
      page.inventory = inventory; page.more = inventory.offset + steps.length < inventory.count
    }
    for (const step of steps) {
      let review: DirectoryReview
      try { await io.hydrate(step); review = await io.preview(step) }
      catch (error) {
        if (isRestorePersistenceError(error)) throw error
        // An admitted update must resolve to the saved identity before any preview is persisted.
        if (error instanceof RestoreWriteDeferredError || !applicationAdmission(step)) throw error
        review = applicationReview(step, null, { id: snapshot.id!, displayName: snapshot.displayName ?? "Unresolved application" }, null, actor)
        review.blocker = error instanceof RestoreSafetyError ? error.message : "A reference could not be resolved. This item is blocked."
      }
      const admission = applicationAdmission(step)
      if (!review.blocker && admission) review.blocker = admission
      page.rows.push({ key: step.key, review }); run.entries.push({ step, state: "pending" })
    }
    this.save(page)
    return this.view(page)
  }
  private view(page: DirectoryPage) {
    const entries = this.history(page).flatMap(({ run }) => run.entries)
    return { ...this.pageState(page, entries), canDiscard: !directoryObjectState(this.store, page.run.tenant, page.run.id).discarded() && !entries.some(entry => entry.state === "uncertain"), runId: page.run.id, selection: page.selection, fingerprint: restoreFingerprint({ source: page.run.source!, rows: page.rows as unknown as Item["rows"], options: page.options as unknown as Item, ...(page.inventory?.principalMappings ? { principalMappings: page.inventory.principalMappings.fingerprint } : {}) }), rows: page.rows, more: page.more, options: page.options }
  }
  private pageState(page: DirectoryPage, entries: GuardedRun["entries"]) {
    const discarded = directoryObjectState(this.store, page.run.tenant, page.run.id).discarded()
    return { discarded, unresolved: directoryPageUnresolved(discarded, page.selection ?? [], entries.map(entry => ({ key: entry.step.key, state: entry.state }))) }
  }
  async resume(tenant: string, request: IdentityRestoreRequest) {
    const operation = this.register(tenant, request.runId!)
    try {
      const page = this.load(tenant, request.runId!)
      const connection = await this.pageConnection(page)
      const { actor } = await this.context(tenant, retryAt => this.recordPageThrottle(page, retryAt), connection)
      if (request.origin !== "restore" || page.run.origin !== request.origin || page.run.source?.path !== request.path || page.run.source.fingerprint !== restoreFingerprint(request.snapshot) || actor.userId !== page.run.actor.userId || actor.clientId !== page.run.actor.clientId) fail("Resume the original backup with the admin and connection that reviewed it.")
      return this.view(page)
    } finally { operation.finish() }
  }
  private register(tenant: string, id: string) {
    this.load(tenant, id)
    const runningKey = key(tenant, id), controller = new AbortController()
    if (this.running.has(runningKey)) fail("This directory page is already running.")
    this.running.set(runningKey, controller)
    return { signal: controller.signal, finish: () => { this.running.delete(runningKey) } }
  }
  async operation<T>(tenant: string, id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | { cancelled: true }> {
    const operation = this.register(tenant, id)
    try { return await work(operation.signal) }
    catch (error) {
      if (isRestorePersistenceError(error)) throw error
      if (operation.signal.aborted) return { cancelled: true }
      throw error
    }
    finally { operation.finish() }
  }
  async execute(tenant: string, request: IdentityRestoreRequest, fingerprint: string, approvals: Record<string, string[]>, operationSignal?: AbortSignal): Promise<ReturnType<DirectoryRestoreService["results"]>> {
    if (!operationSignal) {
      const operation = this.register(tenant, request.runId!)
      try { return await this.execute(tenant, request, fingerprint, approvals, operation.signal) }
      finally { operation.finish() }
    }
    const page = this.load(tenant, request.runId!)
    if (request.origin !== "restore" || page.run.origin !== request.origin || page.run.source?.path !== request.path || page.run.source.fingerprint !== restoreFingerprint(request.snapshot) || this.view(page).fingerprint !== fingerprint) fail("The backup or preview changed. Preview this object again.")
    const connection = await this.pageConnection(page)
    const selection = page.rows.filter(row => !row.review.blocker && row.review.approvals.every(kind => approvals[row.key]?.includes(kind))).map(row => row.key)
    if (!selection.length || (page.selection && JSON.stringify(page.selection) !== JSON.stringify(selection))) fail("Approve each selected row separately. A resumed page must keep its original selection.")
    page.selection = selection; this.save(page)
    const context = await this.context(tenant, retryAt => this.recordPageThrottle(page, retryAt), connection), actor = context.actor
    const rawIO = DIRECTORY_9B_FOLDERS.includes(request.path.split("/")[1]!) ? context.applicationIO : context.io
    const principalValidation = page.inventory ? new DirectoryPrincipalMappings(this.store, tenant, page.inventory.id) : undefined
    const io = { ...rawIO, write: ((step, body, targetId, beforeSend, run, signal, onUnapplied) => rawIO.write(step, body, targetId, () => {
      this.requireAccess(tenant, step.folder)
      if (signal?.aborted) throw new RestoreWriteDeferredError("The directory write was cancelled before sending.")
      if (page.inventory) {
        if (!page.inventory.principalMappings) fail("Preview these relationships again to verify their principal mappings.")
        principalValidation!.validate(page.inventory.principalMappings!, step)
      }
      this.pending.forTenant(tenant).beforeSend()
      beforeSend()
    }, run, signal, onUnapplied)) as typeof rawIO.write }
    if (actor.userId !== page.run.actor.userId || actor.clientId !== page.run.actor.clientId) fail("Resume with the admin and connection that reviewed this page.")
    const entries = page.run.entries.filter(entry => selection.includes(entry.step.key))
    for (const entry of entries) for (const kind of page.rows.find(row => row.key === entry.step.key)!.review.approvals) approveDirectory(entry.step, page.run, kind)
    const { entries: _entries, mappings: _mappings, ...identity } = page.run
    const result = await executeDirectoryBatches(this.store, { ...identity, actor }, { fingerprint, page: async (cursor, limit) => {
      const start = Number(cursor ?? 0), end = Math.min(entries.length, start + limit)
      return { entries: entries.slice(start, end), next: end < entries.length ? String(end) : null }
    } }, io, operationSignal)
    return this.results(page, result)
  }
  private recordSourceThrottle(tenant: string, folder: string, sourceId: string, retryAt: number) {
    this.persistRetry(tenant, retryAt, () => {}, () => directoryObjectState(this.store, tenant, "").recordThrottle({ folder, sourceId }, retryAt))
  }
  private recordPageThrottle(page: DirectoryPage, retryAt: number) {
    const objects = directoryObjectState(this.store, page.run.tenant, page.run.id)
    // Retain the deadline tenant-wide even if both durable publications fail.
    this.persistRetry(page.run.tenant, retryAt, () => {
      // A write may have completed since the actor read was throttled. Never replay its old outcome.
      for (const { batch, run } of this.history(page)) {
        for (const entry of run.entries) entry.retryAt = Math.max(entry.retryAt ?? 0, retryAt)
        new GuardedRunJournal({ get: name => this.store.get(directoryPagePrefix(run.tenant, run.id) + `batch.${batch}.` + name), set: (name, value) => this.store.set(directoryPagePrefix(run.tenant, run.id) + `batch.${batch}.` + name, value), delete: () => fail("History cannot be deleted.") }).save(run)
      }
    }, () => {
      const runs = this.history(page)
      const steps = runs.length ? runs.flatMap(({ run }) => run.entries.map(entry => ({ ...entry.step, targetId: entry.targetId ?? entry.step.targetId }))) : page.run.entries.map(({ step }) => step)
      for (const step of steps) objects.recordThrottle(step, retryAt)
    })
  }
  private history(page: DirectoryPage) {
    const prefix = directoryPagePrefix(page.run.tenant, page.run.id)
    const cursor = JSON.parse(this.store.get(prefix + "cursor") ?? '{"batch":0}')
    const runs: Array<{ batch: number; run: GuardedRun }> = []
    for (let batch = 0; batch <= cursor.batch; batch++) {
      const journal = new GuardedRunJournal({ get: name => this.store.get(prefix + `batch.${batch}.` + name), set: () => fail("History is read-only."), delete: () => fail("History is read-only.") })
      const run = journal.load(page.run.tenant, page.run.id)
      if (run) runs.push({ batch, run })
    }
    return runs
  }
  private results(page: DirectoryPage, result: { status: "complete" | "partial" | "nothing-sent"; batches: number; failed: number }, runs = this.history(page)) {
    const outcomes = new Map(runs.flatMap(({ run }) => run.entries.map(entry => [entry.step.key, { key: entry.step.key, state: entry.state, reason: entry.reason, targetId: entry.targetId, retryAt: entry.retryAt }] as const)))
    for (const entry of page.run.entries) if (page.selection?.includes(entry.step.key) && !outcomes.has(entry.step.key)) outcomes.set(entry.step.key, { key: entry.step.key, state: "pending", reason: undefined, targetId: undefined, retryAt: undefined })
    return { ...result, ...this.pageState(page, runs.flatMap(({ run }) => run.entries)), failed: [...outcomes.values()].filter(entry => ["blocked", "failed", "failed-before-send"].includes(entry.state)).length, canDiscard: !runs.some(({ run }) => run.entries.some(entry => entry.state === "uncertain")) && !directoryObjectState(this.store, page.run.tenant, page.run.id).discarded(),
      outcomes: [...outcomes.values()],
      replacedReferences: runs.flatMap(({ run }) => run.replacedReferences ?? []), warnings: [...new Set(runs.flatMap(({ run }) => run.referenceWarning ? [run.referenceWarning] : []))] }
  }
  /** Saved-page actions trust only durable identity and journal data, never renderer snapshots. */
  async saved(tenant: string, id: string, action: "reconcile" | "discard") {
    const page = this.load(tenant, id), runningKey = key(tenant, id)
    if (this.running.has(runningKey)) fail("This directory page is already running.")
    const controller = new AbortController()
    this.running.set(runningKey, controller)
    try {
      const connection = await this.pageConnection(page)
      const state = directoryObjectState(this.store, tenant, id)
      if (action === "reconcile") {
        const runs = this.history(page)
        const target = (entry: GuardedRun["entries"][number]) => (entry.targetId ?? entry.step.targetId ?? directoryMappedId(this.store, tenant, entry.step.folder, entry.step.sourceId) ?? entry.step.sourceId).toLowerCase()
        const deadlines = new Map<string, number>()
        for (const { run } of runs) for (const entry of run.entries) {
          const id = target(entry), retryAt = state.retryDeadline({ sourceId: id })
          const deadline = Math.max(deadlines.get(id) ?? 0, entry.retryAt ?? 0, retryAt ?? 0)
          deadlines.set(id, deadline)
          if (deadline > (retryAt ?? 0)) state.recordThrottle({ sourceId: id }, deadline)
        }
        const entries = runs.flatMap(({ run }) => run.entries)
        for (const entry of entries) if (deadlines.get(target(entry))) entry.retryAt = deadlines.get(target(entry))
        if (entries.some(entry => (entry.retryAt ?? 0) > Date.now()) && !entries.some(entry => entry.state === "uncertain" && (entry.retryAt ?? 0) <= Date.now())) return { ...this.view(page), ...this.results(page, { status: "partial", batches: 0, failed: 0 }, runs) }
      }
      const context = await this.context(tenant, retryAt => this.recordPageThrottle(page, retryAt), connection)
      if (context.actor.userId !== page.run.actor.userId || context.actor.clientId !== page.run.actor.clientId) fail("Use the admin and connection that reviewed this page.")
      if (action === "discard") {
        state.recoverMappings(page.run.entries.map(entry => entry.step))
        if (this.history(page).some(({ run }) => run.entries.some(entry => entry.state === "uncertain"))) fail("Confirm the uncertain result before discarding this saved restore.")
        state.release(true)
        if (!state.discarded()) fail("The discard marker could not be verified. This page remains saved.")
        return this.view(page)
      }
      if (!this.history(page).length && !this.store.get(directoryPagePrefix(tenant, id) + "batch.0.plan")) {
        return { ...this.view(page), rows: [], ...this.results(page, { status: "nothing-sent", batches: 0, failed: 0 }, []) }
      }
      const entries = page.run.entries.filter(entry => page.selection?.includes(entry.step.key))
      if (!entries.length) fail("This saved page has no executed selection to reconcile.")
      // Recover the approved input from the immutable batch plans. No backup is needed.
      const prefix = directoryPagePrefix(tenant, id)
      const plan = JSON.parse(this.store.get(prefix + "batch.0.plan") ?? "null")
      if (!plan) fail("This saved page has no journal to reconcile.")
      const { entries: _entries, mappings: _mappings, ...identity } = page.run
      const result = await executeDirectoryBatches(this.store, { ...identity, actor: context.actor }, { fingerprint: this.view(page).fingerprint, page: async (cursor, limit) => {
        const start = Number(cursor ?? 0), end = Math.min(entries.length, start + limit)
        return { entries: entries.slice(start, end), next: end < entries.length ? String(end) : null }
      } }, DIRECTORY_9B_FOLDERS.includes(entries[0]!.step.folder) ? context.applicationIO : context.io, controller.signal, 20, true)
      return { ...this.view(page), ...this.results(page, result) }
    } finally { this.running.delete(runningKey) }
  }
  async cancel(tenant: string, id: string) {
    this.load(tenant, id)
    const controller = this.running.get(key(tenant, id))
    controller?.abort()
    return { cancelled: !!controller?.signal.aborted }
  }
}
