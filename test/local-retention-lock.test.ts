import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine, NetworkCircuit } from "../src/main/backup/engine"
import { BlobLeaseError, BlobWriter } from "../src/main/backup/blob-writer"
import { permanentLeaseFailureWarning } from "../src/main/backup/retention-lease"
import { type RetentionProgressStore } from "../src/main/backup/retention-progress"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import {
  BlobLeaseConflictError,
  BlobProtectedError,
  compareProcessStart,
  createProcessInfoReader,
  LocalBlobStore,
  parseDarwinPsStart,
  parseWindowsCreationDate,
  processStartKind,
  type ProcessInfoReader,
} from "../src/main/storage/local-blob-store"
import { BACKUP_CONTAINER, BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { withBackupServerTime } from "./helpers"

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    link: vi.fn(actual.link),
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
  }
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

function memoryProgress(): RetentionProgressStore {
  const data = new Map<string, string>()
  return {
    get: key => data.get(key) ?? null,
    set: (key, value) => { data.set(key, value) },
    delete: key => { data.delete(key) },
  }
}

async function seedOldLocalBackup(store: LocalBlobStore, prefix: string): Promise<void> {
  await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
  await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
  await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")
}

describe("round 4 local retention lock hardening", () => {
  it("P1: reads win32 and darwin process start tokens with explicit kinds, detects PID reuse, and preserves matching live holders", async () => {
    // Win32 reader via injected execFile (no real PowerShell).
    const winCalls: Array<{ file: string; args: string[]; timeout?: number }> = []
    const winReader = createProcessInfoReader({
      platform: "win32",
      isPidAlive: () => true,
      execFile: async (file, args, options) => {
        winCalls.push({ file, args, timeout: options.timeout })
        if (args.join(" ").includes("ProcessId=4242")) return { stdout: "2026-11-27T10:00:00.1234567Z\r\n" }
        return { stdout: "2026-11-27T11:00:00.0000000Z\r\n" }
      },
    })
    expect(parseWindowsCreationDate("2026-11-27T10:00:00.1234567Z\r\n")).toBe("wmi:2026-11-27T10:00:00.123Z")
    const winOwnStart = await winReader.readProcessStart(process.pid)
    expect(winOwnStart).toBe("wmi:2026-11-27T11:00:00.000Z")
    expect(processStartKind(winOwnStart!)).toBe("wmi")
    expect(winCalls[0]!.file).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/)
    expect(winCalls[0]!.args).toContain("-NoProfile")
    expect(winCalls[0]!.timeout).toBeGreaterThan(0)

    const rootWin = mkdtempSync(join(tmpdir(), "tv-lock-win32-")); roots.push(rootWin)
    const winStore = new LocalBlobStore(rootWin, [MASTER], undefined, winReader)
    await winStore.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const winLockPath = join(rootWin, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")

    // Holder records wmi: token matching what it reads for others.
    const heldWin = await winStore.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(winLockPath, "utf8")).processStart).toBe("wmi:2026-11-27T11:00:00.000Z")
    await winStore.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, heldWin)

    // PID reuse on win32 (same kind wmi:, different timestamp) -> reclaimed.
    writeFileSync(winLockPath, JSON.stringify({
      id: "win-reused", host: hostname(), pid: 4242, processStart: "wmi:2026-11-27T08:00:00.000Z", app: "TenuVault",
    }))
    const reclaimedWin = await winStore.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(winLockPath, "utf8")).id).toBe(reclaimedWin)
    await winStore.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, reclaimedWin)

    // Matching wmi: start -> stays temporary "another instance" conflict with holderId.
    writeFileSync(winLockPath, JSON.stringify({
      id: "win-live", host: hostname(), pid: 4242, processStart: "wmi:2026-11-27T10:00:00.123Z", app: "TenuVault",
    }))
    await expect(winStore.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toMatchObject({
      code: "LeaseAlreadyPresent",
      lockPath: winLockPath,
      holderId: "win-live",
      message: expect.stringContaining("Another TenuVault instance"),
    })

    // Darwin reader via injected execFile (no real ps).
    const darwinCalls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
    const darwinReader = createProcessInfoReader({
      platform: "darwin",
      isPidAlive: () => true,
      execFile: async (file, args, options) => {
        darwinCalls.push({ file, args, env: options.env })
        if (args.includes("5151")) return { stdout: "Fri Nov 27 10:00:00 2026\n" }
        return { stdout: "Fri Nov 27 11:00:00 2026\n" }
      },
    })
    const expectedDarwin5151 = `ps:${Math.floor(Date.UTC(2026, 10, 27, 10, 0, 0) / 1000)}`
    expect(parseDarwinPsStart("Fri Nov 27 10:00:00 2026\n")).toBe(expectedDarwin5151)
    const darwinOwnStart = await darwinReader.readProcessStart(process.pid)
    expect(darwinOwnStart).toBe(`ps:${Math.floor(Date.UTC(2026, 10, 27, 11, 0, 0) / 1000)}`)
    expect(darwinCalls[0]!.file).toBe("/bin/ps")
    expect(darwinCalls[0]!.args).toEqual(["-o", "lstart=", "-p", String(process.pid)])
    expect(darwinCalls[0]!.env?.LC_ALL).toBe("C")

    const rootMac = mkdtempSync(join(tmpdir(), "tv-lock-darwin-")); roots.push(rootMac)
    const macStore = new LocalBlobStore(rootMac, [MASTER], undefined, darwinReader)
    await macStore.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const macLockPath = join(rootMac, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")

    // PID reuse on darwin -> reclaimed.
    writeFileSync(macLockPath, JSON.stringify({
      id: "mac-reused", host: hostname(), pid: 5151, processStart: "ps:1700000000", app: "TenuVault",
    }))
    const reclaimedMac = await macStore.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(macLockPath, "utf8")).id).toBe(reclaimedMac)
    await macStore.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, reclaimedMac)
  })

  it("P1 & P3.1: unobservable start or token kind mismatch warns with lockPath, never reclaims, escalates after 3 runs, and leaves backups/restores working", async () => {
    // (a) Token kind mismatch (recorded wmi:, observed proc:) -> manual warning, NOT stale.
    const rootMismatch = mkdtempSync(join(tmpdir(), "tv-lock-kind-mismatch-")); roots.push(rootMismatch)
    const linuxReader: ProcessInfoReader = {
      isPidAlive: () => true,
      readProcessStart: async () => "proc:boot-1:99999",
    }
    const mismatchStore = new LocalBlobStore(rootMismatch, [MASTER], undefined, linuxReader)
    await mismatchStore.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const mismatchLockPath = join(rootMismatch, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")
    const wmiLock = JSON.stringify({
      id: "cross-kind", host: hostname(), pid: 7777, processStart: "wmi:2026-11-27T10:00:00.000Z", app: "TenuVault",
    })
    writeFileSync(mismatchLockPath, wmiLock)
    await expect(mismatchStore.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toMatchObject({
      code: "RetentionLockManualIntervention",
      lockPath: mismatchLockPath,
      message: expect.stringContaining(mismatchLockPath),
    })
    expect(readFileSync(mismatchLockPath, "utf8")).toBe(wmiLock)

    // (b) Command failure / timeout (unobservable start) -> manual warning naming lockPath, escalates on 3rd consecutive run.
    const rootUnobs = mkdtempSync(join(tmpdir(), "tv-lock-unobservable-")); roots.push(rootUnobs)
    const failingReader = createProcessInfoReader({
      platform: "win32",
      isPidAlive: () => true,
      execFile: async () => {
        const err = new Error("Command timed out") as Error & { killed?: boolean }
        err.killed = true
        throw err
      },
    })
    const store = new LocalBlobStore(rootUnobs, [MASTER], undefined, failingReader)
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const oldPrefix = "backup-2026-08-01-020000/"
    await seedOldLocalBackup(store, oldPrefix)
    const lockPath = join(rootUnobs, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")
    const stuckLock = JSON.stringify({
      id: "unobs-id", host: hostname(), pid: 8888, processStart: "wmi:2026-11-27T09:00:00.000Z", app: "TenuVault",
    })
    writeFileSync(lockPath, stuckLock)

    const progress = memoryProgress()
    let clock = new Date(NOW.getTime())
    const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, req)
      return withBackupServerTime(Response.json({ value: [] }), clock)
    }
    const runOnce = async () => {
      const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, retentionProgress: progress, now: () => clock })
      const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
      await engine.waitForJob(job)
      expect(job.status).toBe("Completed")
      clock = new Date(clock.getTime() + 2_000)
      return job
    }

    const run1 = await runOnce()
    expect(run1.log.join("\n")).toContain(lockPath)
    expect(run1.log.join("\n")).toContain("Delete it only if no other computer is running TenuVault")
    expect(run1.log.join("\n")).not.toContain("3 consecutive runs")
    const run2 = await runOnce()
    expect(run2.log.join("\n")).not.toContain("3 consecutive runs")
    const run3 = await runOnce()
    expect(run3.log.join("\n")).toContain("3 consecutive runs")
    expect(run3.log.join("\n")).toContain(lockPath)
    // Lock file was not deleted automatically; backups and restores still work.
    expect(readFileSync(lockPath, "utf8")).toBe(stuckLock)
    const restored = await store.get(ACCOUNT, BACKUP_CONTAINER, `${oldPrefix}metadata.json`)
    expect(restored.data.length).toBeGreaterThan(0)
  })

  it("P1 rule 3: live matching holder stays temporary on runs 1-2 and escalates with lockPath after 3 consecutive runs seeing the same holder", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-lock-stuck-live-")); roots.push(root)
    const liveReader: ProcessInfoReader = {
      isPidAlive: () => true,
      readProcessStart: async () => "proc:boot-live:12345",
    }
    const store = new LocalBlobStore(root, [MASTER], undefined, liveReader)
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    await seedOldLocalBackup(store, "backup-2026-08-01-020000/")
    const lockPath = join(root, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")
    writeFileSync(lockPath, JSON.stringify({
      id: "same-live-holder", host: hostname(), pid: 9999, processStart: "proc:boot-live:12345", app: "TenuVault",
    }))

    const progress = memoryProgress()
    let clock = new Date(NOW.getTime())
    const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, req)
      return withBackupServerTime(Response.json({ value: [] }), clock)
    }
    const runOnce = async () => {
      const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, retentionProgress: progress, now: () => clock })
      const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
      await engine.waitForJob(job)
      expect(job.status).toBe("Completed")
      clock = new Date(clock.getTime() + 2_000)
      return job
    }

    const run1 = await runOnce()
    expect(run1.log.join("\n")).toContain("Another TenuVault instance is currently running retention")
    expect(run1.log.join("\n")).not.toContain("3 consecutive runs")
    const run2 = await runOnce()
    expect(run2.log.join("\n")).not.toContain("3 consecutive runs")
    const run3 = await runOnce()
    expect(run3.log.join("\n")).toContain("3 consecutive runs")
    expect(run3.log.join("\n")).toContain(lockPath)
  })

  it("P2: writes lock atomically via temp+fsync+link, re-reads unparseable lock once before warning, and handles legacy 0.5.3 locks", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-lock-p2-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")

    // (a) Atomic creation: open is never called with "wx" on lockPath directly; link publishes a complete JSON temp file.
    vi.mocked(fsPromises.open).mockClear()
    vi.mocked(fsPromises.link).mockClear()
    let linkedPayload = ""
    vi.mocked(fsPromises.link).mockImplementationOnce(async (existingPath, newPath) => {
      linkedPayload = readFileSync(String(existingPath), "utf8")
      return actual.link(existingPath, newPath)
    })
    const atomicId = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(vi.mocked(fsPromises.open).mock.calls.some(([p, flags]) => String(p) === lockPath && flags === "wx")).toBe(false)
    expect(vi.mocked(fsPromises.link)).toHaveBeenCalledTimes(1)
    expect(JSON.parse(linkedPayload).id).toBe(atomicId)
    expect(readdirSync(dir).filter(f => f.endsWith(".tmp"))).toEqual([])
    await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, atomicId)

    // (b) Unparseable lock re-read once after a short delay: recovers when the lock becomes absent/valid before second read.
    writeFileSync(lockPath, "")
    let readCount = 0
    vi.mocked(fsPromises.readFile).mockImplementation((async (p: Parameters<typeof fsPromises.readFile>[0], options?: Parameters<typeof fsPromises.readFile>[1]) => {
      if (String(p) === lockPath) {
        readCount++
        if (readCount === 1) return ""
        rmSync(lockPath, { force: true })
        const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
        throw missing
      }
      return options === undefined ? actual.readFile(p) : actual.readFile(p, options)
    }) as typeof fsPromises.readFile)
    try {
      const afterTransientEmpty = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      expect(readCount).toBe(2)
      await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, afterTransientEmpty)
    } finally {
      vi.mocked(fsPromises.readFile).mockImplementation(actual.readFile)
    }

    // Permanently unparseable lock -> re-reads once then warns with lockPath.
    writeFileSync(lockPath, "{broken")
    let brokenReads = 0
    vi.mocked(fsPromises.readFile).mockImplementation((async (p: Parameters<typeof fsPromises.readFile>[0], options?: Parameters<typeof fsPromises.readFile>[1]) => {
      if (String(p) === lockPath) brokenReads++
      return options === undefined ? actual.readFile(p) : actual.readFile(p, options)
    }) as typeof fsPromises.readFile)
    try {
      await expect(store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toMatchObject({
        code: "RetentionLockManualIntervention",
        lockPath,
        message: expect.stringContaining(lockPath),
      })
      expect(brokenReads).toBe(2)
    } finally {
      vi.mocked(fsPromises.readFile).mockImplementation(actual.readFile)
    }
    rmSync(lockPath, { force: true })

    // (c) Legacy 0.5.3 lock: expired -> reclaimed via aside-and-verify; unexpired -> warns with lockPath.
    writeFileSync(lockPath, JSON.stringify({ id: "legacy-expired", pid: process.pid, durationMs: 60_000, expiresAt: Date.now() - 10_000 }))
    const reclaimedLegacy = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(reclaimedLegacy)
    await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, reclaimedLegacy)

    const liveLegacy = JSON.stringify({ id: "legacy-active", pid: process.pid, durationMs: 60_000, expiresAt: Date.now() + 60_000 })
    writeFileSync(lockPath, liveLegacy)
    await expect(store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toMatchObject({
      code: "RetentionLockManualIntervention",
      lockPath,
      message: expect.stringContaining(lockPath),
    })
    expect(readFileSync(lockPath, "utf8")).toBe(liveLegacy)
  })

  it("P3.2: recoverRetired skips quarantined files under a protected prefix and recovers them after protection is released", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-retired-guard-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const repPrefix = "backup-2026-10-12-120000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"ok":true}'), "application/json")
    const tvbFile = readdirSync(dir).find(f => f.endsWith(".tvb"))!
    expect(tvbFile).toBeTruthy()

    // Simulate an aged quarantine folder holding a file under repPrefix.
    const retiredDir = join(dir, ".retired-test123")
    mkdirSync(retiredDir)
    renameSync(join(dir, tvbFile), join(retiredDir, tvbFile))
    const stampPath = join(retiredDir, ".quarantined")
    writeFileSync(stampPath, "")
    const oldTime = (Date.now() - 120_000) / 1000
    utimesSync(stampPath, oldTime, oldTime)
    utimesSync(retiredDir, oldTime, oldTime)

    // While repPrefix is protected, listing/recovery must NOT link the retired file back into the live folder.
    const lockId = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER, undefined, [repPrefix])
    try {
      await store.list(ACCOUNT, BACKUP_CONTAINER)
      expect(existsSync(join(dir, tvbFile))).toBe(false)
      expect(existsSync(join(retiredDir, tvbFile))).toBe(true)
    } finally {
      await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, lockId)
    }

    // After protection is released, the next listing retries recovery and restores the file.
    const listedAfter = await store.list(ACCOUNT, BACKUP_CONTAINER)
    expect(existsSync(join(dir, tvbFile))).toBe(true)
    expect(existsSync(retiredDir)).toBe(false)
    expect(listedAfter.map(b => b.name)).toContain(`${repPrefix}metadata.json`)
  })

  it("P3.3: retries local container lock release once and always clears in-process write guard even if release fails before store runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-guard-leak-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    const repPrefix = "backup-2026-10-12-120000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":1}'), "application/json")

    // (a) First release attempt fails transiently, second succeeds -> lock removed and guard cleared.
    let releaseAttempts = 0
    const retryWriter = new BlobWriter(async (input, init) => {
      const req = new Request(input, init)
      if (req.headers.get("x-ms-lease-action") === "release") {
        releaseAttempts++
        if (releaseAttempts === 1) throw new Error("Simulated transient release failure")
      }
      return handleLocalBlobRequest(store, req)
    }, ACCOUNT, async () => "token")
    const retryLockId = await retryWriter.acquireContainerLease([repPrefix])
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json"))
      .rejects.toBeInstanceOf(BlobProtectedError)
    await retryWriter.releaseContainerLease(retryLockId)
    expect(releaseAttempts).toBe(2)
    expect(existsSync(lockPath)).toBe(false)
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json"))
      .resolves.toBeDefined()

    // (b) All release attempts fail before store.releaseRetentionLock runs -> in-process guard is STILL cleared in finally.
    let failedReleaseAttempts = 0
    const failingWriter = new BlobWriter(async (input, init) => {
      const req = new Request(input, init)
      if (req.headers.get("x-ms-lease-action") === "release") {
        failedReleaseAttempts++
        throw new Error("Simulated release timeout before store")
      }
      return handleLocalBlobRequest(store, req)
    }, ACCOUNT, async () => "token")
    const leakLockId = await failingWriter.acquireContainerLease([repPrefix])
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":3}'), "application/json"))
      .rejects.toBeInstanceOf(BlobProtectedError)
    await expect(failingWriter.releaseContainerLease(leakLockId)).rejects.toThrow(/Simulated release timeout/)
    expect(failedReleaseAttempts).toBe(2)
    // Store release never ran, so lock file is still on disk, yet the in-process guard was cleared.
    expect(existsSync(lockPath)).toBe(true)
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":3}'), "application/json"))
      .resolves.toBeDefined()
    rmSync(lockPath, { force: true })

    // (c) End-to-end retention: even if storage release fails on both attempts, the replacement prefix is not stuck guarded.
    await seedOldLocalBackup(store, "backup-2026-08-01-020000/")
    let engineReleaseAttempts = 0
    const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
    const engine = new BackupEngine({
      fetch: async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        if (!localAccountFromUrl(url)) return withBackupServerTime(Response.json({ value: [] }), NOW)
        if (req.headers.get("x-ms-lease-action") === "release") {
          engineReleaseAttempts++
          throw new Error("Release aborted before store")
        }
        return handleLocalBlobRequest(store, req)
      },
      getToken: async () => "token",
      retentionDays: () => 30,
      now: () => NOW,
    })
    const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
    await engine.waitForJob(job)
    expect(job.status).toBe("Completed")
    expect(engineReleaseAttempts).toBe(2)
    expect(job.log.join("\n")).toContain("The local retention lock could not be released.")
    expect(job.results?.notices).toContainEqual(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining("The local retention lock could not be released."),
    }))
    const backups = (await store.list(ACCOUNT, BACKUP_CONTAINER)).map(b => b.name)
    const anchorMetadata = backups.find(n => n.startsWith("backup-2026-10-12-") && n.endsWith("/metadata.json"))!
    expect(anchorMetadata).toBeTruthy()
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, anchorMetadata, Buffer.from('{"unlocked":true}'), "application/json"))
      .resolves.toBeDefined()
  })
})

describe("round 5 CodeRabbit fixes", () => {
  it("4721701660: releases lock file and write guard when a local lock acquire aborts before guard registration", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-lock-abort-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    const repPrefix = "backup-2026-10-12-120000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":1}'), "application/json")

    let markPublished!: () => void
    const published = new Promise<void>(resolve => { markPublished = resolve })
    let releaseLink!: () => void
    const resumeLink = new Promise<void>(resolve => { releaseLink = resolve })

    vi.mocked(fsPromises.link).mockImplementationOnce(async (from, to) => {
      await actual.link(from, to)
      markPublished()
      await resumeLink
    })

    const controller = new AbortController()
    const network = new NetworkCircuit(3, controller.signal, Date.now() + 60_000)
    let pendingEmulator: Promise<Response> | undefined
    const writer = new BlobWriter(async (input, init) => {
      const req = new Request(input, init)
      pendingEmulator = handleLocalBlobRequest(store, req)
      return pendingEmulator
    }, ACCOUNT, async () => "token", network)

    const acquirePromise = writer.acquireContainerLease([repPrefix])
    await published
    // Lock file was published on disk, while the store is still paused before registering the write guard.
    expect(existsSync(lockPath)).toBe(true)

    controller.abort(new Error("Caller timed out"))
    await expect(acquirePromise).rejects.toThrow("Caller timed out")

    // Resume the paused store call and wait for it to settle.
    releaseLink()
    await pendingEmulator?.catch(() => undefined)

    // Neither the lock file nor the write guard may remain.
    expect(existsSync(lockPath)).toBe(false)
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json"))
      .resolves.toBeDefined()
  })

  it("4721701729: treats mixed Linux proc tokens without boot_id as inconclusive while still reclaiming dead or reused PIDs", async () => {
    expect(compareProcessStart("proc:boot-1:123", "proc:123")).toBe("incomparable")
    expect(compareProcessStart("proc:123", "proc:boot-1:123")).toBe("incomparable")
    expect(compareProcessStart("proc:boot-1:123", "proc:boot-1:123")).toBe("same")
    expect(compareProcessStart("proc:boot-1:123", "proc:boot-1:456")).toBe("different")
    expect(compareProcessStart("proc:boot-1:123", "proc:boot-2:123")).toBe("different")

    const root = mkdtempSync(join(tmpdir(), "tv-lock-linux-fields-")); roots.push(root)
    let alive = true
    let observed: string | "gone" | null = "proc:123"
    const reader: ProcessInfoReader = {
      isPidAlive: () => alive,
      readProcessStart: async () => observed,
    }
    const store = new LocalBlobStore(root, [MASTER], undefined, reader)
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(root, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")

    // Recorded has boot_id, contender cannot read boot_id -> inconclusive, preserves lock via manual warning.
    const mixedLock = JSON.stringify({ id: "live-holder", host: hostname(), pid: 4321, processStart: "proc:boot-1:123", app: "TenuVault" })
    writeFileSync(lockPath, mixedLock)
    await expect(store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toMatchObject({
      code: "RetentionLockManualIntervention",
      lockPath,
    })
    expect(readFileSync(lockPath, "utf8")).toBe(mixedLock)

    // Recorded lacks boot_id, contender has boot_id -> also inconclusive, preserves lock.
    const reverseMixed = JSON.stringify({ id: "live-holder-2", host: hostname(), pid: 4321, processStart: "proc:123", app: "TenuVault" })
    writeFileSync(lockPath, reverseMixed)
    observed = "proc:boot-1:123"
    await expect(store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toMatchObject({
      code: "RetentionLockManualIntervention",
      lockPath,
    })
    expect(readFileSync(lockPath, "utf8")).toBe(reverseMixed)

    // Comparable boot_id with different ticks -> proven PID reuse -> reclaimed.
    writeFileSync(lockPath, mixedLock)
    observed = "proc:boot-1:999"
    const reclaimedReuse = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(reclaimedReuse)
    await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, reclaimedReuse)

    // Confirmed dead holder -> still reclaimed even when lock had no boot_id.
    writeFileSync(lockPath, reverseMixed)
    alive = false
    const reclaimedDead = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(reclaimedDead)
    await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, reclaimedDead)
  })

  it("4721701740: removes held copy when live and held refer to the same file, and still reports conflict when they differ", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-retired-same-file-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const prefix = "backup-2026-10-12-120000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from('{"Status":"Success"}'), "application/json")
    const tvbFile = readdirSync(dir).find(f => f.endsWith(".tvb"))!

    // Case A: crash after link(held, live) before rm(held) -> both names point to the same inode.
    const retiredSame = join(dir, ".retired-same1")
    mkdirSync(retiredSame)
    linkSync(join(dir, tvbFile), join(retiredSame, tvbFile))
    const stampSame = join(retiredSame, ".quarantined")
    writeFileSync(stampSame, "")
    const oldTime = (Date.now() - 120_000) / 1000
    utimesSync(stampSame, oldTime, oldTime)
    utimesSync(retiredSame, oldTime, oldTime)

    const damageSame = await store.damage(ACCOUNT, BACKUP_CONTAINER)
    expect(damageSame.files).toEqual([])
    expect(damageSame.unavailable.size).toBe(0)
    expect(existsSync(retiredSame)).toBe(false)
    expect(existsSync(join(dir, tvbFile))).toBe(true)
    expect((await store.get(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`)).data.toString()).toBe('{"Status":"Success"}')

    // Case B: live and held are different files -> conflict is still reported and neither file is removed.
    const retiredDiff = join(dir, ".retired-diff1")
    mkdirSync(retiredDiff)
    // Copy bytes into a separate file (new inode) and overwrite live with new content.
    writeFileSync(join(retiredDiff, tvbFile), readFileSync(join(dir, tvbFile)))
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from('{"Status":"Success","v":2}'), "application/json")
    const stampDiff = join(retiredDiff, ".quarantined")
    writeFileSync(stampDiff, "")
    utimesSync(stampDiff, oldTime, oldTime)
    utimesSync(retiredDiff, oldTime, oldTime)

    const damageDiff = await store.damage(ACCOUNT, BACKUP_CONTAINER)
    expect(damageDiff.files).toHaveLength(1)
    expect(damageDiff.files[0]!.file).toBe(`.retired-diff1/${tvbFile}`)
    expect(existsSync(join(retiredDiff, tvbFile))).toBe(true)
    expect(existsSync(join(dir, tvbFile))).toBe(true)
  })

  it("4721701663: both local lock warnings tell operators to stop same-computer TenuVault processes before deleting the lock", () => {
    const manual = permanentLeaseFailureWarning(true, 3, new BlobLeaseError(new Error("manual"), 409, "RetentionLockManualIntervention", "/backups/.tenuvault-retention.lock"))
    const sameHolder = permanentLeaseFailureWarning(true, 3, new BlobLeaseError(new Error("held"), 409, "LeaseAlreadyPresent", "/backups/.tenuvault-retention.lock", "holder-1"))
    for (const msg of [manual, sameHolder]) {
      expect(msg).toContain("Stop any TenuVault process on this computer that uses this backup folder")
      expect(msg).toContain("no other computer is running TenuVault on this backup folder")
    }
  })

  it("4721701716: percent-encodes and decodes x-tenuvault-lock-warning for non-Latin-1 paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-lock-備-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(root, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")
    const writer = new BlobWriter(async (input, init) => handleLocalBlobRequest(store, new Request(input, init)), ACCOUNT, async () => "token")

    const lockId = await writer.acquireContainerLease()
    // Replace lock file so releaseRetentionLock returns a warning containing lockPath (with 備).
    writeFileSync(lockPath, JSON.stringify({ id: "other-holder", host: hostname(), pid: process.pid, processStart: "other", app: "TenuVault" }))
    const warning = await writer.releaseContainerLease(lockId)
    expect(warning).toBeDefined()
    expect(warning).toContain("備")
    expect(warning).toContain(lockPath)

    // Clean release returns undefined warning.
    rmSync(lockPath, { force: true })
    const cleanId = await writer.acquireContainerLease()
    expect(await writer.releaseContainerLease(cleanId)).toBeUndefined()
  })

  it("4721701725: waits for an in-flight put rename on a protected prefix before lock acquisition returns", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-inflight-put-")); roots.push(root)
    const storeA = new LocalBlobStore(root, [MASTER])
    const storeB = new LocalBlobStore(root, [MASTER])
    await storeA.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const repPrefix = "backup-2026-10-12-120000/"
    await storeA.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":1}'), "application/json")

    let renameStarted!: () => void
    const onRenameStart = new Promise<void>(resolve => { renameStarted = resolve })
    let allowRename!: () => void
    const waitRename = new Promise<void>(resolve => { allowRename = resolve })

    vi.mocked(fsPromises.rename).mockImplementationOnce(async (from, to) => {
      renameStarted()
      await waitRename
      return actual.rename(from, to)
    })

    // Start a put on storeB; pause it after assertPrefixNotProtected, right at rename().
    const putPromise = storeB.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json")
    await onRenameStart

    // Start acquiring the retention lock protecting repPrefix on storeA.
    let lockResolved = false
    const lockPromise = storeA.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER, undefined, [repPrefix]).then(id => {
      lockResolved = true
      return id
    })

    // Give the event loop turns: lock acquisition MUST wait for the in-flight put to finish,
    // while new puts to repPrefix are already blocked.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(lockResolved).toBe(false)
    await expect(storeB.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}DeviceConfigurations/new.json`, Buffer.from("{}"), "application/json"))
      .rejects.toBeInstanceOf(BlobProtectedError)

    // Allow the in-flight rename to commit.
    allowRename()
    await putPromise
    const lockId = await lockPromise
    try {
      // Final read under the lock is guaranteed to observe the committed v2 manifest.
      const read = await storeA.get(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`)
      expect(read.data.toString()).toBe('{"v":2}')
    } finally {
      await storeA.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, lockId)
    }
  })

  it("4721701734: recovers quarantined files safely without hard links (exFAT), never overwrites an occupied live name, and resumes after copy crash", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-retired-no-hardlinks-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const prefix = "backup-2026-10-12-120000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from('{"Status":"Success","exfat":1}'), "application/json")
    const tvbFile = readdirSync(dir).find(f => f.endsWith(".tvb"))!

    const noHardLinkError = () => Object.assign(new Error("Operation not permitted"), { code: "EPERM" })
    vi.mocked(fsPromises.link).mockRejectedValue(noHardLinkError())

    const oldTime = (Date.now() - 120_000) / 1000
    try {
      // Case A: live is absent -> exclusive create + copy + fsync restores live and removes held.
      const retired1 = join(dir, ".retired-exfat1")
      mkdirSync(retired1)
      renameSync(join(dir, tvbFile), join(retired1, tvbFile))
      const stamp1 = join(retired1, ".quarantined")
      writeFileSync(stamp1, "")
      utimesSync(stamp1, oldTime, oldTime)
      utimesSync(retired1, oldTime, oldTime)

      const damage1 = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damage1.files).toEqual([])
      expect(existsSync(retired1)).toBe(false)
      expect(existsSync(join(dir, tvbFile))).toBe(true)
      expect((await store.get(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`)).data.toString()).toBe('{"Status":"Success","exfat":1}')

      // Case B: crash after copy+fsync before rm(held) -> live and held have identical encrypted bytes -> resumes cleanly.
      const retired2 = join(dir, ".retired-exfat2")
      mkdirSync(retired2)
      writeFileSync(join(retired2, tvbFile), readFileSync(join(dir, tvbFile)))
      const stamp2 = join(retired2, ".quarantined")
      writeFileSync(stamp2, "")
      utimesSync(stamp2, oldTime, oldTime)
      utimesSync(retired2, oldTime, oldTime)

      const damage2 = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damage2.files).toEqual([])
      expect(existsSync(retired2)).toBe(false)
      expect(existsSync(join(dir, tvbFile))).toBe(true)

      // Case C: live is occupied by a DIFFERENT file -> open("wx") never overwrites live and damage is reported.
      const retired3 = join(dir, ".retired-exfat3")
      mkdirSync(retired3)
      writeFileSync(join(retired3, tvbFile), readFileSync(join(dir, tvbFile)))
      await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from('{"Status":"Success","exfat":2}'), "application/json")
      const stamp3 = join(retired3, ".quarantined")
      writeFileSync(stamp3, "")
      utimesSync(stamp3, oldTime, oldTime)
      utimesSync(retired3, oldTime, oldTime)

      const damage3 = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damage3.files).toHaveLength(1)
      expect(damage3.files[0]!.file).toBe(`.retired-exfat3/${tvbFile}`)
      expect(existsSync(join(retired3, tvbFile))).toBe(true)
      // Live file was NOT overwritten with held copy.
      rmSync(retired3, { recursive: true, force: true })
      expect((await store.get(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`)).data.toString()).toBe('{"Status":"Success","exfat":2}')
    } finally {
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })
})

describe("round 5b reclaim gate", () => {
  const STALE_PID = 4321

  function reuseReader(pause?: { wait: Promise<void>; reached: () => void }): ProcessInfoReader {
    return {
      isPidAlive: pid => pid === process.pid || pid === STALE_PID,
      readProcessStart: async pid => {
        if (pid === process.pid) return "ps:own-start"
        if (pause) {
          pause.reached()
          await pause.wait
        }
        return "ps:new-start"
      },
    }
  }

  function writeStaleLock(lockPath: string) {
    writeFileSync(lockPath, JSON.stringify({ id: "stale-S", host: hostname(), pid: STALE_PID, processStart: "ps:old-start", app: "TenuVault" }))
  }

  it("4721713622 and 4721717681: a delayed reclaimer that judged the old stale lock never moves the new holder's live lock", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-reclaim-gate-")); roots.push(root)
    const first = new LocalBlobStore(root, [MASTER], undefined, reuseReader())
    await first.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    writeStaleLock(lockPath)

    // R2 observes stale S and pauses while judging its holder.
    let reached!: () => void
    const reachedPromise = new Promise<void>(resolve => { reached = resolve })
    let resume!: () => void
    const wait = new Promise<void>(resolve => { resume = resolve })
    const delayed = new LocalBlobStore(root, [MASTER], undefined, reuseReader({ wait, reached }))
    const delayedAcquire = delayed.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    // Attach a handler now; asserted below.
    const delayedOutcome = delayedAcquire.then(id => ({ id }), (error: unknown) => ({ error }))
    await reachedPromise

    // R1 reclaims S under the gate and a new holder N publishes its live lock.
    const holderId = await first.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(holderId)
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false)

    // Count any attempt to move the live lock file from here on.
    let lockRenames = 0
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      if (String(from) === lockPath) lockRenames++
      return actual.rename(from, to)
    })
    try {
      // R2 resumes with its stale judgment of S. Under the gate it re-reads the lock,
      // sees N instead of S, and must not rename N's lock aside.
      resume()
      const outcome = await delayedOutcome
      expect(outcome).toMatchObject({ error: expect.any(BlobLeaseConflictError) })
      expect(lockRenames).toBe(0)
      expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(holderId)
      expect(readdirSync(dir).filter(f => f.includes(".stale"))).toEqual([])
      expect(existsSync(`${lockPath}.reclaim`)).toBe(false)

      // A third instance still gets a conflict while N holds the lock.
      const third = new LocalBlobStore(root, [MASTER], undefined, reuseReader())
      await expect(third.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toBeInstanceOf(BlobLeaseConflictError)
      expect(lockRenames).toBe(0)
    } finally {
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
      await first.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, holderId)
    }
  })

  it("4721740763: a holder past its ownership check keeps the lock while a delayed reclaimer and a third instance are refused", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-reclaim-gate-delete-")); roots.push(root)
    const holder = new LocalBlobStore(root, [MASTER], undefined, reuseReader())
    await holder.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    const prefix = "backup-2026-08-01-020000/"
    await holder.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await holder.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await holder.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")
    const blob = (await holder.get(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`)).blob
    writeStaleLock(lockPath)

    let reached!: () => void
    const reachedPromise = new Promise<void>(resolve => { reached = resolve })
    let resume!: () => void
    const wait = new Promise<void>(resolve => { resume = resolve })
    const delayed = new LocalBlobStore(root, [MASTER], undefined, reuseReader({ wait, reached }))
    const delayedOutcome = delayed.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      .then(id => ({ id }), (error: unknown) => ({ error }))
    await reachedPromise

    // N reclaims S and holds the lock.
    const holderId = await holder.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)

    // Pause N's delete after its final ownership check, with the quarantine rename pending.
    let renamePending!: () => void
    const renamePendingPromise = new Promise<void>(resolve => { renamePending = resolve })
    let allowRename!: () => void
    const renameWait = new Promise<void>(resolve => { allowRename = resolve })
    let lockRenames = 0
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      if (String(from) === lockPath) lockRenames++
      if (String(to).includes(".retired-")) {
        renamePending()
        await renameWait
      }
      return actual.rename(from, to)
    })
    try {
      const deleting = holder.delete(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, { ifMatch: blob.etag, retentionLockId: holderId })
      const deleteOutcome = deleting.then(() => ({ ok: true }), (error: unknown) => ({ error }))
      await renamePendingPromise

      // The delayed reclaimer resumes now, while N's rename is still pending.
      resume()
      const outcome = await delayedOutcome
      expect(outcome).toMatchObject({ error: expect.any(BlobLeaseConflictError) })
      expect(lockRenames).toBe(0)
      expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(holderId)

      // No third instance can acquire and overlap N's in-flight delete.
      const third = new LocalBlobStore(root, [MASTER], undefined, reuseReader())
      await expect(third.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toBeInstanceOf(BlobLeaseConflictError)

      allowRename()
      expect(await deleteOutcome).toEqual({ ok: true })
      expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(holderId)
    } finally {
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
      await holder.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, holderId)
    }
  })

  it("gate staleness: a dead same-host gate is reclaimed and a foreign-host gate warns naming the gate path", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-reclaim-gate-stale-")); roots.push(root)
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    const gatePath = `${lockPath}.reclaim`

    // Stale lock plus a gate left by a dead same-host reclaimer: both are reclaimed.
    writeFileSync(lockPath, JSON.stringify({ id: "stale-S", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" }))
    writeFileSync(gatePath, JSON.stringify({ id: "dead-gate", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" }))
    const id = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(id)
    expect(existsSync(gatePath)).toBe(false)
    await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, id)

    // Stale lock plus a foreign-host gate: manual warning naming the gate, nothing moved.
    const staleLock = JSON.stringify({ id: "stale-S2", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" })
    const foreignGate = JSON.stringify({ id: "foreign-gate", host: "other-computer", pid: deadPid, processStart: "dead", app: "TenuVault" })
    writeFileSync(lockPath, staleLock)
    writeFileSync(gatePath, foreignGate)
    const failure = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(BlobLeaseConflictError)
    expect((failure as BlobLeaseConflictError).code).toBe("RetentionLockManualIntervention")
    expect((failure as BlobLeaseConflictError).lockPath).toBe(gatePath)
    expect((failure as Error).message).toContain(gatePath)
    expect(readFileSync(lockPath, "utf8")).toBe(staleLock)
    expect(readFileSync(gatePath, "utf8")).toBe(foreignGate)
  })

  it("4721742279: cleanup preserves the candidate when an in-flight write from another store instance changes the replacement", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-inflight-cleanup-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    const otherStore = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const old = "backup-2026-08-01-020000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${old}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${old}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${old}metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")
    const newestPrefix = "backup-2026-10-12-120000/"

    let renameStarted!: () => void
    const renameStartedPromise = new Promise<void>(resolve => { renameStarted = resolve })
    let allowRename!: () => void
    const renameWait = new Promise<void>(resolve => { allowRename = resolve })
    vi.mocked(fsPromises.rename).mockImplementationOnce(async (from, to) => {
      renameStarted()
      await renameWait
      return actual.rename(from, to)
    })
    // A write from another instance passes its guard check (no guard yet) and pauses at rename.
    const inFlight = otherStore.put(ACCOUNT, BACKUP_CONTAINER, `${newestPrefix}metadata.json`, Buffer.from('{"Status":"Success","Tampered":true}'), "application/json")
    const inFlightOutcome = inFlight.then(() => ({ ok: true }), (error: unknown) => ({ error }))
    await renameStartedPromise

    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (!localAccountFromUrl(url)) return withBackupServerTime(Response.json({ value: [] }), NOW)
      return handleLocalBlobRequest(store, req)
    }
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, now: () => NOW })
    const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
    const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
    const finished = engine.waitForJob(job).then(() => "finished" as const)
    // Retention must wait at lock acquisition for the in-flight write, so the job cannot
    // finish while the rename is paused. Give it ample time to (wrongly) finish without the fix.
    const early = await Promise.race([finished, new Promise<"waiting">(resolve => setTimeout(() => resolve("waiting"), 3000))])
    expect(early).toBe("waiting")
    allowRename()
    expect(await inFlightOutcome).toEqual({ ok: true })
    await finished
    expect(job.status).toBe("Completed")
    // The replacement changed before deletion, so the expired candidate is preserved.
    expect(job.log.join("\n")).toContain("changed before deletion")
    expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old)).map(b => b.name)).toContain(`${old}metadata.json`)
  }, 30_000)
})

describe("round 6 findings", () => {
  it("P2 1: restores the candidate file and stops cleanup if an external process changes a replacement between rename and rm", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r6-p2-1-")); roots.push(root)
    const externalRoot = mkdtempSync(join(tmpdir(), "tv-r6-p2-1-ext-")); roots.push(externalRoot)
    const store = new LocalBlobStore(root, [MASTER])
    const externalStore = new LocalBlobStore(externalRoot, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    await externalStore.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const extDir = join(externalRoot, ACCOUNT, BACKUP_CONTAINER)
    const old = "backup-2026-08-01-020000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${old}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${old}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${old}metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    const newestPrefix = "backup-2026-10-12-120000/"
    // Prepare a modified replacement file in an independent store with the same key and container,
    // simulating an external process overwriting the replacement's metadata.json on disk.
    await externalStore.put(ACCOUNT, BACKUP_CONTAINER, `${newestPrefix}metadata.json`, Buffer.from('{"Status":"Success","External":"changed"}'), "application/json")
    const repTvbFile = readdirSync(extDir).find(f => f.endsWith(".tvb"))!
    const extTvbBytes = readFileSync(join(extDir, repTvbFile))

    let tampered = false
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      await actual.rename(from, to)
      if (!tampered && String(to).includes(".retired-")) {
        tampered = true
        // External process overwrites the replacement's .tvb file AFTER rename(path, held) and BEFORE rm(held).
        const staged = join(dir, `${repTvbFile}.ext.tmp`)
        writeFileSync(staged, extTvbBytes)
        renameSync(staged, join(dir, repTvbFile))
      }
    })
    try {
      const fetchImpl: typeof fetch = async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        if (!localAccountFromUrl(url)) return withBackupServerTime(Response.json({ value: [] }), NOW)
        return handleLocalBlobRequest(store, req)
      }
      const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, now: () => NOW })
      const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
      const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
      await engine.waitForJob(job)
      expect(job.status).toBe("Completed")
      expect(tampered).toBe(true)
      expect(job.results?.notices).toContainEqual(expect.objectContaining({
        level: "warning",
        message: expect.stringContaining("changed before deletion"),
      }))
      // Every file of the expired candidate must still exist on disk and be restored cleanly.
      const remaining = (await store.list(ACCOUNT, BACKUP_CONTAINER, old)).map(b => b.name)
      expect(remaining).toContain(`${old}metadata.json`)
      expect(remaining).toContain(`${old}DeviceConfigurations/Old.json`)
      expect(remaining).toContain(`${old}${BACKUP_OWNER_FILE}`)
      expect(readdirSync(dir).filter(f => f.startsWith(".retired-"))).toEqual([])
    } finally {
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
    }
  })

  it("P2 2: live reclaim gate throws holderId and gatePath and escalates after 3 consecutive runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-r6-p2-2-live-")); roots.push(root)
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!
    const liveGatePid = 54321
    const reader: ProcessInfoReader = {
      isPidAlive: pid => pid === process.pid || pid === liveGatePid,
      readProcessStart: async pid => (pid === process.pid ? "ps:own" : pid === liveGatePid ? "ps:live-gate" : "gone"),
    }
    const store = new LocalBlobStore(root, [MASTER], undefined, reader)
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    const gatePath = `${lockPath}.reclaim`
    const old = "backup-2026-08-01-020000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${old}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${old}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${old}metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    writeFileSync(lockPath, JSON.stringify({ id: "stale-lock", host: hostname(), pid: deadPid, processStart: "ps:dead", app: "TenuVault" }))
    writeFileSync(gatePath, JSON.stringify({ id: "live-gate-holder", host: hostname(), pid: liveGatePid, processStart: "ps:live-gate", app: "TenuVault" }))

    const directError = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER).then(() => null, (err: unknown) => err)
    expect(directError).toBeInstanceOf(BlobLeaseConflictError)
    expect(directError).toMatchObject({
      code: "LeaseAlreadyPresent",
      lockPath: gatePath,
      holderId: "live-gate-holder",
    })

    const progressMap = new Map<string, string>()
    const progress: RetentionProgressStore = {
      get: key => progressMap.get(key) ?? null,
      set: (key, value) => { progressMap.set(key, value) },
      delete: key => { progressMap.delete(key) },
    }
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (!localAccountFromUrl(url)) return withBackupServerTime(Response.json({ value: [] }), NOW)
      return handleLocalBlobRequest(store, req)
    }
    const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
    let tick = 0
    const engine = new BackupEngine({
      fetch: fetchImpl,
      getToken: async () => "token",
      retentionDays: () => 30,
      retentionProgress: progress,
      now: () => new Date(NOW.getTime() + tick++ * 1000),
    })

    for (let run = 1; run <= 3; run++) {
      const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
      await engine.waitForJob(job)
      expect(job.status).toBe("Completed")
      const notices = job.results?.notices.map(n => n.message).join("\n") ?? ""
      if (run < 3) {
        expect(notices).not.toContain("3 consecutive runs")
      } else {
        expect(notices).toContain("3 consecutive runs")
        expect(notices).toContain(gatePath)
      }
    }
    expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old)).map(b => b.name)).toContain(`${old}metadata.json`)
  })

  it("P2 2: retries reclaim gate release once, warns on failure, and reclaims own leaked gate on the next acquire", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r6-p2-2-leak-")); roots.push(root)
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!
    const reader: ProcessInfoReader = {
      isPidAlive: pid => pid === process.pid,
      readProcessStart: async pid => (pid === process.pid ? "ps:own" : "gone"),
    }
    const store = new LocalBlobStore(root, [MASTER], undefined, reader)
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    const gatePath = `${lockPath}.reclaim`

    // Part A: transient rename error on gate release succeeds on the single retry without warning.
    writeFileSync(lockPath, JSON.stringify({ id: "stale-1", host: hostname(), pid: deadPid, processStart: "ps:dead", app: "TenuVault" }))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    let gateReleaseRenames = 0
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      if (String(from) === gatePath) {
        gateReleaseRenames++
        if (gateReleaseRenames === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" })
      }
      return actual.rename(from, to)
    })
    try {
      const id1 = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      expect(gateReleaseRenames).toBe(2)
      expect(existsSync(gatePath)).toBe(false)
      expect(warnSpy).not.toHaveBeenCalled()
      await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, id1)

      // Part B: both gate release attempts fail -> warns and leaves our gate on disk; next acquire reclaims it.
      writeFileSync(lockPath, JSON.stringify({ id: "stale-2", host: hostname(), pid: deadPid, processStart: "ps:dead", app: "TenuVault" }))
      gateReleaseRenames = 0
      vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
        if (String(from) === gatePath) {
          gateReleaseRenames++
          throw Object.assign(new Error("busy"), { code: "EBUSY" })
        }
        return actual.rename(from, to)
      })
      const id2 = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      expect(gateReleaseRenames).toBe(2)
      expect(existsSync(gatePath)).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(gatePath), expect.any(Error))
      await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, id2)

      // Restore rename and write another stale lock: next acquire in this process reclaims our own leaked gate.
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
      writeFileSync(lockPath, JSON.stringify({ id: "stale-3", host: hostname(), pid: deadPid, processStart: "ps:dead", app: "TenuVault" }))
      const id3 = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      expect(existsSync(gatePath)).toBe(false)
      expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(id3)
      await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, id3)
    } finally {
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
      warnSpy.mockRestore()
    }
  })

  it("P2 3: hard-link-free recovery replaces a 0-byte or partial-prefix live file after a crash, while preserving conflicts and links", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r6-p2-3-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const prefix = "backup-2026-10-12-120000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from('{"Status":"Success","round":6}'), "application/json")
    const tvbFile = readdirSync(dir).find(f => f.endsWith(".tvb"))!
    const fullBytes = readFileSync(join(dir, tvbFile))
    const oldTime = (Date.now() - 120_000) / 1000

    vi.mocked(fsPromises.link).mockRejectedValue(Object.assign(new Error("Operation not permitted"), { code: "EPERM" }))
    try {
      // Case 1: crash right after open("wx") leaves a 0-byte live file.
      const retiredZero = join(dir, ".retired-zero1")
      mkdirSync(retiredZero)
      renameSync(join(dir, tvbFile), join(retiredZero, tvbFile))
      writeFileSync(join(retiredZero, ".quarantined"), "")
      utimesSync(join(retiredZero, ".quarantined"), oldTime, oldTime)
      utimesSync(retiredZero, oldTime, oldTime)
      writeFileSync(join(dir, tvbFile), Buffer.alloc(0))

      const damageZero = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damageZero.files).toEqual([])
      expect(existsSync(retiredZero)).toBe(false)
      expect(readFileSync(join(dir, tvbFile)).equals(fullBytes)).toBe(true)
      expect((await store.get(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`)).data.toString()).toBe('{"Status":"Success","round":6}')

      // Case 2: crash mid-copy leaves a strict byte prefix of held at live.
      const retiredPartial = join(dir, ".retired-part1")
      mkdirSync(retiredPartial)
      renameSync(join(dir, tvbFile), join(retiredPartial, tvbFile))
      writeFileSync(join(retiredPartial, ".quarantined"), "")
      utimesSync(join(retiredPartial, ".quarantined"), oldTime, oldTime)
      utimesSync(retiredPartial, oldTime, oldTime)
      writeFileSync(join(dir, tvbFile), fullBytes.subarray(0, Math.floor(fullBytes.length / 2)))

      const damagePartial = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damagePartial.files).toEqual([])
      expect(existsSync(retiredPartial)).toBe(false)
      expect(readFileSync(join(dir, tvbFile)).equals(fullBytes)).toBe(true)
      expect((await store.get(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`)).data.toString()).toBe('{"Status":"Success","round":6}')

      // Case 3: live is a shorter file that is NOT a byte prefix of held -> conflict reported, live untouched.
      const retiredDiff = join(dir, ".retired-diff2")
      mkdirSync(retiredDiff)
      renameSync(join(dir, tvbFile), join(retiredDiff, tvbFile))
      writeFileSync(join(retiredDiff, ".quarantined"), "")
      utimesSync(join(retiredDiff, ".quarantined"), oldTime, oldTime)
      utimesSync(retiredDiff, oldTime, oldTime)
      writeFileSync(join(dir, tvbFile), Buffer.from("not-a-prefix"))

      const damageDiff = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damageDiff.files.some(f => f.file === `.retired-diff2/${tvbFile}`)).toBe(true)
      expect(readFileSync(join(dir, tvbFile)).toString()).toBe("not-a-prefix")
      rmSync(join(dir, tvbFile), { force: true })

      // Case 4: live is a symlink to a 0-byte file -> lstat rejects link, conflict stays reported.
      const linkTarget = join(root, "zero-target")
      writeFileSync(linkTarget, Buffer.alloc(0))
      symlinkSync(linkTarget, join(dir, tvbFile))
      const damageLink = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damageLink.files.some(f => f.file === `.retired-diff2/${tvbFile}`)).toBe(true)
      expect(readFileSync(linkTarget).length).toBe(0)
    } finally {
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })
})
