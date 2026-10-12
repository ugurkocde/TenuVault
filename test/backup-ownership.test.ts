import { afterEach, describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import { NextRequest } from "next/server"
import { BackupEngine, type BackupJob } from "../src/main/backup/engine"
import { encryptedAzureFetch, openAzure, registerStorageToken, sealAzure } from "../src/main/storage/azure-seal"
import { POST as downloadBackup } from "../src/portal/app/api/download-backup/route"
import { reviewArchive } from "../src/main/backup/archive"
import { BACKUP_OWNER_FILE } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER = "33333333-3333-3333-3333-333333333333"
const master = Buffer.alloc(32, 4)
const base = "https://contoso.blob.core.windows.net/intune-backups/"
const now = new Date("2026-10-12T12:00:00Z")
const old = "backup-2026-10-12-050000/"
const request = {
  tenantId: TENANT,
  clientId: "client",
  storageAccountName: "contoso",
  scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) },
}
const owner = { Source: "TenuVault Desktop", TenantId: TENANT }

function setup(options: { retention?: number; count?: number; override?: (url: URL, request: Request) => Response | Promise<Response> | undefined } = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const saved = new Map<string, Buffer>()
  const calls: Array<{ name: string; request: Request }> = []
  const wireFetch: typeof fetch = async (input, init) => {
    const sent = new Request(input, init), url = new URL(sent.url)
    const name = decodeURIComponent(url.pathname.slice("/intune-backups/".length))
    calls.push({ name, request: sent })
    const overridden = options.override?.(url, sent)
    if (overridden) return overridden
    if (url.hostname === "graph.microsoft.com") {
      return url.pathname.endsWith("/deviceConfigurations")
        ? Response.json({ value: Array.from({ length: options.count ?? 0 }, (_, index) => ({ id: `p${index}`, displayName: `Policy ${index}` })) })
        : Response.json({ id: url.pathname.split("/").at(-1) })
    }
    if (url.searchParams.get("comp") === "list") {
      const names = [...saved.keys()].filter(name => name.startsWith(url.searchParams.get("prefix") ?? ""))
      const entries = url.searchParams.has("delimiter")
        ? [...new Set(names.map(name => `${name.split("/")[0]}/`))].map(name => `<BlobPrefix><Name>${name}</Name></BlobPrefix>`)
        : names.map(name => `<Blob><Name>${name}</Name></Blob>`)
      return new Response(`<Blobs>${entries.join("")}</Blobs>`)
    }
    if (sent.method === "PUT") {
      if (!url.search) saved.set(name, Buffer.from(await sent.arrayBuffer()))
      return new Response(null, { status: 201 })
    }
    if (sent.method === "DELETE") {
      saved.delete(name)
      return new Response(null, { status: 202 })
    }
    return new Response(sent.method === "HEAD" || !saved.has(name) ? null : new Uint8Array(saved.get(name)!), { status: saved.has(name) ? 200 : 404 })
  }
  const fetch = encryptedAzureFetch(wireFetch, () => [master], () => undefined)
  const engine = new BackupEngine({ fetch, getToken: async () => { registerStorageToken("token", TENANT); return "token" }, retentionDays: () => options.retention ?? 30 })
  function seed(name: string, value: unknown, authenticated = true) {
    const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    saved.set(name, authenticated ? sealAzure(body, master, TENANT, new URL(`${base}${name}`)) : body)
  }
  function folder(prefix: string, marker: unknown = owner, authenticated = true) {
    seed(`${prefix}DeviceConfigurations/Old.json`, { id: "old" })
    if (marker !== null) seed(`${prefix}${BACKUP_OWNER_FILE}`, marker, authenticated)
  }
  return { engine, fetch, saved, calls, seed, folder }
}

async function complete(engine: BackupEngine) {
  const job = engine.start(request)
  await engine.waitForJob(job)
  await vi.advanceTimersByTimeAsync(0)
  expect(job.status).toBe("Completed")
  return job
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("backup folder ownership", () => {
  it("encrypts ownership before policy uploads, even when retention keeps everything", async () => {
    const { engine, saved, calls } = setup({ count: 1, retention: 0 })
    const job = await complete(engine)
    const name = `${job.backupFolder}/${BACKUP_OWNER_FILE}`
    const raw = saved.get(name)!
    expect(raw.toString()).not.toContain(TENANT)
    expect(raw.toString()).not.toContain("TenuVault Desktop")
    const opened = openAzure(raw, [master], TENANT, new URL(`${base}${name}`))
    expect(opened.authenticated).toBe(true)
    expect(JSON.parse(opened.data.toString())).toEqual(owner)
    const puts = calls.filter(call => call.request.method === "PUT" && !new URL(call.request.url).search).map(call => call.name)
    expect(puts).toEqual([name, `${job.backupFolder}/DeviceConfigurations/Policy 0.json`, `${job.backupFolder}/metadata.json`])
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("sweeps a folder left by cancellation only after six hours and a later complete backup", async () => {
    let hanging = true
    const { engine, saved } = setup({ count: 1, override: url => {
      if (hanging && url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) return new Promise(() => {})
    } })
    const cancelled = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    const marker = `${cancelled.backupFolder}/${BACKUP_OWNER_FILE}`
    expect(saved.has(marker)).toBe(true)
    engine.cancel(cancelled.id)
    await engine.waitForJob(cancelled)
    expect(cancelled.status).toBe("Cancelled")
    expect(saved.has(`${cancelled.backupFolder}/metadata.json`)).toBe(false)
    hanging = false
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 + 1000)
    await complete(engine)
    expect(saved.has(marker)).toBe(false)
  })

  it("removes only authenticated abandoned folders strictly older than six hours while the tenant is idle", async () => {
    let job: BackupJob | undefined
    const { engine, saved, calls, seed, folder } = setup({ override: (_url, sent) => {
      if (sent.method === "DELETE") expect(job?.status).toBe("Completed")
    } })
    folder(old, { ...owner, TenantId: TENANT.toUpperCase() })
    const cases = [
      ["backup-2026-10-12-060000/", owner, true],
      ["backup-2026-10-12-070000/", owner, true],
      ["backup-2026-10-12-040000/", null, true],
      ["backup-2026-10-12-030000/", { ...owner, TenantId: OTHER }, true],
      ["backup-2026-10-12-020000/", { ...owner, Source: "Another app" }, true],
      ["backup-2026-10-12-010000/", owner, false],
      ["backup-2026-10-11-230000/", "invalid json", true],
    ] as const
    for (const [prefix, marker, authenticated] of cases) folder(prefix, marker, authenticated)
    const invalidMetadata = "backup-2026-10-11-220000/"
    folder(invalidMetadata)
    seed(`${invalidMetadata}metadata.json`, "invalid json")
    const brokenMetadata = "backup-2026-10-11-210000/"
    folder(brokenMetadata)
    saved.set(`${brokenMetadata}metadata.json`, Buffer.from("damaged ciphertext"))
    const original = new Map(saved)
    job = engine.start(request)
    await engine.waitForJob(job)
    await vi.advanceTimersByTimeAsync(0)
    expect([...saved.keys()].some(name => name.startsWith(old))).toBe(false)
    for (const [name, body] of original) if (!name.startsWith(old)) expect(saved.get(name)).toEqual(body)
    expect(calls.filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([`${old}DeviceConfigurations/Old.json`, `${old}${BACKUP_OWNER_FILE}`])
    expect(job.log.join("\n")).toContain("Removed abandoned backup backup-2026-10-12-050000, older than six hours and without metadata.")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves a marker that cannot be decrypted and continues with other eligible folders", async () => {
    const { engine, saved, folder } = setup()
    const broken = "backup-2026-10-12-040000/"
    folder(broken)
    const name = `${broken}${BACKUP_OWNER_FILE}`
    saved.set(name, sealAzure(Buffer.from(JSON.stringify(owner)), Buffer.alloc(32, 9), TENANT, new URL(`${base}${name}`)))
    folder(old)
    await complete(engine)
    expect(saved.has(name)).toBe(true)
    expect(saved.has(`${broken}DeviceConfigurations/Old.json`)).toBe(true)
    expect([...saved.keys()].some(name => name.startsWith(old))).toBe(false)
  })

  it("keeps ownership when a protected policy interrupts normal retention or orphan cleanup", async () => {
    const { engine, saved, calls, seed, folder } = setup({ override: (url, sent) => {
      if (sent.method === "DELETE" && url.pathname.endsWith("/Old.json")) return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
    } })
    const expired = "backup-2026-08-01-020000/"
    folder(expired)
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Success", Scope: { Excluded: request.scope.excluded } })
    await complete(engine)
    expect(saved.has(`${expired}metadata.json`)).toBe(false)
    expect(saved.has(`${expired}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(calls.filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([`${expired}metadata.json`, `${expired}DeviceConfigurations/Old.json`])
    await vi.advanceTimersByTimeAsync(1000)
    const next = await complete(engine)
    expect(saved.has(`${expired}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(saved.has(`${expired}DeviceConfigurations/Old.json`)).toBe(true)
    expect(next.log.join("\n")).toContain("protected by the storage account's immutability policy or legal hold")
    expect(calls.some(call => call.request.method === "DELETE" && call.name.endsWith(BACKUP_OWNER_FILE))).toBe(false)
  })

  it("deletes ownership last after a complete retention deletion", async () => {
    const { engine, calls, seed, folder } = setup()
    const expired = "backup-2026-08-01-020000/"
    folder(expired)
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Success", Scope: { Excluded: request.scope.excluded } })
    await complete(engine)
    expect(calls.filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([`${expired}metadata.json`, `${expired}DeviceConfigurations/Old.json`, `${expired}${BACKUP_OWNER_FILE}`])
  })

  it("aborts an ignored cleanup request when another backup starts without blocking that job", async () => {
    const releases: Array<(response: Response) => void> = []
    let signal: AbortSignal | undefined
    const { engine, saved, calls, folder } = setup({ override: (url, sent) => {
      if (sent.method === "HEAD" && url.pathname === `/intune-backups/${old}metadata.json`) {
        signal = sent.signal
        return new Promise(resolve => { releases.push(resolve) })
      }
    } })
    folder(old)
    const first = await complete(engine)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    const next = engine.start(request)
    expect(next.id).not.toBe(first.id)
    expect(signal?.aborted).toBe(true)
    await engine.waitForJob(next)
    expect(next.status).toBe("Completed")
    // Stop the next cleanup with a third job before releasing the ignored requests.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    const third = engine.start(request)
    engine.cancel(third.id)
    await engine.waitForJob(third)
    for (const release of releases) release(new Response(null, { status: 404 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(saved.has(`${old}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds a hung cleanup request without keeping the completed job running", async () => {
    const signals: AbortSignal[] = []
    const { engine, saved, folder } = setup({ override: (url, sent) => {
      if (sent.method === "HEAD" && url.pathname === `/intune-backups/${old}metadata.json`) {
        signals.push(sent.signal)
        return new Promise(() => {})
      }
    } })
    folder(old)
    const job = await complete(engine)
    expect(job.endTime).toBeDefined()
    await vi.advanceTimersByTimeAsync(273_000)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    expect(job.log.join("\n")).toContain("Could not remove abandoned backups: Backup request timed out after 90 seconds")
    expect(saved.has(`${old}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(signals).toHaveLength(3)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("refuses deletion when storage lists a file outside the authenticated folder", async () => {
    const { engine, saved, calls, folder } = setup({ override: (url, sent) => {
      if (sent.method === "GET" && url.searchParams.get("prefix") === old) return new Response(`<Blobs><Blob><Name>another-folder/policy.json</Name></Blob><Blob><Name>${old}${BACKUP_OWNER_FILE}</Name></Blob></Blobs>`)
    } })
    folder(old)
    const job = await complete(engine)
    expect(saved.has(`${old}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
    expect(job.log.join("\n")).toContain("Storage returned a file outside the abandoned folder")
  })

  it("does not sweep abandoned folders when retention is disabled", async () => {
    const { engine, saved, calls, folder } = setup({ retention: 0 })
    folder(old)
    await complete(engine)
    expect(saved.has(`${old}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(calls.some(call => call.request.method === "HEAD" || call.request.method === "DELETE")).toBe(false)
  })

  it("excludes ownership from downloaded archives and keeps the existing import format", async () => {
    const { engine, fetch } = setup({ count: 1, retention: 0 })
    const job = await complete(engine)
    vi.useRealTimers()
    registerStorageToken("token", TENANT)
    const routeFetch: typeof fetch = (input, init) => new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).hostname === "login.microsoftonline.com"
      ? Promise.resolve(Response.json({ access_token: "token" })) : fetch(input, init)
    vi.stubGlobal("fetch", routeFetch)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const response = await downloadBackup(new NextRequest("http://localhost/api/download-backup", { method: "POST", body: JSON.stringify({ ...request, appId: "app", clientSecret: "fixture", backupId: job.backupFolder }) }))
    expect(response.status).toBe(200)
    const raw = Buffer.from(await response.arrayBuffer())
    const zip = await JSZip.loadAsync(raw)
    expect(zip.file(BACKUP_OWNER_FILE)).toBeNull()
    expect(zip.file("metadata.json")).not.toBeNull()
    expect(zip.file("DeviceConfigurations/Policy 0.json")).not.toBeNull()
    expect(await reviewArchive(raw)).toMatchObject({ tenantId: TENANT, backupId: job.backupFolder, count: 1 })
  })
})
