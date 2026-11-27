import { BACKUP_OWNER_FILE, BACKUP_RUN_RECORD_FILE } from "../../shared/constants"
import { largeIndexes, type LargeEntry } from "../../shared/large-backup"
import { type Item } from "../../shared/intune/registry"
import { isSafeArchivePath } from "../../shared/security"
import { snapshotHash } from "../../portal/lib/policies/backup-manifest"
import type { OwnershipFile } from "../../shared/backup-ownership"
import { type BlobWriter, type RetentionBlob } from "./blob-writer"
import { retentionIdentity, type VerificationProgress } from "./retention-progress"
import { BackupFingerprintMismatch, largeFiles } from "./large-files"

export interface VerifiedHalf {
  blobs: Map<string, string>
  listing: Awaited<ReturnType<BlobWriter["listFolder"]>>
  counts: Map<string, number>
}

/** Conflicting manifest evidence invalidates the entire retention plan. */
export class RetentionManifestMismatch extends Error {}

/** The listing supplies deletion identities, never the expected inventory. */
export async function verifyHalf(storage: BlobWriter, prefix: string, manifest: Record<string, unknown> | null, listing?: VerifiedHalf["listing"], expectedOwner?: OwnershipFile, progress?: VerificationProgress): Promise<VerifiedHalf> {
  listing ??= await storage.listFolder(prefix)
  const remaining = new Set(listing.blobs)
  const blobs = new Map<string, string>()
  const listedIdentities = [...remaining].sort().map(name => [name, listing.etags.get(name)])
  const listedIdentity = progress && listedIdentities.every(([, etag]) => etag) && remaining.size === listing.blobs.length
    ? retentionIdentity([manifest, expectedOwner, listedIdentities]) : undefined
  if (listedIdentity && progress?.complete?.identity === listedIdentity) {
    return { blobs: new Map(listing.etags), listing, counts: new Map(progress.complete.counts) }
  }
  let containsSealed = false
  let lastRead: RetentionBlob | undefined
  const reject = (name: string): never => { throw new Error(`${prefix}${name} could not be verified for retention.`) }
  const read = async (name: string) => {
    const path = prefix + name
    if (!remaining.delete(path)) reject(name)
    lastRead = await storage.readForRetention(path)
    blobs.set(path, lastRead.etag)
    containsSealed ||= lastRead.authenticated
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
    const path = prefix + name
    const listedETag = listing.etags.get(path)
    const receipt = progress && listedETag ? retentionIdentity([key, entry, listedETag]) : undefined
    if (receipt && progress?.files[name] === receipt) {
      if (!remaining.delete(path)) reject(name)
      blobs.set(path, listedETag!)
    } else {
      const value = await read(name) as Item
      if (Array.isArray(value) || value.id !== key.slice(slash + 1)) mismatch(name)
      if (entry.hash !== undefined && snapshotHash(value) !== entry.hash) mismatch(name)
      if (entry.sha256 !== undefined || entry.hash === undefined) authenticate(name, entry.sha256)
      if (progress && receipt && !lastRead?.authenticated && lastRead?.etag === listedETag) progress.files[name] = receipt
    }
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  if (manifest) {
    const indexes = largeIndexes(manifest)
    for (const [folder, index] of Object.entries(indexes)) counts.set(folder, index.count)
    const relations = new Map<string, string[]>()
    if (progress) for (const path of remaining) {
      const parts = path.slice(prefix.length).split("/")
      if (parts[0] !== "_relations" || parts.length !== 5) continue
      const group = `${parts[1]}/${parts[2]}`
      const paths = relations.get(group)
      if (paths) paths.push(path)
      else relations.set(group, [path])
    }
    const objectPaths = (folder: string, entry: LargeEntry) =>
      [prefix + `${folder}/${entry.file}`, ...(relations.get(`${folder}/${entry.id}`) ?? [])].sort()
    const receiptFor = (entry: LargeEntry, paths: string[]) =>
      paths.every(path => listing.etags.has(path)) ? retentionIdentity([entry, paths.map(path => [path, listing.etags.get(path)])]) : undefined
    let beforeObject = false
    // Existing archive validation walks every object and relationship and checks its fingerprint.
    try {
      for await (const _file of largeFiles({ LargeItems: indexes, LargeIndexHashes: manifest.LargeIndexHashes }, read, undefined, (name, hash) => {
        if (name.startsWith("_index/") || hash !== undefined) authenticate(name, hash)
      }, progress && {
        reuse(folder, entry) {
          beforeObject = containsSealed
          const paths = objectPaths(folder, entry)
          const receipt = receiptFor(entry, paths)
          if (!receipt || progress.files[`large:${folder}/${entry.id}`] !== receipt) return false
          for (const path of paths) {
            if (!remaining.delete(path)) reject(path.slice(prefix.length))
            blobs.set(path, listing.etags.get(path)!)
          }
          return true
        },
        verified(folder, entry) {
          // Never reuse authenticated reads after a recovery key change.
          if (beforeObject || containsSealed) return
          const paths = objectPaths(folder, entry)
          const receipt = receiptFor(entry, paths)
          if (receipt && paths.every(path => blobs.get(path) === listing.etags.get(path))) {
            progress.files[`large:${folder}/${entry.id}`] = receipt
          }
        },
      })) { /* Drain to check all references, including the last relationship fingerprint. */ }
    } catch (error) {
      if (error instanceof BackupFingerprintMismatch) throw new RetentionManifestMismatch(`${prefix} could not be verified for retention because it does not match its manifest.`, { cause: error })
      throw error
    }
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
  if (progress && listedIdentity && !containsSealed && [...blobs].every(([name, etag]) => listing.etags.get(name) === etag)) {
    progress.complete = { identity: listedIdentity, counts: [...counts] }
    progress.files = {}
  }
  return { blobs, listing, counts }
}
