import { AREAS } from "../../shared/intune/scope"
import { BACKUP_SERVICES, backupServiceForFolder, type BackupService } from "../../shared/services/presentation"

export { BACKUP_SERVICES }
export type BackupServiceFilter = BackupService | "all"

export function parseBackupService(value: string | null): BackupServiceFilter {
  return BACKUP_SERVICES.find(service => service.id === value)?.id ?? "all"
}

export function matchesBackupService(folder: string, service: BackupServiceFilter): boolean {
  return service === "all" || backupServiceForFolder(folder) === service
}


export const BACKUP_SERVICE_AREAS = BACKUP_SERVICES.map(service => ({
  ...service,
  areas: AREAS.map(({ area, types }) => ({ area, types: types.filter(type => matchesBackupService(type.folder, service.id)) }))
    .filter(group => group.types.length > 0),
}))
