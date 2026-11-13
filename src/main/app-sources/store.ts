import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { hostname } from "node:os"
import { basename, join, dirname } from "node:path"
import { mkdir, open, readdir, rename, rm, link, lstat, realpath, type FileHandle } from "node:fs/promises"
import type { StoredAppSource, LocalAppArchive, CapturedAppSource, CaptureIdentity } from "../../shared/app-sources/types"
import { inspectIntunewin, inspectSourceZip, type PackageReader } from "./package"
import { bindCapture } from "../app-backup/capture-identity"
import { ingestContent, type ContentEncryption } from "../app-backup/content-stream"

const CHUNK = 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const MAGIC = Buffer.from("TVS1")
const MANIFEST = Buffer.from("TVM1")
const METADATA_LIMIT = 64 * 1024
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
export function sourceTenant(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value.toLowerCase())) throw new Error("Select a configured tenant.")
  return value.toLowerCase()
}
const sourceId = (value: string) => { if (!UUID.test(value)) throw new Error("Invalid source identifier."); return value }
const abort = (signal?: AbortSignal) => signal?.throwIfAborted()
const key = (master: Buffer, tenant: string, purpose: string) => Buffer.from(hkdfSync("sha256", master, "TenuVault/app-sources/v1", `${tenant}/${purpose}`, 32))
const aad = (tenant: string, id: string, type: number, index: number) => Buffer.from(JSON.stringify(["TVS1", tenant, id, type, index]))
function seal(plain: Buffer, secret: Buffer, associated: Buffer): Buffer {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, nonce)
  cipher.setAAD(associated)
  return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}
function unseal(bytes: Buffer, secret: Buffer, associated: Buffer): Buffer {
  if (bytes.length < 28) throw new Error("The source is truncated.")
  const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12))
  decipher.setAAD(associated); decipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()])
}
async function exact(file: FileHandle, length: number): Promise<Buffer> {
  const data = Buffer.alloc(length)
  let at = 0
  while (at < length) { const n = await file.read(data, at, length - at, null); if (!n.bytesRead) throw new Error("The source is truncated."); at += n.bytesRead }
  return data
}
async function exactAt(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const data = Buffer.alloc(length)
  for (let at = 0; at < length;) {
    const { bytesRead } = await file.read(data, at, length - at, position + at)
    if (!bytesRead) throw new Error("The source is truncated.")
    at += bytesRead
  }
  return data
}
/** Fixed-size encrypted frames allow authenticated positional reads with one cached chunk. */
function snapshotReader(file: FileHandle, size: number, secret: Buffer, tenant: string, id: string, signal?: AbortSignal): PackageReader {
  let cachedIndex = -1
  let cached: Buffer = Buffer.alloc(0)
  return { async read(buffer, offset, length, position) {
    let written = 0
    while (written < length && position + written < size) {
      abort(signal)
      const at = position + written, index = Math.floor(at / CHUNK), chunkSize = Math.min(CHUNK, size - index * CHUNK)
      if (cachedIndex !== index) {
        const frame = await exactAt(file, chunkSize + 33, 4 + index * (CHUNK + 33))
        if (frame[0] !== 1 || frame.readUInt32BE(1) !== chunkSize + 28) throw new Error("The source contains an invalid chunk.")
        cached = unseal(frame.subarray(5), secret, aad(tenant, id, 1, index)); cachedIndex = index
      }
      const start = at % CHUNK, count = Math.min(length - written, cached.length - start)
      cached.copy(buffer, offset + written, start, start + count); written += count
    }
    return { bytesRead: written }
  } }
}
async function write(file: FileHandle, data: Buffer): Promise<void> {
  let at = 0
  while (at < data.length) { const n = await file.write(data, at, data.length - at); if (!n.bytesWritten) throw new Error("Could not write source data."); at += n.bytesWritten }
}
async function noLink(path: string): Promise<void> { if ((await lstat(path)).isSymbolicLink()) throw new Error("Source-store links are not supported.") }
async function readMetadata(path: string): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.size > METADATA_LIMIT) throw new Error("Source metadata must be a regular file of at most 64 KiB.")
  const file = await open(path, flags)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > METADATA_LIMIT) throw new Error("Source metadata must be a regular file of at most 64 KiB.")
    // The file can grow after stat. Bound the read itself, including an overflow byte.
    const bytes = Buffer.alloc(METADATA_LIMIT + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null)
      if (!bytesRead) return bytes.subarray(0, size)
      size += bytesRead
      if (size > METADATA_LIMIT) throw new Error("Source metadata exceeds 64 KiB.")
    }
    throw new Error("Source metadata exceeds 64 KiB.")
  } finally { await file.close() }
}
const activeExports = new Set<string>()
const owner = () => ({ host: hostname(), pid: process.pid })
function abandoned(value: { host?: unknown; pid?: unknown }): boolean {
  if (value.host !== hostname() || !Number.isInteger(value.pid) || Number(value.pid) <= 0) return false
  try { process.kill(Number(value.pid), 0); return false } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" }
}

/** Streaming, tenant-bound source storage. A final directory rename is the catalog commit point. */
export class AppSourceStore {
  constructor(readonly root: string, private readonly keys: () => Buffer[], private readonly exportRoot = root) {}
  private async folder(tenant: string, create = false, root = this.root): Promise<string | null> {
    sourceTenant(tenant)
    try {
      if (create) await mkdir(root, { recursive: true, mode: 0o700 })
      await noLink(root)
      const directory = join(await realpath(root), tenant)
      if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
      await noLink(directory)
      return directory
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }
  private encode(value: unknown, tenant: string, id: string, purpose: string, master = this.keys()[0]!): Buffer {
    return Buffer.concat([MANIFEST, seal(Buffer.from(JSON.stringify(value)), key(master, tenant, `${purpose}/${id}`), aad(tenant, id, 0, 0))])
  }
  private decode<T>(data: Buffer, tenant: string, id: string, purpose: string): { value: T; master: Buffer } {
    if (!data.subarray(0, 4).equals(MANIFEST) || data.length > METADATA_LIMIT) throw new Error("The source manifest is invalid.")
    for (const master of this.keys()) {
      try { return { value: JSON.parse(unseal(data.subarray(4), key(master, tenant, `${purpose}/${id}`), aad(tenant, id, 0, 0)).toString("utf8")) as T, master } } catch { /* Try rotated/imported keys. */ }
    }
    throw new Error("The source could not be authenticated. Check the source files and import the matching recovery key.")
  }
  private async manifest(tenant: string, id: string): Promise<{ value: StoredAppSource; master: Buffer; directory: string }> {
    const folder = await this.folder(tenant)
    if (!folder) throw new Error("The source folder is unavailable. Reconnect the retained source store.")
    const directory = join(folder, sourceId(id)); await noLink(directory)
    const bytes = await readMetadata(join(directory, "manifest.tvm"))
    const decoded = this.decode<StoredAppSource>(bytes, tenant, id, "manifest")
    const v = decoded.value
    if (!v || !/^[a-f0-9]{24}$/.test(v.keyId) || v.id !== id || v.tenantId !== tenant || !Number.isSafeInteger(v.bytes) || v.bytes < 0 || v.bytes > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(v.sha256) || typeof v.fileName !== "string" || v.fileName !== basename(v.fileName) || typeof v.appName !== "string" || !Number.isFinite(Date.parse(v.createdAt))) throw new Error("The source manifest is invalid.")
    if (v.provenance === "administrator-selected") {
      if (v.format !== "intunewin" || !/\.intunewin$/i.test(v.fileName) || (v.appName.length > 200 && v.appName !== basename(v.fileName, ".intunewin"))) throw new Error("The source manifest is invalid.")
    } else if (v.provenance === "intune-capture") {
      if (v.format !== "win32-source-zip" || v.fileName !== `${v.id}.zip` || v.appName.length > 200 || !v.receipt || v.receipt.schema !== 1 || v.receipt.tenantId !== tenant || v.bytes < 22 || v.receipt.encryptedBytes !== 48 + (Math.floor(v.bytes / 16) + 1) * 16 || !/^[a-f0-9]{64}$/.test(v.receipt.encryptedSha256)) throw new Error("The capture receipt is invalid.")
      bindCapture(v.receipt, v.receipt)
    } else throw new Error("The source provenance is invalid.")
    // Earlier builds used an unbounded filename-derived label. Normalize only that
    // authenticated legacy value in memory, keeping retained/read-only stores usable.
    v.appName = v.appName.slice(0, 200)
    return { ...decoded, directory }
  }
  async list(tenant: string): Promise<{ sources: StoredAppSource[]; warnings: string[]; unreadableSources: boolean }> {
    const folder = await this.folder(tenant), sources: StoredAppSource[] = [], warnings: string[] = []
    let unreadableSources = false
    const exportFolder = this.exportRoot === this.root ? folder : await this.folder(tenant, false, this.exportRoot)
    for (const current of new Set([folder, exportFolder])) {
      if (!current) continue
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (current === folder && entry.name.startsWith(".staging-")) {
          const stage = join(current, entry.name)
          if (entry.isDirectory() && /^\.staging-[a-f0-9-]{36}$/.test(entry.name)) {
            try { const data = this.decode<{ host: string; pid: number }>(await readMetadata(join(stage, "owner.tvm")), tenant, entry.name.slice(9), "owner"); if (abandoned(data.value)) { await rm(stage, { recursive: true }); continue } } catch { /* Unknown staging is quarantined, never listed. */ }
          }
          warnings.push("An import has not completed and is not counted as a stored source.")
        } else if (current === folder && UUID.test(entry.name)) {
          try { const item = await this.manifest(tenant, entry.name); await noLink(join(item.directory, "artifact.tvs")); sources.push(item.value) } catch { unreadableSources = true; warnings.push("A stored source could not be read. Check the source folder and recovery key.") }
        } else if (/^\.export-[a-f0-9-]{36}\.tvm$/.test(entry.name)) {
          const id = entry.name.slice(8, -4)
          let record: { host: string; pid: number; temporary: string }
          try {
            record = this.decode<typeof record>(await readMetadata(join(current, entry.name)), tenant, id, "export").value
          } catch { warnings.push("An unfinished export journal could not be authenticated. Check its files and matching recovery key."); continue }
          if (!record || typeof record.temporary !== "string" || basename(record.temporary) !== `.tenuvault-export-${id}.tmp`) {
            warnings.push("An unfinished export journal is invalid and has not been reconciled."); continue
          }
          if (!abandoned(record) && !(record.host === hostname() && record.pid === process.pid && !activeExports.has(join(current, entry.name)))) { warnings.push("An unfinished export belongs to another process or device and has not been reconciled."); continue }
          try { await rm(record.temporary, { force: true }) }
          catch { warnings.push(`Plaintext temporary file ${basename(record.temporary)} may remain at the export destination. Check file access and refresh to retry cleanup.`); continue }
          try { await rm(join(current, entry.name)) }
          catch { warnings.push("The plaintext export temporary was removed, but its journal could not be removed. Refresh to retry cleanup.") }
        }
      }
    }
    return { sources: sources.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), warnings: [...new Set(warnings)], unreadableSources }
  }
  async attach(tenant: string, input: string, appName: string, signal?: AbortSignal): Promise<LocalAppArchive> {
    const folder = (await this.folder(tenant, true))!, id = randomUUID(), stage = join(folder, `.staging-${id}`), master = this.keys()[0]!
    if (typeof appName !== "string" || appName.trim().length > 200 || !/\.intunewin$/i.test(input)) throw new Error("Choose an .intunewin file and an app name of at most 200 characters.")
    const file = await open(input, flags)
    let made = false
    try {
      const before = await file.stat()
      if (!before.isFile()) throw new Error("Choose a regular .intunewin file.")
      if (before.size < 22 || before.size > 2 * 1024 ** 3) throw new Error("Choose an .intunewin package smaller than 2 GiB.")
      abort(signal)
      await mkdir(stage, { mode: 0o700 }); made = true
      await this.privateWrite(join(stage, "owner.tvm"), this.encode(owner(), tenant, id, "owner", master))
      const artifact = await open(join(stage, "artifact.tvs"), "wx+", 0o600)
      const secret = key(master, tenant, `artifact/${id}`), hash = createHash("sha256")
      let size = 0, index = 0
      try {
        await write(artifact, MAGIC)
        while (size < before.size) {
          abort(signal)
          const plain = await exactAt(file, Math.min(CHUNK, before.size - size), size); hash.update(plain)
          await this.frame(artifact, plain, secret, tenant, id, 1, index++)
          size += plain.length
        }
        const after = await file.stat()
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("The selected file changed during import.")
        const sha256 = hash.digest("hex")
        await this.frame(artifact, Buffer.from(JSON.stringify({ size, sha256, chunks: index })), secret, tenant, id, 2, index)
        await artifact.sync(); abort(signal)
        // Inspect only the immutable encrypted snapshot that will be published, not the live input.
        await inspectIntunewin(snapshotReader(artifact, size, secret, tenant, id, signal), size); abort(signal)
        const manifest: LocalAppArchive = { id, tenantId: tenant, fileName: basename(input), appName: appName.trim() || basename(input).replace(/\.intunewin$/i, "").slice(0, 200), bytes: size, sha256, createdAt: new Date().toISOString(), provenance: "administrator-selected", format: "intunewin", keyId: createHmac("sha256", master).update("TenuVault/app-sources/key-id/v1").digest("hex").slice(0, 24) }
        await this.privateWrite(join(stage, "manifest.tvm"), this.encode(manifest, tenant, id, "manifest", master))
        await artifact.close(); abort(signal)
        await rename(stage, join(folder, id))
        return manifest
      } finally { await artifact.close().catch(() => {}) }
    } finally { await file.close(); if (made) await rm(stage, { recursive: true, force: true }) }
  }
  /**
   * Internal ingestion seam for an authenticated device adapter. No renderer IPC.
   * The adapter must authorize the requester and establish the returned identity;
   * this store verifies binding and content integrity, not Microsoft permissions.
   */
  async capture(expected: CaptureIdentity, returned: CaptureIdentity, content: AsyncIterable<Uint8Array>, encryption: ContentEncryption, bytes: number, appName: string, signal?: AbortSignal): Promise<CapturedAppSource> {
    const identity = bindCapture(expected, returned), tenant = identity.tenantId
    if (typeof appName !== "string" || !appName.trim() || appName.trim().length > 200) throw new Error("Invalid captured app name.")
    // Snapshot the helper metadata before any asynchronous work.
    const profile = { ...encryption }
    abort(signal)
    if ((await this.list(tenant)).unreadableSources) throw new Error("Import the matching recovery key before capturing into this source store.")
    abort(signal)
    const master = this.keys()[0]
    if (!master || master.length !== 32) throw new Error("A source-store encryption key is required.")
    const folder = (await this.folder(tenant, true))!, id = randomUUID(), stage = join(folder, `.staging-${id}`)
    const secret = key(master, tenant, `artifact/${id}`), pending = Buffer.alloc(CHUNK)
    let made = false, artifact: FileHandle | undefined, used = 0, index = 0
    try {
      await mkdir(stage, { mode: 0o700 }); made = true
      await this.privateWrite(join(stage, "owner.tvm"), this.encode(owner(), tenant, id, "owner", master))
      artifact = await open(join(stage, "artifact.tvs"), "wx+", 0o600)
      await write(artifact, MAGIC)
      const integrity = await ingestContent(content, profile, bytes, async plain => {
        for (let offset = 0; offset < plain.length;) {
          abort(signal)
          const count = Math.min(CHUNK - used, plain.length - offset)
          plain.copy(pending, used, offset, offset + count); used += count; offset += count
          if (used === CHUNK) { await this.frame(artifact!, pending, secret, tenant, id, 1, index++); pending.fill(0); used = 0 }
        }
      }, signal)
      if (used) await this.frame(artifact, pending.subarray(0, used), secret, tenant, id, 1, index++)
      pending.fill(0)
      await this.frame(artifact, Buffer.from(JSON.stringify({ size: integrity.bytes, sha256: integrity.sha256, chunks: index })), secret, tenant, id, 2, index)
      await artifact.sync(); abort(signal)
      await inspectSourceZip(snapshotReader(artifact, integrity.bytes, secret, tenant, id, signal), integrity.bytes)
      const manifest: CapturedAppSource = {
        id, tenantId: tenant, fileName: `${id}.zip`, appName: appName.trim(), bytes: integrity.bytes, sha256: integrity.sha256,
        createdAt: new Date().toISOString(), keyId: createHmac("sha256", master).update("TenuVault/app-sources/key-id/v1").digest("hex").slice(0, 24),
        provenance: "intune-capture", format: "win32-source-zip",
        receipt: { schema: 1, ...identity, encryptedSha256: integrity.encryptedSha256, encryptedBytes: integrity.encryptedBytes },
      }
      abort(signal)
      await this.privateWrite(join(stage, "manifest.tvm"), this.encode(manifest, tenant, id, "manifest", master))
      await artifact.close(); artifact = undefined; abort(signal)
      await rename(stage, join(folder, id))
      return manifest
    } finally {
      pending.fill(0); secret.fill(0)
      try { await artifact?.close() } finally { if (made) await rm(stage, { recursive: true, force: true }) }
    }
  }
  /** Content identity prerequisite only; restore still needs its codec and authorization. */
  async capturedSource(tenant: string, id: string): Promise<CapturedAppSource> {
    const { value } = await this.manifest(tenant, id)
    if (value.provenance !== "intune-capture") throw new Error("Restore requires an earlier Intune capture. Local archives cannot be restored.")
    return value
  }
  private async privateWrite(path: string, bytes: Buffer): Promise<void> {
    const file = await open(path, "wx", 0o600)
    try { await write(file, bytes); await file.sync() } finally { await file.close() }
  }
  private async frame(file: FileHandle, plain: Buffer, secret: Buffer, tenant: string, id: string, type: number, index: number): Promise<void> {
    const encrypted = seal(plain, secret, aad(tenant, id, type, index)), header = Buffer.alloc(5)
    header[0] = type; header.writeUInt32BE(encrypted.length, 1)
    await write(file, header); await write(file, encrypted)
  }
  async export(tenant: string, id: string, destination: string, signal?: AbortSignal): Promise<void> {
    const manifest = await this.manifest(tenant, id), folder = (await this.folder(tenant, true, this.exportRoot))!, job = randomUUID()
    const temporary = join(dirname(destination), `.tenuvault-export-${job}.tmp`), journal = join(folder, `.export-${job}.tvm`)
    let ownsTemp = false, madeJournal = false, published = false
    // Fail early for an existing destination; link() below still guards concurrent creation.
    try { await lstat(destination); throw Object.assign(new Error("The export destination already exists."), { code: "EEXIST" }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    const input = await open(join(manifest.directory, "artifact.tvs"), flags)
    activeExports.add(journal)
    try {
      abort(signal)
      await this.privateWrite(journal, this.encode({ ...owner(), temporary }, tenant, job, "export")); madeJournal = true
      const output = await open(temporary, "wx", 0o600); ownsTemp = true
      try {
        if (!(await exact(input, 4)).equals(MAGIC)) throw new Error("The stored source format is invalid.")
        const secret = key(manifest.master, tenant, `artifact/${id}`), hash = createHash("sha256")
        let size = 0, index = 0
        for (;;) {
          abort(signal)
          const header = await exact(input, 5), type = header[0]!, length = header.readUInt32BE(1)
          if (![1, 2].includes(type) || length < 28 || length > CHUNK + 28) throw new Error("The source contains an invalid chunk.")
          const plain = unseal(await exact(input, length), secret, aad(tenant, id, type, index))
          if (type === 2) {
            const footer = JSON.parse(plain.toString("utf8")) as { size: number; chunks: number; sha256: string }
            const sha256 = hash.digest("hex"), extra = Buffer.alloc(1)
            if (footer.size !== size || footer.chunks !== index || footer.sha256 !== sha256 || size !== manifest.value.bytes || sha256 !== manifest.value.sha256 || (await input.read(extra, 0, 1, null)).bytesRead) throw new Error("The source integrity check failed.")
            break
          }
          size += plain.length; index++
          if (!plain.length || size > manifest.value.bytes) throw new Error("The source length is invalid.")
          hash.update(plain); await write(output, plain)
        }
        await output.sync(); abort(signal)
      } finally { await output.close() }
      // Atomic no-overwrite publication is the cancellation cutoff. Existing files are preserved.
      abort(signal)
      await link(temporary, destination)
      published = true
    } finally {
      // Publication is the success point. Keep the journal for a cleanup retry if needed.
      // The following list returns its warning without misreporting a completed export.
      const cleanup = async () => {
        try { await input.close() } finally {
          if (ownsTemp) await rm(temporary, { force: true })
          if (madeJournal) await rm(journal, { force: true })
        }
      }
      await (published ? cleanup().catch(() => {}) : cleanup()).finally(() => activeExports.delete(journal))
    }
  }
}
