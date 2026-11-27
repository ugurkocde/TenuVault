import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { BlobWriter } from "../src/main/backup/blob-writer"
import { type RetentionProgressStore } from "../src/main/backup/retention-progress"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import {
  BlobLeaseConflictError,
  BlobProtectedError,
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
import { withServerDate } from "./helpers"

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
        writeFileSync(lockPath, liveLock)
        return actual.rename(from, to)
      })

      await expect(store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toBeInstanceOf(BlobLeaseConflictError)
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
        writeFileSync(lockPath, thirdLock)
      })

      await expect(store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toThrow(/kept at .*\.stale/)
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

    const old1 = "backup-2026-08-02-020000/"
    const old2 = "backup-2026-08-01-020000/"
    for (const prefix of [old1, old2]) {
      await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
      await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
      await store.put(ACCOUNT, BACKUP_CONTAINER, `${prefix}metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")
    }
    const blob = (await store.get(ACCOUNT, BACKUP_CONTAINER, `${old1}metadata.json`)).blob
    const heldId = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    writeFileSync(lockPath, JSON.stringify({ id: "another-holder", host: hostname(), pid: process.pid, processStart: "other", app: "TenuVault" }))
    await expect(store.delete(ACCOUNT, BACKUP_CONTAINER, `${old1}metadata.json`, { ifMatch: blob.etag, retentionLockId: heldId }))
      .rejects.toBeInstanceOf(BlobLeaseConflictError)
    expect((await store.list(ACCOUNT, BACKUP_CONTAINER, old1)).map(b => b.name)).toContain(`${old1}metadata.json`)
    expect(readdirSync(dir).some(f => f.startsWith(".retired-"))).toBe(false)
    rmSync(lockPath, { force: true })

    let tamperOnce = false
    const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (!localAccountFromUrl(url)) return withServerDate(Response.json({ value: [] }), NOW)
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
      await expect(storeA.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json"))
        .rejects.toBeInstanceOf(BlobProtectedError)
      await expect(storeB.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}DeviceConfigurations/new.json`, Buffer.from("{}"), "application/json"))
        .rejects.toBeInstanceOf(BlobProtectedError)
      await expect(storeB.delete(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`))
        .rejects.toBeInstanceOf(BlobProtectedError)
      await expect(storeA.delete(ACCOUNT, BACKUP_CONTAINER, `${otherPrefix}metadata.json`, { retentionLockId: lockId }))
        .resolves.toBeUndefined()
    } finally {
      await storeA.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, lockId)
    }

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
    const winStore = new LocalBlobStore(rootWin, [MASTER], undefined, undefined, winReader)
    await winStore.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const winLockPath = join(rootWin, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")

    const heldWin = await winStore.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(winLockPath, "utf8")).processStart).toBe("wmi:2026-11-27T11:00:00.000Z")
    await winStore.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, heldWin)

    writeFileSync(winLockPath, JSON.stringify({
      id: "win-reused", host: hostname(), pid: 4242, processStart: "wmi:2026-11-27T08:00:00.000Z", app: "TenuVault",
    }))
    const reclaimedWin = await winStore.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(winLockPath, "utf8")).id).toBe(reclaimedWin)
    await winStore.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, reclaimedWin)

    writeFileSync(winLockPath, JSON.stringify({
      id: "win-live", host: hostname(), pid: 4242, processStart: "wmi:2026-11-27T10:00:00.123Z", app: "TenuVault",
    }))
    await expect(winStore.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)).rejects.toMatchObject({
      code: "LeaseAlreadyPresent",
      lockPath: winLockPath,
      holderId: "win-live",
      message: expect.stringContaining("Another TenuVault instance"),
    })

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
    const macStore = new LocalBlobStore(rootMac, [MASTER], undefined, undefined, darwinReader)
    await macStore.createContainer(ACCOUNT, BACKUP_CONTAINER)
    const macLockPath = join(rootMac, ACCOUNT, BACKUP_CONTAINER, ".tenuvault-retention.lock")

    writeFileSync(macLockPath, JSON.stringify({
      id: "mac-reused", host: hostname(), pid: 5151, processStart: "ps:1700000000", app: "TenuVault",
    }))
    const reclaimedMac = await macStore.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER)
    expect(JSON.parse(readFileSync(macLockPath, "utf8")).id).toBe(reclaimedMac)
    await macStore.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, reclaimedMac)
  })

  it("P1 & P3.1: unobservable start or token kind mismatch warns with lockPath, never reclaims, escalates after 3 runs, and leaves backups/restores working", async () => {
    const rootMismatch = mkdtempSync(join(tmpdir(), "tv-lock-kind-mismatch-")); roots.push(rootMismatch)
    const linuxReader: ProcessInfoReader = {
      isPidAlive: () => true,
      readProcessStart: async () => "proc:boot-1:99999",
    }
    const mismatchStore = new LocalBlobStore(rootMismatch, [MASTER], undefined, undefined, linuxReader)
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
    const store = new LocalBlobStore(rootUnobs, [MASTER], undefined, undefined, failingReader)
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
      return withServerDate(Response.json({ value: [] }), clock)
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
    const store = new LocalBlobStore(root, [MASTER], undefined, undefined, liveReader)
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
      return withServerDate(Response.json({ value: [] }), clock)
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

    const retiredDir = join(dir, ".retired-test123")
    mkdirSync(retiredDir)
    renameSync(join(dir, tvbFile), join(retiredDir, tvbFile))
    const stampPath = join(retiredDir, ".quarantined")
    writeFileSync(stampPath, "")
    const oldTime = (Date.now() - 120_000) / 1000
    utimesSync(stampPath, oldTime, oldTime)
    utimesSync(retiredDir, oldTime, oldTime)

    const lockId = await store.acquireRetentionLock(ACCOUNT, BACKUP_CONTAINER, undefined, [repPrefix])
    try {
      await store.list(ACCOUNT, BACKUP_CONTAINER)
      expect(existsSync(join(dir, tvbFile))).toBe(false)
      expect(existsSync(join(retiredDir, tvbFile))).toBe(true)
    } finally {
      await store.releaseRetentionLock(ACCOUNT, BACKUP_CONTAINER, lockId)
    }

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

    let releaseAttempts = 0
    const retryWriter = new BlobWriter(async (input, init) => {
      const req = new Request(input, init)
      if (req.headers.get("x-ms-lease-action") === "release") {
        releaseAttempts++
        if (releaseAttempts === 1) throw new Error("Simulated transient release failure")
      }
      return handleLocalBlobRequest(store, req)
    }, ACCOUNT, async () => "token")
    const retryLockId = await retryWriter.acquireContainerLease(BACKUP_CONTAINER, [repPrefix])
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json"))
      .rejects.toBeInstanceOf(BlobProtectedError)
    await retryWriter.releaseContainerLease(retryLockId, BACKUP_CONTAINER)
    expect(releaseAttempts).toBe(2)
    expect(existsSync(lockPath)).toBe(false)
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":2}'), "application/json"))
      .resolves.toBeDefined()

    let failedReleaseAttempts = 0
    const failingWriter = new BlobWriter(async (input, init) => {
      const req = new Request(input, init)
      if (req.headers.get("x-ms-lease-action") === "release") {
        failedReleaseAttempts++
        throw new Error("Simulated release timeout before store")
      }
      return handleLocalBlobRequest(store, req)
    }, ACCOUNT, async () => "token")
    const leakLockId = await failingWriter.acquireContainerLease(BACKUP_CONTAINER, [repPrefix])
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":3}'), "application/json"))
      .rejects.toBeInstanceOf(BlobProtectedError)
    await expect(failingWriter.releaseContainerLease(leakLockId, BACKUP_CONTAINER)).rejects.toThrow(/Simulated release timeout/)
    expect(failedReleaseAttempts).toBe(2)
    expect(existsSync(lockPath)).toBe(true)
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, `${repPrefix}metadata.json`, Buffer.from('{"v":3}'), "application/json"))
      .resolves.toBeDefined()
    rmSync(lockPath, { force: true })

    await seedOldLocalBackup(store, "backup-2026-08-01-020000/")
    let engineReleaseAttempts = 0
    const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
    const engine = new BackupEngine({
      fetch: async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        if (!localAccountFromUrl(url)) return withServerDate(Response.json({ value: [] }), NOW)
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
    const backups = (await store.list(ACCOUNT, BACKUP_CONTAINER)).map(b => b.name)
    const anchorMetadata = backups.find(n => n.startsWith("backup-2026-10-12-") && n.endsWith("/metadata.json"))!
    expect(anchorMetadata).toBeTruthy()
    await expect(store.put(ACCOUNT, BACKUP_CONTAINER, anchorMetadata, Buffer.from('{"unlocked":true}'), "application/json"))
      .resolves.toBeDefined()
  })
})
