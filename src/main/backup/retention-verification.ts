import { BACKUP_OWNER_FILE, BACKUP_RUN_RECORD_FILE } from "../../shared/constants"
import { largeIndexes } from "../../shared/large-backup"
import { type Item } from "../../shared/intune/registry"
import { isSafeArchivePath } from "../../shared/security"
import { snapshotHash } from "../../portal/lib/policies/backup-manifest"
import type { OwnershipFile } from "../../shared/backup-ownership"
import { type BlobWriter, type RetentionBlob } from "./blob-writer"
import { largeFiles } from "./large-files"

export interface VerifiedHalf {
  blobs: Map<string, string>
  listing: Awaited<ReturnType<BlobWriter["listFolder"]>>
  counts: Map<string, number>
}

/** Conflicting manifest evidence invalidates the entire retention plan. */
export class RetentionManifestMismatch extends Error {}

/** The listing supplies deletion identities, never the expected inventory. */
export async function verifyHalf(storage: BlobWriter, prefix: string, manifest: Record<string, unknown> | null, listing?: VerifiedHalf["listing"], expectedOwner?: OwnershipFile): Promise<VerifiedHalf> {
  listing ??= await storage.listFolder(prefix)
  const remaining = new Set(listing.blobs)
  const blobs = new Map<string, string>()
  let lastRead: RetentionBlob | undefined
  const reject = (name: string): never => { throw new Error(`${prefix}${name} could not be verified for retention.`) }
  const read = async (name: string) => {
    const path = prefix + name
    if (!remaining.delete(path)) reject(name)
    lastRead = await storage.readForRetention(path)
    blobs.set(path, lastRead.etag)
    return lastRead.value
  }
  const mismatch = (name: string): never => {
    throw new RetentionManifestMismatch(`${prefix}${name} could not be verified for retention because it does not match its manifest.`)
  }
  const authenticate = (name: string, hash?: string) => {
    if (hash !== undefined) {
      if (hash !== lastRead?.sha256) mismatch(name)
    } else if (!lastRead?.authenticated) reject(name)
  }
  if (manifest ? JSON.stringify(await read("metadata.json")) !== JSON.stringify(manifest) : remaining.has(prefix + "metadata.json")) reject("metadata.json")
  if (expectedOwner?.kind === "found" && JSON.stringify(await read(BACKUP_OWNER_FILE)) !== JSON.stringify(expectedOwner.value)) reject(BACKUP_OWNER_FILE)
  if (expectedOwner?.kind === "missing" && remaining.has(prefix + BACKUP_OWNER_FILE)) reject(BACKUP_OWNER_FILE)
  if (manifest?.Items !== undefined && (!manifest.Items || typeof manifest.Items !== "object" || Array.isArray(manifest.Items))) reject("metadata.json")
  const counts = new Map<string, number>()
  for (const [key, entry] of Object.entries(manifest?.Items ?? {})) {
    const slash = key.indexOf("/")
    const folder = key.slice(0, slash)
    const name = `${folder}/${entry?.file}`
    if (!/^[A-Za-z0-9]+$/.test(folder) || !key.slice(slash + 1) || typeof entry?.file !== "string"
      || !/^[^/\\]+\.json$/.test(entry.file) || !isSafeArchivePath(name)) reject("metadata.json")
    const value = await read(name) as Item
    if (Array.isArray(value) || value.id !== key.slice(slash + 1)) mismatch(name)
    if (entry.hash !== undefined && snapshotHash(value) !== entry.hash) mismatch(name)
    if (entry.sha256 !== undefined || entry.hash === undefined) authenticate(name, entry.sha256)
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  if (manifest) {
    const indexes = largeIndexes(manifest)
    for (const [folder, index] of Object.entries(indexes)) counts.set(folder, index.count)
    // Existing archive validation walks every object and relationship and checks its fingerprint.
    for await (const _file of largeFiles({ LargeItems: indexes, LargeIndexHashes: manifest.LargeIndexHashes }, read, undefined, (name, hash) => {
      if (name.startsWith("_index/") || hash !== undefined) authenticate(name, hash)
    })) { /* Drain to check all references, including the last relationship fingerprint. */ }
  }
  for (const path of remaining) {
    const name = path.slice(prefix.length)
    const value = await read(name)
    if (name === BACKUP_OWNER_FILE || name === BACKUP_RUN_RECORD_FILE) {
      if (Array.isArray(value)) reject(name)
    } else {
      authenticate(name)
      const [folder, file, ...rest] = name.split("/")
      if (folder && file && !rest.length && folder !== "_index" && folder !== "_relations") counts.set(folder, (counts.get(folder) ?? 0) + 1)
    }
  }
  for (const [folder, count] of Object.entries(manifest?.ItemCounts ?? {})) {
    if (folder !== "TotalPolicies" && count !== (counts.get(folder) ?? 0)) reject("metadata.json counts")
  }
  if (Array.isArray(manifest?.Outcomes)) for (const outcome of manifest.Outcomes) {
    if (!outcome || typeof outcome.Folder !== "string" || (outcome.Saved !== undefined && outcome.Saved !== (counts.get(outcome.Folder) ?? 0))) reject("metadata.json outcomes")
  }
  return { blobs, listing, counts }
}
