import { createHash, randomUUID } from "node:crypto"
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Cipher, KeyValueStore } from "./secure-store"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"

/** Directory restore send barriers must fail closed. Windows does not support directory handles here. */
function syncDirectorySync(directory: string): void {
  if (process.platform === "win32") return
  const handle = openSync(directory, "r")
  try { fsyncSync(handle) } finally { closeSync(handle) }
}

export interface PartitionedRestoreStore extends KeyValueStore { readonly partitioned: true }
/** Uses the app's cipher, but never reads or rewrites the full directory history for a batch save. */
export class DirectoryRestoreStore implements PartitionedRestoreStore {
  readonly partitioned = true as const
  constructor(private readonly directory: string, private readonly cipher: Cipher) {
    const first = mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (first) for (let current = directory; ; current = dirname(current)) {
      syncDirectorySync(current)
      if (current === dirname(first) || current === dirname(current)) break
    }
  }
  private file(key: string): string {
    if (!key.startsWith("restore.directory.")) throw new RestoreSafetyError("This store accepts directory restore records only.")
    return join(this.directory, createHash("sha256").update(key).digest("hex") + ".bin")
  }
  private syncDirectory(): void {
    syncDirectorySync(this.directory)
  }
  get(key: string): string | null {
    let encrypted: Buffer
    try { encrypted = readFileSync(this.file(key)) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
    try {
      const record = JSON.parse(this.cipher.decrypt(encrypted))
      if (record.key !== key || typeof record.value !== "string") throw new Error("Invalid record")
      return record.value
    } catch { throw new RestoreSafetyError("Directory restore history could not be verified. No write was sent.") }
  }
  set(key: string, value: string): void {
    const file = this.file(key), temporary = file + "." + randomUUID() + ".tmp"
    const encrypted = this.cipher.encrypt(JSON.stringify({ key, value }))
    const handle = openSync(temporary, "wx", 0o600)
    try {
      try { writeFileSync(handle, encrypted); fsyncSync(handle) } finally { closeSync(handle) }
      renameSync(temporary, file); this.syncDirectory()
    } finally { rmSync(temporary, { force: true }) }
  }
  delete(key: string): void {
    rmSync(this.file(key), { force: true }); this.syncDirectory()
  }
}
