import { INTUNE_TYPES } from "../intune/registry"
import type { BackupScopeCoverage } from "../tenant-connection"
import type { PermissionChoice } from "./manifest"
import { backupNeed, canBackUp, moduleForFolder } from "./modules"
import { BACKUP_SERVICES, backupServiceForFolder } from "./presentation"

const GRAPH_BACKUP_FOLDERS = INTUNE_TYPES.filter(type => {
  const needed = backupNeed(type.folder, "delegated")
  return type.backupMode !== "application" && needed !== undefined && needed !== "unsupported"
}).map(type => type.folder)

function chosenFolder(folder: string, choice: PermissionChoice): boolean {
  const found = moduleForFolder(folder)
  const picked = found && choice[found.module.id]
  return Boolean(picked && (!found.area.optIn || picked.areas?.includes(found.area.id)))
}

/** Restricts the catalog preview from Start now to the areas confirmed in the wizard. */
export function chosenBackupCoverage(coverage: BackupScopeCoverage[], choice: PermissionChoice): BackupScopeCoverage[] {
  return coverage.flatMap(row => {
    const folders = row.folders.filter(folder => chosenFolder(folder, choice))
    return folders.length ? [{ ...row, folders, readable: row.readable?.filter(folder => folders.includes(folder)) ?? null }] : []
  })
}

export function graphCliCoverage(permissions: ReadonlySet<string> | undefined, choice?: PermissionChoice): BackupScopeCoverage[] {
  const selected = choice ? GRAPH_BACKUP_FOLDERS.filter(folder => chosenFolder(folder, choice)) : GRAPH_BACKUP_FOLDERS
  return BACKUP_SERVICES.map(({ id }) => {
    const folders = selected.filter(folder => backupServiceForFolder(folder) === id)
    return { service: id, folders, readable: permissions ? folders.filter(folder => canBackUp(folder, { kind: "delegated", permissions })) : null }
  })
}
