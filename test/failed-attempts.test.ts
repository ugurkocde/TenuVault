import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BackupEngine, type BackupJob, type BackupRequest } from "../src/main/backup/engine"
import { FAILED_ATTEMPT_DAYS, FailedAttemptLog, MAX_FAILED_ATTEMPTS_PER_TENANT, recordPlanRefusal } from "../src/main/backup/failed-attempts"
import { planGuard } from "../src/main/api/plan-gates"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"
import { POST as listBackups } from "../src/portal/app/api/list-backups/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { backupSummary, normalizeBackupStatus } from "../src/portal/lib/backup-health"
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
    log.record({ tenantId: TENANT, runId: "desktop-conflict", trigger: "manual", message: "A different backup is already running for this tenant." })
    log.record({ tenantId: OTHER, trigger: "tray", message: "Not backed up: a license is required." })

    const restarted = new FailedAttemptLog(store)
    expect(restarted.list(TENANT)).toEqual([
      { at: "2026-10-17T02:00:00.000Z", tenantId: TENANT, runId: "desktop-conflict", trigger: "manual", message: "A different backup is already running for this tenant." },
      { at: "2026-10-16T02:00:00.000Z", tenantId: TENANT, runId: expect.stringMatching(/^refused-/), trigger: "scheduled", message: "Sign in again." },
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

    for (let i = 0; i < MAX_FAILED_ATTEMPTS_PER_TENANT + 10; i++) log.record({ tenantId: TENANT, trigger: "manual", message: `attempt ${i}` })
    expect(log.list(TENANT)).toHaveLength(MAX_FAILED_ATTEMPTS_PER_TENANT)
    log.record({ tenantId: TENANT, trigger: "manual", message: "x".repeat(5000) })
    expect(log.list(TENANT)[0]!.message.length).toBeLessThanOrEqual(200)
  })

  it("caps each tenant on its own, so a busy tenant cannot evict another tenant's recent failures", () => {
    const log = new FailedAttemptLog(memoryStore())
    log.record({ tenantId: OTHER, trigger: "manual", message: "other tenant" })
    for (let i = 0; i < MAX_FAILED_ATTEMPTS_PER_TENANT * 3; i++) log.record({ tenantId: TENANT, trigger: "manual", message: `attempt ${i}` })
    expect(log.list(OTHER).map((entry) => entry.message)).toEqual(["other tenant"])
    expect(log.list(TENANT)).toHaveLength(MAX_FAILED_ATTEMPTS_PER_TENANT)
  })

  it("leaves out attempts older than the age limit even before the next write", () => {
    const store = memoryStore()
    let now = new Date("2026-08-01T00:00:00Z")
    new FailedAttemptLog(store, () => now).record({ tenantId: TENANT, trigger: "manual", message: "old" })
    now = new Date(now.getTime() + (FAILED_ATTEMPT_DAYS + 1) * 86_400_000)
    expect(new FailedAttemptLog(store, () => now).list(TENANT)).toEqual([])
  })

  it("starts over from an unreadable log", () => {
    const store = memoryStore()
    store.set("backup.failedAttempts", "not json")
    const log = new FailedAttemptLog(store)
    expect(log.list(TENANT)).toEqual([])
    log.record({ tenantId: TENANT, trigger: "manual", message: "a" })
    expect(log.list(TENANT)).toHaveLength(1)
  })

  const manual = { tenantId: TENANT, clientId: CLIENT, storageAccountName: "store", trigger: "manual" as const }
  const slot = (iso: string) => ({ ...manual, trigger: "scheduled" as const, slot: iso })
  const offline = job({ unreachable: true, exception: "Microsoft Graph could not be reached." })

  it("records every failed job with its run id, and no completed or cancelled job", () => {
    const log = new FailedAttemptLog(memoryStore())
    log.finished(job({ status: "Completed" }), manual)
    log.finished(job({ status: "Cancelled" }), manual)
    expect(log.list(TENANT)).toEqual([])
    log.finished(job({ id: "desktop-run", exception: "Sign in again.\nAADSTS700082" }), slot("2026-10-17T02:00:00.000Z"))
    expect(log.list(TENANT)).toMatchObject([{ runId: "desktop-run", trigger: "scheduled", slot: "2026-10-17T02:00:00.000Z", message: "Sign in again." }])
  })

  it("gives attempts without a backup job a unique id no folder carries", () => {
    const log = new FailedAttemptLog(memoryStore())
    log.record({ tenantId: TENANT, trigger: "tray", message: "Not backed up: a license is required." })
    log.record({ tenantId: TENANT, trigger: "tray", message: "Not backed up: a license is required." })
    const ids = log.list(TENANT).map((entry) => entry.runId)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^refused-/)
  })

  it("saves the pruned list when a read drops old entries, and never throws for it", () => {
    const store = memoryStore()
    let now = new Date("2026-08-01T00:00:00Z")
    new FailedAttemptLog(store, () => now).record({ tenantId: TENANT, trigger: "manual", message: "old" })
    now = new Date(now.getTime() + (FAILED_ATTEMPT_DAYS + 1) * 86_400_000)
    const readOnly = { ...store, set: vi.fn(() => { throw new Error("The store is not writable.") }) }
    expect(new FailedAttemptLog(readOnly, () => now).list(TENANT)).toEqual([])
    expect(readOnly.set).toHaveBeenCalledTimes(1)
    expect(JSON.parse(store.get("backup.failedAttempts")!)).toHaveLength(1)
    expect(new FailedAttemptLog(store, () => now).list(TENANT)).toEqual([])
    expect(JSON.parse(store.get("backup.failedAttempts")!)).toEqual([])
  })

  it("counts every manual and tray failure, also repeated connection failures", () => {
    const log = new FailedAttemptLog(memoryStore())
    log.finished(offline, manual)
    log.finished(offline, manual)
    log.finished(offline, { ...manual, trigger: "tray" })
    log.finished(offline, { ...manual, trigger: "tray" })
    expect(log.list(TENANT).map((entry) => entry.trigger)).toEqual(["tray", "tray", "manual", "manual"])
  })

  it("counts repeated connection failures of one scheduled slot once, also after a restart", () => {
    const store = memoryStore()
    const first = new FailedAttemptLog(store)
    first.finished(offline, slot("2026-10-17T02:00:00.000Z"))
    first.finished({ ...offline, id: "desktop-retry" }, slot("2026-10-17T02:00:00.000Z"))
    const restarted = new FailedAttemptLog(store)
    restarted.finished({ ...offline, id: "desktop-after-restart" }, slot("2026-10-17T02:00:00.000Z"))
    expect(restarted.list(TENANT)).toHaveLength(1)
    expect(restarted.list(TENANT)[0]).toMatchObject({ unreachable: true })
    // The next slot, and the same slot of another tenant, count on their own.
    restarted.finished(offline, slot("2026-10-18T02:00:00.000Z"))
    restarted.finished({ ...offline, tenantId: OTHER }, { ...slot("2026-10-17T02:00:00.000Z"), tenantId: OTHER })
    expect(restarted.list(TENANT)).toHaveLength(2)
    expect(restarted.list(OTHER)).toHaveLength(1)
  })

  it("records every other failed run of a slot, so a lost Success response cannot hide a later failure", () => {
    const log = new FailedAttemptLog(memoryStore())
    // Run A saved a Success manifest but lost the response, so its job failed; its folder counts it.
    log.finished(job({ id: "desktop-a", exception: "The storage did not answer in time." }), slot("2026-10-17T02:00:00.000Z"))
    // Retry B fails to sign in before it has a folder.
    log.finished(job({ id: "desktop-b", exception: "Sign in again." }), slot("2026-10-17T02:00:00.000Z"))
    log.record({ tenantId: TENANT, trigger: "scheduled", slot: "2026-10-17T02:00:00.000Z", message: "Not backed up: a license is required." })
    expect(log.list(TENANT).map((entry) => entry.runId.startsWith("refused-") ? "refused" : entry.runId)).toEqual(["refused", "desktop-b", "desktop-a"])
    const attempts = log.list(TENANT).map((entry) => ({ timestamp: new Date(entry.at), runId: entry.runId }))
    const folders = [{ status: "success" as const, timestamp: new Date("2026-10-17T02:00:00Z"), runId: "desktop-a" }]
    expect(backupSummary(folders, attempts, { since: new Date("2026-10-10T00:00:00Z"), live: [] })).toMatchObject({ successful: 1, failed: 2, finished: 3 })
    // A connection failure after a different failure of the slot counts too.
    log.finished({ ...offline, id: "desktop-c" }, slot("2026-10-17T02:00:00.000Z"))
    expect(log.list(TENANT)).toHaveLength(4)
  })

  it("dates a run's record with its folder instant, so both sources put it in the same period", () => {
    const log = new FailedAttemptLog(memoryStore(), () => new Date("2026-10-17T02:29:59Z"))
    log.finished(job({ id: "desktop-a", startTime: "2026-10-17T01:59:59.400Z", backupFolder: "backup-2026-10-17-015959" }), manual)
    log.finished(job({ id: "desktop-b", startTime: "2026-10-17T01:59:59.400Z" }), manual)
    expect(log.list(TENANT).map((entry) => entry.at)).toEqual(["2026-10-17T01:59:59.400Z", "2026-10-17T01:59:59.000Z"])
  })

  it("does not skip later retries of a slot whose first failure could not be saved", () => {
    const store = memoryStore()
    let writable = false
    const log = new FailedAttemptLog({ ...store, set: (key: string, value: string) => {
      if (!writable) throw new Error("The store is not writable.")
      store.set(key, value)
    } })
    expect(() => log.finished(offline, slot("2026-10-17T02:00:00.000Z"))).toThrow("not writable")
    writable = true
    log.finished(offline, slot("2026-10-17T02:00:00.000Z"))
    expect(log.list(TENANT)).toHaveLength(1)
  })
})

describe("recordPlanRefusal", () => {
  const backupStart = (body: Record<string, unknown>, path = "/api/backup/start") => new Request(`http://tenuvault.internal${path}`, { method: "POST", body: JSON.stringify(body) })

  it("records a manual backup the plan guard refused, and returns the refusal unchanged", async () => {
    const log = new FailedAttemptLog(memoryStore())
    const guard = planGuard(async () => "community")
    const request = backupStart({ tenantId: TENANT, appId: CLIENT, storageAccountName: "contosobackups" })
    const refusal = await guard(request)
    expect(refusal?.status).toBe(402)
    expect(await recordPlanRefusal(log, request, refusal)).toBe(refusal)
    expect(log.list(TENANT)).toMatchObject([{ trigger: "manual", message: (await refusal!.clone().json()).error }])
    // The request itself can still be read by the route after the guard.
    expect((await request.json()).tenantId).toBe(TENANT)
  })

  it("records nothing for admitted requests, other routes or requests without a tenant", async () => {
    const log = new FailedAttemptLog(memoryStore())
    const guard = planGuard(async () => "community")
    const local = backupStart({ tenantId: TENANT, appId: CLIENT, storageAccountName: localStorageAccountName(TENANT) })
    expect(await recordPlanRefusal(log, local, await guard(local))).toBeNull()
    const restore = backupStart({ tenantId: TENANT, restoreType: "full" }, "/api/restore-backup")
    const refused = await guard(restore)
    expect(refused?.status).toBe(402)
    await recordPlanRefusal(log, restore, refused)
    await recordPlanRefusal(log, backupStart({ storageAccountName: "contosobackups" }), Response.json({ error: "Upgrade" }, { status: 402 }))
    await recordPlanRefusal(log, backupStart({ tenantId: TENANT }), Response.json({ error: "Bad request" }, { status: 400 }))
    expect(log.list(TENANT)).toEqual([])
  })
})

describe("BackupEngine end of job", () => {
  type Storage = (request: Request, forward: () => Promise<Response>) => Promise<Response>
  function engineWith(graph: (url: URL) => Response, onFinished: (job: BackupJob, request: BackupRequest) => void, getToken = async () => "token", storage: Storage = (_request, forward) => forward(), now?: () => Date) {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-attempts-")), [randomBytes(32)])
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (localAccountFromUrl(url)) return storage(request, () => handleLocalBlobRequest(store, request))
      if (url.hostname === "graph.microsoft.com") return graph(url)
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch
    const engine = new BackupEngine({ fetch: fetchImpl, getToken, onFinished, ...(now ? { now } : {}) })
    return { engine, store, account: localStorageAccountName(TENANT) }
  }
  const oneItem = (itemResponse: () => Response) => (url: URL) => {
    if (url.pathname === "/beta/deviceManagement/deviceConfigurations") return Response.json({ value: [{ id: "dc1", displayName: "Profile" }] })
    if (url.pathname === "/beta/deviceManagement/deviceConfigurations/dc1") return itemResponse()
    if (url.pathname.endsWith("/assignments")) return Response.json({ value: [] })
    if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
    return Response.json({ id: url.pathname.split("/").pop() })
  }

  /** The Dashboard counts of the tenant: its folders as /api/list-backups lists them, and the log. */
  async function dashboardCounts(store: LocalBlobStore, account: string, log: FailedAttemptLog, read: Storage = (_request, forward) => forward(), live: string[] = []) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "token" })
      if (localAccountFromUrl(url)) return read(request, () => handleLocalBlobRequest(store, request))
      throw new Error(`unexpected ${url}`)
    })
    try {
      const body = { summary: true, tenantId: TENANT, appId: CLIENT, clientSecret: "test", subscriptionId: "local", resourceGroupName: "local", storageAccountName: account }
      const { backups } = await (await listBackups(new NextRequest("http://tenuvault.internal/api/list-backups", { method: "POST", body: JSON.stringify(body) }))).json() as { backups: Array<{ status: string; timestamp: string; runId: string | null }> }
      const folders = backups.map((backup) => ({ status: normalizeBackupStatus(backup), timestamp: new Date(backup.timestamp), runId: backup.runId }))
      const attempts = log.list(TENANT).map((attempt) => ({ timestamp: new Date(attempt.at), runId: attempt.runId }))
      return { backups, summary: backupSummary(folders, attempts, { since: new Date(Date.now() - 7 * 86_400_000), live }) }
    } finally {
      vi.unstubAllGlobals()
    }
  }
  const profile = oneItem(() => Response.json({ id: "dc1", displayName: "Profile" }))
  const start = (engine: BackupEngine, account: string) => engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }))

  it("reports each job once, with the request that started it", async () => {
    const ended: Array<{ job: BackupJob; trigger: string | undefined }> = []
    const onFinished = (job: BackupJob, request: BackupRequest) => void ended.push({ job, trigger: request.trigger })
    const ok = engineWith(profile, onFinished)
    const done = ok.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: ok.account, trigger: "scheduled" })
    // A second request with another scope does not join and fails at once, without a folder.
    const conflict = ok.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: ok.account, scope: { excluded: ["DeviceConfigurations"] } })
    expect(conflict.status).toBe("Failed")
    await ok.engine.waitForJob(done)
    expect(ended.map((entry) => [entry.job.status, entry.trigger])).toEqual([["Failed", undefined], ["Completed", "scheduled"]])
  })

  it("counts a failed job with a folder once, from the folder", async () => {
    const log = new FailedAttemptLog(memoryStore())
    const expired = engineWith(oneItem(() => Response.json({ error: { message: "Unauthorized" } }, { status: 401 })), (job, request) => log.finished(job, request))
    const job = await start(expired.engine, expired.account)
    expect(job.status).toBe("Failed")
    expect(log.list(TENANT)).toMatchObject([{ runId: job.id }])
    const { backups, summary } = await dashboardCounts(expired.store, expired.account, log)
    // The Failed manifest names its run.
    expect(backups).toMatchObject([{ status: "Failed", runId: job.id }])
    expect(summary).toMatchObject({ stored: 1, successful: 0, failed: 1, finished: 1 })
  })

  it("counts a failed job without a folder", async () => {
    const log = new FailedAttemptLog(memoryStore())
    const failing = engineWith((url) => url.pathname === "/beta/deviceManagement/deviceConfigurations"
      ? Response.json({ error: { message: "Unauthorized" } }, { status: 401 })
      : Response.json({ value: [] }), (job, request) => log.finished(job, request))
    const job = await start(failing.engine, failing.account)
    expect(job.status).toBe("Failed")
    const { backups, summary } = await dashboardCounts(failing.store, failing.account, log)
    expect(backups).toEqual([])
    expect(summary).toMatchObject({ stored: 0, failed: 1, finished: 1, successRate: 0 })
  })

  it("counts a claim saved behind a status zero response once", async () => {
    const log = new FailedAttemptLog(memoryStore())
    // Storage saves the ownership marker, but the answer is a network error response.
    const lost: Storage = async (request, forward) => {
      if (request.method !== "PUT" || !new URL(request.url).pathname.endsWith(BACKUP_OWNER_FILE)) return forward()
      await forward()
      return Response.error()
    }
    const unanswered = engineWith(profile, (job, request) => log.finished(job, request), undefined, lost)
    const job = await start(unanswered.engine, unanswered.account)
    expect(job.status).toBe("Failed")
    expect(log.list(TENANT)).toMatchObject([{ runId: job.id }])
    const { backups, summary } = await dashboardCounts(unanswered.store, unanswered.account, log)
    // The folder holds only the marker, which names the run; the failed run counts once and not as running.
    expect(backups).toMatchObject([{ runId: job.id, status: "running" }])
    expect(summary).toMatchObject({ stored: 1, failed: 1, finished: 1 })
    expect(backupSummary(backups.map((backup) => ({ status: normalizeBackupStatus(backup), timestamp: new Date(backup.timestamp), runId: backup.runId })), [], { since: new Date(0) }).inProgress).toBe(1)
  })

  it("counts a run that lost the folder to a rival, next to the rival's own backup", async () => {
    const log = new FailedAttemptLog(memoryStore())
    const rival: Storage = async (request, forward) => request.method === "PUT" && new URL(request.url).pathname.endsWith(BACKUP_OWNER_FILE)
      ? new Response(null, { status: 412, headers: { "x-ms-error-code": "BlobAlreadyExists" } })
      : forward()
    const taken = engineWith(profile, (job, request) => log.finished(job, request), undefined, rival)
    const job = await start(taken.engine, taken.account)
    expect(job.exception).toContain("already in use by another backup")
    expect(log.list(TENANT)).toMatchObject([{ runId: job.id }])
  })

  it("reports a paused scheduled run as live, so the Dashboard counts it as running and not failed", async () => {
    const log = new FailedAttemptLog(memoryStore())
    let resume!: () => void
    const paused = new Promise<void>((resolve) => { resume = resolve })
    const scheduled = engineWith(oneItem(() => Response.json({ id: "dc1", displayName: "Profile" })), (job, request) => log.finished(job, request), undefined, async (request, forward) => {
      // The policy upload waits, after the folder was claimed.
      if (request.method === "PUT" && new URL(request.url).pathname.includes("/DeviceConfigurations/")) await paused
      return forward()
    })
    const job = scheduled.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: scheduled.account, trigger: "scheduled", slot: "2026-10-17T02:00:00.000Z" })
    await vi.waitFor(async () => expect((await scheduled.store.list(scheduled.account, "intune-backups")).length).toBeGreaterThan(0))
    expect(scheduled.engine.liveRuns(TENANT.toUpperCase())).toEqual([job.id])
    expect(scheduled.engine.liveRuns(OTHER)).toEqual([])
    const { backups, summary } = await dashboardCounts(scheduled.store, scheduled.account, log, undefined, scheduled.engine.liveRuns(TENANT))
    expect(backups).toMatchObject([{ runId: job.id, status: "running" }])
    expect(summary).toMatchObject({ inProgress: 1, failed: 0, finished: 0, successRate: null, latestStatus: "running" })
    resume()
    await scheduled.engine.waitForJob(job)
    expect(scheduled.engine.liveRuns(TENANT)).toEqual([])
  })

  const markerOnly: Storage = async (request, forward) => {
    if (request.method !== "PUT" || !new URL(request.url).pathname.endsWith(BACKUP_OWNER_FILE)) return forward()
    await forward()
    return Response.error()
  }
  const isMarkerRead = (request: Request) => request.method === "GET" && new URL(request.url).pathname.endsWith(BACKUP_OWNER_FILE)

  it("counts a run once when its folder's marker cannot be read", async () => {
    const log = new FailedAttemptLog(memoryStore())
    // Seven hours ago, so a folder without a manifest is no longer shown as running.
    const unanswered = engineWith(profile, (job, request) => log.finished(job, request), undefined, markerOnly, () => new Date(Date.now() - 7 * 3_600_000))
    const job = await start(unanswered.engine, unanswered.account)
    expect(job.status).toBe("Failed")
    const { backups, summary } = await dashboardCounts(unanswered.store, unanswered.account, log, async (request, forward) =>
      isMarkerRead(request) ? new Response("<Error><Code>ServerBusy</Code></Error>", { status: 503 }) : forward())
    expect(backups).toMatchObject([{ status: "unknown", runId: null, error: expect.stringContaining("ownership could not be read") }])
    expect(summary).toMatchObject({ stored: 1, failed: 1, finished: 1 })
  })

  describe("folders without a manifest from another tenant", () => {
    const put = (store: LocalBlobStore, account: string, folder: string, body: unknown) => handleLocalBlobRequest(store, new Request(
      `https://${account}.blob.core.windows.net/intune-backups/${folder}/${BACKUP_OWNER_FILE}`,
      { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: JSON.stringify(body) },
    ))
    const shared = async () => {
      const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-shared-")), [randomBytes(32)])
      const account = localStorageAccountName(TENANT)
      await handleLocalBlobRequest(store, new Request(`https://${account}.blob.core.windows.net/intune-backups?restype=container`, { method: "PUT" }))
      await put(store, account, "backup-2026-10-16-020000", { Source: "TenuVault Desktop", TenantId: OTHER, RunId: "desktop-other" })
      await put(store, account, "backup-2026-10-16-030000", { Source: "TenuVault Desktop", TenantId: TENANT.toUpperCase(), RunId: "desktop-own" })
      return { store, account }
    }

    it("leaves out a marker that names another tenant", async () => {
      const { store, account } = await shared()
      const { backups } = await dashboardCounts(store, account, new FailedAttemptLog(memoryStore()))
      expect(backups.map((backup) => backup.runId)).toEqual(["desktop-own"])
    })

    it("leaves out a marker that cannot be opened or authenticated for this tenant", async () => {
      const { store, account } = await shared()
      const sealedForOther = Object.assign(new Error("Backup authentication failed"), { name: "FetchApplicationError" })
      const { backups } = await dashboardCounts(store, account, new FailedAttemptLog(memoryStore()), async (request, forward) => {
        if (!isMarkerRead(request)) return forward()
        if (request.url.includes("030000")) throw sealedForOther
        const response = await forward()
        const headers = new Headers(response.headers)
        headers.set("x-tenuvault-authenticated", "false")
        return new Response(await response.text(), { status: response.status, headers })
      })
      expect(backups).toEqual([])
    })

    it("brings a folder back once its marker can be opened, for example after the recovery key is imported", async () => {
      const { store, account } = await shared()
      const log = new FailedAttemptLog(memoryStore())
      const noKey = Object.assign(new Error("Backup authentication failed"), { name: "FetchApplicationError" })
      const before = await dashboardCounts(store, account, log, async (request, forward) => isMarkerRead(request) && request.url.includes("030000") ? Promise.reject(noKey) : forward())
      expect(before.backups).toEqual([])
      const after = await dashboardCounts(store, account, log)
      expect(after.backups.map((backup) => backup.runId)).toEqual(["desktop-own"])
    })
  })
})
