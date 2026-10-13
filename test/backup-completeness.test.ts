import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { BackupScheduler, scheduledResult, type ScheduledRunResult } from "../src/main/backup/scheduler"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { memoryStore } from "./helpers"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"
const OTHER_TENANT = "33333333-3333-3333-3333-333333333333"

function engineSetup(graph: (url: URL) => Response, options: { retentionDays?: number; now?: string } = {}) {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-complete-")), [randomBytes(32)])
  const account = localStorageAccountName(TENANT)
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
    return graph(url)
  }) as typeof fetch
  const engine = new BackupEngine({
    fetch: fetchImpl,
    getToken: async () => "token",
    retentionDays: () => options.retentionDays ?? 0,
    now: options.now ? () => new Date(options.now!) : undefined,
    concurrency: 4,
  })
  return { engine, store, account }
}

async function finished(engine: BackupEngine, id: string) {
  for (let i = 0; i < 400; i++) {
    const job = engine.get(id)!
    if (job.status !== "Running") return job
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error("backup did not finish")
}

function emptyGraph(url: URL) {
  if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
  return Response.json({ id: url.pathname.split("/").pop() })
}

describe("retention after an incomplete backup", () => {
  it("keeps the last complete copy when a newer backup with warnings covers the same folder", async () => {
    const { engine, store, account } = engineSetup(emptyGraph, { retentionDays: 30, now: "2026-09-24T12:00:00Z" })
    await store.createContainer(account, "intune-backups")
    const put = (name: string, body: unknown) => store.put(account, "intune-backups", name, Buffer.from(JSON.stringify(body)), "application/json")
    // A: the last complete backup, holding apps. B: newer, but one item could not be read, so
    // its copy of apps may be missing that item. Both are past the retention period.
    await put("backup-2026-07-01-020000/metadata.json", { Status: "Success", Failures: 0, Scope: { Excluded: [] } })
    await put("backup-2026-07-01-020000/Apps/Reader.json", {})
    await put("backup-2026-08-01-020000/metadata.json", { Status: "CompletedWithWarnings", Failures: 1, Scope: { Excluded: [] } })
    await put("backup-2026-08-01-020000/Apps/Reader.json", {})
    // C: the new backup leaves apps out, so retention looks for the newest copy of them.
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: { excluded: ["Apps"] } }).id)
    expect(job.status).toBe("Completed")
    const folders = new Set((await store.list(account, "intune-backups")).map((blob) => blob.name.split("/")[0]))
    expect(folders.has("backup-2026-07-01-020000")).toBe(true)
    expect(folders.has("backup-2026-09-24-120000")).toBe(true)
  })
})

describe("BackupEngine deduplication", () => {
  it("joins only requests for the same tenant, storage account and scope", async () => {
    const { engine, account } = engineSetup(emptyGraph)
    const first = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: { excluded: [] } })
    const same = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: { excluded: [] }, trigger: "scheduled" })
    const otherScope = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: { excluded: ["Apps"] }, trigger: "scheduled" })
    const otherStorage = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: localStorageAccountName(OTHER_TENANT), scope: { excluded: [] }, trigger: "scheduled" })

    expect(same.id).toBe(first.id)
    for (const conflict of [otherScope, otherStorage]) {
      expect(conflict.id).not.toBe(first.id)
      expect(conflict.status).toBe("Failed")
      expect(conflict.exception).toMatch(/already running/)
      // A joined outcome must never count as a completed scheduled slot.
      expect(scheduledResult(conflict).status).toBe("Failed")
      expect(await engine.waitForJob(conflict)).toBe(conflict)
    }
    const done = await finished(engine, first.id)
    expect(done.status).toBe("Completed")
    expect(scheduledResult(done).status).toBe("Completed")
  })
})

describe("scheduled outcome of a partial backup", () => {
  it("keeps the slot retryable when a scheduled run saved some policies but not all", async () => {
    const partialGraph = (url: URL) => {
      if (url.pathname === "/beta/deviceManagement/deviceConfigurations" && !url.search) {
        return Response.json({ value: [{ id: "dc1", displayName: "Good" }, { id: "dc2", displayName: "Bad" }] })
      }
      if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
      if (url.pathname.endsWith("/dc2")) return Response.json({ error: { message: "Forbidden" } }, { status: 403 })
      return Response.json({ id: url.pathname.split("/").pop() })
    }
    const { engine, store, account } = engineSetup(partialGraph)
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, trigger: "scheduled" }).id)
    // One policy was saved, one could not be read: the partial backup stays on disk.
    expect(job.status).toBe("Completed")
    expect(job.failures).toBe(1)
    const metadata = JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString())
    expect(metadata).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1 })
    expect(scheduledResult(job).status).toBe("Failed")

    let clock = new Date(2026, 9, 12, 1, 0)
    const result: ScheduledRunResult = scheduledResult(job)
    const scheduler = new BackupScheduler(memoryStore(), async () => result, () => undefined, () => clock)
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    clock = new Date(2026, 9, 12, 2, 5)
    await scheduler.tick()
    const schedule = scheduler.list()[0]!
    expect(schedule.lastStatus).toBe("Failed")
    expect(schedule.attempts).toBe(1)
    expect(schedule.lastRunAt).toBeUndefined()
    expect(scheduler.isDue(schedule)).toBe(false)
    clock = new Date(clock.getTime() + 15 * 60_000)
    expect(scheduler.isDue(scheduler.list()[0]!)).toBe(true)
  })
})
