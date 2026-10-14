import { stat } from "node:fs/promises"
import { join } from "node:path"
import { BACKUP_CONTAINER, localStorageAccountName } from "../../shared/constants"
import type { LocalBlobStore } from "../storage/local-blob-store"

/** Reads of an inventory that a running backup or retention keeps changing before the check gives up. */
const ATTEMPTS = 3

/**
 * Why a backup of the tenant to the local folder would fail, or null when it would not. Reads the
 * tenant's backup inventory exactly as a backup does, so every reason that stops a backup counts:
 * files made with a key this device does not have, damaged files or manifests, a second file for
 * the same blob, missing files listed in a manifest, and file system errors. A missing or empty
 * folder is fine. The store caches a readable inventory, so a repeated check of a healthy folder
 * only compares file stamps.
 *
 * A backup or retention writing while the inventory is read can make it look incomplete, so a
 * failure only counts when the folder did not change during the read. A folder that keeps
 * changing is reported as fine; it is checked again when a page opens or the settings change.
 */
export async function localInventoryProblem(store: Pick<LocalBlobStore, "list">, root: string, tenantId: string): Promise<string | null> {
  const account = localStorageAccountName(tenantId)
  const folder = join(root, account, BACKUP_CONTAINER)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const before = await folderStamp(folder)
    try {
      await store.list(account, BACKUP_CONTAINER)
      return null
    } catch (error) {
      if (await folderStamp(folder) === before) return error instanceof Error ? error.message : String(error)
    }
  }
  return null
}

/** Adding, removing or replacing a file changes the folder's own timestamps. */
async function folderStamp(folder: string): Promise<string> {
  try {
    const info = await stat(folder, { bigint: true })
    return `${info.ino}:${info.mtimeNs}:${info.ctimeNs}`
  } catch {
    return "missing"
  }
}
