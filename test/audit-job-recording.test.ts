import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AuditSink, setMainAuditSink } from "../src/main/api/audit-sink"
import { NextRequest } from "../src/main/api/next-server-shim"
import { checkpointBackupAudit, reconcileBackupAudit, recordBackupAudit } from "../src/main/backup/audit"
import { BackupEngine } from "../src/main/backup/engine"
import { POST as auditLogs } from "../src/portal/app/api/audit/logs/route"
import { AuditContainerMissingError, AuditStorageService } from "../src/portal/lib/audit/storage"
import { auditExportCSV, auditExportJSON } from "../src/portal/lib/audit/export"
import { pendingEvents, setAuditOutboxStore } from "../src/portal/lib/audit/outbox"
import { createAuditLogger } from "../src/portal/lib/audit/logger"
import { AuditEventType, AuditResult, AuditSeverity, type AuditJob, type AuditLogEntry } from "../src/portal/lib/audit/types"
import { graphCaller, Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { projectItem } from "../src/portal/lib/audit/projection"
import { auditChanges } from "../src/portal/lib/audit/restore-changes"
import { recordRestorePreparationFailure, restoreAuditItem } from "../src/portal/lib/audit/restore"
import { clearSettingNames, readSettingNames } from "../src/portal/lib/drift/setting-names"
import { typeForFolder } from "../src/shared/intune/registry"
import { memoryStore } from "./helpers"

const tenantId = "11111111-1111-1111-1111-111111111111"
const registration = "22222222-2222-2222-2222-222222222222"
const storageAccountName = "audittest"
const binding = { tenantId, storageAccountName, user: { id: "admin", email: "admin@example.test", name: "Admin" } }
const credentials = { storageAccountName, accessToken: "reader-token", provisionContainer: false }
const canary = "secretCanaryThatMustNeverAppear"
const job = (items: AuditJob["items"] = []): AuditJob => ({
  operationId: randomUUID(), runId: randomUUID(), stage: "terminal", producer: "desktop", status: "uncertain", counts: {}, items,
})
const input = (value: AuditJob) => ({
  eventType: AuditEventType.RESTORE_COMPLETED, action: "Restore backup in place",
  resource: { type: "backup" as const, id: "backup-2026-11-15-120000", name: canary },
  details: { script: canary, note: canary, error: { code: canary, message: canary }, [canary]: 1 },
  job: value,
})
const dateFilter = { startDate: new Date(Date.now() - 86400_000), endDate: new Date(Date.now() + 86400_000), tenantId }
const meta = { tenantId, exportedAt: new Date().toISOString(), filter: dateFilter, pendingCount: 0 }
afterEach(() => { clearSettingNames(); setMainAuditSink(undefined); setAuditOutboxStore(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function storage() {
  const blobs = new Map<string, { body: string; timestamp: string | null }>()
  const ages = new Map<string, string>()
  let loseResponse = false
  let denied = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.searchParams.get("comp") === "list") {
      const prefix = url.searchParams.get("prefix") ?? ""
      return new Response(`<EnumerationResults><Blobs>${[...blobs].filter(([key]) => key.slice(1).startsWith(prefix)).map(([key, data]) =>
        `<Blob><Name>${key.slice(1)}</Name><Properties><Last-Modified>${ages.get(key) ?? new Date().toUTCString()}</Last-Modified></Properties>${data.timestamp ? `<Metadata><audit_timestamp>${data.timestamp}</audit_timestamp><audit_entries>1</audit_entries></Metadata>` : ""}</Blob>`).join("")}</Blobs></EnumerationResults>`)
    }
    const name = url.pathname.replace("/audit-logs", "")
    if (init?.method === "PUT") {
      expect(new Headers(init.headers).get("if-none-match")).toBe("*")
      if (denied || blobs.has(name)) return new Response(null, { status: 403 })
      blobs.set(name, { body: String(init.body), timestamp: new Headers(init.headers).get("x-ms-meta-audit_timestamp") })
      if (loseResponse) { loseResponse = false; throw new Error(canary) }
      return new Response(null, { status: 201 })
    }
    if (init?.method === "DELETE") return new Response(null, { status: blobs.delete(name) ? 202 : 404 })
    return blobs.has(name) ? new Response(blobs.get(name)!.body) : new Response(null, { status: 404 })
  }
  vi.stubGlobal("fetch", fetcher)
  return { blobs, ages, service: new AuditStorageService(credentials), lose: () => { loseResponse = true }, deny: () => { denied = true }, allow: () => { denied = false } }
}

it("writes only allowlisted metadata to the logger, encrypted outbox and legacy exports", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const remote = storage()
  remote.deny()
  const logger = await createAuditLogger(storageAccountName, "reader-token", binding.user)
  const queued = await logger.queue({ ...input(job()), action: canary })
  expect(JSON.stringify(queued)).not.toContain(canary)
  const logged = vi.spyOn(console, "log").mockImplementation(() => undefined)
  const sink = new AuditSink({ store: local, bind: () => binding, transport: async () => remote.service })
  await expect(sink.record(binding, input(job([{ folder: "DeviceConfigurations", outcome: "partial",
    targetId: canary, planned: [{ operation: "update", field: canary }], reason: canary,
  }])))).rejects.toThrow("queued")
  expect(local.get("audit.pending-events")).not.toContain(canary)
  expect(local.get("audit.pending-events")).not.toContain("reader-token")
  remote.allow()
  await sink.retry()
  expect([...remote.blobs.values()].map(blob => blob.body).join("")).not.toContain(canary)
  const legacy: AuditLogEntry = { ...queued, action: canary, resource: { type: "backup", id: canary, name: canary }, details: { legacyError: canary, changes: [{ field: canary, oldValue: canary, newValue: canary }] } }
  expect(auditExportJSON([legacy], { ...meta, filter: { searchQuery: canary } })).not.toContain(canary)
  expect(auditExportCSV([legacy], meta)).not.toContain(canary)
  expect(JSON.stringify(logged.mock.calls)).not.toContain(canary)
})

it("recovers completed, partial, in-flight and unattempted items after a restart", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const remote = storage()
  const options = { store: local, bind: () => binding, transport: async () => remote.service }
  const value = job(Array.from({ length: 4 }, () => ({ folder: "DeviceConfigurations", outcome: "unattempted" })))
  const first = new AuditSink(options).begin(binding, input(value))
  first.item(0, { folder: "DeviceConfigurations", outcome: "unchanged" })
  first.item(1, { folder: "DeviceConfigurations", outcome: "partial", applied: [{ operation: "update", field: "description" }] })
  first.started(2)
  const restarted = new AuditSink(options)
  restarted.recover()
  await restarted.retry()
  const [entry] = await remote.service.queryAllLogs(dateFilter)
  expect(entry?.job).toMatchObject({ operationId: value.operationId, status: "uncertain",
    counts: { unchanged: 1, partial: 1, uncertain: 1, unattempted: 1 },
    items: [{ outcome: "unchanged" }, { outcome: "partial", applied: [{ field: "description" }] }, { outcome: "uncertain" }, { outcome: "unattempted" }],
  })
})

it("checkpoints large restores once per group and marks only one group uncertain after a crash", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const save = vi.spyOn(local, "set")
  const remote = storage()
  const options = { store: local, bind: () => binding, transport: async () => remote.service }
  const entry = job(Array.from({ length: 60 }, () => ({ folder: "DeviceConfigurations", outcome: "unattempted" })))
  const restore = new AuditSink(options).begin(binding, input(entry))
  const approval = { system: "intune" as const, requestId: randomUUID() }
  for (let index = 0; index < 40; index++) {
    restore.started(index)
    if (index === 30) restore.item(index, { folder: "DeviceConfigurations", outcome: "pending", approval }, true)
    else restore.item(index, { folder: "DeviceConfigurations", outcome: "updated" })
  }
  expect(save.mock.calls.filter(([key]) => key === "audit.restore-jobs")).toHaveLength(4)
  const restarted = new AuditSink(options)
  restarted.recover()
  await restarted.retry()
  const [saved] = await remote.service.queryAllLogs(dateFilter)
  expect(saved?.job).toMatchObject({ status: "uncertain", counts: { updated: 30, pending: 1, uncertain: 19, unattempted: 10 } })
  expect(saved?.job?.items?.[30]).toMatchObject({ outcome: "pending", approval })
})

it("quarantines corrupt audit state and allows new audit events", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  local.set("audit.restore-jobs", "{invalid")
  local.set("audit.restore-receipts", '{"id":null}')
  const remote = storage()
  const sink = new AuditSink({ store: local, bind: () => binding, transport: async () => remote.service })
  expect(local.get("audit.restore-jobs.quarantine")).toBe("{invalid")
  expect(local.get("audit.restore-receipts.quarantine")).toBe('{"id":null}')
  expect(local.get("audit.restore-jobs")).toBeNull()
  await sink.record(binding, input(job()))
  expect(remote.blobs.size).toBe(1)
})

it("journals an App Backup preparation failure when the outbox cannot be written and delivers it on retry", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const save = local.set.bind(local)
  let outboxUnavailable = true
  vi.spyOn(local, "set").mockImplementation((key, value) => {
    if (outboxUnavailable && key === "audit.pending-events") throw new Error("Outbox temporarily unavailable")
    save(key, value)
  })
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const remote = storage()
  const fetchAuditBlob = globalThis.fetch
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).hostname === "login.microsoftonline.com"
      ? Promise.resolve(Response.json({ access_token: "test" }))
      : fetchAuditBlob(input, init))
  const transport = vi.fn(async () => remote.service)
  const options = { store: local, bind: () => binding, transport }
  const sink = new AuditSink(options)
  setMainAuditSink(sink)
  const runId = randomUUID()
  await expect(recordRestorePreparationFailure({
    destination: tenantId, sourceBackupId: randomUUID(), operationId: randomUUID(), runId, action: "Restore app backup",
  })).rejects.toThrow("Outbox temporarily unavailable")
  expect(sink.pending(tenantId, "desktop")).toBe(1)
  expect(local.get("audit.restore-jobs")).toContain('"finished":true')
  expect(local.get("audit.restore-jobs")).not.toContain(canary)
  expect(transport).not.toHaveBeenCalled()
  const logs = await auditLogs(new NextRequest("http://tenuvault.internal/api/audit/logs", {
    method: "POST", body: JSON.stringify({ tenantId, storageAccountName, appId: registration, clientSecret: "test" }),
  }))
  expect(await logs.json()).toMatchObject({ success: true, pendingCount: 1 })

  outboxUnavailable = false
  const restarted = new AuditSink(options)
  await restarted.retry()
  await restarted.retry()
  expect(restarted.pending(tenantId, "desktop")).toBe(0)
  expect(await remote.service.queryAllLogs(dateFilter)).toMatchObject([
    { eventType: AuditEventType.RESTORE_FAILED, action: "Restore app backup", job: { runId, status: "failed", reason: "RESTORE_PREPARATION_FAILED" } },
  ])
  expect(transport).toHaveBeenCalledTimes(1)
})

it("keeps a job count of one and exports every item when a detail page loses its acknowledgement", async () => {
  const remote = storage()
  const value = job(Array.from({ length: 205 }, (_, index) => ({
    folder: "DeviceConfigurations", outcome: "updated", targetId: `target-${index}`, applied: [{ operation: "update", field: "description" }],
  })))
  const sink = new AuditSink({ bind: () => binding, transport: async () => remote.service })
  remote.lose()
  await expect(sink.record(binding, input(value))).rejects.toThrow(canary)
  expect(remote.blobs.size).toBe(1)
  await sink.retry()
  expect(remote.blobs.size).toBe(4)
  expect([...remote.blobs.keys()].filter(name => name.includes("audit-log-"))).toHaveLength(1)
  const entries = await remote.service.queryAllLogs(dateFilter)
  expect(entries).toHaveLength(1)
  expect(entries[0]?.job?.items).toHaveLength(205)
  expect(JSON.parse(auditExportJSON(entries, meta)).logs[0].job.items).toHaveLength(205)
  expect((await remote.service.getStats(dateFilter)).totalEvents).toBe(1)
})

it("records a joined Reader cancellation without admin sign-in and retries under its original registration", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const remote = storage()
  remote.deny()
  const admin = vi.fn(async () => { throw new Error("An admin must never be called") })
  const transports = vi.fn(async (_account: string, entry: AuditLogEntry) => {
    expect(entry.job?.registrationId).toBe(registration)
    expect(entry.user.name).toBe("Backup Reader service principal")
    return remote.service
  })
  const options = { store: local, bind: () => undefined, transport: transports }
  const sink = new AuditSink(options)
  const recorded: Promise<void>[] = []
  const engine = new BackupEngine({
    fetch, getToken: admin, unattendedTokens: () => ({ mode: "app-only", registrationId: registration, graph: () => new Promise(() => {}), storage: async () => "reader-token" }),
    onFinished: (ended, request, tokens) => {
      if (tokens) recorded.push(recordBackupAudit(sink, ended, request, tokens, binding.user, "1.5.0").catch(() => undefined))
    },
  })
  const request = { tenantId, clientId: registration, storageAccountName, trigger: "scheduled" as const }
  const run = engine.start(request)
  expect(engine.start(request)).toBe(run)
  engine.cancel(run.id)
  await vi.waitFor(() => expect(recorded).toHaveLength(1))
  await Promise.all(recorded)
  expect(admin).not.toHaveBeenCalled()
  expect(pendingEvents(storageAccountName)).toMatchObject([{ id: run.id, job: { runId: run.id, producer: "backup-reader", status: "cancelled" } }])
  remote.allow()
  setAuditOutboxStore(local)
  await new AuditSink(options).retry()
  expect((await remote.service.queryAllLogs(dateFilter)).map(entry => entry.id)).toEqual([run.id])
  expect(pendingEvents(storageAccountName)).toEqual([])
})


it("recovers a cancellation before backup execution after the first outbox write fails", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const save = local.set
  let failed = false
  vi.spyOn(local, "set").mockImplementation((key, value) => {
    if (key === "audit.pending-events" && !failed) {
      failed = true
      throw new Error("Outbox temporarily unavailable")
    }
    save(key, value)
  })
  const remote = storage()
  remote.deny()
  const options = { store: local, bind: () => binding, transport: async () => remote.service }
  const sink = new AuditSink(options)
  const started = vi.fn()
  const terminal: Promise<void>[] = []
  const engine = new BackupEngine({
    fetch, getToken: () => new Promise(() => {}),
    onStarted: started,
    onFinished: (ended, request, tokens) => {
      if (tokens && ended.tenantId === tenantId) terminal.push(recordBackupAudit(sink, ended, request, tokens, binding.user, "1.5.0").catch(() => undefined))
    },
  })
  const blocker = engine.start({ tenantId: registration, storageAccountName, clientId: registration })
  const run = engine.start({ tenantId, storageAccountName, clientId: registration })
  expect(run.status).toBe("Queued")
  engine.cancel(run.id)
  await engine.waitForJob(run)
  engine.cancel(blocker.id)
  await engine.waitForJob(blocker)
  await Promise.all(terminal)
  expect(started).toHaveBeenCalledOnce()
  expect(started.mock.calls[0]?.[0]).toBe(blocker)
  expect(failed).toBe(true)
  remote.allow()
  setAuditOutboxStore(local)
  const restarted = new AuditSink(options)
  restarted.recover()
  await restarted.retry()
  expect(await remote.service.queryAllLogs(dateFilter)).toMatchObject([{ id: run.id, job: { status: "cancelled", producer: "desktop" } }])
})

it("keeps a finalized restore checkpoint when the encrypted outbox write fails", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const remote = storage()
  const save = local.set
  const write = vi.spyOn(local, "set").mockImplementation((key, value) => {
    if (key === "audit.pending-events") throw new Error(canary)
    save(key, value)
  })
  const log = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const options = { store: local, bind: () => binding, transport: async () => remote.service }
  const started = new AuditSink(options).begin(binding, input(job([{ folder: "DeviceConfigurations", outcome: "unattempted" }])))
  started.item(0, { folder: "DeviceConfigurations", outcome: "unchanged" })
  started.finish()
  expect(pendingEvents(storageAccountName)).toEqual([])
  expect(local.get("audit.restore-jobs")).toContain('"finished":true')
  expect(JSON.stringify(log.mock.calls)).not.toContain(canary)
  write.mockRestore()
  const restarted = new AuditSink(options)
  restarted.recover()
  await restarted.retry()
  expect(await remote.service.queryAllLogs(dateFilter)).toMatchObject([{ job: { status: "completed", counts: { unchanged: 1 } } }])
})

it("lets an administrator confirm a Reader entry after a lost response without delivering it again", async () => {
  const remote = storage()
  const value = { ...job(), producer: "backup-reader" as const, registrationId: registration }
  const sink = new AuditSink({ bind: () => binding, transport: async () => remote.service })
  remote.lose()
  await expect(sink.record(binding, input(value))).rejects.toThrow(canary)
  expect(remote.blobs.size).toBe(1)
  const admin = new AuditStorageService({ storageAccountName, accessToken: "admin-token" })
  expect(await admin.retryPending(tenantId)).toBe(0)
  expect(remote.blobs.size).toBe(1)
  expect((await admin.queryAllLogs(dateFilter))[0]?.job?.producer).toBe("backup-reader")
})

it("keeps unverified Catalog IDs out of failed restore checkpoints, outbox, storage and exports", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const remote = storage()
  remote.deny()
  const sink = new AuditSink({ store: local, bind: () => binding, transport: async () => remote.service })
  const path = "backup-2026-11-15-120000/ConfigurationPolicies/Example.json"
  const invalidId = "device_canary_credential_placeholder"
  const verifiedId = "device_vendor_msft_policy_config_camera_allowcamera"
  await readSettingNames([verifiedId], async () => ({ status: 200, body: { responses: [
    { id: "0", status: 200, body: { id: verifiedId, displayName: "Camera" } },
  ] } }))
  const restorer = new Restorer(async () => ({ status: 400, body: { error: { message: invalidId } } }),
    { mode: "copy", assignments: false, auditProgress: vi.fn() })
  const result = await restorer.restore(path, { name: "Example", settings: [catalogSetting(invalidId, 1), catalogSetting(verifiedId, 1)] })
  expect(result.success).toBe(false)
  const checkpoint = sink.begin(binding, input(job([restoreAuditItem(path)])))
  checkpoint.item(0, restoreAuditItem(path, result))
  expect(local.get("audit.restore-jobs")).not.toContain(invalidId)
  checkpoint.finish()
  expect(local.get("audit.pending-events")).not.toContain(invalidId)
  remote.allow()
  await sink.retry()
  expect([...remote.blobs.values()].map(blob => blob.body).join("")).not.toContain(invalidId)
  const entries = await remote.service.queryAllLogs(dateFilter)
  expect(entries[0]?.job?.items?.[0]).toMatchObject({ outcome: "failed", planned: expect.arrayContaining([
    { operation: "create", field: "settings" }, { operation: "create", catalogVerified: true, settingDefinitionId: verifiedId },
  ]) })
  const legacy = structuredClone(entries[0]!)
  legacy.job!.items![0]!.planned!.push({ operation: "create", settingDefinitionId: invalidId })
  expect(auditExportJSON([legacy], meta)).not.toContain(invalidId)
  expect(auditExportCSV([legacy], meta)).not.toContain(invalidId)
})

const catalogSetting = (settingDefinitionId: string, value: number) => ({
  settingInstance: { settingDefinitionId, simpleSettingValue: { value } },
})

it("reports only the changed Settings Catalog ID for a successful in-place write", async () => {
  const changed = "device_vendor_msft_policy_config_camera_allowcamera"
  const unchanged = "device_vendor_msft_policy_config_system_allowlocation"
  const snapshot = { id: "policy", name: "Example", settings: [catalogSetting(changed, 1), catalogSetting(unchanged, 1)] }
  await readSettingNames([changed, unchanged], async (_method, _url, body) => ({ status: 200, body: { responses:
    (body!.requests as { id: string; url: string }[]).map(request => ({
      id: request.id, status: 200, body: { id: request.url.split("/").at(-1)!, displayName: "Example setting" },
    })),
  } }))
  const restorer = new Restorer(async (method, url): ReturnType<GraphCall> => {
    expect(url).not.toBe("$batch")
    if (method === "GET") {
      return url.endsWith("/assignments") ? { status: 200, body: { value: [] } }
        : { status: 200, body: { ...snapshot, settings: [catalogSetting(changed, 0), catalogSetting(unchanged, 1)] } }
    }
    return { status: 204, body: {} }
  }, { mode: "replace", assignments: false, auditProgress: vi.fn() })
  const result = await restorer.restore("backup/ConfigurationPolicies/Example.json", snapshot)
  expect(result.success).toBe(true)
  expect(result.auditPlanned?.flatMap(change => change.settingDefinitionId ?? [])).toEqual([changed])
  expect(result.auditApplied?.flatMap(change => change.settingDefinitionId ?? [])).toEqual([changed])
})

it("preserves the Graph write sequence when a restore uses the last request in the quota", async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (url, request) => {
    calls.push(`${request?.method} ${new URL(String(url)).pathname}`)
    if (calls.length > 1) return Response.json({ error: { message: "Throttled" } }, {
      status: 429, headers: { "Retry-After": "60" },
    })
    return Response.json({ id: "created-policy" }, { status: 201 })
  }
  const restorer = new Restorer(graphCaller("test-token", fetcher), { mode: "copy", assignments: false, auditProgress: vi.fn() })
  const result = await restorer.restore("backup/ConfigurationPolicies/Example.json", {
    name: "Example", settings: [catalogSetting("device_vendor_msft_policy_config_camera_allowcamera", 1)],
  })
  expect(calls).toEqual(["POST /beta/deviceManagement/configurationPolicies"])
  expect(result).toMatchObject({ success: true, auditApplied: expect.arrayContaining([{ operation: "create", field: "settings" }]) })
  expect(result.auditApplied?.some(change => change.settingDefinitionId)).toBe(false)
})

it("records only changed top-level schema paths for a Windows configuration", async () => {
  const snapshot = { id: "policy", "@odata.type": "#microsoft.graph.windows10GeneralConfiguration", displayName: "Example",
    passwordMinimumLength: 10, cameraBlocked: true, extraPrivateKey: "ignored", }
  const restorer = new Restorer(async (method) => method === "GET"
    ? { status: 200, body: { ...snapshot, passwordMinimumLength: 8, cameraBlocked: false, extraPrivateKey: "custom" } }
    : { status: 204, body: {} }, { mode: "replace", assignments: false })
  const path = "backup/DeviceConfigurations/Example.json"
  const result = projectItem(restoreAuditItem(path, await restorer.restore(path, snapshot)))
  expect(result.outcome).toBe("updated")
  expect(result.planned?.map(change => change.field)).toEqual(["cameraBlocked", "passwordMinimumLength"])
  expect(result.applied).toEqual(result.planned)
  const custom = { "@odata.type": "#microsoft.graph.windows10CustomConfiguration", omaSettings: [{ value: canary, [canary]: 1 }] }
  const changes = auditChanges(typeForFolder("DeviceConfigurations")!, "update", custom, { ...custom, omaSettings: [] }, true)
  expect(changes).toEqual([{ operation: "update", field: "omaSettings" }])
})

it("still captures and records the Reader terminal result when the encrypted checkpoint cannot be written", async () => {
  const local = memoryStore()
  const save = local.set
  const write = vi.spyOn(local, "set").mockImplementation((key, value) => {
    if (key === "audit.restore-jobs") throw new Error(canary)
    save(key, value)
  })
  const log = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const remote = storage()
  const sink = new AuditSink({ store: local, bind: () => binding, transport: async () => remote.service })
  const terminal: Promise<void>[] = []
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    init?.method === "PUT" ? new Response(null, { status: 201 }) : Response.json({ value: [] }))
  const engine = new BackupEngine({
    fetch: fetcher,
    getToken: async () => { throw new Error("No admin session") },
    unattendedTokens: () => ({ mode: "app-only", registrationId: registration, graph: async () => "reader-graph", storage: async () => "reader-storage" }),
    onStarted: (active, request, tokens) => checkpointBackupAudit(sink, active, request, tokens, binding.user, "1.2.3"),
    onFinished: (active, request, tokens) => {
      if (tokens) terminal.push(recordBackupAudit(sink, active, request, tokens, binding.user, "1.2.3"))
    },
  })
  const active = await engine.waitForJob(engine.start({ tenantId, storageAccountName, clientId: "admin", trigger: "scheduled" }))
  await Promise.all(terminal)
  expect(write).toHaveBeenCalledWith("audit.restore-jobs", expect.any(String))
  expect(active.status).toBe("Completed")
  expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/metadata.json") && init?.method === "PUT")).toBe(true)
  expect(log).toHaveBeenCalledWith("[audit] Backup audit checkpoint could not be saved")
  expect(await remote.service.queryAllLogs(dateFilter)).toMatchObject([{ id: active.id, job: { status: "completed", producer: "backup-reader" } }])
})

it.each([false, true])("retains a known early backup failure when the terminal journal write fails (persistent: %s)", async persistent => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const remote = storage()
  remote.deny()
  const options = { store: local, bind: () => binding, transport: async () => remote.service }
  const sink = new AuditSink(options)
  const stamp = { id: randomUUID(), timestamp: new Date().toISOString() }
  const started = input({ ...job(), runId: stamp.id, producer: "backup-reader" })
  sink.checkpointBackup(binding, { ...started, eventType: AuditEventType.BACKUP_COMPLETED }, stamp)
  const save = local.set
  let fail = true
  const write = vi.spyOn(local, "set").mockImplementation((key, value) => {
    if (key === "audit.restore-jobs" && fail) {
      fail = persistent
      throw new Error("Journal unavailable")
    }
    save(key, value)
  })
  await expect(sink.record(binding, {
    ...started, eventType: AuditEventType.BACKUP_FAILED, result: AuditResult.FAILURE, severity: AuditSeverity.ERROR,
    job: { ...started.job, status: "failed", reason: "BACKUP_FAILED" },
  }, stamp)).rejects.toThrow()
  expect(pendingEvents(storageAccountName)).toMatchObject([{ id: stamp.id, job: { status: "failed" } }])
  write.mockRestore()
  remote.allow()
  const restarted = new AuditSink(options)
  const reconcile = vi.fn(async (_binding, entry: AuditLogEntry) => entry)
  await restarted.recoverBackups(reconcile)
  await restarted.retry()
  expect(reconcile).not.toHaveBeenCalled()
  expect(await remote.service.queryAllLogs(dateFilter)).toMatchObject([{ id: stamp.id, job: { status: "failed" } }])
})

it.each([
  ["app-only", "Success"], ["app-only", "foreign"], ["app-only", "missing"], ["app-only", "offline"],
  ["app-only", "throttled"], ["delegated", "Success"], ["delegated", "wrong run"],
] as const)("recovers a %s checkpoint using the original binding when its manifest is %s", async (mode, status) => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const remote = storage()
  const opts = { store: local, bind: () => binding, transport: async (_account: string, entry: AuditLogEntry) => {
    expect(entry.job?.registrationId).toBe(mode === "app-only" ? registration : undefined)
    return remote.service
  } }
  const first = new AuditSink(opts)
  let committed: Record<string, unknown> | undefined
  const engine = new BackupEngine({
    getToken: async () => {
      if (mode === "app-only") throw new Error("No admin session")
      return "admin-token"
    },
    unattendedTokens: () => ({ mode: "app-only", registrationId: registration, graph: async () => "reader-graph", storage: async () => "reader-storage" }),
    fetch: vi.fn(async (input, init) => {
      expect(local.get("audit.restore-jobs")).toContain(mode === "app-only" ? registration : binding.user.email)
      const url = new URL(String(input))
      if (init?.method === "PUT") {
        if (url.pathname.endsWith("/metadata.json")) committed = JSON.parse(String(init.body))
        return new Response(null, { status: 201 })
      }
      if (url.pathname === "/beta/deviceManagement/deviceConfigurations") return Response.json({ value: [{ id: "first", displayName: "Example" }] })
      return Response.json({ id: "first", value: [] })
    }),
    onStarted: (active, request, tokens) => checkpointBackupAudit(first, active, request, tokens, binding.user, "1.2.3"),
  })
  const active = engine.start({ tenantId, storageAccountName, clientId: "admin", trigger: mode === "app-only" ? "scheduled" : "manual" })
  await engine.waitForJob(active)
  expect(committed).toMatchObject({ TenantId: tenantId, RunId: active.id, Status: "Success" })
  expect(local.get("audit.restore-jobs")).toContain(active.id)
  const restarted = new AuditSink(opts)
  restarted.recover()
  const recover = () => restarted.recoverBackups((original, entry) => {
    expect(original).toMatchObject({ tenantId, storageAccountName, user: { id: mode === "app-only" ? registration : binding.user.id } })
    expect(entry.resource.id).toBe(active.backupFolder)
    return reconcileBackupAudit(entry, async () => status === "missing" ? new Response(null, { status: 404 })
      : Response.json({ ...committed, TenantId: status === "foreign" ? registration : tenantId,
        RunId: status === "wrong run" ? "different-run" : active.id }))
  })
  if (status === "offline" || status === "throttled") {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await restarted.recoverBackups((_, entry) => reconcileBackupAudit(entry, async () => {
      if (status === "offline") throw new TypeError("Network is temporarily unreachable")
      return new Response(null, { status: 429 })
    }))
    await restarted.retry()
    expect(restarted.pending(tenantId, "backup-reader")).toBe(1)
    expect(remote.blobs.size).toBe(0)
    expect(local.get("audit.restore-jobs")).toContain(active.id)
  }
  await recover()
  await restarted.retry()
  const [event] = await remote.service.queryAllLogs(dateFilter)
  expect(event?.id).toBe(active.id)
  expect(event?.job?.status).toBe(["Success", "offline", "throttled"].includes(status) ? "completed" : "uncertain")
  if (status === "Success") expect(event?.job?.counts.saved).toBe(active.totalPolicies)
  const last = new AuditSink(opts)
  last.recover()
  await last.recoverBackups(vi.fn(() => { throw new Error("Reconciled twice") }))
  await last.retry()
  expect(remote.blobs.size).toBe(1)
})

it("reconciles a lost manifest acknowledgement in audit after the Reader job fails", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const remote = storage()
  const sink = new AuditSink({ store: local, bind: () => binding, transport: async () => remote.service })
  const terminal: Promise<void>[] = []
  let manifest: string | undefined
  const readManifest = vi.fn(async () => new Response(manifest))
  const engine = new BackupEngine({
    getToken: async () => { throw new Error("No admin session") },
    unattendedTokens: () => ({ mode: "app-only", registrationId: registration, graph: async () => "reader-graph", storage: async () => "reader-storage" }),
    fetch: async (input, init) => {
      if (String(input).endsWith("/metadata.json")) {
        if (init?.method !== "PUT") return readManifest()
        manifest = String(init.body)
        throw new TypeError("Manifest acknowledgement lost")
      }
      return init?.method === "PUT" ? new Response(null, { status: 201 }) : Response.json({ value: [] })
    },
    onStarted: (active, request, tokens) => checkpointBackupAudit(sink, active, request, tokens, binding.user, "1.2.3"),
    onFinished: (active, request, tokens) => {
      if (tokens) terminal.push(recordBackupAudit(sink, active, request, tokens, binding.user, "1.2.3"))
    },
  })
  const active = await engine.waitForJob(engine.start({ tenantId, storageAccountName, clientId: "admin", trigger: "scheduled" }))
  await Promise.all(terminal)
  expect(active).toMatchObject({ status: "Failed", commitUnconfirmed: true, exception: "Manifest acknowledgement lost" })
  expect(readManifest).not.toHaveBeenCalled()
  expect(sink.pending(tenantId, "backup-reader")).toBe(1)
  expect(remote.blobs.size).toBe(0)
  await sink.recoverBackups((original, entry) => {
    expect(original).toMatchObject({ tenantId, storageAccountName })
    expect(entry.job).toMatchObject({ runId: active.id, status: "uncertain", reason: "WRITE_UNCONFIRMED", registrationId: registration })
    return reconcileBackupAudit(entry, readManifest)
  })
  await sink.retry()
  expect(readManifest).toHaveBeenCalledTimes(1)
  expect(sink.pending(tenantId, "backup-reader")).toBe(0)
  expect(await remote.service.queryAllLogs(dateFilter)).toMatchObject([{ id: active.id, job: { status: "completed", producer: "backup-reader" } }])
  expect(active.status).toBe("Failed")
}, 10_000)

it.each([403, 201])("only passes a Reader permission canary when overwrite and both deletes are denied (%s)", async overwriteStatus => {
  const calls: Array<{ method?: string; path: string; match: string | null }> = []
  let auditBody: BodyInit | null | undefined
  const service = new AuditStorageService({ ...credentials, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname
    const match = new Headers(init?.headers).get("if-match")
    calls.push({ path, method: init?.method, match })
    if (init?.method === "DELETE") return new Response(null, { status: overwriteStatus === 403 ? 403 : 202 })
    if (init?.method === "PUT") {
      if (path.startsWith("/audit-logs/") && !match) auditBody = init.body
      return new Response(null, { status: match ? overwriteStatus : 201 })
    }
    return new Response(auditBody)
  } })
  if (overwriteStatus === 403) await expect(service.testProducerAccess(tenantId)).resolves.toBe(true)
  else await expect(service.testProducerAccess(tenantId)).rejects.toThrow("excessive Azure Storage permissions")
  expect(calls.filter(call => call.method === "DELETE").map(call => call.path.split("/")[1]).sort()).toEqual(["audit-logs", "intune-backups"])
  expect(calls.every(call => call.path.includes("/producer-tests/"))).toBe(true)
  expect(calls.filter(call => call.match === "*")).toMatchObject([{ method: "PUT", path: expect.stringContaining("/audit-logs/") }])
})

it("surfaces a missing audit container during Reader delivery and keeps the original event pending", async () => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const onDelivery = vi.fn()
  const service = new AuditStorageService({ ...credentials, fetch: async () =>
    new Response(null, { status: 404, headers: { "x-ms-error-code": "ContainerNotFound" } }),
  })
  const sink = new AuditSink({ store: local, bind: () => binding, transport: async () => service, onDelivery })
  await expect(sink.record(binding, input({ ...job(), producer: "backup-reader" }))).rejects.toThrow("Rerun the Azure storage setup")
  expect(onDelivery).toHaveBeenCalledWith(storageAccountName, expect.objectContaining({ job: expect.objectContaining({ producer: "backup-reader" }) }), expect.any(AuditContainerMissingError))
  expect(sink.pending(tenantId, "backup-reader")).toBe(1)
})

it("drops an unsupported legacy Intune decision timestamp at the export boundary", () => {
  const item = { folder: "ConfigurationPolicies", outcome: "updated" as const,
    approval: { system: "intune" as const, requestId: registration, decisionAt: "2026-11-20T12:00:00Z" } }
  expect(projectItem(item).approval).toMatchObject({ requestId: registration, decisionAt: undefined })
  expect(projectItem({ ...item, approval: { ...item.approval, system: "tenuvault" } }).approval?.decisionAt).toBe("2026-11-20T12:00:00.000Z")
})

it("keeps old detail pages until their root expires and preserves incomplete rows in history and exports", async () => {
  const remote = storage()
  const value = job(Array.from({ length: 105 }, () => ({ folder: "DeviceConfigurations", outcome: "updated" })))
  const sink = new AuditSink({ bind: () => binding, transport: async () => remote.service })
  await sink.record(binding, input(value))
  const [first, second] = [...remote.blobs.keys()].filter(name => name.startsWith("/job-details/"))
  const root = [...remote.blobs.keys()].find(name => name.includes("-event-"))!
  expect(first).toBeDefined()
  expect(second).toBeDefined()
  remote.ages.set(first!, new Date(0).toUTCString())
  remote.ages.set(second!, new Date(0).toUTCString())
  expect(await remote.service.cleanupOldLogs(tenantId)).toEqual({ deleted: 0, kept: 0 })
  expect(remote.blobs.has(first!)).toBe(true)
  remote.blobs.delete(second!)
  const [history] = await remote.service.queryLogs({ ...dateFilter, limit: 10 })
  expect(history?.job).toMatchObject({ detailsIncomplete: true, detailPages: 2 })
  expect(history?.job?.items).toHaveLength(100)
  const exported = await remote.service.queryAllLogs(dateFilter)
  expect(JSON.parse(auditExportJSON(exported, meta)).logs[0].job.detailsIncomplete).toBe(true)
  expect(auditExportCSV(exported, meta)).toContain("detailsIncomplete")
  remote.ages.set(root, new Date(0).toUTCString())
  expect(await remote.service.cleanupOldLogs(tenantId)).toEqual({ deleted: 2, kept: 0 })
  expect(remote.blobs.size).toBe(0)
})

it.each(["new", "reader saved", "admin response lost"])("recovers a replaced Reader and preserves its actor (%s)", async condition => {
  const local = memoryStore()
  setAuditOutboxStore(local)
  const remote = storage()
  const service = remote.service
  const reader = { id: registration, email: "", name: "Backup Reader service principal" }
  const admin = { ...binding.user, id: randomUUID() }
  const alreadySaved = condition === "reader saved"
  const value = { ...job(), producer: "backup-reader" as const, status: "completed" as const, registrationId: registration }
  const opts = { store: local, bind: () => binding, transport: async () => service }
  if (alreadySaved) remote.lose()
  else remote.deny()
  await expect(new AuditSink(opts).record({ ...binding, user: reader }, input(value))).rejects.toThrow()
  remote.allow()
  if (condition === "admin response lost") remote.lose()
  const restarted = new AuditSink(opts)
  expect(restarted.stuckReaderCount(tenantId, registration)).toBe(0)
  expect(restarted.stuckReaderCount(tenantId, randomUUID())).toBe(1)
  expect(restarted.stuckReaderCount(randomUUID())).toBe(0)
  await restarted.deliverStuckReader(tenantId, randomUUID(), admin, account => {
    expect(account).toBe(storageAccountName)
    return service
  })
  expect(restarted.pending(tenantId, "backup-reader")).toBe(0)
  const [saved] = await service.queryAllLogs(dateFilter)
  expect(remote.blobs.size).toBe(1)
  expect(saved?.user).toMatchObject(reader)
  expect(saved?.job).toMatchObject({ runId: value.runId, producer: "backup-reader", registrationId: registration })
  expect(saved?.job?.deliveredByPrincipalId).toBe(alreadySaved ? undefined : admin.id)
  if (!alreadySaved) {
    expect(saved?.job?.producerPrincipalId).toBe(reader.id)
    const csv = auditExportCSV([saved!], meta)
    expect(csv).toContain(`,${reader.name},`)
    expect(csv).toContain(admin.id)
  }
})

it("requires fresh Reader audit creation even when the last canary remains readable", async () => {
  const blobs = new Map<string, string>()
  const checks: string[] = []
  const auditCreates: string[] = []
  const reads: string[] = []
  let canCreate = true
  let loseAck = false
  const service = new AuditStorageService({ ...credentials, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname
    const headers = new Headers(init?.headers)
    if (init?.method === "DELETE" || headers.get("if-match")) {
      checks.push(`${init?.method} ${path}`)
      return new Response(null, { status: 403 })
    }
    if (init?.method === "PUT") {
      if (path.startsWith("/audit-logs/")) {
        expect(headers.get("if-none-match")).toBe("*")
        auditCreates.push(path)
        if (!canCreate) return new Response(null, { status: 403 })
        if (blobs.has(path)) return new Response(null, { status: 412 })
      }
      blobs.set(path, String(init.body))
      if (loseAck && path.startsWith("/audit-logs/")) throw new TypeError("Acknowledgement lost")
      return new Response(null, { status: 201 })
    }
    reads.push(path)
    return new Response(blobs.get(path), { status: blobs.has(path) ? 200 : 404 })
  } })
  await expect(service.testProducerAccess(tenantId)).resolves.toBe(true)
  loseAck = true
  await expect(service.testProducerAccess(tenantId)).resolves.toBe(true)
  canCreate = false
  await expect(service.testProducerAccess(tenantId)).rejects.toThrow("could not create a blob (403)")
  expect(new Set(auditCreates).size).toBe(3)
  expect(reads).toEqual(auditCreates.slice(0, 2))
  expect(blobs.size).toBe(3)
  expect([...new Set(checks.map(check => check.split("/").slice(0, 2).join("/")))].sort()).toEqual(["DELETE /audit-logs", "DELETE /intune-backups", "PUT /audit-logs"])
})

describe("audit recovery for a run split across an ordinary and a large backup", () => {
  const tenantId = "11111111-1111-1111-1111-111111111111", runId = "desktop-7b223058-dfe2-4d7d-94f4-ce7b6ebf80ae"
  const entry = { id: runId, timestamp: "2026-11-21T00:00:00.000Z", eventType: "BACKUP_COMPLETED", action: "Complete backup", resource: { type: "backup", id: "backup-2026-11-21-000000", name: "Complete backup" },
    result: "partial", severity: "warning", user: { id: "admin", email: "", name: "Admin", tenantId }, job: { operationId: runId, runId, stage: "terminal", producer: "desktop", status: "uncertain" } } as unknown as Parameters<typeof reconcileBackupAudit>[0]
  const manifest = (extra: Record<string, unknown>) => Response.json({ RunId: runId, TenantId: tenantId, AuthMode: "delegated", Status: "Success", ...extra })
  it("keeps the record uncertain until the companion large manifest is committed", async () => {
    const result = await reconcileBackupAudit(entry, async () => manifest({ CompanionBackup: "backup-large-2026-11-21-000000" }), async () => new Response(null, { status: 404 }))
    expect(result).toBe(entry)
    expect(await reconcileBackupAudit(entry, async () => manifest({ CompanionBackup: "backup-large-2026-11-21-000000" }))).toBe(entry)
  })
  it("adds both halves' totals and reports a failed half next to saved items as warnings", async () => {
    const companion = vi.fn(async () => manifest({ Status: "Failed", CompanionBackup: "backup-2026-11-21-000000", ItemCounts: { TotalPolicies: 5 }, Failures: 2, CompletedAt: "2026-11-21T01:00:00.000Z" }))
    const result = await reconcileBackupAudit(entry, async () => manifest({ CompanionBackup: "backup-large-2026-11-21-000000", ItemCounts: { TotalPolicies: 3 }, Failures: 0, CompletedAt: "2026-11-21T00:10:00.000Z" }), companion)
    expect(companion).toHaveBeenCalledWith("backup-large-2026-11-21-000000")
    // The ordinary half saved items, so the run completes with warnings, as the engine reported it.
    expect(result.job).toMatchObject({ status: "warnings", counts: { saved: 8, failures: 2 } })
    expect(result.timestamp).toBe("2026-11-21T01:00:00.000Z")
  })
  it.each([["Failed", "failed"], ["CompletedWithWarnings", "warnings"], ["Success", "completed"]])("uses the run status %s from the run's last manifest", async (run, expected) => {
    const result = await reconcileBackupAudit(entry, async () => manifest({ Status: "Success", RunStatus: run, CompanionBackup: "backup-large-2026-11-21-000000", ItemCounts: { TotalPolicies: 4 } }), async () => manifest({ Status: "Failed", ItemCounts: { TotalPolicies: 0 } }))
    expect(result.job).toMatchObject({ status: expected })
  })
  it("confirms a run whose large half never committed from the final manifest's run status", async () => {
    const result = await reconcileBackupAudit(entry, async () => manifest({ Status: "Success", RunStatus: "CompletedWithWarnings", RunCounts: { saved: 9, failures: 1 }, ItemCounts: { TotalPolicies: 4 }, CompanionBackup: "backup-large-2026-11-21-000000" }), async () => new Response(null, { status: 404 }))
    expect(result.job).toMatchObject({ status: "warnings", counts: { saved: 9, failures: 1 } })
    // The early ordinary manifest has no run status and stays uncertain until the run ends.
    expect(await reconcileBackupAudit(entry, async () => manifest({ Status: "Success", CompanionBackup: "backup-large-2026-11-21-000000" }), async () => new Response(null, { status: 404 }))).toBe(entry)
  })
  it("counts saved directory objects, not only policies, when an older split run has no run status", async () => {
    const result = await reconcileBackupAudit(entry, async () => manifest({ Status: "Failed", CompanionBackup: "backup-large-2026-11-21-000000", ItemCounts: { TotalPolicies: 0 } }), async () => manifest({ Status: "Success", ItemCounts: { Users: 3, TotalPolicies: 0 } }))
    expect(result.job).toMatchObject({ status: "warnings" })
  })
  it("ends a split run without a run status as cancelled when either half was cancelled", async () => {
    const result = await reconcileBackupAudit(entry, async () => manifest({ Status: "Failed", CompanionBackup: "backup-large-2026-11-21-000000" }), async () => manifest({ Status: "Cancelled" }))
    expect(result.job).toMatchObject({ status: "cancelled" })
  })
  it("prefers the final manifest's run totals when both halves are present", async () => {
    const result = await reconcileBackupAudit(entry, async () => manifest({ Status: "CompletedWithWarnings", RunStatus: "CompletedWithWarnings", RunCounts: { saved: 7, failures: 1 }, ItemCounts: { TotalPolicies: 4 }, Failures: 0, CompanionBackup: "backup-large-2026-11-21-000000" }), async () => manifest({ Status: "CompletedWithWarnings", ItemCounts: { TotalPolicies: 3 }, Failures: 2 }))
    expect(result.job).toMatchObject({ status: "warnings", counts: { saved: 7, failures: 1 } })
  })
  it("records both failed halves as failed", async () => {
    const result = await reconcileBackupAudit(entry, async () => manifest({ Status: "Failed", CompanionBackup: "backup-large-2026-11-21-000000", ItemCounts: { TotalPolicies: 0 } }), async () => manifest({ Status: "Failed", ItemCounts: { TotalPolicies: 0 } }))
    expect(result.job).toMatchObject({ status: "failed" })
  })
  it("confirms a failed ordinary half whose large half was never committed", async () => {
    const result = await reconcileBackupAudit(entry, async () => manifest({ Status: "Failed", CompanionBackup: "backup-large-2026-11-21-000000" }), async () => new Response(null, { status: 404 }))
    expect(result.job).toMatchObject({ status: "failed" })
  })
  it.each([["missing", new Response(null, { status: 404 })], ["another run", Response.json({ RunId: "other", TenantId: tenantId, AuthMode: "delegated", Status: "Success" })]])("finds a large-only run when the ordinary folder is %s, and records the folder that matched", async (_case, ordinary) => {
    const read = vi.fn(async (folder: string) => folder.startsWith("backup-large-") ? manifest({}) : new Response(null, { status: 404 }))
    const result = await reconcileBackupAudit(entry, async () => ordinary, read)
    expect(read).toHaveBeenCalledWith("backup-large-2026-11-21-000000")
    expect(result.resource.id).toBe("backup-large-2026-11-21-000000")
    expect(result.job).toMatchObject({ status: "completed" })
  })
})

it("keeps ordinary and large backup folder names as audit resource IDs", async () => {
  const { auditId } = await import("../src/portal/lib/audit/projection")
  expect(auditId("backup-2026-11-21-000000")).toBe("backup-2026-11-21-000000")
  expect(auditId("backup-large-2026-11-21-000000")).toBe("backup-large-2026-11-21-000000")
  expect(auditId("backup-other-2026-11-21")).toMatch(/^sha256-/)
})
