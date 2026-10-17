import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BackupEngine, type BackupJob } from "../src/main/backup/engine"
import { FAILED_ATTEMPT_DAYS, FailedAttemptLog, MAX_FAILED_ATTEMPTS } from "../src/main/backup/failed-attempts"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { memoryStore } from "./helpers"

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER = "33333333-3333-3333-3333-333333333333"
const CLIENT = "22222222-2222-2222-2222-222222222222"

const job = (changes: Partial<BackupJob>): BackupJob => ({
  id: "desktop-job", tenantId: TENANT, storageAccountName: "store", status: "Failed", progress: 100,
  progressMessage: "Backup failed", startTime: "2026-10-17T02:00:00Z", log: [], ...changes,
})

describe("FailedAttemptLog", () => {
  it("keeps attempts across a restart, newest first and scoped by tenant", () => {
    const store = memoryStore()
    let now = new Date("2026-10-16T02:00:00Z")
    const log = new FailedAttemptLog(store, () => now)
    log.record({ tenantId: TENANT.toUpperCase(), trigger: "scheduled", message: "Sign in again." })
    now = new Date("2026-10-17T02:00:00Z")
    log.record({ tenantId: TENANT, trigger: "manual", message: "A different backup is already running for this tenant." })
    log.record({ tenantId: OTHER, trigger: "tray", message: "Not backed up: a license is required." })

    const restarted = new FailedAttemptLog(store)
    expect(restarted.list(TENANT)).toEqual([
      { at: "2026-10-17T02:00:00.000Z", tenantId: TENANT, trigger: "manual", message: "A different backup is already running for this tenant." },
      { at: "2026-10-16T02:00:00.000Z", tenantId: TENANT, trigger: "scheduled", message: "Sign in again." },
    ])
    expect(restarted.list(OTHER.toUpperCase())).toHaveLength(1)
  })

  it("stays bounded by age, count and message length", () => {
    const store = memoryStore()
    let now = new Date("2026-08-01T00:00:00Z")
    const log = new FailedAttemptLog(store, () => now)
    log.record({ tenantId: TENANT, trigger: "manual", message: "old" })
    now = new Date(now.getTime() + (FAILED_ATTEMPT_DAYS + 1) * 86_400_000)
    log.record({ tenantId: TENANT, trigger: "manual", message: "first line\nsecond line with details" })
    expect(log.list(TENANT).map((entry) => entry.message)).toEqual(["first line"])

    for (let i = 0; i < MAX_FAILED_ATTEMPTS + 10; i++) log.record({ tenantId: TENANT, trigger: "manual", message: `attempt ${i}` })
    expect(log.list(TENANT)).toHaveLength(MAX_FAILED_ATTEMPTS)
    log.record({ tenantId: TENANT, trigger: "manual", message: "x".repeat(5000) })
    expect(log.list(TENANT)[0]!.message.length).toBeLessThanOrEqual(200)
  })

  it("starts over from an unreadable log", () => {
    const store = memoryStore()
    store.set("backup.failedAttempts", "not json")
    const log = new FailedAttemptLog(store)
    expect(log.list(TENANT)).toEqual([])
    log.record({ tenantId: TENANT, trigger: "manual", message: "a" })
    expect(log.list(TENANT)).toHaveLength(1)
  })

  it("records only failed jobs that left no backup folder", () => {
    const log = new FailedAttemptLog(memoryStore())
    log.finished(job({ status: "Completed", folderClaimed: true }), "manual")
    log.finished(job({ status: "Cancelled" }), "manual")
    // A run that stopped after claiming its folder is counted from the folder (a Failed manifest).
    log.finished(job({ folderClaimed: true, exception: "Backup stopped" }), "scheduled")
    expect(log.list(TENANT)).toEqual([])
    log.finished(job({ exception: "Sign in again.\nAADSTS700082" }), "scheduled")
    expect(log.list(TENANT)).toMatchObject([{ trigger: "scheduled", message: "Sign in again." }])
  })

  it("records a repeated connection failure once until a backup ends another way", () => {
    const log = new FailedAttemptLog(memoryStore())
    const offline = job({ unreachable: true, exception: "Microsoft Graph could not be reached." })
    log.finished(offline, "scheduled")
    log.finished(offline, "scheduled")
    log.finished(offline, "scheduled")
    expect(log.list(TENANT)).toHaveLength(1)
    log.finished(job({ status: "Completed", folderClaimed: true }), "manual")
    log.finished(offline, "scheduled")
    expect(log.list(TENANT)).toHaveLength(2)
  })
})

describe("BackupEngine end of job", () => {
  function engineWith(graph: (url: URL) => Response, onFinished: (job: BackupJob, trigger: string) => void, getToken = async () => "token") {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-attempts-")), [randomBytes(32)])
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
      if (url.hostname === "graph.microsoft.com") return graph(url)
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch
    const engine = new BackupEngine({ fetch: fetchImpl, getToken, onFinished })
    return { engine, store, account: localStorageAccountName(TENANT) }
  }
  const oneItem = (itemResponse: () => Response) => (url: URL) => {
    if (url.pathname === "/beta/deviceManagement/deviceConfigurations") return Response.json({ value: [{ id: "dc1", displayName: "Profile" }] })
    if (url.pathname === "/beta/deviceManagement/deviceConfigurations/dc1") return itemResponse()
    if (url.pathname.endsWith("/assignments")) return Response.json({ value: [] })
    if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
    return Response.json({ id: url.pathname.split("/").pop() })
  }

  it("reports each job once, with whether it claimed its folder", async () => {
    const ended: Array<{ job: BackupJob; trigger: string; claimed: boolean | undefined }> = []
    const onFinished = (job: BackupJob, trigger: string) => void ended.push({ job, trigger, claimed: job.folderClaimed })

    const ok = engineWith(oneItem(() => Response.json({ id: "dc1", displayName: "Profile" })), onFinished)
    const done = ok.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: ok.account, trigger: "scheduled" })
    // A second request with another scope does not join and fails at once, without a folder.
    const conflict = ok.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: ok.account, scope: { excluded: ["DeviceConfigurations"] } })
    expect(conflict.status).toBe("Failed")
    await ok.engine.waitForJob(done)
    expect(ended.map((entry) => [entry.job.status, entry.trigger, entry.claimed])).toEqual([["Failed", "manual", undefined], ["Completed", "scheduled", true]])

    ended.length = 0
    const signIn = engineWith(oneItem(() => Response.json({})), onFinished, async () => { throw new Error("Sign in again.") })
    await signIn.engine.waitForJob(signIn.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: signIn.account }))
    expect(ended.map((entry) => [entry.job.status, entry.claimed])).toEqual([["Failed", undefined]])
    expect(await signIn.store.list(signIn.account, "intune-backups").catch(() => [])).toEqual([])
  })

  it("leaves a run that wrote a failed manifest to its folder, so it is not counted twice", async () => {
    const store = memoryStore()
    const log = new FailedAttemptLog(store)
    const expired = engineWith(oneItem(() => Response.json({ error: { message: "Unauthorized" } }, { status: 401 })), (job, trigger) => log.finished(job, trigger as "manual"))
    const job = await expired.engine.waitForJob(expired.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: expired.account }))
    expect(job.status).toBe("Failed")
    expect(job.folderClaimed).toBe(true)
    const names = (await expired.store.list(expired.account, "intune-backups")).map((blob) => blob.name)
    expect(names).toContain(`${job.backupFolder}/metadata.json`)
    expect(log.list(TENANT)).toEqual([])
  })

  it("records a failure before the folder claim", async () => {
    const log = new FailedAttemptLog(memoryStore())
    const failing = engineWith((url) => url.pathname === "/beta/deviceManagement/deviceConfigurations"
      ? Response.json({ error: { message: "Unauthorized" } }, { status: 401 })
      : Response.json({ value: [] }), (job, trigger) => log.finished(job, trigger as "manual"))
    const job = await failing.engine.waitForJob(failing.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: failing.account }))
    expect(job.status).toBe("Failed")
    expect(job.folderClaimed).toBeUndefined()
    expect(log.list(TENANT)).toMatchObject([{ trigger: "manual" }])
  })
})
