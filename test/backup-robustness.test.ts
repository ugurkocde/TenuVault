import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine, JOB_DEADLINE_MS, type BackupJob } from "../src/main/backup/engine"
import { BackupScheduler } from "../src/main/backup/scheduler"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { memoryStore } from "./helpers"

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER = "33333333-3333-3333-3333-333333333333"
const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
const request = { tenantId: TENANT, clientId: "client", storageAccountName: "contoso", scope }
const prefix = "/intune-backups/"

function setup(options: { count?: number; retention?: number; now?: () => Date; getToken?: (tenant: string, client: string, scope: string) => Promise<string>; override?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined } = {}) {
  const saved = new Map<string, string>()
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const engine = new BackupEngine({
    now: options.now,
    retentionDays: () => options.retention ?? 0,
    getToken: options.getToken ?? (async () => "token"),
    fetch: async (input, init = {}) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      const overridden = options.override?.(url, init)
      if (overridden) return overridden
      if (url.hostname === "graph.microsoft.com") {
        return url.pathname.endsWith("/deviceConfigurations")
          ? Response.json({ value: Array.from({ length: options.count ?? 0 }, (_, index) => ({ id: `p${index}`, displayName: `Policy ${index}` })) })
          : Response.json({ id: url.pathname.split("/").at(-1) })
      }
      if (url.searchParams.get("comp") === "list") {
        const names = [...saved.keys()].filter(name => name.startsWith(url.searchParams.get("prefix") ?? ""))
        const entries = url.searchParams.get("delimiter")
          ? [...new Set(names.map(name => `${name.split("/")[0]}/`))].map(name => `<BlobPrefix><Name>${name}</Name></BlobPrefix>`)
          : names.map(name => `<Blob><Name>${name}</Name></Blob>`)
        return new Response(`<Blobs>${entries.join("")}</Blobs>`)
      }
      const name = decodeURIComponent(url.pathname.slice(prefix.length))
      if (init.method === "PUT") {
        if (!url.search) {
          saved.set(name, String(init.body))
        }
        return new Response(null, { status: 201 })
      }
      if (init.method === "DELETE") {
        saved.delete(name)
        return new Response(null, { status: 202 })
      }
      return saved.has(name)
        ? new Response(init.method === "HEAD" ? null : saved.get(name))
        : new Response(null, { status: 404 })
    },
  })
  return { engine, saved, calls }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe("bounded backup jobs", () => {
  it("cancels an ignored abort, records the reason, and releases the tenant without another request", async () => {
    vi.useFakeTimers()
    let hanging = true
    const { engine, calls } = setup({ override: url => hanging && url.hostname === "graph.microsoft.com" ? new Promise(() => {}) : undefined })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    const signal = calls.find(call => call.url.hostname === "graph.microsoft.com")!.init.signal!
    engine.cancel(job.id)
    await engine.waitForJob(job)
    expect(job).toMatchObject({ status: "Failed", progress: 100 })
    expect(job.exception).toContain("Backup cancelled by you")
    expect(job.endTime).toBeDefined()
    expect(signal.aborted).toBe(true)
    const count = calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(calls).toHaveLength(count)
    expect(vi.getTimerCount()).toBe(0)
    hanging = false
    const next = engine.start(request)
    await engine.waitForJob(next)
    expect(next.status).toBe("Completed")
    expect(next.id).not.toBe(job.id)
    engine.cancel(next.id)
    expect(next.status).toBe("Completed")
  })

  it("stops a healthy but endless listing at 30 minutes and never retries a pause past the deadline", async () => {
    vi.useFakeTimers()
    let pages = 0
    const { engine, calls } = setup({ override: url => {
      if (url.hostname !== "graph.microsoft.com") return
      pages++
      if (pages === 29) return new Response(null, { status: 429, headers: { "Retry-After": "300" } })
      return new Promise(resolve => { setTimeout(() => resolve(Response.json({ value: [], "@odata.nextLink": `https://graph.microsoft.com/beta/page?n=${pages}` })), 60_000) })
    } })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(JOB_DEADLINE_MS - 1)
    expect(job.status).toBe("Running")
    await vi.advanceTimersByTimeAsync(1)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Backup timed out after the 30 minute job deadline. Retry the backup.")
    expect(pages).toBe(29)
    const count = calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(calls).toHaveLength(count)
    const next = engine.start({ ...request, tenantId: OTHER })
    expect(next.id).not.toBe(job.id)
    engine.cancel(next.id)
    await engine.waitForJob(next)
  })

  it("records one exhausted item read timeout as a warning when a different policy succeeds", async () => {
    vi.useFakeTimers()
    const { engine, saved } = setup({ count: 2, override: url => url.hostname === "graph.microsoft.com" && url.pathname.endsWith("/p0") ? new Promise(() => {}) : undefined })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(273_000)
    await engine.waitForJob(job)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    expect(job.progressMessage).toBe("Backup completed with 1 warning")
    expect(job.log.join("\n")).toContain('Could not back up "Policy 0": Backup request timed out after 90 seconds. Check your connection and retry.')
    expect(JSON.parse(saved.get(`${job.backupFolder}/metadata.json`)!)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1, ItemCounts: { TotalPolicies: 1 }, Warnings: ['Could not back up "Policy 0": Backup request timed out after 90 seconds. Check your connection and retry.'] })
  })

  it("lets the next scheduled tenant run after a hung request fails", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 10, 1))
    let first = true
    const { engine } = setup({ override: url => first && url.hostname === "graph.microsoft.com" ? new Promise(() => {}) : undefined })
    const run = vi.fn(async (tenantId: string) => {
      const job = engine.start({ ...request, tenantId, trigger: "scheduled" })
      await engine.waitForJob(job)
      first = false
      return { status: job.status as "Completed" | "Failed", message: job.exception ?? job.progressMessage }
    })
    const scheduler = new BackupScheduler(memoryStore(), run)
    for (const tenantId of [TENANT, OTHER]) scheduler.set({ tenantId, enabled: true, frequency: "daily", time: "02:00" })
    vi.setSystemTime(new Date(2026, 9, 10, 2))
    const tick = scheduler.tick()
    await vi.advanceTimersByTimeAsync(273_000)
    await tick
    expect(run.mock.calls.map(([tenant]) => tenant)).toEqual([TENANT, OTHER])
    expect(scheduler.list().find(s => s.tenantId === TENANT)).toMatchObject({ lastStatus: "Failed", attempts: 1 })
    expect(scheduler.list().find(s => s.tenantId === TENANT)!.lastRunAt).toBeUndefined()
    expect(scheduler.list().find(s => s.tenantId === OTHER)!.lastStatus).toBe("Completed")
  })
})

function nearDeadlineListing(url: URL, page: number): Promise<Response> | undefined {
  if (url.hostname !== "graph.microsoft.com") return
  return new Promise(resolve => { setTimeout(() => resolve(Response.json({ value: [],
    ...(page < 30 ? { "@odata.nextLink": `https://graph.microsoft.com/beta/page?n=${page}` } : {}),
  })), page < 30 ? 60_000 : 59_500) })
}

describe("manifest commit and retention interruption", () => {
  it.each(["cancel", "deadline"])("fails without dispatching a manifest when %s arrives during its token wait", async interrupt => {
    vi.useFakeTimers()
    let storageTokens = 0
    let release!: (token: string) => void
    let pages = 0
    const { engine, saved, calls } = setup({
      getToken: async (_tenant, _client, tokenScope) => {
        if (tokenScope.includes("storage.azure.com") && ++storageTokens === 2) {
          return new Promise(resolve => { release = resolve })
        }
        return "token"
      },
      override: url => interrupt === "deadline" && url.hostname === "graph.microsoft.com" ? nearDeadlineListing(url, ++pages) : undefined,
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(interrupt === "deadline" ? JOB_DEADLINE_MS - 500 : 0)
    expect(storageTokens).toBe(2)
    expect(release).toBeDefined()
    expect(job.status).toBe("Running")
    if (interrupt === "cancel") engine.cancel(job.id)
    else await vi.advanceTimersByTimeAsync(500)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain(interrupt === "cancel" ? "Backup cancelled by you" : "30 minute job deadline")
    expect(saved.has(`${job.backupFolder}/metadata.json`)).toBe(false)
    expect(calls.some(call => call.init.method === "PUT" && call.url.pathname.endsWith("/metadata.json"))).toBe(false)
    const count = calls.length
    release("token")
    await vi.advanceTimersByTimeAsync(300_000)
    expect(calls).toHaveLength(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["cancel", "deadline"])("fails without a manifest when %s arrives after the last item read and before commit", async interrupt => {
    vi.useFakeTimers()
    let job: BackupJob | undefined
    let interrupted = false
    const { engine, saved, calls } = setup({ count: 1, now: () => {
      // The end-time read follows the finished item pool and precedes the manifest commit.
      if (!interrupted && job?.log.some(line => line.includes("Backed up 1"))) {
        interrupted = true
        if (interrupt === "cancel") engine.cancel(job.id)
        else vi.setSystemTime(new Date(Date.now() + JOB_DEADLINE_MS))
      }
      return new Date()
    } })
    job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain(interrupt === "cancel" ? "Backup cancelled by you" : "30 minute job deadline")
    expect(interrupted).toBe(true)
    expect([...saved.keys()].filter(name => name.includes("/DeviceConfigurations/"))).toHaveLength(1)
    expect([...saved.keys()].some(name => name.endsWith("/metadata.json"))).toBe(false)
    expect(calls.some(call => call.init.method === "PUT" && call.url.pathname.endsWith("/metadata.json"))).toBe(false)
  })

  it.each(["cancel", "deadline"])("completes a saved manifest when %s arrives during its PUT", async interrupt => {
    vi.useFakeTimers()
    let release!: () => void
    let putSignal: AbortSignal | undefined
    let pages = 0
    const { engine, saved, calls } = setup({ retention: 30, override: (url, init) => {
      if (interrupt === "deadline" && url.hostname === "graph.microsoft.com") return nearDeadlineListing(url, ++pages)
      if (init.method !== "PUT" || !url.pathname.endsWith("/metadata.json")) return
      putSignal = init.signal!
      return new Promise(resolve => { release = () => {
        saved.set(decodeURIComponent(url.pathname.slice(prefix.length)), String(init.body))
        resolve(new Response(null, { status: 201 }))
      } })
    } })
    const job = engine.start({ ...request, trigger: "scheduled" })
    await vi.advanceTimersByTimeAsync(interrupt === "deadline" ? JOB_DEADLINE_MS - 500 : 0)
    expect(putSignal).toBeDefined()
    if (interrupt === "cancel") engine.cancel(job.id)
    else await vi.advanceTimersByTimeAsync(500)
    expect(job.status).toBe("Running")
    expect(putSignal!.aborted).toBe(false)
    release()
    await engine.waitForJob(job)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    expect(job.progressMessage).toBe("Backup completed with 1 warning")
    expect(job.log.join("\n")).toContain("Retention was interrupted; older backups are cleaned up on the next run")
    expect(JSON.parse(saved.get(`${job.backupFolder}/metadata.json`)!)).toMatchObject({ Status: "Success", Failures: 0 })
    expect(calls.some(call => call.init.method === "DELETE")).toBe(false)
    expect(calls.some(call => call.url.searchParams.get("comp") === "list")).toBe(false)
  })

  it("does not report interrupted retention for an incomplete run cancelled during commit", async () => {
    vi.useFakeTimers()
    const { engine, saved, calls } = setup({ count: 2, retention: 30, override: (url, init) => {
      if (url.hostname === "graph.microsoft.com" && url.pathname.endsWith("/p0")) return new Response(null, { status: 403 })
      if (init.method === "PUT" && url.pathname.endsWith("/metadata.json")) engine.cancel(job.id)
    } })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    await engine.waitForJob(job)
    expect(job.status).toBe("Completed")
    expect(JSON.parse(saved.get(`${job.backupFolder}/metadata.json`)!)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1 })
    expect(job.log.join("\n")).toContain("Older backups were kept because this backup is incomplete.")
    expect(job.log.join("\n")).not.toContain("Retention was interrupted")
    expect(calls.some(call => call.url.searchParams.get("comp") === "list")).toBe(false)
  })

  it.each(["cancel", "deadline"])("keeps a committed backup completed when %s interrupts retention deletes", async interrupt => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"))
    const old = "backup-2026-08-01-020000"
    let pages = 0
    const { engine, saved, calls } = setup({ retention: 30, override: (url, init) => {
      if (interrupt === "deadline" && url.hostname === "graph.microsoft.com") return nearDeadlineListing(url, ++pages)
      if (init.method === "DELETE" && url.pathname.includes(old)) return new Promise(() => {})
    } })
    saved.set(`${old}/metadata.json`, JSON.stringify({ Status: "Success", TenantId: TENANT, Scope: { Excluded: scope.excluded } }))
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(interrupt === "deadline" ? JOB_DEADLINE_MS - 500 : 0)
    const deletion = calls.find(call => call.init.method === "DELETE")!
    expect(deletion).toBeDefined()
    expect(saved.has(`${job.backupFolder}/metadata.json`)).toBe(true)
    if (interrupt === "cancel") engine.cancel(job.id)
    else await vi.advanceTimersByTimeAsync(500)
    await engine.waitForJob(job)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    expect(job.progressMessage).toBe("Backup completed with 1 warning")
    expect(job.log.join("\n")).toContain("Retention was interrupted; older backups are cleaned up on the next run")
    expect(deletion.init.signal!.aborted).toBe(true)
    expect(saved.has(`${old}/metadata.json`)).toBe(true)
    const count = calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(calls).toHaveLength(count)
  })

  it("commits before retention reads that reach the job deadline", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"))
    const old = "backup-2026-08-01-020000/metadata.json"
    let pages = 0
    const { engine, saved, calls } = setup({ retention: 30, override: (url, init) => {
      if (url.hostname === "graph.microsoft.com") return nearDeadlineListing(url, ++pages)
      if (init.method === "GET" && url.pathname.endsWith(old)) {
        expect([...saved.keys()].filter(name => name.endsWith("/metadata.json"))).toHaveLength(2)
        return new Promise(() => {})
      }
    } })
    saved.set(old, JSON.stringify({ Status: "Success", TenantId: TENANT }))
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(JOB_DEADLINE_MS)
    await engine.waitForJob(job)
    expect(job.status).toBe("Completed")
    expect(job.log.join("\n")).toContain("Retention was interrupted; older backups are cleaned up on the next run")
    expect(saved.has(`${job.backupFolder}/metadata.json`)).toBe(true)
    expect(saved.has(old)).toBe(true)
    expect(calls.some(call => call.init.method === "DELETE")).toBe(false)
  })

  it("fails a manifest PUT that exhausts its own timeout", async () => {
    vi.useFakeTimers()
    const { engine } = setup({ override: (url, init) => init.method === "PUT" && url.pathname.endsWith("/metadata.json") ? new Promise(() => {}) : undefined })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(273_000)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Backup request timed out after 90 seconds. Check your connection and retry.")
  })

  it("fails token acquisition during an item read instead of recording an item warning", async () => {
    vi.useFakeTimers()
    let tokens = 0
    const engine = new BackupEngine({
      getToken: async (_tenant, _client, tokenScope) => tokenScope.includes("graph.microsoft.com") && ++tokens > 1 ? new Promise(() => {}) : "token",
      fetch: async input => new URL(String(input)).hostname === "graph.microsoft.com" ? Response.json({ value: [{ id: "p", displayName: "Policy" }] }) : new Response(null, { status: 201 }),
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(273_000)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("Backup request timed out after 90 seconds")
    expect(job.log.some(line => line.includes("Could not back up"))).toBe(false)
  })
})
