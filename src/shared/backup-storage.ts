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

export const LARGE_STORAGE_PROVISIONING = "Ask your Azure administrator to rerun New-TenuVaultStorage.ps1 -BackupReaderAppId <application ID> with the usual storage arguments to provision intune-backups-large and its container-scoped TenuVault Backup Writer assignment. Check this identity's access to that container. See https://docs.tenuvault.com/backups/backup-reader/#step-3-your-azure-administrator-storage-write-access-azure-backups-only."
export const LARGE_STORAGE_UNAVAILABLE = `Storage not provisioned for large backups, or large storage is unavailable. ${LARGE_STORAGE_PROVISIONING}`
