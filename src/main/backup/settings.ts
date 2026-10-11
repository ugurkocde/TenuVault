import type { BackupSettings } from "../../shared/ipc"
import type { BackupKeys } from "./keys"
import { localBackupsExist } from "../storage/local-blob-store"
import type { KeyValueStore } from "../storage/secure-store"

export async function readBackupSettings(localFolder: string, keys: BackupKeys, store: KeyValueStore): Promise<BackupSettings> {
  const keyFingerprint = keys.fingerprint()
  return {
    localFolder, keyFingerprint,
    recoveryExported: store.get("backup.recovery-exported") === keyFingerprint,
    hasLocalBackups: await localBackupsExist(localFolder),
  }
}
