import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import type { Feature } from "../../shared/plans"
import type { BackupJob, BackupRequest } from "../backup/engine"

export function trialBackupObserver(record: (tenant: string, feature: Feature) => void) {
  const finished = new WeakSet<BackupJob>()
  const recordUsage = (tenant: string, feature: Feature) => {
    try { record(tenant, feature) } catch { /* A tally never changes a completed action. */ }
  }
  return (job: BackupJob, request: BackupRequest): void => {
    if (finished.has(job)) return
    finished.add(job)
    if (job.status !== "Completed" || job.failures) return
    if (request.trigger === "scheduled" && request.scheduleFrequency === "daily") recordUsage(job.tenantId, "dailySchedule")
    if (!request.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)) recordUsage(job.tenantId, "azureStorage")
  }
}
