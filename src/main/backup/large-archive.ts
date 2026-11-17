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
function allowance(metadata: Record<string, any>) {
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
  if (!Object.keys(indexes).length || legacy > 60_000 || metadata.Status !== "Success" || metadata.Failures !== 0 || metadata.Coverage !== "Complete") throw new Error("Only complete large backups can be exported or imported")
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
  if (!identity.test(tenantId) || !/^backup-\d{4}-\d{2}-\d{2}-\d{6}$/.test(backupId) || metadata.BackupFolder !== backupId) throw new Error("Invalid archive identity")
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
export interface ReviewedLargeArchive { tenantId: string; backupId: string; digest: string; count: number; path: string }
async function visitArchive(path: string, visit?: (name: string, value: unknown) => Promise<void>): Promise<ReviewedLargeArchive> {
  const file = await open(path, "r")
  try {
    const size = (await file.stat()).size
    if (size > LARGE_ARCHIVE_MAX) throw new Error("Archive exceeds 32 GiB")
    const tar = new TarReader(file, size)
    const manifest = await tar.next("tenuvault-manifest.json")
    if (manifest?.version !== 2 || !identity.test(manifest.sourceTenantId) || !/^backup-\d{4}-\d{2}-\d{2}-\d{6}$/.test(manifest.backupId)) throw new Error("Invalid archive identity")
    const metadata = await tar.next("metadata.json")
    if (metadata?.BackupFolder !== manifest.backupId || (metadata.TenantId && metadata.TenantId.toLowerCase() !== manifest.sourceTenantId.toLowerCase())) throw new Error("Archive source identity mismatch")
    const { limits, relationship } = allowance(metadata)
    const read: JsonFileReader = async name => {
      if (tar.files >= limits.files) throw new Error("Archive file count exceeds the inventory allowance")
      const value = await tar.next(name)
      if (tar.offset > limits.bytes) throw new Error("Archive exceeds the inventory size allowance")
      return value
    }
    for await (const entry of largeFiles(metadata, read, relationship)) if (entry.name !== "metadata.json") await visit?.(entry.name, entry.value)
    const digest = await tar.end()
    if (size > limits.bytes) throw new Error("Archive exceeds the inventory size allowance")
    await visit?.("metadata.json", metadata)
    // Completion is the very last write, after the source digest and every reference were checked.
    return { tenantId: manifest.sourceTenantId.toLowerCase(), backupId: manifest.backupId, digest, count: limits.count, path }
  } finally { await file.close() }
}
export const reviewLargeArchive = (path: string) => visitArchive(path)
export async function importLargeArchive(store: LocalBlobStore, archive: ReviewedLargeArchive): Promise<void> {
  const account = `tvlocal-${archive.tenantId}`, container = "intune-backups", prefix = `${archive.backupId}/`
  await store.createContainer(account, container)
  if ((await store.list(account, container, prefix)).length) throw new Error("This backup already exists on this device")
  const marker = `${prefix}.tenuvault-owner.json`
  await store.put(account, container, marker, Buffer.from(JSON.stringify({ TenantId: archive.tenantId, RunId: randomUUID(), LargeInventory: { version: 1 } })), "application/json", true)
  const pending = new Set<Promise<void>>()
  let failure: unknown
  try {
    let metadata: any
    const checked = await visitArchive(archive.path, async (name, value) => {
      if (name === "metadata.json") { metadata = value; return }
      const task = store.put(account, container, prefix + name, Buffer.from(JSON.stringify(value)), "application/json", true).then(() => undefined, error => { failure ??= error }).finally(() => pending.delete(task))
      pending.add(task)
      if (pending.size >= 16) await Promise.race(pending)
      if (failure) throw failure
    })
    await Promise.all(pending)
    if (failure) throw failure
    if (checked.digest !== archive.digest || checked.tenantId !== archive.tenantId || checked.backupId !== archive.backupId) throw new Error("The archive changed since review")
    await store.put(account, container, prefix + "metadata.json", Buffer.from(JSON.stringify({ ...metadata, SourceTenantId: archive.tenantId, Import: { sha256: archive.digest, provenance: "User-reviewed tar; source identity is not cryptographically verified" } })), "application/json", true)
  } catch (error) {
    await Promise.all(pending)
    // Retire a possibly published completion marker before rolling back any content.
    await store.delete(account, container, prefix + "metadata.json", { despiteDamage: true }).catch(() => undefined)
    for (const blob of await store.list(account, container, prefix)) await store.delete(account, container, blob.name, { despiteDamage: true }).catch(() => undefined)
    throw error
  }
}
