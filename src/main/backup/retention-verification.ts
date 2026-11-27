import { BACKUP_OWNER_FILE } from "../../shared/constants"
import { itemsOf } from "../../shared/intune/backup-changes"
import { coveredFolders, restorableFolders } from "../../shared/intune/scope"
import { typeForFolder, type Item } from "../../shared/intune/registry"
import { withMaskedSecrets } from "../../shared/intune/read"
import { isSafeArchivePath } from "../../shared/security"
import { snapshotHash } from "../../portal/lib/policies/backup-manifest"
import { retentionIdentity, type VerificationProgress } from "./retention-progress"
import type { BlobListing, BlobWriter, RetentionBlob } from "./blob-writer"

export class RetentionVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RetentionVerificationError"
  }
}

export async function verifyBackup(
  storage: BlobWriter, prefix: string, manifest: Record<string, unknown>, roots: Map<string, RetentionBlob>,
  listing: BlobListing, keyFingerprint: string | undefined, progress?: VerificationProgress,
): Promise<{ identities: Map<string, string>; covers: Set<string>; types: Set<string> }> {
  const reject = (name: string, reason: string): never => {
    throw new RetentionVerificationError(`${prefix}${name} could not be verified for retention: ${reason}.`)
  }
  const items = itemsOf(manifest)
  if (!items) return reject("metadata.json", "the item list is invalid")
  const remaining = new Set(listing.blobs)
  if (remaining.size !== listing.blobs.length) reject("metadata.json", "storage listed duplicate files")
  const identities = new Map<string, string>()
  const use = (name: string, etag: string) => {
    const path = prefix + name
    if (!remaining.delete(path)) reject(name, "the expected file is missing")
    if (listing.etags.has(path) && listing.etags.get(path) !== etag) reject(name, "the file changed during verification")
    identities.set(path, etag)
  }
  for (const [name, file] of roots) use(name, file.etag)
  if (manifest.BackupFolder !== undefined && manifest.BackupFolder !== prefix.slice(0, -1)) reject("metadata.json", "the backup folder does not match")
  const counts = new Map<string, number>()
  const masked = new Set<string>()
  for (const [key, entry] of Object.entries(items)) {
    const slash = key.indexOf("/")
    const folder = key.slice(0, slash)
    const type = typeForFolder(folder)
    if (!type || !key.slice(slash + 1) || typeof entry?.file !== "string"
      || !/^[^/\\]+\.json$/.test(entry.file) || !isSafeArchivePath(`${folder}/${entry.file}`)) {
      return reject("metadata.json", "an item path is invalid")
    }
    const name = `${folder}/${entry.file}`
    const path = prefix + name
    const listed = listing.etags.get(path)
    if (!remaining.has(path)) reject(name, "the expected file is missing")
    const receipt = progress && listed && keyFingerprint ? retentionIdentity([key, entry, listed, keyFingerprint]) : undefined
    if (receipt && progress?.files[name] === receipt) {
      use(name, listed!)
    } else {
      const file = await storage.readForRetention(path)
      use(name, file.etag)
      const item = file.value as Item
      if (item.id !== key.slice(slash + 1)) reject(name, "the policy ID does not match its manifest")
      const maskedView = entry.hashWithMaskedSecrets === undefined ? undefined : withMaskedSecrets(type, item)
      if ((entry.sha256 !== undefined && file.sha256 !== entry.sha256)
        || (entry.hash !== undefined && snapshotHash(item) !== entry.hash)
        || (entry.hashWithEmptyAssignments !== undefined && snapshotHash({ ...item, assignments: [] }) !== entry.hashWithEmptyAssignments)
        || (entry.hashWithMaskedSecrets !== undefined && (!maskedView || snapshotHash(maskedView) !== entry.hashWithMaskedSecrets))) {
        reject(name, "a hash does not match its manifest")
      }
      // Plain Azure backups use the manifest fingerprint. Encrypted formats also authenticate on read.
      if (!file.authenticated && entry.sha256 === undefined && entry.hash === undefined) reject(name, "the payload has no authentication evidence")
      if (receipt && progress && (!file.keyFingerprint || file.keyFingerprint === keyFingerprint)) progress.files[name] = receipt
    }
    if (entry.secretsMasked) masked.add(folder)
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  // An unindexed payload may be a customer's only copy. No retention path removes it.
  if (remaining.size) reject([...remaining][0]!.slice(prefix.length), "the file is absent from the manifest")
  const declared = manifest.ItemCounts
  if (declared !== undefined) {
    if (!declared || typeof declared !== "object" || Array.isArray(declared)) reject("metadata.json", "item counts are invalid")
    const totalPolicies = [...counts.entries()].reduce((sum, [folder, count]) => (typeForFolder(folder)?.inventory ? sum : sum + count), 0)
    for (const [folder, count] of Object.entries(declared!)) {
      if (folder === "TotalPolicies") {
        if (count !== totalPolicies) reject("metadata.json", "the recorded policy total does not match")
      } else if (count !== (counts.get(folder) ?? 0)) {
        reject("metadata.json", "a recorded item count does not match")
      }
    }
  }
  const types = new Set([...counts.keys(), ...coveredFolders(manifest)].filter(folder =>
    counts.has(folder) || Object.hasOwn(declared ?? {}, folder) || Array.isArray((manifest.Scope as { Included?: unknown })?.Included)))
  const complete = ["success", "succeeded"].includes(String(manifest.Status).toLowerCase())
    && (manifest.Failures === undefined || manifest.Failures === 0)
  const covers = new Set(complete ? [...restorableFolders(manifest)].filter(folder => types.has(folder) && !masked.has(folder)) : [])
  return { identities, types, covers }
}

export function checkOwner(marker: RetentionBlob, manifest: Record<string, unknown>, tenant: string, prefix: string): void {
  const { TenantId, RunId } = marker.value as Record<string, unknown>
  if (typeof TenantId !== "string" || TenantId.toLowerCase() !== tenant
    || (typeof manifest.RunId === "string" && typeof RunId === "string" && RunId !== manifest.RunId)) {
    throw new RetentionVerificationError(`${prefix}${BACKUP_OWNER_FILE} does not match the backup's ownership.`)
  }
}
