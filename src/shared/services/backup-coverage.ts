import type { BackupCoverageIssue, BackupScopeCoverage } from "../tenant-connection"
import { BACKUP_SERVICES, backupServiceForFolder } from "./presentation"
import { moduleForFolder } from "./modules"

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

/** Keep partially readable areas usable while naming any areas with settings left out. */
export function backupAreaCoverage(row: BackupScopeCoverage) {
  const areas = new Map<string, { label: string; readable: boolean; missing: boolean; unknown: boolean }>()
  for (const folder of row.folders) {
    const entry = moduleForFolder(folder)
    const key = entry ? `${entry.module.id}/${entry.area.id}` : folder
    const area = areas.get(key) ?? { label: entry?.area.label ?? folder, readable: false, missing: false, unknown: false }
    const issue = coverageIssue(row, folder)
    area.readable ||= issue === undefined
    area.missing ||= issue !== undefined && issue !== "unknown"
    area.unknown ||= issue === "unknown"
    areas.set(key, area)
  }
  const values = [...areas.values()]
  return {
    readable: values.filter(area => area.readable).length,
    complete: values.filter(area => area.readable && !area.missing && !area.unknown).length,
    total: values.length,
    missing: values.filter(area => area.missing).map(area => area.label),
    unknown: values.some(area => area.unknown),
  }
}

export function needsBackupAccess(row: BackupScopeCoverage | undefined): boolean {
  return Boolean(row?.folders.length && row.readable?.length === 0 && !backupAreaCoverage(row).unknown)
}
