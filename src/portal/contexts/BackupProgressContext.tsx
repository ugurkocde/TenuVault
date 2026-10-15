"use client"

import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from "react"

import { useTenants, useTenantOperations } from "./TenantContext"
import { backupCompletionUpdates } from "~/lib/backup-completion"
import { isBackupJobPollable } from "~/lib/backup-job-display"
import { createJobPoller } from "@desktop/lib/job-store"

export interface BackupJob {
  jobId: string
  tenantName: string
  tenantId: string
  status: string
  progress: number
  progressMessage: string
  startTime?: string
  endTime?: string
  exception?: string
  output?: string
  isComplete: boolean
  isSuccessful: boolean
  /** Set when status polling failed and stopped; progress views show it so the admin can retry or skip. */
  pollError?: string
  isMinimized: boolean
  /** Not listed in the floating panel (its workflow shows the progress); still polled so completion is recorded. */
  isHidden?: boolean
  /** Never expands on its own, not even when it is the only job or fails. */
  quiet?: boolean
  credentials: {
    tenantId: string
    appId: string
    clientSecret: string
  }
  resources: {
    subscriptionId: string
    resourceGroupName: string
    automationAccountName: string
    storageAccountName?: string
  }
}

interface BackupProgressContextType {
  activeJobs: BackupJob[]
  addJob: (job: Omit<BackupJob, "isMinimized">) => void
  updateJob: (jobId: string, updates: Partial<BackupJob>) => void
  removeJob: (jobId: string) => void
  minimizeJob: (jobId: string) => void
  expandJob: (jobId: string) => void
  getJob: (jobId: string) => BackupJob | undefined
}

const BackupProgressContext = createContext<BackupProgressContextType | undefined>(undefined)

export function BackupProgressProvider({ children }: { children: ReactNode }) {
  const [activeJobs, setActiveJobs] = useState<BackupJob[]>([])
  const tenants = useTenants()
  const { updateTenant } = useTenantOperations()
  const recorded = useRef(new Set<string>())

  // This provider stays mounted across navigation, so every tracked job updates
  // its tenant even when the initiating page or progress modal is gone.
  useEffect(() => {
    const current = new Map(tenants.map((tenant) => [tenant.id, { ...tenant }]))
    for (const job of activeJobs) {
      if (!job.isComplete || recorded.current.has(job.jobId)) continue
      const original = tenants.find((item) => item.credentials?.tenantId.toLowerCase() === job.tenantId.toLowerCase())
      if (!original) continue
      const tenant = current.get(original.id)!
      recorded.current.add(job.jobId)
      const updates = backupCompletionUpdates(job, tenant.lastBackup, tenant.lastSync)
      Object.assign(tenant, updates)
      updateTenant(tenant.id, updates)
    }
  }, [activeJobs, tenants, updateTenant])

  // Add a new job to track. Re-adding a job whose polling stopped on error clears
  // the error so polling resumes, which is how a reopened view retries the same job.
  const addJob = useCallback((job: Omit<BackupJob, "isMinimized">) => {
    setActiveJobs(prev => {
      const existing = prev.find((item) => item.jobId === job.jobId)
      if (!existing) return [...prev, { ...job, isMinimized: true }]
      if (!existing.pollError) return prev
      return prev.map((item) => item.jobId === job.jobId ? { ...item, pollError: undefined } : item)
    })
  }, [])

  // Update an existing job
  const updateJob = useCallback((jobId: string, updates: Partial<BackupJob>) => {
    setActiveJobs(prev => 
      prev.map(job => 
        job.jobId === jobId ? { ...job, ...updates } : job
      )
    )
  }, [])

  // Remove a job from tracking
  const removeJob = useCallback((jobId: string) => {
    setActiveJobs(prev => prev.filter(job => job.jobId !== jobId))
  }, [])

  // Minimize a job (show in floating notification)
  const minimizeJob = useCallback((jobId: string) => {
    updateJob(jobId, { isMinimized: true })
  }, [updateJob])

  // Expand a job (show details)
  const expandJob = useCallback((jobId: string) => {
    updateJob(jobId, { isMinimized: false })
  }, [updateJob])

  // Get a specific job
  const getJob = useCallback((jobId: string) => {
    return activeJobs.find(job => job.jobId === jobId)
  }, [activeJobs])

  const jobsRef = useRef<BackupJob[]>([])
  jobsRef.current = activeJobs
  const callbacksRef = useRef({ updateJob, removeJob })
  callbacksRef.current = { updateJob, removeJob }
  const pollerRef = useRef<ReturnType<typeof createJobPoller<string>> | null>(null)
  if (!pollerRef.current) {
    pollerRef.current = createJobPoller<string>({
      intervalMs: 2000,
      poll: async (jobId, isCurrent) => {
        const job = jobsRef.current.find((item) => item.jobId === jobId)
        if (!job || job.isComplete) return
        const response = await fetch("/api/backup/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...job.credentials, ...job.resources, jobId: job.jobId }),
        })
        if (!response.ok) {
          const errorData = await response.json()
          throw new Error(errorData.error || "Failed to check job status")
        }
        const data = await response.json()
        if (!isCurrent()) return
        callbacksRef.current.updateJob(job.jobId, {
          status: data.status,
          progress: data.progress,
          progressMessage: data.progressMessage,
          startTime: data.startTime,
          endTime: data.endTime,
          exception: data.exception,
          output: data.output,
          isComplete: data.isComplete,
          isSuccessful: data.isSuccessful,
          pollError: undefined
        })
        if (data.isComplete) {
          pollerRef.current?.untrack(jobId)
          // Auto-remove successful jobs after 30 seconds
          if (data.isSuccessful) setTimeout(() => callbacksRef.current.removeJob(job.jobId), 30000)
        }
      },
      // A failed status check stops polling for this job and records the error on
      // it, so the view showing the job can surface it and let the admin retry or skip.
      stopOnError: true,
      onError: (jobId, err) => {
        console.error("Error checking job status:", err)
        callbacksRef.current.updateJob(jobId, { pollError: err instanceof Error ? err.message : "Failed to check job status" })
      },
    })
  }

  const wantedRef = useRef(new Set<string>())
  // Poll for job updates: one shared poller, one entry per incomplete job id.
  useEffect(() => {
    const poller = pollerRef.current!
    const wanted = new Set(activeJobs.filter((job) => isBackupJobPollable(job)).map((job) => job.jobId))
    for (const jobId of wantedRef.current) if (!wanted.has(jobId)) poller.untrack(jobId)
    for (const jobId of wanted) poller.track(jobId)
    wantedRef.current = wanted
  }, [activeJobs])

  useEffect(() => () => pollerRef.current?.stopAll(), [])

  return (
    <BackupProgressContext.Provider 
      value={{
        activeJobs,
        addJob,
        updateJob,
        removeJob,
        minimizeJob,
        expandJob,
        getJob
      }}
    >
      {children}
    </BackupProgressContext.Provider>
  )
}

export function useBackupProgress() {
  const context = useContext(BackupProgressContext)
  if (context === undefined) {
    throw new Error("useBackupProgress must be used within a BackupProgressProvider")
  }
  return context
}