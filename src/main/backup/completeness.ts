import { normalizeBackupStatus } from "../../portal/lib/backup-health"
import { typeForFolder } from "../../shared/intune/registry"
import { maskedFolders } from "../../shared/intune/scope"

/**
 * Whether a backup holds a complete copy of the types a change is about to write, from its
 * metadata.json. Shared by change sets and OpenIntuneBaseline deployments: a backup that completed
 * with warnings may miss exactly the objects about to change.
 */
export interface BackupGaps {
  /** The status as recorded, or "unknown". */
  status: string
  failures?: number
  /** The status reads as success (Success or an equivalent such as Succeeded) and no item failed. */
  succeeded: boolean
  /** The given folders the backup does not hold, by reason; reasons without folders are left out. */
  missing: Array<{ reason: GapReason; folders: string[] }>
}

export type GapReason = "excluded" | "skipped" | "failed" | "reader" | "masked"

const REASON_TEXT: Record<GapReason, string> = {
  excluded: "left out of the backup scope",
  skipped: "skipped for missing permissions",
  failed: "failed",
  reader: "not readable by the Backup Reader (covered by manual backups)",
  masked: "saved with encrypted values masked (a manual backup captures them)",
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

export const folderLabel = (folder: string) => typeForFolder(folder)?.label ?? folder

/** Null when the metadata cannot be read. */
export function backupGaps(metadataValue: unknown, folders: string[]): BackupGaps | null {
  if (!metadataValue || typeof metadataValue !== "object" || Array.isArray(metadataValue)) return null
  const metadata = metadataValue as Record<string, unknown>
  const status = typeof metadata.Status === "string" ? metadata.Status : "unknown"
  const failures = typeof metadata.Failures === "number" ? metadata.Failures : undefined
  const lists: Array<[GapReason, string[]]> = [
    ["excluded", strings(record(metadata.Scope).Excluded)],
    ["skipped", strings(metadata.SkippedTypes)],
    ["failed", strings(metadata.FailedTypes)],
    ["reader", strings(metadata.AppOnlyExcludedTypes)],
    ["masked", [...maskedFolders(metadata)]],
  ]
  return {
    status, ...(failures !== undefined ? { failures } : {}),
    succeeded: normalizeBackupStatus({ status }) === "success" && failures === 0,
    missing: lists.map(([reason, list]) => ({ reason, folders: folders.filter((folder) => list.includes(folder)) })).filter((entry) => entry.folders.length),
  }
}

/** "status CompletedWithWarnings, 2 failure(s)" */
export function describeStatus(gaps: BackupGaps): string {
  return `status ${gaps.status}, ${gaps.failures !== undefined ? `${gaps.failures} failure(s)` : "an unknown number of failures"}`
}

/** "Settings Catalog, Compliance policies left out of the backup scope; Scripts failed" */
export function describeMissing(gaps: BackupGaps): string {
  return gaps.missing.map(({ reason, folders }) => `${folders.map(folderLabel).join(", ")} ${REASON_TEXT[reason]}`).join("; ")
}
