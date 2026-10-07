import { coveredFolders, type ScopeMetadata } from "./scope"

/** Per item fingerprints a backup's metadata.json holds, keyed by "<type folder>/<Intune ID>". */
export type BackupItems = Record<string, {
  file: string
  hash: string
  /**
   * For types whose assignments earlier versions could not read (assignmentsFormerlyExpanded): the hash
   * with `assignments: []`, as those versions recorded it.
   */
  hashWithEmptyAssignments?: string
}>

export interface BackupFingerprint extends ScopeMetadata {
  Status?: unknown
  Items?: unknown
}

export interface ItemChange {
  /** Registry folder of the item's type. */
  folder: string
  id: string
  change: "added" | "modified" | "removed"
  /** File name in the newer backup, or in the older one for removed items. */
  file: string
  /** File name in the older backup, for modified items. */
  previousFile?: string
}

export interface ChangeSummary {
  added: number
  modified: number
  removed: number
}

export function itemsOf(metadata: BackupFingerprint | null | undefined): BackupItems | null {
  const items = metadata?.Items
  return items && typeof items === "object" && !Array.isArray(items) ? (items as BackupItems) : null
}

/** Whether a backup can be compared: it finished, and it was made by a version that records fingerprints. */
export function comparable(metadata: BackupFingerprint | null | undefined): boolean {
  return itemsOf(metadata) !== null && String(metadata?.Status ?? "").toLowerCase() !== "failed"
}

/**
 * Items added, changed and removed between an older and a newer backup. Only types both backups hold a
 * complete copy of are compared, so a backup that left apps out does not report every app as removed.
 */
export function compareBackups(older: BackupFingerprint, newer: BackupFingerprint): ItemChange[] {
  const before = itemsOf(older)
  const after = itemsOf(newer)
  if (!before || !after) return []
  const olderFolders = coveredFolders(older)
  const shared = new Set([...coveredFolders(newer)].filter((folder) => olderFolders.has(folder)))
  const inScope = (key: string) => shared.has(key.slice(0, key.indexOf("/")))
  const split = (key: string) => ({ folder: key.slice(0, key.indexOf("/")), id: key.slice(key.indexOf("/") + 1) })

  const changes: ItemChange[] = []
  for (const [key, item] of Object.entries(after)) {
    if (!inScope(key)) continue
    const previous = before[key]
    if (!previous) changes.push({ ...split(key), change: "added", file: item.file })
    else if (!sameItem(previous, item)) changes.push({ ...split(key), change: "modified", file: item.file, previousFile: previous.file })
  }
  for (const [key, item] of Object.entries(before)) {
    if (inScope(key) && !after[key]) changes.push({ ...split(key), change: "removed", file: item.file })
  }
  return changes
}

/**
 * An older backup without hashWithEmptyAssignments was made by a version that could not read the item's
 * assignments, so the newer item is compared as that version would have recorded it: reading the
 * assignments now is not a change.
 */
export function sameItem(previous: BackupItems[string], item: BackupItems[string]): boolean {
  if (previous.hash === item.hash) return true
  return previous.hashWithEmptyAssignments === undefined && item.hashWithEmptyAssignments !== undefined && previous.hash === item.hashWithEmptyAssignments
}

export function summarize(changes: ItemChange[]): ChangeSummary {
  return {
    added: changes.filter((change) => change.change === "added").length,
    modified: changes.filter((change) => change.change === "modified").length,
    removed: changes.filter((change) => change.change === "removed").length,
  }
}
