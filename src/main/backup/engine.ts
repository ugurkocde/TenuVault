export { assertStorageAccountName } from "../../shared/storage-account"
export { ProtectedBlobError, isImmutabilityRefusal } from "./request"
import { createHash, randomUUID } from "node:crypto"
import { BACKUP_OWNER_FILE } from "../../shared/constants"
import { BlobWriter } from "./blob-writer"
import { GraphSession, type GraphItem } from "./graph-session"
import { GRAPH, BlobClaimError, GraphError, ProtectedBlobError, RequestTimeoutError, StorageError, TokenError, isUnreachable } from "./request"
import { isLocalAccount } from "../storage/blob-emulator"
import { FetchApplicationError } from "../api/network-error"
import { INTUNE_TYPES, itemName, type IntuneType, type Item } from "../../shared/intune/registry"
import { readObject } from "../../shared/intune/read"
import { comparableSnapshot } from "../../shared/intune/compare"
import type { BackupItems } from "../../shared/intune/backup-changes"
import { coveredFolders, EVERYTHING, includedTypes, normalizeScope, type BackupScope } from "../../shared/intune/scope"

/**
 * Runs Intune backups from the desktop app as the signed-in admin.
 *
 * Output matches the TenuVault Azure Automation runbook (folder layout and metadata.json), so the
 * shared restore, drift detection, download and history features work the same for
 * backups made by the app and by the Azure Automation runbook. The destination is the
 * tenant's storage account: either the customer's Azure storage account or the
 * encrypted store on this device (served through the fetch bridge).
 */

export type BackupStatus = "Running" | "Completed" | "Failed" | "Cancelled"

export interface BackupJob {
  id: string
  tenantId: string
  storageAccountName: string
  status: BackupStatus
  progress: number
  progressMessage: string
  startTime: string
  endTime?: string
  exception?: string
  backupFolder?: string
  /** Policies and types that could not be read; above zero the backup on disk is partial. */
  failures?: number
  /** Set when the job failed because Microsoft or the storage account could not be reached, including timeouts. */
  unreachable?: boolean
  log: string[]
}

export type BackupTrigger = "manual" | "scheduled" | "tray"

export interface BackupRequest {
  tenantId: string
  clientId: string
  storageAccountName: string
  /** What to back up; everything when left out. */
  scope?: BackupScope
  trigger?: BackupTrigger
}

export interface BackupEngineDeps {
  /** The main-process fetch (bridged, so local storage accounts are served from disk). */
  fetch: typeof fetch
  getToken: (tenantId: string, clientId: string, scope: string) => Promise<string>
  /** Backups older than this many days are deleted after each backup; 0 keeps everything. */
  retentionDays?: (tenantId: string) => number
  now?: () => Date
  /** Items read at the same time. Graph throttling (429) pauses every reader. */
  concurrency?: number
}

/** A Graph beta path, or an absolute nextLink that must be on the Graph origin. */
function graphUrl(path: string): string {
  if (!URL.canParse(path)) return `${GRAPH}/beta/${path}`
  if (new URL(path).origin !== GRAPH) throw new Error("Invalid Graph continuation link")
  return path
}

/** Types covered by the original DeviceManagementConfiguration permission. */
const ORIGINAL_FOLDERS = new Set(["DeviceConfigurations", "CompliancePolicies", "ConfigurationPolicies", "GroupPolicyConfigurations"])

const listUrl = (type: IntuneType) => `${GRAPH}/beta/${type.path}${type.listQuery ? `?${type.listQuery}` : ""}`

const MAX_JOBS = 25
const CONCURRENCY = 8
export const JOB_DEADLINE_MS = 30 * 60_000
export const MANIFEST_COMMIT_GRACE_MS = 2 * 60_000

/** Another writer already claimed this backup folder, so this backup wrote nothing. */
export class BackupFolderTakenError extends StorageError {
  constructor(readonly folder: string) {
    super(`Backup folder ${folder} is already in use by another backup for this tenant and storage. Nothing from this backup was written. Wait for the other backup to finish, then try again.`)
    this.name = "BackupFolderTakenError"
  }
}
class BackupCancelledError extends Error {}

/**
 * What a run saved, whether the network answered any of its requests, and how many recorded
 * failures had a cause that was neither the network nor an HTTP response (for example a sign-in
 * Microsoft refused, or a local storage error). A run is unreachable only when it saved nothing,
 * got no HTTP response and failed only because Microsoft or the storage could not be reached.
 */
interface RunOutcome {
  saved: number
  answered: boolean
  otherFailures: number
}

/**
 * The job's fetch, recording any HTTP response from Graph or Azure Storage as soon as it arrives,
 * before status handling, retries, the circuit or a timeout can replace it with another error.
 * Responses for a local storage account (`localHost`) come from this device, not the network.
 */
function answeredFetch(fetchImpl: typeof fetch, outcome: RunOutcome, localHost: string | null): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (new URL(url).hostname !== localHost) outcome.answered = true
    return response
  }
}

type NetworkService = "Microsoft Graph" | "backup storage"

/** Repeated 401 or 403 responses mean the role behind them is gone, so the job stops instead of grinding the whole work list. */
export const CONSECUTIVE_AUTH_FAILURE_LIMIT = 5

/** One service outage must stop the job before readers drain every policy or type. */
export class NetworkCircuit {
  private readonly controller = new AbortController()
  private readonly combined: AbortSignal
  private readonly consecutiveFailures: Record<NetworkService, number> = { "Microsoft Graph": 0, "backup storage": 0 }
  private readonly consecutiveAuthFailures: Record<NetworkService, { status: number; count: number } | null> = { "Microsoft Graph": null, "backup storage": null }

  constructor(private readonly threshold: number, signal?: AbortSignal, private readonly deadline?: number) {
    this.combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
  }

  get signal(): AbortSignal {
    if (this.deadline !== undefined && Date.now() >= this.deadline) this.controller.abort(jobDeadlineError())
    return this.combined
  }

  succeeded(service: NetworkService): void {
    this.signal.throwIfAborted()
    this.consecutiveFailures[service] = 0
    this.consecutiveAuthFailures[service] = null
  }

  /** `cause` is the failure that trips the circuit, kept so the job can tell an unreachable service apart. */
  failed(service: NetworkService, cause?: unknown): void {
    this.signal.throwIfAborted()
    if (++this.consecutiveFailures[service] < this.threshold) return
    this.controller.abort(new Error(`Backup stopped: ${service} did not respond for ${this.consecutiveFailures[service]} consecutive requests. Earlier policies in this run were saved; the backup is incomplete.`, { cause }))
    this.signal.throwIfAborted()
  }

  /** Counts consecutive responses with the same 401 or 403 status; a success or a different status starts over. */
  authFailed(service: NetworkService, status: number, message: string): void {
    this.signal.throwIfAborted()
    if (status !== 401 && status !== 403) return
    const previous = this.consecutiveAuthFailures[service]
    const count = previous?.status === status ? previous.count + 1 : 1
    this.consecutiveAuthFailures[service] = { status, count }
    if (count < CONSECUTIVE_AUTH_FAILURE_LIMIT) return
    this.controller.abort(new Error(message))
    this.signal.throwIfAborted()
  }
}

async function tokenOrStop(get: () => Promise<string>): Promise<string> {
  try {
    return await get()
  } catch (error) {
    // Keep the cause: it tells a sign-in Microsoft refused from one that could not reach Microsoft.
    throw new TokenError(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

export class BackupEngine {
  private readonly jobs = new Map<string, BackupJob>()
  private readonly running = new Map<string, { job: BackupJob; key: string }>()
  private readonly executions = new Map<string, { controller: AbortController; done: Promise<BackupJob> }>()

  constructor(private readonly deps: BackupEngineDeps) {}

  get(jobId: string): BackupJob | undefined {
    return this.jobs.get(jobId)
  }

  /** Waits for the same bounded execution used by manual and scheduled jobs. */
  waitForJob(job: BackupJob): Promise<BackupJob> {
    return this.executions.get(job.id)?.done ?? Promise.resolve(job)
  }

  cancel(jobId: string): BackupJob | undefined {
    const job = this.jobs.get(jobId)
    if (job?.status === "Running") this.executions.get(jobId)?.controller.abort(new BackupCancelledError("Backup cancelled by you. No manifest was written for this run."))
    return job
  }

  /**
   * Starts a backup in the background. One backup per tenant runs at a time. A request joins the
   * running backup only when tenant, storage account and scope all match; any other request gets
   * a failed job of its own, so a scheduled full backup can never ride on a narrower manual one.
   */
  start(request: BackupRequest): BackupJob {
    const tenantKey = request.tenantId.toLowerCase()
    const key = `${request.storageAccountName.toLowerCase()}\n${normalizeScope(request.scope ?? EVERYTHING).excluded.join(",")}`
    const active = this.running.get(tenantKey)
    if (active) {
      if (active.key === key) return active.job
      const conflict: BackupJob = {
        id: `desktop-${randomUUID()}`,
        tenantId: request.tenantId,
        storageAccountName: request.storageAccountName,
        status: "Failed",
        progress: 100,
        progressMessage: "Backup failed",
        startTime: this.now().toISOString(),
        endTime: this.now().toISOString(),
        exception: "A different backup is already running for this tenant. Wait for it to finish, then try again.",
        log: [],
      }
      this.write(conflict, `Backup failed: ${conflict.exception}`)
      this.jobs.set(conflict.id, conflict)
      this.prune()
      return conflict
    }

    const controller = new AbortController()
    const deadline = Date.now() + JOB_DEADLINE_MS
    const job: BackupJob = {
      id: `desktop-${randomUUID()}`,
      tenantId: request.tenantId,
      storageAccountName: request.storageAccountName,
      status: "Running",
      progress: 5,
      progressMessage: "Starting backup...",
      startTime: this.now().toISOString(),
      log: [],
    }
    this.jobs.set(job.id, job)
    this.running.set(tenantKey, { job, key })
    this.prune()

    const timer = setTimeout(() => controller.abort(jobDeadlineError()), JOB_DEADLINE_MS)
    timer.unref?.()
    const outcome: RunOutcome = { saved: 0, answered: false, otherFailures: 0 }
    const done = this.run(job, request, controller.signal, deadline, outcome)
      .catch((error: unknown) => {
        job.status = error instanceof BackupCancelledError ? "Cancelled" : "Failed"
        job.exception = error instanceof Error ? error.message : String(error)
        if (job.status === "Failed" && isUnreachable(error) && !outcome.saved && !outcome.answered && !outcome.otherFailures) job.unreachable = true
        job.progressMessage = job.status === "Cancelled" ? "Backup cancelled" : "Backup failed"
        this.write(job, `${job.progressMessage}: ${job.exception}`)
      })
      .finally(() => {
        clearTimeout(timer)
        controller.abort(new Error("Backup finished"))
        job.progress = 100
        job.endTime = this.now().toISOString()
        this.running.delete(tenantKey)
        this.executions.delete(job.id)
      })
      .then(() => job)
    this.executions.set(job.id, { controller, done })
    return job
  }

  private async run(job: BackupJob, request: BackupRequest, signal: AbortSignal, deadline: number, outcome: RunOutcome): Promise<void> {
    const started = this.now()
    const local = isLocalAccount(request.storageAccountName)
    const fetchImpl = answeredFetch(this.deps.fetch, outcome, local ? `${request.storageAccountName.toLowerCase()}.blob.core.windows.net` : null)
    const backupFolder = `backup-${folderTimestamp(started)}`
    job.backupFolder = backupFolder
    this.write(job, `Backing up tenant ${request.tenantId} to ${local ? "this device (encrypted)" : `storage account ${request.storageAccountName}`}.`)
    this.write(job, `Backup folder: ${backupFolder}`)

    const graphToken = () => tokenOrStop(() => this.deps.getToken(request.tenantId, request.clientId, `${GRAPH}/.default`))
    const storageToken = local
      ? async () => ""
      : () => tokenOrStop(() => this.deps.getToken(request.tenantId, request.clientId, "https://storage.azure.com/.default"))

    const concurrency = this.deps.concurrency ?? CONCURRENCY
    const network = new NetworkCircuit(3 * concurrency, signal, deadline)
    const storage = new BlobWriter(fetchImpl, request.storageAccountName, storageToken, network)
    await storage.ensureContainer()

    const scope = normalizeScope(request.scope ?? EVERYTHING)
    const types = includedTypes(scope)
    if (scope.excluded.length) this.write(job, `Leaving out ${scope.excluded.length} of ${INTUNE_TYPES.length} types: ${scope.excluded.join(", ")}.`)
    const graph = new GraphSession(fetchImpl, graphToken, network)
    const reader = {
      get: (path: string) => graph.get<Item>(`${GRAPH}/beta/${path}`),
      list: (path: string) => graph.list(graphUrl(path)) as Promise<Item[]>,
    }

    // List everything first so progress reflects the real amount of work.
    job.progressMessage = "Reading Intune configuration..."
    const counts: Record<string, number> = Object.fromEntries(types.map((type) => [type.folder, 0]))
    const lists: Array<{ type: IntuneType; items: GraphItem[] } | null> = Array.from({ length: types.length }, () => null)
    const skippedTypes: string[] = []
    const failedTypes: string[] = []
    let failures = 0
    // A type the app registration has no permission for is skipped below and does not count:
    // only failures that point at a removed role across the work list stop the backup.
    const countAuthFailure = (error: unknown) => {
      if (error instanceof GraphError && (error.status === 401 || error.status === 403)) network.authFailed("Microsoft Graph", error.status, error.message)
    }
    await pool(types.map((type, index) => ({ type, index })), concurrency, async ({ type, index }) => {
      try {
        const all = await graph.list(listUrl(type))
        const items = all.filter((item) => !type.skip?.(item as never))
        const skipped = all.length - items.length
        this.write(job, `Found ${items.length} ${type.label}${skipped ? ` (${skipped} built-in skipped)` : ""}.`)
        lists[index] = { type, items }
      } catch (error) {
        // Access denied: the app registration lacks the permission or its admin consent (for example
        // one created before the type was supported), or the admin's Intune role does not cover the
        // type. It is left out and reported, without marking the backup incomplete for the rest.
        const denied = error instanceof GraphError && error.status === 403 && !ORIGINAL_FOLDERS.has(type.folder)
        // Counted before any rethrow, so the job sees this cause whichever failure ends it.
        if (!denied && !isUnreachable(error)) outcome.otherFailures++
        network.signal.throwIfAborted()
        if (error instanceof RequestTimeoutError) throw error
        if (error instanceof TokenError || (error instanceof GraphError && error.status === 401)) throw error
        if (denied) {
          skippedTypes.push(type.folder)
          this.write(job, `Skipped ${type.label}: access was denied. The app registration may lack the permission or admin consent, or your Intune role may not allow it.`)
          return
        }
        countAuthFailure(error)
        failures++
        failedTypes.push(type.folder)
        this.write(job, `Could not read ${type.label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, network.signal)

    // Claim the folder before writing any policy, even when retention currently keeps everything.
    // The create-only write is atomic, so two writers that start in the same second cannot share
    // one folder: the loser fails here and writes nothing else.
    try {
      await storage.put(`${backupFolder}/${BACKUP_OWNER_FILE}`, JSON.stringify({ Source: "TenuVault Desktop", TenantId: request.tenantId.toLowerCase() }), undefined, true)
    } catch (error) {
      if (error instanceof BlobClaimError) throw new BackupFolderTakenError(backupFolder)
      throw error
    }

    // File names are chosen in list order, before the parallel reads, so they do not depend on timing.
    const work: Array<{ type: IntuneType; item: GraphItem; displayName: string; fileName: string }> = []
    for (const list of lists) {
      if (!list) continue
      const usedNames = new Set<string>()
      for (const item of list.items) {
        const displayName = itemName(list.type, item as never)
        work.push({ type: list.type, item, displayName, fileName: uniqueName(safeFileName(displayName), item.id, usedNames) })
      }
    }
    const remaining = new Map(lists.filter((list) => list !== null).map((list) => [list.type.folder, list.items.length]))
    const items: BackupItems = {}
    let done = 0
    const itemTimeoutWarnings: string[] = []

    await pool(work, concurrency, async ({ type, item, displayName, fileName }) => {
      job.progressMessage = `Backing up ${type.label}`
      try {
        const detail = await readObject(type, item.id, reader)
        const body = JSON.stringify(detail, null, 2)
        await storage.put(`${backupFolder}/${type.folder}/${fileName}.json`, body)
        items[`${type.folder}/${item.id}`] = {
          file: `${fileName}.json`,
          hash: snapshotHash(detail),
          // What versions that could not read this type's assignments recorded, to compare with their backups.
          ...(type.assignmentsFormerlyExpanded ? { hashWithEmptyAssignments: snapshotHash({ ...detail, assignments: [] }) } : {}),
        }
        counts[type.folder]!++
        outcome.saved++
      } catch (error) {
        // Counted before any rethrow, so the job sees this cause whichever failure ends it.
        if (!isUnreachable(error)) outcome.otherFailures++
        network.signal.throwIfAborted()
        countAuthFailure(error)
        // An expired sign-in fails every remaining item the same way, so it stops the backup once.
        if (error instanceof TokenError || (error instanceof GraphError && error.status === 401)) throw error
        failures++
        const warning = `Could not back up "${displayName}": ${error instanceof Error ? error.message : String(error)}`
        if (error instanceof RequestTimeoutError) itemTimeoutWarnings.push(warning)
        this.write(job, warning)
      }
      done++
      job.progress = Math.round(10 + (done / Math.max(work.length, 1)) * 85)
      const left = remaining.get(type.folder)! - 1
      remaining.set(type.folder, left)
      if (left === 0) this.write(job, `Backed up ${counts[type.folder]} ${type.label}.`)
    }, network.signal)

    const ended = this.now()
    const seconds = Math.round((ended.getTime() - started.getTime()) / 1000)
    const totalPolicies = Object.values(counts).reduce((sum, count) => sum + count, 0)
    const metadata = {
      BackupDate: folderTimestamp(started),
      BackupFolder: backupFolder,
      StartTime: displayTime(started),
      EndTime: displayTime(ended),
      Duration: seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
      DurationSeconds: seconds,
      ItemCounts: { ...counts, TotalPolicies: totalPolicies },
      Status: failures > 0 ? (totalPolicies === 0 ? "Failed" : "CompletedWithWarnings") : "Success",
      RunbookVersion: "desktop",
      BackupFormat: "Individual policy files with Intune-compatible JSON",
      Source: "TenuVault Desktop",
      // Retention only ever removes backups recorded as this tenant's.
      TenantId: request.tenantId.toLowerCase(),
      Trigger: request.trigger ?? "manual",
      Scope: { Excluded: scope.excluded },
      Failures: failures,
      SkippedTypes: skippedTypes,
      FailedTypes: failedTypes,
      // Per item fingerprints (by type folder and Intune ID), so backups can be compared without reading every file.
      Items: sortKeys(items),
      ...(itemTimeoutWarnings.length ? { Warnings: itemTimeoutWarnings } : {}),
    }

    // Detach cancellation at the first manifest PUT, after cancellable token acquisition.
    // Retention reads cannot delay the manifest, and a saved backup must not burn a retry slot.
    network.signal.throwIfAborted()
    const commitDeadline = deadline + MANIFEST_COMMIT_GRACE_MS
    const commitController = new AbortController()
    const commitTimer = setTimeout(() => commitController.abort(jobDeadlineError()), Math.max(0, commitDeadline - Date.now()))
    commitTimer.unref?.()
    const commitNetwork = new NetworkCircuit(3 * concurrency, commitController.signal, commitDeadline)
    const commitStorage = new BlobWriter(fetchImpl, request.storageAccountName, storageToken, commitNetwork)
    try {
      await commitStorage.put(`${backupFolder}/metadata.json`, JSON.stringify(metadata, null, 2), network)
    } finally {
      clearTimeout(commitTimer)
    }

    // Only a complete backup may replace older ones: if policies could not be read (for
    // example after a permission change), keep every existing backup.
    let retentionWarnings = 0
    if (failures === 0 && (this.deps.retentionDays?.(job.tenantId) ?? 0) > 0) {
      const retentionNetwork = new NetworkCircuit(3 * concurrency, signal, deadline)
      const retentionStorage = new BlobWriter(fetchImpl, request.storageAccountName, storageToken, retentionNetwork)
      try {
        const result = await this.applyRetention(job, retentionStorage, backupFolder, coveredFolders(metadata), retentionNetwork.signal)
        if (result > 0) retentionWarnings++
      } catch (error) {
        retentionWarnings++
        if (signal.aborted || Date.now() >= deadline) {
          this.write(job, "Retention was interrupted; older backups are cleaned up on the next run")
        } else if (retentionNetwork.signal.aborted) {
          this.write(job, "Old backups were not removed because the network stopped responding. They will be reconsidered on the next run.")
        } else {
          this.write(job, `Could not remove old backups: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")}. They will be reconsidered on the next run.`)
        }
      }
    } else if (failures > 0) {
      this.write(job, "Older backups were kept because this backup is incomplete.")
    }

    job.failures = failures
    job.status = failures > 0 && totalPolicies === 0 ? "Failed" : "Completed"
    if (job.status === "Failed" && !outcome.answered && !outcome.otherFailures) job.unreachable = true
    const warnings = failures + retentionWarnings
    job.progressMessage =
      job.status === "Failed" ? "Backup failed: no policies could be saved" : warnings > 0 ? `Backup completed with ${warnings} warning${warnings === 1 ? "" : "s"}` : "Backup completed successfully"
    this.write(job, `Backup completed: ${totalPolicies} policies in ${metadata.Duration}.`)
  }

  /**
   * Deletes backup folders older than the retention period, never the one just written, and never the
   * newest backup that holds a type the current backup left out: a backup of fewer types must not
   * age out the only copy of the others. Only this tenant's backups are considered: another
   * tenant's backups and backups without readable metadata are never deleted. Backups from
   * versions that did not record the tenant count as this tenant's unless the container also
   * holds a backup recorded as another tenant's.
   */
  private async applyRetention(job: BackupJob, storage: BlobWriter, current: string, covered: Set<string>, signal: AbortSignal): Promise<number> {
    const days = this.deps.retentionDays?.(job.tenantId) ?? 0
    if (days <= 0) return 0
    const cutoff = this.now().getTime() - days * 24 * 60 * 60 * 1000
    const { prefixes } = await storage.list("backup-", "/")
    const backups = prefixes
      .map((prefix) => {
        const match = /^backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\/$/.exec(prefix)
        if (!match || prefix === `${current}/`) return null
        const [, y, mo, d, h, mi, se] = match.map(Number) as number[]
        return { prefix, time: Date.UTC(y!, mo! - 1, d!, h!, mi!, se!) }
      })
      .filter((backup) => backup !== null)
      .sort((a, b) => b.time - a.time)

    // Who each backup belongs to. Every metadata file is read first, because backups from versions
    // that did not record the tenant count as this tenant's only while no backup names another one.
    const tenant = job.tenantId.toLowerCase()
    const owners: Array<{ metadata: Record<string, unknown>; owner: "this" | "other" | "untagged" } | null> = Array.from({ length: backups.length }, () => null)
    const unreadable = new Set<number>()
    let unreadableReason = ""
    await pool(backups.map((backup, index) => ({ backup, index })), CONCURRENCY, async ({ backup, index }) => {
      let metadata: Record<string, unknown> | null
      try {
        metadata = await storage.readJson(`${backup.prefix}metadata.json`)
      } catch (error) {
        // Metadata that cannot be decrypted (a wrong or rotated key, damaged ciphertext) is
        // unreadable: never ours, and it must not stop the cleanup of the other backups.
        if (!(error instanceof FetchApplicationError)) throw error
        unreadable.add(index)
        unreadableReason ||= error.message
        return
      }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return // Missing or unreadable: never ours.
      const owner = typeof metadata.TenantId !== "string" ? "untagged" : metadata.TenantId.toLowerCase() === tenant ? "this" : "other"
      owners[index] = { metadata, owner }
    }, signal)
    // An unreadable backup may be another tenant's, so while one exists the container counts as
    // shared and untagged backups from earlier versions stay, as they did before.
    const shared = owners.some((entry) => entry?.owner === "other") || unreadable.size > 0

    // Types no newer backup holds yet, walking from the newest backup to the oldest.
    const uncovered = new Set(INTUNE_TYPES.map((type) => type.folder).filter((folder) => !covered.has(folder)))
    let removed = 0
    let kept = 0
    let unowned = 0
    let protectedKept = 0
    let partlyRemoved = 0
    for (const [index, backup] of backups.entries()) {
      const entry = owners[index]
      if (!entry || entry.owner === "other" || (entry.owner === "untagged" && shared)) {
        if (backup.time < cutoff && !unreadable.has(index)) unowned++
        continue
      }
      const metadata = entry.metadata
      let holdsUncovered = false
      // Only a backup that read everything may satisfy coverage: one that finished with
      // warnings may miss items in any folder it appears to hold. Backups recorded before
      // failures were counted carry no Failures value and count by their status alone.
      const status = String(metadata.Status ?? "").toLowerCase()
      const complete = (status === "success" || status === "succeeded") && (metadata.Failures === undefined || metadata.Failures === 0)
      for (const folder of complete ? coveredFolders(metadata) : []) {
        if (uncovered.delete(folder)) holdsUncovered = true
      }
      if (backup.time >= cutoff) continue
      if (holdsUncovered) {
        kept++
        continue
      }
      const { blobs } = await storage.list(backup.prefix)
      // The manifest goes first: a delete that stops at a protected file must not leave a
      // metadata.json that still reports the backup as complete. A protected manifest stops
      // before any policy file is touched.
      const manifest = `${backup.prefix}metadata.json`
      const marker = `${backup.prefix}${BACKUP_OWNER_FILE}`
      let deleted = 0
      try {
        // Keep ownership until every policy is gone, including when a protected policy stops deletion.
        for (const blob of [...blobs.filter((name) => name === manifest), ...blobs.filter((name) => name !== manifest && name !== marker), ...blobs.filter((name) => name === marker)]) {
          await storage.delete(blob)
          deleted++
        }
      } catch (error) {
        // Provider retention wins over local retention: the backup stays, and nothing here
        // tries to shorten a policy or clear a hold to make the delete succeed.
        if (!(error instanceof ProtectedBlobError)) throw error
        protectedKept++
        if (deleted > 0) partlyRemoved++
        continue
      }
      removed++
    }
    if (removed > 0) this.write(job, `Removed ${removed} backup${removed === 1 ? "" : "s"} older than ${days} days.`)
    if (kept > 0) this.write(job, `Kept ${kept} older backup${kept === 1 ? "" : "s"} because ${kept === 1 ? "it holds" : "they hold"} the newest copy of types this backup leaves out.`)
    if (protectedKept > 0) {
      this.write(job, `Kept ${protectedKept} older backup${protectedKept === 1 ? "" : "s"} protected by the storage account's immutability policy or legal hold.${partlyRemoved > 0 ? ` ${partlyRemoved} of them lost some files before the protected ones were reached, including ${partlyRemoved === 1 ? "its" : "their"} metadata, so ${partlyRemoved === 1 ? "it is" : "they are"} no longer offered as complete.` : ""}`)
    }
    if (unowned > 0) this.write(job, `Kept ${unowned} older backup${unowned === 1 ? "" : "s"} not recorded as this tenant's (another tenant's, without readable metadata, or from an earlier version in a container another tenant also uses).`)
    if (unreadable.size > 0) this.write(job, `Could not read the metadata of ${unreadable.size} older backup${unreadable.size === 1 ? "" : "s"}: ${unreadableReason.replace(/\.$/, "")}. ${unreadable.size === 1 ? "It was" : "They were"} left in place.`)
    return unreadable.size
  }

  private write(job: BackupJob, line: string): void {
    job.log.push(`[${this.now().toISOString().slice(11, 19)}] ${line}`)
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private prune(): void {
    while (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.values()].find((job) => job.status !== "Running")
      if (!oldest) break
      this.jobs.delete(oldest.id)
    }
  }
}

/**
 * Runs `task` for every entry with at most `limit` running at once. The first error stops new
 * tasks from starting and is thrown once the running ones have settled.
 */
async function pool<T>(entries: T[], limit: number, task: (entry: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0
  let failure: { error: unknown } | null = null
  const worker = async () => {
    while (!failure && !signal?.aborted && next < entries.length) {
      const entry = entries[next++]!
      try {
        await task(entry)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker))
  signal?.throwIfAborted()
  if (failure) throw (failure as { error: unknown }).error
}

/** Fingerprint of a snapshot without the fields Intune changes on every read or write. */
function snapshotHash(detail: Item): string {
  return createHash("sha256").update(JSON.stringify(comparableSnapshot(detail))).digest("base64").slice(0, 22)
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Checks that the signed-in admin can write backups to an Azure storage account:
 * creates the backup container if needed, then writes and deletes a test blob.
 * Throws with an actionable message (for example the missing role) when not.
 */
export async function verifyStorageAccess(
  fetchImpl: typeof fetch,
  storageAccountName: string,
  token: () => Promise<string>,
): Promise<void> {
  const writer = new BlobWriter(fetchImpl, storageAccountName, token)
  await writer.ensureContainer()
  const probe = `.tenuvault-write-test-${randomUUID()}`
  await writer.put(probe, "{}")
  // An immutable container accepts new blobs but keeps them; write access is still proven.
  await writer.delete(probe).catch((error: unknown) => {
    if (!(error instanceof ProtectedBlobError)) throw error
  })
}

function jobDeadlineError(): Error {
  return new Error("Backup timed out after the 30 minute job deadline. Retry the backup.")
}

/** backup-yyyy-MM-dd-HHmmss in UTC, the runbook's folder format. */
function folderTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

function displayTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19)
}

/** Same rules as Get-SafeFileName in the runbook. */
export function safeFileName(name: string): string {
  return (
    name
      // Control characters are intentionally replaced in safe filenames.
      // oxlint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || "unnamed"
  )
}

/** Policies can share a display name; keep both instead of overwriting one. */
function uniqueName(name: string, id: string, used: Set<string>): string {
  const key = name.toLowerCase()
  if (!used.has(key)) {
    used.add(key)
    return name
  }
  // Ids can share their first characters (enrollment defaults all start with the same GUID),
  // so fall back to the whole id, then a counter, until the name is free.
  const candidates = [`${name} (${id.slice(0, 8)})`, `${name} (${safeFileName(id)})`]
  let unique = candidates.find((candidate) => !used.has(candidate.toLowerCase()))
  for (let n = 2; !unique; n++) {
    if (!used.has(`${name} (${n})`.toLowerCase())) unique = `${name} (${n})`
  }
  used.add(unique.toLowerCase())
  return unique
}

