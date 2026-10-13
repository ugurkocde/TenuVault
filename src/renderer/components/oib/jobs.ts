import { useEffect, useRef, useSyncExternalStore } from "react"
import type { OibProgress } from "../../../shared/oib/types"
import { createJobPoller } from "../../lib/job-store"
import { errorText, oibRequest } from "./common"
import type { Progress } from "./FlowShell"

export type OibFlow = "new" | "existing" | "validate"
export type OibJobKind = "deploy" | "fix" | "undo" | "validate"

/** A deployment, drift fix, undo or validation that keeps running when its page unmounts. */
export interface OibJob<T = unknown> {
  id: string
  tenantId: string
  tenantName: string
  kind: OibJobKind
  /** The workflow that started the job; absent for the overview. */
  flow?: OibFlow
  /** "Deploying to Contoso" */
  label: string
  stage: string
  /** Names the tenant and platform of the current step, for example "Contoso, Windows". */
  detail?: string
  done: number
  total: number
  /** Backup progress, 0 to 100. */
  percent?: number
  backupJobId?: string
  /** The tenant the backup job runs for; differs from tenantId for the later tenants of a multi-tenant deployment. */
  backupTenantId?: string
  startedAt: string
  finishedAt?: string
  /** What the work returned, or what it has produced so far (see JobContext.setResult). */
  result?: T
  error?: string
  /** The finished job was seen in its workflow or dismissed in the indicator. */
  seen?: boolean
}

export interface JobContext<T> {
  update: (changes: Partial<Pick<OibJob, "stage" | "detail" | "done" | "total" | "percent">>) => void
  /** Partial results while the job runs; the work's return value replaces them. */
  setResult: (result: T) => void
  /** The tenant whose oib-progress is polled; the job's tenant by default. MSP runs switch it per tenant. */
  poll: (tenantId: string) => void
}

let jobs: OibJob[] = []
const listeners = new Set<() => void>()
const finishListeners = new Set<(job: OibJob) => void>()
const polls = new Map<string, { tenantId: string; scope?: "validate" }>()

/** Deploy, fix and undo share the main process's per-tenant lock; validation has its own. */
const lane = (kind: OibJobKind) => kind === "validate" ? "validate" : "change"
const running = (job: OibJob) => !job.finishedAt

function emit() {
  for (const listener of listeners) listener()
}

function patch(id: string, changes: Partial<OibJob>) {
  jobs = jobs.map(job => job.id === id ? { ...job, ...changes } : job)
  emit()
}

const poller = createJobPoller<string>({
  intervalMs: 1000,
  poll: async (id, isCurrent) => {
    const target = polls.get(id)
    if (!target) return
    const progress = await oibRequest<OibProgress | null>({ action: "oib-progress", tenantId: target.tenantId, ...(target.scope ? { scope: target.scope } : {}) })
    if (!isCurrent()) return
    const job = jobs.find(j => j.id === id)
    // The main process forgets a job's progress when it ends; the last stage stays until the work returns.
    if (!progress || !job || !running(job)) return
    patch(id, { stage: progress.stage, done: progress.done, total: progress.total, percent: progress.percent, ...(progress.backupJobId ? { backupJobId: progress.backupJobId, backupTenantId: target.tenantId } : {}) })
  },
  onError: () => undefined,
})

/** The running job that blocks starting `kind` for this tenant, if any. */
export function blockingJob(tenantId: string, kind: OibJobKind): OibJob | undefined {
  return jobs.find(job => running(job) && job.tenantId === tenantId && lane(job.kind) === lane(kind))
}

/**
 * Starts a job and resolves with the finished job; it never rejects, a failure is in `error`.
 * Throws at once when a job of the same lane is already running for the tenant.
 * Finished jobs of the same tenant and kind (and flow, for deploy and fix) are replaced.
 */
export function startJob<T>(spec: { tenantId: string; tenantName: string; kind: OibJobKind; flow?: OibFlow; label: string; stage?: string }, work: (context: JobContext<T>) => Promise<T>): Promise<OibJob<T>> {
  const blocking = blockingJob(spec.tenantId, spec.kind)
  if (blocking) throw new Error(`${blocking.label} is still running. Wait for it to finish first.`)
  const id = `${spec.tenantId}:${spec.kind}:${Date.now()}`
  const job: OibJob = { id, tenantId: spec.tenantId, tenantName: spec.tenantName, kind: spec.kind, flow: spec.flow, label: spec.label, stage: spec.stage ?? "Starting", done: 0, total: 0, startedAt: new Date().toISOString() }
  // Only the finished job this one supersedes goes; an undo keeps a deploy result on screen and the other way round.
  jobs = [job, ...jobs.filter(j => !(j.tenantId === spec.tenantId && j.kind === spec.kind && (spec.kind === "undo" || spec.kind === "validate" || j.flow === spec.flow)))]
  polls.set(id, { tenantId: spec.tenantId, ...(spec.kind === "validate" ? { scope: "validate" as const } : {}) })
  poller.track(id, { immediate: false })
  emit()
  const context: JobContext<T> = {
    update: changes => patch(id, changes),
    setResult: result => patch(id, { result }),
    poll: tenantId => { polls.set(id, { ...polls.get(id)!, tenantId }); patch(id, { stage: "Starting", done: 0, total: 0, percent: undefined }) },
  }
  return work(context).then(result => ({ result }), (error: unknown) => ({ error: errorText(error) })).then(outcome => {
    polls.delete(id)
    poller.untrack(id)
    patch(id, { ...outcome, finishedAt: new Date().toISOString(), percent: undefined })
    const finished = jobs.find(j => j.id === id)!
    for (const listener of finishListeners) listener(finished)
    return finished as OibJob<T>
  })
}

export function getJob(id: string): OibJob | undefined {
  return jobs.find(job => job.id === id)
}

/** Removes a finished job; a running job is kept. */
export function clearJob(id: string): void {
  if (!jobs.some(job => job.id === id && !running(job))) return
  jobs = jobs.filter(job => job.id !== id)
  emit()
}

/** Hides a finished job from the global indicator. */
export function markSeen(id: string): void {
  if (jobs.some(job => job.id === id && !job.seen)) patch(id, { seen: true })
}

export function subscribeJobs(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function onJobFinished(listener: (job: OibJob) => void): () => void {
  finishListeners.add(listener)
  return () => void finishListeners.delete(listener)
}

export function useOibJobs(): OibJob[] {
  return useSyncExternalStore(subscribeJobs, () => jobs)
}

/** The newest job of a tenant matching the kinds and flow given (running or finished). */
export function useOibJob<T = unknown>(tenantId: string | undefined, match: { kind?: OibJobKind | OibJobKind[]; flow?: OibFlow } = {}): OibJob<T> | undefined {
  const all = useOibJobs()
  const kinds = match.kind === undefined ? undefined : Array.isArray(match.kind) ? match.kind : [match.kind]
  return all.find(job => job.tenantId === tenantId && (!kinds || kinds.includes(job.kind)) && (!match.flow || job.flow === match.flow)) as OibJob<T> | undefined
}

/** A running job of the tenant, of any kind; undo and new deployments wait for it. */
export function useRunningJob(tenantId: string | undefined): OibJob | undefined {
  return useOibJobs().find(job => job.tenantId === tenantId && running(job))
}

/** A running deploy, fix or undo of the tenant (the main process allows one at a time). */
export function useBlockingJob(tenantId: string | undefined, kind: OibJobKind): OibJob | undefined {
  return useOibJobs().find(job => job.tenantId === tenantId && running(job) && lane(job.kind) === lane(kind))
}

/** Calls `callback` when the job finishes while the component is mounted (not for a job that had finished before). */
export function useJobFinished<T>(job: OibJob<T> | undefined, callback: ((job: OibJob<T>) => void) | undefined) {
  const handled = useRef(job?.finishedAt ? job.id : undefined)
  const latest = useRef(callback)
  latest.current = callback
  useEffect(() => {
    if (!job?.finishedAt || handled.current === job.id) return
    handled.current = job.id
    latest.current?.(job)
  }, [job?.id, job?.finishedAt])
}

/** The job's live line for ActionBar, prefixed with its tenant and platform when set; null once finished. */
export function jobProgress(job: OibJob | undefined): Progress | null {
  if (!job || job.finishedAt) return null
  return { stage: job.detail ? `${job.detail}: ${job.stage}` : job.stage, done: job.done, total: job.total, percent: job.percent }
}

const DONE: Record<OibJobKind, string> = { deploy: "Deployment", fix: "Drift fix", undo: "Undo", validate: "Validation" }

/** "Deploying to Contoso" while running, then "Deployment finished in Contoso" or "Deployment failed in Contoso". */
export const jobTitle = (job: OibJob) => job.finishedAt ? `${DONE[job.kind]} ${job.error ? "failed" : "finished"} in ${job.tenantName}` : job.label

/** The route of the workflow that started the job. */
export const jobRoute = (job: OibJob) => job.flow ? `/portal/oib/${job.flow}` : "/portal/oib"
