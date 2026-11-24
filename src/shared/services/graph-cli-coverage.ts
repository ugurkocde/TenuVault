import { INTUNE_TYPES } from "../intune/registry"
import type { BackupScopeCoverage } from "../tenant-connection"
import { backupNeed, canBackUp } from "./modules"
import { BACKUP_SERVICES, backupServiceForFolder } from "./presentation"

const GRAPH_BACKUP_FOLDERS = INTUNE_TYPES.filter(type => {
  const needed = backupNeed(type.folder, "delegated")
  return type.backupMode !== "application" && needed !== undefined && needed !== "unsupported"
}).map(type => type.folder)

export function graphCliCoverage(permissions: ReadonlySet<string> | undefined): BackupScopeCoverage[] {
  return BACKUP_SERVICES.map(({ id }) => {
    const folders = GRAPH_BACKUP_FOLDERS.filter(folder => backupServiceForFolder(folder) === id)
    return { service: id, folders, readable: permissions ? folders.filter(folder => canBackUp(folder, { kind: "delegated", permissions })) : null }
  })
}
