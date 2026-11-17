import { BACKUP_CONTAINER, BACKUP_OWNER_FILE } from "./constants"
import { blobPath } from "./security"

/** Large payloads never share a flat inventory with ordinary backups or discovery records. */
export const LARGE_BACKUP_CONTAINER = "intune-backups-large"
export const LARGE_BACKUP_PREFIX = "backup-large-"
export const isLargeBackup = (name: string) => name.startsWith(LARGE_BACKUP_PREFIX)
export const backupContainer = (name: string) => isLargeBackup(name) ? LARGE_BACKUP_CONTAINER : BACKUP_CONTAINER
export function backupBlobName(name: string): string {
  const [folder, ...parts] = name.split("/")
  return isLargeBackup(folder!) && !(parts.length === 1 && ["metadata.json", BACKUP_OWNER_FILE].includes(parts[0]!)) ? `payload/${name}` : name
}
export const logicalBackupName = (name: string) => name.startsWith("payload/backup-large-") ? name.slice("payload/".length) : name
export const backupStoragePath = (name: string) => `${backupContainer(name)}/${blobPath(backupBlobName(name))}`
