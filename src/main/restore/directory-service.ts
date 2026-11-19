import { randomUUID, createHash } from "node:crypto"
import { INTUNE_TYPES, type Item } from "../../shared/intune/registry"
import { canBackUp } from "../../shared/services/modules"
import { grantedPermissions } from "../../shared/services/token"
import { referenceMatches, REFERENCE_SCAN_EXCLUDED } from "./reference-scanner"
import { isGuid } from "../../shared/security"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { relationPath, LARGE_SHARD_ITEMS } from "../../shared/large-backup"
import type { PartitionedRestoreStore } from "../storage/directory-restore-store"
import { directory9aIO, directoryAdmission } from "./directory-9a-io"
import { directoryObjectStep, directoryRelationshipSteps, mappedDirectoryIds } from "./directory-9a-plan"
import { approveDirectory, type DirectoryReview } from "./directory-9a"
import { directoryMappedId, executeDirectoryBatches } from "./directory-9a-batches"
import { GuardedRunJournal, restoreFingerprint, type GuardedRun } from "./guarded-run"
import { resolveRestoreActor, type RecoveryAccounts } from "./safety-resolvers"
import { safetyReader } from "./safety-reader"
import { requireRestoreActor } from "./restore-actor"
import type { RestoreConnection } from "./service"
import type { IdentityRestoreRequest } from "./dispatch"

export interface DirectoryOptions { stage: "object" | "relationships"; exactMembers: boolean; exactOwners: boolean; previousRunId?: string }
export interface DirectoryPage { run: GuardedRun; rows: Array<{ key: string; review: DirectoryReview }>; more: boolean; options: DirectoryOptions; selection?: string[] }
const fail = (message: string): never => { throw new RestoreSafetyError(message) }
const key = (tenant: string, id: string) => `restore.directory.review.${tenant.toLowerCase()}.${id}`
/** Owned backup readers are supplied by the authenticated route, never by the renderer. */
export class DirectoryRestoreService {
  private readonly running = new Map<string, AbortController>()
  constructor(private readonly store: PartitionedRestoreStore, private readonly recovery: RecoveryAccounts, private readonly connection: (tenant: string) => Promise<RestoreConnection>, private readonly fetchImpl: typeof fetch = fetch) {}
  private async context(tenant: string) {
    const connection = await this.connection(tenant)
    if (connection.tenantId.toLowerCase() !== tenant.toLowerCase()) fail("The connection belongs to another tenant.")
    requireRestoreActor(connection.token, { ...connection, recoveryAccountIds: [] })
    const actor = await resolveRestoreActor(safetyReader(connection.token, this.fetchImpl), connection, this.recovery.get(tenant), ["identity-references"])
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
      return referenceMatches(connection.token, mappings, this.fetchImpl, { signal })
    })
    return { actor, io }
  }
  private load(tenant: string, id: string): DirectoryPage {
    if (!isGuid(id)) fail("Select a saved directory preview.")
    const raw = this.store.get(key(tenant, id))
    if (!raw) fail("This directory preview is unavailable.")
    return JSON.parse(raw!)
  }
  private save(page: DirectoryPage) { this.store.set(key(page.run.tenant, page.run.id), JSON.stringify(page)) }
  async prepare(tenant: string, request: IdentityRestoreRequest, options: DirectoryOptions, read: (path: string) => Promise<unknown>) {
    const folder = request.path.split("/")[1]
    if (!["Users", "Groups"].includes(folder ?? "") || request.origin !== "restore") fail("Directory restore requires an owned same-tenant backup.")
    const snapshot = request.snapshot, sourceId = snapshot.id
    if (!isGuid(sourceId)) fail("The directory source ID is missing.")
    const { actor, io } = await this.context(tenant)
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
    let after = ""
    if (options.previousRunId) {
      const previous = this.load(tenant, options.previousRunId)
      if (folder !== "Groups" || options.stage !== "relationships" || previous.run.source?.path !== request.path || previous.run.source.fingerprint !== run.source!.fingerprint || previous.options.exactMembers !== options.exactMembers || previous.options.exactOwners !== options.exactOwners || previous.run.actor.userId !== actor.userId || previous.run.actor.clientId !== actor.clientId) fail("Continue the original group's relationship preview and exact choices.")
      after = previous.run.entries.at(-1)?.step.key ?? ""
    }
    const page: DirectoryPage = { run, rows: [], more: false, options }
    let steps: AsyncIterable<typeof object>
    if (options.stage === "object") steps = (async function* () { yield object })()
    else {
      if (object.directory?.action !== "update") fail("Restore the directory object before reviewing its relationships.")
      const target = object.targetId!
      const mapPrincipal = async (id: string) => directoryMappedId(this.store, tenant, "Users", id) ?? directoryMappedId(this.store, tenant, "Groups", id) ?? id
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
        members: { saved: folder === "Groups" ? mappedDirectoryIds(saved("members"), mapPrincipal) : empty(), current: folder === "Groups" ? mappedDirectoryIds(io.ids(target, "members"), async id => id) : empty() },
        owners: { saved: folder === "Groups" ? mappedDirectoryIds(saved("owners"), mapPrincipal) : empty(), current: folder === "Groups" ? mappedDirectoryIds(io.ids(target, "owners"), async id => id) : empty() },
        exactMembers: options.exactMembers, exactOwners: options.exactOwners, mapPrincipal, savedIdsAreTargets: true,
      })
    }
    for await (const step of steps) {
      if (after && step.key <= after) continue
      if (page.rows.length === 50) { page.more = true; break }
      const review = await io.review(step)
      const blocker = directoryAdmission(step)
      if (blocker) review.blocker ??= blocker
      page.rows.push({ key: step.key, review }); run.entries.push({ step, state: "pending" })
    }
    this.save(page)
    return this.view(page)
  }
  private view(page: DirectoryPage) {
    return { runId: page.run.id, fingerprint: restoreFingerprint({ source: page.run.source!, rows: page.rows as unknown as Item["rows"], options: page.options as unknown as Item }), rows: page.rows, more: page.more, options: page.options }
  }
  async resume(tenant: string, request: IdentityRestoreRequest) {
    const { actor } = await this.context(tenant), page = this.load(tenant, request.runId!)
    if (page.run.source?.path !== request.path || page.run.source.fingerprint !== restoreFingerprint(request.snapshot) || actor.userId !== page.run.actor.userId || actor.clientId !== page.run.actor.clientId) fail("Resume the original backup with the admin and connection that reviewed it.")
    return this.view(page)
  }
  async execute(tenant: string, request: IdentityRestoreRequest, fingerprint: string, approvals: Record<string, string[]>) {
    const page = this.load(tenant, request.runId!)
    if (page.run.source?.path !== request.path || page.run.source.fingerprint !== restoreFingerprint(request.snapshot) || this.view(page).fingerprint !== fingerprint) fail("The backup or preview changed. Preview this object again.")
    const { actor, io } = await this.context(tenant)
    if (actor.userId !== page.run.actor.userId || actor.clientId !== page.run.actor.clientId) fail("Resume with the admin and connection that reviewed this page.")
    const selection = page.rows.filter(row => !row.review.blocker && row.review.approvals.every(kind => approvals[row.key]?.includes(kind))).map(row => row.key)
    if (!selection.length || (page.selection && JSON.stringify(page.selection) !== JSON.stringify(selection))) fail("Approve each selected row separately. A resumed page must keep its original selection.")
    page.selection = selection; this.save(page)
    const entries = page.run.entries.filter(entry => selection.includes(entry.step.key))
    for (const entry of entries) for (const kind of page.rows.find(row => row.key === entry.step.key)!.review.approvals) approveDirectory(entry.step, page.run, kind)
    const controller = new AbortController(), runningKey = key(tenant, page.run.id)
    if (this.running.has(runningKey)) fail("This directory page is already running.")
    this.running.set(runningKey, controller)
    try {
      const { entries: _entries, mappings: _mappings, ...identity } = page.run
      const result = await executeDirectoryBatches(this.store, { ...identity, actor }, { fingerprint, page: async (cursor, limit) => {
        const start = Number(cursor ?? 0), end = Math.min(entries.length, start + limit)
        return { entries: entries.slice(start, end), next: end < entries.length ? String(end) : null }
      } }, io, controller.signal)
      const outcomes = [], warnings = new Set<string>(), replacedReferences = []
      for (let batch = 0; batch <= result.batches; batch++) {
        const prefix = `restore.directory.${encodeURIComponent(tenant)}.${encodeURIComponent(page.run.id)}.batch.${batch}.`
        const journal = new GuardedRunJournal({ get: name => this.store.get(prefix + name), set: () => fail("History is read-only."), delete: () => fail("History is read-only.") })
        const run = journal.load(tenant, page.run.id)
        if (run) {
          replacedReferences.push(...(run.replacedReferences ?? []))
          if (run.referenceWarning) warnings.add(run.referenceWarning)
          outcomes.push(...run.entries.map(entry => ({ key: entry.step.key, state: entry.state, reason: entry.reason, targetId: entry.targetId })))
        }
      }
      return { ...result, outcomes, replacedReferences, warnings: [...warnings] }
    } finally { this.running.delete(runningKey) }
  }
  async cancel(tenant: string, id: string) {
    await this.context(tenant); this.load(tenant, id)
    this.running.get(key(tenant, id))?.abort()
    return { cancelled: true }
  }
}
