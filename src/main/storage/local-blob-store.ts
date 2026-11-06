import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { link, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { BACKUP_CONTAINER, BACKUP_OWNER_FILE } from "../../shared/constants"
import { mapLimit } from "../../shared/map-limit"

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
 *
 * Damaged files. In the backup container, a file that cannot be read (damaged, truncated, or
 * encrypted with a key this device does not have) or a second file for the same blob does not
 * block the healthy backups. Damage that can be traced to a backup (its folder's manifest or
 * ownership marker, a manifest item, or a duplicate's name) makes only that backup unavailable:
 * its listing and reads fail with IncompleteInventoryError. Damage that cannot be traced makes
 * every backup without a manifest unavailable, since none of them can be checked. While any
 * damage is present nothing in the container is deleted, so retention never removes a copy that
 * may be needed. Damaged files are left in place for recovery. Other containers still fail
 * closed: one unreadable file stops every listing and read.
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
/** An If-Match ETag no longer matches the stored blob. */
export class BlobConditionNotMetError extends Error {}

export class IncompleteInventoryError extends Error {
  /** The backup folder that is unavailable, when the error is about one backup. */
  backup?: string
  constructor(readonly unreadableFiles: number, message?: string) {
    super(message ?? `Backup inventory is incomplete: ${unreadableFiles} encrypted file(s) could not be read. Import the correct recovery keys or recover damaged files before continuing.`)
  }
}

/** A file in the backup container that could not be used. */
export interface DamagedFile {
  /** The encrypted file name on disk. */
  file: string
  reason: string
  /** The backup folder the file belongs to, or null when it cannot be traced. */
  backup: string | null
}

/** Damage found while reading the backup container's inventory. */
export interface InventoryDamage {
  files: DamagedFile[]
  /** Backup folders (without the trailing slash) that cannot be used, with the reason. */
  unavailable: Map<string, string>
  /** Damaged files that could not be traced to a backup. */
  unattributed: number
}

const RECOVERY = "Import the recovery key it was made with, or restore the damaged files from a copy. Files that cannot be recovered can be removed from the backup folder."

/** Thrown by decrypt when no key in the keyring opens the data, damaged data included. */
const WRONG_KEY = "This backup was encrypted with a key this device does not have. Import its recovery key."

/** Why a file could not be read. */
class Unreadable {
  constructor(readonly reason: string) {}
}

function unreadableReason(error: unknown): string {
  if (error instanceof Error && error.message === WRONG_KEY) return "it is damaged, or was encrypted with a key this device does not have"
  const code = (error as NodeJS.ErrnoException)?.code
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return `it could not be read (${code})`
  return "it is damaged or incomplete"
}

/** Damaged files named in a message at most. */
export const MAX_NAMED_FILES = 10

const backupFolderOf = (name: string) => /^(backup-[^/]+)\//.exec(name)?.[1] ?? null

/** One sentence on the damage in a container, for messages. */
function describeDamage(damage: InventoryDamage): string {
  const files = damage.files.length
  const backups = damage.unavailable.size
  const parts = [
    ...(files ? [`${files} file${files === 1 ? "" : "s"} in the backup folder could not be read`] : []),
    ...(backups ? [`${backups} backup${backups === 1 ? " is" : "s are"} unavailable`] : []),
  ]
  return `${parts.join(" and ")}.`
}

/** The damage in a container in a few sentences, or null when there is none. */
export function damageSummary(damage: InventoryDamage): string | null {
  if (damage.files.length === 0 && damage.unavailable.size === 0) return null
  const reasons = [...new Set(damage.files.map((file) => file.reason))]
  const backups = [...damage.unavailable].slice(0, 3).map(([folder, reason]) => `${folder}: ${reason}`)
  return [
    describeDamage(damage),
    ...(reasons.length ? [`${reasons.length === 1 ? "Reason" : "Reasons"}: ${reasons.join("; ")}.`] : []),
    ...backups,
    ...(damage.unavailable.size > 3 ? [`And ${damage.unavailable.size - 3} more.`] : []),
  ].join(" ")
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
  private readonly generations = new Map<string, number>()
  private readonly writes = new Map<string, number>()
  private readonly rebuilding = new Map<string, Promise<Map<string, Entry>>>()
  private readonly checks = new Map<string, { generation: number; started: boolean; entries: Promise<Map<string, Entry>> }>()
  /** Cleared once the folder's file system refuses a hard link. */
  private hardLinks = true
  private readonly blobWrites = new Map<string, Promise<void>>()
  /** Damage found by the read that built each inventory. */
  private readonly damageOf = new WeakMap<Map<string, Entry>, InventoryDamage>()
  /** File names derived for traced blob names; see fileNames. */
  private readonly fileNameCache = new Map<string, string[]>()
  /** Stamps of the damaged files of each inventory, so a repaired or removed file is noticed. */
  private readonly damagedStamps = new WeakMap<Map<string, Entry>, Map<string, string>>()

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
    const dir = this.dir(account, container)
    await mkdirDurable(dir)
    if (!existed && !this.index.has(dir)) {
      // A container we just created starts with a known empty inventory.
      this.directoryStamps.set(dir, await this.directoryStamp(dir))
      this.index.set(dir, Promise.resolve(new Map()))
      this.changed(dir)
    }
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
    const folder = backupFolderOf(prefix)
    if (folder) this.assertAvailable(entries, folder)
    return [...entries.values()].filter((entry) => entry.name.startsWith(prefix))
      .map(({ file: _file, version: _version, stamp: _stamp, ...blob }) => blob).sort((a, b) => (a.name < b.name ? -1 : 1))
  }

  /** Damage in the container's current inventory; empty when there is none. */
  async damage(account: string, container: string): Promise<InventoryDamage> {
    const entries = await this.checkedEntries(account, container)
    return this.damageOf.get(entries) ?? { files: [], unavailable: new Map(), unattributed: 0 }
  }

  /** Every file name a blob can have, for each key and format. Remembered, since each takes an HMAC per key. */
  private fileNames(account: string, container: string, name: string): string[] {
    const key = JSON.stringify([account, container, name])
    let names = this.fileNameCache.get(key)
    if (!names) {
      names = this.keyring.flatMap((keys) => ([1, 2] as const).map((version) => fileName(version, keys.naming, account, container, name)))
      if (this.fileNameCache.size >= FILE_NAME_CACHE_LIMIT) this.fileNameCache.clear()
      this.fileNameCache.set(key, names)
    }
    return names
  }

  private assertAvailable(entries: Map<string, Entry>, folder: string): void {
    const damage = this.damageOf.get(entries)
    const reason = damage?.unavailable.get(folder)
    if (!damage || !reason) return
    const files = damage.files.filter((file) => file.backup === folder).map((file) => file.file)
    const named = files.length ? ` Affected file${files.length === 1 ? "" : "s"} in the backup folder: ${files.slice(0, MAX_NAMED_FILES).join(", ")}${files.length > MAX_NAMED_FILES ? `, and ${files.length - MAX_NAMED_FILES} more` : ""}.` : ""
    throw Object.assign(new IncompleteInventoryError(damage.files.length, `Backup ${folder} is unavailable: ${reason}${named} ${RECOVERY}`), { backup: folder })
  }

  /** A blob that is not in the inventory may be in a file that could not be traced, so it is not reported as missing then. */
  private missing(entries: Map<string, Entry>, name: string): Error {
    const damage = this.damageOf.get(entries)
    if (!damage?.unattributed) return new BlobNotFoundError(name)
    return new IncompleteInventoryError(damage.files.length, `${name} could not be found, and ${damage.unattributed} file${damage.unattributed === 1 ? "" : "s"} in the backup folder could not be read, so it may be in one of them. ${RECOVERY}`)
  }

  async get(account: string, container: string, name: string): Promise<{ blob: StoredBlob; data: Buffer }> {
    const dir = this.dir(account, container)
    let entries = this.dirty.has(dir) ? await this.checkedEntries(account, container) : await this.entries(account, container)
    let entry = entries.get(name)
    const folder = backupFolderOf(name)
    if (folder) this.assertAvailable(entries, folder)
    if (!entry) throw this.missing(entries, name)
    // A selective read checks its own file. Listings still verify every cached header,
    // and directory changes or our own writes still validate the complete manifest.
    let unchanged = false
    try { unchanged = fileStamp(await stat(join(dir, entry.file), { bigint: true })) === entry.stamp } catch { /* Rebuild missing or replaced files. */ }
    if (!unchanged) {
      this.changed(dir)
      this.index.delete(dir)
      entries = await this.checkedEntries(account, container)
      if (folder) this.assertAvailable(entries, folder)
      entry = entries.get(name)
      if (!entry) throw this.missing(entries, name)
    }
    const raw = await readFile(join(this.dir(account, container), entry.file))
    const version = versionOf(raw.subarray(0, MAGIC_LENGTH))
    if (!version) throw new Error("Invalid backup header")
    const headerLength = raw.readUInt16BE(MAGIC_LENGTH)
    const body = raw.subarray(MAGIC_LENGTH + 2 + headerLength)
    const { file: _file, version: _version, stamp: _stamp, ...blob } = entry
    try {
      return { blob, data: this.decrypt(body, bodyAad(version, account, container, name)) }
    } catch (error) {
      // Inventories check headers only, so a damaged body is found when it is read. Retrying cannot repair it.
      throw new IncompleteInventoryError(1, `${name} could not be read: ${unreadableReason(error)}. ${RECOVERY}`)
    }
  }

  /**
   * Writes one blob. Conditional writes (`ifMatch` with an ETag, or `*` for any
   * existing blob) to the same blob run one at a time, so the check holds until the
   * write is published. Unconditional writes are not ordered against them.
   */
  put(account: string, container: string, name: string, data: Uint8Array, contentType: string, createOnly = false, metadata?: Record<string, string>, ifMatch?: string): Promise<StoredBlob> {
    if (ifMatch === undefined) return this.putNow(account, container, name, data, contentType, createOnly, metadata, undefined)
    const key = `${this.dir(account, container)}\0${name}`
    const run = (this.blobWrites.get(key) ?? Promise.resolve()).then(() => this.putNow(account, container, name, data, contentType, createOnly, metadata, ifMatch))
    const tail = run.then(() => undefined, () => undefined)
    this.blobWrites.set(key, tail)
    void tail.then(() => { if (this.blobWrites.get(key) === tail) this.blobWrites.delete(key) })
    return run
  }

  private async putNow(account: string, container: string, name: string, data: Uint8Array, contentType: string, createOnly: boolean, metadata: Record<string, string> | undefined, ifMatch: string | undefined): Promise<StoredBlob> {
    if (!(await this.containerExists(account, container))) throw new BlobNotFoundError(container)
    const entries = await this.entries(account, container)
    const current = this.keyring[0]!
    const existing = entries.get(name)
    if (createOnly && existing) throw new BlobAlreadyExistsError(name)
    if (ifMatch !== undefined) {
      // Compare with the file on disk, which is what a GET returns as the ETag.
      let tag: string | null = null
      if (existing) {
        try { tag = `"${fileStamp(await stat(join(this.dir(account, container), existing.file), { bigint: true }))}"` } catch { /* Removed since listed. */ }
      }
      if (!tag || (ifMatch !== "*" && ifMatch !== tag)) throw new BlobConditionNotMetError(name)
    }
    // A version 1 file keeps its name when overwritten, so the blob never has two files.
    const version = this.writeFormat
    const file = existing?.file ?? fileName(version, current.naming, account, container, name)
    const created = existing?.created ?? new Date()

    const header = seal(current.encryption, Buffer.from(JSON.stringify({ name, contentType, created, ...(metadata ? { metadata } : {}) })), headerAad(version, account, container, file))
    const body = seal(current.encryption, Buffer.from(data), bodyAad(version, account, container, name))
    const length = Buffer.alloc(2)
    length.writeUInt16BE(header.length)

    const dir = this.dir(account, container)
    return this.write(dir, async () => {
      const path = join(dir, file)
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`
      let written: BigIntStats
      try {
        const handle = await open(tmp, "wx", 0o600)
        try {
          await handle.writeFile(Buffer.concat([version === 1 ? MAGIC_V1 : MAGIC_V2, length, header, body]))
          await handle.sync()
          written = await handle.stat({ bigint: true })
        } finally {
          await handle.close()
        }
        if (createOnly) await this.publishNew(tmp, path)
        else await rename(tmp, path)
        this.changed(dir)
        if (process.platform !== "win32") await syncDirectory(dir)
      } catch (error) {
        if (createOnly && (error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new BlobAlreadyExistsError(name)
        }
        throw error
      } finally {
        await rm(tmp, { force: true })
      }

      const published = await stat(path, { bigint: true })
      const sameFile = published.dev === written.dev && published.ino === written.ino && published.size === written.size && published.mtimeNs === written.mtimeNs
      // Rename can change ctime. Use its final stamp only after verifying the written file's identity.
      const info = sameFile ? published : written
      const stamp = fileStamp(info)
      const blob: StoredBlob = { name, size: data.byteLength, contentType, created, lastModified: info.mtime, etag: `"${stamp}"`, ...(metadata ? { metadata } : {}) }
      if (sameFile) this.updateEntry(dir, entries, name, { ...blob, file, version, stamp })
      else {
        // Keep the replacement's authenticated filename and metadata for the next mutation.
        const replacement = await this.readEntry(dir, account, container, file)
        if (replacement !== VANISHED && !(replacement instanceof Unreadable) && replacement.name === name) this.updateEntry(dir, entries, name, replacement)
        else this.index.delete(dir)
        this.changed(dir)
      }
      return blob
    })
  }

  /**
   * Deletes one blob. Nothing in the backup container is deleted while it holds damaged files or
   * an unavailable backup: a damaged file may be the only copy of what an older backup holds.
   * The check uses the cached inventory, which a new or removed file always refreshes. Retention
   * lists the folder right before it deletes, and a listing checks every file's stamp, so a file
   * damaged in place is found then. despiteDamage is for removing files the caller has just
   * written itself, such as an archive import that is rolled back.
   */
  async delete(account: string, container: string, name: string, options: { despiteDamage?: boolean } = {}): Promise<void> {
    const entries = await this.entries(account, container)
    const damage = this.damageOf.get(entries)
    if (!options.despiteDamage && damage && (damage.files.length > 0 || damage.unavailable.size > 0)) {
      throw new IncompleteInventoryError(damage.files.length, `${describeDamage(damage)} Nothing in the backup folder is deleted until this is resolved, so older backups are kept. ${RECOVERY}`)
    }
    const entry = entries.get(name)
    if (!entry) throw new BlobNotFoundError(name)
    const dir = this.dir(account, container)
    await this.write(dir, async () => {
      await rm(join(dir, entry.file), { force: true })
      this.changed(dir)
      this.updateEntry(dir, entries, name)
    })
  }

  /**
   * Publishes a complete temporary file under a name that must not exist yet. A hard link does
   * both atomically across store and process instances. File systems without hard links (exFAT,
   * FAT32, some network shares) claim the name with an exclusive create instead, so a second
   * writer still fails with EEXIST, then rename the complete file over the empty claim. Readers
   * skip an empty file, so the claim is never reported as unreadable. A claim left behind by a
   * crash is taken over once it is older than STALE_CLAIM_MS.
   */
  private async publishNew(tmp: string, path: string): Promise<void> {
    try {
      await this.createNew(tmp, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await this.removeStaleClaim(path))) throw error
      await this.createNew(tmp, path)
    }
  }

  private async createNew(tmp: string, path: string): Promise<void> {
    if (this.hardLinks) {
      try {
        await link(tmp, path)
        return
      } catch (error) {
        if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? "")) throw error
        this.hardLinks = false
      }
    }
    await (await open(path, "wx", 0o600)).close()
    try {
      await rename(tmp, path)
    } catch (error) {
      await rm(path, { force: true })
      throw error
    }
  }

  /**
   * Removes an empty claim that no writer finished, and returns whether it did. The claim is moved
   * aside first, so of several writers taking over the same claim only one moves it; a file that
   * turns out not to be that claim is put back.
   */
  private async removeStaleClaim(path: string): Promise<boolean> {
    try {
      const claim = await stat(path, { bigint: true })
      if (claim.size !== 0n || Date.now() - Number(claim.mtimeMs) < STALE_CLAIM_MS) return false
      const aside = `${path}.${randomBytes(4).toString("hex")}.stale`
      await rename(path, aside)
      const moved = await stat(aside, { bigint: true })
      if (moved.ino !== claim.ino || moved.size !== 0n) {
        await rename(aside, path)
        return false
      }
      await rm(aside, { force: true })
      return true
    } catch {
      return false
    }
  }

  /** Own directory mutations update the cache without making the next put rebuild it. */
  private async write<T>(dir: string, run: () => Promise<T>): Promise<T> {
    this.writes.set(dir, (this.writes.get(dir) ?? 0) + 1)
    this.changed(dir)
    try {
      const result = await run()
      let generation: number, stamp: string
      do {
        generation = this.generations.get(dir) ?? 0
        stamp = await this.directoryStamp(dir)
      } while ((this.generations.get(dir) ?? 0) !== generation)
      this.directoryStamps.set(dir, stamp)
      // Keep the inventory dirty: this stamp may include an external mutation, so
      // the next read/list must still reconcile membership and validate manifests.
      this.changed(dir)
      return result
    } catch (error) {
      this.changed(dir)
      this.index.delete(dir)
      throw error
    } finally {
      const remaining = this.writes.get(dir)! - 1
      if (remaining) this.writes.set(dir, remaining)
      else this.writes.delete(dir)
    }
  }

  private updateEntry(dir: string, entries: Map<string, Entry>, name: string, entry?: Entry): void {
    const update = (current: Map<string, Entry>) => { if (entry) current.set(name, entry); else current.delete(name) }
    update(entries)
    // A listing may have started another index while the write was publishing.
    // Update it when ready without making publication wait for that listing.
    void this.index.get(dir)?.then(update).catch(() => undefined)
  }

  private dir(account: string, container: string): string {
    return join(this.root, safeSegment(account), safeSegment(container))
  }

  private async directoryStamp(dir: string): Promise<string> {
    try {
      const info = await stat(dir, { bigint: true })
      return fileStamp(info)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
      throw error
    }
  }

  /** Coalesces checks requested together; later listings wait for a fresh membership and file check. */
  private checkedEntries(account: string, container: string): Promise<Map<string, Entry>> {
    const dir = this.dir(account, container)
    const generation = this.generations.get(dir) ?? 0
    const pending = this.checks.get(dir)
    if (pending?.generation === generation && !pending.started) return pending.entries
    // An invalidated check must not delay or supply a read from the new generation.
    const running = pending?.generation === generation ? pending.entries.catch(() => undefined) : undefined
    const check = { generation, started: false, entries: Promise.resolve(new Map<string, Entry>()) }
    check.entries = (async () => {
      await running
      if ((this.generations.get(dir) ?? 0) !== generation) return this.checkedEntries(account, container)
      check.started = true
      try {
        let entries = await this.entries(account, container)
        const files = new Set(await this.files(dir))
        // Directory stamps can be coarse on a shared folder, so always reconcile names.
        // Damaged files count too, so a file that is repaired, replaced or removed is read again.
        const damaged = this.damagedStamps.get(entries) ?? new Map<string, string>()
        const known = new Map<string, string>([...damaged, ...[...entries.values()].map((entry): [string, string] => [entry.file, entry.stamp])])
        const sameFiles = files.size === known.size && [...known.keys()].every(file => files.has(file))
        const unchanged = !this.dirty.has(dir) && sameFiles && (await mapLimit([...known], HEADER_CONCURRENCY, async ([file, stamp]) => {
          try { return fileStamp(await stat(join(dir, file), { bigint: true })) === stamp } catch { return false }
        })).every(Boolean)
        if ((this.generations.get(dir) ?? 0) !== generation) return this.checkedEntries(account, container)
        if (!unchanged) {
          this.index.delete(dir)
          entries = await this.entries(account, container, entries)
        }
        return (this.generations.get(dir) ?? 0) === generation ? entries : this.checkedEntries(account, container)
      } catch (error) {
        if ((this.generations.get(dir) ?? 0) !== generation) return this.checkedEntries(account, container)
        throw error
      }
    })()
    this.checks.set(dir, check)
    void check.entries.finally(() => { if (this.checks.get(dir) === check) this.checks.delete(dir) }).catch(() => undefined)
    return check.entries
  }

  /** Reuses headers across own writes; external directory changes still rebuild the inventory. */
  private async entries(account: string, container: string, reuse?: Map<string, Entry>): Promise<Map<string, Entry>> {
    const dir = this.dir(account, container)
    const generation = this.generations.get(dir) ?? 0
    const stamp = await this.directoryStamp(dir)
    if ((this.generations.get(dir) ?? 0) !== generation) return this.entries(account, container, reuse)
    const previous = reuse ?? this.index.get(dir)
    if (!this.writes.has(dir) && !this.rebuilding.has(dir) && this.directoryStamps.get(dir) !== stamp) this.index.delete(dir)
    let cached = this.index.get(dir)
    if (!cached) {
      cached = this.readIndex(dir, account, container, previous).then(entries => {
        if (this.index.get(dir) === cached) {
          if ((this.generations.get(dir) ?? 0) === generation) {
            this.directoryStamps.set(dir, stamp)
            this.dirty.delete(dir)
          } else this.dirty.add(dir)
        }
        return entries
      }).finally(() => { if (this.rebuilding.get(dir) === cached) this.rebuilding.delete(dir) })
      this.rebuilding.set(dir, cached)
      this.index.set(dir, cached)
      const current = cached
      void cached.catch(() => { if (this.index.get(dir) === current) this.index.delete(dir) })
    }
    return cached
  }

  private changed(dir: string): void {
    this.generations.set(dir, (this.generations.get(dir) ?? 0) + 1)
    this.dirty.add(dir)
  }

  private async files(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((f) => f.endsWith(EXT))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }

  /**
   * Returns Unreadable for a file that cannot be read, and VANISHED for one removed since it was listed
   * or an empty file. Every blob file has a header, so an empty one is a create-only claim that a
   * writer is about to fill or never finished (see publishNew), not a damaged blob.
   */
  private async readEntry(dir: string, account: string, container: string, file: string): Promise<Entry | Unreadable | typeof VANISHED> {
    const path = join(dir, file)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, "r")
      const prefix = Buffer.alloc(MAGIC_LENGTH + 2)
      const prefixRead = await handle.read(prefix, 0, prefix.length, 0)
      if (prefixRead.bytesRead === 0 && (await handle.stat()).size === 0) return VANISHED
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
      const info = await handle.stat({ bigint: true })
      if (Number(info.size) < prefix.length + headerLength + IV + TAG) throw new Error("Truncated backup body")
      return {
        file,
        version,
        name: header.name,
        contentType: header.contentType,
        created: new Date(header.created),
        lastModified: info.mtime,
        size: Number(info.size) - prefix.length - headerLength - IV - TAG,
        stamp: fileStamp(info),
        etag: `"${fileStamp(info)}"`,
        ...(header.metadata ? { metadata: header.metadata } : {}),
      }
    } catch (error) {
      return isMissing(error) ? VANISHED : new Unreadable(unreadableReason(error))
    } finally {
      await handle?.close()
    }
  }

  private async readIndex(dir: string, account: string, container: string, previous?: Map<string, Entry> | Promise<Map<string, Entry>>): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>()
    const files = await this.files(dir)
    const cached = await Promise.resolve(previous).catch(() => undefined)
    const byFile = new Map([...(cached?.values() ?? [])].map(entry => [entry.file, entry]))
    // Headers are read a few at a time and added in directory order, so duplicates are found as before.
    // The stamp of each file before its header is read: a damaged file is remembered by it, so a
    // file still being written when it was read is read again once it changes.
    const before = new Map<string, string>()
    const read = await mapLimit(files, HEADER_CONCURRENCY, async (file): Promise<Entry | Unreadable | typeof VANISHED> => {
      try {
        const stamp = fileStamp(await stat(join(dir, file), { bigint: true }))
        before.set(file, stamp)
        const cached = byFile.get(file)
        if (cached && stamp === cached.stamp) return cached
        return this.readEntry(dir, account, container, file)
      } catch (error) {
        return isMissing(error) ? VANISHED : new Unreadable(unreadableReason(error))
      }
    })
    const unreadable: Array<{ file: string; reason: string }> = []
    // Every file that claims a blob another file also claims: none of them can be trusted.
    const claims = new Map<string, string[]>()
    for (const [index, entry] of read.entries()) {
      // A file removed since the listing (retention, another device) is simply gone, and an empty claim holds no blob yet.
      if (entry === VANISHED) continue
      if (entry instanceof Unreadable) {
        unreadable.push({ file: files[index]!, reason: entry.reason })
        continue
      }
      const first = entries.get(entry.name)
      if (first || claims.has(entry.name)) {
        claims.set(entry.name, [...(claims.get(entry.name) ?? [first!.file]), entry.file])
        entries.delete(entry.name)
        continue
      }
      entries.set(entry.name, entry)
    }
    // Other containers fail closed, as the backup container did before damage could be traced.
    if (container !== BACKUP_CONTAINER) {
      const count = unreadable.length + [...claims.values()].reduce((sum, list) => sum + list.length, 0)
      if (count) throw new IncompleteInventoryError(count)
      return entries
    }

    const damage: InventoryDamage = { files: [], unavailable: new Map(), unattributed: 0 }
    const unavailable = (folder: string, reason: string) => { if (!damage.unavailable.has(folder)) damage.unavailable.set(folder, reason) }
    for (const [name, claimed] of claims) {
      const folder = backupFolderOf(name)
      for (const file of claimed) damage.files.push({ file, reason: "another file holds the same backup item", backup: folder })
      if (folder) unavailable(folder, "two files hold the same backup item.")
      else damage.unattributed += claimed.length
    }

    // Blob names whose files can be traced to a backup folder, by the encrypted file name they would have.
    const folders = new Set([...entries.keys(), ...claims.keys()].map(backupFolderOf).filter((folder) => folder !== null))
    const traced = new Map<string, string>()
    for (const folder of folders) traced.set(`${folder}/metadata.json`, folder).set(`${folder}/${BACKUP_OWNER_FILE}`, folder)
    const withManifest = new Set<string>()
    // Folders whose metadata.json has no item list (backups from versions before the manifest).
    const legacy = new Set<string>()

    // Desktop metadata already contains a per-item manifest. Check it before
    // exposing any inventory to downloads or restores, including selective reads.
    for (const entry of entries.values()) {
      if (!/^backup-[^/]+\/metadata\.json$/.test(entry.name)) continue
      const folder = backupFolderOf(entry.name)!
      let metadata: { Items?: unknown }
      try {
        const raw = await readFile(join(dir, entry.file))
        const body = raw.subarray(MAGIC_LENGTH + 2 + raw.readUInt16BE(MAGIC_LENGTH))
        metadata = JSON.parse(this.decrypt(body, bodyAad(entry.version, account, container, entry.name)).toString())
      } catch (error) {
        // A manifest removed since the listing no longer describes a backup.
        if (isMissing(error)) { entries.delete(entry.name); continue }
        damage.files.push({ file: entry.file, reason: unreadableReason(error), backup: folder })
        unavailable(folder, "its manifest (metadata.json) could not be read.")
        continue
      }
      if (metadata?.Items === undefined) { legacy.add(folder); continue } // Legacy backups have no inventory manifest.
      if (!metadata.Items || typeof metadata.Items !== "object" || Array.isArray(metadata.Items)) {
        unavailable(folder, "its manifest (metadata.json) is not valid.")
        continue
      }
      const prefix = `${folder}/`
      let missing = 0
      let valid = true
      for (const [key, item] of Object.entries(metadata.Items)) {
        const type = key.split("/")[0]
        const file = (item as { file?: unknown } | null)?.file
        if (!type || typeof file !== "string" || !file || file.includes("/") || file.includes("\\")) { valid = false; break }
        const name = `${prefix}${type}/${file}`
        traced.set(name, folder)
        if (!entries.has(name)) missing++
      }
      if (!valid) unavailable(folder, "its manifest (metadata.json) is not valid.")
      else if (missing) unavailable(folder, `${missing} file${missing === 1 ? "" : "s"} listed in its manifest ${missing === 1 ? "is" : "are"} missing or damaged.`)
      else withManifest.add(folder)
    }

    if (unreadable.length) {
      const byFileName = new Map<string, string>()
      for (const [name, folder] of traced) {
        for (const file of this.fileNames(account, container, name)) byFileName.set(file, folder)
      }
      for (const { file, reason } of unreadable) {
        const folder = byFileName.get(file) ?? null
        damage.files.push({ file, reason, backup: folder })
        if (folder) unavailable(folder, `one of its files could not be read: ${reason}.`)
        else damage.unattributed++
      }
    }
    // A file that cannot be traced may belong to any finished backup whose files cannot be checked
    // against a manifest. A folder without metadata.json is still being written or stopped early,
    // and is already shown as running or incomplete; a backup writing to it must be able to read
    // back what it wrote.
    if (damage.unattributed > 0) {
      for (const folder of legacy) unavailable(folder, "files in the backup folder could not be read, and this backup has no manifest to show that none of them are its own.")
    }
    this.damageOf.set(entries, damage)
    this.damagedStamps.set(entries, new Map(damage.files.map(({ file }) => [file, before.get(file) ?? "missing"])))
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
    throw new Error(WRONG_KEY)
  }
}

/** Errors of a file system that has no hard links. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])

/** Derived file names remembered at most, so a very large folder does not grow the cache without bound. */
const FILE_NAME_CACHE_LIMIT = 200_000

/** Age after which an empty create-only claim counts as left behind by a writer that stopped. */
const STALE_CLAIM_MS = 60_000

/** Marks a listed file that was removed before it could be read, or an empty claim. */
const VANISHED = Symbol("vanished")

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

/** Keeps account and container names inside the root folder. */
function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9-]/g, "_")
  if (!safe || safe === "." || safe === "..") throw new Error(`Invalid storage name: ${value}`)
  return safe
}

/** BigInt stats keep the full inode and nanosecond times, so a replaced file never shares a stamp with the old one. */
function fileStamp(info: BigIntStats): string {
  return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}
