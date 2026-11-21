import { compareBackups, itemsOf, type BackupFingerprint, type BackupItems } from "../../../shared/intune/backup-changes"
import { comparisonOmission, observablePair, OMISSION_VERSION, snapshotPath } from "../../../shared/intune/secret-omission"
import { withoutUnreadAssignments } from "../../../shared/intune/read"
import { typeForFolder, type Item } from "../../../shared/intune/registry"
import { mapLimit } from "../../../shared/map-limit"
import { readProjectedSnapshot } from "./backup-manifest"

type Backup = { id: string; metadata: BackupFingerprint }

export async function compareBackupFiles(
  older: Backup,
  newer: Backup,
  read: (path: string) => Promise<Response>,
  compare: (before: Item, after: Item) => unknown[],
  detailLimit = 0,
  reserveComparisonRead?: () => boolean,
) {
  const excludedPaths = new Set<string>()
  const before = itemsOf(older.metadata)
  const after = itemsOf(newer.metadata)
  for (const [key, item] of Object.entries(before ?? {})) {
    const other = after?.[key]
    if (!other) continue
    for (const path of [...(item.partialCollections ?? []), ...(other.partialCollections ?? [])]) excludedPaths.add(path)
  }
  const candidates = compareBackups(older.metadata, newer.metadata, true)
  const policy = comparisonOmission(older.metadata, newer.metadata)
  let partial = [before, after].some((items) => Object.values(items ?? {}).some((item) => item.omitted))
  const readItem = async (backup: Backup, folder: string, id: string, item: BackupItems[string]): Promise<Item> => {
    if (typeof item.file !== "string" || !item.file.endsWith(".json") || item.file.includes("/") || item.file.includes("\\")) throw new Error("The backup inventory has an invalid file name.")
    const response = await read(`${backup.id}/${snapshotPath(folder, item)}`)
    if (!response.ok) throw new Error("The backup file could not be read.")
    return item.omitted ? await readProjectedSnapshot(response, { ...item, id }) : (await response.json()) as Item
  }
  const results = await mapLimit(candidates.map((change, index) => ({ change, index })), 6, async ({ change, index }) => {
    if (change.change !== "modified") return { change }
    const key = `${change.folder}/${change.id}`
    const left = before![key]!
    const right = after![key]!
    const projected = left.omitted !== undefined || right.omitted !== undefined
    const mixed = older.metadata.OmissionVersion !== newer.metadata.OmissionVersion &&
      (older.metadata.OmissionVersion === OMISSION_VERSION || newer.metadata.OmissionVersion === OMISSION_VERSION)
    if (!projected && !mixed && !left.partialCollections?.length && !right.partialCollections?.length && index >= detailLimit) return { change }
    if (reserveComparisonRead && !reserveComparisonRead()) {
      partial = true
      return null
    }
    try {
      const [oldItem, newItem] = await Promise.all([
        readItem(older, change.folder, change.id, left),
        readItem(newer, change.folder, change.id, right),
      ])
      const [olderView, newerView, excluded] = observablePair(change.folder, oldItem, newItem, left.secretsMasked || right.secretsMasked, policy)
      for (const path of excluded) excludedPaths.add(path)
      const [oldView, newView] = withoutUnreadAssignments(typeForFolder(change.folder), olderView, newerView)
      const fields = compare(oldView, newView)
      if ((projected || mixed || policy || excluded.length) && !fields.length) return null
      return { change, ...(index < detailLimit ? { fields: fields.slice(0, 50) } : {}) }
    } catch {
      partial = true
      return projected || mixed ? null : { change }
    }
  })
  return { entries: results.filter((entry) => entry !== null), partial: partial || excludedPaths.size > 0, excludedPaths: [...excludedPaths].sort() }
}
