"use client"

import { useState, useEffect, useLayoutEffect, useRef } from "react"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { Progress } from "~/components/ui/progress"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { bridge } from "@desktop/lib/bridge"
import { FirstBackupNote } from "@desktop/components/FirstBackupNote"
import { tenantLicense, tenantPlan, useLicense } from "@desktop/lib/license"
import { azureStoragePortalUrl } from "~/lib/azure-portal"
import { 
  Ban,
  X,
  ChevronUp,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Activity,
  ExternalLink,
  FileText
} from "lucide-react"

export function FloatingProgress() {
  const { activeJobs: allJobs, removeJob } = useBackupProgress()
  const { status: licenseStatus } = useLicense()
  const activeJobs = allJobs.filter(job => !job.isHidden)
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
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

  const formatTime = (dateString?: string) => {
    if (!dateString) return "N/A"
    return new Date(dateString).toLocaleTimeString()
  }

  const getDuration = (startTime?: string, endTime?: string) => {
    if (!startTime) return "N/A"
    const start = new Date(startTime).getTime()
    const end = endTime ? new Date(endTime).getTime() : Date.now()
    const duration = Math.floor((end - start) / 1000)
    const minutes = Math.floor(duration / 60)
    const seconds = duration % 60
    return `${minutes}m ${seconds}s`
  }

  const toggleJobExpansion = (jobId: string) => {
    setExpandedJobId(prevId => {
      const isCurrentlyExpanded = prevId === jobId
      if (isCurrentlyExpanded) {
        // User is collapsing, track this
        setUserCollapsed(prev => new Set(prev).add(jobId))
        return null
      } else {
        // User is expanding, remove from collapsed set
        setUserCollapsed(prev => {
          const newSet = new Set(prev)
          newSet.delete(jobId)
          return newSet
        })
        return jobId
      }
    })
  }

  const toggleOutput = (jobId: string) => {
    setShowOutput(prev => ({ ...prev, [jobId]: !prev[jobId] }))
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

  return (
    <div ref={panel} className="fixed bottom-4 right-4 z-50 space-y-2">
      {activeJobs.map((job) => {
        const isExpanded = expandedJobId === job.jobId
        const showingOutput = showOutput[job.jobId] || false
        const portalUrl = azureStoragePortalUrl({
          tenantId: job.credentials.tenantId,
          subscriptionId: job.resources.subscriptionId,
          resourceGroupName: job.resources.resourceGroupName,
          storageAccountName: job.resources.storageAccountName,
        })

        return (
          <div
            key={job.jobId}
            className={cn(
              "bg-card rounded-3xl border border-border shadow-sm transition-all duration-300 overflow-hidden",
              isExpanded ? "w-96" : "w-80"
            )}
          >
            {/* Header */}
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {job.isComplete ? (
                    job.isSuccessful ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                    ) : job.status === "Cancelled" ? (
                      <Ban className="h-5 w-5 text-gray-500" />
                    ) : (
                      <XCircle className="h-5 w-5 text-destructive" />
                    )
                  ) : (
                    <Activity className={cn("h-5 w-5 text-blue-600", job.status !== "Queued" && "animate-pulse")} />
                  )}
                  <div>
                    <h4 className="font-medium tracking-tight text-sm">{job.tenantName}</h4>
                    <p className="text-xs text-gray-500">
                      {job.isComplete ? (
                        job.isSuccessful ? "Backup completed" : job.status === "Cancelled" ? "Backup cancelled" : "Backup failed"
                      ) : job.status === "Queued" ? (
                        "Backup queued"
                      ) : (
                        "Backup in progress"
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleJobExpansion(job.jobId)
                    }}
                  >
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeJob(job.jobId)
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {job.isComplete && job.isSuccessful && !job.quiet && (
                <div className="mt-3"><FirstBackupNote plan={tenantPlan(tenantLicense(licenseStatus, job.tenantId))} /></div>
              )}

              {/* Progress Bar */}
              {!job.isComplete && (
                <div className="mt-3 space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">{job.progressMessage}</span>
                    <span className="font-medium">{job.progress}%</span>
                  </div>
                  <Progress value={job.progress} className="h-1.5 bg-gray-100 [&>div]:bg-coral-500" />
                  {job.jobId.startsWith("desktop-") && (
                    <Button variant="outline" size="sm" disabled={cancelling[job.jobId]} onClick={() => void cancelJob(job.jobId)}>
                      {cancelling[job.jobId] ? "Cancelling…" : "Cancel backup"}
                    </Button>
                  )}
                  {cancelErrors[job.jobId] && <p role="alert" className="break-words text-xs text-destructive">{cancelErrors[job.jobId]}</p>}
                  {job.pollError && <p role="alert" className="break-words text-xs text-destructive">{job.pollError}</p>}
                </div>
              )}
            </div>

            {/* Expanded Content */}
            {isExpanded && (
              <div className="px-5 pb-5 space-y-3 text-sm">
                {/* Status Details */}
                <div className="space-y-2 rounded-2xl bg-gray-50 p-4">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Status:</span>
                    <span className={cn(
                      "font-medium",
                      job.isSuccessful && "text-green-600",
                      job.status === "Failed" && "text-destructive"
                    )}>
                      {job.status}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Start Time:</span>
                    <span>{formatTime(job.startTime)}</span>
                  </div>
                  {job.isComplete && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-500">End Time:</span>
                        <span>{formatTime(job.endTime)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Duration:</span>
                        <span>{getDuration(job.startTime, job.endTime)}</span>
                      </div>
                    </>
                  )}
                </div>

                {/* Exception Message */}
                {job.exception && (
                  <div className={cn("rounded-2xl p-3", job.status === "Cancelled" ? "bg-gray-100" : "bg-red-50")}>
                    <p className={cn("text-xs", job.status === "Cancelled" ? "text-gray-700" : "text-red-700")}>{job.exception}</p>
                  </div>
                )}

                {/* Job Output */}
                {job.output && (
                  <div className="space-y-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleOutput(job.jobId)}
                      className="w-full"
                    >
                      <FileText className="mr-2 h-4 w-4" />
                      {showingOutput ? "Hide" : "Show"} Output
                    </Button>
                    {showingOutput && (
                      <div className="max-h-40 overflow-auto rounded-2xl bg-slate-950 p-3 text-xs">
                        <pre className="text-slate-50">{job.output}</pre>
                      </div>
                    )}
                  </div>
                )}

                {/* Actions */}
                {job.isComplete && portalUrl && (
                  <div className="flex gap-2 pt-2">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => window.open(portalUrl, "_blank")}>
                      <ExternalLink className="mr-2 h-3 w-3" />
                      View in Azure
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Multiple jobs indicator */}
      {activeJobs.length > 1 && (() => {
        const running = activeJobs.filter(j => !j.isComplete && j.status !== "Queued").length
        const queued = activeJobs.filter(j => !j.isComplete && j.status === "Queued").length
        if (running + queued === 0) return null
        return (
          <div className="text-center">
            <span className="text-xs text-gray-500">
              {queued > 0 ? `${running} running, ${queued} queued` : `${running} active backup${running !== 1 ? 's' : ''}`}
            </span>
          </div>
        )
      })()}
    </div>
  )
}
