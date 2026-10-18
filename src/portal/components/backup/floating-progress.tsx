"use client"

import { useState, useEffect, useLayoutEffect, useRef } from "react"
import { useBackupProgress, type BackupJob } from "~/contexts/BackupProgressContext"
import { Progress } from "~/components/ui/progress"
import { cn } from "~/lib/utils"
import { bridge } from "@desktop/lib/bridge"
import { FirstBackupNote } from "@desktop/components/FirstBackupNote"
import { tenantLicense, tenantPlan, useLicense } from "@desktop/lib/license"
import { azureStoragePortalUrl } from "~/lib/azure-portal"
import { backupActivitySummary, backupJobPhase, type BackupJobPhase } from "~/lib/backup-job-display"
import {
  Ban,
  X,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  XCircle,
  ExternalLink,
  FileText,
} from "lucide-react"

const PHASE_LABEL: Record<BackupJobPhase, string> = {
  running: "Backup in progress",
  queued: "Backup queued",
  completed: "Backup completed",
  failed: "Backup failed",
  cancelled: "Backup cancelled",
}

function formatTime(dateString?: string): string {
  if (!dateString) return "N/A"
  return new Date(dateString).toLocaleTimeString()
}

function formatDuration(startTime?: string, endTime?: string): string {
  if (!startTime) return "N/A"
  const start = new Date(startTime).getTime()
  const end = endTime ? new Date(endTime).getTime() : Date.now()
  const duration = Math.max(0, Math.floor((end - start) / 1000))
  return `${Math.floor(duration / 60)}m ${duration % 60}s`
}

function PhaseIcon({ phase }: { phase: BackupJobPhase }) {
  if (phase === "running") return <LoaderCircle className="h-5 w-5 animate-spin text-coral-500" aria-hidden="true" />
  if (phase === "queued") return <Clock3 className="h-5 w-5 text-gray-500" aria-hidden="true" />
  if (phase === "completed") return <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden="true" />
  if (phase === "cancelled") return <Ban className="h-5 w-5 text-gray-500" aria-hidden="true" />
  return <XCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
}

interface JobRowProps {
  job: BackupJob
  expanded: boolean
  showingOutput: boolean
  cancelling: boolean
  cancelError?: string
  onToggleExpanded: () => void
  onToggleOutput: () => void
  onCancel: () => void
  onDismiss: () => void
}

function JobRow({ job, expanded, showingOutput, cancelling, cancelError, onToggleExpanded, onToggleOutput, onCancel, onDismiss }: JobRowProps) {
  const { status: licenseStatus } = useLicense()
  const phase = backupJobPhase(job)
  const active = phase === "running" || phase === "queued"
  const portalUrl = azureStoragePortalUrl({
    tenantId: job.credentials.tenantId,
    subscriptionId: job.resources.subscriptionId,
    resourceGroupName: job.resources.resourceGroupName,
    storageAccountName: job.resources.storageAccountName,
  })
  const detail = active && job.progressMessage ? job.progressMessage : PHASE_LABEL[phase]

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0"><PhaseIcon phase={phase} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-foreground">{job.tenantName}</p>
            {active && <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{job.progress}%</span>}
          </div>
          <p className="truncate text-xs text-muted-foreground" title={detail}>{detail}</p>
          {active && (
            <Progress
              value={job.progress}
              aria-label={`${job.tenantName} backup progress`}
              className={cn("mt-2 h-1 bg-secondary [&>div]:bg-coral-500", phase === "queued" && "[&>div]:bg-muted-foreground")}
            />
          )}
          {cancelError && <p role="alert" className="mt-1.5 break-words text-xs text-destructive">{cancelError}</p>}
          {job.pollError && <p role="alert" className="mt-1.5 break-words text-xs text-destructive">{job.pollError}</p>}
          {job.isComplete && job.isSuccessful && !job.quiet && (
            <FirstBackupNote plan={tenantPlan(tenantLicense(licenseStatus, job.tenantId))} />
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium">
            {active && job.jobId.startsWith("desktop-") && (
              <button
                type="button"
                disabled={cancelling}
                onClick={onCancel}
                aria-label={`Cancel backup for ${job.tenantName}`}
                className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {cancelling ? "Cancelling…" : "Cancel backup"}
              </button>
            )}
            <button
              type="button"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} details for ${job.tenantName}`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {expanded ? "Hide details" : "Details"}
            </button>
          </div>

          {expanded && (
            <div className="mt-2.5 space-y-2.5 border-t border-border pt-2.5">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Status</dt>
                <dd className={cn("text-right font-medium text-foreground", phase === "completed" && "text-green-600", phase === "failed" && "text-destructive")}>{job.status}</dd>
                <dt className="text-muted-foreground">Started</dt>
                <dd className="text-right tabular-nums text-foreground">{formatTime(job.startTime)}</dd>
                {job.isComplete && (
                  <>
                    <dt className="text-muted-foreground">Finished</dt>
                    <dd className="text-right tabular-nums text-foreground">{formatTime(job.endTime)}</dd>
                    <dt className="text-muted-foreground">Duration</dt>
                    <dd className="text-right tabular-nums text-foreground">{formatDuration(job.startTime, job.endTime)}</dd>
                  </>
                )}
              </dl>
              {job.exception && (
                <div className={cn("rounded-2xl p-3", phase === "cancelled" ? "bg-gray-100" : "bg-red-50")}>
                  <p className={cn("text-xs", phase === "cancelled" ? "text-gray-700" : "text-red-700")}>{job.exception}</p>
                </div>
              )}
              {job.output && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={onToggleOutput}
                    aria-expanded={showingOutput}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    {showingOutput ? "Hide output" : "Show output"}
                  </button>
                  {showingOutput && (
                    <div className="max-h-40 overflow-auto rounded-xl bg-slate-950 p-3 text-xs">
                      <pre className="whitespace-pre-wrap break-words text-slate-50">{job.output}</pre>
                    </div>
                  )}
                </div>
              )}
              {job.isComplete && portalUrl && (
                <button
                  type="button"
                  onClick={() => window.open(portalUrl, "_blank")}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  View in Azure
                </button>
              )}
            </div>
          )}
        </div>
        {/* A job whose status polling stopped on error never completes here, so it stays
            dismissible while incomplete; healthy running jobs are removed by cancelling. */}
        {(job.isComplete || job.pollError) && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={`Dismiss backup for ${job.tenantName}`}
            className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  )
}

/**
 * One compact panel for every backup in flight, fixed at the bottom right. Jobs are
 * rows in a single list under a summary header, so two or three backups stay a small
 * stack instead of a tower of full cards. The whole panel collapses to its header.
 */
export function FloatingProgress() {
  const { activeJobs: allJobs, removeJob } = useBackupProgress()
  const activeJobs = allJobs.filter(job => !job.isHidden)
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [showOutput, setShowOutput] = useState<Record<string, boolean>>({})
  const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set())
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({})
  const [cancelErrors, setCancelErrors] = useState<Record<string, string>>({})
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setCancelling(prev => {
      const pending = Object.entries(prev).filter(([jobId]) => allJobs.some(job => job.jobId === jobId && !job.isComplete))
      return pending.length === Object.keys(prev).length ? prev : Object.fromEntries(pending)
    })
  }, [allJobs])

  // Auto-expand if only one job (unless user manually collapsed it or it is quiet)
  useEffect(() => {
    if (activeJobs.length === 1 && !expandedJobId) {
      const job = activeJobs[0]
      if (job && !job.quiet && !userCollapsed.has(job.jobId)) {
        setExpandedJobId(job.jobId)
      }
    }
  }, [activeJobs, expandedJobId, userCollapsed])

  // While the panel shows, --floating-progress-offset holds the space it takes at the bottom of the
  // window, so sticky action bars and page ends can stay clear of it.
  const shown = activeJobs.length > 0
  useLayoutEffect(() => {
    const root = document.documentElement
    const element = panel.current
    if (!shown || !element) { root.style.removeProperty("--floating-progress-offset"); return }
    const set = () => root.style.setProperty("--floating-progress-offset", `${element.offsetHeight + 24}px`)
    set()
    const observer = new ResizeObserver(set)
    observer.observe(element)
    return () => { observer.disconnect(); root.style.removeProperty("--floating-progress-offset") }
  }, [shown])

  if (activeJobs.length === 0) return null

  const toggleJobExpansion = (jobId: string) => {
    setExpandedJobId(prevId => {
      const isCurrentlyExpanded = prevId === jobId
      if (isCurrentlyExpanded) {
        setUserCollapsed(prev => new Set(prev).add(jobId))
        return null
      }
      setUserCollapsed(prev => {
        const newSet = new Set(prev)
        newSet.delete(jobId)
        return newSet
      })
      return jobId
    })
  }

  const cancelJob = async (jobId: string) => {
    setCancelling(prev => ({ ...prev, [jobId]: true }))
    setCancelErrors(prev => ({ ...prev, [jobId]: "" }))
    try {
      await bridge.backups.cancel(jobId)
    } catch (error) {
      setCancelErrors(prev => ({ ...prev, [jobId]: error instanceof Error ? error.message : "Could not cancel the backup. Try again." }))
      setCancelling(prev => ({ ...prev, [jobId]: false }))
    }
  }

  const anyActive = activeJobs.some(job => !job.isComplete)
  const anyFailed = activeJobs.some(job => backupJobPhase(job) === "failed")
  const anySuccessful = activeJobs.some(job => job.isSuccessful)
  const finished = activeJobs.filter(job => job.isComplete)

  return (
    <div ref={panel} className="fixed bottom-4 right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)]">
      <section aria-label="Backup activity" className="overflow-hidden rounded-3xl border border-border bg-card shadow-[0_12px_32px_-12px_rgba(22,21,20,0.35)]">
        <div className="flex items-center gap-2 px-4 py-3">
          {anyActive ? (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-coral-500" aria-hidden="true" />
          ) : anyFailed ? (
            <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          ) : anySuccessful ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
          ) : (
            <Ban className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
          )}
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-foreground">
            Backups
            <span className="ml-2 font-normal text-muted-foreground">{backupActivitySummary(activeJobs)}</span>
          </h2>
          {finished.length > 0 && (
            <button
              type="button"
              onClick={() => finished.forEach(job => removeJob(job.jobId))}
              className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(value => !value)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Show backups" : "Hide backups"}
            className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            {collapsed ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
        {!collapsed && (
          <ul className="max-h-[min(60vh,26rem)] divide-y divide-border overflow-y-auto border-t border-border">
            {activeJobs.map(job => (
              <JobRow
                key={job.jobId}
                job={job}
                expanded={expandedJobId === job.jobId}
                showingOutput={showOutput[job.jobId] || false}
                cancelling={cancelling[job.jobId] || false}
                cancelError={cancelErrors[job.jobId]}
                onToggleExpanded={() => toggleJobExpansion(job.jobId)}
                onToggleOutput={() => setShowOutput(prev => ({ ...prev, [job.jobId]: !prev[job.jobId] }))}
                onCancel={() => void cancelJob(job.jobId)}
                onDismiss={() => removeJob(job.jobId)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
