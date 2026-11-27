import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { BlobLeaseConflictError, BlobProtectedError, LocalBlobStore } from "../src/main/storage/local-blob-store"
import { BACKUP_CONTAINER, BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { withBackupServerTime } from "./helpers"

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const TENANT = "11111111-1111-1111-1111-111111111111"
const ACCOUNT = localStorageAccountName(TENANT)
const MASTER = Buffer.alloc(32, 7)
const NOW = new Date("2026-10-12T12:00:00Z")
const OWNER = { Source: "TenuVault Desktop", TenantId: TENANT }
const OLD_ITEM = { id: "old" }
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const ONE_ITEM_MANIFEST = {
  TenantId: TENANT,
  Status: "Success",
  Failures: 0,
  Scope: { Included: ["DeviceConfigurations"] },
  Items: {
    "DeviceConfigurations/old": { file: "Old.json", hash: snapshotHash(OLD_ITEM), sha256: sha256(OLD_ITEM) },
  },
  ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 },
}

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("local retention lock races and ownership checks", () => {
  it("4721002131: restores a live replacement lock during stale reclaim when lockPath is free, and preserves the aside file when lockPath is occupied", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!

    // Case A: another reclaimer installs a live lock before our rename, and lockPath is free when we restore.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-lock-reclaim-restore-")); roots.push(root)
      const store = new LocalBlobStore(root, [MASTER])
      await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
      const lockPath = join(dir, ".tenuvault-retention.lock")
      writeFileSync(lockPath, JSON.stringify({ id: "stale-id", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" }))

      const liveLock = JSON.stringify({ id: "live-other-id", host: hostname(), pid: process.pid, processStart: "live-start", app: "TenuVault" })
      vi.mocked(fsPromises.rename).mockImplementationOnce(async (from, to) => {
        // Between observing stale-id and renaming lockPath, another reclaimer replaced lockPath with its live lock.
        writeFileSync(lockPath, liveLock)
        return actual.rename(from, to)
      })

      await expect(store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toBeInstanceOf(BlobLeaseConflictError)
      // Live lock was restored via link and aside file was cleaned up.
      expect(readFileSync(lockPath, "utf8")).toBe(liveLock)
      expect(readdirSync(dir).filter(f => f.includes(".stale"))).toEqual([])
    }

    // Case B: another reclaimer installs a live lock before our rename, AND a third instance creates lockPath before restore ->
    // aside file is preserved on disk (never unlinked!) and retention stops with a warning.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-lock-reclaim-preserve-")); roots.push(root)
      const store = new LocalBlobStore(root, [MASTER])
      await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
      const lockPath = join(dir, ".tenuvault-retention.lock")
      writeFileSync(lockPath, JSON.stringify({ id: "stale-id", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" }))

      const liveLock = JSON.stringify({ id: "live-b-id", host: hostname(), pid: process.pid, processStart: "live-b", app: "TenuVault" })
      const thirdLock = JSON.stringify({ id: "live-c-id", host: hostname(), pid: process.pid, processStart: "live-c", app: "TenuVault" })
      vi.mocked(fsPromises.rename).mockImplementationOnce(async (from, to) => {
        writeFileSync(lockPath, liveLock)
        await actual.rename(from, to)
        // Third instance occupies lockPath before link(aside, lockPath) runs.
        writeFileSync(lockPath, thirdLock)
      })

      await expect(store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toThrow(/kept at .*\.stale/)
      // Third lock remains intact at lockPath AND live-b's lock is preserved in the aside file (never unlinked).
      expect(readFileSync(lockPath, "utf8")).toBe(thirdLock)
      const staleFiles = readdirSync(dir).filter(f => f.includes(".stale"))
      expect(staleFiles).toHaveLength(1)
      expect(readFileSync(join(dir, staleFiles[0]!), "utf8")).toBe(liveLock)
    }
  })

  it("4721002151: release verifies moved aside id and restores or preserves a different lock instead of unlinking it", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")

    // Case A: lock changes between read and rename; lockPath is free -> restored and warning returned.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-lock-release-restore-")); roots.push(root)
      const store = new LocalBlobStore(root, [MASTER])
      await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
      const lockPath = join(dir, ".tenuvault-retention.lock")
      const myId = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      const otherLock = JSON.stringify({ id: "other-id", host: hostname(), pid: process.pid, processStart: "other", app: "TenuVault" })

      vi.mocked(fsPromises.rename).mockImplementationOnce(async (from, to) => {
        writeFileSync(lockPath, otherLock)
        return actual.rename(from, to)
      })

      const result = await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, myId)
      expect(result.warning).toContain("restored")
      expect(readFileSync(lockPath, "utf8")).toBe(otherLock)
      expect(readdirSync(dir).filter(f => f.includes(".release"))).toEqual([])
    }

    // Case B: lock changes between read and rename AND lockPath is occupied before restore -> aside preserved, never unlinked.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-lock-release-preserve-")); roots.push(root)
      const store = new LocalBlobStore(root, [MASTER])
      await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
      const lockPath = join(dir, ".tenuvault-retention.lock")
      const myId = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      const otherLock = JSON.stringify({ id: "other-id", host: hostname(), pid: process.pid, processStart: "other", app: "TenuVault" })
      const newestLock = JSON.stringify({ id: "newest-id", host: hostname(), pid: process.pid, processStart: "newest", app: "TenuVault" })

      vi.mocked(fsPromises.rename).mockImplementationOnce(async (from, to) => {
        writeFileSync(lockPath, otherLock)
        await actual.rename(from, to)
        writeFileSync(lockPath, newestLock)
      })

      const result = await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, myId)
      expect(result.warning).toContain("was not deleted")
      expect(readFileSync(lockPath, "utf8")).toBe(newestLock)
      const releaseFiles = readdirSync(dir).filter(f => f.includes(".release"))
      expect(releaseFiles).toHaveLength(1)
      expect(readFileSync(join(dir, releaseFiles[0]!), "utf8")).toBe(otherLock)
    }
  })

  it("4721002110: local DELETE verifies retention lock ownership before renaming into quarantine and stops cleanup if lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-lock-delete-check-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")

    // Direct store.delete refuses when retentionLockId does not match the current lock file.
    const old1 = "backup-2026-08-02-020000/"
    const old2 = "backup-2026-08-01-020000/"
    for (const prefix of [old1, old2]) {
      await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
      await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
      await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")
    }
    const blob = (await store.get(ACCOUNT, BACKUP_CONTAINER, `${old1}metadata.json`)).blob
    const heldId = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    // Simulate lock replaced by another holder before delete.
    writeFileSync(lockPath, JSON.stringify({ id: "another-holder", host: hostname(), pid: process.pid, processStart: "other", app: "TenuVault" }))
    await expect(store.delete(ACCOUNT, BACKUP_CONTAINER, `${old1}metadata.json`, { ifMatch: blob.etag, retentionLockId: heldId }))
      .rejects.toBeInstanceOf(BlobLeaseConflictError)
    // Blob was NOT renamed or removed.
    expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old1)).map(b => b.name)).toContain(`${old1}metadata.json`)
    expect(readdirSync(dir).some(f => f.startsWith(".retired-"))).toBe(false)
    rmSync(lockPath, { force: true })

    // End-to-end retention: lock disappears right before the first DELETE of old1 ->
    // old1 is untouched, outer plan loop exits, and old2 is also untouched.
    let tamperOnce = false
    const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (!localAccountFromUrl(url)) return withBackupServerTime(Response.json({ value: [] }), NOW)
      if (req.method === "DELETE" && !tamperOnce) {
        tamperOnce = true
        expect(existsSync(lockPath)).toBe(true)
        writeFileSync(lockPath, JSON.stringify({ id: "stolen-lock", host: hostname(), pid: process.pid, processStart: "other", app: "TenuVault" }))
      }
      return handleLocalBlobRequest(store, req)
    }
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, now: () => NOW })
    const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
    await engine.waitForJob(job)
    expect(job.status).toBe("Completed")
    expect(tamperOnce).toBe(true)
    expect(job.log.join("\n")).toContain("local retention lock was lost")
    expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old1)).length).toBe(3)
    expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old2)).length).toBe(3)
  })

  it("4721024845: in-process write guard blocks concurrent put/delete on protected replacement prefixes from any LocalBlobStore instance", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-write-guard-")); roots.push(root)
    const keys = [randomBytes(32)]
    const storeA = new LocalBlobStore(root, keys)
    const storeB = new LocalBlobStore(root, keys)
    await storeA.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const repPrefix = "backup-2026-10-12-120000/"
    const otherPrefix = "backup-2026-08-01-120000/"
    await storeA.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":1}'), "application/json")
    await storeA.put(ACCOUNT, BACKUP_CONTAINER, `${otherPrefix}metadata.json`, Buffer.from('{"v":1}'), "application/json")

    const lockId = await storeA.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER, undefined, [repPrefix])
    try {
      // Both storeA and a separate LocalBlobStore instance storeB are blocked from mutating the protected prefix.
      await expect(storeA.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json"))
        .rejects.toBeInstanceOf(BlobProtectedError)
      await expect(storeB.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}DeviceConfigurations/new.json`, Buffer.from("{}"), "application/json"))
        .rejects.toBeInstanceOf(BlobProtectedError)
      await expect(storeB.delete(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`))
        .rejects.toBeInstanceOf(BlobProtectedError)
      // Unprotected prefixes can still be deleted with the lock.
      await expect(storeA.delete(ACCOUNT, BACKUP_CONTAINER, `${otherPrefix}metadata.json`, { retentionLockId: lockId }))
        .resolves.toBeUndefined()
    } finally {
      await storeA.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, lockId)
    }

    // Once released, writes to the previously protected prefix succeed again.
    await expect(storeB.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json"))
      .resolves.toBeDefined()
  })
})
