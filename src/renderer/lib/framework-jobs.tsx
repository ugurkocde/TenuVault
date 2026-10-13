import { useEffect, useSyncExternalStore } from "react"
import { useLocation } from "react-router-dom"
import type { NativeJobSummary } from "../../main/frameworks/native"
import type { AssessmentScope } from "../../shared/compliance/types"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { createJobPoller } from "./job-store"
import { toast } from "./toast"

export type FrameworkJob = NativeJobSummary

/**
 * Framework comparisons run in the main process. This store mirrors their progress for
 * every page, so a comparison keeps going (and stays visible in the sidebar) while the
 * admin works elsewhere, and a toast says when it is done.
 */
let jobs: FrameworkJob[] = []
const listeners = new Set<() => void>()
const finishListeners = new Set<(job: FrameworkJob) => void>()
let loaded = false
// Responses to polls sent before a local change are stale and must not undo it.
let revision = 0

function emit() {
  for (const listener of listeners) listener()
}

async function request<T>(body: object): Promise<T> {
  const response = await fetch("/api/frameworks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const value = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? "Framework request failed.")
  return value
}

function apply(next: FrameworkJob[]) {
  revision++
  const previous = new Map(jobs.map((job) => [job.jobId, job]))
  jobs = next
  emit()
  // Only jobs this window saw running announce their end, not ones finished before a reload.
  for (const job of next) if (job.status !== "running" && previous.get(job.jobId)?.status === "running") for (const listener of finishListeners) listener(job)
  schedule()
}

const poller = createJobPoller<string>({ intervalMs: 1000, poll: async () => { await refreshFrameworkJobs() } })

function schedule() {
  if (jobs.some((job) => job.status === "running")) poller.track("jobs", { immediate: false })
  else poller.untrack("jobs")
}

export async function refreshFrameworkJobs(): Promise<void> {
  const sent = revision
  try {
    const { jobs: next } = await request<{ jobs: FrameworkJob[] }>({ action: "native-jobs" })
    if (sent === revision) apply(next)
    else schedule()
  } catch {
    loaded = false
    schedule()
  }
}

export async function startFrameworkJob(body: { tenantId: string; appId: string; frameworkId: string; scope: AssessmentScope }): Promise<FrameworkJob> {
  const { job } = await request<{ job: FrameworkJob }>({ ...body, action: "native-start" })
  apply([job, ...jobs.filter((item) => item.jobId !== job.jobId)])
  return job
}

export async function cancelFrameworkJob(job: FrameworkJob, appId?: string): Promise<void> {
  await request({ action: "native-cancel", jobId: job.jobId, tenantId: job.tenantId, appId, frameworkId: job.frameworkId })
  await refreshFrameworkJobs()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!loaded) {
    loaded = true
    void refreshFrameworkJobs()
  }
  return () => void listeners.delete(listener)
}

export function useFrameworkJobs(): FrameworkJob[] {
  return useSyncExternalStore(subscribe, () => jobs)
}

/** The newest comparison of one framework for one tenant, running or recently finished. */
export function useFrameworkJob(tenantId: string | undefined, frameworkId: string): FrameworkJob | undefined {
  const all = useFrameworkJobs()
  if (!tenantId) return undefined
  return all
    .filter((job) => job.tenantId === tenantId.toLowerCase() && job.frameworkId === frameworkId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
}

export function onFrameworkJobFinished(listener: (job: FrameworkJob) => void): () => void {
  finishListeners.add(listener)
  return () => void finishListeners.delete(listener)
}

/** Mounted once in the layout: announces finished comparisons on whichever page is open. */
export function FrameworkJobNotifier() {
  const { pathname } = useLocation()
  const { selectedTenant } = useSelectedTenant()
  const selected = selectedTenant?.credentials?.tenantId.toLowerCase()
  useFrameworkJobs()
  useEffect(() => onFrameworkJobFinished((job) => {
    // The route selects the tenant the comparison ran for, which may not be the one on screen.
    const route = `/portal/frameworks/${job.frameworkId}?tenant=${job.tenantId}`
    // The framework page of that tenant shows its own result, so a toast there would only repeat it.
    if (pathname === `/portal/frameworks/${job.frameworkId}` && selected === job.tenantId && document.hasFocus()) return
    if (job.status === "completed") toast(`${job.frameworkName} comparison is ready.`, "success", { label: "View results", href: route })
    else if (job.status === "failed") toast(`${job.frameworkName} comparison failed. ${job.error ?? ""}`.trim(), "error", { label: "Open", href: route })
  }), [pathname, selected])
  return null
}
