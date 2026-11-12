"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "~/components/ui/button"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { bridge } from "@desktop/lib/bridge"
import { useTenantPlan } from "@desktop/lib/license"
import { FirstBackupNote } from "@desktop/components/FirstBackupNote"
import { completedWithWarnings, resolveBackupJobDisplay, toBackupJobDisplay, type BackupJobDisplay } from "~/lib/backup-job-display"
import { azureStoragePortalUrl } from "~/lib/azure-portal"
import { BackupResults } from "~/components/backup/backup-results"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Progress } from "~/components/ui/progress"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { 
  Ban,
  CheckCircle2, 
  XCircle, 
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  LoaderCircle,
  Activity
} from "lucide-react"

interface BackupProgressModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tenantName: string
  jobId: string | null
  credentials: {
    tenantId: string
    appId: string
    clientSecret: string
  } | null
  resources: {
    subscriptionId: string
    resourceGroupName: string
    automationAccountName: string
    storageAccountName?: string
  } | null
  onComplete?: (success: boolean) => void
}

type JobStatus = BackupJobDisplay

export function BackupProgressModal({
  open,
  onOpenChange,
  tenantName,
  jobId,
  credentials,
  resources,
  onComplete
}: BackupProgressModalProps) {
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState("")
  const { addJob, updateJob, activeJobs } = useBackupProgress()
  const plan = useTenantPlan(credentials?.tenantId)

  // The modal reads the shared backup job store instead of polling the same job again.
  // The snapshot keeps the finished state on screen after the store drops the job.
  const [snapshot, setSnapshot] = useState<JobStatus | null>(null)
  const tracked = jobId ? activeJobs.find((job) => job.jobId === jobId) : undefined
  const trackedStatus: JobStatus | null = tracked ? toBackupJobDisplay(tracked) : null
  const jobStatus = resolveBackupJobDisplay(trackedStatus, snapshot, null)
  const pollError = tracked?.pollError ?? ""
  const latest = useRef({ onComplete })
  latest.current = { onComplete }
  const completedFor = useRef<string | null>(null)

  useEffect(() => { setCancelling(false); setCancelError(""); completedFor.current = null; setSnapshot(null) }, [jobId])

  // Register the job once with the shared store; addJob ignores a job id it already tracks.
  // Hidden while the modal shows it, so the floating panel does not show the same job twice.
  useEffect(() => {
    if (!open || !jobId || !credentials || !resources) return
    addJob({
      jobId,
      tenantName,
      tenantId: credentials.tenantId,
      status: "Activating",
      progress: 0,
      progressMessage: "Activating job...",
      isComplete: false,
      isSuccessful: false,
      isHidden: true,
      credentials,
      resources,
    })
  }, [open, jobId, credentials, resources, tenantName, addJob])

  useEffect(() => {
    if (!tracked?.isComplete || !jobId || completedFor.current === jobId) return
    completedFor.current = jobId
    setSnapshot(trackedStatus)
    setCancelling(false)
    setCancelError("")
    latest.current.onComplete?.(tracked.isSuccessful)
  }, [tracked?.isComplete, tracked?.isSuccessful, jobId])

  const handleRunInBackground = () => {
    if (jobId && credentials && resources) {
      // The job is already tracked by the shared store; show it in the floating panel.
      if (tracked) updateJob(jobId, { isHidden: false })
      else addJob({
        jobId,
        tenantName,
        tenantId: credentials.tenantId,
        status: jobStatus?.status || "Activating",
        progress: jobStatus?.progress || 0,
        progressMessage: jobStatus?.progressMessage || "Activating job...",
        startTime: jobStatus?.startTime,
        endTime: jobStatus?.endTime,
        exception: jobStatus?.exception,
        output: jobStatus?.output,
        results: jobStatus?.results,
        isComplete: jobStatus?.isComplete || false,
        isSuccessful: jobStatus?.isSuccessful || false,
        credentials,
        resources
      })
      onOpenChange(false)
    }
  }

  const cancelBackup = async () => {
    if (!jobId) return
    setCancelling(true)
    setCancelError("")
    try {
      await bridge.backups.cancel(jobId)
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "Could not cancel the backup. Try again.")
      setCancelling(false)
    }
  }

  const portalUrl = azureStoragePortalUrl({
    tenantId: credentials?.tenantId,
    subscriptionId: resources?.subscriptionId,
    resourceGroupName: resources?.resourceGroupName,
    storageAccountName: resources?.storageAccountName,
  })

  const handleDialogChange = (newOpen: boolean) => {
    // If the dialog is being closed and the job is still running
    if (!newOpen && jobId && !jobStatus?.isComplete) {
      // Minimize to floating notification instead of just closing
      handleRunInBackground()
    } else {
      // Otherwise, just close normally
      onOpenChange(newOpen)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Backup Progress</DialogTitle>
          <DialogDescription>
            Monitoring backup job for {tenantName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {cancelError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{cancelError}</AlertDescription>
            </Alert>
          )}
          {pollError ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{pollError}</AlertDescription>
            </Alert>
          ) : jobStatus ? (
            <>
              <div className="space-y-2">
                <div className="flex items-center gap-2.5" role="status">
                  {jobStatus.isComplete ? (
                    completedWithWarnings(jobStatus) ? (
                      <AlertTriangle className="h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
                    ) : jobStatus.isSuccessful ? (
                      <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
                    ) : jobStatus.status === "Cancelled" ? (
                      <Ban className="h-5 w-5 shrink-0 text-gray-500" aria-hidden="true" />
                    ) : (
                      <XCircle className="h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
                    )
                  ) : (
                    <LoaderCircle className="h-5 w-5 shrink-0 animate-spin text-coral-500" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{jobStatus.progressMessage}</span>
                  {!jobStatus.isComplete && <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{jobStatus.progress}%</span>}
                </div>
                {!jobStatus.isComplete && <Progress value={jobStatus.progress} aria-label="Backup progress" className="h-2 bg-gray-100 [&>div]:bg-coral-500" />}
              </div>

              {open && jobStatus.isComplete && jobStatus.isSuccessful && <FirstBackupNote key={jobId} plan={plan} />}

              {/* Exception Message */}
              {jobStatus.exception && (
                <Alert variant={jobStatus.status === "Cancelled" ? "default" : "destructive"} className={jobStatus.status === "Cancelled" ? "border-gray-200 bg-gray-50 text-gray-700" : undefined}>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{jobStatus.exception}</AlertDescription>
                </Alert>
              )}

              <BackupResults job={jobStatus} jobId={jobId} />
            </>
          ) : (
            <div className="flex items-center justify-center py-8">
              <Activity className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Initializing...</span>
            </div>
          )}
        </div>

        <DialogFooter>
          {jobStatus?.isComplete ? (
            <>
              {portalUrl && (
                <Button variant="outline" onClick={() => window.open(portalUrl, "_blank")}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  View in Azure
                </Button>
              )}
              <Button onClick={() => onOpenChange(false)} className="bg-coral-600 text-white hover:bg-coral-700">
                Close
              </Button>
            </>
          ) : (
            <>
              {jobId?.startsWith("desktop-") && (
                <Button variant="outline" disabled={cancelling} onClick={() => void cancelBackup()}>
                  {cancelling ? "Cancelling…" : "Cancel backup"}
                </Button>
              )}
              <Button variant="outline" onClick={handleRunInBackground}>
                Run in Background
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
