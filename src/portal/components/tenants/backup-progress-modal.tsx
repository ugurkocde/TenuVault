"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "~/components/ui/button"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { bridge } from "@desktop/lib/bridge"
import { useTenantPlan } from "@desktop/lib/license"
import { FirstBackupNote } from "@desktop/components/FirstBackupNote"
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
  CheckCircle2, 
  XCircle, 
  AlertCircle,
  ExternalLink,
  FileText,
  Clock,
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
  } | null
  onComplete?: (success: boolean) => void
}

interface JobStatus {
  status: string
  progress: number
  progressMessage: string
  startTime?: string
  endTime?: string
  exception?: string
  output?: string
  isComplete: boolean
  isSuccessful: boolean
}

export function BackupProgressModal({
  open,
  onOpenChange,
  tenantName,
  jobId,
  credentials,
  resources,
  onComplete
}: BackupProgressModalProps) {
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null)
  const [error, setError] = useState("")
  const [showOutput, setShowOutput] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState("")
  const { addJob } = useBackupProgress()
  const plan = useTenantPlan(credentials?.tenantId)

  // The latest props, so a parent re-rendering with new objects does not restart polling.
  const latest = useRef({ credentials, resources, onComplete })
  latest.current = { credentials, resources, onComplete }
  const ready = Boolean(credentials && resources)

  useEffect(() => {
    if (open && jobId && ready) {
      setJobStatus(null)
      setError("")
      setCancelError("")
      const { credentials, resources } = latest.current
      let stopped = false
      // Poll now and then every 2 seconds.
      const poll = async () => {
        if (stopped) return
        try {
          const response = await fetch("/api/backup/status", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...credentials,
              ...resources,
              jobId
            }),
          })

          if (!response.ok) {
            let errorMessage = "Failed to check job status"
            const responseText = await response.text()
            try {
              const errorData = JSON.parse(responseText)
              errorMessage = errorData.error || errorMessage
            } catch {
              errorMessage = responseText || errorMessage
            }
            throw new Error(errorMessage)
          }

          const responseText = await response.text()
          let data
          try {
            data = JSON.parse(responseText)
          } catch (parseError) {
            console.error("Failed to parse response:", responseText)
            throw new Error("Invalid JSON response from server")
          }
          if (stopped) return
          setJobStatus(data)

          // Stop polling if job is complete
          if (data.isComplete) {
            setCancelError("")
            clearInterval(pollInterval)
            latest.current.onComplete?.(data.isSuccessful)
          }
        } catch (err) {
          console.error("Error checking job status:", err)
          setError(err instanceof Error ? err.message : "Failed to check job status")
          clearInterval(pollInterval)
        }
      }
      const pollInterval = setInterval(() => void poll(), 2000)
      void poll()

      return () => {
        stopped = true
        clearInterval(pollInterval)
      }
    }
  }, [open, jobId, ready])

  const formatTime = (dateString?: string) => {
    if (!dateString) return "N/A"
    return new Date(dateString).toLocaleTimeString()
  }

  const getDuration = () => {
    if (!jobStatus?.startTime) return "N/A"
    const start = new Date(jobStatus.startTime).getTime()
    const end = jobStatus.endTime ? new Date(jobStatus.endTime).getTime() : Date.now()
    const duration = Math.floor((end - start) / 1000)
    const minutes = Math.floor(duration / 60)
    const seconds = duration % 60
    return `${minutes}m ${seconds}s`
  }

  const handleRunInBackground = () => {
    if (jobId && credentials && resources) {
      // Add job to global context
      addJob({
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
        isComplete: jobStatus?.isComplete || false,
        isSuccessful: jobStatus?.isSuccessful || false,
        credentials,
        resources
      })
      
      // Close modal
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
    } finally {
      setCancelling(false)
    }
  }

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
          {error ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : jobStatus ? (
            <>
              {/* Progress Bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-gray-600">
                  <span>{jobStatus.progressMessage}</span>
                  <span>{jobStatus.progress}%</span>
                </div>
                <Progress value={jobStatus.progress} className="h-2 bg-gray-100 [&>div]:bg-coral-500" />
              </div>

              {/* Status Icon */}
              <div className="flex items-center justify-center py-4">
                {jobStatus.isComplete ? (
                  jobStatus.isSuccessful ? (
                    <CheckCircle2 className="h-20 w-20 rounded-full bg-green-50 p-5 text-green-600" />
                  ) : (
                    <XCircle className="h-20 w-20 rounded-full bg-red-50 p-5 text-red-600" />
                  )
                ) : (
                  <Activity className="h-20 w-20 rounded-full bg-blue-50 p-5 text-blue-700 animate-pulse" />
                )}
              </div>

              {/* Job Details */}
              <div className="space-y-2 rounded-2xl bg-gray-50 p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status:</span>
                  <span className={`font-medium ${
                    jobStatus.isSuccessful ? "text-green-600" : 
                    jobStatus.status === "Failed" ? "text-destructive" : 
                    ""
                  }`}>
                    {jobStatus.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Job ID:</span>
                  <span className="font-mono text-xs">{jobId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Start Time:</span>
                  <span>{formatTime(jobStatus.startTime)}</span>
                </div>
                {jobStatus.isComplete && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">End Time:</span>
                      <span>{formatTime(jobStatus.endTime)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Duration:</span>
                      <span>{getDuration()}</span>
                    </div>
                  </>
                )}
              </div>

              {open && jobStatus.isComplete && jobStatus.isSuccessful && <FirstBackupNote key={jobId} plan={plan} />}

              {/* Exception Message */}
              {jobStatus.exception && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{jobStatus.exception}</AlertDescription>
                </Alert>
              )}

              {/* Job Output */}
              {jobStatus.output && (
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowOutput(!showOutput)}
                    className="w-full"
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    {showOutput ? "Hide" : "Show"} Job Output
                  </Button>
                  {showOutput && (
                    <div className="max-h-60 overflow-auto rounded-2xl bg-slate-950 p-4 text-xs">
                      <pre className="text-slate-50">{jobStatus.output}</pre>
                    </div>
                  )}
                </div>
              )}
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
              <Button
                variant="outline"
                onClick={() => {
                  // Use the direct URL format for viewing automation jobs
                  const url = `https://portal.azure.com/#@${credentials?.tenantId}/resource/subscriptions/${resources?.subscriptionId}/resourceGroups/${resources?.resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${resources?.automationAccountName}/jobs/${jobId}/output`
                  window.open(url, "_blank")
                }}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                View in Azure
              </Button>
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
