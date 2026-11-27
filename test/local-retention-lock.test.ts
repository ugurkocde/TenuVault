import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine, NetworkCircuit } from "../src/main/backup/engine"
import { BlobLeaseError, BlobWriter } from "../src/main/backup/blob-writer"
import { permanentLeaseFailureWarning } from "../src/main/backup/retention-lease"
import { readRetentionProgress, type RetentionProgressStore } from "../src/main/backup/retention-progress"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import {
  BlobDeleteInterruptedError,
  BlobLeaseConflictError,
  BlobLeaseUnsupportedError,
  BlobProtectedError,
  BlobQuarantinedError,
  compareProcessStart,
  createProcessInfoReader,
  hardLinksUnsupportedWarning,
  IncompleteInventoryError,
  LocalBlobStore,
  parseDarwinPsStart,
  parseWindowsCreationDate,
  processStartKind,
  waitForLocalRetentionGuardRegistration,
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
    lstat: vi.fn(actual.lstat),
    rename: vi.fn(actual.rename),
    link: vi.fn(actual.link),
    open: vi.fn(actual.open),
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
    rm: vi.fn(actual.rm),
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

    const events: string[] = []
    vi.mocked(fsPromises.rename).mockImplementationOnce(async (from, to) => {
      renameStarted()
      await waitRename
      const result = await actual.rename(from, to)
      events.push("put-rename-committed")
      return result
    })

    // Start a put on storeB; pause it after assertPrefixNotProtected, right at rename().
    const putPromise = storeB.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json")
    await onRenameStart

    let lockId: string | undefined
    let lockPromise: Promise<string> | undefined
    try {
      // Synchronize explicitly on guard registration before asserting that lock acquisition
      // waits for the in-flight put while blocking new puts to repPrefix.
      const guardRegistered = waitForLocalRetentionGuardRegistration(join(root, ACCOUNT, BACKUP_CONTAINER))
      let cleanupStarted = false
      let cleanupDone!: () => void
      const onCleanupDone = new Promise<void>(resolve => { cleanupDone = resolve })
      let lockResolved = false
      lockPromise = storeA.acquireRetentionLock(
        ACCOUNT,
        BACKUP_CONTAINER,
        undefined,
        [repPrefix],
        undefined,
        async cleanup => {
          cleanupStarted = true
          events.push("lock-cleanup-started")
          await cleanup()
          cleanupDone()
        },
      ).then(id => {
        lockResolved = true
        events.push("lock-resolved")
        return id
      })

      await guardRegistered
      await expect(storeB.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}DeviceConfigurations/new.json`, Buffer.from("{}"), "application/json"))
        .rejects.toBeInstanceOf(BlobProtectedError)
      if (cleanupStarted) {
        await onCleanupDone
        await lockPromise
      }
      expect(cleanupStarted).toBe(false)
      expect(lockResolved).toBe(false)
      expect(events).toEqual([])

      // Allow the in-flight rename to commit.
      allowRename()
      await putPromise
      lockId = await lockPromise
      expect(events).toEqual(["put-rename-committed", "lock-cleanup-started", "lock-resolved"])
      // Final read under the lock is guaranteed to observe the committed v2 manifest.
      const read = await storeA.get(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`)
      expect(read.data.toString()).toBe('{"v":2}')
    } finally {
      allowRename()
      const [, lockResult] = await Promise.allSettled([putPromise, ...(lockPromise ? [lockPromise] : [])])
      const resolvedLockId = lockId ?? (lockResult?.status === "fulfilled" ? (lockResult.value as string) : undefined)
      if (resolvedLockId) await storeA.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, resolvedLockId).catch(() => undefined)
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
    }
  })

  it("4721701734: existing quarantined files without hard links (exFAT) never create new copies, resolve identical live copies, and keep both on conflict", async () => {
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
      // Case A: live is absent -> never creates a new copy; keeps held untouched and reports damage.
      const retired1 = join(dir, ".retired-exfat1")
      mkdirSync(retired1)
      renameSync(join(dir, tvbFile), join(retired1, tvbFile))
      const stamp1 = join(retired1, ".quarantined")
      writeFileSync(stamp1, "")
      utimesSync(stamp1, oldTime, oldTime)
      utimesSync(retired1, oldTime, oldTime)

      const damage1 = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damage1.files).toHaveLength(1)
      expect(damage1.files[0]!.file).toBe(`.retired-exfat1/${tvbFile}`)
      expect(damage1.files[0]!.reason).toContain("does not support hard links")
      expect(existsSync(join(retired1, tvbFile))).toBe(true)
      expect(existsSync(join(dir, tvbFile))).toBe(false)

      // Move held back to live to test occupied-live cases without creating copies.
      renameSync(join(retired1, tvbFile), join(dir, tvbFile))
      rmSync(retired1, { recursive: true, force: true })

      // Case B: live and held have identical encrypted bytes -> reconciles by removing held without copying.
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

      // Case C: live is occupied by a DIFFERENT file -> never overwrites live and keeps both files.
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

  it("gate staleness: a dead same-host gate is never auto-reclaimed and warns naming the gate path, like a foreign-host gate", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-reclaim-gate-stale-")); roots.push(root)
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!
    const storeA = new LocalBlobStore(root, [MASTER])
    const storeB = new LocalBlobStore(root, [MASTER])
    await storeA.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    const gatePath = `${lockPath}.reclaim`

    // Stale lock plus a gate left by a dead same-host reclaimer: two concurrent reclaimers must
    // both skip with the named manual warning, and neither the gate nor the lock may be moved.
    const staleLock1 = JSON.stringify({ id: "stale-S", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" })
    const deadGate = JSON.stringify({ id: "dead-gate", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" })
    writeFileSync(lockPath, staleLock1)
    writeFileSync(gatePath, deadGate)
    let renames = 0
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      if (String(from) === gatePath || String(from) === lockPath) renames++
      return actual.rename(from, to)
    })
    try {
      const [errA, errB] = await Promise.all([
        storeA.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER).then(() => null, (error: unknown) => error),
        storeB.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER).then(() => null, (error: unknown) => error),
      ])
      for (const failure of [errA, errB]) {
        expect(failure).toBeInstanceOf(BlobLeaseConflictError)
        expect((failure as BlobLeaseConflictError).code).toBe("RetentionLockManualIntervention")
        expect((failure as BlobLeaseConflictError).lockPath).toBe(gatePath)
        expect((failure as Error).message).toContain(gatePath)
        expect((failure as Error).message).toContain("Stop any TenuVault process on this computer")
      }
      expect(renames).toBe(0)
      expect(readFileSync(lockPath, "utf8")).toBe(staleLock1)
      expect(readFileSync(gatePath, "utf8")).toBe(deadGate)
    } finally {
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
    }

    // Stale lock plus a foreign-host gate: manual warning naming the gate, nothing moved.
    const staleLock = JSON.stringify({ id: "stale-S2", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" })
    const foreignGate = JSON.stringify({ id: "foreign-gate", host: "other-computer", pid: deadPid, processStart: "dead", app: "TenuVault" })
    writeFileSync(lockPath, staleLock)
    writeFileSync(gatePath, foreignGate)
    const failure = await storeA.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER).then(() => null, (error: unknown) => error)
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

  it("4722421526: hard-link-free recovery never overwrites a 0-byte, partial-prefix, or concurrently written live file and reports both paths", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r6-p2-3-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const prefix = "backup-2026-10-12-120000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from('{"Status":"Success","round":7}'), "application/json")
    const tvbFile = readdirSync(dir).find(f => f.endsWith(".tvb"))!
    const livePath = join(dir, tvbFile)
    const fullBytes = readFileSync(livePath)
    const oldTime = (Date.now() - 120_000) / 1000

    vi.mocked(fsPromises.link).mockRejectedValue(Object.assign(new Error("Operation not permitted"), { code: "EPERM" }))
    try {
      // Case 1: 0-byte file at live -> never overwritten; held kept and conflict names both paths.
      const retiredZero = join(dir, ".retired-zero1")
      const heldZero = join(retiredZero, tvbFile)
      mkdirSync(retiredZero)
      renameSync(livePath, heldZero)
      writeFileSync(join(retiredZero, ".quarantined"), "")
      utimesSync(join(retiredZero, ".quarantined"), oldTime, oldTime)
      utimesSync(retiredZero, oldTime, oldTime)
      writeFileSync(livePath, Buffer.alloc(0))

      const damageZero = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damageZero.files).toHaveLength(1)
      expect(damageZero.files[0]!.file).toBe(`.retired-zero1/${tvbFile}`)
      expect(damageZero.files[0]!.reason).toContain(heldZero)
      expect(damageZero.files[0]!.reason).toContain(livePath)
      expect(existsSync(heldZero)).toBe(true)
      expect(readFileSync(livePath).length).toBe(0)
      rmSync(retiredZero, { recursive: true, force: true })

      // Case 2: partial-prefix file at live (e.g. crash or concurrent writer) -> never overwritten; held kept and both paths named.
      const retiredPartial = join(dir, ".retired-part1")
      const heldPartial = join(retiredPartial, tvbFile)
      mkdirSync(retiredPartial)
      writeFileSync(heldPartial, fullBytes)
      writeFileSync(join(retiredPartial, ".quarantined"), "")
      utimesSync(join(retiredPartial, ".quarantined"), oldTime, oldTime)
      utimesSync(retiredPartial, oldTime, oldTime)
      const partialBytes = fullBytes.subarray(0, Math.floor(fullBytes.length / 2))
      writeFileSync(livePath, partialBytes)

      const damagePartial = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damagePartial.files.some(f => f.file === `.retired-part1/${tvbFile}` && f.reason.includes(heldPartial) && f.reason.includes(livePath))).toBe(true)
      expect(existsSync(heldPartial)).toBe(true)
      expect(readFileSync(livePath).equals(partialBytes)).toBe(true)
      rmSync(retiredPartial, { recursive: true, force: true })

      // Case 3: live is a different file -> conflict reported with both paths, live untouched.
      const retiredDiff = join(dir, ".retired-diff2")
      const heldDiff = join(retiredDiff, tvbFile)
      mkdirSync(retiredDiff)
      writeFileSync(heldDiff, fullBytes)
      writeFileSync(join(retiredDiff, ".quarantined"), "")
      utimesSync(join(retiredDiff, ".quarantined"), oldTime, oldTime)
      utimesSync(retiredDiff, oldTime, oldTime)
      writeFileSync(livePath, Buffer.from("not-a-prefix"))

      const damageDiff = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damageDiff.files.some(f => f.file === `.retired-diff2/${tvbFile}` && f.reason.includes(heldDiff) && f.reason.includes(livePath))).toBe(true)
      expect(readFileSync(livePath).toString()).toBe("not-a-prefix")
      rmSync(livePath, { force: true })

      // Case 4: live is a symlink to a 0-byte file -> never overwritten, conflict stays reported.
      const linkTarget = join(root, "zero-target")
      writeFileSync(linkTarget, Buffer.alloc(0))
      symlinkSync(linkTarget, livePath)
      const damageLink = await store.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(damageLink.files.some(f => f.file === `.retired-diff2/${tvbFile}` && f.reason.includes(heldDiff) && f.reason.includes(livePath))).toBe(true)
      expect(readFileSync(linkTarget).length).toBe(0)
    } finally {
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })
})


describe("round 7 findings", () => {
  it("4722421520: with an unstealable gate held, lock check and move complete without interleaving from another reclaimer", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r7-gate-serial-")); roots.push(root)
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!
    const storeA = new LocalBlobStore(root, [MASTER])
    const storeB = new LocalBlobStore(root, [MASTER])
    await storeA.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    const gatePath = `${lockPath}.reclaim`
    writeFileSync(lockPath, JSON.stringify({ id: "stale-S", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" }))

    let lockMoveReached!: () => void
    const onLockMove = new Promise<void>(resolve => { lockMoveReached = resolve })
    let allowLockMove!: () => void
    const waitLockMove = new Promise<void>(resolve => { allowLockMove = resolve })
    let gateRenames = 0
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      if (String(from) === gatePath && String(to).endsWith(".stale")) gateRenames++
      if (String(from) === lockPath && String(to).endsWith(".stale")) {
        lockMoveReached()
        await waitLockMove
      }
      return actual.rename(from, to)
    })
    let lockIdA: string | undefined
    let acquireA: Promise<string> | undefined
    try {
      acquireA = storeA.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      await onLockMove
      // A holds the gate and has checked the lock; B arrives now and must not move the gate or lock.
      const errB = await storeB.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER).then(() => null, (error: unknown) => error)
      expect(errB).toBeInstanceOf(BlobLeaseConflictError)
      expect((errB as BlobLeaseConflictError).code).toBe("LeaseAlreadyPresent")
      expect((errB as BlobLeaseConflictError).lockPath).toBe(gatePath)
      expect(gateRenames).toBe(0)

      allowLockMove()
      lockIdA = await acquireA
      expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(lockIdA)
      expect(existsSync(gatePath)).toBe(false)
    } finally {
      allowLockMove()
      const [resultA] = await Promise.allSettled(acquireA ? [acquireA] : [])
      const resolvedLockIdA = lockIdA ?? (resultA?.status === "fulfilled" ? resultA.value : undefined)
      if (resolvedLockIdA) await storeA.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, resolvedLockIdA).catch(() => undefined)
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
    }
  })

  it("4722421496: persists the bound ETag after copy-fallback restore so a later healthy run resumes partial deletion", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r7-restored-etag-")); roots.push(root)
    const externalRoot = mkdtempSync(join(tmpdir(), "tv-r7-restored-etag-ext-")); roots.push(externalRoot)
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
    const preRestoreEtag = (await store.get(ACCOUNT, BACKUP_CONTAINER, `${old}DeviceConfigurations/Old.json`)).blob.etag

    const firstRunPrefix = "backup-2026-10-12-120000/"
    await externalStore.put(ACCOUNT, BACKUP_CONTAINER, `${firstRunPrefix}metadata.json`, Buffer.from('{"Status":"Success","External":"changed"}'), "application/json")
    const repTvbFile = readdirSync(extDir).find(f => f.endsWith(".tvb"))!
    const extTvbBytes = readFileSync(join(extDir, repTvbFile))

    const progressData = new Map<string, string>()
    const progress: RetentionProgressStore = {
      get: key => progressData.get(key) ?? null,
      set: (key, value) => { progressData.set(key, value) },
      delete: key => { progressData.delete(key) },
    }
    const progressKey = `${TENANT}/${ACCOUNT}`

    // Mutate replacement on the 2nd quarantine rename (payload Old.json, after metadata.json was already deleted).
    let quarantineRenames = 0
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      await actual.rename(from, to)
      if (String(to).includes(".retired-")) {
        quarantineRenames++
        if (quarantineRenames === 2) {
          const staged = join(dir, `${repTvbFile}.ext.tmp`)
          writeFileSync(staged, extTvbBytes)
          renameSync(staged, join(dir, repTvbFile))
        }
      }
    })
    try {
      let currentNow = NOW
      const fetchImpl: typeof fetch = async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        if (!localAccountFromUrl(url)) return withBackupServerTime(Response.json({ value: [] }), currentNow)
        return handleLocalBlobRequest(store, req)
      }
      const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
      const engine = new BackupEngine({
        fetch: fetchImpl,
        getToken: async () => "token",
        retentionDays: () => 30,
        retentionProgress: progress,
        now: () => currentNow,
      })

      const job1 = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
      await engine.waitForJob(job1)
      expect(job1.status).toBe("Completed")
      expect(quarantineRenames).toBe(2)

      // metadata.json is gone, Old.json was restored with a bound ETag,
      // and the deletion journal recorded that exact bound ETag.
      const savedAfterStop = readRetentionProgress(progressData.get(progressKey))
      const journal = savedAfterStop.deletes?.[old]
      expect(journal).toBeDefined()
      const currentOldEtag = (await store.get(ACCOUNT, BACKUP_CONTAINER, `${old}DeviceConfigurations/Old.json`)).blob.etag
      expect(currentOldEtag).not.toBe(preRestoreEtag)
      expect(journal!.remaining[`${old}DeviceConfigurations/Old.json`]).toBe(currentOldEtag)

      // Next run creates a fresh healthy newest backup -> partial deletion resumes cleanly!
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
      currentNow = new Date(NOW.getTime() + 60_000)
      const job2 = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
      await engine.waitForJob(job2)
      expect(job2.status).toBe("Completed")
      expect(await store.list(ACCOUNT, BACKUP_CONTAINER, old)).toEqual([])
      expect(readRetentionProgress(progressData.get(progressKey)).deletes?.[old]).toBeUndefined()
    } finally {
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
    }
  })

  it("4722421489: releases an accepted lease (Azure and local) when the job deadline expires before request() returns", async () => {
    // 1. Azure blob lease accepted right as the job deadline elapses -> released before rethrowing.
    let fakeNow = 1_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow)
    try {
      const released: Array<{ action: string | null; leaseId: string | null }> = []
      const azureFetch: typeof fetch = async (_input, init) => {
        const headers = new Headers(init?.headers)
        const action = headers.get("x-ms-lease-action")
        if (action === "acquire") {
          // Cross the deadline right as storage accepts the lease; signal is still un-aborted inside read().
          fakeNow = 1_000_500
          return new Response(null, { status: 201, headers: { "x-ms-lease-id": "accepted-azure-lease" } })
        }
        if (action === "release") {
          released.push({ action, leaseId: headers.get("x-ms-lease-id") })
          return new Response(null, { status: 200 })
        }
        return new Response(null, { status: 200 })
      }
      const network = new NetworkCircuit(3, undefined, 1_000_100)
      const azureWriter = new BlobWriter(azureFetch, "contoso", async () => "token", network)
      await expect(azureWriter.acquireLease("backup-2026-10-12-120000/metadata.json", 60)).rejects.toThrow(/timed out|deadline/i)
      expect(released).toEqual([{ action: "release", leaseId: "accepted-azure-lease" }])

      // 2. Local container retention lock accepted right as the job deadline elapses -> lock file and guard are cleaned up.
      const root = mkdtempSync(join(tmpdir(), "tv-r7-deadline-local-")); roots.push(root)
      const store = new LocalBlobStore(root, [MASTER])
      await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const lockPath = join(root, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")
      const repPrefix = "backup-2026-10-12-120000/"
      fakeNow = 2_000_000
      const localFetch: typeof fetch = async (input, init) => {
        const req = new Request(input, init)
        const res = await handleLocalBlobRequest(store, req)
        if (req.headers.get("x-ms-lease-action") === "acquire" && res.ok) {
          fakeNow = 2_000_500
        }
        return res
      }
      const localNetwork = new NetworkCircuit(3, undefined, 2_000_100)
      const localWriter = new BlobWriter(localFetch, ACCOUNT, async () => "", localNetwork)
      await expect(localWriter.acquireContainerLease([repPrefix])).rejects.toThrow(/timed out|deadline/i)
      expect(existsSync(lockPath)).toBe(false)
      await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}check.json`, Buffer.from("{}"), "application/json")).resolves.toBeDefined()
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe("round 8 findings", () => {
  it("P2.1: leftover .partial files from earlier runs are kept untouched and reported with keep-both guidance", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-r8-partial-keep-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const prefix = "backup-2026-10-12-120000/"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from('{"Status":"Success","round":8}'), "application/json")
    const tvbFile = readdirSync(dir).find(f => f.endsWith(".tvb"))!
    const livePath = join(dir, tvbFile)
    const partialName = `${tvbFile}.deadbeef12345678.partial`
    const partialPath = join(dir, partialName)
    writeFileSync(partialPath, Buffer.from("leftover-aside-bytes"))

    const damage = await new LocalBlobStore(root, [MASTER]).damage(ACCOUNT, BACKUP_CONTAINER)
    expect(existsSync(partialPath)).toBe(true)
    expect(existsSync(livePath)).toBe(true)
    const entry = damage.files.find(f => f.file === partialName)
    expect(entry).toBeDefined()
    expect(entry!.reason).toContain(`Keep both files (${livePath} and ${partialPath})`)
  })

  it("P2.2: conflict warning and delete-blocked error name both paths with plain resolution steps, and deleting partial live restores the backup on next scan", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r8-resolve-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const backupId = "backup-2026-08-01-020000"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    const entries = await (store as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
    const payloadFile = entries.get(`${backupId}/DeviceConfigurations/Old.json`)!.file
    const livePath = join(dir, payloadFile)
    const fullBytes = readFileSync(livePath)
    const retired = join(dir, ".retired-conflict1")
    const heldPath = join(retired, payloadFile)
    const oldTime = (Date.now() - 120_000) / 1000
    mkdirSync(retired)
    renameSync(livePath, heldPath)
    writeFileSync(join(retired, ".quarantined"), "")
    utimesSync(join(retired, ".quarantined"), oldTime, oldTime)
    utimesSync(retired, oldTime, oldTime)
    // Crash left a smaller partial file at livePath.
    writeFileSync(livePath, fullBytes.subarray(0, Math.floor(fullBytes.length / 2)))

    try {
      const fresh = new LocalBlobStore(root, [MASTER])
      const damage = await fresh.damage(ACCOUNT, BACKUP_CONTAINER)
      const conflictEntry = damage.files.find(f => f.file === `.retired-conflict1/${payloadFile}`)
      expect(conflictEntry).toBeDefined()
      const expectedStep = `Close TenuVault on every computer that uses this backup folder. Then copy the backup folder somewhere safe, then delete the file at ${livePath}. TenuVault then restores it from ${heldPath} on the next start.`
      expect(conflictEntry!.reason).toContain(expectedStep)

      await expect(fresh.get(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).rejects.toThrow(expectedStep)
      await expect(fresh.delete(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).rejects.toThrow(expectedStep)

      // Follow the plain instruction: delete the smaller partial live file and rescan.
      rmSync(livePath)
      const afterDelete = new LocalBlobStore(root, [MASTER])
      const resolvedDamage = await afterDelete.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(resolvedDamage.files).toEqual([])
      expect(resolvedDamage.unavailable.size).toBe(0)
      expect(existsSync(heldPath)).toBe(false)
      expect(existsSync(retired)).toBe(false)
      expect((await afterDelete.get(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`)).data.toString()).toBe(JSON.stringify(OLD_ITEM))
      expect((await afterDelete.list(ACCOUNT, BACKUP_CONTAINER, `${backupId}/`)).length).toBe(3)
    } finally {
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })

  it("P2.4: scopes recovery-conflict delete blocks to the conflicted backup while keeping unrelated backups, restores, imports, and retention working", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r8-scoped-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)

    const oldCovered = "backup-2026-08-01-020000"
    const oldUncovered = "backup-2026-08-05-020000"
    const conflicted = "backup-2026-09-25-020000"
    const complianceItem = { id: "comp-1" }
    const complianceManifest = {
      TenantId: TENANT,
      Status: "Success",
      Failures: 0,
      Scope: { Included: ["CompliancePolicies"] },
      Items: {
        "CompliancePolicies/comp-1": { file: "Comp.json", hash: snapshotHash(complianceItem), sha256: sha256(complianceItem) },
      },
      ItemCounts: { CompliancePolicies: 1, TotalPolicies: 1 },
    }

    // 1. Expired backup holding only DeviceConfigurations (covered by the new run).
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${oldCovered}/DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${oldCovered}/${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${oldCovered}/metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    // 2. Expired backup holding CompliancePolicies (only the conflicted backup newer than it has CompliancePolicies).
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${oldUncovered}/CompliancePolicies/Comp.json`, Buffer.from(JSON.stringify(complianceItem)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${oldUncovered}/${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${oldUncovered}/metadata.json`, Buffer.from(JSON.stringify(complianceManifest)), "application/json")

    // 3. Newer backup holding CompliancePolicies that suffers an exFAT partial-copy recovery conflict.
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${conflicted}/CompliancePolicies/Comp.json`, Buffer.from(JSON.stringify(complianceItem)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${conflicted}/${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${conflicted}/metadata.json`, Buffer.from(JSON.stringify(complianceManifest)), "application/json")

    const entries = await (store as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
    const conflictFile = entries.get(`${conflicted}/CompliancePolicies/Comp.json`)!.file
    const livePath = join(dir, conflictFile)
    const fullBytes = readFileSync(livePath)
    const retired = join(dir, ".retired-scope1")
    const heldPath = join(retired, conflictFile)
    const oldTime = (Date.now() - 120_000) / 1000
    mkdirSync(retired)
    renameSync(livePath, heldPath)
    writeFileSync(join(retired, ".quarantined"), "")
    utimesSync(join(retired, ".quarantined"), oldTime, oldTime)
    utimesSync(retired, oldTime, oldTime)
    writeFileSync(livePath, fullBytes.subarray(0, Math.floor(fullBytes.length / 2)))

    try {
      const fresh = new LocalBlobStore(root, [MASTER])

      // Direct deletes touching the conflicted backup (either as target or as expected replacement) fail closed with both paths.
      await expect(fresh.delete(ACCOUNT, BACKUP_CONTAINER, `${conflicted}/metadata.json`)).rejects.toThrow(IncompleteInventoryError)
      await expect(fresh.delete(ACCOUNT, BACKUP_CONTAINER, `${oldUncovered}/metadata.json`, {
        expectedReplacements: [{ prefix: `${conflicted}/`, blobs: { [`${conflicted}/metadata.json`]: '"etag"' } }],
      })).rejects.toThrow(livePath)

      // Healthy backups remain readable and new puts/imports work.
      expect((await fresh.get(ACCOUNT, BACKUP_CONTAINER, `${oldUncovered}/CompliancePolicies/Comp.json`)).data.toString()).toBe(JSON.stringify(complianceItem))
      const imported = "backup-2026-10-01-020000"
      await fresh.put(ACCOUNT, BACKUP_CONTAINER, `${imported}/metadata.json`, Buffer.from('{"Status":"Success"}'), "application/json")
      expect((await fresh.get(ACCOUNT, BACKUP_CONTAINER, `${imported}/metadata.json`)).data.toString()).toBe('{"Status":"Success"}')
      await fresh.delete(ACCOUNT, BACKUP_CONTAINER, `${imported}/metadata.json`)

      // End-to-end BackupEngine run covering only DeviceConfigurations:
      // - oldCovered IS removed (covered by the healthy new backup)
      // - oldUncovered is KEPT (conflicted backup cannot supply CompliancePolicies coverage)
      // - conflicted is KEPT with a warning naming both paths and plain steps
      const fetchImpl: typeof fetch = async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        if (!localAccountFromUrl(url)) return withBackupServerTime(Response.json({ value: [] }), NOW)
        return handleLocalBlobRequest(fresh, req)
      }
      const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
      const engine = new BackupEngine({
        fetch: fetchImpl,
        getToken: async () => "token",
        retentionDays: () => 30,
        now: () => NOW,
      })
      const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
      await engine.waitForJob(job)
      expect(job.status).toBe("Completed")
      const log = job.log.join("\n")
      expect(log).toContain(livePath)
      expect(log).toContain(heldPath)
      expect(log).toContain("Close TenuVault on every computer that uses this backup folder. Then copy the backup folder somewhere safe")
      expect(await fresh.list(ACCOUNT, BACKUP_CONTAINER, `${oldCovered}/`)).toEqual([])
      expect((await fresh.list(ACCOUNT, BACKUP_CONTAINER, `${oldUncovered}/`)).length).toBe(3)
      expect(existsSync(heldPath)).toBe(true)

      // Mixed damage (conflict + unrelated corrupted file) still blocks all deletes in the folder.
      const otherFile = entries.get(`${oldUncovered}/CompliancePolicies/Comp.json`)!.file
      const damaged = Buffer.from(readFileSync(join(dir, otherFile)))
      damaged[6] = damaged[6]! ^ 0xff
      writeFileSync(join(dir, otherFile), damaged)
      const mixedStore = new LocalBlobStore(root, [MASTER])
      await expect(mixedStore.delete(ACCOUNT, BACKUP_CONTAINER, "backup-2026-10-12-120000/metadata.json")).rejects.toThrow("Nothing in the backup folder is deleted")
    } finally {
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })

  it("4722441339: literal interleaving where createNew creates a 0-byte live claim, recovery starts, and the new file is published leaves live untouched and keeps held", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r8-interleave-")); roots.push(root)
    const storeSetup = new LocalBlobStore(root, [MASTER])
    const storeWriter = new LocalBlobStore(root, [MASTER])
    const storeRecovery = new LocalBlobStore(root, [MASTER])
    await storeSetup.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const prefix = "backup-2026-10-12-120000/"
    await storeSetup.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from('{"Status":"Success","v":"held"}'), "application/json")
    const tvbFile = readdirSync(dir).find(f => f.endsWith(".tvb"))!
    const livePath = join(dir, tvbFile)
    const heldBytes = readFileSync(livePath)

    // Move original file into an aged quarantine so livePath is free for createNew.
    const retired = join(dir, ".retired-race1")
    const heldPath = join(retired, tvbFile)
    const oldTime = (Date.now() - 120_000) / 1000
    mkdirSync(retired)
    renameSync(livePath, heldPath)
    writeFileSync(join(retired, ".quarantined"), "")
    utimesSync(join(retired, ".quarantined"), oldTime, oldTime)
    utimesSync(retired, oldTime, oldTime)

    let claimCreated!: () => void
    const onClaimCreated = new Promise<void>(resolve => { claimCreated = resolve })
    let allowPublish!: () => void
    const waitPublish = new Promise<void>(resolve => { allowPublish = resolve })
    let recoveryHitLive!: () => void
    const onRecoveryHitLive = new Promise<void>(resolve => { recoveryHitLive = resolve })
    let allowRecoveryContinue!: () => void
    const waitRecoveryContinue = new Promise<void>(resolve => { allowRecoveryContinue = resolve })

    vi.mocked(fsPromises.link).mockRejectedValue(Object.assign(new Error("Operation not permitted"), { code: "EPERM" }))
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      if (String(to) === livePath && String(from).endsWith(".tmp")) {
        claimCreated()
        await waitPublish
      }
      return actual.rename(from, to)
    })
    let hitLiveCheck = false
    vi.mocked(fsPromises.lstat).mockImplementation(async (file, options) => {
      const result = await actual.lstat(file as never, options as never)
      if (!hitLiveCheck && String(file) === livePath && existsSync(heldPath)) {
        hitLiveCheck = true
        recoveryHitLive()
        await waitRecoveryContinue
      }
      return result
    })

    let putPromise: Promise<unknown> | undefined
    let recoveryPromise: Promise<unknown> | undefined
    try {
      // Stage the aged quarantine folder outside dir while storeWriter runs entries(),
      // pause at claimCreated (0-byte livePath exists), then move retired into place and start storeRecovery.
      const stagedRetired = join(root, ".retired-race1")
      renameSync(retired, stagedRetired)

      const newPayload = '{"Status":"Success","v":"published-by-createNew"}'
      putPromise = storeWriter.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from(newPayload), "application/json", true)
      await onClaimCreated
      // Right now createNew has created the 0-byte claim at livePath and has not renamed tmp onto it yet.
      expect(existsSync(livePath)).toBe(true)
      expect(readFileSync(livePath).length).toBe(0)

      // Place the aged quarantine folder in dir and start recovery while livePath is the 0-byte claim.
      renameSync(stagedRetired, retired)
      utimesSync(join(retired, ".quarantined"), oldTime, oldTime)
      utimesSync(retired, oldTime, oldTime)
      recoveryPromise = storeRecovery.damage(ACCOUNT, BACKUP_CONTAINER)
      await onRecoveryHitLive

      // Now the writer publishes its completed file onto livePath, and recovery resumes.
      allowPublish()
      await putPromise
      allowRecoveryContinue()
      const damage = await recoveryPromise as Awaited<ReturnType<LocalBlobStore["damage"]>>

      // Assert: published file is completely untouched, held copy is kept, and conflict names both paths.
      expect(existsSync(heldPath)).toBe(true)
      expect(readFileSync(heldPath).equals(heldBytes)).toBe(true)
      expect(damage.files.some(f => f.file === `.retired-race1/${tvbFile}` && f.reason.includes(heldPath) && f.reason.includes(livePath))).toBe(true)
      // Remove the held folder to verify livePath holds the exact untouched published blob.
      rmSync(retired, { recursive: true, force: true })
      const verifyStore = new LocalBlobStore(root, [MASTER])
      expect((await verifyStore.get(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`)).data.toString()).toBe(newPayload)
    } finally {
      allowPublish()
      allowRecoveryContinue()
      await Promise.allSettled([putPromise, recoveryPromise].filter((p): p is Promise<unknown> => Boolean(p)))
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
      vi.mocked(fsPromises.lstat).mockImplementation(actual.lstat)
    }
  })

  it("P3.2: escalated reclaim gate warnings name the gate file rather than the lock file with safe stop instructions", () => {
    const gatePath = "/backups/.tenuvault-retention.lock.reclaim"
    const manual = permanentLeaseFailureWarning(true, 3, new BlobLeaseError(new Error("gate"), 409, "RetentionLockManualIntervention", gatePath))
    const sameHolder = permanentLeaseFailureWarning(true, 3, new BlobLeaseError(new Error("gate-held"), 409, "LeaseAlreadyPresent", gatePath, "holder-gate"))
    for (const msg of [manual, sameHolder]) {
      expect(msg).toContain(gatePath)
      expect(msg).toContain("gate file")
      expect(msg).not.toContain("Delete the lock file")
      expect(msg).not.toContain("delete the lock file")
      expect(msg).toContain("Stop any TenuVault process on this computer that uses this backup folder")
      expect(msg).toContain("no other computer is running TenuVault on this backup folder")
    }
  })
})

describe("round 9 findings", () => {
  it("P1: smaller non-prefix live file gives keep-both text on scan and immediate delete-time conflict", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r9-p1-nonprefix-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const backupId = "backup-2026-08-01-020000"
    const largerPayload = JSON.stringify({ id: "old", padding: "x".repeat(512) })
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(largerPayload), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    const entries = await (store as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
    const payloadFile = entries.get(`${backupId}/DeviceConfigurations/Old.json`)!.file
    const livePath = join(dir, payloadFile)
    const retired = join(dir, ".retired-nonprefix1")
    const heldPath = join(retired, payloadFile)
    const oldTime = (Date.now() - 120_000) / 1000
    mkdirSync(retired)
    renameSync(livePath, heldPath)
    writeFileSync(join(retired, ".quarantined"), "")
    utimesSync(join(retired, ".quarantined"), oldTime, oldTime)
    utimesSync(retired, oldTime, oldTime)
    // A newer, legitimately smaller file at the same HMAC path (not a prefix of held).
    writeFileSync(livePath, Buffer.from("smaller-newer-non-prefix-bytes"))

    const expectedKeepBoth = `Keep both files (${livePath} and ${heldPath}), do not delete either, and contact support with both paths.`
    try {
      const fresh = new LocalBlobStore(root, [MASTER])
      const damage = await fresh.damage(ACCOUNT, BACKUP_CONTAINER)
      const conflictEntry = damage.files.find(f => f.file === `.retired-nonprefix1/${payloadFile}`)
      expect(conflictEntry?.conflict?.liveIsHeldPrefix).toBe(false)
      expect(conflictEntry!.reason).toContain(expectedKeepBoth)
      expect(conflictEntry!.reason).not.toContain("delete the file at")
      expect(conflictEntry!.reason).not.toContain("smaller than")

      await expect(fresh.get(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).rejects.toThrow(expectedKeepBoth)
      await expect(fresh.delete(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).rejects.toThrow(expectedKeepBoth)
      await expect(fresh.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from("{}"), "application/json")).rejects.toThrow(expectedKeepBoth)

      // Immediate delete-time conflict: smaller non-prefix file appears at live during rollback.
      rmSync(retired, { recursive: true, force: true })
      rmSync(livePath, { force: true })
      const delRoot = mkdtempSync(join(tmpdir(), "tv-r9-p1-del-nonprefix-")); roots.push(delRoot)
      const delStore = new LocalBlobStore(delRoot, [MASTER])
      await delStore.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const delDir = join(delRoot, ACCOUNT, BACKUP_CONTAINER)
      const repId = "backup-2026-10-12-120000"
      await delStore.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(largerPayload), "application/json")
      await delStore.put(ACCOUNT, BACKUP_CONTAINER, `${repId}/metadata.json`, Buffer.from('{"Status":"Success"}'), "application/json")
      const delEntries = await (delStore as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string; etag: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
      const delFile = delEntries.get(`${backupId}/DeviceConfigurations/Old.json`)!.file
      const delLive = join(delDir, delFile)
      let quarantineHeld = ""
      vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
        await actual.rename(from, to)
        if (String(from) === delLive && String(to).includes(".retired-")) {
          quarantineHeld = String(to)
          writeFileSync(delLive, Buffer.from("newer-smaller-file"))
        }
      })
      const delErr = await delStore.delete(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, {
        despiteDamage: true,
        expectedReplacements: [{ prefix: `${repId}/`, blobs: { [`${repId}/metadata.json`]: '"stale-etag"' } }],
      }).then(() => null, (error: unknown) => error)
      expect(delErr).toBeInstanceOf(BlobQuarantinedError)
      expect((delErr as Error).message).toContain(`Keep both files (${delLive} and ${quarantineHeld}), do not delete either, and contact support with both paths.`)
      expect((delErr as Error).message).not.toContain("delete the file at")
    } finally {
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })

  it("P1: smaller verified prefix live file gives copy-first delete text on scan and immediate delete-time conflict", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r9-p1-prefix-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const backupId = "backup-2026-08-01-020000"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    const entries = await (store as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
    const payloadFile = entries.get(`${backupId}/DeviceConfigurations/Old.json`)!.file
    const livePath = join(dir, payloadFile)
    const fullBytes = readFileSync(livePath)
    const retired = join(dir, ".retired-prefix1")
    const heldPath = join(retired, payloadFile)
    const oldTime = (Date.now() - 120_000) / 1000
    mkdirSync(retired)
    renameSync(livePath, heldPath)
    writeFileSync(join(retired, ".quarantined"), "")
    utimesSync(join(retired, ".quarantined"), oldTime, oldTime)
    utimesSync(retired, oldTime, oldTime)
    const prefixBytes = fullBytes.subarray(0, Math.floor(fullBytes.length / 2))
    writeFileSync(livePath, prefixBytes)

    const expectedDelete = `Close TenuVault on every computer that uses this backup folder. Then copy the backup folder somewhere safe, then delete the file at ${livePath}. TenuVault then restores it from ${heldPath} on the next start.`
    try {
      const fresh = new LocalBlobStore(root, [MASTER])
      const damage = await fresh.damage(ACCOUNT, BACKUP_CONTAINER)
      const conflictEntry = damage.files.find(f => f.file === `.retired-prefix1/${payloadFile}`)
      expect(conflictEntry?.conflict?.liveIsHeldPrefix).toBe(true)
      expect(conflictEntry!.reason).toContain(expectedDelete)
      expect(conflictEntry!.reason).not.toContain("smaller than")

      await expect(fresh.get(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).rejects.toThrow(expectedDelete)
      await expect(fresh.delete(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).rejects.toThrow(expectedDelete)
      await expect(fresh.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from("{}"), "application/json")).rejects.toThrow(expectedDelete)

      // Immediate delete-time conflict with verified prefix at live.
      const delRoot = mkdtempSync(join(tmpdir(), "tv-r9-p1-del-prefix-")); roots.push(delRoot)
      const delStore = new LocalBlobStore(delRoot, [MASTER])
      await delStore.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const delDir = join(delRoot, ACCOUNT, BACKUP_CONTAINER)
      const repId = "backup-2026-10-12-120000"
      await delStore.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
      await delStore.put(ACCOUNT, BACKUP_CONTAINER, `${repId}/metadata.json`, Buffer.from('{"Status":"Success"}'), "application/json")
      const delEntries = await (delStore as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
      const delFile = delEntries.get(`${backupId}/DeviceConfigurations/Old.json`)!.file
      const delLive = join(delDir, delFile)
      const delBytes = readFileSync(delLive)
      let quarantineHeld = ""
      vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
        await actual.rename(from, to)
        if (String(from) === delLive && String(to).includes(".retired-")) {
          quarantineHeld = String(to)
          writeFileSync(delLive, delBytes.subarray(0, Math.floor(delBytes.length / 2)))
        }
      })
      const delErr = await delStore.delete(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, {
        despiteDamage: true,
        expectedReplacements: [{ prefix: `${repId}/`, blobs: { [`${repId}/metadata.json`]: '"stale-etag"' } }],
      }).then(() => null, (error: unknown) => error)
      expect(delErr).toBeInstanceOf(BlobQuarantinedError)
      expect((delErr as Error).message).toContain(`Close TenuVault on every computer that uses this backup folder. Then copy the backup folder somewhere safe, then delete the file at ${delLive}. TenuVault then restores it from ${quarantineHeld} on the next start.`)
    } finally {
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })

  it("P1: live file changing between detection and cached use or scan completion falls back to keep-both", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r9-p1-reval-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const backupId = "backup-2026-08-01-020000"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    const entries = await (store as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
    const payloadFile = entries.get(`${backupId}/DeviceConfigurations/Old.json`)!.file
    const livePath = join(dir, payloadFile)
    const fullBytes = readFileSync(livePath)
    const retired = join(dir, ".retired-reval1")
    const heldPath = join(retired, payloadFile)
    const oldTime = (Date.now() - 120_000) / 1000
    mkdirSync(retired)
    renameSync(livePath, heldPath)
    writeFileSync(join(retired, ".quarantined"), "")
    utimesSync(join(retired, ".quarantined"), oldTime, oldTime)
    utimesSync(retired, oldTime, oldTime)
    writeFileSync(livePath, fullBytes.subarray(0, Math.floor(fullBytes.length / 2)))

    const expectedKeepBoth = `Keep both files (${livePath} and ${heldPath}), do not delete either, and contact support with both paths.`
    try {
      // Part A: Detection caches liveIsHeldPrefix=true; live is overwritten in-place (dir mtime unchanged)
      // before cached get/delete/put use the stored conflict. All three must re-validate and fall back to keep-both.
      const cached = new LocalBlobStore(root, [MASTER])
      const initialDamage = await cached.damage(ACCOUNT, BACKUP_CONTAINER)
      const storedConflict = initialDamage.files.find(f => f.conflict)?.conflict
      expect(storedConflict?.liveIsHeldPrefix).toBe(true)

      // Overwrite live in-place so directory entries/mtime stay unchanged, keeping cached inventory active.
      writeFileSync(livePath, Buffer.from("changed-after-detection"))
      await expect(cached.get(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).rejects.toThrow(expectedKeepBoth)
      await expect(cached.delete(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).rejects.toThrow(expectedKeepBoth)
      await expect(cached.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from("{}"), "application/json")).rejects.toThrow(expectedKeepBoth)
      expect(storedConflict?.liveIsHeldPrefix).toBe(false)

      // Part B: live is a verified prefix during conflict detection in recoverRetired, then mutates
      // before readIndex/damage finishes scanning. damage() must re-validate and fall back to keep-both.
      writeFileSync(livePath, fullBytes.subarray(0, Math.floor(fullBytes.length / 2)))
      let mutatedMidScan = false
      vi.mocked(fsPromises.readFile).mockImplementation((async (file: unknown, options: unknown) => {
        const result = await actual.readFile(file as never, options as never)
        // Mutate live when readIndex reads metadata.json (after recoverRetired already detected the prefix conflict).
        if (!mutatedMidScan && String(file).startsWith(dir) && String(file).endsWith(".tvb") && String(file) !== livePath && !String(file).includes(".retired-")) {
          mutatedMidScan = true
          writeFileSync(livePath, Buffer.from("mutated-mid-scan"))
        }
        return result
      }) as typeof actual.readFile)
      const midScanStore = new LocalBlobStore(root, [MASTER])
      const midScanDamage = await midScanStore.damage(ACCOUNT, BACKUP_CONTAINER)
      expect(mutatedMidScan).toBe(true)
      const midConflict = midScanDamage.files.find(f => f.file === `.retired-reval1/${payloadFile}`)
      expect(midConflict?.conflict?.liveIsHeldPrefix).toBe(false)
      expect(midConflict!.reason).toContain(expectedKeepBoth)
      expect(midConflict!.reason).not.toContain("delete the file at")
    } finally {
      vi.mocked(fsPromises.readFile).mockImplementation(actual.readFile)
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })

  it("P1: storage docs order close-first then copy then delete and qualify retention pause for scoped conflicts", () => {
    const doc = readFileSync(join(process.cwd(), "docs-site/src/content/docs/backups/storage.md"), "utf8")
    const start = doc.indexOf("### Recover files from interrupted cleanup")
    expect(start).toBeGreaterThan(-1)
    const end = doc.indexOf("\n## ", start)
    const section = doc.slice(start, end > start ? end : undefined)
    const closeIdx = section.indexOf("Close TenuVault on every computer that uses this backup folder")
    const copyIdx = section.indexOf("Copy the backup folder, including the `.retired-*` folder, to a safe location")
    const deleteIdx = section.indexOf("delete that live file")
    expect(closeIdx).toBeGreaterThan(-1)
    expect(copyIdx).toBeGreaterThan(closeIdx)
    expect(deleteIdx).toBeGreaterThan(copyIdx)
    expect(section).toContain("If TenuVault tells you it is safe to delete the file at the live path")
    expect(section).toContain("If TenuVault tells you to keep both files, do not delete either file and contact support with both paths.")
    expect(section).not.toMatch(/smaller than/i)
    expect(section).not.toMatch(/compare the two/i)

    const pauseLines = doc.split("\n").filter(line => line.includes("Retention is paused"))
    expect(pauseLines.length).toBeGreaterThanOrEqual(2)
    for (const line of pauseLines) {
      expect(line).toContain("recovery conflict after interrupted cleanup")
      expect(line).toContain("deletes that touch the conflicted backup are blocked")
      expect(line).toContain("retention of unrelated expired backups continues")
    }
  })
})

describe("round 10 findings", () => {
  it("4723063824: DELETE never reports success while a scan-restored manifest is live, and scan treats ENOENT on rm(held) after linking as interrupted", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const oldTime = (Date.now() - 120_000) / 1000

    // Subcase A: DELETE pauses after quarantine rename (before its pre-rm checks), scan links
    // held -> live and pauses before its own rm(held). DELETE resumes and must fail with
    // BlobDeleteInterruptedError without removing held; scan then finishes cleanly.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-r10-del-race-a-")); roots.push(root)
      const storeDelete = new LocalBlobStore(root, [MASTER])
      const storeScan = new LocalBlobStore(root, [MASTER])
      await storeDelete.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
      const backupId = "backup-2026-08-01-020000"
      await storeDelete.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")
      await storeDelete.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
      const entries = await (storeDelete as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
      const manifestFile = entries.get(`${backupId}/metadata.json`)!.file
      const livePath = join(dir, manifestFile)

      let heldPath = ""
      let quarantineDir = ""
      let deletePaused!: () => void
      const onDeletePaused = new Promise<void>(resolve => { deletePaused = resolve })
      let allowDeleteResume!: () => void
      const waitDeleteResume = new Promise<void>(resolve => { allowDeleteResume = resolve })
      let scanLinked!: () => void
      const onScanLinked = new Promise<void>(resolve => { scanLinked = resolve })
      let allowScanRm!: () => void
      const waitScanRm = new Promise<void>(resolve => { allowScanRm = resolve })

      vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
        await actual.rename(from, to)
        if (String(from) === livePath && String(to).includes(".retired-")) {
          heldPath = String(to)
          quarantineDir = dirname(heldPath)
          utimesSync(join(quarantineDir, ".quarantined"), oldTime, oldTime)
          utimesSync(quarantineDir, oldTime, oldTime)
          deletePaused()
          await waitDeleteResume
        }
      })
      vi.mocked(fsPromises.link).mockImplementation(async (existing, next) => {
        const res = await actual.link(existing, next)
        if (String(existing) === heldPath && String(next) === livePath) {
          scanLinked()
          await waitScanRm
        }
        return res
      })

      let delPromise: Promise<unknown> | undefined
      let scanPromise: Promise<unknown> | undefined
      try {
        delPromise = storeDelete.delete(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, { despiteDamage: true })
        await onDeletePaused

        scanPromise = storeScan.damage(ACCOUNT, BACKUP_CONTAINER)
        await onScanLinked
        expect(existsSync(livePath)).toBe(true)
        expect(existsSync(heldPath)).toBe(true)

        allowDeleteResume()
        await expect(delPromise).rejects.toBeInstanceOf(BlobDeleteInterruptedError)
        expect(existsSync(livePath)).toBe(true)

        allowScanRm()
        const damage = await scanPromise as Awaited<ReturnType<LocalBlobStore["damage"]>>
        expect(damage.files).toEqual([])
        expect(existsSync(livePath)).toBe(true)
        const verify = new LocalBlobStore(root, [MASTER])
        expect((await verify.get(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).data.toString()).toBe(JSON.stringify(ONE_ITEM_MANIFEST))
      } finally {
        allowDeleteResume()
        allowScanRm()
        await Promise.allSettled([delPromise, scanPromise].filter((p): p is Promise<unknown> => Boolean(p)))
        vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
        vi.mocked(fsPromises.link).mockImplementation(actual.link)
        vi.mocked(fsPromises.rm).mockImplementation(actual.rm)
      }
    }

    // Subcase B: DELETE has already passed its pre-rm check and pauses right at rm(held);
    // scan links held -> live and pauses before its own rm(held); DELETE then runs rm(held)
    // first. DELETE must STILL fail with BlobDeleteInterruptedError (because live is present),
    // and scan's subsequent rm(held) ENOENT must NOT be treated as complete/done.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-r10-del-race-b-")); roots.push(root)
      const storeDelete = new LocalBlobStore(root, [MASTER])
      const storeScan = new LocalBlobStore(root, [MASTER])
      await storeDelete.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
      const backupId = "backup-2026-08-01-020000"
      await storeDelete.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")
      await storeDelete.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
      const entries = await (storeDelete as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
      const manifestFile = entries.get(`${backupId}/metadata.json`)!.file
      const livePath = join(dir, manifestFile)

      let heldPath = ""
      let quarantineDir = ""
      let deleteAtRm!: () => void
      const onDeleteAtRm = new Promise<void>(resolve => { deleteAtRm = resolve })
      let allowDeleteRm!: () => void
      const waitDeleteRm = new Promise<void>(resolve => { allowDeleteRm = resolve })
      let scanLinked!: () => void
      const onScanLinked = new Promise<void>(resolve => { scanLinked = resolve })
      let allowScanRm!: () => void
      const waitScanRm = new Promise<void>(resolve => { allowScanRm = resolve })
      let rmCallCount = 0

      vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
        await actual.rename(from, to)
        if (String(from) === livePath && String(to).includes(".retired-")) {
          heldPath = String(to)
          quarantineDir = dirname(heldPath)
          utimesSync(join(quarantineDir, ".quarantined"), oldTime, oldTime)
          utimesSync(quarantineDir, oldTime, oldTime)
        }
      })
      vi.mocked(fsPromises.link).mockImplementation(async (existing, next) => {
        const res = await actual.link(existing, next)
        if (String(existing) === heldPath && String(next) === livePath) {
          scanLinked()
          await waitScanRm
        }
        return res
      })
      vi.mocked(fsPromises.rm).mockImplementation(async (target, options) => {
        if (String(target) === heldPath) {
          rmCallCount++
          if (rmCallCount === 1) {
            // First rm(held) is DELETE's rm(held): pause so scan can link held -> live first.
            deleteAtRm()
            await waitDeleteRm
          }
        }
        return actual.rm(target, options)
      })

      let delPromise: Promise<unknown> | undefined
      let scanPromise: Promise<unknown> | undefined
      try {
        delPromise = storeDelete.delete(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, { despiteDamage: true })
        await onDeleteAtRm

        scanPromise = storeScan.damage(ACCOUNT, BACKUP_CONTAINER)
        await onScanLinked
        expect(existsSync(livePath)).toBe(true)
        expect(existsSync(heldPath)).toBe(true)

        // Let DELETE's rm(held) execute while scan is paused between link() and rm(held).
        allowDeleteRm()
        await expect(delPromise).rejects.toBeInstanceOf(BlobDeleteInterruptedError)
        expect(existsSync(livePath)).toBe(true)
        expect(existsSync(heldPath)).toBe(false)

        // Now let scan's rm(held) run and observe ENOENT: scan must report interrupted, never done.
        allowScanRm()
        const damage = await scanPromise as Awaited<ReturnType<LocalBlobStore["damage"]>>
        expect(damage.files.length).toBeGreaterThan(0)
        expect(damage.unavailable.has(backupId)).toBe(true)
        expect(damage.files.some(f => f.reason.includes("interrupted"))).toBe(true)
        expect(existsSync(livePath)).toBe(true)
        const verify = new LocalBlobStore(root, [MASTER])
        expect((await verify.get(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`)).data.toString()).toBe(JSON.stringify(ONE_ITEM_MANIFEST))
      } finally {
        allowDeleteRm()
        allowScanRm()
        await Promise.allSettled([delPromise, scanPromise].filter((p): p is Promise<unknown> => Boolean(p)))
        vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
        vi.mocked(fsPromises.link).mockImplementation(actual.link)
        vi.mocked(fsPromises.rm).mockImplementation(actual.rm)
      }
    }
  })

  it("4723063813: aborting during readRetentionLockState does not consume leakedReclaimGates so a later acquire reclaims it", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r10-leaked-abort-")); roots.push(root)
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const lockPath = join(dir, ".tenuvault-retention.lock")
    const gatePath = `${lockPath}.reclaim`
    writeFileSync(lockPath, JSON.stringify({ id: "stale-1", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" }))

    // Step 1: Cause releaseReclaimGate to fail both rename attempts so this process leaks its gate.
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      if (String(from) === gatePath && String(to).endsWith(".release")) {
        throw Object.assign(new Error("EIO"), { code: "EIO" })
      }
      return actual.rename(from, to)
    })
    let lock1: string | undefined
    let lock3: string | undefined
    try {
      lock1 = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      expect(existsSync(gatePath)).toBe(true)
      await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, lock1)
      lock1 = undefined
      // Re-plant a stale lock so the next acquire enters reclaimStaleRetentionLock -> acquireReclaimGate.
      writeFileSync(lockPath, JSON.stringify({ id: "stale-2", host: hostname(), pid: deadPid, processStart: "dead", app: "TenuVault" }))
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)

      // Step 2: Abort while readRetentionLockState(gatePath) is pending.
      const controller = new AbortController()
      let abortedDuringRead = false
      vi.mocked(fsPromises.readFile).mockImplementation((async (file: unknown, options: unknown) => {
        const result = await actual.readFile(file as never, options as never)
        if (!abortedDuringRead && String(file) === gatePath) {
          abortedDuringRead = true
          controller.abort(new Error("aborted during gate read"))
        }
        return result
      }) as typeof actual.readFile)

      await expect(store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER, undefined, undefined, controller.signal)).rejects.toThrow("aborted during gate read")
      expect(abortedDuringRead).toBe(true)
      expect(existsSync(gatePath)).toBe(true)

      // Step 3: A subsequent non-aborted acquire must still recognize the leaked gate and reclaim it.
      vi.mocked(fsPromises.readFile).mockImplementation(actual.readFile)
      lock3 = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      expect(existsSync(gatePath)).toBe(false)
      expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(lock3)
    } finally {
      vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
      vi.mocked(fsPromises.readFile).mockImplementation(actual.readFile)
      if (lock1) await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, lock1).catch(() => undefined)
      if (lock3) await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, lock3).catch(() => undefined)
    }
  })

  it("4723063820: hard-link-capable volumes resolve byte-identical live copies in different inodes and still conflict when bytes differ or change", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r10-hardlink-ident-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const backupId = "backup-2026-08-01-020000"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    const entries = await (store as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
    const payloadFile = entries.get(`${backupId}/DeviceConfigurations/Old.json`)!.file
    const livePath = join(dir, payloadFile)
    const fullBytes = readFileSync(livePath)
    const oldTime = (Date.now() - 120_000) / 1000

    // Case 1: Byte-identical copy in a DIFFERENT inode on a hard-link-capable volume -> resolves cleanly.
    const retired1 = join(dir, ".retired-hlident1")
    const held1 = join(retired1, payloadFile)
    mkdirSync(retired1)
    renameSync(livePath, held1)
    writeFileSync(join(retired1, ".quarantined"), "")
    utimesSync(join(retired1, ".quarantined"), oldTime, oldTime)
    utimesSync(retired1, oldTime, oldTime)
    writeFileSync(livePath, fullBytes)
    expect(statSync(livePath).ino).not.toBe(statSync(held1).ino)

    const damage1 = await new LocalBlobStore(root, [MASTER]).damage(ACCOUNT, BACKUP_CONTAINER)
    expect(damage1.files).toEqual([])
    expect(existsSync(retired1)).toBe(false)
    expect((await new LocalBlobStore(root, [MASTER]).get(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`)).data.toString()).toBe(JSON.stringify(OLD_ITEM))

    // Case 2: Equal-length DIFFERENT bytes in a different inode -> conflict with keep-both guidance.
    const retired2 = join(dir, ".retired-hldiff1")
    const held2 = join(retired2, payloadFile)
    mkdirSync(retired2)
    renameSync(livePath, held2)
    writeFileSync(join(retired2, ".quarantined"), "")
    utimesSync(join(retired2, ".quarantined"), oldTime, oldTime)
    utimesSync(retired2, oldTime, oldTime)
    const altered = Buffer.from(fullBytes)
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 0xff
    writeFileSync(livePath, altered)

    const damage2 = await new LocalBlobStore(root, [MASTER]).damage(ACCOUNT, BACKUP_CONTAINER)
    expect(damage2.files.some(f => f.file === `.retired-hldiff1/${payloadFile}` && f.reason.includes("Keep both files"))).toBe(true)
    expect(existsSync(held2)).toBe(true)
    expect(readFileSync(livePath).equals(altered)).toBe(true)

    // Case 3: live is replaced while identicalLiveHeldInfo holds an open handle to the old copy ->
    // path recheck catches the change, held is NOT removed, and conflict is reported.
    rmSync(retired2, { recursive: true, force: true })
    writeFileSync(livePath, fullBytes)
    const retired3 = join(dir, ".retired-hlrace1")
    const held3 = join(retired3, payloadFile)
    mkdirSync(retired3)
    renameSync(livePath, held3)
    writeFileSync(join(retired3, ".quarantined"), "")
    utimesSync(join(retired3, ".quarantined"), oldTime, oldTime)
    utimesSync(retired3, oldTime, oldTime)
    writeFileSync(livePath, fullBytes)

    let mutatedAfterOpen = false
    vi.mocked(fsPromises.open).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags as never, mode as never)
      if (!mutatedAfterOpen && String(file) === livePath && String(flags) === "r") {
        mutatedAfterOpen = true
        const replacement = join(dir, `${payloadFile}.hlrace.tmp`)
        writeFileSync(replacement, altered)
        renameSync(replacement, livePath)
      }
      return handle
    })
    try {
      const damage3 = await new LocalBlobStore(root, [MASTER]).damage(ACCOUNT, BACKUP_CONTAINER)
      expect(mutatedAfterOpen).toBe(true)
      expect(existsSync(held3)).toBe(true)
      expect(readFileSync(livePath).equals(altered)).toBe(true)
      expect(damage3.files.some(f => f.file === `.retired-hlrace1/${payloadFile}`)).toBe(true)
    } finally {
      vi.mocked(fsPromises.open).mockImplementation(actual.open)
    }
  })
})

describe("round 12 findings", () => {
  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"] as const)(
    "no-hard-link volume (%s): skips local retention deletes with a named, escalating warning while backups, restores, and non-retention deletes keep working",
    async (code) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      const root = mkdtempSync(join(tmpdir(), `tv-r12-nohl-${code.toLowerCase()}-`)); roots.push(root)
      const store = new LocalBlobStore(root, [MASTER])
      await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
      const dir = join(root, ACCOUNT, BACKUP_CONTAINER)

      const old1 = "backup-2026-08-01-020000/"
      const old2 = "backup-2026-08-02-020000/"
      for (const prefix of [old1, old2]) {
        await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
        await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
        await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")
      }

      const progressData = new Map<string, string>()
      const progress: RetentionProgressStore = {
        get: key => progressData.get(key) ?? null,
        set: (key, value) => { progressData.set(key, value) },
        delete: key => { progressData.delete(key) },
      }
      const progressKey = `${TENANT}/${ACCOUNT}`

      let linkRefused = true
      vi.mocked(fsPromises.link).mockImplementation(async (existing, next) => {
        if (linkRefused) throw Object.assign(new Error(`${code}: hard links unsupported`), { code })
        return actual.link(existing, next)
      })
      try {
        // Direct acquireRetentionLock refuses with RetentionHardLinksUnsupported and leaves no lock or temp files.
        const err = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER).then(() => null, (e: unknown) => e)
        expect(err).toBeInstanceOf(BlobLeaseUnsupportedError)
        expect((err as BlobLeaseUnsupportedError).code).toBe("RetentionHardLinksUnsupported")
        expect((err as BlobLeaseUnsupportedError).lockPath).toBe(dir)
        expect(readdirSync(dir).filter(f => f.includes(".tenuvault-retention.lock"))).toEqual([])

        // Non-retention delete (such as archive rollback) still works on no-hard-link volumes.
        const tempBlob = "backup-2026-09-10-020000/metadata.json"
        const created = await store.put(ACCOUNT, BACKUP_CONTAINER, tempBlob, Buffer.from('{"Status":"Success"}'), "application/json", true)
        expect((await store.get(ACCOUNT, BACKUP_CONTAINER, tempBlob)).data.toString()).toBe('{"Status":"Success"}')
        await store.delete(ACCOUNT, BACKUP_CONTAINER, tempBlob, { despiteDamage: true, ifMatch: created.etag })
        expect(await store.list(ACCOUNT, BACKUP_CONTAINER, "backup-2026-09-10-020000/")).toEqual([])

        // Defense-in-depth: retention-locked delete also refuses when hardLinks is false.
        const lockPath = join(dir, ".tenuvault-retention.lock")
        writeFileSync(lockPath, JSON.stringify({ id: "manual-lock", host: hostname(), pid: process.pid, processStart: "ps:1", app: "TenuVault" }))
        const delErr = await store.delete(ACCOUNT, BACKUP_CONTAINER, `${old1}metadata.json`, { retentionLockId: "manual-lock" }).then(() => null, (e: unknown) => e)
        rmSync(lockPath, { force: true })
        expect(delErr).toBeInstanceOf(BlobLeaseUnsupportedError)
        expect((delErr as BlobLeaseUnsupportedError).code).toBe("RetentionHardLinksUnsupported")
        expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old1)).length).toBe(3)

        // End-to-end BackupEngine runs: backups & restores succeed, retention deletes nothing,
        // warning is emitted ONCE per run (not once per expired backup), and escalates on run 3.
        let clock = new Date(NOW.getTime())
        const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
        const fetchImpl: typeof fetch = async (input, init) => {
          const req = new Request(input, init)
          const url = new URL(req.url)
          if (!localAccountFromUrl(url)) return withBackupServerTime(Response.json({ value: [] }), clock)
          return handleLocalBlobRequest(store, req)
        }
        const runBackup = async () => {
          const engine = new BackupEngine({
            fetch: fetchImpl,
            getToken: async () => "token",
            retentionDays: () => 30,
            retentionProgress: progress,
            now: () => clock,
          })
          const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
          await engine.waitForJob(job)
          expect(job.status).toBe("Completed")
          clock = new Date(clock.getTime() + 2_000)
          return job
        }

        const run1 = await runBackup()
        const warn1 = run1.log.filter(line => line.includes("does not support hard links"))
        expect(warn1).toHaveLength(1)
        expect(warn1[0]).toContain(hardLinksUnsupportedWarning(dir))
        expect(warn1[0]).toContain("NTFS, APFS or ext4")
        expect(warn1[0]).toContain("Backups and restores keep working")
        expect(warn1[0]).toContain("moved to a drive that supports hard links")
        expect(warn1[0]).not.toContain("manually")
        expect(run1.log.join("\n")).not.toContain("local retention lock could not be acquired")
        expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old1)).length).toBe(3)
        expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old2)).length).toBe(3)
        // Old backup and newly created backup are both readable for restore.
        expect((await store.get(ACCOUNT, BACKUP_CONTAINER, `${old1}DeviceConfigurations/Old.json`)).data.toString()).toBe(JSON.stringify(OLD_ITEM))

        const run2 = await runBackup()
        const warn2 = run2.log.filter(line => line.includes("does not support hard links"))
        expect(warn2).toHaveLength(1)
        expect(warn2[0]).toContain(hardLinksUnsupportedWarning(dir))

        const run3 = await runBackup()
        const warn3 = run3.log.filter(line => line.includes("does not support hard links"))
        expect(warn3).toHaveLength(1)
        expect(warn3[0]).toContain(hardLinksUnsupportedWarning(dir, 3))
        expect(warn3[0]).toContain("3 consecutive runs")
        expect(readRetentionProgress(progressData.get(progressKey)).leaseFailures).toEqual({
          key: `local:no-hard-links:${dir}`,
          count: 3,
        })
        expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old1)).length).toBe(3)
        expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old2)).length).toBe(3)

        // Once moved to a hard-link-capable volume (fresh store instance with working link), retention succeeds and clears state.
        linkRefused = false
        const movedStore = new LocalBlobStore(root, [MASTER])
        const movedFetch: typeof fetch = async (input, init) => {
          const req = new Request(input, init)
          const url = new URL(req.url)
          if (!localAccountFromUrl(url)) return withBackupServerTime(Response.json({ value: [] }), clock)
          return handleLocalBlobRequest(movedStore, req)
        }
        const engineMoved = new BackupEngine({
          fetch: movedFetch,
          getToken: async () => "token",
          retentionDays: () => 30,
          retentionProgress: progress,
          now: () => clock,
        })
        const run4 = engineMoved.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, scope })
        await engineMoved.waitForJob(run4)
        expect(run4.status).toBe("Completed")
        expect(await movedStore.list(ACCOUNT, BACKUP_CONTAINER, old1)).toEqual([])
        expect(await movedStore.list(ACCOUNT, BACKUP_CONTAINER, old2)).toEqual([])
        expect(readRetentionProgress(progressData.get(progressKey)).leaseFailures).toBeUndefined()
      } finally {
        linkRefused = false
        vi.mocked(fsPromises.link).mockImplementation(actual.link)
      }
    },
  )

  it("existing quarantined file on a no-hard-link volume with a prefix live file uses keep-both guidance and never advises deleting live", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r12-nohl-prefix-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)
    const backupId = "backup-2026-08-01-020000"
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(ACCOUNT, BACKUP_CONTAINER, `${backupId}/metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    const entries = await (store as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(ACCOUNT, BACKUP_CONTAINER)
    const payloadFile = entries.get(`${backupId}/DeviceConfigurations/Old.json`)!.file
    const livePath = join(dir, payloadFile)
    const fullBytes = readFileSync(livePath)
    const retired = join(dir, ".retired-nohlpref")
    const heldPath = join(retired, payloadFile)
    const oldTime = (Date.now() - 120_000) / 1000
    mkdirSync(retired)
    renameSync(livePath, heldPath)
    writeFileSync(join(retired, ".quarantined"), "")
    utimesSync(join(retired, ".quarantined"), oldTime, oldTime)
    utimesSync(retired, oldTime, oldTime)
    writeFileSync(livePath, fullBytes.subarray(0, Math.floor(fullBytes.length / 2)))

    vi.mocked(fsPromises.link).mockRejectedValue(Object.assign(new Error("Operation not permitted"), { code: "EPERM" }))
    try {
      const damage = await new LocalBlobStore(root, [MASTER]).damage(ACCOUNT, BACKUP_CONTAINER)
      const conflictEntry = damage.files.find(f => f.file === `.retired-nohlpref/${payloadFile}`)
      expect(conflictEntry?.conflict?.liveIsHeldPrefix).toBe(false)
      expect(conflictEntry!.reason).toContain(`Keep both files (${livePath} and ${heldPath}), do not delete either, and contact support with both paths.`)
      expect(conflictEntry!.reason).not.toContain("delete the file at")
    } finally {
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })

  it("4723504745: removes an aged stamp-only quarantine under the retention lock, while refusing recent, unreadable, unlocked, or newly-populated quarantines", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-r12-empty-q-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const dir = join(root, ACCOUNT, BACKUP_CONTAINER)

    const rep = "backup-2026-10-12-120000/"
    const old1 = "backup-2026-08-01-020000/"
    const old2 = "backup-2026-08-02-020000/"
    const repBlob = await store.put(ACCOUNT, BACKUP_CONTAINER, `${rep}metadata.json`, Buffer.from('{"Status":"Success"}'), "application/json")
    const old1Blob = await store.put(ACCOUNT, BACKUP_CONTAINER, `${old1}metadata.json`, Buffer.from('{"Status":"Success"}'), "application/json")
    const old2Blob = await store.put(ACCOUNT, BACKUP_CONTAINER, `${old2}metadata.json`, Buffer.from('{"Status":"Success"}'), "application/json")
    const expectedReplacements = [{ prefix: rep, blobs: { [`${rep}metadata.json`]: repBlob.etag! } }]
    const oldTime = (Date.now() - 120_000) / 1000

    // Case 1: Aged stamp-only quarantine without a retention lock -> refused and kept in place.
    const agedEmpty = join(dir, ".retired-empty1")
    mkdirSync(agedEmpty)
    writeFileSync(join(agedEmpty, ".quarantined"), "")
    utimesSync(join(agedEmpty, ".quarantined"), oldTime, oldTime)
    utimesSync(agedEmpty, oldTime, oldTime)

    await expect(store.delete(ACCOUNT, BACKUP_CONTAINER, `${old1}metadata.json`, {
      ifMatch: old1Blob.etag,
      expectedReplacements,
    })).rejects.toThrow(/Replacement backup/)
    expect(existsSync(agedEmpty)).toBe(true)

    // Case 2: Under an active retention lock, the aged stamp-only quarantine is removed and delete succeeds.
    const lockId = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    try {
      const currentOld1 = (await store.get(ACCOUNT, BACKUP_CONTAINER, `${old1}metadata.json`)).blob.etag
      await expect(store.delete(ACCOUNT, BACKUP_CONTAINER, `${old1}metadata.json`, {
        ifMatch: currentOld1,
        retentionLockId: lockId,
        expectedReplacements,
      })).resolves.toBeUndefined()
      expect(existsSync(agedEmpty)).toBe(false)
      expect(await store.list(ACCOUNT, BACKUP_CONTAINER, old1)).toEqual([])

      // Case 3: Recent stamp-only quarantine (within 60s grace) -> refused and kept in place even under lock.
      const recentEmpty = join(dir, ".retired-recent1")
      mkdirSync(recentEmpty)
      writeFileSync(join(recentEmpty, ".quarantined"), "")

      await expect(store.delete(ACCOUNT, BACKUP_CONTAINER, `${old2}metadata.json`, {
        ifMatch: old2Blob.etag,
        retentionLockId: lockId,
        expectedReplacements,
      })).rejects.toThrow(/Replacement backup/)
      expect(existsSync(recentEmpty)).toBe(true)
      rmSync(recentEmpty, { recursive: true, force: true })

      // Case 4: Unreadable aged quarantine -> refused and kept in place even under lock.
      const currentOld2Case4 = (await store.get(ACCOUNT, BACKUP_CONTAINER, `${old2}metadata.json`)).blob.etag
      const unreadableDir = join(dir, ".retired-unreadable1")
      mkdirSync(unreadableDir)
      writeFileSync(join(unreadableDir, ".quarantined"), "")
      utimesSync(join(unreadableDir, ".quarantined"), oldTime, oldTime)
      utimesSync(unreadableDir, oldTime, oldTime)

      vi.mocked(fsPromises.readdir).mockImplementation((async (path: unknown, options?: unknown) => {
        if (String(path) === unreadableDir) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
        }
        return actual.readdir(path as never, options as never)
      }) as typeof actual.readdir)
      try {
        await expect(store.delete(ACCOUNT, BACKUP_CONTAINER, `${old2}metadata.json`, {
          despiteDamage: true,
          ifMatch: currentOld2Case4,
          retentionLockId: lockId,
          expectedReplacements,
        })).rejects.toThrow(/Replacement backup/)
        expect(existsSync(unreadableDir)).toBe(true)
      } finally {
        vi.mocked(fsPromises.readdir).mockImplementation(actual.readdir)
        rmSync(unreadableDir, { recursive: true, force: true })
      }

      // Case 5: File appears inside aged empty quarantine before re-confirmation -> refused and preserved.
      const currentOld2Case5 = (await store.get(ACCOUNT, BACKUP_CONTAINER, `${old2}metadata.json`)).blob.etag
      const racingDir = join(dir, ".retired-racing1")
      mkdirSync(racingDir)
      writeFileSync(join(racingDir, ".quarantined"), "")
      utimesSync(join(racingDir, ".quarantined"), oldTime, oldTime)
      utimesSync(racingDir, oldTime, oldTime)
      const appearedFile = join(racingDir, `${"a".repeat(40)}.tvb`)
      let readdirCalls = 0
      vi.mocked(fsPromises.readdir).mockImplementation((async (path: unknown, options?: unknown) => {
        const res = await actual.readdir(path as never, options as never)
        if (String(path) === racingDir) {
          readdirCalls++
          if (readdirCalls === 1) {
            writeFileSync(appearedFile, Buffer.from("concurrent-held-file"))
          }
        }
        return res
      }) as typeof actual.readdir)
      try {
        await expect(store.delete(ACCOUNT, BACKUP_CONTAINER, `${old2}metadata.json`, {
          despiteDamage: true,
          ifMatch: currentOld2Case5,
          retentionLockId: lockId,
          expectedReplacements,
        })).rejects.toThrow(/Replacement backup/)
        expect(existsSync(appearedFile)).toBe(true)
      } finally {
        vi.mocked(fsPromises.readdir).mockImplementation(actual.readdir)
        rmSync(racingDir, { recursive: true, force: true })
      }
    } finally {
      await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, lockId)
    }
  })

  it("storage docs document the NTFS, APFS or ext4 hard-link requirement for local retention cleanup", () => {
    const doc = readFileSync(join(process.cwd(), "docs-site/src/content/docs/backups/storage.md"), "utf8")
    expect(doc).toContain("NTFS, APFS or ext4")
    expect(doc).toContain("exFAT")
    expect(doc).toContain("hard links")
    expect(doc).not.toContain("copying the file on drives without hard links")
  })
})

describe("hard link re-probe", () => {
  it("re-probes hard link support on every retention run instead of latching a single failure", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const root = mkdtempSync(join(tmpdir(), "tv-reprobe-")); roots.push(root)
    const store = new LocalBlobStore(root, [MASTER])
    await store.createContainer(ACCOUNT, BACKUP_CONTAINER)
    let refuse = true
    vi.mocked(fsPromises.link).mockImplementation(async (existing, next) => {
      if (refuse) throw Object.assign(new Error("EPERM: transient"), { code: "EPERM" })
      return actual.link(existing, next)
    })
    try {
      const first = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER).then(() => null, (e: unknown) => e)
      expect(first).toBeInstanceOf(BlobLeaseUnsupportedError)
      refuse = false
      const id = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
      expect(typeof id).toBe("string")
      await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, id)
    } finally {
      vi.mocked(fsPromises.link).mockImplementation(actual.link)
    }
  })
})
