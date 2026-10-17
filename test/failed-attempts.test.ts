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

  it("records only failed jobs that left no backup folder", () => {
    const log = new FailedAttemptLog(memoryStore())
    log.finished(job({ status: "Completed", folderClaimed: true }), manual)
    log.finished(job({ status: "Cancelled" }), manual)
    // A run that stopped after claiming its folder is counted from the folder (a Failed manifest).
    log.finished(job({ folderClaimed: true, exception: "Backup stopped" }), slot("2026-10-17T02:00:00.000Z"))
    // A claim whose outcome is unknown may have left a folder, which storage then counts.
    log.finished(job({ folderUnknown: true }), manual)
    expect(log.list(TENANT)).toEqual([])
    log.finished(job({ exception: "Sign in again.\nAADSTS700082" }), slot("2026-10-17T02:00:00.000Z"))
    expect(log.list(TENANT)).toMatchObject([{ trigger: "scheduled", slot: "2026-10-17T02:00:00.000Z", message: "Sign in again." }])
  })

  it("counts every manual and tray failure, also repeated connection failures", () => {
    const log = new FailedAttemptLog(memoryStore())
    log.finished(offline, manual)
    log.finished(offline, manual)
    log.finished(offline, { ...manual, trigger: "tray" })
    log.finished(offline, { ...manual, trigger: "tray" })
    expect(log.list(TENANT).map((entry) => entry.trigger)).toEqual(["tray", "tray", "manual", "manual"])
  })

  it("counts the retries of one scheduled slot once, also after a restart", () => {
    const store = memoryStore()
    const first = new FailedAttemptLog(store)
    first.finished(offline, slot("2026-10-17T02:00:00.000Z"))
    first.finished(offline, slot("2026-10-17T02:00:00.000Z"))
    expect(first.record({ tenantId: TENANT, trigger: "scheduled", slot: "2026-10-17T02:00:00.000Z", message: "Not backed up: a license is required." })).toBeNull()
    const restarted = new FailedAttemptLog(store)
    restarted.finished(offline, slot("2026-10-17T02:00:00.000Z"))
    expect(restarted.list(TENANT)).toHaveLength(1)
    // The next slot, and the same slot of another tenant, count on their own.
    restarted.finished(offline, slot("2026-10-18T02:00:00.000Z"))
    restarted.finished({ ...offline, tenantId: OTHER }, { ...slot("2026-10-17T02:00:00.000Z"), tenantId: OTHER })
    expect(restarted.list(TENANT)).toHaveLength(2)
    expect(restarted.list(OTHER)).toHaveLength(1)
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
  function engineWith(graph: (url: URL) => Response, onFinished: (job: BackupJob, request: BackupRequest) => void, getToken = async () => "token", storage: Storage = (_request, forward) => forward()) {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-attempts-")), [randomBytes(32)])
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (localAccountFromUrl(url)) return storage(request, () => handleLocalBlobRequest(store, request))
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
    const ended: Array<{ job: BackupJob; trigger: string | undefined; claimed: boolean | undefined }> = []
    const onFinished = (job: BackupJob, request: BackupRequest) => void ended.push({ job, trigger: request.trigger, claimed: job.folderClaimed })

    const ok = engineWith(oneItem(() => Response.json({ id: "dc1", displayName: "Profile" })), onFinished)
    const done = ok.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: ok.account, trigger: "scheduled" })
    // A second request with another scope does not join and fails at once, without a folder.
    const conflict = ok.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: ok.account, scope: { excluded: ["DeviceConfigurations"] } })
    expect(conflict.status).toBe("Failed")
    await ok.engine.waitForJob(done)
    expect(ended.map((entry) => [entry.job.status, entry.trigger, entry.claimed])).toEqual([["Failed", undefined, undefined], ["Completed", "scheduled", true]])

    ended.length = 0
    const signIn = engineWith(oneItem(() => Response.json({})), onFinished, async () => { throw new Error("Sign in again.") })
    await signIn.engine.waitForJob(signIn.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: signIn.account }))
    expect(ended.map((entry) => [entry.job.status, entry.claimed])).toEqual([["Failed", undefined]])
    expect(await signIn.store.list(signIn.account, "intune-backups").catch(() => [])).toEqual([])
  })

  it("leaves a run that wrote a failed manifest to its folder, so it is not counted twice", async () => {
    const store = memoryStore()
    const log = new FailedAttemptLog(store)
    const expired = engineWith(oneItem(() => Response.json({ error: { message: "Unauthorized" } }, { status: 401 })), (job, request) => log.finished(job, request))
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
      : Response.json({ value: [] }), (job, request) => log.finished(job, request))
    const job = await failing.engine.waitForJob(failing.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: failing.account }))
    expect(job.status).toBe("Failed")
    expect(job.folderClaimed).toBeUndefined()
    expect(log.list(TENANT)).toMatchObject([{ trigger: "manual" }])
  })

  // Storage saves the claim marker, but the response is lost; the retry is then refused because the marker exists.
  const lostClaimResponse = (afterwards: Storage = (_request, forward) => forward()): Storage => {
    let lost = false
    return async (request, forward) => {
      if (request.method === "PUT" && new URL(request.url).pathname.endsWith(BACKUP_OWNER_FILE) && !lost) {
        lost = true
        await forward()
        throw new TypeError("network error")
      }
      return afterwards(request, forward)
    }
  }
  const profile = oneItem(() => Response.json({ id: "dc1", displayName: "Profile" }))

  it("continues a run whose claim landed but whose response was lost, and records no failure", async () => {
    const log = new FailedAttemptLog(memoryStore())
    const lost = engineWith(profile, (job, request) => log.finished(job, request), undefined, lostClaimResponse())
    const job = await lost.engine.waitForJob(lost.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: lost.account }))
    expect(job.status).toBe("Completed")
    expect(job.folderClaimed).toBe(true)
    const owner = JSON.parse((await lost.store.get(lost.account, "intune-backups", `${job.backupFolder}/${BACKUP_OWNER_FILE}`)).data.toString())
    expect(owner).toMatchObject({ TenantId: TENANT, RunId: job.id })
    expect(log.list(TENANT)).toEqual([])
  })

  it("records no failure when it cannot tell whether a lost claim landed", async () => {
    const log = new FailedAttemptLog(memoryStore())
    const unreadable: Storage = async (request, forward) => request.method === "GET" && new URL(request.url).pathname.endsWith(BACKUP_OWNER_FILE)
      ? new Response("<Error><Code>AuthorizationFailure</Code></Error>", { status: 403 })
      : forward()
    const lost = engineWith(profile, (job, request) => log.finished(job, request), undefined, lostClaimResponse(unreadable))
    const job = await lost.engine.waitForJob(lost.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: lost.account }))
    expect(job.status).toBe("Failed")
    expect(job).toMatchObject({ folderUnknown: true })
    expect(job.folderClaimed).toBeUndefined()
    expect(log.list(TENANT)).toEqual([])
  })

  it("still records a rival's claim as a failure without a folder", async () => {
    const log = new FailedAttemptLog(memoryStore())
    const rival: Storage = async (request, forward) => request.method === "PUT" && new URL(request.url).pathname.endsWith(BACKUP_OWNER_FILE)
      ? new Response(null, { status: 412, headers: { "x-ms-error-code": "BlobAlreadyExists" } })
      : forward()
    const taken = engineWith(profile, (job, request) => log.finished(job, request), undefined, rival)
    const job = await taken.engine.waitForJob(taken.engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: taken.account }))
    expect(job.exception).toContain("already in use by another backup")
    expect(job.folderUnknown).toBeUndefined()
    expect(log.list(TENANT)).toHaveLength(1)
  })
})
