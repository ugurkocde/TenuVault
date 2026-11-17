import { LARGE_BACKUP_CONTAINER } from "../../shared/backup-storage"
import { stat } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
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
  for (const container of [BACKUP_CONTAINER, LARGE_BACKUP_CONTAINER]) {
    const folder = join(root, account, container)
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const before = await folderStamp(folder)
      if (container === LARGE_BACKUP_CONTAINER && before === "missing") break
      let problem: string | null
      try {
        problem = damageSummary(await store.damage(account, container))
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error)
      }
      if (problem === null) break
      if (await folderStamp(folder) === before) return problem
    }
  }
  return null
}

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The folder Open backup folder shows: the tenant's backup folder when it exists, otherwise the
 * root. The tenant comes from the renderer, so anything but a tenant ID is refused, and the
 * folder must stay inside the root.
 */
export async function folderToOpen(root: string, tenantId: unknown): Promise<string> {
  if (tenantId === undefined || tenantId === null) return root
  if (typeof tenantId !== "string" || !TENANT_ID.test(tenantId)) throw new Error("Unknown tenant.")
  const folder = join(root, localStorageAccountName(tenantId), BACKUP_CONTAINER)
  const inside = relative(root, folder)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Unknown tenant.")
  try {
    if ((await stat(join(root, localStorageAccountName(tenantId), LARGE_BACKUP_CONTAINER)).catch(() => null))?.isDirectory()) return join(root, localStorageAccountName(tenantId))
    return (await stat(folder)).isDirectory() ? folder : root
  } catch {
    return root
  }
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
