"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Button } from "~/components/ui/button"
import { Progress } from "~/components/ui/progress"
import {
  CheckCircle,
  AlertCircle,
  Loader2,
  RefreshCw
} from "lucide-react"
import { cn } from "~/lib/utils"

interface RestoreProgressModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tenantName: string
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
  jobId: string | null
  onComplete: (success: boolean) => void
}

type JobStatus = "New" | "Activating" | "Running" | "Completed" | "Failed" | "Stopped" | "Blocked" | "Suspended" | "Disconnected" | "Suspending" | "Stopping" | "Resuming" | "Removing"

interface RestoreLog {
  time: string
  message: string
  type: "info" | "success" | "error" | "warning"
}

export function RestoreProgressModal({
  open,
  onOpenChange,
  tenantName,
  jobId,
}: RestoreProgressModalProps) {
  const [status, setStatus] = useState<JobStatus>("Running")
  const [progress, setProgress] = useState(0)
  const [logs, setLogs] = useState<RestoreLog[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const [startTime, setStartTime] = useState<Date | null>(null)
  const [endTime, setEndTime] = useState<Date | null>(null)

  useEffect(() => {
    if (open) {
      // Reset state when modal opens
      setStatus("Running")
      setProgress(0)
      setLogs([])
      setError(null)
      setStartTime(new Date())
      setEndTime(null)

      // Simulate progress since restore now happens synchronously
      simulateProgress()
    }
  }, [open])

  // Handle external completion signal
  useEffect(() => {
    if (!open && status === "Running" && progress > 0) {
      // Modal was closed externally, likely due to completion
      setStatus("Completed")
      setProgress(100)
      setEndTime(new Date())
    }
  }, [open, status, progress])

  const simulateProgress = () => {
    // Simulate progress updates
    const progressSteps = [
      { progress: 10, log: "Connecting to Azure Storage...", type: "info" as const },
      { progress: 25, log: "Fetching backup content...", type: "info" as const },
      { progress: 40, log: "Reading policy configurations...", type: "info" as const },
      { progress: 60, log: "Connecting to Microsoft Graph API...", type: "info" as const },
      { progress: 80, log: "Creating policies in Intune...", type: "info" as const },
      { progress: 95, log: "Finalizing restore operation...", type: "info" as const }
    ]

    progressSteps.forEach((step, index) => {
      setTimeout(() => {
        if (open) {
          setProgress(step.progress)
          addLog(step.log, step.type)
        }
      }, (index + 1) * 500)
    })

    // The actual restore will complete and call onComplete
  }

  const addLog = (message: string, type: RestoreLog["type"]) => {
    const log: RestoreLog = {
      time: new Date().toLocaleTimeString(),
      message,
      type
    }
    setLogs(prev => [...prev, log])
  }

  const getDuration = () => {
    if (!startTime) return ""
    const end = endTime || new Date()
    const duration = Math.floor((end.getTime() - startTime.getTime()) / 1000)
    const minutes = Math.floor(duration / 60)
    const seconds = duration % 60
    return `${minutes}m ${seconds}s`
  }

  const getStatusIcon = () => {
    if (status === "Completed") {
      return <CheckCircle className="h-6 w-6 text-green-600" />
    } else if (status === "Failed" || status === "Stopped") {
      return <AlertCircle className="h-6 w-6 text-red-600" />
    } else if (isPolling) {
      return <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
    } else {
      return <RefreshCw className="h-6 w-6 text-gray-400" />
    }
  }

  const getStatusColor = () => {
    if (status === "Completed") return "text-green-600"
    if (status === "Failed" || status === "Stopped") return "text-red-600"
    if (status === "Running") return "text-blue-600"
    return "text-gray-600"
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Restore Progress</DialogTitle>
          <DialogDescription>
            Restoring configuration for {tenantName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Status Display */}
          <div className="flex items-center justify-between rounded-2xl bg-gray-50 p-5">
            <div className="flex items-center gap-4">
              {getStatusIcon()}
              <div>
                <p className="font-medium tracking-tight">Status: <span className={getStatusColor()}>{status}</span></p>
                {jobId && <p className="text-xs text-gray-500">Job ID: {jobId}</p>}
              </div>
            </div>
            {startTime && (
              <div className="text-right">
                <p className="text-xs text-gray-500">Duration</p>
                <p className="font-mono font-medium">{getDuration()}</p>
              </div>
            )}
          </div>

          {/* Progress Bar */}
          <div>
            <div className="flex justify-between text-sm text-gray-600 mb-2">
              <span>Progress</span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} className="h-2 bg-gray-100 [&>div]:bg-coral-500" />
          </div>

          {/* Activity Logs */}
          <div className="overflow-hidden rounded-2xl bg-gray-50">
            <div className="px-4 pt-3 pb-1">
              <h4 className="text-xs font-medium text-gray-500">Activity Log</h4>
            </div>
            <div className="max-h-[200px] overflow-y-auto px-4 pb-4 pt-2">
              {logs.length === 0 ? (
                <p className="text-sm text-gray-500">Waiting for restore to start...</p>
              ) : (
                <div className="space-y-2">
                  {logs.map((log, index) => (
                    <div key={index} className="flex items-start gap-3 text-sm">
                      <span className="text-gray-400 font-mono text-xs mt-0.5">{log.time}</span>
                      <div className="flex-1">
                        <span className={cn(
                          log.type === "success" && "text-green-600",
                          log.type === "error" && "text-red-600",
                          log.type === "warning" && "text-amber-700",
                          log.type === "info" && "text-gray-600"
                        )}>
                          {log.message}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="rounded-2xl bg-red-50 p-4">
              <div className="flex">
                <AlertCircle className="h-5 w-5 text-red-600 mr-2 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-red-800">Restore Error</h4>
                  <p className="text-sm text-red-700 mt-1">{error}</p>
                </div>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end">
            <div className="flex gap-3">
              {status === "Completed" || status === "Failed" || status === "Stopped" ? (
                <>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                  {status === "Completed" && (
                    <Button className="bg-coral-600 text-white hover:bg-coral-700">
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Done
                    </Button>
                  )}
                </>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsPolling(false)
                    onOpenChange(false)
                  }}
                >
                  Run in Background
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}