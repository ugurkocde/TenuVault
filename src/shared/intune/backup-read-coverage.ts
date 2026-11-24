import { INTUNE_TYPES } from "./registry"
import { coveredFolders, LEGACY_FOLDERS, type ScopeMetadata } from "./scope"
import { stoppedEarly } from "./backup-status"
import { largeIndexes, type LargeIndexes } from "../large-backup"

export interface BackupReadMetadata extends ScopeMetadata {
  Status?: unknown
  Failures?: unknown
  Coverage?: unknown
  Outcomes?: unknown
  LargeItems?: unknown
}

/** Modern manifests must confirm a complete read. Older manifests use the recorded scope and exclusions. */
export function backupReadCoverage(metadata: BackupReadMetadata | null | undefined) {
  if (!metadata) return { selected: [], readable: new Set<string>() }
  const included = metadata.Scope?.Included
  const selected = new Set(Array.isArray(included) ? included : LEGACY_FOLDERS)
  const excluded = metadata.Scope?.Excluded
  if (Array.isArray(excluded)) for (const folder of excluded) selected.delete(folder)
  const readable = stoppedEarly(metadata.Status) ? new Set<string>() : coveredFolders(metadata)
  const outcomes = new Map<string, unknown>()
  if (Array.isArray(metadata.Outcomes)) {
    for (const outcome of metadata.Outcomes) {
      if (!outcome || typeof outcome.Folder !== "string") continue
      outcomes.set(outcome.Folder, outcomes.has(outcome.Folder) ? undefined : outcome.Outcome)
    }
  }
  const folders = INTUNE_TYPES.filter(type => selected.has(type.folder)).map(type => type.folder)
  let indexes: LargeIndexes
  try { indexes = largeIndexes(metadata) }
  catch { return { selected: folders, readable: new Set<string>() } }
  // Older backups could count a failed policy read without recording which type it belonged to.
  const unassignedFailures = typeof metadata.Failures === "number"
    && metadata.Failures > (Array.isArray(metadata.FailedTypes) ? metadata.FailedTypes.length : 0)
  const needsOutcomes = metadata.Outcomes !== undefined || metadata.Coverage === "Incomplete" || unassignedFailures
  for (const folder of readable) {
    const outcome = outcomes.get(folder)
    if (needsOutcomes && outcome !== "saved" && outcome !== "notConfigured") {
      readable.delete(folder)
    }
    if (Object.hasOwn(indexes, folder) && !indexes[folder]?.complete) readable.delete(folder)
  }
  return { selected: folders, readable }
}

export function comparisonCoverage(older: BackupReadMetadata | null, newer: BackupReadMetadata | null) {
  const before = backupReadCoverage(older)
  const after = backupReadCoverage(newer)
  const shared = new Set([...after.readable].filter(folder => before.readable.has(folder)))
  const unknown = [...new Set([...before.selected, ...after.selected])].filter(folder => !shared.has(folder))
  return { shared, unknown }
}
