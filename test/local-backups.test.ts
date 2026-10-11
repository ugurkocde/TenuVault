import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as fileSystem from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"
import { LocalBlobStore, localBackupsExist } from "../src/main/storage/local-blob-store"
import { BackupKeys } from "../src/main/backup/keys"
import { readBackupSettings } from "../src/main/backup/settings"
import { memoryStore } from "./helpers"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

const ACCOUNT = "tvlocal-11111111-1111-1111-1111-111111111111"
const base = `https://${ACCOUNT}.blob.core.windows.net`

afterEach(() => {
  vi.mocked(fileSystem.readdir).mockReset()
  vi.restoreAllMocks()
})

function setup(keys = [randomBytes(32)]) {
  const root = mkdtempSync(join(tmpdir(), "tv-backups-"))
  const store = new LocalBlobStore(root, keys)
  const call = (path: string, init?: RequestInit) => handleLocalBlobRequest(store, new Request(`${base}${path}`, init))
  return { root, store, call, keys }
}

const put = (call: ReturnType<typeof setup>["call"], name: string, body: string) =>
  call(`/intune-backups/${name.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/json" },
    body,
  })

describe("encrypted local backups", () => {
  it("detects local backup files without decrypting them or needing connected tenants", async () => {
    const { root } = setup()
    expect(await localBackupsExist(join(root, "missing"))).toBe(false)
    expect(await localBackupsExist(root)).toBe(false)
    const folder = join(root, ACCOUNT, "intune-backups")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "other.txt"), "unrelated file")
    mkdirSync(join(folder, "directory.tvb"))
    expect(await localBackupsExist(root)).toBe(false)
    writeFileSync(join(folder, "encrypted.tvb"), "unreadable backup")
    expect(await localBackupsExist(root)).toBe(true)
  })

  it("does not count local audit records as backups", async () => {
    const { root } = setup()
    const folder = join(root, ACCOUNT, "audit-logs")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "record.tvb"), "encrypted record")
    expect(await localBackupsExist(root)).toBe(false)
  })

  it.each(["EACCES", "EPERM", "ENODEV", "EIO", "ENOTCONN", "ETIMEDOUT"])("returns unknown and logs a root scan failure with %s", async (code) => {
    const error = Object.assign(new Error("Backup folder unavailable"), { code })
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const readDirectory = vi.fn().mockRejectedValue(error)
    expect(await localBackupsExist("/unavailable-backups", readDirectory)).toBeNull()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("/unavailable-backups"), error)
  })

  it.skipIf(process.platform === "win32")("returns unknown for an unreadable root folder", async (context) => {
    const { root } = setup()
    const mode = statSync(root).mode & 0o777
    let permissionsChanged = false
    vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      try {
        chmodSync(root, 0)
        permissionsChanged = true
      } catch {
        context.skip("The platform does not allow directory permissions to be changed")
      }
      const result = await localBackupsExist(root)
      if (result !== null) context.skip("This user can read directories without permission bits")
      expect(result).toBeNull()
    } finally {
      if (permissionsChanged) chmodSync(root, mode)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([true, false])("continues after an inaccessible account folder when a sibling has backups: %s", async (hasBackup) => {
    const { root } = setup()
    const blocked = join(root, "blocked-account", "intune-backups")
    const sibling = join(root, "readable-account", "intune-backups")
    mkdirSync(blocked, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    if (hasBackup) writeFileSync(join(sibling, "encrypted.tvb"), "unreadable backup")
    const error = Object.assign(new Error("Account folder unavailable"), { code: "EACCES" })
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const readDirectory = vi.fn(async (path: string) => {
      if (path === blocked) throw error
      const entries = await fileSystem.readdir(path, { withFileTypes: true })
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    })
    expect(await localBackupsExist(root, readDirectory)).toBe(hasBackup ? true : null)
    expect(readDirectory).toHaveBeenCalledWith(sibling)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(blocked), error)
  })

  it.each(["EACCES", "ENODEV", "ENOTCONN"])("keeps settings and the export marker available after a scan fails with %s", async (code) => {
    const store = memoryStore()
    const keys = new BackupKeys(store)
    const keyFingerprint = keys.fingerprint()
    const localFolder = "/unavailable-backups"
    vi.mocked(fileSystem.readdir).mockRejectedValue(Object.assign(new Error("Backup folder unavailable"), { code }))
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await readBackupSettings(localFolder, keys, store)).toEqual({
      localFolder, keyFingerprint, recoveryExported: false, hasLocalBackups: null,
    })
    store.set("backup.recovery-exported", keyFingerprint)
    expect(await readBackupSettings(localFolder, keys, store)).toEqual({
      localFolder, keyFingerprint, recoveryExported: true, hasLocalBackups: null,
    })
  })

  it("keeps policy names and content off the disk in plain text", async () => {
    const { root, call } = setup()
    expect((await call("/intune-backups?restype=container", { method: "PUT" })).status).toBe(201)
    await put(call, "backup-2026-09-24-101500/CompliancePolicies/Win - Contoso BitLocker.json", '{"secret":"S3cr3tValue"}')

    const dir = join(root, ACCOUNT, "intune-backups")
    const [file] = readdirSync(dir)
    expect(file).toMatch(/^[0-9a-f]{40}\.tvb$/)
    const raw = readFileSync(join(dir, file!)).toString("latin1")
    expect(raw).not.toContain("Contoso")
    expect(raw).not.toContain("S3cr3tValue")
  })

  it("round-trips blobs and rejects tampered files", async () => {
    const { root, call, keys } = setup()
    await call("/intune-backups?restype=container", { method: "PUT" })
    await put(call, "backup-2026-09-24-101500/metadata.json", '{"Status":"Success"}')
    const response = await call("/intune-backups/backup-2026-09-24-101500/metadata.json")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ Status: "Success" })

    // Flip a byte in the body: authentication must fail instead of returning garbage.
    const dir = join(root, ACCOUNT, "intune-backups")
    const path = join(dir, readdirSync(dir)[0]!)
    const bytes = readFileSync(path)
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1)
    const { writeFileSync } = await import("node:fs")
    writeFileSync(path, bytes)
    const fresh = new LocalBlobStore(root, keys)
    const tampered = await handleLocalBlobRequest(fresh, new Request(`${base}/intune-backups/backup-2026-09-24-101500/metadata.json`))
    expect(tampered.status).toBe(500)
  })

  it("lists backups in the XML shape the shared routes parse", async () => {
    const { call } = setup()
    await call("/intune-backups?restype=container", { method: "PUT" })
    for (const name of [
      "backup-2026-09-23-020000/metadata.json",
      "backup-2026-09-23-020000/DeviceConfigurations/A & B.json",
      "backup-2026-09-24-020000/metadata.json",
    ]) {
      await put(call, name, "{}")
    }

    const folders = await (await call("/intune-backups?restype=container&comp=list&prefix=&delimiter=/")).text()
    // list-backups/route.ts
    const folderPattern = /<BlobPrefix><Name>(backup-\d{4}-\d{2}-\d{2}-\d{6})\/<\/Name><\/BlobPrefix>/g
    expect([...folders.matchAll(folderPattern)].map((m) => m[1])).toEqual(["backup-2026-09-23-020000", "backup-2026-09-24-020000"])

    const contents = await (await call("/intune-backups?restype=container&comp=list&prefix=backup-2026-09-23-020000/")).text()
    // list-backups/route.ts metadata size check (single-line XML required)
    expect(/metadata\.json<\/Name>.*?<Content-Length>(\d+)<\/Content-Length>/.exec(contents)?.[1]).toBe("2")
    const blobPattern = /<Blob>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<Content-Length>(\d+)<\/Content-Length>[\s\S]*?<\/Blob>/g
    expect([...contents.matchAll(blobPattern)].map((m) => m[1])).toEqual([
      "backup-2026-09-23-020000/DeviceConfigurations/A &amp; B.json",
      "backup-2026-09-23-020000/metadata.json",
    ])
  })

  it("answers like Azure for missing containers and blobs", async () => {
    const { call } = setup()
    expect((await call("/intune-backups?restype=container&comp=list&prefix=&delimiter=/")).status).toBe(404)
    expect((await put(call, "x.json", "{}")).status).toBe(404)
    await call("/intune-backups?restype=container", { method: "PUT" })
    expect((await call("/intune-backups?restype=container", { method: "PUT" })).status).toBe(409)
    const missing = await call("/intune-backups/nope.json")
    expect(missing.status).toBe(404)
    expect(missing.headers.get("x-ms-error-code")).toBe("BlobNotFound")
    await put(call, "x.json", "{}")
    expect((await call("/intune-backups/x.json", { method: "DELETE" })).status).toBe(202)
    expect((await call("/intune-backups/x.json")).status).toBe(404)
  })

  it("pages long listings with markers", async () => {
    const { call } = setup()
    await call("/intune-backups?restype=container", { method: "PUT" })
    for (const n of ["a", "b", "c"]) await put(call, `${n}.json`, "{}")
    const first = await (await call("/intune-backups?restype=container&comp=list&maxresults=2")).text()
    expect(first).toContain("<NextMarker>c.json</NextMarker>")
    const second = await (await call("/intune-backups?restype=container&comp=list&maxresults=2&marker=c.json")).text()
    expect(second).toContain("<Name>c.json</Name>")
    expect(second).toContain("<NextMarker />")
  })

  it("keeps older backups readable after importing a recovery key", async () => {
    const store = memoryStore()
    const keys = new BackupKeys(store)
    const { root } = setup()
    const before = new LocalBlobStore(root, keys.keyring())
    await before.createContainer(ACCOUNT, "intune-backups")
    await before.put(ACCOUNT, "intune-backups", "old.json", Buffer.from("old"), "application/json")

    const other = new BackupKeys(memoryStore())
    keys.importRecoveryKey(other.exportRecoveryKey())
    expect(keys.fingerprint()).toBe(other.fingerprint())

    const after = new LocalBlobStore(root, keys.keyring())
    await after.put(ACCOUNT, "intune-backups", "new.json", Buffer.from("new"), "application/json")
    expect((await after.get(ACCOUNT, "intune-backups", "old.json")).data.toString()).toBe("old")
    expect((await after.get(ACCOUNT, "intune-backups", "new.json")).data.toString()).toBe("new")
  })

  it("recovers backups from every key generation on a fresh installation", async () => {
    const keys = new BackupKeys(memoryStore())
    const { root } = setup()
    const first = new LocalBlobStore(root, keys.keyring())
    await first.createContainer(ACCOUNT, "intune-backups")
    await first.put(ACCOUNT, "intune-backups", "first.json", Buffer.from("first"), "application/json")
    const legacyKey = randomBytes(32)
    keys.importRecoveryKey(`TVK1.${legacyKey.toString("base64url")}`)
    const second = new LocalBlobStore(root, keys.keyring())
    await second.put(ACCOUNT, "intune-backups", "second.json", Buffer.from("second"), "application/json")

    const fresh = new BackupKeys(memoryStore())
    fresh.importRecoveryKey(keys.exportRecoveryKey())
    fresh.importRecoveryKey(keys.exportRecoveryKey())
    expect(fresh.keyring()).toHaveLength(2)
    expect(fresh.keyring()[0]).toEqual(legacyKey)
    const recovered = new LocalBlobStore(root, fresh.keyring())
    expect((await recovered.get(ACCOUNT, "intune-backups", "first.json")).data.toString()).toBe("first")
    expect((await recovered.get(ACCOUNT, "intune-backups", "second.json")).data.toString()).toBe("second")
  })

  it("rejects a malformed bundle atomically without changing existing keys", () => {
    const keys = new BackupKeys(memoryStore())
    const before = keys.exportRecoveryKey()
    for (const value of ["TVK2.", `${before}.bad`, `${before}.`, before + "!", "TVK3.unknown"]) {
      expect(() => keys.importRecoveryKey(value)).toThrow(/recovery key/)
      expect(keys.exportRecoveryKey()).toBe(before)
    }
  })

  it("rejects malformed recovery keys", () => {
    expect(() => new BackupKeys(memoryStore()).importRecoveryKey("TVK1.short")).toThrow(/recovery key/)
  })
})
