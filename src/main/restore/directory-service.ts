import { privilegedRestoreConsent } from "./privileged-consent"
import type { SignInMethod } from "../../shared/tenant-connection"
import { guardedRestoreJournal } from "../storage/restore-journal"
import { mappedReference } from "../../shared/intune/restore-references"
import { PRIVILEGED_REVIEW_FOLDERS, PRIVILEGED_RESTORE_BLOCKER } from "../../shared/intune/directory-review-folders"
import { administrativeUnits, privilegeReview, requirePrivilegeId, requirePrivilegeObject, unitRelationships, type PrivilegeCandidate, type UnitReviewCursor } from "./directory-9c"
import { DIRECTORY_REPLICATION_WINDOW_MS } from "./directory-relationship-history"
import { restoreTenantKey } from "./restore-tenant-key"
import { DirectoryPrincipalMappings } from "./directory-principal-mappings"
import { DirectoryPendingPublications } from "./directory-pending-publications"
import { captureDirectoryExecutionActor } from "../api/execution-metadata"
import { directoryPagePrefix, directoryObjectState } from "./directory-object-state"
import { DirectoryAuthenticationDeferredError, DirectoryReadDeferredError, DirectoryThrottledError, persistDirectoryRetry } from "./directory-retry"
import { directoryWriteAuthorization } from "./directory-write-response"
import { directory9bIO } from "./directory-9b-io"
import { applicationObjectStep, applicationRelationshipSteps } from "./directory-9b-plan"
import { DIRECTORY_9B_FOLDERS, applicationAdmission, applicationReview, requireApplicationRestoreAccess } from "./directory-9b"
import type { ModuleSettings } from "../services/settings"
import type { GuardedIO, GuardedStep } from "./guarded-run"
import { randomUUID, createHash } from "node:crypto"
import { INTUNE_TYPES, type Item } from "../../shared/intune/registry"
import { canBackUp } from "../../shared/services/modules"
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
import { directoryMappedId, executeDirectoryBatches, recoverDirectoryRejections } from "./directory-9a-batches"
import { assertNoSecrets, isRestorePersistenceError, GuardedRunJournal, restoreFingerprint, restorePersistence, type GuardedRun } from "./guarded-run"
import { resolveRestoreActor, type RecoveryAccounts } from "./safety-resolvers"
import { safetyReader } from "./safety-reader"
import { requireRestoreActor, restorePermissions } from "./restore-actor"
import type { RestoreConnection } from "./service"
import type { IdentityRestoreRequest } from "./dispatch"

export interface DirectoryOptions { stage: "object" | "relationships"; exactMembers: boolean; exactOwners: boolean; previousRunId?: string }
export interface DirectoryPage { unitCursor?: { targetId: string; cursor: UnitReviewCursor }; inventory?: { id: string; count: number; offset: number; targetId: string; principalMappings?: { parts: number; fingerprint: string } }; run: GuardedRun; rows: Array<{ key: string; review: DirectoryReview }>; more: boolean; options: DirectoryOptions; selection?: string[] }
const fail = (message: string): never => { throw new RestoreSafetyError(message) }
const key = (tenant: string, id: string) => `restore.directory.review.${restoreTenantKey(tenant)}.${id}`
/** One small record lists a tenant's saved pages, so discovery never decrypts every journal. */
const indexKey = (tenant: string) => `restore.directory.pages.${restoreTenantKey(tenant)}`
/** Name the source-ID race or the folder-specific create-key conflict. */
export function directoryExistingObjectBlocker(step: Pick<GuardedStep, "folder" | "sourceId" | "desired">, current: Item): string {
  const existing = `${String(current.displayName ?? current.id)} (${String(current.id)})`
  let conflict: string
  if (String(current.id).toLowerCase() === step.sourceId.toLowerCase()) conflict = `The object ${existing} already exists.`
  else if (step.folder === "Users") conflict = `The user principal name ${String(current.userPrincipalName ?? step.desired.userPrincipalName)} belongs to existing object ${existing}.`
  else conflict = `The group ${String(current.mailNickname ?? step.desired.mailNickname ?? current.displayName ?? step.desired.displayName)} conflicts with existing object ${existing}.`
  return `${conflict} Review that object in Microsoft Entra before restoring.`
}
/** Owned backup readers are supplied by the authenticated route, never by the renderer. */
export class DirectoryRestoreService {
  private readonly pending = new DirectoryPendingPublications(() => this.now())
  private readonly unpublishedCleanup = new Set<() => void>()
  private readonly running = new Map<string, AbortController>()
  private readonly store: PartitionedRestoreStore
  constructor(store: PartitionedRestoreStore, private readonly recovery: RecoveryAccounts, private readonly connection: (tenant: string) => Promise<RestoreConnection>, private readonly localOwner: (tenant: string) => Promise<Pick<RestoreConnection, "tenantId" | "userId" | "clientId">>, private readonly fetchImpl: typeof fetch = fetch, private readonly protectedAppIds: (tenant: string) => readonly string[] = () => [], private readonly settings?: Pick<ModuleSettings, "get">, private readonly now: () => number = () => Date.now(), private readonly signInMethod?: (tenant: string) => SignInMethod | undefined) {
    this.store = { partitioned: store.partitioned, get: name => restorePersistence(() => store.get(name)), set: (name, value) => restorePersistence(() => store.set(name, value)), delete: name => restorePersistence(() => store.delete(name)) }
  }
  private async actorContext(tenant: string, onThrottled?: (retryAt: number) => void, validatedConnection?: RestoreConnection, version = "v1.0") {
    const connection = validatedConnection ?? await this.connection(tenant)
    if (connection.tenantId.toLowerCase() !== restoreTenantKey(tenant)) fail("The connection belongs to another tenant.")
    requireRestoreActor(connection.token, connection, connection.authorization)
    const actorFetch: typeof fetch = async (input, init) => {
      const response = await this.fetchImpl(input, init)
      if (response.status === 429) {
        const error = new DirectoryThrottledError(response)
        onThrottled?.(error.retryAt!)
        throw error
      }
      // Actor safety reads keep their own denial message, but a claims challenge needs a new sign-in.
      try { await directoryWriteAuthorization(response, true) } catch (error) { if (error instanceof DirectoryAuthenticationDeferredError) throw error }
      return response
    }
    const reader = safetyReader(connection.token, actorFetch, version)
    const actor = await resolveRestoreActor(reader, connection, this.recovery.get(tenant), ["identity-references"], version === "beta")
    return { actor, connection, reader }
  }
  private async context(tenant: string, onThrottled?: (retryAt: number) => void, validatedConnection?: RestoreConnection, pageId?: string) {
    const { actor, connection } = await this.actorContext(tenant, onThrottled, validatedConnection)
    const io = directory9aIO(connection.token, actor, async (step) => {
      // The admitted subset cannot remove directory roles or change account state. Group
      // relationships are restricted again at transport to static, nonprivileged user links.
      const principals = [step.targetId ?? step.sourceId]
      if (step.directory?.principalId) principals.push(step.directory.principalId)
      return { complete: true, principals, applications: [] }
    }, this.fetchImpl, (mappings, signal) => {
      const granted = restorePermissions(connection.token, connection.authorization?.scopes)
      // Unrelated policy reads are advisory and never add a permission to directory restore.
      if (!granted || INTUNE_TYPES.some(type => type.restoreSafety !== "identity" && !type.singleton && !type.staticIds && !REFERENCE_SCAN_EXCLUDED.has(type.folder) && !canBackUp(type.folder, granted))) throw new Error("Reference scan read access is unavailable")
      return referenceMatches(connection.token, mappings, async (input, init) => {
        const response = await this.fetchImpl(input, init)
        if (response.status === 429) onThrottled?.(new DirectoryThrottledError(response).retryAt!)
        return response
      }, { signal })
    }, undefined, undefined, true, onThrottled, connection.authorization)
    const applicationIO = directory9bIO(connection.token, actor, this.fetchImpl, () => this.protectedAppIds(tenant), () => this.settings?.get(tenant).entra, undefined, onThrottled, connection.authorization)
    for (const adapter of [io, applicationIO]) {
      adapter.recentlyCreated = objectId => this.recentlyCreated(tenant, objectId)
      adapter.now = this.now
      adapter.persistRetry = (_step, journal, coordinator, retryAt) => this.persistRetry(tenant, retryAt, journal, coordinator, pageId)
      adapter.persistConfirmed = (_step, save) => this.pending.forTenant(tenant).retain(save, undefined, pageId)
    }
    return { actor, io, applicationIO }
  }
  private persistRetry(tenant: string, retryAt: number, journal: () => void, coordinator: () => void, pageId?: string) {
    this.pending.forTenant(tenant).retain(() => persistDirectoryRetry(journal, coordinator), retryAt, pageId)
  }
  private verifyOwner(page: DirectoryPage, connection: Pick<RestoreConnection, "tenantId" | "userId" | "clientId">) {
    if (connection.tenantId.toLowerCase() !== restoreTenantKey(page.run.tenant) || connection.tenantId.toLowerCase() !== page.run.actor.tenantId.toLowerCase() || connection.userId.toLowerCase() !== page.run.actor.userId.toLowerCase() || connection.clientId.toLowerCase() !== page.run.actor.clientId.toLowerCase()) fail("Use the admin and connection that reviewed this page.")
  }
  private async verifyLocalOwner(page: DirectoryPage) { this.verifyOwner(page, await this.localOwner(page.run.tenant)) }
  private pageIds(tenant: string): string[] {
    const raw = this.store.get(indexKey(tenant))
    if (raw === null) return []
    let ids: unknown
    try { ids = JSON.parse(raw) } catch { ids = null }
    if (!Array.isArray(ids) || !ids.every(isGuid)) fail("Local saved restore discovery could not be verified.")
    return ids as string[]
  }
  /** The index is published before its page, so an interrupted first save lists no page. */
  private savedPages(tenant: string): DirectoryPage[] {
    return this.pageIds(tenant).flatMap(id => { const raw = this.store.get(key(tenant, id)); return raw === null ? [] : [JSON.parse(raw) as DirectoryPage] })
  }
  async unfinished(tenant: string) {
    const owner = await this.localOwner(tenant)
    if (owner.tenantId.toLowerCase() !== restoreTenantKey(tenant)) fail("The connection belongs to another tenant.")
    const pages: Array<{ runId: string; path: string }> = []
    for (const page of this.savedPages(tenant)) {
      const id = page.run.id
      if (page.run.actor.tenantId.toLowerCase() !== owner.tenantId.toLowerCase() || page.run.actor.userId.toLowerCase() !== owner.userId.toLowerCase() || page.run.actor.clientId.toLowerCase() !== owner.clientId.toLowerCase()) continue
      this.verifyOwner(page, owner)
      const view = this.view(page)
      // A settled page still lists while it owns objects, until its cursor and lock cleanup finishes.
      if (!view.discarded && (!page.selection || view.unresolved || directoryObjectState(this.store, tenant, id).ownsObjects())) pages.push({ runId: id, path: page.run.source?.path ?? "" })
    }
    // Account changes while the read was running must not disclose the prior owner's pages.
    const current = await this.localOwner(tenant)
    if (["tenantId", "userId", "clientId"].some(field => current[field as keyof typeof current].toLowerCase() !== owner[field as keyof typeof owner].toLowerCase())) fail("The signed-in account changed. Refresh saved restores.")
    return { owner: [owner.tenantId, owner.userId, owner.clientId].map(value => value.toLowerCase()).join("/"), pages }
  }
  private recentlyCreated(tenant: string, objectId?: string): boolean {
    if (!objectId) return false
    const now = this.now()
    // Unreadable evidence never defers: the row keeps its ordinary not-found outcome.
    try {
      for (const page of this.savedPages(tenant)) for (const { run } of this.history(page)) {
        if (run.tenant.toLowerCase() !== restoreTenantKey(tenant)) continue
        // Directory object IDs are unique across users and groups.
        if (run.entries.some(entry => entry.step.directory?.action === "create" && entry.step.operation === "create" && entry.acknowledged === true && entry.targetId?.toLowerCase() === objectId.toLowerCase() && Number.isFinite(entry.acknowledgedAt) && entry.acknowledgedAt! <= now && now < entry.acknowledgedAt! + DIRECTORY_REPLICATION_WINDOW_MS)) return true
      }
    } catch (error) { if (isRestorePersistenceError(error)) throw error }
    return false
  }
  async verifySavedOwner(tenant: string, id: string) { await this.verifyLocalOwner(this.load(tenant, id)) }
  private async ownerConnection(page: DirectoryPage) {
    const connection = await this.connection(page.run.tenant)
    requireRestoreActor(connection.token, connection, connection.authorization)
    this.verifyOwner(page, connection)
    return connection
  }
  private async pageConnection(page: DirectoryPage) {
    // Online actions retain the tenant-wide publication gate as well as this page's recovery requirement.
    directoryObjectState(this.store, page.run.tenant, page.run.id, this.now).recoverRetryDeadlines()
    this.pending.forTenant(page.run.tenant).flush()
    this.pending.forTenant(page.run.tenant).flush(page.run.id)
    const connection = await this.ownerConnection(page)
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
  private save(page: DirectoryPage) {
    assertNoSecrets(page)
    const ids = this.pageIds(page.run.tenant), first = !ids.includes(page.run.id)
    if (first) this.store.set(indexKey(page.run.tenant), JSON.stringify([...ids, page.run.id]))
    try { this.store.set(key(page.run.tenant, page.run.id), JSON.stringify(page)) }
    catch (error) {
      // An unpublished first page leaves no index entry. A failed rollback lists nothing, since the page is absent.
      if (first) try { if (this.store.get(key(page.run.tenant, page.run.id)) === null) { if (ids.length) this.store.set(indexKey(page.run.tenant), JSON.stringify(ids)); else this.store.delete(indexKey(page.run.tenant)) } } catch { /* Keep the original failure. */ }
      throw error
    }
  }
  private cleanupUnpublished(work: Array<() => void> = [], published?: () => boolean) {
    for (const remove of work) this.unpublishedCleanup.add(() => { if (!published?.()) remove() })
    for (const remove of this.unpublishedCleanup) {
      try { remove(); this.unpublishedCleanup.delete(remove) }
      catch { /* Retain failed deletes for the next preview, and attempt every record. */ }
    }
  }
  async prepare(tenant: string, request: IdentityRestoreRequest, options: DirectoryOptions, read: (path: string) => Promise<unknown>) {
    if (options.previousRunId !== undefined) await this.verifySavedOwner(tenant, options.previousRunId)
    this.cleanupUnpublished()
    directoryObjectState(this.store, tenant, "", this.now).recoverRetryDeadlines()
    this.pending.forTenant(tenant).flush(options.previousRunId)
    let discardUnpublished: (() => void) | undefined
    try { return await this.preparePage(tenant, request, options, read, discard => { discardUnpublished = discard }) }
    catch (error) {
      discardUnpublished?.()
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
  private async preparePage(tenant: string, request: IdentityRestoreRequest, options: DirectoryOptions, read: (path: string) => Promise<unknown>, onInventory: (discard: () => void) => void) {
    const folder = request.path.split("/")[1]
    if (PRIVILEGED_REVIEW_FOLDERS.includes(folder ?? "")) return this.preparePrivileges(tenant, request, options)
    if (DIRECTORY_9B_FOLDERS.includes(folder ?? "")) return this.prepareApplications(tenant, request, options, read, onInventory)
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
      await this.finishContinuation(previous, io)
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
      const inventoryKey = (part: number) => `restore.directory.inventory.${restoreTenantKey(tenant)}.${run.id}.${part}`
      onInventory(() => {
        this.cleanupUnpublished([() => principalMappings.discard(), ...Array.from({ length: part }, (_, index) => () => this.store.delete(inventoryKey(index)))], () => !!this.store.get(key(tenant, run.id)))
      })
      for await (const step of steps) {
        if (++inventory.count > 1_000_000) fail("The directory difference limit was reached.")
        chunk.push(step)
        if (chunk.length === 50) { this.store.set(inventoryKey(part++), JSON.stringify(chunk)); chunk = [] }
      }
      if (chunk.length) this.store.set(inventoryKey(part++), JSON.stringify(chunk))
      inventory.principalMappings = principalMappings.finish()
    }
    if (inventory) {
      const raw = this.store.get(`restore.directory.inventory.${restoreTenantKey(tenant)}.${inventory.id}.${inventory.offset / 50}`)
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
      assertNoSecrets(current)
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
        if (error instanceof DirectoryReadDeferredError || error.retryAt !== undefined) throw error
        review = directoryReview(step, { ...(current?.resource as Item | undefined), ...current }, (current?.principal as Item | null) ?? null, actor, false)
        review.blocker = error.message
      }
      if (step.operation === "create" && current !== null) review.blocker = directoryExistingObjectBlocker(step, current)
      if (step.operation !== "create" && !review.changes.length) review.blocker ??= "This row already matches the desired state. No write is needed."
      const blocker = directoryAdmission(step)
      if (blocker) review.blocker ??= blocker
      page.rows.push({ key: step.key, review }); run.entries.push({ step, state: "pending" })
    }
    this.save(page)
    return this.view(page)
  }
  private async prepareApplications(tenant: string, request: IdentityRestoreRequest, options: DirectoryOptions, read: (path: string) => Promise<unknown>, onInventory: (discard: () => void) => void) {
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
        await this.finishContinuation(previous, io)
        inventory = { ...previous.inventory!, offset: previous.inventory!.offset + previous.run.entries.length }
      } else {
        inventory = { id: run.id, count: 0, offset: 0, targetId: object.targetId! }
        let chunk: GuardedStep[] = [], part = 0
        onInventory(() => {
          this.cleanupUnpublished(Array.from({ length: part }, (_, index) => () => this.store.delete(`restore.directory.inventory.${restoreTenantKey(tenant)}.${run.id}.${index}`)), () => !!this.store.get(key(tenant, run.id)))
        })
        for await (const step of applicationRelationshipSteps(request.path, snapshot, object.targetId!, io, read, readSource)) {
          if (++inventory.count > 1_000_000) fail("The application difference limit was reached.")
          chunk.push(step)
          if (chunk.length === 50) { this.store.set(`restore.directory.inventory.${restoreTenantKey(tenant)}.${run.id}.${part++}`, JSON.stringify(chunk)); chunk = [] }
        }
        if (chunk.length) this.store.set(`restore.directory.inventory.${restoreTenantKey(tenant)}.${run.id}.${part++}`, JSON.stringify(chunk))
      }
      const raw = this.store.get(`restore.directory.inventory.${restoreTenantKey(tenant)}.${inventory.id}.${inventory.offset / 50}`)
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
  private async preparePrivileges(tenant: string, request: IdentityRestoreRequest, requested: DirectoryOptions) {
    if (request.origin !== "restore") fail("Role and PIM review requires an owned same-tenant backup.")
    const [, folder, file] = request.path.split("/") as [string, string, string]
    const snapshot = request.snapshot, sourceId = snapshot.id
    const unitFolder = folder === "AdministrativeUnits"
    // Administrative units in existing backups are stored under their display name.
    if (unitFolder ? !isGuid(sourceId) : typeof sourceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(sourceId) || file !== sourceId + ".json") return fail("The selected backup does not identify the saved relationship.")
    if (typeof sourceId !== "string") return fail("The saved relationship ID is unavailable.")
    const exactMembers = unitFolder && requested.exactMembers
    const options: DirectoryOptions = { stage: unitFolder ? "relationships" : "object", exactMembers, exactOwners: false }
    const retryAt = directoryObjectState(this.store, tenant, "").retryDeadline({ sourceId })
    if (retryAt && retryAt > this.now()) throw new RestoreWriteDeferredError("Microsoft Graph asked TenuVault to wait before reading this relationship again.", retryAt, "throttle")
    const { actor, reader } = await this.actorContext(tenant, deadline => this.recordSourceThrottle(tenant, folder, sourceId, deadline), undefined, "beta")
    const source = { path: request.path, fingerprint: restoreFingerprint(snapshot) }
    const run: GuardedRun = { version: 1, id: randomUUID(), tenant, actor, origin: "restore", source, entries: [], mappings: [] }
    const page: DirectoryPage = { run, rows: [], more: false, options }
    const configurationMappings = guardedRestoreJournal().mappings(tenant)
    const map = (type: string, id: string) => requirePrivilegeId(["Users", "Groups"].includes(type)
      ? directoryMappedId(this.store, tenant, type, id) ?? id
      : mappedReference(configurationMappings, "objectId", type, id) ?? id)
    let candidates: PrivilegeCandidate[] = [{ source: snapshot }]
    if (unitFolder) {
      const id = map(folder, requirePrivilegeId(sourceId))
      const path = `${administrativeUnits}/${id}`
      const live = await reader.getOptional(path)
      const unit = live ? requirePrivilegeObject(live, id, "The saved administrative unit no longer resolves.") : undefined
      let cursor: UnitReviewCursor | undefined
      if (requested.previousRunId) {
        const previous = this.load(tenant, requested.previousRunId)
        if (!previous.unitCursor || !previous.more || previous.run.source?.path !== source.path || previous.run.source.fingerprint !== source.fingerprint || previous.options.exactMembers !== exactMembers || previous.run.actor.userId !== actor.userId || previous.run.actor.clientId !== actor.clientId || previous.unitCursor.targetId !== id) return fail("Continue the original administrative unit review with the same membership choice, or start a new review.")
        cursor = previous.unitCursor.cursor
      }
      const relationships = await unitRelationships(snapshot, reader, unit ? path : undefined, exactMembers, map, cursor)
      candidates = relationships.rows.map(candidate => ({ ...candidate, unitId: id, unit }))
      if (!unit && !candidates.length) candidates.push({ source: {}, unitId: id, blocker: "The live relationship inventory is unavailable." })
      page.more = !!relationships.cursor
      if (relationships.cursor) page.unitCursor = { targetId: id, cursor: relationships.cursor }
    } else if (requested.previousRunId) fail("This relationship has only one review page.")
    for (const [index, candidate] of candidates.entries()) {
      let review: DirectoryReview
      try {
        if (candidate.blocker && !candidate.principalId && candidate.unit) fail(candidate.blocker)
        review = await privilegeReview(folder, candidate, reader, actor, map, this.now())
      } catch (error) {
        if (error instanceof RestoreWriteDeferredError || isRestorePersistenceError(error)) throw error
        review = {
          principal: null, resource: { id: "", name: "Unresolved relationship", type: "directory" }, privilege: "Relationship review", scope: "Unresolved scope",
          approvals: ["directory-item", "privileged-relationship"], notices: [], roleAssignable: false, changes: [],
          blocker: error instanceof RestoreSafetyError ? error.message : "A required relationship reference could not be read.",
        }
      }
      page.rows.push({ key: `privilege-${index}`, review })
    }
    await this.verifyLocalOwner(page)
    this.save(page)
    return this.view(page)
  }
  private retryableLock(page: DirectoryPage) {
    return (owner: string) => {
      if (!page.inventory) return false
      const previous = this.load(page.run.tenant, owner)
      return previous.inventory?.id === page.inventory.id && previous.inventory.offset < page.inventory.offset && !this.view(previous).unresolved
    }
  }
  private async finishContinuation(page: DirectoryPage, io: GuardedIO) {
    const operation = await this.register(page.run.tenant, page.run.id)
    try {
      const view = this.view(page)
      if (view.unresolved) fail("Resolve or discard this saved page before previewing the next page.")
      try {
        if (view.discarded) directoryObjectState(this.store, page.run.tenant, page.run.id).release(true)
        else if (this.store.get(directoryPagePrefix(page.run.tenant, page.run.id) + "cursor")) {
          const entries = page.run.entries.filter(entry => page.selection?.includes(entry.step.key))
          const { entries: _entries, mappings: _mappings, ...identity } = page.run
          await executeDirectoryBatches(this.store, identity, { fingerprint: view.fingerprint, page: async (cursor, limit) => {
            const start = Number(cursor ?? 0), end = Math.min(entries.length, start + limit)
            return { entries: entries.slice(start, end), next: end < entries.length ? String(end) : null }
          } }, io, operation.signal, 20, true, this.retryableLock(page))
          if (!JSON.parse(this.store.get(directoryPagePrefix(page.run.tenant, page.run.id) + "cursor")!).done) throw new RestoreWriteDeferredError("Cursor cleanup is incomplete")
        }
      } catch (error) {
        if (!isRestorePersistenceError(error) && !(error instanceof RestoreWriteDeferredError)) throw error
        throw new RestoreWriteDeferredError("The previous directory page could not finish its cursor and lock cleanup. Retry previewing the next page.")
      }
    } finally { operation.finish() }
  }
  private view(page: DirectoryPage) {
    const runs = this.history(page), entries = runs.flatMap(({ run }) => run.entries)
    return { outcomes: this.outcomes(page, runs), ...this.pageState(page, entries), canDiscard: this.canDiscard(page, runs), runId: page.run.id, selection: page.selection, fingerprint: restoreFingerprint({ source: page.run.source!, rows: page.rows as unknown as Item["rows"], options: page.options as unknown as Item, ...(page.inventory?.principalMappings ? { principalMappings: page.inventory.principalMappings.fingerprint } : {}) }), rows: page.rows, more: page.more, options: page.options }
  }
  private canDiscard(page: DirectoryPage, runs = this.history(page)) {
    return !directoryObjectState(this.store, page.run.tenant, page.run.id).discarded() && !runs.some(({ batch, run }) => {
      const recovered = structuredClone(run)
      recoverDirectoryRejections(this.store, recovered, directoryPagePrefix(page.run.tenant, page.run.id) + `batch.${batch}.`, this.now)
      return recovered.entries.some(entry => entry.state === "uncertain")
    })
  }
  private pageState(page: DirectoryPage, entries: GuardedRun["entries"]) {
    const discarded = directoryObjectState(this.store, page.run.tenant, page.run.id).discarded()
    return { discarded, unresolved: directoryPageUnresolved(discarded, page.selection ?? [], entries.map(entry => ({ key: entry.step.key, state: entry.state }))) }
  }
  async resume(tenant: string, request: IdentityRestoreRequest, operationSignal?: AbortSignal): Promise<ReturnType<DirectoryRestoreService["view"]>> {
    if (!operationSignal) {
      const operation = await this.register(tenant, request.runId!)
      try { return await this.resume(tenant, request, operation.signal) }
      finally { operation.finish() }
    }
    const page = this.load(tenant, request.runId!)
    await this.verifyLocalOwner(page)
    const connection = await this.pageConnection(page)
    const privileged = PRIVILEGED_REVIEW_FOLDERS.includes(page.run.source?.path.split("/")[1] ?? "")
    const { actor } = privileged
      ? await this.actorContext(tenant, retryAt => this.recordPageThrottle(page, retryAt), connection, "beta")
      : await this.context(tenant, retryAt => this.recordPageThrottle(page, retryAt), connection, page.run.id)
    if (request.origin !== "restore" || page.run.origin !== request.origin || page.run.source?.path !== request.path || page.run.source.fingerprint !== restoreFingerprint(request.snapshot) || actor.userId !== page.run.actor.userId || actor.clientId !== page.run.actor.clientId) fail("Resume the original backup with the admin and connection that reviewed it.")
    return this.view(page)
  }
  private async register(tenant: string, id: string) {
    await this.verifyLocalOwner(this.load(tenant, id))
    const runningKey = key(tenant, id), controller = new AbortController()
    if (this.running.has(runningKey)) fail("This directory page is already running.")
    this.running.set(runningKey, controller)
    return { signal: controller.signal, finish: () => { this.running.delete(runningKey) } }
  }
  async operation<T>(tenant: string, id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | { cancelled: true }> {
    const operation = await this.register(tenant, id)
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
      const operation = await this.register(tenant, request.runId!)
      try { return await this.execute(tenant, request, fingerprint, approvals, operation.signal) }
      finally { operation.finish() }
    }
    const page = this.load(tenant, request.runId!)
    await this.verifyLocalOwner(page)
    if (request.origin !== "restore" || page.run.origin !== request.origin || page.run.source?.path !== request.path || page.run.source.fingerprint !== restoreFingerprint(request.snapshot) || this.view(page).fingerprint !== fingerprint) fail("The backup or preview changed. Preview this object again.")
    const folder = request.path.split("/")[1] ?? ""
    if (PRIVILEGED_REVIEW_FOLDERS.includes(folder)) fail(PRIVILEGED_RESTORE_BLOCKER)
    const consent = privilegedRestoreConsent(this.signInMethod?.(tenant), folder)
    if (consent) fail(`${consent.pack.label} is unavailable with the TenuVault app until temporary access and permission removal can be verified.`)
    const connection = await this.pageConnection(page)
    const selection = page.rows.filter(row => !row.review.blocker && row.review.approvals.every(kind => approvals[row.key]?.includes(kind))).map(row => row.key)
    if (!selection.length || (page.selection && JSON.stringify(page.selection) !== JSON.stringify(selection))) fail("Approve each selected row separately. A resumed page must keep its original selection.")
    page.selection = selection; this.save(page)
    const context = await this.context(tenant, retryAt => this.recordPageThrottle(page, retryAt), connection, page.run.id), actor = context.actor
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
    } }, io, operationSignal, 20, false, this.retryableLock(page))
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
      const runs = this.history(page)
      objects.trackRetryJournals(runs.filter(({ run }) => run.entries.length).map(({ batch, run }) => ({
        prefix: directoryPagePrefix(run.tenant, run.id) + `batch.${batch}.`,
        targets: run.entries.map(entry => entry.targetId ?? entry.step.targetId ?? directoryMappedId(this.store, run.tenant, entry.step.folder, entry.step.sourceId) ?? entry.step.sourceId),
      })), retryAt)
      for (const { batch, run } of runs) {
        for (const entry of run.entries) entry.retryAt = Math.max(entry.retryAt ?? 0, retryAt)
        new GuardedRunJournal({ get: name => this.store.get(directoryPagePrefix(run.tenant, run.id) + `batch.${batch}.` + name), set: (name, value) => this.store.set(directoryPagePrefix(run.tenant, run.id) + `batch.${batch}.` + name, value), delete: () => fail("History cannot be deleted.") }).save(run)
      }
    }, () => {
      const runs = this.history(page)
      const steps: Array<Pick<GuardedStep, "folder" | "sourceId" | "targetId">> = runs.length ? runs.flatMap(({ run }) => run.entries.map(entry => ({ ...entry.step, targetId: entry.targetId ?? entry.step.targetId }))) : page.run.entries.map(({ step }) => step)
      if (!steps.length && page.inventory) steps.push({ folder: page.run.source!.path.split("/")[1]!, sourceId: page.inventory.targetId, targetId: page.inventory.targetId })
      for (const step of steps) objects.recordThrottle(step, retryAt)
    }, page.run.id)
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
  private outcomes(page: DirectoryPage, runs = this.history(page)) {
    const outcomes = new Map(runs.flatMap(({ run }) => run.entries.map(entry => [entry.step.key, { key: entry.step.key, state: entry.state, reason: entry.reason, targetId: entry.targetId, retryAt: entry.retryAt, ...(entry.deferralCause ? { deferralCause: entry.deferralCause } : {}) }] as const)))
    for (const entry of page.run.entries) if (page.selection?.includes(entry.step.key) && !outcomes.has(entry.step.key)) outcomes.set(entry.step.key, { key: entry.step.key, state: "pending", reason: undefined, targetId: undefined, retryAt: undefined })
    return [...outcomes.values()]
  }
  private results(page: DirectoryPage, result: { status: "complete" | "partial" | "nothing-sent"; batches: number; failed: number }, runs = this.history(page)) {
    const outcomes = this.outcomes(page, runs)
    return { ...result, ...this.pageState(page, runs.flatMap(({ run }) => run.entries)), failed: outcomes.filter(entry => ["blocked", "failed", "failed-before-send"].includes(entry.state)).length, canDiscard: this.canDiscard(page, runs),
      outcomes,
      replacedReferences: runs.flatMap(({ run }) => run.replacedReferences ?? []), warnings: [...new Set(runs.flatMap(({ run }) => run.referenceWarning ? [run.referenceWarning] : []))] }
  }
  /** Saved-page actions trust only durable identity and journal data, never renderer snapshots. */
  async saved(tenant: string, id: string, action: "reconcile" | "discard") {
    const page = this.load(tenant, id), runningKey = key(tenant, id)
    await this.verifyLocalOwner(page)
    if (this.running.has(runningKey)) fail("This directory page is already running.")
    const controller = new AbortController()
    this.running.set(runningKey, controller)
    try {
      const state = directoryObjectState(this.store, tenant, id, this.now)
      state.recoverRetryDeadlines()
      if (action === "discard") {
        this.pending.forTenant(tenant).flush(page.run.id)
        for (const { batch, run } of this.history(page)) {
          const prefix = directoryPagePrefix(tenant, id) + `batch.${batch}.`
          if (recoverDirectoryRejections(this.store, run, prefix, this.now)) new GuardedRunJournal({ get: name => this.store.get(prefix + name), set: (name, value) => this.store.set(prefix + name, value), delete: () => fail("History cannot be deleted.") }).save(run)
        }
        state.recoverMappings(page.run.entries.map(entry => entry.step))
        if (this.history(page).some(({ run }) => run.entries.some(entry => entry.state === "uncertain"))) fail("Confirm the uncertain result before discarding this saved restore.")
        state.release(true)
        if (!state.discarded()) fail("The discard marker could not be verified. This page remains saved.")
        return this.view(page)
      }
      if (PRIVILEGED_REVIEW_FOLDERS.includes(page.run.source?.path.split("/")[1] ?? "")) {
        return { ...this.view(page), ...this.results(page, { status: "nothing-sent", batches: 0, failed: 0 }, []) }
      }
      const connection = await this.pageConnection(page)
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
      const context = await this.context(tenant, retryAt => this.recordPageThrottle(page, retryAt), connection, page.run.id)
      if (context.actor.userId !== page.run.actor.userId || context.actor.clientId !== page.run.actor.clientId) fail("Use the admin and connection that reviewed this page.")
      if (!this.history(page).length && !this.store.get(directoryPagePrefix(tenant, id) + "batch.0.plan")) {
        return { ...this.view(page), ...this.results(page, { status: "nothing-sent", batches: 0, failed: 0 }, []) }
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
      } }, DIRECTORY_9B_FOLDERS.includes(entries[0]!.step.folder) ? context.applicationIO : context.io, controller.signal, 20, true, this.retryableLock(page))
      return { ...this.view(page), ...this.results(page, result) }
    } finally { this.running.delete(runningKey) }
  }
  async cancel(tenant: string, id: string) {
    await this.verifyLocalOwner(this.load(tenant, id))
    const controller = this.running.get(key(tenant, id))
    controller?.abort()
    return { cancelled: !!controller?.signal.aborted }
  }
}
