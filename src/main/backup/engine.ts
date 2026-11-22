import { isBackupName, parseBackupName } from "../../shared/intune/backup-names"
import { ownedRemnant, REMNANT_RECOVERY_DAYS, completeHalf, matchingCompanions } from "../../shared/backup-companion"
import { isLargeBackup, LARGE_BACKUP_CONTAINER } from "../../shared/backup-storage"
import { captureLarge } from "./large"
import { LARGE_JOB_MS, LARGE_TYPE_MS, LARGE_TYPE_REQUESTS, type LargeIndexes } from "../../shared/large-backup"
import { backupTypeUse } from "../../shared/services/backup-use"
import { auditUserFromToken } from "../api/audit-sink"
import type { AuditUser } from "~/lib/audit/types"
export { assertStorageAccountName } from "../../shared/storage-account"
export { ProtectedBlobError, isImmutabilityRefusal } from "./request"
import { createHash, randomUUID } from "node:crypto"
import { BACKUP_CANCELLED_MESSAGE, BACKUP_OWNER_FILE } from "../../shared/constants"
import { resolveBackupOwnership, type OwnershipFile } from "../../shared/backup-ownership"
import { BlobWriter } from "./blob-writer"
import { GraphSession, type GraphItem, type ReadControl } from "./graph-session"
import { ReadBudgetError, typeReadBudget, withReadBudget } from "./read-budget"
import { GRAPH, BlobClaimError, GraphError, GraphUnansweredError, InventoryDamagedError, ProtectedBlobError, RequestTimeoutError, StorageError, LargeStorageError, TokenError, isUnreachable, withAbort } from "./request"
import { RetryDelayError } from "../graph-retry"
import { isLocalAccount } from "../storage/blob-emulator"
import { FetchApplicationError } from "../api/network-error"
import { INTUNE_TYPES, itemName, typeForFolder, type GraphVersion, type IntuneType, type Item } from "../../shared/intune/registry"
import { readEntries, ScopeDiscoveryError, OrganizationResolutionError, organizationReader, graphVersion, listPath, listSnapshot, readObject, withMaskedSecrets, type GraphReader } from "../../shared/intune/read"
import { comparableSnapshot } from "../../shared/intune/compare"
import type { BackupItems } from "../../shared/intune/backup-changes"
import { EVERYTHING, includedTypes, normalizeScope, restorableFolders, type BackupScope } from "../../shared/intune/scope"
import { canBackUp, DEFAULT_SELECTION, describeRequirement, disabledFolders, MODULES, moduleForFolder, SERVICES_PAGE, signedInOnly, type ServiceSelection, type SignInMode } from "../../shared/services/modules"
import { grantedPermissions } from "../../shared/services/token"
import { MAX_ITEM_ERRORS, type BackupNotice, type BackupResults, type BackupTypeResult } from "../../shared/backup-results"
import { classifyAnswer, coverageOf, manifestOutcomes, nothingRead, nothingReadReason, signInRefused, skipReason, type Coverage, type RunOutcomes, type SkipCause, type TypeOutcome } from "../../shared/backup-outcomes"

/**
 * Runs Intune backups from the desktop app as the signed-in admin.
 *
 * Output matches the TenuVault Azure Automation runbook (folder layout and metadata.json), so the
 * shared restore, drift detection, download and history features work the same for
 * backups made by the app and by the Azure Automation runbook. The destination is the
 * tenant's storage account: either the customer's Azure storage account or the
 * encrypted store on this device (served through the fetch bridge).
 */

export type BackupStatus = "Queued" | "Running" | "Completed" | "Failed" | "Cancelled"

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
  /** Policies saved by a run that reached its manifest. */
  totalPolicies?: number
  /** Registry folders whose list could not be read, for notifications. */
  failedTypes?: string[]
  /** Whose tokens the run reads and writes with: the signed-in admin's, or the tenant's Backup Reader. */
  authMode?: BackupAuthMode
  /** Failed because the Backup Reader could not be used; retrying or signing in cannot fix that. */
  credentialError?: true
  /** Set when the job failed because Microsoft or the storage account could not be reached, including timeouts. */
  unreachable?: boolean
  /** A manifest PUT was dispatched, but the final response did not confirm it. */
  commitUnconfirmed?: boolean
  log: string[]
  /** Per type results and notices for progress views, filled as the run goes; absent until the run starts. */
  results?: BackupResults
  /** Whether every selected type was read. Set with the outcomes; the job's status does not follow it. */
  coverage?: Coverage
  /** How every selected type ended, once the run has ended after choosing what to read. */
  outcomes?: RunOutcomes
}

export type BackupTrigger = "manual" | "scheduled" | "tray"

/**
 * - delegated: the signed-in admin's tokens, so MFA and Conditional Access apply.
 * - app-only: the tenant's read-only Backup Reader app registration, for scheduled backups only.
 */
export type BackupAuthMode = "delegated" | "app-only"

/** The tokens one backup run uses for Microsoft Graph and Azure Storage, chosen once when it starts. */
export interface RunTokens {
  mode: BackupAuthMode
  registrationId?: string
  /** The Backup Reader certificate a run captured, so a renewed reader is never credited with it. */
  readerCertificate?: string
  auditUser?: AuditUser
  /** `fresh`: a token Microsoft issues now instead of a cached one, which proves that the sign-in still works. */
  graph: (options?: { fresh?: boolean }) => Promise<string>
  storage: () => Promise<string>
  /**
   * Type folders these tokens have no permission for by design; the run leaves them out and records
   * why. Asked once when the run starts: a Backup Reader answers from the roles in its token.
   */
  excludedTypes?: () => Promise<string[]>
}

export interface BackupRequest {
  scheduleFrequency?: "daily" | "weekly"
  tenantId: string
  clientId: string
  storageAccountName: string
  /** What to back up; everything when left out. */
  scope?: BackupScope
  trigger?: BackupTrigger
  /** A scheduled backup's slot, as an ISO timestamp. Retries of one slot share it. */
  slot?: string
}

export interface BackupEngineDeps {
  /** The main-process fetch (bridged, so local storage accounts are served from disk). */
  fetch: typeof fetch
  /** `fresh`: a token Microsoft issues now instead of a cached one. */
  getToken: (tenantId: string, clientId: string, scope: string, fresh?: boolean) => Promise<string>
  /**
   * The tenant's Backup Reader tokens, or null when it has none. Asked only for scheduled backups:
   * manual and tray backups, where an admin is present, always use the admin's own sign-in.
   */
  unattendedTokens?: (request: BackupRequest) => RunTokens | null
  /**
   * The services and opt-in areas turned on for the tenant (see shared/services/modules). Types of a
   * service or area that is off are never backed up, whatever the scope says. When left out, the
   * services that are on by default.
   */
  services?: (tenantId: string) => ServiceSelection
  /** Backups older than this many days are deleted after each backup; 0 keeps everything. */
  retentionDays?: (tenantId: string) => number
  now?: () => Date
  /** Items read at the same time. Graph throttling (429) pauses every reader. */
  concurrency?: number
  /**
   * Called once when a request got a job of its own, as it is queued with the tokens it captured. A
   * request that joined a running job, or was refused because of one, started nothing and is not announced.
   */
  onQueued?: (job: BackupJob, request: BackupRequest) => void
  /** Called once before the job reads Graph or starts writing its assigned folder. */
  onStarted?: (job: BackupJob, request: BackupRequest, tokens: RunTokens) => void
  /** Called once when a job has ended, with the request that started it. */
  onFinished?: (job: BackupJob, request: BackupRequest, tokens?: RunTokens) => void
  /**
   * Called once for a run that got as far as choosing what to read, before onFinished, with how each
   * selected type ended. The same outcomes are in the backup's manifest when the run wrote one.
   */
  onOutcomes?: (outcomes: RunOutcomes, request: BackupRequest) => void
  /** Permission names of a Graph token the run used, for health only; never changes its outcomes. */
  onToken?: (runId: string, granted: ReturnType<typeof grantedPermissions>) => void
}

/** A Graph path in the primary version or an explicitly declared sub-resource version. Paging is validated by GraphSession.list. */
function graphUrl(version: GraphVersion, path: string, additional: readonly GraphVersion[] = []): string {
  if (!URL.canParse(path)) return `${GRAPH}/${version}/${path}`
  const link = new URL(path)
  if (link.origin !== GRAPH || ![version, ...additional].some(allowed => link.pathname.startsWith(`/${allowed}/`))) throw new Error("Invalid Graph continuation link")
  return path
}

/** Types covered by the original DeviceManagementConfiguration permission. */
const ORIGINAL_FOLDERS = new Set(["DeviceConfigurations", "CompliancePolicies", "ConfigurationPolicies", "GroupPolicyConfigurations"])

const MAX_JOBS = 25
const CONCURRENCY = 8
export const JOB_DEADLINE_MS = 30 * 60_000
export const MANIFEST_COMMIT_GRACE_MS = 2 * 60_000
/** How long a run that stopped early may spend recording its folder as a failed backup. */
export const FAILED_MANIFEST_GRACE_MS = 30_000

/** Another writer already claimed this backup folder, so this backup wrote nothing. */
export class BackupFolderTakenError extends StorageError {
  constructor(readonly folder: string) {
    super(`Backup folder ${folder} is already in use by another backup for this tenant and storage. Nothing from this backup was written. Wait for the other backup to finish, then try again.`)
    this.name = "BackupFolderTakenError"
  }
}
class BackupCancelledError extends Error {}

/**
 * Set by a run once it owns its backup folder: the manifest it would record if it stopped now.
 * `committing` is set when the real manifest write starts, after which nothing else may write one.
 */
interface StoppedRun {
  manifest?: (status: "Failed" | "Cancelled", error: string, outcomes: RunOutcomes) => Record<string, unknown>
  committing: boolean
  /** The service whose failures stopped the run, if one did. */
  stoppedBy?: () => NetworkService | null
  /** Set once the run has chosen what to read: how each selected type ended if the run stopped now. */
  outcomes?: (status: "Failed" | "Cancelled") => RunOutcomes
}

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

/** Records a failure that is not a connection failure when it is caught, before an abort can replace it. */
function recordFailure(outcome: RunOutcome, error: unknown): void {
  if (!isUnreachable(error)) outcome.otherFailures++
}

/**
 * The job's fetch, recording what each Graph or Azure Storage request ended with as soon as it
 * ends, before status handling, retries, the circuit or a timeout can replace it with another
 * error: any HTTP response, or a failure other than a connection failure. Responses for a local
 * storage account (`localHost`) come from this device, not the network. A request that ends
 * because the job aborted it says nothing new: the abort reason is classified where it is raised.
 */
function answeredFetch(fetchImpl: typeof fetch, outcome: RunOutcome, localHost: string | null): typeof fetch {
  return async (input, init) => {
    let response: Response
    try {
      response = await fetchImpl(input, init)
    } catch (error) {
      if (!init?.signal?.aborted) recordFailure(outcome, error)
      throw error
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    // A network error response (status 0) is not an answer.
    if (response.type !== "error" && response.status !== 0 && new URL(url).hostname !== localHost) outcome.answered = true
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
  /** By scope: the storage, and each service read from Microsoft Graph, so one service's answers never count for another. */
  private readonly consecutiveAuthFailures = new Map<string, { status: number; count: number }>()
  /** The service whose failures opened the circuit. */
  stoppedBy: NetworkService | null = null

  /** `threshold`: the consecutive requests without an answer that stop the job. */
  constructor(readonly threshold: number, signal?: AbortSignal, private readonly deadline?: number) {
    this.combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
  }

  get signal(): AbortSignal {
    if (this.deadline !== undefined && Date.now() >= this.deadline) this.controller.abort(jobDeadlineError())
    return this.combined
  }

  /** `scope` names whose auth failures the success ends: the network service itself, or one service read from it. */
  succeeded(service: NetworkService, scope: string = service): void {
    this.signal.throwIfAborted()
    this.consecutiveFailures[service] = 0
    this.consecutiveAuthFailures.delete(scope)
  }

  /** `cause` is the failure that trips the circuit, kept so the job can tell an unreachable service apart. */
  failed(service: NetworkService, cause?: unknown): void {
    this.signal.throwIfAborted()
    if (++this.consecutiveFailures[service] < this.threshold) return
    this.stoppedBy = service
    this.controller.abort(new Error(`Backup stopped: ${service} did not respond for ${this.consecutiveFailures[service]} consecutive requests. Earlier policies in this run were saved; the backup is incomplete.`, { cause }))
    this.signal.throwIfAborted()
  }

  /** Counts consecutive responses with the same 401 or 403 status within a scope; a success or a different status starts over. */
  authFailed(service: NetworkService, status: number, message: string, scope: string = service): void {
    this.signal.throwIfAborted()
    if (status !== 401 && status !== 403) return
    const previous = this.consecutiveAuthFailures.get(scope)
    const count = previous?.status === status ? previous.count + 1 : 1
    this.consecutiveAuthFailures.set(scope, { status, count })
    if (count < CONSECUTIVE_AUTH_FAILURE_LIMIT) return
    this.stoppedBy = service
    this.controller.abort(new Error(message))
    this.signal.throwIfAborted()
  }
}

async function tokenOrStop<T>(get: () => Promise<T>, outcome: RunOutcome): Promise<T> {
  try {
    return await get()
  } catch (error) {
    recordFailure(outcome, error)
    // Keep the cause: it tells a sign-in Microsoft refused from one that could not reach Microsoft.
    throw new TokenError(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

export class BackupEngine {
  private readonly jobs = new Map<string, BackupJob>()
  private readonly running = new Map<string, { job: BackupJob; key: string; mode: BackupAuthMode }>()
  private readonly executions = new Map<string, { controller: AbortController; done: Promise<BackupJob> }>()
  /** Existing capture runs FIFO, one tenant at a time. Streaming runs yield this turn before their large phase. */
  private queueTail: Promise<void> = Promise.resolve()
  /** Jobs started but not finished yet, the running one plus every queued one. */
  private pending = 0

  constructor(private readonly deps: BackupEngineDeps) {}

  /** Whether the selected scope includes an enabled streaming type. */
  hasLargeTypes(tenantId: string, scope: BackupScope = EVERYTHING): boolean {
    const off = new Set(disabledFolders(this.deps.services?.(tenantId) ?? DEFAULT_SELECTION))
    return includedTypes(normalizeScope(scope)).some(type => type.volume === "large" && !off.has(type.folder))
  }

  get(jobId: string): BackupJob | undefined {
    return this.jobs.get(jobId)
  }

  /** The run ids of the tenant's unfinished jobs, whatever started them. */
  liveRuns(tenantId: string): string[] {
    const active = this.running.get(tenantId.toLowerCase())
    return active ? [active.job.id] : []
  }

  /** Whether a backup to storage on this device is queued, running or still writing its manifest. */
  hasLocalWork(): boolean {
    return [...this.executions.keys()].some((id) => isLocalAccount(this.jobs.get(id)?.storageAccountName))
  }

  /** Waits for the same bounded execution used by manual and scheduled jobs. */
  waitForJob(job: BackupJob): Promise<BackupJob> {
    return this.executions.get(job.id)?.done ?? Promise.resolve(job)
  }

  cancel(jobId: string): BackupJob | undefined {
    const job = this.jobs.get(jobId)
    if (job?.status === "Running" || job?.status === "Queued") this.executions.get(jobId)?.controller.abort(new BackupCancelledError(`${BACKUP_CANCELLED_MESSAGE} This run is never offered as a complete backup.`))
    return job
  }

  /**
   * Starts a backup in the background. One backup per tenant runs at a time. A request joins the
   * running backup only when tenant, storage account and scope match, and never a Backup Reader run
   * with the admin's sign-in: a manual backup is never served by the Backup Reader. A scheduled
   * request may join a run with the admin's sign-in, which reads at least as much. Any other request
   * gets a failed job of its own, so a scheduled full backup can never ride on a narrower manual one.
   */
  start(request: BackupRequest): BackupJob {
    const tenantKey = request.tenantId.toLowerCase()
    const tokens = this.runTokens(request)
    const key = `${request.storageAccountName.toLowerCase()}\n${normalizeScope(request.scope ?? EVERYTHING).excluded.join(",")}`
    const active = this.running.get(tenantKey)
    if (active) {
      const joinable = active.mode === "delegated" || tokens.mode === "app-only"
      if (active.key === key && joinable) return active.job
      const conflict: BackupJob = {
        id: `desktop-${randomUUID()}`,
        tenantId: request.tenantId,
        storageAccountName: request.storageAccountName,
        status: "Failed",
        progress: 100,
        progressMessage: "Backup failed",
        startTime: this.now().toISOString(),
        endTime: this.now().toISOString(),
        exception: active.key === key
          ? "A scheduled backup with the Backup Reader is running for this tenant. Wait for it to finish, then try again."
          : "A different backup is already running for this tenant. Wait for it to finish, then try again.",
        log: [],
      }
      this.write(conflict, `Backup failed: ${conflict.exception}`)
      this.jobs.set(conflict.id, conflict)
      this.prune()
      this.finished(conflict, request)
      return conflict
    }

    const controller = new AbortController()
    const queued = this.pending > 0
    this.pending++
    const job: BackupJob = {
      id: `desktop-${randomUUID()}`,
      tenantId: request.tenantId,
      storageAccountName: request.storageAccountName,
      status: queued ? "Queued" : "Running",
      progress: queued ? 0 : 5,
      progressMessage: queued ? "Waiting for another backup to finish..." : "Starting backup...",
      startTime: this.now().toISOString(),
      authMode: tokens.mode,
      log: [],
    }
    this.jobs.set(job.id, job)
    this.running.set(tenantKey, { job, key, mode: tokens.mode })
    this.prune()
    if (queued) this.write(job, "Queued behind another tenant's backup; backups run one at a time.")
    // A failing listener must not keep the job from running.
    try {
      this.deps.onQueued?.(job, request)
    } catch (error) {
      console.warn("[backup] Could not announce the start of a backup:", error)
    }

    let releaseTurn: () => void = () => {}
    const turnDone = new Promise<void>(resolve => { releaseTurn = resolve })
    const outcome: RunOutcome = { saved: 0, answered: false, otherFailures: 0 }
    const stopped: StoppedRun = { committing: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    let legacyTimer: ReturnType<typeof setTimeout> | undefined
    // The deadline and the start time count from when the run actually starts, not from when it was queued.
    const execute = async () => {
      if (controller.signal.aborted) throw controller.signal.reason
      job.status = "Running"
      job.progress = 5
      job.progressMessage = "Starting backup..."
      job.startTime = this.now().toISOString()
      const selection = this.deps.services?.(request.tenantId) ?? DEFAULT_SELECTION
      const off = new Set(disabledFolders(selection))
      const large = includedTypes(normalizeScope(request.scope ?? EVERYTHING)).some(type => type.volume === "large" && !off.has(type.folder))
      const duration = large ? LARGE_JOB_MS : JOB_DEADLINE_MS
      const deadline = Date.now() + duration
      timer = setTimeout(() => controller.abort(jobDeadlineError(duration)), duration)
      timer.unref?.()
      // The existing phase keeps its original deadline even in a mixed backup.
      if (large) { legacyTimer = setTimeout(() => controller.abort(jobDeadlineError()), JOB_DEADLINE_MS); legacyTimer.unref?.() }
      await this.run(job, request, tokens, controller.signal, deadline, outcome, stopped, () => { if (legacyTimer) clearTimeout(legacyTimer); releaseTurn() })
    }
    // A queued backup cancelled before its turn settles at once instead of holding its tenant
    // until every backup ahead of it has finished. Its place in the chain still waits for those
    // backups (see queueTail below), so the next queued backup cannot jump ahead of them.
    const previous = this.queueTail
    const waitForTurn = () => new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason)
      if (controller.signal.aborted) return onAbort()
      controller.signal.addEventListener("abort", onAbort, { once: true })
      void previous.then(() => {
        controller.signal.removeEventListener("abort", onAbort)
        resolve()
      })
    })
    // An unqueued backup begins synchronously inside start(), as it did before the queue existed.
    const done = (queued ? waitForTurn().then(execute) : execute())
      .catch(async (error: unknown) => {
        job.status = error instanceof BackupCancelledError ? "Cancelled" : "Failed"
        job.exception = error instanceof Error ? error.message : String(error)
        // Classified before the failed manifest is written, which goes around the run's fetch and cannot change it.
        if (job.status === "Failed" && isUnreachable(error) && !outcome.saved && !outcome.answered && !outcome.otherFailures) job.unreachable = true
        if (job.status === "Failed" && tokens.mode === "app-only" && causedBy(error, "BackupReaderError")) job.credentialError = true
        job.progressMessage = job.status === "Cancelled" ? "Backup cancelled" : "Backup failed"
        this.write(job, `${job.progressMessage}: ${job.exception}`)
        // A run that committed its manifest before it failed keeps the outcomes that manifest records.
        if (stopped.outcomes && !job.outcomes) this.conclude(job, stopped.outcomes(job.status))
        const outcomes = job.outcomes
        // A storage that stopped answering or refused access would not take the manifest either.
        if (!stopped.manifest || !outcomes || stopped.committing || stopped.stoppedBy?.() === "backup storage") return
        // The run is over, so a backup started while the manifest is written gets its own job instead of joining this one.
        if (this.running.get(tenantKey)?.job === job) this.running.delete(tenantKey)
        await this.recordStopped(job, request, tokens, stopped.manifest(job.status, job.exception, outcomes))
      })
      .finally(() => {
        releaseTurn()
        if (legacyTimer) clearTimeout(legacyTimer)
        if (timer) clearTimeout(timer)
        controller.abort(new Error("Backup finished"))
        job.progress = 100
        job.endTime = this.now().toISOString()
        if (this.running.get(tenantKey)?.job === job) this.running.delete(tenantKey)
        this.executions.delete(job.id)
        this.pending--
        this.finished(job, request, tokens)
      })
      .then(() => job)
    // Existing runs release their turn only when fully settled. Streaming runs release before
    // their large phase; each page then waits for the tenants that have queued a turn.
    this.queueTail = Promise.all([previous, turnDone]).then(() => undefined)
    this.executions.set(job.id, { controller, done })
    return job
  }

  /** Backup Reader tokens for a scheduled backup of a tenant that has one, otherwise the admin's. */
  private runTokens(request: BackupRequest): RunTokens {
    const unattended = request.trigger === "scheduled" ? this.deps.unattendedTokens?.(request) : null
    if (unattended) return unattended
    return {
      mode: "delegated",
      graph: (options) => (options?.fresh ? this.deps.getToken(request.tenantId, request.clientId, `${GRAPH}/.default`, true) : this.deps.getToken(request.tenantId, request.clientId, `${GRAPH}/.default`)),
      storage: () => this.deps.getToken(request.tenantId, request.clientId, "https://storage.azure.com/.default"),
    }
  }

  /** A failing listener must not change how the job ended. */
  private finished(job: BackupJob, request: BackupRequest, tokens?: RunTokens): void {
    try {
      if (job.outcomes) this.deps.onOutcomes?.(job.outcomes, request)
    } catch (error) {
      console.warn("[backup] Could not hand over the outcomes of a backup:", error)
    }
    try {
      this.deps.onFinished?.(job, request, tokens)
    } catch (error) {
      console.warn("[backup] Could not record the end of a backup:", error)
    }
  }

  /** Puts the run's outcomes and its coverage on the job, where progress views and the listeners read them. */
  private conclude(job: BackupJob, outcomes: RunOutcomes): void {
    job.outcomes = outcomes
    job.coverage = outcomes.coverage
    if (job.results) job.results.coverage = outcomes.coverage
  }

  private async run(job: BackupJob, request: BackupRequest, tokens: RunTokens, signal: AbortSignal, deadline: number, outcome: RunOutcome, stopped: StoppedRun, releaseTurn: () => void): Promise<void> {
    const started = this.now()
    const local = isLocalAccount(request.storageAccountName)
    const fetchImpl = answeredFetch(this.deps.fetch, outcome, local ? `${request.storageAccountName.toLowerCase()}.blob.core.windows.net` : null)
    const streaming = this.hasLargeTypes(request.tenantId, request.scope ?? EVERYTHING)
    let backupFolder = `backup-${folderTimestamp(started)}`
    job.backupFolder = backupFolder
    try {
      this.deps.onStarted?.(job, request, tokens)
    } catch {
      console.warn("[audit] Backup audit checkpoint could not be saved")
      this.write(job, "The audit checkpoint could not be saved. Terminal audit recording will still be attempted.", "warning")
    }
    this.write(job, `Backing up tenant ${request.tenantId} to ${local ? "this device (encrypted)" : `storage account ${request.storageAccountName}`}.`)
    if (!streaming) this.write(job, `Backup folder: ${backupFolder}`)
    if (tokens.mode === "app-only") this.write(job, "Reading as the tenant's Backup Reader (app-only, read-only).")

    const observeToken = (granted: ReturnType<typeof grantedPermissions>) => {
      try {
        this.deps.onToken?.(job.id, granted)
      } catch (error) {
        console.warn("[backup] Could not hand over token permissions:", error)
      }
    }
    let lastToken: string | undefined
    const graphToken = async (options?: { fresh: true }) => {
      const token = await tokenOrStop(() => (options ? tokens.graph(options) : tokens.graph()), outcome)
      tokens.auditUser ??= auditUserFromToken(token, request.tenantId)
      if (token !== lastToken) {
        lastToken = token
        observeToken(grantedPermissions(token))
      }
      return token
    }
    const storageToken = local ? async () => "" : () => tokenOrStop(tokens.storage, outcome)

    const concurrency = this.deps.concurrency ?? CONCURRENCY
    const network = new NetworkCircuit(3 * concurrency, signal, deadline)
    const storage = new BlobWriter(fetchImpl, request.storageAccountName, storageToken, network)
    // The Backup Reader cannot create containers; New-TenuVaultStorage.ps1 creates the backup container for it.
    if (local || tokens.mode === "delegated") await storage.ensureContainer()

    const scope = normalizeScope(request.scope ?? EVERYTHING)
    // The answer needs the reader's token, so a reader Microsoft refuses stops the run here as it would at the first read.
    const readerExcluded = new Set(tokens.excludedTypes ? await tokenOrStop(tokens.excludedTypes, outcome) : [])
    const selection = this.deps.services?.(request.tenantId) ?? DEFAULT_SELECTION
    const moduleOff = new Set(disabledFolders(selection))
    const notReadable = includedTypes(scope).filter((type) => readerExcluded.has(type.folder) && !moduleOff.has(type.folder)).map((type) => type.folder)
    // A service with a token pre-check that is on but whose read permission the token lacks is left out up front with
    // the missing permission named, instead of failing on a refused read. Intune keeps its long-standing per-type handling.
    const granted = await moduleGrants(tokens, includedTypes(scope).some((type) => !moduleOff.has(type.folder) && moduleForFolder(type.folder)?.module.precheck))
    if (granted) observeToken(granted)
    const signIn: SignInMode = tokens.mode === "app-only" ? "application" : "delegated"
    // A type only a signed-in admin can read is left out of a Backup Reader run whatever its token says: no permission changes that.
    const adminOnly = (type: IntuneType) => tokens.mode === "app-only" && signedInOnly(type.folder)
    const applicationOnly = (type: IntuneType) => signIn === "delegated" && type.backupMode === "application"
    const unpermitted = includedTypes(scope).filter((type) => !moduleOff.has(type.folder) && !readerExcluded.has(type.folder) && (adminOnly(type) || applicationOnly(type) || (moduleForFolder(type.folder)?.module.precheck && granted && !canBackUp(type.folder, granted))))
    const types = includedTypes(scope).filter((type) => !readerExcluded.has(type.folder) && !moduleOff.has(type.folder) && !unpermitted.includes(type))
    const largeTypes = types.filter(type => type.volume === "large")
    const mixed = largeTypes.length > 0 && types.some(type => type.volume !== "large")
    const ordinaryFolder = backupFolder
    const largeFolder = `backup-large-${folderTimestamp(started)}`
    if (largeTypes.length && !mixed) backupFolder = largeFolder
    job.backupFolder = backupFolder
    // Large storage has its own circuit: a refusal there cannot poison ordinary writes.
    const largeNetwork = new NetworkCircuit(3 * concurrency, signal, deadline)
    const largeStorage = new BlobWriter(fetchImpl, request.storageAccountName, storageToken, largeNetwork)
    if (streaming) this.write(job, `Backup folder: ${backupFolder}`)
    // Results list every type this run covers or leaves out for a permission, in registry order.
    const results: BackupResults = {
      types: includedTypes(scope)
        .filter((type) => !moduleOff.has(type.folder))
        .map((type): BackupTypeResult => ({ folder: type.folder, label: type.label, area: type.area, ...(type.inventory ? { inventory: true } : {}), state: "reading", saved: 0, failed: 0 })),
      notices: [],
    }
    job.results = results
    const result = (folder: string) => results.types.find((entry) => entry.folder === folder)!
    // A failure takes precedence over a refusal, including one recorded after an optional sub-read.
    const settled = new Map<string, TypeOutcome>()
    const settle = (folder: string, ending: { outcome: "notConfigured" } | { outcome: "skipped"; cause: SkipCause; reason: string; reader?: true; status?: number; code?: string } | { outcome: "failed"; error: string; status?: number; code?: string }) => {
      if (!settled.has(folder) || (ending.outcome === "failed" && settled.get(folder)?.outcome !== "failed")) settled.set(folder, { folder, service: moduleForFolder(folder)?.module.id ?? null, ...ending, ...(ending.outcome === "failed" ? { saved: 0 } : {}) } as TypeOutcome)
    }
    // Every selected type has an outcome at any moment: the settled one, or what its result says so far.
    const typesNow = (stopped: boolean) =>
      results.types.map((entry): TypeOutcome => {
        const known = settled.get(entry.folder)
        const base = { folder: entry.folder, service: moduleForFolder(entry.folder)?.module.id ?? null }
        // A failed object takes precedence over an optional sub-read refusal on another object.
        if (entry.failed > 0) return { ...base, outcome: "failed", error: `${entry.failed} of ${entry.found ?? entry.saved + entry.failed} could not be saved. ${entry.errors?.[0] ?? ""}`.trim(), saved: entry.saved }
        // Objects saved before the type ended stay in the backup, so the outcome names how many.
        if (known?.outcome === "failed") return { ...known, saved: entry.saved }
        if (known?.outcome === "skipped") return entry.saved ? { ...known, saved: entry.saved } : known
        if (known) return known
        if (entry.state === "reading" && stopped) return { ...base, outcome: "failed", error: "The backup stopped before this type was read in full.", saved: entry.saved }
        return { ...base, outcome: "saved", saved: entry.saved }
      })
    const outcomesNow = (status: string, ended: Date, stopped: boolean): RunOutcomes => {
      const typeOutcomes = typesNow(stopped)
      return {
        runId: job.id,
        tenantId: request.tenantId.toLowerCase(),
        authMode: tokens.mode,
        trigger: request.trigger ?? "manual",
        startedAt: started.toISOString(),
        endedAt: ended.toISOString(),
        status,
        coverage: coverageOf(typeOutcomes),
        types: typeOutcomes,
      }
    }
    stopped.outcomes = (status) => outcomesNow(status, this.now(), true)
    for (const type of unpermitted) {
      const entry = moduleForFolder(type.folder)!
      const needed = entry.part.backup[granted?.kind ?? signIn]
      const reason = applicationOnly(type) ? skipReason("appOnly", { service: entry.module.label, mode: tokens.mode, settingsPage: SERVICES_PAGE }) : needed === "unsupported"
        // No permission lets this sign-in read the type, so there is nothing to add.
        ? skipReason("signedIn", { service: entry.module.label, mode: tokens.mode, settingsPage: SERVICES_PAGE })
        : `The ${tokens.mode === "app-only" ? "Backup Reader" : "TenuVault app registration"} has no ${describeRequirement(needed, granted?.permissions)} permission for ${entry.module.label}. ${SERVICES_PAGE} in Settings shows how to add it.`
      Object.assign(result(type.folder), { state: "skipped", reason })
      settle(type.folder, { outcome: "skipped", cause: applicationOnly(type) ? "appOnly" : needed === "unsupported" ? "signedIn" : "permission", reason })
      this.write(job, `Leaving out ${type.label}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`)
    }
    // A service that is normally on but was turned off for the tenant is named, so a smaller or empty backup explains itself.
    for (const module of MODULES) {
      if (!module.defaultOn || selection.services.includes(module.id) || !includedTypes(scope).some((type) => moduleForFolder(type.folder)?.module === module)) continue
      this.write(job, `${module.label} is turned off for this tenant, so its types are not backed up. ${SERVICES_PAGE} in Settings turns it on again.`, "warning")
    }
    if (scope.excluded.length) {
      this.write(job, `Leaving out ${scope.excluded.length} of ${INTUNE_TYPES.length} types: ${scope.excluded.join(", ")}.`)
      // The notice names the types as people read them; the log keeps the folder names.
      results.notices.push({ level: "info", message: `Left out by the backup scope: ${scope.excluded.map((folder) => typeForFolder(folder)?.label ?? folder).join(", ")}.` })
    }
    for (const folder of notReadable) {
      const cause: SkipCause = signedInOnly(folder) ? "signedIn" : "permission"
      const reason = cause === "signedIn" ? skipReason("signedIn", { service: "", mode: tokens.mode, settingsPage: SERVICES_PAGE }) : "The Backup Reader has no permission for this type. Manual backups include it."
      Object.assign(result(folder), { state: "skipped", reason })
      settle(folder, { outcome: "skipped", cause, reason, reader: true })
    }
    if (notReadable.length) this.write(job, `Leaving out ${notReadable.length} type${notReadable.length === 1 ? "" : "s"} the Backup Reader has no permission for: ${notReadable.join(", ")}. Manual backups include them.`)
    // Only a Backup Reader run keeps a value Microsoft refuses to decrypt masked; with the admin's sign-in a refused read fails the object as before.
    const keepMasked = tokens.mode === "app-only" ? (error: unknown) => error instanceof GraphError && error.status === 403 : undefined
    const maskedItems: Array<{ Folder: string; Id: string; Name: string }> = []
    // Each service reads through its own session, so a pause or a refusal of one never holds up another.
    const sessions = new Map<string, GraphSession>()
    const serviceOf = (type: IntuneType) => {
      const module = moduleForFolder(type.folder)?.module
      const id = module?.id ?? "intune"
      let session = sessions.get(id)
      if (!session) sessions.set(id, (session = new GraphSession(fetchImpl, graphToken, network, { service: id, isolated: module?.isolated })))
      return { id, module, isolated: module?.isolated === true, session }
    }
    const typeBudgets = new Map<string, ReturnType<typeof typeReadBudget>>()
    const readerOf = (type: IntuneType, control: ReadControl = {}): GraphReader => {
      const { session } = serviceOf(type)
      const version = graphVersion(type)
      let budget = typeBudgets.get(type.folder)
      if (!budget && type.readBudget) {
        budget = typeReadBudget(network.signal, type.readBudget)
        typeBudgets.set(type.folder, budget)
      }
      const read = <T>(operation: (control: ReadControl) => Promise<T>) => budget ? budget(operation) : operation(control)
      return organizationReader({
        get: (path: string) => read(control => session.get<Item>(graphUrl(version, path, type.additionalReadVersions), type.headers, control)),
        list: (path: string) => read(control => session.list(graphUrl(version, path, type.additionalReadVersions), { ...control, headers: type.headers, ...(path === listPath(type) ? { filter: type.filter } : {}) }) as Promise<Item[]>),
      })
    }

    // List everything first so progress reflects the real amount of work.
    job.progressMessage = types.some((type) => moduleForFolder(type.folder)?.module.id === "intune") ? "Reading Intune configuration..." : "Reading configuration..."
    const counts: Record<string, number> = Object.fromEntries(types.map((type) => [type.folder, 0]))
    const lists: Array<{ type: IntuneType; items: GraphItem[] } | null> = Array.from({ length: types.length }, () => null)
    // Types left out for a missing permission count as skipped, like a type whose read was denied.
    const skippedTypes: string[] = unpermitted.map((type) => type.folder)
    const failedTypes: string[] = []
    let failures = 0
    // A type the app registration has no permission for is skipped below and does not count:
    // only failures that point at a removed role across the work list stop the backup.
    const countAuthFailure = (error: unknown, service: string) => {
      if (error instanceof GraphError && (error.status === 401 || error.status === 403)) network.authFailed("Microsoft Graph", error.status, error.message, service)
    }
    // Types of a service that isolates its failures which ended before every object was read; their remaining objects are not read.
    const endedTypes = new Set<string>()
    // Microsoft no longer accepts the sign-in. No type is at fault: every read after it fails the same way, for every service.
    const signInEnded = (error: unknown) => error instanceof TokenError || (error instanceof GraphError && signInRefused({ status: error.status, ...error.answer }))
    /**
     * Whether a type's own read was answered the way the type declares for a tenant that never set it
     * up. Only the read of the type itself can say so: an object that answers the same way after
     * others were saved is a failed read.
     */
    const notSetUp = (type: IntuneType, error: unknown) =>
      error instanceof GraphError && !!type.notConfigured && classifyAnswer({ status: error.status, ...error.answer }, { notConfigured: type.notConfigured, mode: tokens.mode }).outcome === "notConfigured"
    /**
     * Ends a type of a service that isolates its failures, by what the failed read means: the sign-in
     * may not read it, or it could not be read. The backup goes on with the other types. A read that
     * fails after an earlier one ended the type changes nothing.
     */
    const endType = (type: IntuneType, error: unknown, ownList = false): void => {
      if (endedTypes.has(type.folder)) return
      endedTypes.add(type.folder)
      const { module } = serviceOf(type)
      const answer = error instanceof GraphError ? { status: error.status, ...error.answer } : null
      const verdict = answer ? classifyAnswer(answer, { held: granted ? canBackUp(type.folder, granted) : undefined, mode: tokens.mode, ...(type.unavailable !== undefined ? { unavailable: ownList ? type.unavailable : [] } : {}) }) : { outcome: "failed" as const }
      const evidence = answer ? { status: answer.status, ...(answer.code ? { code: answer.code } : {}) } : {}
      const entry = result(type.folder)
      if (error instanceof LargeStorageError) {
        const reason = error.message
        skippedTypes.push(type.folder)
        Object.assign(entry, { state: "skipped", reason })
        settle(type.folder, { outcome: "skipped", cause: "storage", reason, ...(error.status ? { status: error.status } : {}) })
        this.write(job, `Skipped ${type.label}: ${reason}`, "warning")
        return
      }
      if (verdict.outcome === "skipped") {
        const reason = skipReason(verdict.cause, { service: module?.label ?? "this service", roles: module?.roles, mode: tokens.mode, settingsPage: SERVICES_PAGE }, answer?.message)
        skippedTypes.push(type.folder)
        Object.assign(entry, { state: "skipped", reason })
        settle(type.folder, { outcome: "skipped", cause: verdict.cause, reason, ...evidence })
        this.write(job, `Skipped ${type.label}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`)
        return
      }
      recordFailure(outcome, error)
      failures++
      failedTypes.push(type.folder)
      const reason = error instanceof Error ? error.message : String(error)
      Object.assign(entry, { state: "unreadable", reason })
      settle(type.folder, { outcome: "failed", error: reason, ...evidence })
      this.write(job, `Could not read ${type.label}: ${reason}`)
    }
    const discoveries = new Map<string, Promise<Item[]>>()
    await pool(types.map((type, index) => ({ type, index })).filter(({ type }) => type.volume !== "large"), concurrency, async ({ type, index }) => {
      const service = serviceOf(type)
      try {
        // A tenant-wide object has no list; reading it here skips the type on a denied read, like a denied list.
        const reader = readerOf(type)
        const source = type.listSource
        const budget = source?.budget
        const discover = source ? (path: string) => {
          // One discovery per run, with its own lifetime so ending one type cannot cancel another.
          const key = `${graphVersion(type)}/${path}`
          let scopes = discoveries.get(key)
          if (!scopes) {
            scopes = budget ? withReadBudget(network.signal, budget.durationMs, Infinity, control => readerOf(type, control).list(path)) : reader.list(path)
            discoveries.set(key, scopes)
          }
          return scopes
        } : undefined
        const all = (budget
          ? await withReadBudget(network.signal, budget.durationMs, budget.maxRequests, control => readEntries(type, readerOf(type, control), discover))
          : await readEntries(type, reader, discover)) as GraphItem[]
        const filtered = all.filter((item) => !type.skip?.(item as never))
        // A list that repeats an ID (an item seen on two pages) keeps only its first copy:
        // saving both would inflate the counts past the per-ID manifest inventory.
        const seen = new Set<string>()
        const items = filtered.filter((item) => {
          const key = item.id.toLowerCase()
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        const duplicates = filtered.length - items.length
        if (duplicates) this.write(job, `Ignored ${duplicates} repeated ${type.label} entr${duplicates === 1 ? "y" : "ies"} in the listing.`)
        const skipped = all.length - filtered.length
        this.write(job, `Found ${items.length} ${type.label}${skipped ? ` (${skipped} built-in skipped)` : ""}.`)
        Object.assign(result(type.folder), { found: items.length, ...(skipped ? { builtInSkipped: skipped } : {}), ...(items.length === 0 ? { state: "empty" } : {}) })
        lists[index] = { type, items }
      } catch (caught) {
        const resolverFailed = caught instanceof OrganizationResolutionError || caught instanceof ScopeDiscoveryError
        const error = caught instanceof OrganizationResolutionError || caught instanceof ScopeDiscoveryError ? caught.cause : caught
        // The answer the type declares for a tenant that never set it up: nothing to save, and nothing missing.
        // A sign-in Microsoft no longer accepts is never that answer, whatever status the type declares.
        if (!network.signal.aborted && !signInEnded(error) && !resolverFailed && notSetUp(type, error)) {
          result(type.folder).state = "notConfigured"
          settle(type.folder, { outcome: "notConfigured" })
          this.write(job, `${type.label.charAt(0).toUpperCase()}${type.label.slice(1)} is not set up in this tenant.`)
          return
        }
        // A sign-in that failed fails every read of the run, and a run that was stopped is over: both still end the backup.
        if (service.isolated && !signInEnded(error) && !network.signal.aborted) {
          endType(type, error, !resolverFailed)
          return
        }
        if (service.isolated) {
          // Counted before the rethrow, so the job sees this cause whichever failure ends it.
          recordFailure(outcome, error)
          network.signal.throwIfAborted()
          throw error
        }
        // Access denied: the app registration lacks the permission or its admin consent (for example
        // one created before the type was supported), or the admin's Intune role does not cover the
        // type. It is left out and reported, without marking the backup incomplete for the rest.
        const denied = error instanceof GraphError && error.status === 403 && !ORIGINAL_FOLDERS.has(type.folder)
        // Counted before any rethrow, so the job sees this cause whichever failure ends it.
        if (!denied) recordFailure(outcome, error)
        network.signal.throwIfAborted()
        if (error instanceof RequestTimeoutError) throw error
        if (error instanceof TokenError || (error instanceof GraphError && error.status === 401)) throw error
        if (denied) {
          skippedTypes.push(type.folder)
          const module = moduleForFolder(type.folder)?.module
          const reason = module?.precheck
            ? `Access was denied. The app registration may lack the permission or admin consent, or your account may not have a role that can read ${module.label}${module.roles ? ` (${module.roles.split(";")[0]})` : ""}.`
            : `Access was denied. The app registration may lack the permission or admin consent, or your ${module?.label ?? "Intune"} role may not allow it.`
          Object.assign(result(type.folder), { state: "skipped", reason })
          settle(type.folder, { outcome: "skipped", cause: "permission", reason, status: 403, ...(error.answer.code ? { code: error.answer.code } : {}) })
          this.write(job, `Skipped ${type.label}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`)
          return
        }
        countAuthFailure(error, service.id)
        failures++
        failedTypes.push(type.folder)
        const reason = error instanceof Error ? error.message : String(error)
        Object.assign(result(type.folder), { state: "unreadable", reason })
        settle(type.folder, { outcome: "failed", error: reason, ...(error instanceof GraphError ? { status: error.status, ...(error.answer.code ? { code: error.answer.code } : {}) } : {}) })
        this.write(job, `Could not read ${type.label}: ${reason}`)
      }
    }, network.signal)

    // Claim the folder before writing any policy, even when retention currently keeps everything.
    // The create-only write is atomic, so two writers that start in the same second cannot share
    // one folder: the loser fails here and writes nothing else.
    // The marker names this run, so the Dashboard can match a failed run to whatever folder storage holds for it.
    try {
      if (!isLargeBackup(backupFolder)) await storage.put(`${backupFolder}/${BACKUP_OWNER_FILE}`, JSON.stringify({ Source: "TenuVault Desktop", TenantId: request.tenantId.toLowerCase(), RunId: job.id, ...(mixed ? { CompanionBackup: largeFolder } : {}) }), undefined, true)
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
    const largeItems: LargeIndexes = {}
    const largeSizes: Record<string, number> = {}
    let done = 0
    const itemTimeoutWarnings: string[] = []
    // Same shape as the runbook's metadata.json, describing what this run saved so far.
    const manifest = (status: string, ended: Date, outcomes: RunOutcomes, extra: Record<string, unknown> = {}, folder = backupFolder) => {
      const seconds = Math.round((ended.getTime() - started.getTime()) / 1000)
      const large = isLargeBackup(folder)
      const inFolder = (folder: string) => !mixed || (typeForFolder(folder)?.volume === "large") === large
      const folderCounts = Object.fromEntries(Object.entries(counts).filter(([folder]) => inFolder(folder)))
      const folderOutcomes = mixed ? outcomes.types.filter(type => inFolder(type.folder)) : outcomes.types
      const folderFailures = mixed ? results.types.filter(type => inFolder(type.folder)).reduce((sum, type) => sum + type.failed + (failedTypes.includes(type.folder) ? 1 : 0), 0) : failures
      const folderSaved = Object.values(folderCounts).reduce((sum, count) => sum + count, 0)
      const folderStatus = mixed ? (folderFailures ? (folderSaved ? "CompletedWithWarnings" : "Failed") : nothingRead(folderOutcomes) ? "Failed" : "Success") : status
      return {
        BackupDate: folderTimestamp(started),
        BackupFolder: folder,
        StartTime: displayTime(started),
        EndTime: displayTime(ended),
        CompletedAt: ended.toISOString(),
        Duration: seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
        DurationSeconds: seconds,
        // Inventory such as Autopilot devices is counted under its own folder, not as policies.
        ItemCounts: { ...folderCounts, TotalPolicies: policyCount(folderCounts) },
        Status: folderStatus,
        RunbookVersion: "desktop",
        BackupFormat: "Individual policy files with Intune-compatible JSON",
        Source: "TenuVault Desktop",
        // Retention only ever removes backups recorded as this tenant's.
        TenantId: request.tenantId.toLowerCase(),
        Trigger: request.trigger ?? "manual",
        RunId: job.id,
        // Included records the types this run attempted, so later app versions do not count types added since as covered.
        Scope: { Excluded: scope.excluded, Included: types.filter(type => inFolder(type.folder)).map((type) => type.folder) },
        Failures: folderFailures,
        SkippedTypes: skippedTypes.filter(inFolder),
        FailedTypes: failedTypes.filter(inFolder),
        AuthMode: tokens.mode,
        ...(notReadable.length ? { AppOnlyExcludedTypes: notReadable } : {}),
        ...(maskedItems.length ? { MaskedSecretItems: maskedItems } : {}),
        // Whether every selected type was read, and how each ended. Status, Failures and the type lists above keep their meaning.
        Coverage: coverageOf(folderOutcomes) === "complete" ? "Complete" : "Incomplete",
        Outcomes: manifestOutcomes(folderOutcomes),
        ...(mixed ? { CompanionBackup: large ? ordinaryFolder : largeFolder, ...(!large ? { LargeBackupOutcomes: manifestOutcomes(outcomes.types.filter(type => !inFolder(type.folder))) } : {}) } : {}),
        // Per item fingerprints (by type folder and Intune ID), so backups can be compared without reading every file.
        Items: large ? {} : sortKeys(items),
        ...(large ? { LargeItems: largeItems, LargeSizes: largeSizes } : {}),
        ...(itemTimeoutWarnings.length ? { Warnings: itemTimeoutWarnings } : {}),
        ...extra,
      }
    }
    const commitManifest = async (folder: string, metadata: Record<string, unknown>, trackCommit = true) => {
      // The dispatched manifest may land despite cancellation. Give it the existing commit grace
      // and never follow an ambiguous commit with a failed manifest for the same folder.
      network.signal.throwIfAborted()
      const commitDeadline = deadline + MANIFEST_COMMIT_GRACE_MS
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(jobDeadlineError()), Math.max(0, commitDeadline - Date.now()))
      timer.unref?.()
      const commitNetwork = new NetworkCircuit(3 * concurrency, controller.signal, commitDeadline)
      const writer = new BlobWriter(fetchImpl, request.storageAccountName, storageToken, commitNetwork)
      let unconfirmed = false
      try {
        await writer.put(`${folder}/metadata.json`, JSON.stringify(metadata, null, 2), network, false, () => { if (trackCommit) stopped.committing = true }, undefined, () => { unconfirmed = true })
      } catch (error) {
        // Keep the job failure and let audit reconcile the possible storage commit separately.
        if (unconfirmed && trackCommit) job.commitUnconfirmed = true
        throw error
      } finally { clearTimeout(timer) }
    }
    // From here the folder is this run's, so a run that stops early records it as failed, or as cancelled when the user cancelled it.
    if (!isLargeBackup(backupFolder)) stopped.manifest = (status, error, outcomes) => manifest(status, this.now(), outcomes, { Status: status, Error: error })
    stopped.stoppedBy = () => network.stoppedBy

    await pool(work, concurrency, async ({ type, item, displayName, fileName }) => {
      const service = serviceOf(type)
      // The rest of a type that ended is not read: its first refusal answers for every object of it.
      if (endedTypes.has(type.folder)) {
        done++
        return
      }
      job.progressMessage = `Backing up ${type.label}`
      try {
        let masked = false
        const unreadExtras: Array<{ property: string; error: unknown }> = []
        // A list-only type's list entry already holds everything its snapshot keeps.
        const detail = type.listOnly ? listSnapshot(type, item as Item) : await readObject(type, item.id, readerOf(type), {
          ...(keepMasked ? { keepMasked: (error: unknown) => (masked = keepMasked(error)) } : {}),
          onUnreadExtra: (property, error) => {
            if (signInEnded(error)) throw error
            unreadExtras.push({ property, error })
          },
        })
        const body = JSON.stringify(detail, null, 2)
        await storage.put(`${backupFolder}/${type.folder}/${fileName}.json`, body)
        const maskedView = withMaskedSecrets(type, detail)
        items[`${type.folder}/${item.id}`] = {
          file: `${fileName}.json`,
          hash: snapshotHash(detail),
          // What versions that could not read this type's assignments recorded, to compare with their backups.
          ...(type.assignmentsFormerlyExpanded ? { hashWithEmptyAssignments: snapshotHash({ ...detail, assignments: [] }) } : {}),
          ...(maskedView ? { hashWithMaskedSecrets: snapshotHash(maskedView) } : {}),
          ...(masked ? { secretsMasked: true as const } : {}),
        }
        if (masked) maskedItems.push({ Folder: type.folder, Id: item.id, Name: displayName })
        counts[type.folder]!++
        result(type.folder).saved++
        outcome.saved++
        // Only a committed snapshot can say that the parent configuration was kept.
        for (const { property, error } of unreadExtras) {
          const reason = `${type.label}: ${property} could not be read; the parent configuration was kept.`
          const verdict = error instanceof GraphError ? classifyAnswer({ status: error.status, ...error.answer }, { mode: tokens.mode }) : { outcome: "failed" as const }
          if (verdict.outcome === "skipped") {
            if (!skippedTypes.includes(type.folder)) skippedTypes.push(type.folder)
            settle(type.folder, { outcome: "skipped", cause: verdict.cause, reason })
            Object.assign(result(type.folder), { state: "skipped", reason })
          } else {
            recordFailure(outcome, error)
            failures++
            const entry = result(type.folder)
            entry.failed++
            if ((entry.errors ??= []).length < MAX_ITEM_ERRORS) entry.errors.push(reason)
          }
          this.write(job, reason, "warning")
        }
      } catch (caught) {
        const error = caught instanceof OrganizationResolutionError || caught instanceof ScopeDiscoveryError ? caught.cause : caught
        if (service.isolated && !signInEnded(error) && !network.signal.aborted) {
          // A refusal, a pause longer than the bound or a request without an answer holds for every object of the type: the type ends, the backup goes on.
          const refused = error instanceof GraphError && classifyAnswer({ status: error.status, ...error.answer }, { mode: tokens.mode }).outcome === "skipped"
          if (refused || error instanceof ReadBudgetError || error instanceof RetryDelayError || error instanceof GraphUnansweredError || endedTypes.has(type.folder)) {
            endType(type, error)
            done++
            return
          }
        }
        // Counted before any rethrow, so the job sees this cause whichever failure ends it.
        recordFailure(outcome, error)
        network.signal.throwIfAborted()
        if (!service.isolated) countAuthFailure(error, service.id)
        // An expired sign-in fails every remaining item the same way, so it stops the backup once.
        if (signInEnded(error) || (!service.isolated && error instanceof GraphError && error.status === 401)) throw error
        failures++
        const warning = `Could not back up "${displayName}": ${error instanceof Error ? error.message : String(error)}`
        if (error instanceof RequestTimeoutError) itemTimeoutWarnings.push(warning)
        const entry = result(type.folder)
        entry.failed++
        if ((entry.errors ??= []).length < MAX_ITEM_ERRORS) entry.errors.push(`${displayName}: ${error instanceof Error ? error.message : String(error)}`)
        this.write(job, warning)
      }
      done++
      job.progress = Math.round(10 + (done / Math.max(work.length, 1)) * 85)
      const left = remaining.get(type.folder)! - 1
      remaining.set(type.folder, left)
      if (left === 0 && !endedTypes.has(type.folder) && !settled.has(type.folder)) {
        result(type.folder).state = "saved"
        this.write(job, `Backed up ${counts[type.folder]} ${type.label}.`)
      }
    }, network.signal)

    // Fairness: legacy work remains FIFO and serial. A large run releases its whole-job turn
    // before streaming, then yields to queued tenants before each Graph page. A throttle in
    // this run cannot hold the legacy queue for the large type's two-hour allowance.
    if (mixed) {
      // Publish ordinary coverage before the large phase, even if that phase crashes or is cancelled.
      await commitManifest(ordinaryFolder, manifest(failures ? "CompletedWithWarnings" : "Success", this.now(), outcomesNow("Success", this.now(), true)), false)
    }
    let largeClaimed = false
    if (largeTypes.length) {
      releaseTurn()
      try {
        if (local || tokens.mode === "delegated") await largeStorage.ensureContainer(LARGE_BACKUP_CONTAINER)
        await largeStorage.put(`${largeFolder}/${BACKUP_OWNER_FILE}`, JSON.stringify({ Source: "TenuVault Desktop", TenantId: request.tenantId.toLowerCase(), RunId: job.id, LargeInventory: { version: 1 }, ...(mixed ? { CompanionBackup: ordinaryFolder } : {}) }), undefined, true)
        largeClaimed = true
      } catch (error) {
        network.signal.throwIfAborted()
        for (const type of largeTypes) endType(type, error instanceof LargeStorageError ? error : new LargeStorageError(undefined, { cause: error }))
      }
    }
    if (largeClaimed) stopped.manifest = (status, error, outcomes) => manifest(status, this.now(), outcomes, { Status: status, Error: error }, largeFolder)
    const waitForTenants = () => this.queueTail
    for (const type of largeTypes.filter(() => largeClaimed)) {
      const entry = result(type.folder)
      largeItems[type.folder] = { version: 1, count: 0, shards: 0, complete: false }
      const limits = type.readBudget ?? { durationMs: LARGE_TYPE_MS, maxRequests: LARGE_TYPE_REQUESTS }
      const typeController = new AbortController()
      const typeSignal = AbortSignal.any([network.signal, typeController.signal])
      // The type deadline covers uploads and external sorting as well as Graph reads.
      const typeTimer = setTimeout(() => typeController.abort(new ReadBudgetError("The large type time budget was reached. This type was not fully read.")), limits.durationMs)
      typeTimer.unref?.()
      const budget = typeReadBudget(typeSignal, limits)
      const { session } = serviceOf(type)
      const boundedPages = async function* (path: string) {
        // Every concurrent relationship iterator owns its request controls. The allowance and
        // type signal remain shared across all pages, retries and relationships.
        const pageControl: { current: ReadControl } = { current: {} }
        const controls = { get signal() { return pageControl.current.signal }, beforeRequest: () => pageControl.current.beforeRequest?.() }
        const iterator = session.pages(graphUrl(graphVersion(type), path, type.additionalReadVersions), { get signal() { return controls.signal }, beforeRequest: controls.beforeRequest, headers: type.headers, ...(path === listPath(type) ? { filter: type.filter } : {}) })
        try {
          for (;;) {
            const next = await budget(async control => {
              await withAbort(waitForTenants, control.signal!)
              control.signal?.throwIfAborted()
              pageControl.current = control
              return iterator.next()
            })
            if (next.done) break
            yield next.value as Item[]
          }
        } finally { await iterator.return(undefined) }
      }
      try {
        largeItems[type.folder] = await captureLarge({
          type, reader: {
            get: path => budget(control => session.get<Item>(graphUrl(graphVersion(type), path, type.additionalReadVersions), type.headers, control)),
            list: async () => { throw new Error("Large types must stream sub-collections") },
          },
          pages: boundedPages,
          put: async (path, body) => {
            try { await largeStorage.put(`${largeFolder}/${path}`, body, undefined, false, undefined, typeSignal) }
            catch (error) {
              typeSignal.throwIfAborted()
              throw error instanceof LargeStorageError ? error : new LargeStorageError(undefined, { cause: error })
            }
            largeSizes[type.folder] = (largeSizes[type.folder] ?? 0) + Buffer.byteLength(body)
          },
          signal: typeSignal,
          saved: () => { counts[type.folder]!++; entry.saved++; outcome.saved++ },
          unread: () => { entry.failed++; failures++; entry.errors = ["Directory relationships were not read in full."] },
        })
        if (!largeItems[type.folder]!.complete) {
          failedTypes.push(type.folder)
          settle(type.folder, { outcome: "failed", error: "Some directory relationships could not be read in full." })
        }
        Object.assign(entry, { found: entry.saved, state: entry.failed ? "unreadable" : entry.saved ? "saved" : "empty" })
        this.write(job, `Backed up ${entry.saved} ${type.label}.`)
      } catch (error) {
        network.signal.throwIfAborted()
        // Directory Graph errors can echo profile values. Keep status for classification, but never
        // publish the response text or error code into job logs, outcomes or diagnostics.
        if (signInEnded(error)) throw new TokenError("Microsoft Graph sign-in ended during the directory read.")
        const safeError = error instanceof LargeStorageError || error instanceof ReadBudgetError ? error
          : error instanceof GraphError ? new GraphError("The directory collection could not be read in full.", error.status)
          : new Error("The directory collection could not be read in full.")
        // Even a refused continuation is incomplete, never a saved prefix of the collection.
        endType(type, safeError)
      } finally { clearTimeout(typeTimer) }
    }

    if (largeClaimed) {
      try {
        const ending = typesNow(false)
        const saved = Object.values(counts).reduce((sum, count) => sum + count, 0)
        const status = failures ? (saved ? "CompletedWithWarnings" : "Failed") : nothingRead(ending) ? "Failed" : "Success"
        await commitManifest(largeFolder, manifest(status, this.now(), outcomesNow(status, this.now(), false), {}, largeFolder))
      } catch (error) {
        network.signal.throwIfAborted()
        for (const type of largeTypes) endType(type, error instanceof LargeStorageError ? error : new LargeStorageError(undefined, { cause: error }))
      }
    }
    const ended = this.now()
    const totalPolicies = policyCount(counts)
    const saved = Object.values(counts).reduce((sum, count) => sum + count, 0)
    const inventory = Object.entries(counts).filter(([folder, count]) => count > 0 && typeForFolder(folder)?.inventory)
    // Every selected type was left out, so the backup holds nothing: that is a failure, although no single read failed.
    // A run with failures keeps its status and its message as they were.
    const ending = typesNow(false)
    const unread = failures === 0 && nothingRead(ending) ? nothingReadReason(ending, { mode: tokens.mode, settingsPage: SERVICES_PAGE }) : null
    const status = failures > 0 ? (saved === 0 ? "Failed" : "CompletedWithWarnings") : unread ? "Failed" : "Success"
    const outcomes = outcomesNow(status, ended, false)
    const metadata = manifest(status, ended, outcomes, unread ? { Error: unread } : {})

    if (!isLargeBackup(backupFolder)) await commitManifest(backupFolder, metadata)
    this.conclude(job, outcomes)

    // Only a complete backup may replace older ones: if policies could not be read (for
    // example after a permission change), keep every existing backup.
    let retentionWarnings = 0
    // The Backup Reader cannot delete from Azure Storage. The next backup with an admin's sign-in applies
    // retention to every backup of the tenant, Backup Reader backups included, with the same protections.
    const deletesAllowed = local || tokens.mode === "delegated"
    const complete = mixed ? coverageOf(outcomes.types.filter(type => typeForFolder(type.folder)?.volume !== "large")) === "complete" : failures === 0 && !unread && Object.values(largeItems).every(index => index.complete)
    if (!deletesAllowed && complete && (this.deps.retentionDays?.(job.tenantId) ?? 0) > 0) {
      this.write(job, "Older backups were kept: the Backup Reader cannot delete from Azure Storage. The next backup made with an admin's sign-in removes expired ones.", "info")
    } else if (deletesAllowed && complete && (this.deps.retentionDays?.(job.tenantId) ?? 0) > 0) {
      const retentionNetwork = new NetworkCircuit(3 * concurrency, signal, deadline)
      const retentionStorage = new BlobWriter(fetchImpl, request.storageAccountName, storageToken, retentionNetwork)
      try {
        const covered = restorableFolders(metadata)
        if (mixed && largeClaimed && coverageOf(outcomes.types.filter(type => typeForFolder(type.folder)?.volume === "large")) === "complete") for (const type of largeTypes) covered.add(type.folder)
        const unreadableOlder = await this.applyRetention(job, retentionStorage, backupFolder, covered, retentionNetwork.signal)
        if (unreadableOlder > 0) retentionWarnings++
        if (mixed && largeClaimed) {
          const largeMetadata = { ...metadata, Scope: { Included: largeTypes.map(type => type.folder) } }
          try { await this.applyRetention(job, largeStorage, largeFolder, coverageOf(outcomes.types.filter(type => typeForFolder(type.folder)?.volume === "large")) === "complete" ? restorableFolders(largeMetadata) : new Set(), largeNetwork.signal) }
          catch (error) { this.write(job, `Large backup retention was skipped. ${error instanceof Error ? error.message : String(error)}`, "warning"); retentionWarnings++ }
        }
      } catch (error) {
        retentionWarnings++
        if (signal.aborted || Date.now() >= deadline) {
          this.write(job, "Retention was interrupted; older backups are cleaned up on the next run", "warning")
        } else if (retentionNetwork.signal.aborted) {
          this.write(job, "Old backups were not removed because the network stopped responding. They will be reconsidered on the next run.", "warning")
        } else if (error instanceof InventoryDamagedError) {
          // The local store refuses every delete while the backup folder holds damaged files.
          this.write(job, `Retention is paused. ${error.message}`, "warning")
        } else {
          this.write(job, `Could not remove old backups: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")}. They will be reconsidered on the next run.`, "warning")
        }
      }
    } else if (!complete) {
      this.write(job, "Older backups were kept because this backup is incomplete.", "info")
    }

    job.failures = failures
    job.totalPolicies = totalPolicies
    results.totalPolicies = totalPolicies
    job.failedTypes = [...failedTypes]
    job.status = status === "Failed" ? "Failed" : "Completed"
    // Types that were left out are an answer, or were left out before any request: only failed reads can mean that Microsoft was out of reach.
    if (job.status === "Failed" && failures > 0 && !outcome.answered && !outcome.otherFailures) job.unreachable = true
    if (maskedItems.length) {
      this.write(job, `Saved ${maskedItems.length} object${maskedItems.length === 1 ? "" : "s"} with encrypted OMA-URI values masked (****): Microsoft refused the plain-text read, so these copies cannot be restored. A manual backup with your sign-in captures them when Microsoft returns the values.`, "warning")
    }
    const warnings = failures + retentionWarnings + (maskedItems.length ? 1 : 0)
    results.warnings = warnings
    if (unread) {
      // The reason is the job's error, so the result, the schedule and the notification show it like any other failure's.
      job.progressMessage = "Backup failed: nothing could be read"
      job.exception = unread
      this.write(job, `Backup failed: ${unread.charAt(0).toLowerCase()}${unread.slice(1)}`)
      return
    }
    job.progressMessage =
      job.status === "Failed" ? "Backup failed: no policies could be saved" : warnings > 0 ? `Backup completed with ${warnings} warning${warnings === 1 ? "" : "s"}` : "Backup completed successfully"
    const extra = inventory.map(([folder, count]) => ` and ${count} ${typeForFolder(folder)!.label}`).join("")
    this.write(job, `Backup completed: ${totalPolicies} policies${extra} in ${metadata.Duration}.`)
  }

  /**
   * Writes the manifest of a run that stopped after claiming its folder, with status Failed, or
   * Cancelled when the user cancelled it, so every list names the backup and its trigger and
   * retention can remove it like any other backup of this tenant. Readers never treat a failed or
   * cancelled backup as complete. The write only creates: it
   * never replaces a manifest that is already there. It goes around the run's fetch, so it cannot
   * change how the failure was classified, and it gives up after FAILED_MANIFEST_GRACE_MS.
   */
  private async recordStopped(job: BackupJob, request: BackupRequest, tokens: RunTokens, metadata: Record<string, unknown>): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new RequestTimeoutError("The storage did not answer in time.")), FAILED_MANIFEST_GRACE_MS)
    timer.unref?.()
    const deadline = Date.now() + FAILED_MANIFEST_GRACE_MS
    const network = new NetworkCircuit(3, controller.signal, deadline)
    const token = isLocalAccount(request.storageAccountName) ? async () => "" : tokens.storage
    const storage = new BlobWriter(this.deps.fetch, request.storageAccountName, token, network)
    const recorded = metadata.Status === "Cancelled" ? "cancelled" : "failed"
    try {
      await storage.put(`${metadata.BackupFolder ?? job.backupFolder}/metadata.json`, JSON.stringify(metadata, null, 2), undefined, true)
      this.write(job, `Recorded this backup as ${recorded}. The policies it saved stay in storage but are never offered as a complete backup.`)
    } catch (error) {
      if (error instanceof BlobClaimError) this.write(job, "This backup already has a manifest, so it was left as it is.")
      else {
        // The circuit's own deadline error names the job deadline; this write has its own, shorter one.
        const reason = controller.signal.aborted || Date.now() >= deadline ? "The storage did not answer in time" : (error instanceof Error ? error.message : String(error)).replace(/\.$/, "")
        this.write(job, `Could not record this backup as ${recorded}: ${reason}. It is listed as incomplete.`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Deletes backup folders older than the retention period, never the one just written, and never the
   * newest backup that holds a type the current backup left out: a backup of fewer types must not
   * age out the only copy of the others. Another tenant's backups are never deleted.
   * Owned remnants expire after seven extra recovery days. Unverifiable remnants stay for manual
   * review. Ordinary backups with no companion keep their existing retention rules. A manifest that
   * names no tenant is placed by the folder's ownership marker. Backups that record no tenant in
   * either count as this tenant's unless the container also holds a backup recorded as another
   * tenant's, or one whose metadata or marker cannot be read.
   */
  private async applyRetention(job: BackupJob, storage: BlobWriter, current: string, covered: Set<string>, signal: AbortSignal): Promise<number> {
    const days = this.deps.retentionDays?.(job.tenantId) ?? 0
    if (days <= 0) return 0
    const cutoff = this.now().getTime() - days * 24 * 60 * 60 * 1000
    // Each storage class retains its own coverage, so large discovery cannot block ordinary deletion.
    const ordinary = isLargeBackup(current) ? { prefixes: [] } : await storage.list("backup-", "/")
    const large = isLargeBackup(current) ? await storage.list("backup-large-", "", LARGE_BACKUP_CONTAINER, true) : { blobs: [] }
    const largePrefixes = [...new Set(large.blobs.map(name => `${name.split("/")[0]}/`))].filter(isLargeBackup)
    const prefixes = [...ordinary.prefixes, ...largePrefixes]
    const backups = prefixes
      .map((prefix) => {
        const match = /^backup-(?:large-)?(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\/$/.exec(prefix)
        if (!match || prefix === `${current}/`) return null
        const [, y, mo, d, h, mi, se] = match.map(Number) as number[]
        return { prefix, time: Date.UTC(y!, mo! - 1, d!, h!, mi!, se!) }
      })
      .filter((backup) => backup !== null)
      .sort((a, b) => b.time - a.time)

    // Who each backup belongs to. Every metadata file is read first, because backups from versions
    // that did not record the tenant count as this tenant's only while no backup names another one.
    const tenant = job.tenantId.toLowerCase()
    const owners: Array<{ metadata: Record<string, unknown> | null; owner: "this" | "other" | "untagged"; claim?: OwnershipFile } | null> = Array.from({ length: backups.length }, () => null)
    const unreadable = new Set<number>()
    let unreadableReason = ""
    // Metadata or a marker that cannot be opened (an Azure backup sealed by an earlier version with a
    // key this device lacks, a local file with a wrong key or damage, JSON that is not an object) or
    // a local backup made unavailable by damaged files is unreadable: never ours, and it must not
    // stop the review of the other backups. Any other failure stops retention.
    const readFile = async (name: string): Promise<OwnershipFile> => {
      try {
        const value = await storage.readJson(name)
        return value === null ? { kind: "missing" } : { kind: "found", value }
      } catch (error) {
        if (!(error instanceof FetchApplicationError) && !(error instanceof InventoryDamagedError)) throw error
        return { kind: "unreadable", error }
      }
    }
    await pool(backups.map((backup, index) => ({ backup, index })), CONCURRENCY, async ({ backup, index }) => {
      let claim: OwnershipFile | undefined
      const { manifest, owner } = await resolveBackupOwnership(async (file) => {
        const read = await readFile(`${backup.prefix}${file}`)
        if (file === BACKUP_OWNER_FILE) claim = read
        return read
      }, tenant)
      const failure = manifest.kind === "unreadable" ? manifest.error : owner.kind === "unreadable" ? owner.error : null
      if (failure !== null) {
        unreadable.add(index)
        unreadableReason ||= failure instanceof Error ? failure.message : String(failure)
        return
      }
      // The marker places unfinished folders too. Remnant cleanup requires a separate app claim check.
      owners[index] = {
        metadata: manifest.kind === "found" ? manifest.metadata : null,
        claim,
        owner: owner.kind === "owned" ? "this" : owner.kind === "other" ? "other" : "untagged",
      }
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
    const remnants = { deleted: 0, deletedBytes: 0, kept: 0, keptBytes: 0, unowned: 0, unownedBytes: 0 }
    const reportRemnants = () => {
      if (remnants.deleted || remnants.kept || remnants.unowned) this.write(job, `Remnant cleanup: deleted ${remnants.deleted} halves (${remnants.deletedBytes} bytes); kept ${remnants.kept} owned halves (${remnants.keptBytes} bytes) for recovery or storage protection; kept ${remnants.unowned} unverified halves (${remnants.unownedBytes} bytes) for manual review. Recovery grace is ${REMNANT_RECOVERY_DAYS} days after the ${days}-day retention period.`, remnants.unowned ? "warning" : "info")
    }
    try {
      for (const [index, backup] of backups.entries()) {
        const entry = owners[index]
        const metadata = entry?.metadata
        let companion: Record<string, unknown> | null = null
        const companionId = metadata?.CompanionBackup
        const paired = companionId !== undefined || metadata?.LargeBackupOutcomes !== undefined
        let validPair = false
        if (paired && typeof companionId === "string" && isBackupName(companionId) && isLargeBackup(companionId) !== isLargeBackup(backup.prefix)) {
          try { companion = await storage.readJson(`${companionId}/metadata.json`) }
          catch { this.write(job, `Kept mixed backup ${backup.prefix}: its companion is unreadable.`, "warning"); continue }
          validPair = matchingCompanions(backup.prefix.slice(0, -1), metadata!, companionId, companion) && completeHalf(metadata) && completeHalf(companion)
        }
        // Older standalone manifests did not record Coverage, but successful complete indexes
        // still follow their original retention rule. Reciprocal pairs require the stricter check.
        const standaloneComplete = metadata && ["success", "succeeded"].includes(String(metadata.Status).toLowerCase())
          && (metadata.Failures === undefined || metadata.Failures === 0) && metadata.Coverage !== "Incomplete"
          && Object.values(metadata.LargeItems ?? {}).every((index: any) => index.complete === true)
        const remnant = !metadata || (paired && !validPair) || (isLargeBackup(backup.prefix) && !standaloneComplete)
        if (remnant && !unreadable.has(index)) {
          const marker = entry?.claim ?? await readFile(`${backup.prefix}${BACKUP_OWNER_FILE}`)
          const claim = marker.kind === "found" ? marker.value as Record<string, unknown> : null
          const owned = ownedRemnant(backup.prefix.slice(0, -1), tenant, claim, metadata)
          const listing = await storage.listFolder(backup.prefix)
          const bytes = [...listing.sizes.values()].reduce((sum, size) => sum + size, 0)
          if (!owned) { remnants.unowned++; remnants.unownedBytes += bytes; if (backup.time < cutoff) unowned++; continue }
          if (backup.time >= cutoff - REMNANT_RECOVERY_DAYS * 86400_000) { remnants.kept++; remnants.keptBytes += bytes; continue }
          let remaining = bytes
          try {
            const markerName = `${backup.prefix}${BACKUP_OWNER_FILE}`, manifestName = `${backup.prefix}metadata.json`
            // Keep the ownership claim until the last payload has gone, so a later pass can finish.
            for (const name of [...listing.blobs.filter(name => name === manifestName), ...listing.blobs.filter(name => name !== manifestName && name !== markerName), ...listing.blobs.filter(name => name === markerName)]) {
              await storage.delete(name)
              const size = listing.sizes.get(name) ?? 0
              remaining -= size
              remnants.deletedBytes += size
            }
            remnants.deleted++
          } catch (error) {
            remnants.kept++; remnants.keptBytes += remaining
            if (!(error instanceof ProtectedBlobError)) throw error
          }
          continue
        }
        if (!metadata || !entry || entry.owner === "other" || (entry.owner === "untagged" && shared)) {
          if (backup.time < cutoff && !unreadable.has(index)) unowned++
          continue
        }
        if (paired) {
          // The ordinary half alone coordinates complete pairs. Coverage protects both halves.
          if (!validPair || isLargeBackup(backup.prefix)) continue
          if (Date.parse(parseBackupName(String(companionId))!.timestamp) >= cutoff) continue
          if ([...restorableFolders(companion!)].some(folder => !covered.has(folder))) continue
        }
        let holdsUncovered = false
        // Only a backup that read everything may satisfy coverage: one that finished with
        // warnings may miss items in any folder it appears to hold. Backups recorded before
        // failures were counted carry no Failures value and count by their status alone.
        const status = String(metadata.Status ?? "").toLowerCase()
        const complete = (status === "success" || status === "succeeded") && (metadata.Failures === undefined || metadata.Failures === 0)
        // A folder with masked values does not satisfy coverage, so the newest backup with the plain values stays.
        for (const folder of complete ? restorableFolders(metadata) : []) {
          if (uncovered.delete(folder)) holdsUncovered = true
        }
        if (backup.time >= cutoff) continue
        if (holdsUncovered) {
          kept++
          continue
        }
        const unitPrefixes = [backup.prefix, ...(companion ? [`${companionId}/`] : [])]
        // Settle both inventories before the first delete, including large storage access.
        const unitListings = await Promise.all(unitPrefixes.map(prefix => storage.listFolder(prefix)))
        const blobs = unitListings.flatMap(listing => listing.blobs)
        // The manifest goes first: a delete that stops at a protected file must not leave a
        // metadata.json that still reports the backup as complete. A protected manifest stops
        // before any policy file is touched.
        const manifests = new Set(unitPrefixes.map(prefix => `${prefix}metadata.json`))
        const markers = new Set(unitPrefixes.map(prefix => `${prefix}${BACKUP_OWNER_FILE}`))
        let deleted = 0
        try {
          // Keep ownership until every policy is gone, including when a protected policy stops deletion.
          for (const blob of [...blobs.filter((name) => manifests.has(name)), ...blobs.filter((name) => !manifests.has(name) && !markers.has(name)), ...blobs.filter((name) => markers.has(name))]) {
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
    } finally { reportRemnants() }
    if (removed > 0) this.write(job, `Removed ${removed} backup${removed === 1 ? "" : "s"} older than ${days} days.`, "info")
    if (kept > 0) this.write(job, `Kept ${kept} older backup${kept === 1 ? "" : "s"} because ${kept === 1 ? "it holds" : "they hold"} the newest copy of types this backup leaves out.`, "info")
    if (protectedKept > 0) {
      this.write(job, `Kept ${protectedKept} older backup${protectedKept === 1 ? "" : "s"} protected by the storage account's immutability policy or legal hold.${partlyRemoved > 0 ? ` ${partlyRemoved} of them lost some files before the protected ones were reached, including ${partlyRemoved === 1 ? "its" : "their"} metadata, so ${partlyRemoved === 1 ? "it is" : "they are"} no longer offered as complete.` : ""}`, "info")
    }
    if (unowned > 0) this.write(job, `Kept ${unowned} older backup${unowned === 1 ? "" : "s"} not recorded as this tenant's (another tenant's, without readable metadata, or from an earlier version in a container another tenant also uses).`, "info")
    if (unreadable.size > 0) this.write(job, `Could not read the metadata of ${unreadable.size} older backup${unreadable.size === 1 ? "" : "s"}: ${unreadableReason.replace(/\.$/, "")}. ${unreadable.size === 1 ? "It was" : "They were"} left in place.`, "warning")
    return unreadable.size + remnants.unowned
  }

  /** Adds a line to the log, in local time; a level also lists it among the run's notices. */
  private write(job: BackupJob, line: string, level?: BackupNotice["level"]): void {
    job.log.push(`[${this.now().toTimeString().slice(0, 8)}] ${line}`)
    if (level) job.results?.notices.push({ level, message: line })
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private prune(): void {
    while (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.values()].find((job) => job.status !== "Running" && job.status !== "Queued" && job.endTime !== undefined)
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

/** Whether `error` or one of its causes has the given name. */
function causedBy(error: unknown, name: string): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    if (current.name === name) return true
  }
  return false
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

function jobDeadlineError(duration = JOB_DEADLINE_MS): Error {
  return new Error(`Backup timed out after the ${duration === LARGE_JOB_MS ? "8 hour" : "30 minute"} job deadline. Retry the backup.`)
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
  const cleaned = name
    // Control characters are intentionally replaced in safe filenames.
    // oxlint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
  // Truncate without splitting a surrogate pair: a lone surrogate makes
  // encodeURIComponent throw when the file name is written to storage.
  const truncated = cleaned.slice(0, 200).replace(/[\ud800-\udbff]$/, "").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "_")
  return truncated || "unnamed"
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


/** The permissions in the run's Graph token, read only when a service with a token pre-check needs checking. */
async function moduleGrants(tokens: RunTokens, needed: boolean) {
  if (!needed) return undefined
  try {
    return grantedPermissions(await tokens.graph())
  } catch {
    // A token that cannot be acquired fails the run on the first read with the usual sign-in handling.
    return undefined
  }
}

/** Saved objects that are configuration, leaving out tenant inventory such as Autopilot devices. */
function policyCount(counts: Record<string, number>): number {
  return Object.entries(counts).reduce((sum, [folder, count]) => (typeForFolder(folder) && !backupTypeUse(typeForFolder(folder)!).policyCount ? sum : sum + count), 0)
}
