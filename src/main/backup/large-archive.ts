import { completeHalf, largeRunProblems, matchingCompanions } from "../../shared/backup-companion"
import { BACKUP_CONTAINER } from "../../shared/constants"
import { backupBlobName, backupContainer } from "../../shared/backup-storage"
import { createHash, randomUUID } from "node:crypto"
import { open, rename, rm } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createWriteStream } from "node:fs"
import { largeIndexes } from "../../shared/large-backup"
import { typeForFolder } from "../../shared/intune/registry"
import { largeFiles, type JsonFileReader } from "./large-files"
import type { LocalBlobStore } from "../storage/local-blob-store"

const BLOCK = 512
const FILES_MAX = 5_000_000
const ENTRY_MAX = 8 * 1024 * 1024
export const LARGE_ARCHIVE_MAX = 32 * 1024 * 1024 * 1024
const identity = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
// Control characters and separators must be rejected before any path is used.
// oxlint-disable-next-line no-control-regex
const safeName = (name: string) => Buffer.byteLength(name) <= 1024 && !/[\\:\x00-\x1f]/.test(name) && !name.startsWith("/") && !name.split("/").some(part => !part || part === "." || part === "..")
function header(name: string, size: number, kind = 48): Buffer {
  if (!safeName(name)) throw new Error("Unsafe archive path")
  const out = Buffer.alloc(BLOCK)
  let leaf = name, prefix = ""
  if (Buffer.byteLength(name) > 100) { const cut = name.lastIndexOf("/"); prefix = name.slice(0, cut); leaf = name.slice(cut + 1) }
  if (Buffer.byteLength(leaf) > 100 || Buffer.byteLength(prefix) > 155) throw new Error("Archive path is too long")
  out.write(leaf, 0, 100); out.write("0000600\0", 100); out.write("0000000\0", 108); out.write("0000000\0", 116)
  out.write(size.toString(8).padStart(11, "0") + "\0", 124); out.write("00000000000\0", 136)
  out.fill(32, 148, 156); out[156] = kind; out.write("ustar\0", 257); out.write("00", 263); out.write(prefix, 345, 155)
  out.write(out.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148)
  return out
}
async function* record(name: string, value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > ENTRY_MAX) throw new Error("Archive entry exceeds 8 MiB")
  const split = name.lastIndexOf("/")
  if (Buffer.byteLength(name) > 100 && (split < 0 || Buffer.byteLength(name.slice(0, split)) > 155 || Buffer.byteLength(name.slice(split + 1)) > 100)) {
    if (!safeName(name)) throw new Error("Unsafe archive path")
    const path = ` path=${name}\n`
    let length = Buffer.byteLength(path) + 1
    while (length !== Buffer.byteLength(path) + String(length).length) length = Buffer.byteLength(path) + String(length).length
    const pax = Buffer.from(`${length}${path}`)
    yield header("PaxHeader", pax.length, 120); yield pax
    if (pax.length % BLOCK) yield Buffer.alloc(BLOCK - pax.length % BLOCK)
    yield header("snapshot.json", body.length)
  } else yield header(name, body.length)
  yield body
  if (body.length % BLOCK) yield Buffer.alloc(BLOCK - body.length % BLOCK)
}
function allowance(metadata: Record<string, any>, requireLarge = true) {
  const indexes = largeIndexes(metadata)
  if (!metadata.Items || typeof metadata.Items !== "object" || Array.isArray(metadata.Items) || !metadata.ItemCounts || typeof metadata.ItemCounts !== "object") throw new Error("Invalid backup inventory")
  const legacy = Object.keys(metadata.Items).length
  const counts: Record<string, number> = {}
  for (const key of Object.keys(metadata.Items)) {
    const folder = key.split("/")[0]!
    if (!typeForFolder(folder) || indexes[folder]) throw new Error("Invalid legacy inventory folder")
    counts[folder] = (counts[folder] ?? 0) + 1
  }
  for (const [folder, index] of Object.entries(indexes)) counts[folder] = index.count
  const policies = Object.entries(counts).reduce((sum, [folder, count]) => sum + (typeForFolder(folder)?.inventory ? 0 : count), 0)
  if (metadata.ItemCounts.TotalPolicies !== policies || Object.entries(metadata.ItemCounts).some(([folder, count]) => folder !== "TotalPolicies" && count !== (counts[folder] ?? 0)) || Object.entries(counts).some(([folder, count]) => metadata.ItemCounts[folder] !== count)) throw new Error("Invalid backup counts")
  if ((requireLarge && !Object.keys(indexes).length) || legacy > 60_000 || metadata.Status !== "Success" || metadata.Failures !== 0 || metadata.Coverage !== "Complete") throw new Error("Only complete large backups can be exported or imported")
  for (const [folder, index] of Object.entries(indexes)) if (!index.complete || !typeForFolder(folder) || metadata.ItemCounts?.[folder] !== index.count) throw new Error("Invalid large backup counts")
  const count = legacy + Object.values(indexes).reduce((sum, index) => sum + index.count, 0)
  const limits = { count, files: 2 + count + Object.values(indexes).reduce((sum, index) => sum + index.shards, 0), bytes: Math.min(LARGE_ARCHIVE_MAX, 128 * 1024 * 1024 + count * 65536) }
  if (limits.files > FILES_MAX) throw new Error("Archive file count exceeds the inventory allowance")
  return {
    limits,
    // largeFiles calls this only for a bounded relationship declaration in a fingerprinted
    // snapshot. Every shard is then checked against that declaration and its own fingerprint.
    relationship: (shards: number) => {
      limits.files += shards
      if (limits.files > FILES_MAX) throw new Error("Archive file count exceeds the inventory allowance")
      limits.bytes = Math.min(LARGE_ARCHIVE_MAX, limits.bytes + shards * (ENTRY_MAX + BLOCK))
    },
  }
}

/** Uncompressed POSIX ustar avoids ZIP's entry ceiling and compression bombs and streams to disk. */
export async function* exportLargeArchive(tenantId: string, backupId: string, metadata: Record<string, any>, read: JsonFileReader): AsyncGenerator<Buffer> {
  const { limits, relationship } = allowance(metadata)
  if (!identity.test(tenantId) || !/^backup-large-\d{4}-\d{2}-\d{2}-\d{6}$/.test(backupId) || metadata.BackupFolder !== backupId) throw new Error("Invalid archive identity")
  let bytes = 0, files = 1
  for await (const chunk of record("tenuvault-manifest.json", { version: 2, sourceTenantId: tenantId, backupId })) { bytes += chunk.length; yield chunk }
  for await (const file of largeFiles(metadata, read, relationship)) {
    if (++files > limits.files) throw new Error("Archive file count exceeds the inventory allowance")
    for await (const chunk of record(file.name, file.value)) {
      bytes += chunk.length
      if (bytes > limits.bytes) throw new Error("Archive exceeds the inventory size allowance")
      yield chunk
    }
  }
  if (bytes + 2 * BLOCK > limits.bytes) throw new Error("Archive exceeds the inventory size allowance")
  yield Buffer.alloc(2 * BLOCK)
}

/** Version 3 keeps each half under its real folder, including both reciprocal manifests. */
export async function* exportMixedArchive(tenantId: string, ordinaryId: string, ordinary: Record<string, any>, largeId: string, large: Record<string, any>, read: JsonFileReader): AsyncGenerator<Buffer> {
  if (!identity.test(tenantId) || ordinary.TenantId?.toLowerCase() !== tenantId.toLowerCase() || !matchingCompanions(ordinaryId, ordinary, largeId, large) || !completeHalf(ordinary) || !completeHalf(large) || largeRunProblems(ordinary).length || Object.keys(largeIndexes(ordinary)).length) throw new Error("Only a verified complete mixed run can be exported")
  const halves = [{ id: ordinaryId, metadata: ordinary, budget: allowance(ordinary, false) }, { id: largeId, metadata: large, budget: allowance(large) }]
  yield* record("tenuvault-manifest.json", { version: 3, sourceTenantId: tenantId, backupId: ordinaryId, companionId: largeId })
  let total = 0, totalFiles = 1
  for (const half of halves) {
    let bytes = 0, files = 1
    for await (const file of largeFiles(half.metadata, name => read(`${half.id}/${name}`), half.budget.relationship)) {
      if (++totalFiles > FILES_MAX || ++files > half.budget.limits.files) throw new Error("Archive file count exceeds the inventory allowance")
      for await (const chunk of record(`${half.id}/${file.name}`, file.value)) {
        bytes += chunk.length; total += chunk.length
        if (bytes > half.budget.limits.bytes || total > LARGE_ARCHIVE_MAX - 4096) throw new Error("Archive exceeds the inventory size allowance")
        yield chunk
      }
    }
  }
  yield Buffer.alloc(2 * BLOCK)
}

/** Save atomically so a failed download never leaves a file presented as a complete archive. */
export async function saveLargeDownload(body: ReadableStream<Uint8Array>, destination: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.partial`
  try {
    await pipeline(Readable.fromWeb(body as never), createWriteStream(temporary, { flags: "wx", mode: 0o600 }))
    await rename(temporary, destination)
  } finally { await rm(temporary, { force: true }) }
}

class TarReader {
  offset = 0
  files = 0
  readonly hash = createHash("sha256")
  constructor(private readonly file: FileHandle, readonly size: number) {}
  async bytes(size: number): Promise<Buffer> {
    if (this.offset + size > this.size) throw new Error("Truncated archive")
    const buffer = Buffer.alloc(size)
    let read = 0
    while (read < size) { const next = await this.file.read(buffer, read, size - read, this.offset + read); if (!next.bytesRead) throw new Error("Truncated archive"); read += next.bytesRead }
    this.offset += size; this.hash.update(buffer)
    return buffer
  }
  async next(expected: string): Promise<any> {
    if (!safeName(expected) || ++this.files > FILES_MAX) throw new Error("Unsafe archive path or count")
    let block = await this.bytes(BLOCK)
    const text = (start: number, length: number) => block.subarray(start, start + length).toString().replace(/\0.*$/s, "")
    const nameOf = () => [text(345, 155), text(0, 100)].filter(Boolean).join("/")
    const checkedSize = (kind: number) => {
      const checksum = text(148, 8).trim(), sizeText = text(124, 12).trim()
      if (!/^[0-7]+$/.test(checksum) || !/^[0-7]+$/.test(sizeText)) throw new Error("Invalid tar numeric field")
      const size = Number.parseInt(sizeText, 8), sum = Number.parseInt(checksum, 8)
      block.fill(32, 148, 156)
      if (block.reduce((total, byte) => total + byte, 0) !== sum || text(257, 6) !== "ustar" || block[156] !== kind || size > ENTRY_MAX) throw new Error("Unsafe or unexpected archive entry")
      return size
    }
    let extended: string | undefined
    if (block[156] === 120) {
      if (nameOf() !== "PaxHeader") throw new Error("Unsafe tar path record")
      const length = checkedSize(120)
      if (length > 2048) throw new Error("Oversized tar path record")
      const bytes = await this.bytes(length), path = bytes.toString("utf8")
      const match = /^(\d+) path=([^\n]+)\n$/.exec(path)
      if (!match || Number(match[1]) !== length || !Buffer.from(path).equals(bytes) || !safeName(match[2]!)) throw new Error("Unsafe tar path record")
      extended = match[2]
      if (length % BLOCK && (await this.bytes(BLOCK - length % BLOCK)).some(byte => byte !== 0)) throw new Error("Invalid tar padding")
      block = await this.bytes(BLOCK)
    }
    if (extended && nameOf() !== "snapshot.json") throw new Error("Unsafe extended archive entry")
    const name = extended ?? nameOf()
    const size = checkedSize(48)
    if (name !== expected || !safeName(name)) throw new Error("Unsafe or unexpected archive entry")
    const value = JSON.parse((await this.bytes(size)).toString("utf8"))
    if (size % BLOCK && (await this.bytes(BLOCK - size % BLOCK)).some(byte => byte !== 0)) throw new Error("Invalid tar padding")
    return value
  }
  async end() {
    if (this.size - this.offset !== 2 * BLOCK || (await this.bytes(2 * BLOCK)).some(byte => byte !== 0)) throw new Error("Archive has extra or missing files")
    return this.hash.digest("hex")
  }
}
export interface ReviewedLargeArchive { tenantId: string; backupId: string; digest: string; count: number; path: string; companionId?: string }
async function visitArchive(path: string, visit?: (name: string, value: unknown) => Promise<void>): Promise<ReviewedLargeArchive> {
  const file = await open(path, "r")
  try {
    const size = (await file.stat()).size
    if (size > LARGE_ARCHIVE_MAX) throw new Error("Archive exceeds 32 GiB")
    const tar = new TarReader(file, size)
    const manifest = await tar.next("tenuvault-manifest.json")
    const mixed = manifest?.version === 3
    if ((!mixed && manifest?.version !== 2) || !identity.test(manifest.sourceTenantId) || !(mixed ? /^backup-\d{4}-\d{2}-\d{2}-\d{6}$/ : /^backup-large-\d{4}-\d{2}-\d{2}-\d{6}$/).test(manifest.backupId) || (mixed && !/^backup-large-\d{4}-\d{2}-\d{2}-\d{6}$/.test(manifest.companionId))) throw new Error("Invalid archive identity")
    const ids: string[] = mixed ? [manifest.backupId, manifest.companionId] : [manifest.backupId]
    const manifests: Record<string, any>[] = []
    let count = 0, allowedBytes = 0
    for (const [index, id] of ids.entries()) {
      const prefix = mixed ? `${id}/` : ""
      const start = tar.offset
      const metadata = await tar.next(prefix + "metadata.json")
      if (metadata?.BackupFolder !== id || (metadata.TenantId && metadata.TenantId.toLowerCase() !== manifest.sourceTenantId.toLowerCase())) throw new Error("Archive source identity mismatch")
      const { limits, relationship } = allowance(metadata, !mixed || index === 1)
      const startFiles = tar.files
      const read: JsonFileReader = async name => {
        if (tar.files - startFiles + 2 >= limits.files) throw new Error("Archive file count exceeds the inventory allowance")
        const value = await tar.next(prefix + name)
        if (tar.offset - start > limits.bytes) throw new Error("Archive exceeds the inventory size allowance")
        return value
      }
      for await (const entry of largeFiles(metadata, read, relationship)) if (entry.name !== "metadata.json") await visit?.(`${id}/${entry.name}`, entry.value)
      if (tar.offset - start > limits.bytes) throw new Error("Archive exceeds the inventory size allowance")
      count += limits.count
      allowedBytes += limits.bytes
      manifests.push(metadata)
    }
    if (mixed && (!matchingCompanions(ids[0]!, manifests[0]!, ids[1], manifests[1]) || !completeHalf(manifests[0]) || !completeHalf(manifests[1]) || largeRunProblems(manifests[0]!).length || Object.keys(largeIndexes(manifests[0]!)).length)) throw new Error("Archive companion does not match")
    const digest = await tar.end()
    if (size > Math.min(LARGE_ARCHIVE_MAX, allowedBytes)) throw new Error("Archive exceeds the inventory size allowance")
    // Both completion markers follow the digest and all referenced contents.
    for (const [index, id] of ids.entries()) await visit?.(`${id}/metadata.json`, manifests[index])
    return { tenantId: manifest.sourceTenantId.toLowerCase(), backupId: manifest.backupId, ...(mixed ? { companionId: manifest.companionId } : {}), digest, count, path }
  } finally { await file.close() }
}
export const reviewLargeArchive = (path: string) => visitArchive(path)
export async function importLargeArchive(store: LocalBlobStore, archive: ReviewedLargeArchive): Promise<void> {
  const account = `tvlocal-${archive.tenantId}`
  const ids = [archive.backupId, ...(archive.companionId ? [archive.companionId] : [])]
  // Check every destination before claiming any of them.
  for (const id of ids) {
    const container = backupContainer(id), prefix = `${id}/`
    await store.createContainer(account, container)
    if ((await store.list(account, container, prefix)).length || (container !== BACKUP_CONTAINER && (await store.list(account, container, backupBlobName(prefix))).length)) throw new Error("This backup already exists on this device")
  }
  const claimed: string[] = []
  const pending = new Set<Promise<void>>()
  let failure: unknown
  try {
    for (const id of ids) {
      await store.put(account, backupContainer(id), `${id}/.tenuvault-owner.json`, Buffer.from(JSON.stringify({ TenantId: archive.tenantId, RunId: randomUUID() })), "application/json", true)
      claimed.push(id)
    }
    const manifests = new Map<string, any>()
    const checked = await visitArchive(archive.path, async (name, value) => {
      const id = name.split("/")[0]!
      if (!ids.includes(id)) throw new Error("The archive changed since review")
      if (name === `${id}/metadata.json`) { manifests.set(id, value); return }
      const task = store.put(account, backupContainer(id), backupBlobName(name), Buffer.from(JSON.stringify(value)), "application/json", true).then(() => undefined, error => { failure ??= error }).finally(() => pending.delete(task))
      pending.add(task)
      if (pending.size >= 16) await Promise.race(pending)
      if (failure) throw failure
    })
    await Promise.all(pending)
    if (failure) throw failure
    if (checked.digest !== archive.digest || checked.tenantId !== archive.tenantId || checked.backupId !== archive.backupId || checked.companionId !== archive.companionId) throw new Error("The archive changed since review")
    for (const id of ids) {
      const metadata = manifests.get(id)
      await store.put(account, backupContainer(id), `${id}/.tenuvault-owner.json`, Buffer.from(JSON.stringify({ TenantId: archive.tenantId, RunId: metadata.RunId ?? randomUUID(), ...(metadata.CompanionBackup ? { CompanionBackup: metadata.CompanionBackup } : {}), ...(backupContainer(id) !== BACKUP_CONTAINER ? { LargeInventory: { version: 1 } } : {}) })), "application/json")
    }
    for (const id of ids) {
      const metadata = manifests.get(id)
      await store.put(account, backupContainer(id), `${id}/metadata.json`, Buffer.from(JSON.stringify({ ...metadata, SourceTenantId: archive.tenantId, Import: { sha256: archive.digest, provenance: "User-reviewed tar; source identity is not cryptographically verified" } })), "application/json", true)
    }
  } catch (error) {
    await Promise.all(pending)
    // Retire both completion markers before rolling back any payload.
    for (const id of claimed) await store.delete(account, backupContainer(id), `${id}/metadata.json`, { despiteDamage: true }).catch(() => undefined)
    for (const id of claimed) {
      const container = backupContainer(id), prefix = `${id}/`
      for (const blob of [...await store.list(account, container, prefix), ...(container === BACKUP_CONTAINER ? [] : await store.list(account, container, backupBlobName(prefix)))]) await store.delete(account, container, blob.name, { despiteDamage: true }).catch(() => undefined)
    }
    throw error
  }
}
