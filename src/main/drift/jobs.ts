import { randomUUID } from "node:crypto"
import type { KeyValueStore } from "../storage/secure-store"
import type { RouteModule } from "../api/host"
import type { NextRequest } from "../api/next-server-shim"
import type { FeatureDeps } from "../features/deps"
import { isGuid } from "../../shared/security"
import type { DriftResult, DriftScanPhase, DriftScanProgress, DriftSummary } from "../../shared/intune/drift"
import { registerDriftScan } from "../../portal/lib/drift/scan-hooks"

export interface DriftJobSummary {
  jobId: string
  tenantId: string
  status: "running" | "completed" | "failed" | "cancelled"
  phase: DriftScanPhase
  /** Human readable description of the current step. */
  detail: string
  /** Items compared so far and in total, while comparing. */
  done: number
  total: number
  /** 0 to 100. */
  percent: number
  startedAt: string
  finishedAt?: string
  /** The pair asked for; null for the default pair (the two newest complete backups). */
  baseline: string | null
  comparison: string | null
  summary?: DriftSummary
  error?: string
  /** The route's error code, such as INSUFFICIENT_BACKUPS. */
  code?: string
}

/** The last comparison of a tenant, as saved on this device. */
export interface SavedDriftResult extends DriftResult {
  schemaVersion: 1
  tenantId: string
  jobId: string
  /** Where the compared backups are stored; a result from another storage account is not shown. */
  storageAccountName: string
}

interface DriftJob extends DriftJobSummary {
  controller: AbortController
  settled: Promise<void>
}

export interface DriftJobDeps {
  /** Runs /api/detect-drifts with the tenant's credentials (FeatureDeps.api). */
  api: FeatureDeps["api"]
  tenant: FeatureDeps["tenant"]
  /** Throws when the tenant is not signed in or not licensed. */
  plan: FeatureDeps["plan"]
  /** Where the last result per tenant is kept; the encrypted app store when available. */
  store: KeyValueStore
  /** Called once when a scan finishes, fails or is cancelled. */
  notify?: (job: DriftJobSummary) => void
}

export class DriftJobError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = "DriftJobError"
  }
}

const FINISHED_JOB_TTL = 30 * 60_000
/** Results larger than this stay in memory for the session instead of being saved. */
const MAX_SAVED_LENGTH = 4_000_000
const BACKUP_NAME = /^(?:backup-\d{4}-\d{2}-\d{2}-\d{6}|\d{4}-\d{2}-\d{2}_[0-9_-]+)$/

const PHASE_PERCENT: Record<DriftScanPhase, number> = { checking: 2, listing: 6, comparing: 10, history: 96 }

function percentOf(progress: DriftScanProgress): number {
  if (progress.phase !== "comparing") return PHASE_PERCENT[progress.phase]
  return Math.round(10 + (progress.total ? progress.done / progress.total : 1) * 85)
}

/**
 * Drift scans run in the main process, independent of the page that started them, so the admin can
 * keep working while backups are compared. Each tenant has at most one running scan. The scan runs
 * /api/detect-drifts through the API host (so it gets the tenant's storage access and its audit log
 * entry), follows its progress and cancels it through scan hooks, and saves the result as the
 * tenant's last result. Finished jobs stay listed for a while so the renderer picks up the outcome
 * after navigating back.
 */
export class DriftJobs {
  private readonly jobs = new Map<string, DriftJob>()
  /** Results too large to save, kept for this session. */
  private readonly unsaved = new Map<string, SavedDriftResult>()
  /** The storage account each job compares, as it was when the job started. */
  private readonly storage = new Map<string, string>()

  constructor(private readonly deps: DriftJobDeps) {}

  list(): DriftJobSummary[] {
    this.prune()
    return [...this.jobs.values()].map(summary)
  }

  /** Starts a scan of the tenant, or returns the one already running for the same pair. */
  async start(tenantId: string, pair: { baseline?: unknown; comparison?: unknown } = {}): Promise<DriftJobSummary> {
    const tenant = this.connected(tenantId)
    const storageAccountName = this.deps.tenant(tenant)!.storageAccountName
    try {
      await this.deps.plan(tenant)
    } catch (error) {
      throw new DriftJobError(error instanceof Error ? error.message : "This tenant is not licensed.", 403)
    }
    const baseline = pair.baseline ?? null
    const comparison = pair.comparison ?? null
    if ((baseline === null) !== (comparison === null)) throw new DriftJobError("Choose both a baseline and a comparison backup.")
    if (baseline !== null && (typeof baseline !== "string" || typeof comparison !== "string" || !BACKUP_NAME.test(baseline) || !BACKUP_NAME.test(comparison))) {
      throw new DriftJobError("Choose backups from this tenant's backup list.")
    }

    const running = [...this.jobs.values()].find((job) => job.tenantId === tenant && job.status === "running")
    if (running) {
      if (baseline === null || (running.baseline === baseline && running.comparison === comparison)) return summary(running)
      throw new DriftJobError("A drift scan is already running for this tenant. Wait for it to finish or cancel it first.", 409)
    }

    const controller = new AbortController()
    const job: DriftJob = {
      jobId: randomUUID(), tenantId: tenant, status: "running", phase: "checking", detail: "Checking the backups", done: 0, total: 0, percent: 1,
      startedAt: new Date().toISOString(), baseline: baseline as string | null, comparison: comparison as string | null, controller, settled: Promise.resolve(),
    }
    this.storage.set(job.jobId, storageAccountName)
    this.prune()
    this.jobs.set(job.jobId, job)
    job.settled = this.run(job)
    return summary(job)
  }

  /** Stops a running scan: no further backup files are read and nothing is saved. */
  cancel(tenantId: string, jobId: unknown): DriftJobSummary {
    const job = typeof jobId === "string" ? this.jobs.get(jobId) : undefined
    if (!job || job.tenantId !== tenantId.toLowerCase()) throw new DriftJobError("Drift scan not found.", 404)
    if (job.status === "running") {
      job.controller.abort()
      Object.assign(job, { status: "cancelled", detail: "Drift scan cancelled", finishedAt: new Date().toISOString() })
    }
    return summary(job)
  }

  /**
   * The tenant's last saved result, or null when it has none. A result of the backups in another
   * storage account (the tenant moved, for example from Azure to this device) is not shown: its
   * backups and revert targets are not where the tenant's backups are now.
   */
  result(tenantId: string): SavedDriftResult | null {
    const tenant = tenantId.toLowerCase()
    const storage = this.deps.tenant(tenant)?.storageAccountName.toLowerCase()
    const current = (value: SavedDriftResult | null | undefined) => (value && value.storageAccountName?.toLowerCase() === storage ? value : null)
    const memory = this.unsaved.get(tenant)
    if (memory) return current(memory)
    const raw = this.deps.store.get(resultKey(tenant))
    if (!raw) return null
    try {
      const value = JSON.parse(raw) as SavedDriftResult
      return current(value?.schemaVersion === 1 && value.tenantId === tenant && Array.isArray(value.drifts) && value.baseline && value.comparison ? value : null)
    } catch {
      return null
    }
  }

  /** Resolves once the job has finished; for tests and shutdown. */
  async settled(jobId: string): Promise<void> {
    await this.jobs.get(jobId)?.settled
  }

  private connected(tenantId: unknown): string {
    if (!isGuid(tenantId)) throw new DriftJobError("Select a tenant first.")
    if (!this.deps.tenant(tenantId)) throw new DriftJobError("This tenant is no longer connected.", 404)
    return tenantId.toLowerCase()
  }

  private async run(job: DriftJob): Promise<void> {
    const { signal } = job.controller
    const unregister = registerDriftScan(job.jobId, {
      tenantId: job.tenantId,
      signal,
      onProgress: (progress) => {
        if (job.status !== "running") return
        Object.assign(job, { phase: progress.phase, detail: progress.detail, done: progress.done, total: progress.total, percent: percentOf(progress) })
      },
    })
    try {
      const response = await this.deps.api("/api/detect-drifts", job.tenantId, {
        scanId: job.jobId,
        ...(job.baseline !== null ? { baseline: job.baseline, comparison: job.comparison } : {}),
      })
      const data = (await response.json().catch(() => ({}))) as Partial<DriftResult> & { error?: string; code?: string }
      if (signal.aborted) return
      if (!response.ok || !Array.isArray(data.drifts) || !data.baseline || !data.comparison) {
        Object.assign(job, { status: "failed", detail: "Drift scan failed", error: data.error ?? `Drift scan failed (${response.status}).`, code: data.code, finishedAt: new Date().toISOString() })
        return
      }
      const saved: SavedDriftResult = { ...(data as DriftResult), schemaVersion: 1, tenantId: job.tenantId, jobId: job.jobId, storageAccountName: this.storage.get(job.jobId)! }
      const json = JSON.stringify(saved)
      if (json.length > MAX_SAVED_LENGTH) this.unsaved.set(job.tenantId, saved)
      else {
        this.unsaved.delete(job.tenantId)
        this.deps.store.set(resultKey(job.tenantId), json)
      }
      Object.assign(job, { status: "completed", detail: "Drift scan complete", percent: 100, summary: saved.summary, finishedAt: new Date().toISOString() })
    } catch (error) {
      if (signal.aborted) return
      Object.assign(job, { status: "failed", detail: "Drift scan failed", error: error instanceof Error ? error.message : "Drift scan failed.", finishedAt: new Date().toISOString() })
    } finally {
      unregister()
      this.storage.delete(job.jobId)
      this.deps.notify?.(summary(job))
    }
  }

  private prune(now = Date.now()): void {
    for (const [id, job] of this.jobs) if (job.finishedAt && now - Date.parse(job.finishedAt) > FINISHED_JOB_TTL) this.jobs.delete(id)
  }
}

function summary({ controller: _controller, settled: _settled, ...job }: DriftJob): DriftJobSummary {
  return { ...job }
}

function resultKey(tenantId: string): string {
  return `drift.result.v1.${tenantId}`
}

/**
 * POST /api/drift-scan { action, ... }:
 *   jobs                                        -> { jobs }   every tenant's running and recent scans
 *   start  { tenantId, baseline?, comparison? } -> { job }    returns at once; the scan runs in the background
 *   cancel { tenantId, jobId }                  -> { job }
 *   result { tenantId }                         -> { result } the tenant's last saved result, or null
 */
export function driftScanRoutes(jobs: DriftJobs): Record<string, RouteModule> {
  return {
    "/api/drift-scan": {
      POST: async (request: NextRequest) => {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid request" }, { status: 400 })
        try {
          switch (body.action) {
            case "jobs":
              return Response.json({ jobs: jobs.list() })
            case "start":
              return Response.json({ job: await jobs.start(String(body.tenantId ?? ""), { baseline: body.baseline, comparison: body.comparison }) })
            case "cancel":
              if (!isGuid(body.tenantId)) throw new DriftJobError("Select a tenant first.")
              return Response.json({ job: jobs.cancel(body.tenantId, body.jobId) })
            case "result":
              if (!isGuid(body.tenantId)) throw new DriftJobError("Select a tenant first.")
              return Response.json({ result: jobs.result(body.tenantId) })
            default:
              return Response.json({ error: "Unknown action" }, { status: 400 })
          }
        } catch (error) {
          if (error instanceof DriftJobError) return Response.json({ error: error.message }, { status: error.status })
          throw error
        }
      },
    },
  }
}
