import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import type { BackupSettings } from "../../shared/ipc"

export function needsRecoveryKeyExport(settings: BackupSettings | null, storageAccounts: readonly (string | undefined)[]): boolean {
  return settings !== null && !settings.recoveryExported && (
    settings.hasLocalBackups || storageAccounts.some((account) => account?.startsWith(LOCAL_STORAGE_PREFIX))
  )
}
