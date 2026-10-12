import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const APP_STATE_START_OVER_DETAIL = "Your saved data is kept as an unreadable backup copy. Starting over deletes the backup encryption key from TenuVault, along with your sign-ins and license. Existing local and Azure backups become unreadable unless you exported their recovery key. To export it first, choose Quit, restore access to the saved data, then open Settings > Storage and recovery > Save recovery key. If you already exported it, use Import a recovery key in the same Settings section after starting over. Sign in to your tenants and activate your license again."
export const APP_STATE_START_OVER_BUTTON = "Delete backup key and start over"

/** Syncs a directory so its entries survive a crash; a failure is logged, since the data itself is already written. */
function syncDirectorySync(dir: string): void {
  try {
    const directory = openSync(dir, "r")
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch (error) {
    console.warn(`Failed to sync directory ${dir}: ${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}`)
  }
}

/** Creates a directory and syncs the parent of every directory it had to create, so the new entries survive a crash. */
function mkdirDurableSync(path: string): void {
  const created: string[] = []
  for (let probe = path; !existsSync(probe); probe = dirname(probe)) {
    created.unshift(probe)
    if (dirname(probe) === probe) break
  }
  mkdirSync(path, { recursive: true })
  if (process.platform === "win32") return
  for (const dir of created) syncDirectorySync(dirname(dir))
}

export interface Cipher {
  encrypt: (plainText: string) => Buffer
  decrypt: (cipherText: Buffer) => string
}

/** The synchronous key/value interface SecureStore offers, for code that only reads and writes values. */
export interface KeyValueStore {
  get: (key: string) => string | null
  set: (key: string, value: string) => void
  delete: (key: string) => void
  /** Atomically persists every value or throws without changing any persisted value. */
  setMany?: (values: Record<string, string>) => void
  keys?: () => string[]
}

/** The store file exists but cannot be decrypted or parsed. */
export class UnreadableStoreError extends Error {
  constructor(
    readonly filePath: string,
    cause: unknown,
  ) {
    super(`Cannot read ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "UnreadableStoreError"
  }
}

/**
 * Small key/value store persisted as a single encrypted file.
 *
 * In the app the cipher is Electron `safeStorage` (DPAPI on Windows, Keychain on macOS),
 * so tenant profiles, license state and MSAL token caches are bound to the signed-in OS user.
 * Values live in memory after the first read, so `get` is synchronous.
 *
 * A file that cannot be decrypted (for example after a denied Keychain prompt) is never
 * overwritten: reads throw UnreadableStoreError until the caller decides, via
 * `moveAside`, to start over.
 */
export class SecureStore {
  private values: Record<string, string> | null = null

  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {}

  get(key: string): string | null {
    return this.load()[key] ?? null
  }

  set(key: string, value: string): void {
    const values = { ...this.load(), [key]: value }
    this.flush(values)
    this.values = values
  }

  /** Publishes a group of values with one encryption, sync and atomic rename. */
  setMany(changes: Record<string, string>): void {
    if (!Object.keys(changes).length) return
    const values = { ...this.load(), ...changes }
    this.flush(values)
    this.values = values
  }

  delete(key: string): void {
    const current = this.load()
    if (!(key in current)) return
    const { [key]: _removed, ...values } = current
    this.flush(values)
    this.values = values
  }

  keys(): string[] {
    return Object.keys(this.load())
  }

  /** Reads the file now so startup can handle an unreadable store before anything writes. */
  open(): void {
    this.load()
  }

  /** Renames an unreadable file to a timestamped backup and starts with an empty store. */
  moveAside(): string {
    const backup = `${this.filePath}.unreadable-${Date.now()}`
    if (existsSync(this.filePath)) renameSync(this.filePath, backup)
    this.values = {}
    return backup
  }

  private load(): Record<string, string> {
    if (this.values) return this.values
    let raw: Buffer
    try {
      raw = readFileSync(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new UnreadableStoreError(this.filePath, error)
      this.values = {}
      return this.values
    }
    try {
      const parsed: unknown = JSON.parse(this.cipher.decrypt(raw))
      if (!parsed || typeof parsed !== "object") throw new Error("unexpected content")
      this.values = parsed as Record<string, string>
    } catch (error) {
      throw new UnreadableStoreError(this.filePath, error)
    }
    return this.values
  }

  private flush(values: Record<string, string> = this.values ?? {}): void {
    mkdirDurableSync(dirname(this.filePath))
    const tmp = `${this.filePath}.tmp`
    try {
      const handle = openSync(tmp, "w", 0o600)
      try {
        writeFileSync(handle, this.cipher.encrypt(JSON.stringify(values)))
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(tmp, this.filePath)
      if (process.platform !== "win32") syncDirectorySync(dirname(this.filePath))
    } finally {
      rmSync(tmp, { force: true })
    }
  }
}
