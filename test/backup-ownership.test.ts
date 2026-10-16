import { afterEach, describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import { NextRequest } from "next/server"
import { BackupEngine } from "../src/main/backup/engine"
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
  registerStorageToken("token", TENANT)
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

  it("authenticates an encrypted ownership read", async () => {
    const { fetch, folder } = setup()
    folder(old)
    const response = await fetch(`${base}${old}${BACKUP_OWNER_FILE}`, { headers: { Authorization: "Bearer token" } })
    expect(response.headers.get("x-tenuvault-authenticated")).toBe("true")
    expect(await response.json()).toEqual(owner)
  })

  it("does not authenticate a plaintext ownership read", async () => {
    const { fetch, folder } = setup()
    folder(old, owner, false)
    const response = await fetch(`${base}${old}${BACKUP_OWNER_FILE}`, { headers: { Authorization: "Bearer token" } })
    expect(response.headers.get("x-tenuvault-authenticated")).toBe("false")
    expect(await response.json()).toEqual(owner)
  })

  it.each(["key", "tenant", "path", "ciphertext"])("rejects ownership with invalid %s authentication", async mismatch => {
    const { fetch, saved } = setup()
    const name = `${old}${BACKUP_OWNER_FILE}`
    const raw = sealAzure(Buffer.from(JSON.stringify(owner)), mismatch === "key" ? Buffer.alloc(32, 9) : master, mismatch === "tenant" ? OTHER : TENANT, new URL(`${base}${mismatch === "path" ? "another-folder/" + BACKUP_OWNER_FILE : name}`))
    if (mismatch === "ciphertext") raw[raw.length - 1] = raw[raw.length - 1]! ^ 1
    saved.set(name, raw)
    await expect(fetch(`${base}${name}`, { headers: { Authorization: "Bearer token" } })).rejects.toThrow("Backup authentication failed")
  })

  it("records a cancelled folder as failed and keeps it through a later complete backup within retention", async () => {
    let hanging = true
    const { engine, saved, calls } = setup({ count: 1, override: url => {
      if (hanging && url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) return new Promise(() => {})
    } })
    const cancelled = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    const marker = `${cancelled.backupFolder}/${BACKUP_OWNER_FILE}`
    expect(saved.has(marker)).toBe(true)
    engine.cancel(cancelled.id)
    await engine.waitForJob(cancelled)
    expect(cancelled.status).toBe("Cancelled")
    const manifest = `${cancelled.backupFolder}/metadata.json`
    const opened = openAzure(saved.get(manifest)!, [master], TENANT, new URL(`${base}${manifest}`))
    expect(opened.authenticated).toBe(true)
    expect(JSON.parse(opened.data.toString())).toMatchObject({ Status: "Failed", TenantId: TENANT, Trigger: "manual", ItemCounts: { TotalPolicies: 0 }, Error: cancelled.exception })
    expect(cancelled.log.join("\n")).toContain("Recorded this backup as failed.")
    hanging = false
    const original = new Map(saved)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 + 1000)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
  })

  it("removes a failed backup past the retention period, manifest first and ownership last", async () => {
    const { engine, saved, calls, seed, folder } = setup()
    const expired = "backup-2026-08-01-020000/"
    folder(expired)
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Failed", Failures: 0, Scope: { Excluded: [] }, ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 } })
    await complete(engine)
    expect([...saved.keys()].some(name => name.startsWith(expired))).toBe(false)
    expect(calls.filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([`${expired}metadata.json`, `${expired}DeviceConfigurations/Old.json`, `${expired}${BACKUP_OWNER_FILE}`])
  })

  it.each([old, "backup-2026-08-01-020000/"])("leaves manifestless folder %s untouched with valid same-tenant ownership", async prefix => {
    const { engine, saved, calls, folder } = setup()
    folder(prefix, { ...owner, TenantId: TENANT.toUpperCase() })
    const marker = `${prefix}${BACKUP_OWNER_FILE}`
    const opened = openAzure(saved.get(marker)!, [master], TENANT, new URL(`${base}${marker}`))
    expect(opened.authenticated).toBe(true)
    expect(JSON.parse(opened.data.toString())).toEqual({ ...owner, TenantId: TENANT.toUpperCase() })
    const original = new Map(saved)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
    expect(saved.has(`${prefix}metadata.json`)).toBe(false)
    expect(calls.filter(call => call.name.startsWith(prefix)).map(call => [call.request.method, call.name])).toEqual([["GET", `${prefix}metadata.json`]])
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves manifestless folders with missing, foreign or unreadable ownership", async () => {
    const { engine, saved, folder } = setup()
    const cases = [
      ["backup-2026-08-01-020000/", null, true],
      ["backup-2026-08-02-020000/", { ...owner, TenantId: OTHER }, true],
      ["backup-2026-08-03-020000/", { ...owner, Source: "Another app" }, true],
      ["backup-2026-08-04-020000/", owner, false],
      ["backup-2026-08-05-020000/", "invalid json", true],
    ] as const
    for (const [prefix, marker, authenticated] of cases) folder(prefix, marker, authenticated)
    const broken = "backup-2026-08-06-020000/"
    folder(broken)
    const name = `${broken}${BACKUP_OWNER_FILE}`
    saved.set(name, sealAzure(Buffer.from(JSON.stringify(owner)), Buffer.alloc(32, 9), TENANT, new URL(`${base}${name}`)))
    const original = new Map(saved)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
  })

  it("keeps ownership when a protected policy interrupts normal retention", async () => {
    const { engine, saved, calls, seed, folder } = setup({ override: (url, sent) => {
      if (sent.method === "DELETE" && url.pathname.endsWith("/Old.json")) return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
    } })
    const expired = "backup-2026-08-01-020000/"
    folder(expired)
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Success", Scope: { Excluded: request.scope.excluded } })
    const first = await complete(engine)
    expect(first.log.join("\n")).toContain("protected by the storage account's immutability policy or legal hold")
    expect(saved.has(`${expired}metadata.json`)).toBe(false)
    expect(saved.has(`${expired}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(calls.filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([`${expired}metadata.json`, `${expired}DeviceConfigurations/Old.json`])
    await vi.advanceTimersByTimeAsync(1000)
    await complete(engine)
    expect(saved.has(`${expired}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(saved.has(`${expired}DeviceConfigurations/Old.json`)).toBe(true)
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

  it("leaves manifestless folders untouched when retention is disabled", async () => {
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
