import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine, FAILED_MANIFEST_GRACE_MS } from "../src/main/backup/engine"
import { BACKUP_OWNER_FILE } from "../src/shared/constants"
import { jobStatus } from "../src/main/api/desktop-routes"
import { withNetworkErrors } from "../src/main/api/network-error"
import { INTUNE_TYPES } from "../src/shared/intune/registry"

const TENANT = "11111111-1111-1111-1111-111111111111"
const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
const request = { tenantId: TENANT, clientId: "client", storageAccountName: "contoso", scope, trigger: "scheduled" as const }
const prefix = "/intune-backups/"

/** Azure storage in memory that honours create-only writes, and Graph with `count` policies. */
function setup(options: { count?: number; retention?: number; getToken?: (saved: Map<string, string>) => Promise<string>; override?: (url: URL, init: RequestInit, saved: Map<string, string>) => Response | Promise<Response> | undefined } = {}) {
  const saved = new Map<string, string>()
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const engine = new BackupEngine({
    retentionDays: () => options.retention ?? 0,
    getToken: async () => options.getToken?.(saved) ?? "token",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      const overridden = options.override?.(url, init, saved)
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
        if (url.search) return new Response(null, { status: 201 })
        if ((init.headers as Record<string, string>)["if-none-match"] === "*" && saved.has(name)) return new Response(null, { status: 412, headers: { "x-ms-error-code": "BlobAlreadyExists" } })
        saved.set(name, String(init.body))
        return new Response(null, { status: 201 })
      }
      if (init.method === "DELETE") {
        saved.delete(name)
        return new Response(null, { status: 202 })
      }
      return saved.has(name) ? new Response(saved.get(name)) : new Response(null, { status: 404 })
    },
  })
  const manifestPuts = () => calls.filter(call => call.init.method === "PUT" && call.url.pathname.endsWith("/metadata.json"))
  return { engine, saved, calls, manifestPuts }
}

const graphItem = (url: URL, id: string) => url.hostname === "graph.microsoft.com" && url.pathname.endsWith(`/${id}`)

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe("failed backup manifest", () => {
  it("records a run that stops after saving policies as a failed backup of this tenant", async () => {
    const { engine, saved, manifestPuts } = setup({ count: 3, override: url => graphItem(url, "p2") ? new Response(null, { status: 401 }) : undefined })
    const job = engine.start(request)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(job.unreachable).toBeUndefined()
    expect(manifestPuts()).toHaveLength(1)
    expect(manifestPuts()[0]!.init.headers).toMatchObject({ "if-none-match": "*" })
    const metadata = JSON.parse(saved.get(`${job.backupFolder}/metadata.json`)!)
    expect(metadata).toMatchObject({
      BackupFolder: job.backupFolder,
      Status: "Failed",
      TenantId: TENANT,
      Trigger: "scheduled",
      Source: "TenuVault Desktop",
      Scope: { Excluded: scope.excluded },
      ItemCounts: { DeviceConfigurations: 2, TotalPolicies: 2 },
      Error: job.exception,
    })
    expect(Object.keys(metadata.Items).sort()).toEqual(["DeviceConfigurations/p0", "DeviceConfigurations/p1"])
    expect(saved.has(`${job.backupFolder}/${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(job.log.slice(-2)).toEqual([expect.stringContaining(`Backup failed: ${job.exception}`), expect.stringContaining("Recorded this backup as failed.")])
  })

  it("records a run the user cancels after claiming its folder as cancelled", async () => {
    let job!: ReturnType<BackupEngine["start"]>
    const { engine, saved, manifestPuts } = setup({ count: 3, override: url => {
      if (graphItem(url, "p2")) engine.cancel(job.id)
      return undefined
    } })
    job = engine.start(request)
    await engine.waitForJob(job)
    expect(job.status).toBe("Cancelled")
    expect(manifestPuts()).toHaveLength(1)
    const metadata = JSON.parse(saved.get(`${job.backupFolder}/metadata.json`)!)
    expect(metadata).toMatchObject({ Status: "Cancelled", TenantId: TENANT, Trigger: "scheduled", Error: job.exception })
    expect(metadata.Error).toMatch(/^Backup cancelled by you\./)
    expect(job.log.at(-1)).toContain("Recorded this backup as cancelled.")
  })

  it("records the run as failed when the manifest's sign-in fails before its PUT is sent", async () => {
    let refused = false
    const { engine, saved, manifestPuts } = setup({ count: 1, getToken: async store => {
      if (!refused && [...store.keys()].some(name => name.includes("/DeviceConfigurations/"))) {
        refused = true
        throw new Error("AADSTS50173: The provided grant has expired.")
      }
      return "token"
    } })
    const job = engine.start(request)
    await engine.waitForJob(job)
    expect(refused).toBe(true)
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("AADSTS50173")
    expect(manifestPuts()).toHaveLength(1)
    expect(JSON.parse(saved.get(`${job.backupFolder}/metadata.json`)!)).toMatchObject({ Status: "Failed", ItemCounts: { TotalPolicies: 1 }, Error: job.exception })
  })

  it("never replaces a manifest that is already in the folder", async () => {
    const { engine, saved, manifestPuts } = setup({ count: 2, override: (url, _init, store) => {
      if (!graphItem(url, "p1")) return
      // Another writer's manifest appears while this run is still reading.
      const folder = [...store.keys()].find(name => name.endsWith(BACKUP_OWNER_FILE))!.split("/")[0]
      store.set(`${folder}/metadata.json`, JSON.stringify({ Status: "Success", TenantId: TENANT }))
      return new Response(null, { status: 401 })
    } })
    const job = engine.start(request)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(manifestPuts()).toHaveLength(1)
    expect(JSON.parse(saved.get(`${job.backupFolder}/metadata.json`)!)).toEqual({ Status: "Success", TenantId: TENANT })
    expect(job.log.join("\n")).toContain("This backup already has a manifest, so it was left as it is.")
  })

  it("writes nothing into a folder another backup claimed", async () => {
    const { engine, manifestPuts } = setup({ count: 1, override: (url, init) =>
      init.method === "PUT" && url.pathname.endsWith(BACKUP_OWNER_FILE) ? new Response(null, { status: 412, headers: { "x-ms-error-code": "BlobAlreadyExists" } }) : undefined })
    const job = engine.start(request)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("already in use by another backup")
    expect(manifestPuts()).toHaveLength(0)
  })

  it("writes nothing and stays unreachable when nothing can be reached", async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const engine = new BackupEngine({ getToken: async () => "token", fetch: withNetworkErrors(async (input) => {
      calls.push(String(input))
      throw new TypeError("net::ERR_INTERNET_DISCONNECTED")
    }) })
    const done = engine.waitForJob(engine.start(request))
    await vi.advanceTimersByTimeAsync(600_000)
    const job = await done
    expect(job).toMatchObject({ status: "Failed", unreachable: true })
    expect(calls.some(url => url.endsWith("/metadata.json") || url.endsWith(BACKUP_OWNER_FILE))).toBe(false)
  })

  it("writes nothing more when the storage stopped the run", async () => {
    const { engine, manifestPuts } = setup({ count: 8, override: (url, init) =>
      init.method === "PUT" && url.pathname.includes("/DeviceConfigurations/") ? new Response(null, { status: 403 }) : undefined })
    const job = engine.start(request)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(manifestPuts()).toHaveLength(0)
  })

  it("gives up on a storage that does not answer the failed manifest and finishes the job", async () => {
    vi.useFakeTimers()
    const { engine, calls, manifestPuts } = setup({ count: 2, override: (url, init) => {
      if (graphItem(url, "p1")) return new Response(null, { status: 401 })
      if (init.method === "PUT" && url.pathname.endsWith("/metadata.json")) return new Promise(() => {})
    } })
    const job = engine.start(request)
    let finished = false
    void engine.waitForJob(job).then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(FAILED_MANIFEST_GRACE_MS - 1)
    expect(finished).toBe(false)
    expect(job.status).toBe("Failed")
    // Progress views keep polling until the job has finished recording itself.
    expect(jobStatus(job).isComplete).toBe(false)
    // The tenant is free while the manifest is written: a new backup gets its own job.
    const next = engine.start(request)
    expect(next.id).not.toBe(job.id)
    engine.cancel(next.id)
    await vi.advanceTimersByTimeAsync(1)
    await engine.waitForJob(job)
    expect(finished).toBe(true)
    expect(jobStatus(job)).toMatchObject({ isComplete: true, isSuccessful: false })
    expect(jobStatus(job).endTime).toBeDefined()
    expect(jobStatus(job).output).toContain("Could not record this backup as failed")
    await engine.waitForJob(next)
    expect(manifestPuts()).toHaveLength(1)
    expect(job.log.join("\n")).toContain("Could not record this backup as failed: The storage did not answer in time.")
    expect(job.log.join("\n")).not.toContain("30 minute")
    const count = calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(calls).toHaveLength(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["Failed", "Cancelled"])("never lets a %s backup stand in for an older complete copy of a type during retention", async status => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"))
    const { engine, saved } = setup({ count: 1, retention: 30 })
    const complete = "backup-2026-08-01-020000"
    const failed = "backup-2026-08-10-020000"
    // The older complete backup holds compliance policies, which the current scope leaves out.
    saved.set(`${complete}/CompliancePolicies/Old.json`, "{}")
    saved.set(`${complete}/metadata.json`, JSON.stringify({ TenantId: TENANT, Status: "Success", Failures: 0, Scope: { Excluded: [] }, ItemCounts: { CompliancePolicies: 1, TotalPolicies: 1 } }))
    saved.set(`${failed}/CompliancePolicies/Newer.json`, "{}")
    saved.set(`${failed}/metadata.json`, JSON.stringify({ TenantId: TENANT, Status: status, Failures: 0, Scope: { Excluded: [] }, ItemCounts: { CompliancePolicies: 1, TotalPolicies: 1 } }))
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    await engine.waitForJob(job)
    expect(job.status).toBe("Completed")
    expect(saved.has(`${complete}/metadata.json`)).toBe(true)
    expect(saved.has(`${complete}/CompliancePolicies/Old.json`)).toBe(true)
    expect([...saved.keys()].some(name => name.startsWith(`${failed}/`))).toBe(false)
  })
})
