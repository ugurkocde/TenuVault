import type { Tenant } from "~/contexts/TenantContext"
import type { BackupJob, useBackupProgress } from "~/contexts/BackupProgressContext"
import type { BackupTarget } from "../components/RunBackupDialog"

type AddJob = ReturnType<typeof useBackupProgress>["addJob"]

/** The tenant as RunBackupDialog needs it, or an error when its backup storage is not chosen yet. */
export function backupTarget(tenant: Tenant): BackupTarget {
  if (!tenant.credentials || !tenant.resources?.storageAccountName) {
    throw new Error("Choose where backups for this tenant are stored in Settings first.")
  }
  return { name: tenant.name, credentials: tenant.credentials, storageAccountName: tenant.resources.storageAccountName }
}

/** Tracks a started backup of a tenant in the floating progress panel. */
export function trackBackup(tenant: Tenant, jobId: string, addJob: AddJob, options: Pick<BackupJob, "isHidden" | "quiet"> = {}): void {
  if (!tenant.credentials) return
  addJob({
    jobId,
    tenantName: tenant.name,
    tenantId: tenant.credentials.tenantId,
    status: "Running",
    progress: 5,
    progressMessage: "Starting backup...",
    startTime: new Date().toISOString(),
    isComplete: false,
    isSuccessful: false,
    credentials: tenant.credentials,
    resources: {
      subscriptionId: tenant.resources?.subscriptionId ?? "",
      resourceGroupName: tenant.resources?.resourceGroupName ?? "",
      automationAccountName: tenant.resources?.automationAccountName ?? "",
      storageAccountName: tenant.resources?.storageAccountName ?? "",
    },
    ...options,
  })
}

/**
 * Calls onEnd once the backup job has ended, reading its status every intervalMs. A job the app no
 * longer knows has ended too. Returns a function that stops watching.
 */
export function whenBackupEnds(jobId: string, onEnd: () => void, intervalMs = 3000): () => void {
  let stopped = false
  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  const timer = setInterval(() => {
    void fetch("/api/backup/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId }) })
      .then(async (response) => {
        const data = response.ok ? ((await response.json().catch(() => null)) as { isComplete?: boolean } | null) : null
        if (stopped || !(response.status === 404 || data?.isComplete)) return
        stop()
        onEnd()
      })
      .catch(() => undefined)
  }, intervalMs)
  return stop
}
