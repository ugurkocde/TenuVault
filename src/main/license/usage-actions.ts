import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import type { Feature } from "../../shared/plans"
import type { BackupJob, BackupRequest } from "../backup/engine"

export function trialBackupObserver(record: (tenant: string, feature: Feature) => void) {
  const finished = new WeakSet<BackupJob>()
  return (job: BackupJob, request: BackupRequest): void => {
    if (finished.has(job)) return
    finished.add(job)
    if (job.status !== "Completed" || job.failures) return
    if (request.trigger === "scheduled" && request.scheduleFrequency === "daily") record(job.tenantId, "dailySchedule")
    if (!request.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)) record(job.tenantId, "azureStorage")
  }
}
