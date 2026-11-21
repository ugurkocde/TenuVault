import { hasOmissions, OMISSION_BLOCKER, OMISSION_MARKER, OMISSION_VERSION, type OmittedField } from "../../../shared/intune/secret-omission"
import { readBytesCapped } from "../../../shared/capped-body"
import { MAX_BACKUP_ARCHIVE_BYTES } from "../../../shared/constants"
import { createHash } from "node:crypto"
import { comparableSnapshot } from "../../../shared/intune/compare"
import type { Item } from "../../../shared/intune/registry"
import { manifestStatus, stoppedEarly } from "../../../shared/intune/backup-status"

/** One recorded backup item: the Intune object ID and the fingerprint of its backed-up content. */
export interface ManifestEntry { id: string; hash: string; omitted?: OmittedField[]; rawHash?: string }

/** The fingerprint a backup records for a snapshot, without the fields Intune changes on every read or write. */
export const snapshotHash = (snapshot: Item) => createHash("sha256").update(JSON.stringify(comparableSnapshot(snapshot))).digest("base64").slice(0, 22)

/** Recorded backup items by blob path, or null for legacy backups that hold no inventory. */
export function backupManifest(metadata: Record<string, any> | null, backupId: string): Map<string, ManifestEntry> | null {
  if (metadata?.OmissionVersion !== undefined && metadata.OmissionVersion !== OMISSION_VERSION) throw new Error("Unsupported backup omission format")
  const items = metadata?.Items
  if (metadata?.OmissionVersion !== undefined && items === undefined) throw new Error("The backup has no omission inventory.")
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
    if (item.omitted !== undefined && (metadata?.OmissionVersion !== OMISSION_VERSION || !validOmissions(item.omitted) || !validRawHash(item.rawHash))) throw new Error("Invalid backup omission inventory")
    entries.set(path, { id, hash, ...(item.omitted ? { omitted: item.omitted, rawHash: item.rawHash } : {}) })
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
      const missing = [...manifest.entries()].filter(([path, entry]) => !entry.omitted && !listed.has(path))
      if (missing.length) return `This backup is incomplete: ${missing.length} file(s) listed in the backup manifest are missing. Restore from a complete backup instead.`
    }
  }
  return undefined
}

/**
 * The manifest checks every restore from a backup runs before it writes anything: the recorded
 * inventory and whether the backup is complete for `paths`. The manifest is null for legacy
 * backups that record no inventory.
 */
export function checkRestoreManifest(metadata: Record<string, any> | null, backupId: string, paths: string[], full: boolean): { ok: true; manifest: Map<string, ManifestEntry> | null } | { ok: false; error: string } {
  let manifest: Map<string, ManifestEntry> | null
  try { manifest = backupManifest(metadata, backupId) }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Invalid backup inventory manifest" } }
  const incomplete = incompleteReason(metadata, manifest, paths, full)
  return incomplete ? { ok: false, error: incomplete } : { ok: true, manifest }
}

/** Throws when a snapshot is not the object, or not the content, its backup manifest records. */
export function verifySnapshot(snapshot: Item, expected: ManifestEntry | undefined): void {
  if (expected?.omitted || hasOmissions(snapshot)) throw new Error(OMISSION_BLOCKER)
  if (expected && (snapshot.id !== expected.id || snapshotHash(snapshot) !== expected.hash)) throw new Error("This backup file does not match its recorded fingerprint. It was not restored.")
}

const validRawHash = (hash: unknown): hash is string => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)
const reasons = new Set(["encrypted-oma", "typed-secret", "enrollment-credential", "credential", "script"])

export function validOmissions(value: unknown): value is OmittedField[] {
  return Array.isArray(value) && value.length > 0 && value.every((field) =>
    field && typeof field.path === "string" && field.path.startsWith("/") && reasons.has(field.reason))
}

export function verifyProjectedSnapshot(raw: string | Buffer, expected: ManifestEntry): Item {
  const unreadable = () => new Error("The projected backup file does not match its omission inventory.")
  if (!validOmissions(expected.omitted) || !validRawHash(expected.rawHash) || createHash("sha256").update(raw).digest("hex") !== expected.rawHash) throw unreadable()
  let snapshot: Item
  try { snapshot = JSON.parse(String(raw)) as Item } catch { throw unreadable() }
  const marker = snapshot?.[OMISSION_MARKER]
  if (!marker || typeof marker !== "object" || Array.isArray(marker) || marker.version !== OMISSION_VERSION || !validOmissions(marker.fields) ||
      marker.fields.length !== expected.omitted.length || marker.fields.some((field, index) => field.path !== expected.omitted![index]!.path || field.reason !== expected.omitted![index]!.reason) ||
      snapshot.id !== expected.id) throw unreadable()
  const { [OMISSION_MARKER]: _marker, ...content } = snapshot
  if (snapshotHash(content) !== expected.hash) throw unreadable()
  return snapshot
}


export async function readProjectedSnapshot(response: Response, expected: ManifestEntry): Promise<Item> {
  const raw = await readBytesCapped(response, MAX_BACKUP_ARCHIVE_BYTES)
  if (!raw) throw new Error("The projected backup file is too large to read.")
  return verifyProjectedSnapshot(Buffer.from(raw), expected)
}
