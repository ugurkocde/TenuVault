import { INTUNE_TYPES } from "./registry"
import { coveredFolders, LEGACY_FOLDERS, type ScopeMetadata } from "./scope"
import { stoppedEarly } from "./backup-status"
import { largeIndexes, type LargeIndexes } from "../large-backup"

export interface BackupReadMetadata extends ScopeMetadata {
  Status?: unknown
  status?: unknown
  Failures?: unknown
  Coverage?: unknown
  Outcomes?: unknown
  LargeItems?: unknown
}

export const LEGACY_COMPARISON_NOTICE = "An older backup recorded a read failure without identifying the type. Some reported deletions may be policies that failed to read."

export interface ComparisonCoverageNotice {
  unknownTypes?: string[]
  legacyReadFailure?: boolean
}

export function comparisonTypeName(folder: string): string {
  return folder.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
}

export function comparisonReadNotices(coverage: ComparisonCoverageNotice): string[] {
  return [
    ...(coverage.legacyReadFailure ? [LEGACY_COMPARISON_NOTICE] : []),
    ...(coverage.unknownTypes?.length ? [`Types not compared: ${coverage.unknownTypes.map(comparisonTypeName).join(", ")}.`] : []),
  ]
}

export const COMPARISON_COVERAGE_DETAIL = "Comparison coverage"

/** Keep full type names within the notification envelope's detail limit. */
export function comparisonReadDetails(coverage: ComparisonCoverageNotice): Array<{ label: string; value: string }> {
  const details = coverage.legacyReadFailure ? [{ label: COMPARISON_COVERAGE_DETAIL, value: LEGACY_COMPARISON_NOTICE }] : []
  const label = "Types not compared"
  let value = ""
  for (const folder of coverage.unknownTypes ?? []) {
    const name = comparisonTypeName(folder)
    if (value && value.length + name.length + 2 > 500) {
      details.push({ label, value })
      value = ""
    }
    value = value ? `${value}, ${name}` : name
  }
  if (value) details.push({ label, value })
  return details
}

/** Attempted folders plus types skipped before the engine made its read list. */
export function recordedBackupTypes(metadata: BackupReadMetadata | null | undefined): string[] | undefined {
  const included = metadata?.Scope?.Included
  if (!Array.isArray(included) && !Array.isArray(metadata?.Outcomes)) return undefined
  const selected = new Set(Array.isArray(included) ? included.filter(folder => typeof folder === "string") : [])
  if (Array.isArray(metadata?.Outcomes)) {
    for (const outcome of metadata.Outcomes) if (typeof outcome?.Folder === "string") selected.add(outcome.Folder)
  }
  return [...selected]
}

/** Modern manifests must confirm a complete read. Older manifests use the recorded scope and exclusions. */
export function backupReadCoverage(metadata: BackupReadMetadata | null | undefined) {
  if (!metadata) return { selected: [], readable: new Set<string>(), legacyReadFailure: false }
  const recorded = recordedBackupTypes(metadata)
  const selected = new Set(recorded ?? LEGACY_FOLDERS)
  const excluded = metadata.Scope?.Excluded
  if (Array.isArray(excluded)) for (const folder of excluded) selected.delete(folder)
  const readable = stoppedEarly(metadata.Status ?? metadata.status) ? new Set<string>() : coveredFolders(recorded ? { ...metadata, Scope: { ...metadata.Scope, Included: recorded } } : metadata)
  const outcomes = new Map<string, unknown>()
  if (Array.isArray(metadata.Outcomes)) {
    for (const outcome of metadata.Outcomes) {
      if (!outcome || typeof outcome.Folder !== "string") continue
      outcomes.set(outcome.Folder, outcomes.has(outcome.Folder) ? undefined : outcome.Outcome)
    }
  }
  const needsOutcomes = metadata.Outcomes !== undefined || metadata.Coverage === "Incomplete"
  // In 0.5.3, FailedTypes names failed type lists. An individual failed read increments
  // Failures too, but its optional timeout warning only names the policy and the error.
  const failedTypes = new Set(Array.isArray(metadata.FailedTypes) ? metadata.FailedTypes.filter(folder => typeof folder === "string" && selected.has(folder)) : [])
  const legacyReadFailure = !needsOutcomes && typeof metadata.Failures === "number" && metadata.Failures > failedTypes.size
  const folders = INTUNE_TYPES.filter(type => selected.has(type.folder)).map(type => type.folder)
  let indexes: LargeIndexes
  try { indexes = largeIndexes(metadata) }
  catch { return { selected: folders, readable: new Set<string>(), legacyReadFailure } }
  for (const folder of readable) {
    const outcome = outcomes.get(folder)
    if (needsOutcomes && outcome !== "saved" && outcome !== "notConfigured") {
      readable.delete(folder)
    }
    if (Object.hasOwn(indexes, folder) && !indexes[folder]?.complete) readable.delete(folder)
  }
  return { selected: folders, readable, legacyReadFailure }
}

export function comparisonCoverage(older: BackupReadMetadata | null, newer: BackupReadMetadata | null) {
  const before = backupReadCoverage(older)
  const after = backupReadCoverage(newer)
  const shared = new Set([...after.readable].filter(folder => before.readable.has(folder)))
  const unknown = [...new Set([...before.selected, ...after.selected])].filter(folder => !shared.has(folder))
  return { shared, unknown, legacyReadFailure: before.legacyReadFailure || after.legacyReadFailure }
}
