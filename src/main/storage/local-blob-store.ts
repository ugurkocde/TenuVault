import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"
import { lstatSync, readdirSync, unlinkSync } from "node:fs"
import { link, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
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
 * The format new files and overwrites are written in. Stays 1 for now, because earlier
 * app versions read only TVB1 and would treat a folder holding TVB2 files as damaged
 * (shared backup folders, downgrades). Switch to 2 in a later release, once installs
 * that read TVB2 are widespread.
 */
export const WRITE_FORMAT: Version = 1

const MAGIC_V1 = Buffer.from("TVB1")
const MAGIC_V2 = Buffer.from("TVB2")
const MAGIC_LENGTH = 4
const IV = 12
const TAG = 16
const EXT = ".tvb"
/** Files authenticated at once while reading a container's inventory. */
const HEADER_CONCURRENCY = 16

export interface StoredBlob {
  name: string
  size: number
  contentType: string
  created: Date
  lastModified: Date
}

export type Version = 1 | 2

interface Entry extends StoredBlob {
  file: string
  version: Version
}

export interface DamagedFile {
  file: string
  reason: string
  /** Available only when the encrypted header could be authenticated. */
  name?: string
}

interface Inventory {
  entries: Map<string, Entry>
  files: Map<string, string | null>
  damagedFiles: DamagedFile[]
  unavailableBackups: Map<string, string>
  blockedBackups: Map<string, string>
}

function emptyInventory(): Inventory {
  return { entries: new Map(), files: new Map(), damagedFiles: [], unavailableBackups: new Map(), blockedBackups: new Map() }
}

function fileState(info: Awaited<ReturnType<typeof stat>>): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
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
  constructor(readonly unreadableFiles: number, reason?: string) {
    super(reason ?? `Backup inventory is incomplete: ${unreadableFiles} encrypted file(s) could not be read. Import the correct recovery keys or recover damaged files before continuing.`)
  }
}

export class LocalBlobStore {
  private readonly keyring: Keys[]
  private readonly index = new Map<string, Promise<Inventory>>()
  /** The inventory reread per container that list() calls share; `started` once it reads the disk. */
  private readonly rereads = new Map<string, { started: boolean; entries: Promise<Inventory> }>()

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
    await mkdir(this.dir(account, container), { recursive: true, mode: 0o700 })
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

  async list(account: string, container: string): Promise<StoredBlob[]> {
    return (await this.inventory(account, container)).blobs
  }

  /** Healthy blobs and diagnostics from the same shared inventory reread. */
  async inventory(account: string, container: string) {
    const inventory = await this.reread(account, container)
    return {
      blobs: [...inventory.entries.values()].map(({ file: _file, version: _version, ...blob }) => blob).sort((a, b) => (a.name < b.name ? -1 : 1)),
      damagedFiles: inventory.damagedFiles.map((file) => ({ ...file })),
      unavailableBackups: [...inventory.unavailableBackups].map(([name, reason]) => ({ name, reason })),
      completenessUnknown: inventory.damagedFiles.some((file) => !file.name || (container === "intune-backups" && !/^backup-[^/]+\//.test(file.name))),
      retentionPaused: inventory.damagedFiles.length > 0 || inventory.unavailableBackups.size > 0,
    }
  }

  async get(account: string, container: string, name: string): Promise<{ blob: StoredBlob; data: Buffer }> {
    const dir = this.dir(account, container)
    const cached = await this.entries(account, container)
    // Check membership and file changes without decrypting an unchanged inventory again.
    const files = (await readdir(dir)).filter((file) => file.endsWith(EXT))
    const states = await mapLimit(files, HEADER_CONCURRENCY, async (file) => {
      try { return fileState(await stat(join(dir, file))) } catch { return null }
    })
    if (files.length !== cached.files.size || files.some((file, i) => !cached.files.has(file) || cached.files.get(file) !== states[i])) this.index.delete(dir)
    const inventory = await this.entries(account, container)
    const unavailable = container === "intune-backups" ? inventory.blockedBackups.get(name.split("/")[0]!) : undefined
    if (unavailable) throw new IncompleteInventoryError(1, unavailable)
    const damaged = this.damagedFor(inventory, account, container, name)
    if (damaged.length) throw new IncompleteInventoryError(damaged.length)
    const entry = inventory.entries.get(name)
    if (!entry) throw new BlobNotFoundError(name)
    const raw = await readFile(join(this.dir(account, container), entry.file))
    const version = versionOf(raw.subarray(0, MAGIC_LENGTH))
    if (!version) throw new Error("Invalid backup header")
    const headerLength = raw.readUInt16BE(MAGIC_LENGTH)
    const body = raw.subarray(MAGIC_LENGTH + 2 + headerLength)
    const { file: _file, version: _version, ...blob } = entry
    return { blob, data: this.decrypt(body, bodyAad(version, account, container, name)) }
  }

  async put(account: string, container: string, name: string, data: Uint8Array, contentType: string, createOnly = false): Promise<StoredBlob> {
    if (!(await this.containerExists(account, container))) throw new BlobNotFoundError(container)
    const inventory = await this.entries(account, container)
    const entries = inventory.entries
    const current = this.keyring[0]!
    const existing = entries.get(name)
    if (createOnly && (existing || this.damagedFor(inventory, account, container, name).length)) throw new BlobAlreadyExistsError(name)
    // A version 1 file keeps its name when overwritten, so the blob never has two files.
    const version = this.writeFormat
    const file = existing?.file ?? fileName(version, current.naming, account, container, name)
    const created = existing?.created ?? new Date()

    const header = seal(current.encryption, Buffer.from(JSON.stringify({ name, contentType, created })), headerAad(version, account, container, file))
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
      if (process.platform !== "win32") {
        const directory = await open(this.dir(account, container), "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } catch (error) {
      this.index.delete(this.dir(account, container))
      if (createOnly && (error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new BlobAlreadyExistsError(name)
      }
      throw error
    } finally {
      await rm(tmp, { force: true })
    }

    const blob: StoredBlob = { name, size: data.byteLength, contentType, created, lastModified: new Date() }
    entries.set(name, { ...blob, file, version })
    inventory.files.set(file, fileState(await stat(path)))
    if (name.endsWith("/metadata.json") || inventory.damagedFiles.length || inventory.unavailableBackups.size) this.index.delete(this.dir(account, container))
    return blob
  }

  async delete(account: string, container: string, name: string): Promise<void> {
    const dir = this.dir(account, container)
    // Delete is the only destructive operation, so it carries its own clean-inventory
    // precondition. Never use the cache or a listing's shared reread for this check.
    try {
      let inventory: Inventory
      try {
        inventory = await this.readIndex(dir, account, container)
      } catch {
        throw new IncompleteInventoryError(1, "Cannot delete local backup files because a fresh inventory could not be read. Recover the files or finish folder sync before retrying.")
      }
      const backup = name.split("/")[0]!
      const unavailable = inventory.unavailableBackups.get(backup) ?? inventory.blockedBackups.get(backup)
      if (inventory.damagedFiles.length || inventory.unavailableBackups.size || inventory.blockedBackups.size || unavailable) {
        throw new IncompleteInventoryError(Math.max(inventory.damagedFiles.length, inventory.unavailableBackups.size, inventory.blockedBackups.size), `Cannot delete local backup files while the container has damaged files or unavailable backups. ${unavailable ?? "Recover the reported files or import their recovery keys before retrying."}`)
      }
      const entry = inventory.entries.get(name)
      if (!entry) throw new BlobNotFoundError(name)
      try {
        const files = readdirSync(dir).filter((file) => file.endsWith(EXT))
        if (files.length !== inventory.files.size || files.some((file) => inventory.files.get(file) !== fileState(lstatSync(join(dir, file))))) {
          throw new Error("Inventory changed")
        }
        if (inventory.files.get(entry.file) !== fileState(lstatSync(join(dir, entry.file)))) throw new Error("Target changed")
      } catch {
        throw new IncompleteInventoryError(1, "Cannot delete local backup files because files changed during the fresh inventory check. Finish folder sync and retry.")
      }
      // Validate every scanned file, including the exact target's identity, size and times,
      // then unlink without an async yield where another app request could change the folder.
      unlinkSync(join(dir, entry.file))
    } finally {
      this.index.delete(dir)
    }
  }

  private dir(account: string, container: string): string {
    return join(this.root, safeSegment(account), safeSegment(container))
  }

  private damagedFor(inventory: Inventory, account: string, container: string, name: string): DamagedFile[] {
    const candidates = new Set(this.keyring.flatMap((keys) => ([1, 2] as const).map((version) => fileName(version, keys.naming, account, container, name))))
    return inventory.damagedFiles.filter((file) => file.name === name || candidates.has(file.file))
  }

  /**
   * Every listing rereads the container's inventory from disk, so it shows files changed by anything
   * else. A listing made while a reread runs waits for it and shares the next reread with the other
   * listings made meanwhile: each still sees the files as they were when it was made, but listings
   * made together (the backup list makes one per backup) no longer each decrypt every header.
   */
  private reread(account: string, container: string): Promise<Inventory> {
    const dir = this.dir(account, container)
    const pending = this.rereads.get(dir)
    if (pending && !pending.started) return pending.entries
    const running = pending?.entries.catch(() => undefined)
    const reread = { started: false, entries: Promise.resolve(emptyInventory()) }
    reread.entries = (async () => {
      await running
      reread.started = true
      this.index.delete(dir)
      return this.entries(account, container)
    })()
    this.rereads.set(dir, reread)
    void reread.entries.catch(() => undefined).then(() => {
      if (this.rereads.get(dir) === reread) this.rereads.delete(dir)
    })
    return reread.entries
  }

  /** Authenticates every file once per container; later calls use the cache. */
  private entries(account: string, container: string): Promise<Inventory> {
    const dir = this.dir(account, container)
    let cached = this.index.get(dir)
    if (!cached) {
      cached = this.readIndex(dir, account, container)
      this.index.set(dir, cached)
      cached.catch(() => this.index.delete(dir))
    }
    return cached
  }

  private async readIndex(dir: string, account: string, container: string): Promise<Inventory> {
    const inventory = emptyInventory()
    const { entries, damagedFiles, unavailableBackups } = inventory
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(EXT)).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return inventory
      throw error
    }
    const metadataBodies = new Map<string, Buffer>()
    const read = await mapLimit(files, HEADER_CONCURRENCY, async (file): Promise<Entry | DamagedFile> => {
      const path = join(dir, file)
      let handle: Awaited<ReturnType<typeof open>> | undefined
      let name: string | undefined
      inventory.files.set(file, null)
      try {
        handle = await open(path, "r")
        const info = await handle.stat()
        inventory.files.set(file, fileState(info))
        const raw = await handle.readFile()
        const prefixLength = MAGIC_LENGTH + 2
        if (raw.length < prefixLength) throw new Error("Truncated backup header")
        const version = versionOf(raw.subarray(0, MAGIC_LENGTH))
        if (!version) throw new Error("Invalid backup header")
        const headerLength = raw.readUInt16BE(MAGIC_LENGTH)
        const sealed = raw.subarray(prefixLength, prefixLength + headerLength)
        if (headerLength < IV + TAG || sealed.length !== headerLength) throw new Error("Truncated backup header")
        const header = JSON.parse(this.decrypt(sealed, headerAad(version, account, container, file)).toString()) as {
          name: string
          contentType: string
          created: string
        }
        if (!header || typeof header.name !== "string" || !header.name || typeof header.contentType !== "string" || !Number.isFinite(Date.parse(header.created))) {
          throw new Error("Invalid backup header")
        }
        name = header.name
        const body = raw.subarray(prefixLength + headerLength)
        if (body.length < IV + TAG) throw new Error("Truncated backup body")
        let plain: Buffer
        try {
          plain = this.decrypt(body, bodyAad(version, account, container, name))
        } catch {
          throw new Error("Backup body could not be decrypted or authenticated")
        }
        if (container === "intune-backups" && /^backup-[^/]+\/metadata\.json$/.test(name)) metadataBodies.set(file, plain)
        return {
          file,
          version,
          name: header.name,
          contentType: header.contentType,
          created: new Date(header.created),
          lastModified: info.mtime,
          size: body.length - IV - TAG,
        }
      } catch (error) {
        return { file, name, reason: error instanceof Error ? error.message : String(error) }
      } finally {
        await handle?.close()
      }
    })
    const counts = new Map<string, number>()
    for (const entry of read) {
      if (entry.name) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1)
    }
    for (const entry of read) {
      if (entry.name && counts.get(entry.name)! > 1) damagedFiles.push({ file: entry.file, name: entry.name, reason: "Duplicate blob name" })
      else if ("reason" in entry) damagedFiles.push(entry)
      else entries.set(entry.name, entry)
    }
    // An authenticated manifest blocks only its backup's downloads and restores.
    for (const entry of entries.values()) {
      if (container !== "intune-backups" || !/^backup-[^/]+\/metadata\.json$/.test(entry.name)) continue
      const backup = entry.name.split("/")[0]!
      try {
        const metadata = JSON.parse(metadataBodies.get(entry.file)!.toString())
        if (metadata?.Items === undefined) continue // Legacy backups have no inventory manifest.
        if (!metadata.Items || typeof metadata.Items !== "object" || Array.isArray(metadata.Items)) throw new Error("Invalid backup inventory manifest")
        const prefix = entry.name.slice(0, -"metadata.json".length)
        let missing = 0
        const names: string[] = []
        for (const [key, item] of Object.entries(metadata.Items)) {
          const folder = key.split("/")[0]
          const file = (item as { file?: unknown } | null)?.file
          if (!folder || typeof file !== "string" || !file || file.includes("/") || file.includes("\\")) throw new Error("Invalid backup inventory manifest")
          names.push(`${prefix}${folder}/${file}`)
        }
        for (const name of names) {
          // A readable manifest and the keyed file name can attribute an unreadable header.
          if (damagedFiles.some((file) => !file.name)) {
            for (const damaged of this.damagedFor(inventory, account, container, name)) {
              if (!damaged.name) damaged.name = name
            }
          }
          if (!entries.has(name)) missing++
        }
        if (missing) throw new Error(`Backup inventory is incomplete: ${missing} file(s) listed in the manifest are missing or damaged. Recover the missing files before downloading or restoring.`)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        unavailableBackups.set(backup, reason)
        inventory.blockedBackups.set(backup, reason)
      }
    }
    for (const damaged of damagedFiles) {
      const backup = damaged.name?.split("/")[0]
      if (container === "intune-backups" && backup?.startsWith("backup-") && !unavailableBackups.has(backup)) unavailableBackups.set(backup, `Backup is unavailable: ${damaged.file}: ${damaged.reason}. Recover the file or import its recovery key before downloading or restoring.`)
    }
    return inventory
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
