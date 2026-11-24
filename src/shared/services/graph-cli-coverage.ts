import { INTUNE_TYPES } from "../intune/registry"
import type { BackupScopeCoverage } from "../tenant-connection"
import type { PermissionChoice } from "./manifest"
import { backupNeed, canBackUp, moduleForFolder } from "./modules"
import { BACKUP_SERVICES, backupServiceForFolder } from "./presentation"

const GRAPH_BACKUP_FOLDERS = INTUNE_TYPES.filter(type => {
  const needed = backupNeed(type.folder, "delegated")
  return type.backupMode !== "application" && needed !== undefined && needed !== "unsupported"
}).map(type => type.folder)

export function graphCliCoverage(permissions: ReadonlySet<string> | undefined, choice?: PermissionChoice): BackupScopeCoverage[] {
  const selected = choice ? GRAPH_BACKUP_FOLDERS.filter(folder => {
    const found = moduleForFolder(folder)
    const picked = found && choice[found.module.id]
    return picked && (!found.area.optIn || picked.areas?.includes(found.area.id))
  }) : GRAPH_BACKUP_FOLDERS
  return BACKUP_SERVICES.map(({ id }) => {
    const folders = selected.filter(folder => backupServiceForFolder(folder) === id)
    return { service: id, folders, readable: permissions ? folders.filter(folder => canBackUp(folder, { kind: "delegated", permissions })) : null }
  })
}
