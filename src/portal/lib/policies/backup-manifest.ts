import { createHash } from "node:crypto"
import { comparableSnapshot } from "../../../shared/intune/compare"
import type { Item } from "../../../shared/intune/registry"
import { manifestStatus, stoppedEarly } from "../../../shared/intune/backup-status"

/** One recorded backup item: the Intune object ID and the fingerprint of its backed-up content. */
export interface ManifestEntry { id: string; hash: string }

/** The fingerprint a backup records for a snapshot, without the fields Intune changes on every read or write. */
export const snapshotHash = (snapshot: Item) => createHash("sha256").update(JSON.stringify(comparableSnapshot(snapshot))).digest("base64").slice(0, 22)

/** Recorded backup items by blob path, or null for legacy backups that hold no inventory. */
export function backupManifest(metadata: Record<string, any> | null, backupId: string): Map<string, ManifestEntry> | null {
  const items = metadata?.Items
  if (items === undefined) return null
  if (!items || typeof items !== "object" || Array.isArray(items)) throw new Error("Invalid backup inventory manifest")
  const entries = new Map<string, ManifestEntry>()
  for (const [key, item] of Object.entries(items as Record<string, any>)) {
    const split = key.indexOf("/")
    const folder = split > 0 ? key.slice(0, split) : ""
    const id = split > 0 ? key.slice(split + 1) : ""
    const file = item?.file
    const hash = item?.hash
    if (!folder || !id || typeof file !== "string" || !file || file.includes("/") || file.includes("\\") || typeof hash !== "string" || !hash) throw new Error("Invalid backup inventory manifest")
    const path = `${backupId}/${folder}/${file}`
    if (entries.has(path)) throw new Error("Invalid backup inventory manifest")
    entries.set(path, { id, hash })
  }
  return entries
}

const metadataStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])

/** Why this backup must not be restored for the requested files, or undefined when it may. */
export function incompleteReason(metadata: Record<string, any> | null, manifest: Map<string, ManifestEntry> | null, paths: string[], full: boolean): string | undefined {
  // A cancel recorded as Failed by an earlier version reads as cancelled.
  const recordedStatus = metadata ? manifestStatus(metadata) : undefined
  // Metadata is written when a backup finishes, so a full restore without a completion record
  // would restore a stopped backup as if it were whole. Selected files that are present may
  // still be restored on their own.
  if (full && recordedStatus === undefined && !manifest) return "This backup is incomplete: it has no recorded completion status. Restore selected items from it, or restore from a complete backup instead."
  if (!metadata || (recordedStatus === undefined && !manifest)) return undefined
  const status = String(recordedStatus ?? "").toLowerCase()
  // A backup that failed or was cancelled records what it saved, so those items may still be restored one by one.
  if (stoppedEarly(status) && (full || !manifest)) return `This backup is recorded as ${status === "cancelled" ? "cancelled" : "failed"} and is incomplete. ${manifest ? "Restore selected items from it, or restore" : "Restore"} from a complete backup instead.`
  const folders = new Set(paths.map((path) => path.split("/")[1]))
  const failedRequested = metadataStrings(metadata.FailedTypes).filter((folder) => folders.has(folder))
  if (failedRequested.length) return `This backup is incomplete for ${failedRequested.join(", ")}: those types could not be read when the backup ran. Restore from a complete backup instead.`
  const failures = typeof metadata.Failures === "number" ? metadata.Failures : 0
  if (full && (failures > 0 || status === "completedwithwarnings")) return "This backup is incomplete: some items could not be read when the backup ran. Restore from a complete backup instead."
  if (manifest) {
    const unlisted = paths.filter((path) => !manifest.has(path))
    if (unlisted.length) return "A backup file is not listed in the backup manifest. The backup was not restored."
    if (full) {
      const listed = new Set(paths)
      const missing = [...manifest.keys()].filter((path) => !listed.has(path))
      if (missing.length) return `This backup is incomplete: ${missing.length} file(s) listed in the backup manifest are missing. Restore from a complete backup instead.`
    }
  }
  return undefined
}
