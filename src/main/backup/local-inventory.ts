import { stat } from "node:fs/promises"
import { join } from "node:path"
import { BACKUP_CONTAINER, localStorageAccountName } from "../../shared/constants"
import { damageSummary, type LocalBlobStore } from "../storage/local-blob-store"

/** Reads of an inventory that a running backup or retention keeps changing before the check gives up. */
const ATTEMPTS = 3

/**
 * What in the tenant's local backup folder cannot be used, or null when everything can. Reads
 * the tenant's backup inventory exactly as backups, downloads and restores do, so every reason
 * counts: files made with a key this device does not have, damaged files or manifests, a second
 * file for the same blob, missing files listed in a manifest, and file system errors. Healthy
 * backups stay usable next to damaged files, but retention is paused while any are present. A
 * missing or empty folder is fine. The store caches the inventory, so a repeated check of an
 * unchanged folder only compares file stamps.
 *
 * A backup or retention writing while the inventory is read can make it look incomplete, so a
 * problem only counts when the folder did not change during the read. A folder that keeps
 * changing is reported as fine; it is checked again when a page opens or the settings change.
 */
export async function localInventoryProblem(store: Pick<LocalBlobStore, "damage">, root: string, tenantId: string): Promise<string | null> {
  const account = localStorageAccountName(tenantId)
  const folder = join(root, account, BACKUP_CONTAINER)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const before = await folderStamp(folder)
    let problem: string | null
    try {
      problem = damageSummary(await store.damage(account, BACKUP_CONTAINER))
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    if (problem === null) return null
    if (await folderStamp(folder) === before) return problem
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
