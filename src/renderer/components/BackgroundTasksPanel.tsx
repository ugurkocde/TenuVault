import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { CheckCircle2, ChevronDown, ChevronUp, LoaderCircle, X, XCircle } from "lucide-react"
import { Progress } from "~/components/ui/progress"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { cisRunDisplayPhase, cisRunHeading, cisRunProgress } from "../../shared/frameworks/cis-run"
import { clearFinishedBackgroundTasks, dismissBackgroundTask, noteBackgroundTaskTenant, taskHref, useBackgroundTasks } from "../lib/background-tasks"
import { useCisJobs } from "../lib/cis-jobs"
import { cancelDriftScan, useDriftJobs } from "../lib/drift-jobs"
import { cancelFrameworkJob, useFrameworkJobs } from "../lib/framework-jobs"
import { toast } from "../lib/toast"

type PanelStatus = "running" | "completed" | "failed" | "cancelled"

interface PanelTask {
  id: string
  title: string
  subtitle?: string
  detail?: string
  /** 0 to 100; undefined shows an indeterminate bar. */
  percent?: number
  status: PanelStatus
  startedAt: number
  href?: string
  tenantId?: string
  cancel?: () => Promise<void>
  dismiss?: () => void
  onOpen?: () => void
}

/** How long a finished mirrored job stays in the panel. Failures stay until dismissed. */
const FINISHED_VISIBLE_MS = 30_000

function elapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const STATUS_LABEL: Record<PanelStatus, string> = {
  running: "Running in the background",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
}

function TaskCard({ task, now }: { task: PanelTask; now: number }) {
  const [cancelling, setCancelling] = useState(false)
  const running = task.status === "running"
  const Icon = running ? LoaderCircle : task.status === "completed" ? CheckCircle2 : XCircle
  const cancel = () => {
    if (!task.cancel) return
    setCancelling(true)
    void task.cancel().catch((error: unknown) => {
      setCancelling(false)
      toast(error instanceof Error ? error.message : "The task could not be cancelled.", "error")
    })
  }
  return (
    <li className="rounded-2xl bg-secondary p-3">
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", running ? "animate-spin text-blue-700" : task.status === "completed" ? "text-green-700" : "text-destructive")} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
          {task.subtitle && <p className="truncate text-xs text-muted-foreground">{task.subtitle}</p>}
          <p className="mt-0.5 text-xs text-muted-foreground" aria-live={running ? undefined : "polite"}>
            {task.detail ?? STATUS_LABEL[task.status]}
            {running && <span className="tabular-nums"> · {elapsed(task.startedAt, now)}</span>}
          </p>
          {running && task.percent !== undefined && (
            <div className="mt-2 flex items-center gap-2">
              <Progress value={task.percent} className="h-1.5 flex-1 bg-gray-200 [&>div]:bg-primary" aria-label={`${task.title} progress`} />
              <span className="text-xs font-medium tabular-nums text-muted-foreground">{task.percent}%</span>
            </div>
          )}
          {running && task.percent === undefined && (
            <div role="progressbar" aria-label={`${task.title} in progress`} className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200">
              <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
            </div>
          )}
          {(task.href || (running && task.cancel)) && (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-medium">
              {task.href && (
                <Link to={task.href} onClick={task.onOpen} className="text-blue-700 hover:underline">
                  {task.status === "completed" ? "View results" : "Open"}
                </Link>
              )}
              {running && task.cancel && (
                <button type="button" disabled={cancelling} onClick={cancel} className="text-muted-foreground hover:text-foreground disabled:opacity-50">
                  {cancelling ? "Cancelling" : "Cancel"}
                </button>
              )}
            </div>
          )}
        </div>
        {task.dismiss && (
          <button type="button" onClick={task.dismiss} className="-mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground" aria-label={`Dismiss ${task.title}`}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  )
}

/**
 * The background activity panel, fixed at the bottom right above the backup progress panel.
 * It mirrors every long-running job the app knows about: drift scans, framework comparisons
 * and pack assessments from the main process, plus renderer background tasks (hygiene scans,
 * health reviews, exports). Backups keep their own richer panel below this one. Work keeps
 * running whichever page is open; this panel is where its progress and outcome stay visible.
 */
export function BackgroundTasksPanel() {
  const local = useBackgroundTasks()
  const driftJobs = useDriftJobs()
  const frameworkJobs = useFrameworkJobs()
  const cisJobs = useCisJobs()
  const tenants = useTenants()
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  useEffect(() => { noteBackgroundTaskTenant(selectedTenant?.credentials?.tenantId) }, [selectedTenant?.credentials?.tenantId])
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(Date.now())
  const panel = useRef<HTMLDivElement>(null)
  // Mirrored jobs this window saw running; only their finish is shown, not older history.
  const seenRunning = useRef(new Set<string>())
  // Failures observed this session, kept after the main process prunes its job history.
  const retainedFailures = useRef(new Map<string, PanelTask>())

  const tenantName = (tenantId: string) =>
    tenants.find((tenant) => tenant.credentials?.tenantId.toLowerCase() === tenantId.toLowerCase())?.name
  const selectTenant = (tenantId: string | undefined) => {
    if (!tenantId) return
    const match = tenants.find((tenant) => tenant.credentials?.tenantId.toLowerCase() === tenantId.toLowerCase())
    if (match && match.id !== selectedTenant?.id) setSelectedTenantId(match.id)
  }
  const dismissMirrored = (id: string) => {
    retainedFailures.current.delete(id)
    setDismissed((prev) => new Set(prev).add(id))
  }

  const mirrored: PanelTask[] = []
  const consider = (task: PanelTask, finishedAt?: string) => {
    if (task.status === "running") seenRunning.current.add(task.id)
    if (dismissed.has(task.id)) return
    const openable = { ...task, onOpen: () => selectTenant(task.tenantId) }
    if (task.status === "running") {
      mirrored.push(openable)
      return
    }
    if (!seenRunning.current.has(task.id)) return
    if (task.status === "completed" && finishedAt && now - Date.parse(finishedAt) > FINISHED_VISIBLE_MS) return
    const finished = { ...openable, dismiss: () => dismissMirrored(task.id) }
    if (task.status === "failed") retainedFailures.current.set(task.id, finished)
    mirrored.push(finished)
  }
  for (const job of driftJobs) {
    consider({
      id: `drift:${job.jobId}`,
      title: "Drift scan",
      subtitle: tenantName(job.tenantId),
      detail: job.status === "completed" ? `${job.summary?.total ?? 0} change${job.summary?.total === 1 ? "" : "s"} found` : job.status === "failed" ? job.error : job.detail,
      percent: job.percent,
      status: job.status,
      startedAt: Date.parse(job.startedAt),
      href: `/portal/drift?tenant=${job.tenantId}`,
      tenantId: job.tenantId,
      cancel: job.status === "running" ? () => cancelDriftScan(job) : undefined,
    }, job.finishedAt)
  }
  for (const job of frameworkJobs) {
    consider({
      id: `framework:${job.jobId}`,
      title: `${job.frameworkName} comparison`,
      subtitle: tenantName(job.tenantId),
      detail: job.status === "failed" ? job.error : job.detail,
      percent: job.percent,
      status: job.status,
      startedAt: Date.parse(job.startedAt),
      href: `/portal/frameworks/${job.frameworkId}?tenant=${job.tenantId}`,
      tenantId: job.tenantId,
      cancel: job.status === "running" ? () => cancelFrameworkJob(job) : undefined,
    }, job.finishedAt)
  }
  for (const job of cisJobs) {
    const percent = cisRunProgress(job) ?? undefined
    consider({
      id: `cis:${job.jobId}`,
      title: job.frameworkId === "cis-benchmarks" ? "CIS assessment" : "Policy pack comparison",
      subtitle: job.reference,
      detail: job.status === "failed" ? job.error ?? undefined : job.status === "done" ? "Assessment complete" : cisRunHeading(cisRunDisplayPhase(job)),
      percent,
      status: job.status === "done" ? "completed" : job.status,
      startedAt: Date.parse(job.startedAt),
      href: `/portal/frameworks/${job.frameworkId}?tenant=${job.tenantId}`,
      tenantId: job.tenantId,
    }, job.finishedAt ?? undefined)
  }

  // Failures stay until dismissed even after main prunes them from its job lists.
  const mirroredIds = new Set(mirrored.map((task) => task.id))
  for (const retained of retainedFailures.current.values()) {
    if (!mirroredIds.has(retained.id) && !dismissed.has(retained.id)) mirrored.push(retained)
  }

  const tasks: PanelTask[] = [
    ...mirrored,
    ...local.map<PanelTask>((task) => ({
      id: task.id,
      title: task.title,
      detail: task.detail,
      percent: task.percent,
      status: task.status,
      startedAt: task.startedAt,
      href: taskHref(task),
      tenantId: task.tenantId,
      onOpen: () => selectTenant(task.tenantId),
      dismiss: task.status !== "running" ? () => dismissBackgroundTask(task.id) : undefined,
    })),
  ].sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || b.startedAt - a.startedAt)

  const runningCount = tasks.filter((task) => task.status === "running").length
  const shown = tasks.length > 0

  // Elapsed labels and the finished window move with the clock only while the panel shows.
  useEffect(() => {
    if (!shown) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [shown])

  // --background-tasks-offset lets the page end scroll clear of this panel, next to the offset
  // the backup panel already publishes for the same corner.
  useLayoutEffect(() => {
    const root = document.documentElement
    const element = panel.current
    if (!shown || !element) {
      root.style.removeProperty("--background-tasks-offset")
      return
    }
    const set = () => root.style.setProperty("--background-tasks-offset", `${element.offsetHeight + 24}px`)
    set()
    const observer = new ResizeObserver(set)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty("--background-tasks-offset")
    }
  }, [shown])

  if (!shown) return null

  const clearFinished = () => {
    clearFinishedBackgroundTasks()
    for (const task of mirrored) if (task.status !== "running") retainedFailures.current.delete(task.id)
    setDismissed((prev) => new Set([...prev, ...mirrored.filter((task) => task.status !== "running").map((task) => task.id)]))
  }

  return (
    <div ref={panel} className="fixed bottom-[calc(var(--floating-progress-offset,1rem)+0.5rem)] right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)]">
      <section aria-label="Background activity" className="overflow-hidden rounded-3xl border border-border bg-card shadow-[0_12px_32px_-12px_rgba(22,21,20,0.35)]">
        <div className="flex items-center gap-2 px-4 py-3">
          {runningCount > 0 ? (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-blue-700" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-700" aria-hidden="true" />
          )}
          <h2 className="flex-1 text-sm font-medium tracking-tight text-foreground">
            Background activity
            <span className="ml-2 font-normal text-muted-foreground">
              {runningCount > 0 ? `${runningCount} running` : "Done"}
            </span>
          </h2>
          {tasks.some((task) => task.status !== "running") && (
            <button type="button" onClick={clearFinished} className="text-xs font-medium text-muted-foreground hover:text-foreground">
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="rounded-full p-1 text-muted-foreground hover:text-foreground"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Show background tasks" : "Hide background tasks"}
          >
            {collapsed ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
        {!collapsed && (
          <ul className="max-h-[50vh] space-y-2 overflow-y-auto px-3 pb-3">
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} now={now} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
