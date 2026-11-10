import { expect, it, vi } from "vitest"
import { trialBackupObserver } from "../src/main/license/usage-actions"
import type { BackupJob, BackupRequest } from "../src/main/backup/engine"

it.each(["Completed", "Failed", "Cancelled"])("counts a finished %s job once, never per policy", status => {
  const record = vi.fn()
  const observe = trialBackupObserver(record)
  const job = { tenantId: "contoso", status, failures: 0 } as BackupJob
  const request = { trigger: "scheduled", scheduleFrequency: "daily", storageAccountName: "azure" } as BackupRequest
  observe(job, request); observe(job, request)
  expect(record.mock.calls).toEqual(status === "Completed" ? [["contoso", "dailySchedule"], ["contoso", "azureStorage"]] : [])
})
it.each(["weekly", undefined])("does not count a %s local backup as daily", frequency => {
  const record = vi.fn()
  trialBackupObserver(record)({ tenantId: "contoso", status: "Completed", failures: 0 } as BackupJob, { trigger: "scheduled", scheduleFrequency: frequency, storageAccountName: "tvlocal-contoso" } as BackupRequest)
  expect(record).not.toHaveBeenCalled()
})
it("ignores unsuccessful jobs and makes no network call", () => {
  const network = vi.fn(() => { throw new Error("Network forbidden") })
  vi.stubGlobal("fetch", network)
  try {
    const record = vi.fn()
    trialBackupObserver(record)({ tenantId: "contoso", status: "Completed", failures: 1 } as BackupJob, { trigger: "scheduled", scheduleFrequency: "daily", storageAccountName: "azure" } as BackupRequest)
    expect(record).not.toHaveBeenCalled()
    trialBackupObserver(record)({ tenantId: "contoso", status: "Completed", failures: 0 } as BackupJob, { trigger: "scheduled", scheduleFrequency: "daily", storageAccountName: "azure" } as BackupRequest)
    expect(record).toHaveBeenCalledTimes(2)
    expect(network).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

it("contains throwing store writes and still attempts the other tally", () => {
  const store = { set: vi.fn(() => { throw new Error("Store unavailable") }) }
  const observe = trialBackupObserver(() => store.set())
  const job = { tenantId: "contoso", status: "Completed", failures: 0 } as BackupJob
  const request = { trigger: "scheduled", scheduleFrequency: "daily", storageAccountName: "azure" } as BackupRequest
  expect(() => observe(job, request)).not.toThrow()
  expect(store.set).toHaveBeenCalledTimes(2)
  observe(job, request)
  expect(store.set).toHaveBeenCalledTimes(2)
})
