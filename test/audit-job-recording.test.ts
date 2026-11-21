import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { AuditSink } from "../src/main/api/audit-sink"
import { recordBackupAudit } from "../src/main/backup/audit"
import { BackupEngine } from "../src/main/backup/engine"
import { AuditStorageService } from "../src/portal/lib/audit/storage"
import { auditExportCSV, auditExportJSON } from "../src/portal/lib/audit/export"
import { pendingEvents, setAuditOutboxStore } from "../src/portal/lib/audit/outbox"
import { createAuditLogger } from "../src/portal/lib/audit/logger"
import { AuditEventType, type AuditJob, type AuditLogEntry } from "../src/portal/lib/audit/types"
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
afterEach(() => { setAuditOutboxStore(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function storage() {
  const blobs = new Map<string, { body: string; timestamp: string | null }>()
  let loseResponse = false
  let denied = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.searchParams.get("comp") === "list") {
      const prefix = url.searchParams.get("prefix") ?? ""
      return new Response(`<EnumerationResults><Blobs>${[...blobs].filter(([key]) => key.slice(1).startsWith(prefix)).map(([key, data]) =>
        `<Blob><Name>${key.slice(1)}</Name>${data.timestamp ? `<Metadata><audit_timestamp>${data.timestamp}</audit_timestamp><audit_entries>1</audit_entries></Metadata>` : ""}</Blob>`).join("")}</Blobs></EnumerationResults>`)
    }
    const name = url.pathname.replace("/audit-logs", "")
    if (init?.method === "PUT") {
      expect(new Headers(init.headers).get("if-none-match")).toBe("*")
      if (denied || blobs.has(name)) return new Response(null, { status: 403 })
      blobs.set(name, { body: String(init.body), timestamp: new Headers(init.headers).get("x-ms-meta-audit_timestamp") })
      if (loseResponse) { loseResponse = false; throw new Error(canary) }
      return new Response(null, { status: 201 })
    }
    return blobs.has(name) ? new Response(blobs.get(name)!.body) : new Response(null, { status: 404 })
  }
  vi.stubGlobal("fetch", fetcher)
  return { blobs, service: new AuditStorageService(credentials), lose: () => { loseResponse = true }, deny: () => { denied = true }, allow: () => { denied = false } }
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
