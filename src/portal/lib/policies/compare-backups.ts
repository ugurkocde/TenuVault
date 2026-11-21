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
  const policy = comparisonOmission(older.metadata, newer.metadata)
  for (const [key, item] of Object.entries(before ?? {})) {
    const other = after?.[key]
    if (!other || (!policy && !item.omitted && !other.omitted)) continue
    for (const path of [...(item.partialCollections ?? []), ...(other.partialCollections ?? [])]) excludedPaths.add(path)
  }
  const candidates = compareBackups(older.metadata, newer.metadata, true)
  let partial = [before, after].some((items) => Object.values(items ?? {}).some((item) => item.omitted))
  const readItem = async (backup: Backup, folder: string, id: string, item: BackupItems[string], projectedComparison: boolean): Promise<Item | null> => {
    if (typeof item.file !== "string" || !item.file.endsWith(".json") || item.file.includes("/") || item.file.includes("\\")) throw new Error("The backup inventory has an invalid file name.")
    const response = await read(`${backup.id}/${snapshotPath(folder, item)}`)
    if (response.status === 404 && !projectedComparison) return null
    if (!response.ok) throw new Error(projectedComparison ? "The backup file could not be read." : `Backup storage returned ${response.status}. Check storage access and retry.`)
    return item.omitted ? await readProjectedSnapshot(response, { ...item, id }) : (await response.json()) as Item
  }
  let detailed = 0
  const requests = candidates.map(change => ({ change, details: change.change === "modified" && detailed++ < detailLimit }))
  const results = await mapLimit(requests, 6, async ({ change, details }) => {
    if (change.change !== "modified") return { change }
    const key = `${change.folder}/${change.id}`
    const left = before![key]!
    const right = after![key]!
    const projected = left.omitted !== undefined || right.omitted !== undefined
    const mixed = older.metadata.OmissionVersion !== newer.metadata.OmissionVersion &&
      (older.metadata.OmissionVersion === OMISSION_VERSION || newer.metadata.OmissionVersion === OMISSION_VERSION)
    const projectionRead = projected || mixed || !!policy
    if (!projectionRead && !details) return { change }
    if (projectionRead && reserveComparisonRead && !reserveComparisonRead()) {
      partial = true
      return null
    }
    try {
      const [oldItem, newItem] = await Promise.all([
        readItem(older, change.folder, change.id, left, projectionRead),
        readItem(newer, change.folder, change.id, right, projectionRead),
      ])
      if (!oldItem || !newItem) return { change }
      const [olderView, newerView, excluded] = observablePair(change.folder, oldItem, newItem, left.secretsMasked || right.secretsMasked, policy)
      for (const path of excluded) excludedPaths.add(path)
      const [oldView, newView] = withoutUnreadAssignments(typeForFolder(change.folder), olderView, newerView)
      const fields = compare(oldView, newView)
      if (projectionRead && !fields.length) return null
      return { change, ...(details ? { fields: fields.slice(0, 50) } : {}) }
    } catch (error) {
      if (!projectionRead) throw error
      partial = true
      return null
    }
  })
  return { entries: results.filter((entry) => entry !== null), partial: partial || excludedPaths.size > 0, excludedPaths: [...excludedPaths].sort() }
}
