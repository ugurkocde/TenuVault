import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface Cipher {
  encrypt: (plainText: string) => Buffer
  decrypt: (cipherText: Buffer) => string
}

/** The synchronous key/value interface SecureStore offers, for code that only reads and writes values. */
export interface KeyValueStore {
  get: (key: string) => string | null
  set: (key: string, value: string) => void
  delete: (key: string) => void
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

  delete(key: string): void {
    const values = this.load()
    if (key in values) {
      delete values[key]
      this.flush()
    }
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
    mkdirSync(dirname(this.filePath), { recursive: true })
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
      if (process.platform !== "win32") {
        const dir = dirname(this.filePath)
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
    } finally {
      rmSync(tmp, { force: true })
    }
  }
}
