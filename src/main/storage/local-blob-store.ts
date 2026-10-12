import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"
import { link, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { mapLimit } from "../../portal/lib/map-limit"

/**
 * Encrypted on-disk blob storage for backups kept on this device.
 *
 * Layout: <root>/<account>/<container>/<id>.tvb, one file per blob. Every file is
 * encrypted with AES-256-GCM. File names are an HMAC of the blob name, so the disk
 * shows neither policy names nor content. File format:
 *
 *   magic | u16 header length | header iv (12) | header tag (16) | header ciphertext
 *         | body iv (12) | body tag (16) | body ciphertext
 *
 * The header holds { name, contentType, created } as JSON. Keys are derived from a
 * master key; older master keys (after importing a recovery key) stay readable.
 *
 * Version 1 ("TVB1") binds only the container and blob name. Version 2 ("TVB2") binds
 * every file to its account (tenant): the account is part of the file-name HMAC and of
 * both AES-GCM AADs, and the header AAD also holds the file name, so a header cannot be
 * moved to another file, container or account. Both versions are read, each with its
 * own rules; new files and overwrites use WRITE_FORMAT.
 */

/**
 * The format new files and overwrites are written in. Version 2 since 0.3.0. Every released
 * app version (0.2.0 and later) reads both versions, so a folder shared with or opened by an
 * earlier release stays readable, and files written before the switch are never rewritten
 * unless they are overwritten. Keep reading version 1 until at least 0.5.0 (two minor
 * versions after the switch) and record the removal in RELEASING.md when it happens.
 */
export const WRITE_FORMAT: Version = 2

const MAGIC_V1 = Buffer.from("TVB1")
const MAGIC_V2 = Buffer.from("TVB2")
const MAGIC_LENGTH = 4
const IV = 12
const TAG = 16
const EXT = ".tvb"

/** Detects encrypted local backup files. Returns null if an incomplete scan cannot rule them out. */
export async function localBackupsExist(
  root: string,
  readDirectory = (path: string) => readdir(path, { withFileTypes: true }),
): Promise<boolean | null> {
  try {
    const accounts = await readDirectory(root)
    let incomplete = false
    for (const account of accounts) {
      if (!account.isDirectory()) continue
      const folder = join(root, account.name, "intune-backups")
      try {
        const files = await readDirectory(folder)
        if (files.some((file) => file.isFile() && file.name.endsWith(EXT))) return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          incomplete = true
          console.warn(`[backups] Could not scan local backup folder ${folder}:`, error)
        }
      }
    }
    return incomplete ? null : false
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false
    console.warn(`[backups] Could not scan local backup folder ${root}:`, error)
    return null
  }
}

/** File headers read at once while reading a container's inventory. */
const HEADER_CONCURRENCY = 16

export interface StoredBlob {
  name: string
  size: number
  contentType: string
  created: Date
  lastModified: Date
  metadata?: Record<string, string>
  etag?: string
}

export type Version = 1 | 2

interface Entry extends StoredBlob {
  file: string
  version: Version
  stamp: string
}

interface Keys {
  encryption: Buffer
  naming: Buffer
}

function deriveKeys(master: Buffer): Keys {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32))
  return { encryption: derive("tenuvault-backup-encryption-v1"), naming: derive("tenuvault-backup-naming-v1") }
}

function seal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

function unseal(key: Buffer, sealed: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(sealed.subarray(IV, IV + TAG))
  return Buffer.concat([decipher.update(sealed.subarray(IV + TAG)), decipher.final()])
}

/** Associated data for a file's header. Version 1 bound only the container. */
function headerAad(version: Version, account: string, container: string, file: string): string {
  return version === 1 ? `header:${container}` : JSON.stringify(["tvb2-header", account.toLowerCase(), container, file])
}

/** Associated data for a file's body. Version 1 bound only the container and blob name. */
function bodyAad(version: Version, account: string, container: string, name: string): string {
  return version === 1 ? `${container}/${name}` : JSON.stringify(["tvb2-body", account.toLowerCase(), container, name])
}

function fileName(version: Version, naming: Buffer, account: string, container: string, name: string): string {
  const input = version === 1 ? `${container}/${name}` : JSON.stringify(["tvb2-name", account.toLowerCase(), container, name])
  const id = createHmac("sha256", naming).update(input).digest("hex").slice(0, 40)
  return `${id}${EXT}`
}

function versionOf(magic: Buffer): Version | null {
  return magic.equals(MAGIC_V2) ? 2 : magic.equals(MAGIC_V1) ? 1 : null
}

export class BlobNotFoundError extends Error {}
export class BlobAlreadyExistsError extends Error {}

export class IncompleteInventoryError extends Error {
  constructor(readonly unreadableFiles: number) {
    super(`Backup inventory is incomplete: ${unreadableFiles} encrypted file(s) could not be read. Import the correct recovery keys or recover damaged files before continuing.`)
  }
}

/** Syncs a directory so its entries survive a crash; a failure is logged, since the data itself is already written. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const directory = await open(dir, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    console.warn(`Failed to sync directory ${dir}: ${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}`)
  }
}

/** Creates a directory and syncs the parent of every directory it had to create, so the new entries survive a crash. */
async function mkdirDurable(path: string): Promise<void> {
  const created: string[] = []
  for (let probe = path; ; probe = dirname(probe)) {
    try {
      await stat(probe)
      break
    } catch {
      created.unshift(probe)
      if (dirname(probe) === probe) break
    }
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform === "win32") return
  for (const dir of created) await syncDirectory(dirname(dir))
}

export class LocalBlobStore {
  private readonly keyring: Keys[]
  private readonly index = new Map<string, Promise<Map<string, Entry>>>()
  private readonly directoryStamps = new Map<string, string>()
  private readonly dirty = new Set<string>()
  private readonly checks = new Map<string, Promise<Map<string, Entry>>>()

  /**
   * @param root   Folder that holds the encrypted backups.
   * @param masterKeys Current master key first, then older keys that must stay readable.
   * @param writeFormat Format for new files and overwrites; see WRITE_FORMAT.
   */
  constructor(
    private readonly root: string,
    masterKeys: Buffer[],
    private readonly writeFormat: Version = WRITE_FORMAT,
  ) {
    if (masterKeys.length === 0) throw new Error("A backup encryption key is required.")
    this.keyring = masterKeys.map(deriveKeys)
  }

  async containerExists(account: string, container: string): Promise<boolean> {
    try {
      return (await stat(this.dir(account, container))).isDirectory()
    } catch {
      return false
    }
  }

  /** Returns false when the container already existed. */
  async createContainer(account: string, container: string): Promise<boolean> {
    const existed = await this.containerExists(account, container)
    await mkdirDurable(this.dir(account, container))
    return !existed
  }

  async listContainers(account: string): Promise<string[]> {
    try {
      const entries = await readdir(join(this.root, safeSegment(account)), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch {
      return []
    }
  }

  async list(account: string, container: string, prefix = ""): Promise<StoredBlob[]> {
    const entries = await this.checkedEntries(account, container)
    return [...entries.values()].filter((entry) => entry.name.startsWith(prefix))
      .map(({ file: _file, version: _version, stamp: _stamp, ...blob }) => blob).sort((a, b) => (a.name < b.name ? -1 : 1))
  }

  async get(account: string, container: string, name: string): Promise<{ blob: StoredBlob; data: Buffer }> {
    const entry = (await this.checkedEntries(account, container)).get(name)
    if (!entry) throw new BlobNotFoundError(name)
    const raw = await readFile(join(this.dir(account, container), entry.file))
    const version = versionOf(raw.subarray(0, MAGIC_LENGTH))
    if (!version) throw new Error("Invalid backup header")
    const headerLength = raw.readUInt16BE(MAGIC_LENGTH)
    const body = raw.subarray(MAGIC_LENGTH + 2 + headerLength)
    const { file: _file, version: _version, stamp: _stamp, ...blob } = entry
    return { blob, data: this.decrypt(body, bodyAad(version, account, container, name)) }
  }

  async put(account: string, container: string, name: string, data: Uint8Array, contentType: string, createOnly = false, metadata?: Record<string, string>): Promise<StoredBlob> {
    if (!(await this.containerExists(account, container))) throw new BlobNotFoundError(container)
    const entries = await this.entries(account, container)
    const current = this.keyring[0]!
    const existing = entries.get(name)
    if (createOnly && existing) throw new BlobAlreadyExistsError(name)
    // A version 1 file keeps its name when overwritten, so the blob never has two files.
    const version = this.writeFormat
    const file = existing?.file ?? fileName(version, current.naming, account, container, name)
    const created = existing?.created ?? new Date()

    const header = seal(current.encryption, Buffer.from(JSON.stringify({ name, contentType, created, ...(metadata ? { metadata } : {}) })), headerAad(version, account, container, file))
    const body = seal(current.encryption, Buffer.from(data), bodyAad(version, account, container, name))
    const length = Buffer.alloc(2)
    length.writeUInt16BE(header.length)

    const path = join(this.dir(account, container), file)
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`
    try {
      const handle = await open(tmp, "wx", 0o600)
      try {
        await handle.writeFile(Buffer.concat([version === 1 ? MAGIC_V1 : MAGIC_V2, length, header, body]))
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (createOnly) await link(tmp, path) // Atomic creation across store/process instances.
      else await rename(tmp, path)
      if (process.platform !== "win32") await syncDirectory(this.dir(account, container))
    } catch (error) {
      this.index.delete(this.dir(account, container))
      if (createOnly && (error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new BlobAlreadyExistsError(name)
      }
      throw error
    } finally {
      await rm(tmp, { force: true })
    }

    const info = await stat(path)
    const stamp = fileStamp(info)
    const blob: StoredBlob = { name, size: data.byteLength, contentType, created, lastModified: info.mtime, etag: `"${stamp}"`, ...(metadata ? { metadata } : {}) }
    entries.set(name, { ...blob, file, version, stamp })
    this.dirty.add(this.dir(account, container))
    this.directoryStamps.set(this.dir(account, container), await this.directoryStamp(this.dir(account, container)))
    return blob
  }

  async delete(account: string, container: string, name: string): Promise<void> {
    const entries = await this.entries(account, container)
    const entry = entries.get(name)
    if (!entry) throw new BlobNotFoundError(name)
    await rm(join(this.dir(account, container), entry.file), { force: true })
    entries.delete(name)
    this.dirty.add(this.dir(account, container))
    this.directoryStamps.set(this.dir(account, container), await this.directoryStamp(this.dir(account, container)))
  }

  private dir(account: string, container: string): string {
    return join(this.root, safeSegment(account), safeSegment(container))
  }

  private async directoryStamp(dir: string): Promise<string> {
    try {
      const info = await stat(dir)
      return fileStamp(info)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
      throw error
    }
  }

  /** Coalesces inventory checks and rebuilds. File stats also detect in-place corruption. */
  private checkedEntries(account: string, container: string): Promise<Map<string, Entry>> {
    const dir = this.dir(account, container)
    const pending = this.checks.get(dir)
    if (pending) return pending
    const check = (async () => {
      let entries = await this.entries(account, container)
      const unchanged = !this.dirty.has(dir) && (await mapLimit([...entries.values()], HEADER_CONCURRENCY, async (entry) => {
        try { return fileStamp(await stat(join(dir, entry.file))) === entry.stamp } catch { return false }
      })).every(Boolean)
      if (!unchanged) {
        this.index.delete(dir)
        entries = await this.entries(account, container)
        this.dirty.delete(dir)
      }
      return entries
    })()
    this.checks.set(dir, check)
    void check.finally(() => { if (this.checks.get(dir) === check) this.checks.delete(dir) }).catch(() => undefined)
    return check
  }

  /** Keeps decrypted headers until a write or a change to the directory inventory. */
  private async entries(account: string, container: string): Promise<Map<string, Entry>> {
    const dir = this.dir(account, container)
    const stamp = await this.directoryStamp(dir)
    if (this.directoryStamps.get(dir) !== stamp) this.index.delete(dir)
    let cached = this.index.get(dir)
    if (!cached) {
      this.directoryStamps.set(dir, stamp)
      cached = this.readIndex(dir, account, container)
      this.index.set(dir, cached)
      const current = cached
      void cached.catch(() => { if (this.index.get(dir) === current) this.index.delete(dir) })
    }
    return cached
  }

  private async readIndex(dir: string, account: string, container: string): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>()
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(EXT))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return entries
      throw error
    }
    // Headers are read a few at a time and added in directory order, so duplicates are found as before.
    const read = await mapLimit(files, HEADER_CONCURRENCY, async (file): Promise<Entry | null> => {
      const path = join(dir, file)
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(path, "r")
        const prefix = Buffer.alloc(MAGIC_LENGTH + 2)
        const prefixRead = await handle.read(prefix, 0, prefix.length, 0)
        const version = prefixRead.bytesRead === prefix.length ? versionOf(prefix.subarray(0, MAGIC_LENGTH)) : null
        if (!version) throw new Error("Invalid backup header")
        const headerLength = prefix.readUInt16BE(MAGIC_LENGTH)
        const sealed = Buffer.alloc(headerLength)
        const headerRead = await handle.read(sealed, 0, headerLength, prefix.length)
        if (headerLength < IV + TAG || headerRead.bytesRead !== headerLength) throw new Error("Truncated backup header")
        const header = JSON.parse(this.decrypt(sealed, headerAad(version, account, container, file)).toString()) as {
          name: string
          contentType: string
          created: string
          metadata?: Record<string, string>
        }
        if (!header || typeof header.name !== "string" || !header.name || typeof header.contentType !== "string" || !Number.isFinite(Date.parse(header.created))) {
          throw new Error("Invalid backup header")
        }
        const info = await handle.stat()
        if (info.size < prefix.length + headerLength + IV + TAG) throw new Error("Truncated backup body")
        return {
          file,
          version,
          name: header.name,
          contentType: header.contentType,
          created: new Date(header.created),
          lastModified: info.mtime,
          size: info.size - prefix.length - headerLength - IV - TAG,
          stamp: fileStamp(info),
          etag: `"${fileStamp(info)}"`,
          ...(header.metadata ? { metadata: header.metadata } : {}),
        }
      } catch {
        return null
      } finally {
        await handle?.close()
      }
    })
    let unreadable = 0
    for (const entry of read) {
      // A file that cannot be read, or a second file for the same blob, is unreadable.
      if (!entry || entries.has(entry.name)) unreadable++
      else entries.set(entry.name, entry)
    }
    if (unreadable) throw new IncompleteInventoryError(unreadable)
    // Desktop metadata already contains a per-item manifest. Check it before
    // exposing any inventory to downloads or restores, including selective reads.
    for (const entry of entries.values()) {
      if (container !== "intune-backups" || !/^backup-[^/]+\/metadata\.json$/.test(entry.name)) continue
      const raw = await readFile(join(dir, entry.file))
      const body = raw.subarray(MAGIC_LENGTH + 2 + raw.readUInt16BE(MAGIC_LENGTH))
      const metadata = JSON.parse(this.decrypt(body, bodyAad(entry.version, account, container, entry.name)).toString())
      if (metadata.Items === undefined) continue // Legacy backups have no inventory manifest.
      if (!metadata.Items || typeof metadata.Items !== "object" || Array.isArray(metadata.Items)) throw new Error("Invalid backup inventory manifest")
      const prefix = entry.name.slice(0, -"metadata.json".length)
      let missing = 0
      for (const [key, item] of Object.entries(metadata.Items)) {
        const folder = key.split("/")[0]
        const file = (item as { file?: unknown } | null)?.file
        if (!folder || typeof file !== "string" || !file || file.includes("/") || file.includes("\\")) throw new Error("Invalid backup inventory manifest")
        if (!entries.has(`${prefix}${folder}/${file}`)) missing++
      }
      if (missing) throw new Error(`Backup inventory is incomplete: ${missing} file(s) listed in the manifest are missing. Recover the missing files before downloading or restoring.`)
    }
    return entries
  }

  private decrypt(sealed: Buffer, aad: string): Buffer {
    for (const keys of this.keyring) {
      try {
        return unseal(keys.encryption, sealed, aad)
      } catch {
        // Try the next (older) key.
      }
    }
    throw new Error("This backup was encrypted with a key this device does not have. Import its recovery key.")
  }
}

/** Keeps account and container names inside the root folder. */
function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9-]/g, "_")
  if (!safe || safe === "." || safe === "..") throw new Error(`Invalid storage name: ${value}`)
  return safe
}

/** Includes change time and inode so atomic replacements and in-place edits invalidate the cache. */
function fileStamp(info: NonNullable<Awaited<ReturnType<typeof stat>>>): string {
  return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}
