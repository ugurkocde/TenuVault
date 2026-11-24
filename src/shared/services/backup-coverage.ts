import type { BackupCoverageIssue, BackupScopeCoverage } from "../tenant-connection"
import { BACKUP_SERVICES, backupServiceForFolder } from "./presentation"

export const COVERAGE_ISSUE_TEXT: Record<BackupCoverageIssue, string> = {
  permission: "Permission not granted",
  role: "Your role can't do this",
  unknown: "Unknown",
  license: "Service license or setup required",
}

export function groupBackupCoverage(
  folders: readonly string[],
  state: (folder: string) => "readable" | BackupCoverageIssue,
): BackupScopeCoverage[] {
  return BACKUP_SERVICES.map(({ id }) => {
    const selected = folders.filter(folder => backupServiceForFolder(folder) === id)
    const readable: string[] = []
    const issues: Record<string, BackupCoverageIssue> = {}
    for (const folder of selected) {
      const result = state(folder)
      if (result === "readable") readable.push(folder)
      else issues[folder] = result
    }
    return { service: id, folders: selected, readable, issues }
  })
}

export function coverageIssue(row: BackupScopeCoverage, folder: string): BackupCoverageIssue | undefined {
  if (row.readable === null) return "unknown"
  if (row.readable.includes(folder)) return undefined
  return row.issues?.[folder] ?? "permission"
}
