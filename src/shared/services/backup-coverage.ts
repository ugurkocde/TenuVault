import { INTUNE_TYPES } from "../intune/registry"
import type { BackupCoverageIssue, BackupScopeCoverage } from "../tenant-connection"
import type { PermissionChoice } from "./manifest"
import { BACKUP_SERVICES, backupServiceForFolder } from "./presentation"
import { backupNeed, canBackUp, moduleForFolder } from "./modules"

export const COVERAGE_ISSUE_TEXT: Record<BackupCoverageIssue, string> = {
  permission: "Permission not granted",
  role: "Your role can't do this",
  unknown: "Unknown",
  license: "Service license or setup required",
}

export const DELEGATED_BACKUP_FOLDERS = INTUNE_TYPES.filter(type => {
  const needed = backupNeed(type.folder, "delegated")
  return type.backupMode !== "application" && needed !== undefined && needed !== "unsupported"
}).map(type => type.folder)

export function chosenFolder(folder: string, choice: PermissionChoice): boolean {
  const found = moduleForFolder(folder)
  const picked = found && choice[found.module.id]
  return Boolean(picked && (!found.area.optIn || picked.areas?.includes(found.area.id)))
}

/** Restricts the backup coverage preview to the areas confirmed in the wizard. */
export function chosenBackupCoverage(coverage: BackupScopeCoverage[], choice: PermissionChoice): BackupScopeCoverage[] {
  return coverage.flatMap(row => {
    const folders = row.folders.filter(folder => chosenFolder(folder, choice))
    return folders.length ? [{ ...row, folders, readable: row.readable?.filter(folder => folders.includes(folder)) ?? null }] : []
  })
}

export function delegatedBackupCoverage(permissions: ReadonlySet<string> | undefined, choice?: PermissionChoice): BackupScopeCoverage[] {
  const selected = choice ? DELEGATED_BACKUP_FOLDERS.filter(folder => chosenFolder(folder, choice)) : DELEGATED_BACKUP_FOLDERS
  const coverage = groupBackupCoverage(selected, folder =>
    !permissions ? "unknown" : canBackUp(folder, { kind: "delegated", permissions }) ? "readable" : "permission")
  return coverage.map(row => ({ ...row, readable: permissions ? row.readable : null }))
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
