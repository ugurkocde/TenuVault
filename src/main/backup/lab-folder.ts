import { lstatSync, realpathSync, statSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { BACKUP_CONTAINER } from "../../shared/constants"
import { LARGE_BACKUP_CONTAINER, logicalBackupName } from "../../shared/backup-storage"
import { isBackupName } from "../../shared/intune/backup-names"
import { LocalBlobStore, type StoredBlob } from "../storage/local-blob-store"

export const LAB_FOLDER_ERROR = "TenuVault Lab can only browse the stable backup folder. Use the TenuVault Lab Backups folder to save backups."

function existing<T>(read: () => T): T | null {
  try { return read() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Resolve existing ancestors, including junctions, before comparing a folder that may not exist yet. */
function canonical(path: string): string {
  const real = existing(() => realpathSync.native(path))
  if (real) return real
  // A dangling symlink can become writable later. Refuse it until its destination can be resolved.
  if (existing(() => lstatSync(path))) throw new Error("The backup folder points to an unavailable location.")
  const parent = dirname(path)
  if (parent === path) throw new Error("The backup folder could not be resolved.")
  return join(canonical(parent), path.slice(parent.length).replace(/^[/\\]/, ""))
}

const comparable = (path: string) => path.normalize("NFC").replace(/\\/g, "/").split("/").map(part => part.replace(/[. ]+$/, "").toLowerCase()).join("/")

export function isStableBackupFolder(path: string, stable: string): boolean {
  const stablePath = canonical(resolve(stable))
  const stableName = comparable(stablePath)
  const identity = existing(() => statSync(stablePath, { bigint: true }))
  for (let location = canonical(resolve(path)); ; location = dirname(location)) {
    if (comparable(location) === stableName) return true
    const current = identity && existing(() => statSync(location, { bigint: true }))
    if (current && current.ino !== 0n && current.dev === identity?.dev && current.ino === identity.ino) return true
    if (dirname(location) === location) return false
  }
}

export function guardLabBackupWrites(stable: string): (path: string) => void {
  return path => {
    if (isStableBackupFolder(path, stable)) throw new Error(LAB_FOLDER_ERROR)
  }
}

/** Copy only backups whose full payload opens with the Lab profile's own key. */
export async function copyLabBackups(source: string, target: string, keys: Buffer[], guard: (path: string) => void): Promise<{ copied: number; skipped: number }> {
  guard(target)
  if (!keys.length) throw new Error("TenuVault Lab cannot identify its own key. You can continue browsing the original folder.")
  const reader = new LocalBlobStore(source, keys, undefined, () => { throw new Error(LAB_FOLDER_ERROR) })
  const writer = new LocalBlobStore(target, keys, undefined, guard)
  let copied = 0, skipped = 0
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^tvlocal-[a-f0-9-]+$/i.test(entry.name)) continue
    const account = entry.name
    for (const container of [BACKUP_CONTAINER, LARGE_BACKUP_CONTAINER]) {
      if (!await reader.containerExists(account, container)) continue
      const candidates = new Map<string, StoredBlob[]>()
      for (const blob of await reader.list(account, container)) {
        const id = logicalBackupName(blob.name).split("/")[0]!
        if (!isBackupName(id)) continue
        const group = candidates.get(id) ?? []
        group.push(blob)
        candidates.set(id, group)
      }
      const damage = await reader.damage(account, container)
      skipped += damage.unattributed
      for (const id of damage.unavailable.keys()) if (!candidates.has(id)) skipped++
      if (!candidates.size) continue
      await writer.createContainer(account, container)
      const destination = new Set((await writer.list(account, container)).map(blob => blob.name))
      for (const [id, files] of candidates) {
        try {
          if (damage.unavailable.has(id)) throw new Error("Backup inventory is incomplete.")
          const read = async (file: StoredBlob) => {
            const { blob, data } = await reader.get(account, container, file.name)
            if (blob.etag !== file.etag) throw new Error("The source changed during copying.")
            return data
          }
          for (const file of files) await read(file)
          const manifest = files.find(file => file.name === `${id}/metadata.json`)
          const payload = files.filter(file => file !== manifest)
          const copy = async (file: StoredBlob) => {
            if (destination.has(file.name)) return
            await writer.put(account, container, file.name, await read(file), file.contentType, true, file.metadata)
            destination.add(file.name)
          }
          const verify = async (file: StoredBlob) => {
            const verified = await writer.get(account, container, file.name)
            if (!verified.data.equals(await read(file))) throw new Error("The copy does not match the source.")
          }
          for (const file of payload) await copy(file)
          for (const file of payload) await verify(file)
          // Publish the completion record only after every other copy has been read back.
          if (manifest) {
            await copy(manifest)
            await verify(manifest)
          }
          copied++
        } catch {
          skipped++
        }
      }
    }
  }
  return { copied, skipped }
}
