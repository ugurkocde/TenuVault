import { moduleForFolder } from "../services/modules"
import { deferredPrivilegedRestore, DEFERRED_RESTORE_MESSAGE, DIRECTORY_REVIEW_FOLDERS } from "./directory-review-folders"
import { restoreCapability, typeForFolder } from "./registry"

/** Whether this build offers any restore or dedicated review for the folder. */
export function backupOnlyRestoreMessage(folder: string): string | undefined {
  if (deferredPrivilegedRestore(folder)) return DEFERRED_RESTORE_MESSAGE
  const type = typeForFolder(folder)
  if (!type || DIRECTORY_REVIEW_FOLDERS.includes(type.folder)) return undefined
  const permission = moduleForFolder(type.folder)?.part.restore
  if (["none", "metadata"].includes(restoreCapability(type)) ||
    (permission?.delegated === "unsupported" && permission.application === "unsupported")) {
    return DEFERRED_RESTORE_MESSAGE
  }
}
