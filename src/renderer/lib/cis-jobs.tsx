import { useEffect, useSyncExternalStore } from "react"
import { useLocation } from "react-router-dom"
import type { AssessJobSummary } from "../../main/frameworks/service"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { createJobPoller } from "./job-store"
import { toast } from "./toast"

export type CisJob = AssessJobSummary

/**
 * Pack assessments (CIS Benchmarks and other policy pack comparisons) run in the main process.
 * This store mirrors their progress for every page, so an assessment started on the framework
 * page stays visible in the background activity panel while the admin works elsewhere, and a
 * toast says when it is done. The framework page itself still follows its run in detail through
 * assess-status; this store only reads the lightweight assess-jobs summaries.
 */
let jobs: CisJob[] = []
const listeners = new Set<() => void>()
const finishListeners = new Set<(job: CisJob) => void>()
let loaded = false
// Responses to polls sent before a local change are stale and must not undo it.
let revision = 0

function emit() {
  for (const listener of listeners) listener()
}

async function request<T>(body: object): Promise<T> {
  const response = await fetch("/api/frameworks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const value = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? "Framework request failed.")
  return value
}

function apply(next: CisJob[]) {
  revision++
  const previous = new Map(jobs.map((job) => [job.jobId, job]))
  jobs = next
  emit()
  // Only jobs this window saw running announce their end, not ones finished before a reload.
  for (const job of next) if (job.status !== "running" && previous.get(job.jobId)?.status === "running") for (const listener of finishListeners) listener(job)
  schedule()
}

const poller = createJobPoller<string>({ intervalMs: 1000, poll: async () => { await refreshCisJobs() } })

function schedule() {
  if (jobs.some((job) => job.status === "running")) poller.track("jobs", { immediate: false })
  else poller.untrack("jobs")
}

export async function refreshCisJobs(): Promise<void> {
  const sent = revision
  try {
    const { jobs: next } = await request<{ jobs: CisJob[] }>({ action: "assess-jobs" })
    if (!Array.isArray(next)) throw new Error("Framework request failed.")
    if (sent === revision) apply(next)
    else schedule()
  } catch {
    loaded = false
    schedule()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!loaded) {
    loaded = true
    void refreshCisJobs()
  }
  return () => void listeners.delete(listener)
}

export function useCisJobs(): CisJob[] {
  return useSyncExternalStore(subscribe, () => jobs)
}

export function onCisJobFinished(listener: (job: CisJob) => void): () => void {
  finishListeners.add(listener)
  return () => void finishListeners.delete(listener)
}

/** Mounted once in the layout: announces finished pack assessments on whichever page is open. */
export function CisJobNotifier() {
  const { pathname } = useLocation()
  const { selectedTenant } = useSelectedTenant()
  const selected = selectedTenant?.credentials?.tenantId.toLowerCase()
  useCisJobs()
  useEffect(() => onCisJobFinished((job) => {
    // The route selects the tenant the assessment ran for, which may not be the one on screen.
    const route = `/portal/frameworks/${job.frameworkId}?tenant=${job.tenantId}`
    // The framework page of that tenant shows its own result, so a toast there would only repeat it.
    if (pathname === `/portal/frameworks/${job.frameworkId}` && selected === job.tenantId && document.hasFocus()) return
    if (job.status === "done") toast(`Assessment of ${job.reference} is ready.`, "success", { label: "View results", href: route })
    else if (job.status === "failed") toast(`Assessment of ${job.reference} failed. ${job.error ?? ""}`.trim(), "error", { label: "Open", href: route })
  }), [pathname, selected])
  return null
}
