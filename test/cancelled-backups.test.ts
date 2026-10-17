import { describe, expect, it } from "vitest"
import { backupHealth, backupSummary, normalizeBackupStatus } from "../src/portal/lib/backup-health"
import { manifestStatus, stoppedEarly } from "../src/shared/intune/backup-status"
import { comparable } from "../src/shared/intune/backup-changes"
import { statusKind, statusLabel, unresolvedNotice, type BackupSummary } from "../src/portal/components/backup/types"
import { comparableBackups } from "../src/portal/components/drift/backup-pair-picker"
import { backupCompleteness, selectBackupPair, type BackupMetadata } from "../src/shared/intune/drift"
import { incompleteReason } from "../src/portal/lib/policies/backup-manifest"
import { checkBackups } from "../src/main/features/health-review/rules"

const CANCEL_ERROR = "Backup cancelled by you. This run is never offered as a complete backup."
const now = new Date("2026-10-17T12:00:00Z")
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000)

describe("cancelled backup status", () => {
  it("reads Cancelled manifests, and Failed manifests carrying the cancel message, as cancelled", () => {
    expect(normalizeBackupStatus({ status: "Cancelled" })).toBe("cancelled")
    expect(manifestStatus({ Status: "Cancelled", Error: CANCEL_ERROR })).toBe("Cancelled")
    expect(manifestStatus({ Status: "Failed", Error: CANCEL_ERROR })).toBe("Cancelled")
    // Deadline, sign-in, network and storage stops stay failed.
    expect(manifestStatus({ Status: "Failed", Error: "Backup timed out after the 30 minute job deadline. Retry the backup." })).toBe("Failed")
    expect(manifestStatus({ Status: "Failed" })).toBe("Failed")
    expect(manifestStatus({ Status: "Success", Error: CANCEL_ERROR })).toBe("Success")
    expect(manifestStatus({ status: "Completed" })).toBe("Completed")
  })

  it("treats a cancelled backup as never complete, like a failed one", () => {
    expect(["Cancelled", "cancelled", "Failed", "FAILED"].map(stoppedEarly)).toEqual([true, true, true, true])
    expect(["Success", "Completed", "CompletedWithWarnings", "running", "incomplete", undefined].map(stoppedEarly)).toEqual([false, false, false, false, false, false])
  })
})

describe("Dashboard counts with a cancelled backup", () => {
  const folders = (statuses: Array<[string, number]>) => statuses.map(([status, hours], index) => ({ status: normalizeBackupStatus({ status }), timestamp: hoursAgo(hours), runId: `run-${index}` }))

  it("counts a cancelled backup in storage only, and names it on the Last backup chip", () => {
    const summary = backupSummary(folders([["Cancelled", 1], ["Success", 2], ["Failed", 3]]), [], { since: hoursAgo(24) })
    expect(summary).toMatchObject({ stored: 3, successful: 1, failed: 1, finished: 2, successRate: 50, inProgress: 0, latestStatus: "cancelled" })
    // Without it, the rate and the failed count are the same.
    expect(backupSummary(folders([["Success", 2], ["Failed", 3]]), [], { since: hoursAgo(24) })).toMatchObject({ successful: 1, failed: 1, successRate: 50 })
  })

  it("leaves the success rate empty when only a cancelled backup is in the period", () => {
    expect(backupSummary(folders([["Cancelled", 1]]), [], { since: hoursAgo(24) })).toMatchObject({ stored: 1, successful: 0, failed: 0, finished: 0, successRate: null, latestStatus: "cancelled" })
  })

  it("does not count a cancelled run as running while the engine still reports it", () => {
    const summary = backupSummary(folders([["Cancelled", 0.1]]), [], { since: hoursAgo(24), live: ["run-0"] })
    expect(summary).toMatchObject({ inProgress: 0, latestStatus: "cancelled" })
  })

  it("gives no protection in tenant health, and does not turn it critical on its own", () => {
    expect(backupHealth(folders([["Cancelled", 1]]), now)).toBe("warning")
    expect(backupHealth(folders([["Failed", 1]]), now)).toBe("critical")
    // The newest complete backup decides, whatever was cancelled after it.
    expect(backupHealth(folders([["Cancelled", 1], ["Success", 2]]), now)).toBe("healthy")
    expect(backupHealth(folders([["Cancelled", 1], ["Success", 30]]), now)).toBe("warning")
  })
})

describe("backups the user cancelled elsewhere in the app", () => {
  const listed = (id: string, timestamp: string, status: string): BackupSummary => ({ id, timestamp, type: "manual", status, totalPolicies: 3, scope: null, size: 1, duration: null, changes: null, comparedWith: null })

  it("shows a cancelled backup in the backup list and restore wizard as Cancelled, neither complete nor failed", () => {
    expect(statusKind("Cancelled")).toBe("cancelled")
    expect(statusLabel("Cancelled")).toBe("Cancelled")
    expect(statusKind("Failed")).toBe("failed")
    expect(statusLabel("Failed")).toBe("Failed")
  })

  it("never compares a cancelled backup's items with the backups next to it", () => {
    const items = { "DeviceConfigurations/a": { file: "A.json", hash: "h" } }
    expect(comparable({ Status: "Cancelled", Items: items })).toBe(false)
    expect(comparable({ Status: "Failed", Items: items })).toBe(false)
    expect(comparable({ Status: "Success", Items: items })).toBe(true)
  })

  it("never offers a cancelled backup to drift detection", async () => {
    expect(backupCompleteness("Cancelled")).toBe("incomplete")
    const list = [listed("newer", "2026-10-15T02:00:00Z", "Success"), listed("cancelled", "2026-10-14T02:00:00Z", "Cancelled"), listed("older", "2026-10-12T02:00:00Z", "Success")]
    expect(comparableBackups(list).map((backup) => backup.id)).toEqual(["newer", "older"])
    const metadata: Record<string, BackupMetadata> = { newer: { Status: "Success" }, cancelled: { Status: "Cancelled" }, older: { Status: "Success" } }
    const folders = list.map((backup) => ({ name: backup.id, timestamp: backup.timestamp }))
    const load = async (name: string) => metadata[name] ?? null
    const pair = await selectBackupPair({ folders, tenantId: "tenant", load })
    expect([pair.baseline.name, pair.comparison.name]).toEqual(["older", "newer"])
    await expect(selectBackupPair({ folders, tenantId: "tenant", load, baseline: "older", comparison: "cancelled" })).rejects.toMatchObject({ code: "BACKUP_INCOMPLETE" })
  })

  it("refuses a full restore of a cancelled backup and allows its saved items one by one, like a failed one", () => {
    const items = new Map([["backup-1/DeviceConfigurations/A.json", { id: "a", hash: "h" }]])
    const paths = [...items.keys()]
    for (const Status of ["Cancelled", "Failed"]) {
      expect(incompleteReason({ Status, Failures: 0, Error: CANCEL_ERROR }, items, paths, true)).toContain("incomplete")
      expect(incompleteReason({ Status, Failures: 0, Error: CANCEL_ERROR }, items, paths, false)).toBeUndefined()
      expect(incompleteReason({ Status, Failures: 0 }, null, paths, false)).toContain("incomplete")
    }
    expect(incompleteReason({ Status: "Cancelled", Failures: 0 }, items, paths, true)).toBe("This backup is recorded as cancelled and is incomplete. Restore selected items from it, or restore from a complete backup instead.")
  })

  it("treats a cancelled latest backup as no complete backup in the health review, without a failure", () => {
    const review = (statuses: Array<[string, number]>) => checkBackups("tenant", { outcome: "ok", backups: statuses.map(([status, hours]) => ({ status, timestamp: hoursAgo(hours).toISOString() })) }, now)
    expect(review([["Cancelled", 1]]).detail).toBe("No complete backup was found for this tenant.")
    expect(review([["Cancelled", 1]])).toEqual(review([]))
    expect(review([["Failed", 1]]).detail).toBe("No complete backup was found and recent backups failed or stopped early.")
    // A cancel after a recent complete backup raises nothing.
    expect(review([["Cancelled", 1], ["Success", 2]]).findings).toEqual([])
  })

  it("words the notice for folders whose ownership could not be read", () => {
    expect(unresolvedNotice(1)).toBe("1 backup could not be read. Select Refresh to try again.")
    expect(unresolvedNotice(3)).toBe("3 backups could not be read. Select Refresh to try again.")
  })
})
