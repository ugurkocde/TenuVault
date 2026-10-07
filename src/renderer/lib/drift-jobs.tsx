import { useEffect, useSyncExternalStore } from "react"
import { useLocation } from "react-router-dom"
import { LoaderCircle } from "lucide-react"
import type { DriftJobSummary, SavedDriftResult } from "../../main/drift/jobs"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { toast } from "./toast"

export type DriftJob = DriftJobSummary
export type { SavedDriftResult }

/**
 * Drift scans run in the main process. This store mirrors their progress and each tenant's
 * last saved result for every page, so a scan keeps going (and shows in the sidebar) while the
 * admin works elsewhere, the drift page shows the saved result at once when it opens again, and
 * a toast says when a scan is done.
 */
interface State {
  jobs: DriftJob[]
  /** Last saved result per tenant; null when the tenant has none, missing until loaded. */
  results: Record<string, SavedDriftResult | null>
}

let state: State = { jobs: [], results: {} }
const listeners = new Set<() => void>()
const finishListeners = new Set<(job: DriftJob) => void>()
const loadingResults = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined
let loaded = false
// Responses to polls sent before a local change are stale and must not undo it.
let revision = 0

function emit() {
  for (const listener of listeners) listener()
}

async function request<T>(body: object): Promise<T> {
  const response = await fetch("/api/drift-scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const value = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? "Drift scan request failed.")
  return value
}

function apply(next: DriftJob[]) {
  revision++
  const previous = new Map(state.jobs.map((job) => [job.jobId, job]))
  state = { ...state, jobs: next }
  emit()
  for (const job of next) {
    if (job.status === "running" || previous.get(job.jobId)?.status !== "running") continue
    // Only jobs this window saw running announce their end, not ones finished before a reload.
    if (job.status === "completed") void loadDriftResult(job.tenantId, true).then(() => finishListeners.forEach((listener) => listener(job)))
    else for (const listener of finishListeners) listener(job)
  }
  schedule()
}

function schedule() {
  clearTimeout(timer)
  timer = state.jobs.some((job) => job.status === "running") ? setTimeout(() => void refreshDriftJobs(), 1000) : undefined
}

export async function refreshDriftJobs(): Promise<void> {
  const sent = revision
  try {
    const { jobs } = await request<{ jobs: DriftJob[] }>({ action: "jobs" })
    if (sent === revision) apply(jobs)
    else schedule()
  } catch {
    loaded = false
    schedule()
  }
}

/** Starts a scan of the tenant; without a pair, the two newest complete backups are compared. */
export async function startDriftScan(tenantId: string, pair?: { baseline: string; comparison: string }): Promise<DriftJob> {
  const { job } = await request<{ job: DriftJob }>({ action: "start", tenantId, ...pair })
  apply([job, ...state.jobs.filter((item) => item.jobId !== job.jobId)])
  return job
}

export async function cancelDriftScan(job: DriftJob): Promise<void> {
  await request({ action: "cancel", tenantId: job.tenantId, jobId: job.jobId })
  await refreshDriftJobs()
}

/** Reads the tenant's saved result from the main process, once unless `force`. */
export async function loadDriftResult(tenantId: string, force = false): Promise<void> {
  const tenant = tenantId.toLowerCase()
  if (!force && (tenant in state.results || loadingResults.has(tenant))) return
  loadingResults.add(tenant)
  try {
    const { result } = await request<{ result: SavedDriftResult | null }>({ action: "result", tenantId: tenant })
    state = { ...state, results: { ...state.results, [tenant]: result } }
  } catch {
    // Reported as no saved result; the page can still start a scan.
    if (!(tenant in state.results)) state = { ...state, results: { ...state.results, [tenant]: null } }
  } finally {
    loadingResults.delete(tenant)
    emit()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!loaded) {
    loaded = true
    void refreshDriftJobs()
  }
  return () => void listeners.delete(listener)
}

export function useDriftJobs(): DriftJob[] {
  return useSyncExternalStore(subscribe, () => state.jobs)
}

/** The newest scan of one tenant, running or recently finished. */
export function useDriftJob(tenantId: string | undefined): DriftJob | undefined {
  const all = useDriftJobs()
  if (!tenantId) return undefined
  return all.filter((job) => job.tenantId === tenantId.toLowerCase()).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
}

/** The tenant's saved result; `loaded` is false until the main process answered. */
export function useDriftResult(tenantId: string | undefined): { result: SavedDriftResult | null; loaded: boolean } {
  const results = useSyncExternalStore(subscribe, () => state.results)
  const tenant = tenantId?.toLowerCase()
  useEffect(() => {
    if (tenant) void loadDriftResult(tenant)
  }, [tenant])
  if (!tenant) return { result: null, loaded: true }
  return { result: results[tenant] ?? null, loaded: tenant in results }
}

export function onDriftScanFinished(listener: (job: DriftJob) => void): () => void {
  finishListeners.add(listener)
  return () => void finishListeners.delete(listener)
}

/** In the sidebar's Drift Detection entry while a scan runs. */
export function DriftScanIndicator() {
  const running = useDriftJobs().filter((job) => job.status === "running")
  if (!running.length) return null
  return <LoaderCircle className="ml-auto h-4 w-4 shrink-0 animate-spin" aria-label={`${running.length} drift scan${running.length === 1 ? "" : "s"} running`} />
}

/** Mounted once in the layout: announces finished drift scans on whichever page is open. */
export function DriftScanNotifier() {
  const { pathname } = useLocation()
  const { selectedTenant } = useSelectedTenant()
  const tenants = useTenants()
  const selected = selectedTenant?.credentials?.tenantId.toLowerCase()
  useDriftJobs()
  useEffect(() => onDriftScanFinished((job) => {
    // The drift page of that tenant shows its own result, so a toast there would only repeat it.
    if (pathname.replace(/\/$/, "") === "/portal/drift" && selected === job.tenantId) return
    const name = tenants.find((tenant) => tenant.credentials?.tenantId.toLowerCase() === job.tenantId)?.name ?? "this tenant"
    // The route selects the tenant the scan ran for, which may not be the one on screen.
    const route = `/portal/drift?tenant=${job.tenantId}`
    if (job.status === "completed") toast(`Drift scan of ${name} is ready: ${job.summary?.total ?? 0} change${job.summary?.total === 1 ? "" : "s"}.`, "success", { label: "View results", href: route })
    else if (job.status === "failed") toast(`Drift scan of ${name} failed. ${job.error ?? ""}`.trim(), "error", { label: "Open", href: route })
  }), [pathname, selected, tenants])
  return null
}
