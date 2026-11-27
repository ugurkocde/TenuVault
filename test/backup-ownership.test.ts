import { createHash } from "node:crypto"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import type { RetentionLimits } from "../src/main/backup/retention-budget"
import { readRetentionProgress, type RetentionProgressStore } from "../src/main/backup/retention-progress"
import { afterEach, describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import { NextRequest } from "next/server"
import { BackupEngine, JOB_DEADLINE_MS } from "../src/main/backup/engine"
import { legacyAzureReader, legacyRecoveryFingerprint, registerStorageToken } from "../src/main/storage/azure-seal"
import { LEGACY_SEALED_MESSAGE } from "../src/shared/legacy-sealed"
import { sealLegacyAzure } from "./legacy-seal"
import { endlessBody, withBackupServerTime } from "./helpers"
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

const oldItem = { id: "old" }
const indexed = { "DeviceConfigurations/old": { file: "Old.json", hash: snapshotHash(oldItem), sha256: createHash("sha256").update(JSON.stringify(oldItem)).digest("hex") } }

function setup(options: { retention?: number; count?: number; limits?: RetentionLimits; serverTime?: () => Date | null; progress?: RetentionProgressStore; override?: (url: URL, request: Request) => Response | Promise<Response> | undefined } = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const saved = new Map<string, Buffer>()
  const keyring = [master]
  const etag = (name: string) => `"${createHash("sha256").update(saved.get(name)!).digest("hex")}"`
  const withDate = (response: Response) => {
    const serverTime = options.serverTime ? options.serverTime() : new Date()
    return serverTime ? withBackupServerTime(response, serverTime) : response
  }
  const calls: Array<{ name: string; request: Request }> = []
  const wireFetch: typeof fetch = async (input, init) => {
    const sent = new Request(input, init), url = new URL(sent.url)
    const name = decodeURIComponent(url.pathname.slice("/intune-backups/".length))
    calls.push({ name, request: sent })
    const overridden = options.override?.(url, sent)
    if (overridden) return overridden
    if (url.hostname === "graph.microsoft.com") {
      return withDate(url.pathname.endsWith("/deviceConfigurations")
        ? Response.json({ value: Array.from({ length: options.count ?? 0 }, (_, index) => ({ id: `p${index}`, displayName: `Policy ${index}` })) })
        : Response.json({ id: url.pathname.split("/").at(-1) }))
    }
    if (url.searchParams.get("comp") === "list") {
      const names = [...saved.keys()].filter(name => name.startsWith(url.searchParams.get("prefix") ?? ""))
      const entries = url.searchParams.has("delimiter")
        ? [...new Set(names.map(name => `${name.split("/")[0]}/`))].map(name => `<BlobPrefix><Name>${name}</Name></BlobPrefix>`)
        : names.map(name => `<Blob><Name>${name}</Name><Properties><Etag>${etag(name)}</Etag></Properties></Blob>`)
      return new Response(`<Blobs>${entries.join("")}</Blobs>`)
    }
    if (sent.method === "PUT") {
      if (!url.search) saved.set(name, Buffer.from(await sent.arrayBuffer()))
      return withDate(new Response(null, { status: 201 }))
    }
    if (sent.method === "DELETE") {
      if (saved.has(name) && sent.headers.get("if-match") !== etag(name)) return new Response(null, { status: 412 })
      saved.delete(name)
      return new Response(null, { status: 202 })
    }
    return new Response(sent.method === "HEAD" || !saved.has(name) ? null : new Uint8Array(saved.get(name)!), { status: saved.has(name) ? 200 : 404, headers: saved.has(name) ? { etag: etag(name) } : undefined })
  }
  registerStorageToken("token", TENANT)
  const fetch = legacyAzureReader(wireFetch, () => keyring)
  const progressData = new Map<string, string>()
  const progress: RetentionProgressStore = options.progress ?? {
    get: key => progressData.get(key) ?? null,
    set: (key, value) => { progressData.set(key, value) },
    delete: key => { progressData.delete(key) },
  }
  const engine = new BackupEngine({ fetch, getToken: async () => { registerStorageToken("token", TENANT); return "token" }, retentionDays: () => options.retention ?? 30, retentionLimits: options.limits, retentionProgress: progress, recoveryKeyFingerprint: () => legacyRecoveryFingerprint(keyring) })
  /** A plain blob, as this version writes, or one sealed by an earlier version with `key`. */
  function seed(name: string, value: unknown, sealed = false, key = master) {
    const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    saved.set(name, sealed ? sealLegacyAzure(body, key, TENANT, new URL(`${base}${name}`)) : body)
  }
  function folder(prefix: string, marker: unknown = owner, sealed = false) {
    seed(`${prefix}DeviceConfigurations/Old.json`, { id: "old" }, sealed)
    if (marker !== null) seed(`${prefix}${BACKUP_OWNER_FILE}`, marker, sealed)
  }
  return { engine, fetch, saved, calls, seed, folder, keyring, progress, progressData }
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
  it("writes plain ownership before policy uploads, even when retention keeps everything", async () => {
    const { engine, saved, calls } = setup({ count: 1, retention: 0 })
    const job = await complete(engine)
    const name = `${job.backupFolder}/${BACKUP_OWNER_FILE}`
    for (const blob of [name, `${job.backupFolder}/DeviceConfigurations/Policy 0.json`, `${job.backupFolder}/metadata.json`]) {
      expect(saved.get(blob)!.subarray(0, 5).toString()).not.toBe("TVAZ1")
      expect(() => JSON.parse(saved.get(blob)!.toString())).not.toThrow()
    }
    expect(JSON.parse(saved.get(name)!.toString())).toEqual({ ...owner, RunId: job.id })
    expect(JSON.parse(saved.get(`${job.backupFolder}/metadata.json`)!.toString())).toMatchObject({ TenantId: TENANT, Status: "Success" })
    const putRequests = calls.filter(call => call.request.method === "PUT" && !new URL(call.request.url).search)
    for (const call of putRequests) expect(call.request.headers.get("content-type")).toBe("application/json")
    const puts = calls.filter(call => call.request.method === "PUT" && !new URL(call.request.url).search).map(call => call.name)
    expect(puts).toEqual([name, `${job.backupFolder}/DeviceConfigurations/Policy 0.json`, `${job.backupFolder}/metadata.json`])
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])("reads a plain or legacy sealed ownership marker (sealed: %s)", async sealed => {
    const { fetch, folder } = setup()
    folder(old, owner, sealed)
    const response = await fetch(`${base}${old}${BACKUP_OWNER_FILE}`, { headers: { Authorization: "Bearer token" } })
    expect(response.headers.get("x-tenuvault-authenticated")).toBeNull()
    expect(await response.json()).toEqual(owner)
  })

  it.each(["key", "tenant", "path", "ciphertext"])("names the missing key for legacy sealed ownership with an invalid %s", async mismatch => {
    const { fetch, saved } = setup()
    const name = `${old}${BACKUP_OWNER_FILE}`
    const raw = sealLegacyAzure(Buffer.from(JSON.stringify(owner)), mismatch === "key" ? Buffer.alloc(32, 9) : master, mismatch === "tenant" ? OTHER : TENANT, new URL(`${base}${mismatch === "path" ? "another-folder/" + BACKUP_OWNER_FILE : name}`))
    if (mismatch === "ciphertext") raw[raw.length - 1] = raw[raw.length - 1]! ^ 1
    saved.set(name, raw)
    await expect(fetch(`${base}${name}`, { headers: { Authorization: "Bearer token" } })).rejects.toThrow(LEGACY_SEALED_MESSAGE)
  })

  it("records a cancelled folder as cancelled and keeps it through a later complete backup within retention", async () => {
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
    expect(JSON.parse(saved.get(manifest)!.toString())).toMatchObject({ Status: "Cancelled", TenantId: TENANT, Trigger: "manual", ItemCounts: { TotalPolicies: 0 }, Error: cancelled.exception })
    expect(cancelled.log.join("\n")).toContain("Recorded this backup as cancelled.")
    hanging = false
    const original = new Map(saved)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 + 1000)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
  })

  it("removes a failed backup past the retention period, payload first and ownership last", async () => {
    const { engine, saved, calls, seed, folder } = setup()
    const expired = "backup-2026-08-01-020000/"
    folder(expired)
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Failed", Failures: 0, Scope: { Excluded: [] }, Items: indexed, ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 } })
    await complete(engine)
    expect([...saved.keys()].some(name => name.startsWith(expired))).toBe(false)
    expect(calls.filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([`${expired}DeviceConfigurations/Old.json`, `${expired}metadata.json`, `${expired}${BACKUP_OWNER_FILE}`])
  })

  it.each([old, "backup-2026-08-01-020000/"])("leaves manifestless folder %s untouched with valid same-tenant ownership", async prefix => {
    const { engine, saved, calls, folder } = setup()
    folder(prefix, { ...owner, TenantId: TENANT.toUpperCase() })
    const marker = `${prefix}${BACKUP_OWNER_FILE}`
    expect(JSON.parse(saved.get(marker)!.toString())).toEqual({ ...owner, TenantId: TENANT.toUpperCase() })
    const original = new Map(saved)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
    expect(saved.has(`${prefix}metadata.json`)).toBe(false)
    // Retention reads the marker of a folder without a manifest to know who uses the container, and changes nothing.
    if (prefix !== old) expect(calls.filter(call => call.name.startsWith(prefix)).map(call => [call.request.method, call.name])).toEqual([["GET", `${prefix}metadata.json`], ["GET", `${prefix}${BACKUP_OWNER_FILE}`]])
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves manifestless folders with missing, foreign or unreadable ownership", async () => {
    const { engine, saved, folder } = setup()
    const cases = [
      ["backup-2026-08-01-020000/", null, false],
      ["backup-2026-08-02-020000/", { ...owner, TenantId: OTHER }, false],
      ["backup-2026-08-03-020000/", { ...owner, Source: "Another app" }, false],
      ["backup-2026-08-04-020000/", owner, true],
      ["backup-2026-08-05-020000/", "invalid json", false],
    ] as const
    for (const [prefix, marker, sealed] of cases) folder(prefix, marker, sealed)
    const broken = "backup-2026-08-06-020000/"
    folder(broken)
    const name = `${broken}${BACKUP_OWNER_FILE}`
    saved.set(name, sealLegacyAzure(Buffer.from(JSON.stringify(owner)), Buffer.alloc(32, 9), TENANT, new URL(`${base}${name}`)))
    const original = new Map(saved)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
  })

  it("keeps an older backup sealed with another key and still removes independently verified owned backups", async () => {
    const { engine, saved, seed, folder } = setup()
    const plain = "backup-2026-08-01-020000/", legacy = "backup-2026-08-02-020000/", unopenable = "backup-2026-08-03-020000/", untagged = "backup-2026-08-04-020000/"
    const manifest = { TenantId: TENANT, Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } }
    folder(plain)
    seed(`${plain}metadata.json`, manifest)
    folder(legacy, owner, true)
    seed(`${legacy}metadata.json`, manifest, true)
    folder(unopenable, owner, true)
    seed(`${unopenable}metadata.json`, manifest, true, Buffer.alloc(32, 9))
    folder(untagged, null)
    seed(`${untagged}metadata.json`, { Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    const kept = [...saved.entries()].filter(([name]) => name.startsWith(unopenable) || name.startsWith(untagged))
    const job = await complete(engine)
    for (const [name, body] of kept) expect(saved.get(name)).toEqual(body)
    expect([...saved.keys()].some(name => name.startsWith(plain))).toBe(false)
    expect([...saved.keys()].some(name => name.startsWith(legacy))).toBe(false)
    expect(job.log.join("\n")).toContain(LEGACY_SEALED_MESSAGE)
  })

  it("never deletes another tenant's untagged backup when a damaged manifest sits in the container", async () => {
    const { engine, saved, seed, folder } = setup()
    const damaged = "backup-2026-08-01-020000/", theirs = "backup-2026-08-02-020000/"
    folder(damaged)
    saved.set(`${damaged}metadata.json`, Buffer.from("{ not json"))
    folder(theirs, { ...owner, TenantId: OTHER })
    seed(`${theirs}metadata.json`, { Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    const original = new Map(saved)
    const job = await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
    expect(job.log.join("\n")).toContain("metadata.json could not be verified for retention")
  })

  it("places an expired untagged backup by its ownership marker", async () => {
    const { engine, saved, seed, folder } = setup()
    const ours = "backup-2026-08-01-020000/", theirs = "backup-2026-08-02-020000/"
    for (const prefix of [ours, theirs]) seed(`${prefix}metadata.json`, { Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    folder(ours)
    folder(theirs, { ...owner, TenantId: OTHER })
    const kept = [...saved.entries()].filter(([name]) => name.startsWith(theirs))
    await complete(engine)
    expect([...saved.keys()].some((name) => name.startsWith(ours))).toBe(false)
    for (const [name, body] of kept) expect(saved.get(name)).toEqual(body)
  })

  it("counts a manifestless folder's marker as another tenant in the container (review repro)", async () => {
    const { engine, saved, seed, folder } = setup()
    const abandoned = "backup-2026-08-01-020000/", legacy = "backup-2026-08-02-020000/"
    // Tenant B's run stopped before its manifest; tenant B's legacy backup records no tenant and has no marker.
    folder(abandoned, { ...owner, TenantId: OTHER })
    folder(legacy, null)
    seed(`${legacy}metadata.json`, { Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    const original = new Map(saved)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
  })

  it("keeps untagged backups when a manifestless folder's marker cannot be read", async () => {
    const { engine, saved, seed, folder } = setup()
    const abandoned = "backup-2026-08-01-020000/", legacy = "backup-2026-08-02-020000/"
    folder(abandoned, "{ damaged")
    folder(legacy, null)
    seed(`${legacy}metadata.json`, { Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    const original = new Map(saved)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
  })

  it("still ages out an untagged backup when nothing in the container shows another tenant", async () => {
    const { engine, saved, seed, folder } = setup()
    const abandoned = "backup-2026-08-01-020000/", legacy = "backup-2026-08-02-020000/"
    folder(abandoned)
    folder(legacy, null)
    seed(`${legacy}metadata.json`, { Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    await complete(engine)
    expect([...saved.keys()].some((name) => name.startsWith(legacy))).toBe(false)
    expect(saved.has(`${abandoned}${BACKUP_OWNER_FILE}`)).toBe(true)
  })

  it("keeps an untagged backup whose marker is oversized, reads it only to the cap, protects untagged backups, and cleans up verified owned candidates", async () => {
    const big = endlessBody(40, new TextEncoder().encode('{"TenantId":"'))
    const oversized = "backup-2026-08-01-020000/", ours = "backup-2026-08-02-020000/", untagged = "backup-2026-08-03-020000/"
    const { engine, saved, seed, folder } = setup({ override: (url, sent) => sent.method === "GET" && url.pathname.endsWith(`${oversized}${BACKUP_OWNER_FILE}`) ? new Response(big.body) : undefined })
    seed(`${oversized}metadata.json`, { Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    folder(oversized)
    seed(`${ours}metadata.json`, { TenantId: TENANT, Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    folder(ours)
    seed(`${untagged}metadata.json`, { Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    folder(untagged, null)
    const job = await complete(engine)
    expect(saved.has(`${oversized}metadata.json`)).toBe(true)
    expect(saved.has(`${untagged}metadata.json`)).toBe(true)
    expect([...saved.keys()].some((name) => name.startsWith(ours))).toBe(false)
    expect(job.log.join("\n")).toContain("is larger than the 32 MiB TenuVault reads")
    expect(big.pulled()).toBeLessThan(40)
  })

  it("keeps ownership when a protected policy interrupts normal retention", async () => {
    const { engine, saved, calls, seed, folder } = setup({ override: (url, sent) => {
      if (sent.method === "DELETE" && url.pathname.endsWith("/Old.json")) return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
    } })
    const expired = "backup-2026-08-01-020000/"
    folder(expired)
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    const first = await complete(engine)
    expect(first.log.join("\n")).toContain("storage immutability or a legal hold refused deletion")
    expect(saved.has(`${expired}metadata.json`)).toBe(true)
    expect(saved.has(`${expired}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(calls.filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([`${expired}DeviceConfigurations/Old.json`])
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
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Success", Items: indexed, Scope: { Excluded: request.scope.excluded } })
    await complete(engine)
    expect(calls.filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([`${expired}DeviceConfigurations/Old.json`, `${expired}metadata.json`, `${expired}${BACKUP_OWNER_FILE}`])
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

describe("retention verification", () => {
  const expired = "backup-2026-08-01-020000/"
  const newerExpired = "backup-2026-08-02-020000/"
  const manifest = { TenantId: TENANT, Status: "Success", Items: indexed, Scope: { Included: ["DeviceConfigurations"] } }

  it.each(["missing", "policy ID", "snapshot hash", "sha256", "unlisted", "wrong key"])(
    "keeps the failing candidate and untagged backups when verification detects %s while removing independently verified owned candidates", async fault => {
      const { engine, saved, calls, seed, folder } = setup()
      const untagged = "backup-2026-08-03-020000/"
      folder(untagged, null)
      seed(untagged + "metadata.json", { Status: "Success", Items: indexed, Scope: { Included: ["DeviceConfigurations"] } })
      folder(newerExpired)
      seed(newerExpired + "metadata.json", manifest)
      folder(expired)
      const policy = expired + "DeviceConfigurations/Old.json"
      const item = { ...indexed["DeviceConfigurations/old"] }
      if (fault === "snapshot hash") item.hash = "mismatch"
      if (fault === "sha256") item.sha256 = "mismatch"
      if (fault === "missing") saved.delete(policy)
      if (fault === "policy ID") {
        const wrongPolicy = { id: "different" }
        seed(policy, wrongPolicy)
        item.hash = snapshotHash(wrongPolicy)
        item.sha256 = createHash("sha256").update(JSON.stringify(wrongPolicy)).digest("hex")
      }
      if (fault === "unlisted") seed(expired + "DeviceConfigurations/Unlisted.json", { id: "unlisted" })
      if (fault === "wrong key") seed(policy, oldItem, true, Buffer.alloc(32, 9))
      seed(expired + "metadata.json", { ...manifest, Items: { "DeviceConfigurations/old": item } })
      const job = await complete(engine)
      expect(saved.has(expired + "metadata.json")).toBe(true)
      expect(saved.has(untagged + "metadata.json")).toBe(true)
      expect(saved.has(newerExpired + "metadata.json")).toBe(false)
      expect(calls.some(call => call.request.method === "DELETE" && call.name.startsWith(expired))).toBe(false)
      expect(calls.some(call => call.request.method === "DELETE" && call.name.startsWith(untagged))).toBe(false)
      expect(job.results?.notices).toContainEqual(expect.objectContaining({ level: "warning", message: expect.stringContaining("could not be verified") }))
    },
  )

  it("does not skip an unverified backup on the next run", async () => {
    const { engine, saved, calls, seed, folder } = setup()
    folder(newerExpired)
    saved.delete(newerExpired + "DeviceConfigurations/Old.json")
    seed(newerExpired + "metadata.json", manifest)
    folder(expired)
    seed(expired + "metadata.json", manifest)
    await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(calls.some(call => call.request.method === "DELETE" && call.name.startsWith(newerExpired))).toBe(false)
  })

  it("keeps expired legacy backups with readable metadata but no item list", async () => {
    const { engine, calls, seed, folder } = setup()
    folder(expired)
    seed(expired + "metadata.json", { TenantId: TENANT, Status: "Success" })
    const job = await complete(engine)
    expect(calls.filter(call => call.request.method === "DELETE")).toEqual([])
    expect(job.log.join("\n")).toContain("no manifest item list")
  })

  it("keeps older backups when the newly written backup cannot be read back", async () => {
    const { engine, saved, seed, folder } = setup({ count: 1, override: (url, request) =>
      request.method === "GET" && url.pathname.endsWith("/Policy%200.json") ? new Response(null, { status: 404 }) : undefined })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const job = await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(job.results?.notices).toContainEqual(expect.objectContaining({ level: "warning" }))
  })

  it("keeps the Azure manifest on a conditional payload refusal and continues with older candidates", async () => {
    const payload = newerExpired + "DeviceConfigurations/Old.json"
    const { engine, saved, seed, folder, calls } = setup({ override: (url, request) =>
      request.method === "DELETE" && url.pathname.endsWith(payload) ? new Response(null, { status: 412 }) : undefined })
    for (const prefix of [expired, newerExpired]) {
      folder(prefix)
      seed(prefix + "metadata.json", manifest)
    }
    const job = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    const deletes = calls.filter(call => call.request.method === "DELETE")
    expect(deletes.map(call => call.name)).toEqual([payload, expired + "DeviceConfigurations/Old.json", expired + "metadata.json", expired + BACKUP_OWNER_FILE])
    expect(deletes.every(call => call.request.headers.get("if-match")?.startsWith('"'))).toBe(true)
    expect(job.log.join("\n")).toContain("changed before it could be deleted")
  })

  it("continues with the next candidate after reaching the run candidate limit", async () => {
    const { engine, saved, seed, folder } = setup({ limits: { candidates: 1, requests: 100, bytes: 100_000 } })
    for (const prefix of [expired, newerExpired]) {
      folder(prefix)
      seed(prefix + "metadata.json", manifest)
    }
    await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(false)
    expect(saved.has(expired + "metadata.json")).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(false)
  })

  it.each([false, true])("resumes verification within the byte budget, bound to the recovery keyring (changed: %s)", async changeKey => {
    const { engine, saved, calls, seed, folder, keyring } = setup({ limits: { candidates: 32, requests: 100, bytes: 110_000 } })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    folder(newerExpired)
    const first = { id: "old", description: "a".repeat(70_000) }
    const second = { id: "second", description: "b".repeat(70_000) }
    const firstName = newerExpired + "DeviceConfigurations/Old.json"
    seed(firstName, first, true)
    seed(newerExpired + "DeviceConfigurations/Second.json", second)
    seed(newerExpired + "metadata.json", { ...manifest, Items: {
      "DeviceConfigurations/old": { file: "Old.json", hash: snapshotHash(first) },
      "DeviceConfigurations/second": { file: "Second.json", hash: snapshotHash(second) },
    } })
    const job = await complete(engine)
    expect(job.log.join("\n")).toContain("reached its storage budget")
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(true)
    if (changeKey) keyring.splice(0, 1, Buffer.alloc(32, 9))
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(changeKey)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    expect(calls.filter(call => call.name === firstName && call.request.method === "GET")).toHaveLength(changeKey ? 2 : 1)
  })

  it("escalates repeated deferrals when deletes cannot fit within the run request budget", async () => {
    const { engine, saved, calls, seed, folder } = setup({ limits: { candidates: 32, requests: 12, bytes: 100_000 } })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    let job = await complete(engine)
    expect(job.log.join("\n")).toContain("reached its storage budget")
    expect(job.log.join("\n")).not.toContain("repeatedly deferred")
    for (let run = 0; run < 4 && !job.log.join("\n").includes("repeatedly deferred"); run++) {
      await vi.advanceTimersByTimeAsync(1_000)
      job = await complete(engine)
    }
    expect(job.log.join("\n")).toContain("repeatedly deferred")
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(calls.filter(call => call.request.method === "DELETE")).toEqual([])
  })

  it.each([false, true])("resumes verification of a newest backup over the byte budget across runs, bound to the recovery keyring (changed: %s)", async changeKey => {
    const big = "x".repeat(70_000)
    const { engine, saved, calls, seed, folder, keyring } = setup({
      count: 2,
      limits: { candidates: 32, requests: 100, bytes: 110_000 },
      override: (url) => {
        if (url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) {
          return withBackupServerTime(Response.json({ id: url.pathname.split("/").at(-1), description: big }), new Date())
        }
      },
    })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const firstJob = await complete(engine)
    const firstPolicy = `${firstJob.backupFolder}/DeviceConfigurations/Policy 0.json`
    expect(firstJob.log.join("\n")).toContain("reached its storage budget")
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(calls.filter(call => call.name === firstPolicy && call.request.method === "GET")).toHaveLength(1)
    if (changeKey) keyring.splice(0, 1, Buffer.alloc(32, 9))
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(changeKey)
    expect(calls.filter(call => call.name === firstPolicy && call.request.method === "GET")).toHaveLength(changeKey ? 2 : 1)
  })

  it("resumes newest backup verification after a job deadline and re-verifies if a verified file changes", async () => {
    const big = "y".repeat(20_000)
    let hitDeadline = true
    const { engine, saved, calls, seed, folder } = setup({
      count: 2,
      limits: { candidates: 32, requests: 100, bytes: 200_000 },
      override: (url, req) => {
        if (url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) {
          return withBackupServerTime(Response.json({ id: url.pathname.split("/").at(-1), description: big }), new Date())
        }
        if (hitDeadline && req.method === "GET" && url.pathname.endsWith("/Policy%201.json")) {
          hitDeadline = false
          vi.advanceTimersByTime(JOB_DEADLINE_MS)
          return new Promise(() => {})
        }
      },
    })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const firstJob = await complete(engine)
    const firstPolicy = `${firstJob.backupFolder}/DeviceConfigurations/Policy 0.json`
    expect(firstJob.log.join("\n")).toContain("Retention was interrupted")
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(calls.filter(call => call.name === firstPolicy && call.request.method === "GET")).toHaveLength(1)
    // Tampering with the already-verified file changes its ETag and must invalidate the saved receipt.
    // The run detects the tamper, falls back to freshly verifying the new newest backup, and deletes expired.
    const original = saved.get(firstPolicy)!
    seed(firstPolicy, { id: "p0", description: "tampered" })
    await vi.advanceTimersByTimeAsync(1_000)
    const tamperedJob = await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    expect(calls.filter(call => call.name === firstPolicy && call.request.method === "GET")).toHaveLength(2)
    expect(tamperedJob.results?.notices).toContainEqual(expect.objectContaining({ level: "warning", message: expect.stringContaining("hash does not match") }))
    // Restoring the original bytes makes the receipt match again on the next run without re-reading firstPolicy.
    const anotherExpired = "backup-2026-07-15-020000/"
    folder(anotherExpired)
    seed(anotherExpired + "metadata.json", manifest)
    saved.set(firstPolicy, original)
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect(saved.has(anotherExpired + "metadata.json")).toBe(false)
    expect(calls.filter(call => call.name === firstPolicy && call.request.method === "GET")).toHaveLength(2)
  })

  it("keeps non-resumed newest-backup receipts when the candidate phase hits the byte budget", async () => {
    const big = "z".repeat(70_000)
    const expiredBig = { id: "old", description: "w".repeat(70_000) }
    const { engine, saved, calls, seed, folder } = setup({
      count: 1,
      limits: { candidates: 32, requests: 100, bytes: 110_000 },
      override: url => {
        if (url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) {
          return withBackupServerTime(Response.json({ id: url.pathname.split("/").at(-1), description: big }), new Date())
        }
      },
    })
    folder(expired)
    seed(expired + "DeviceConfigurations/Old.json", expiredBig)
    seed(expired + "metadata.json", {
      ...manifest,
      Items: { "DeviceConfigurations/old": { file: "Old.json", hash: snapshotHash(expiredBig) } },
    })
    const firstJob = await complete(engine)
    const firstPolicy = `${firstJob.backupFolder}/DeviceConfigurations/Policy 0.json`
    expect(firstJob.log.join("\n")).toContain("reached its storage budget")
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(calls.filter(call => call.name === firstPolicy && call.request.method === "GET")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    expect(calls.filter(call => call.name === firstPolicy && call.request.method === "GET")).toHaveLength(1)
  })

  it("binds newest-backup receipts to the exact folder prefix and starts fresh for a different newest backup", async () => {
    const big = "r".repeat(70_000)
    const { engine, saved, calls, seed, folder, progressData } = setup({
      count: 2,
      limits: { candidates: 32, requests: 100, bytes: 110_000 },
      override: url => {
        if (url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) {
          return withBackupServerTime(Response.json({ id: url.pathname.split("/").at(-1), description: big }), new Date())
        }
      },
    })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const firstJob = await complete(engine)
    const key = `${TENANT}/contoso`
    const savedProgress = JSON.parse(progressData.get(key)!) as { latest?: string; reviews: Record<string, { files: Record<string, string>; attempts: number }> }
    const firstPrefix = `${firstJob.backupFolder}/`
    expect(savedProgress.latest).toBe(firstPrefix)
    const firstReceipt = savedProgress.reviews[firstPrefix]!.files["DeviceConfigurations/Policy 0.json"]!
    expect(firstReceipt).toBeTruthy()
    // Remove the old anchor and pre-seed its receipt under the next newest folder name (same content & ETag).
    for (const name of saved.keys()) if (name.startsWith(firstPrefix)) saved.delete(name)
    await vi.advanceTimersByTimeAsync(1_000)
    const nextPrefix = "backup-2026-10-12-120001/"
    progressData.set(key, JSON.stringify({
      latest: firstPrefix,
      latestAttempts: 2,
      reviews: { [nextPrefix]: { files: { "DeviceConfigurations/Policy 0.json": firstReceipt }, attempts: 0 } },
    }))
    const secondJob = await complete(engine)
    expect(`${secondJob.backupFolder}/`).toBe(nextPrefix)
    // Receipt from the old folder must not match the new folder, so Policy 0.json is read fresh.
    expect(calls.filter(call => call.name === `${nextPrefix}DeviceConfigurations/Policy 0.json` && call.request.method === "GET")).toHaveLength(1)
    // latestAttempts was reset when switching away from the gone anchor, so no 3-attempt warning yet.
    expect(secondJob.log.join("\n")).not.toContain("repeatedly reached its budget")
  })

  it("falls back in the same run to freshly verify the newest backup when a resumed anchor is unreadable, and refuses deletion if the fallback also fails", async () => {
    const big = "q".repeat(20_000)
    let hitBudget = true
    let failFallback = false
    let firstPrefix = ""
    const { engine, saved, calls, seed, folder, progressData } = setup({
      count: 2,
      limits: { candidates: 32, requests: 100, bytes: 200_000 },
      override: (url, req) => {
        if (url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) {
          return withBackupServerTime(Response.json({ id: url.pathname.split("/").at(-1), description: big }), new Date())
        }
        if (hitBudget && req.method === "GET" && url.pathname.endsWith("/Policy%201.json")) {
          hitBudget = false
          vi.advanceTimersByTime(JOB_DEADLINE_MS)
          return new Promise(() => {})
        }
        if (failFallback && req.method === "GET" && firstPrefix && !url.pathname.includes(firstPrefix) && url.pathname.endsWith("/Policy%200.json")) {
          return new Response(null, { status: 404 })
        }
      },
    })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const firstJob = await complete(engine)
    firstPrefix = `${firstJob.backupFolder}/`
    // Corrupt the resumed anchor and position cursor at firstPrefix so candidate loop reviews expired directly.
    seed(`${firstPrefix}DeviceConfigurations/Policy 0.json`, { id: "p0", description: "tampered" })
    const key = `${TENANT}/contoso`
    const stored = JSON.parse(progressData.get(key)!) as Record<string, unknown>
    progressData.set(key, JSON.stringify({ ...stored, cursor: firstPrefix }))
    await vi.advanceTimersByTimeAsync(1_000)
    // First test: when the fallback newest backup ALSO fails verification, nothing is deleted.
    failFallback = true
    const failedFallback = await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(failedFallback.results?.notices).toContainEqual(expect.objectContaining({ level: "warning" }))

    // Re-seed resumed anchor progress and test successful fallback to a healthy newest backup in the same run.
    progressData.set(key, JSON.stringify({ ...stored, cursor: firstPrefix }))
    failFallback = false
    await vi.advanceTimersByTimeAsync(1_000)
    const recovered = await complete(engine)
    const fallbackPolicy = `${recovered.backupFolder}/DeviceConfigurations/Policy 0.json`
    expect(calls.some(call => call.name === fallbackPolicy && call.request.method === "GET")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(false)
  })

  it("keeps an unreadable candidate, cleans up other owned candidates immediately, and escalates to a persistent warning after 3 consecutive failures", async () => {
    const { engine, saved, calls, seed, folder } = setup()
    folder(newerExpired)
    saved.delete(newerExpired + "DeviceConfigurations/Old.json")
    seed(newerExpired + "metadata.json", manifest)
    folder(expired)
    seed(expired + "metadata.json", manifest)
    // Attempt 1 keeps the unreadable candidate with a warning and deletes the verified owned candidate.
    const first = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    expect(calls.some(call => call.request.method === "DELETE" && call.name.startsWith(newerExpired))).toBe(false)
    expect(first.results?.notices).toContainEqual(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining(newerExpired),
    }))
    expect(first.log.join("\n")).not.toContain("consecutive failed attempts")
    // Attempt 2 keeps the unreadable candidate without escalating yet.
    await vi.advanceTimersByTimeAsync(1_000)
    const second = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(second.log.join("\n")).not.toContain("consecutive failed attempts")
    // Attempt 3 escalates to the persistent 3-attempt warning.
    await vi.advanceTimersByTimeAsync(1_000)
    const third = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(third.results?.notices).toContainEqual(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining("3 consecutive failed attempts"),
    }))
    // The persistent warning continues on later runs while the unreadable candidate remains, and newer expiries still clean up.
    const anotherExpired = "backup-2026-07-15-020000/"
    folder(anotherExpired)
    seed(anotherExpired + "metadata.json", manifest)
    await vi.advanceTimersByTimeAsync(1_000)
    const fourth = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(saved.has(anotherExpired + "metadata.json")).toBe(false)
    expect(fourth.results?.notices).toContainEqual(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining("consecutive failed attempts"),
    }))
    // Once repaired, the warning clears and the candidate ages out normally.
    seed(newerExpired + "DeviceConfigurations/Old.json", oldItem)
    await vi.advanceTimersByTimeAsync(1_000)
    const fifth = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(false)
    expect(fifth.results?.notices?.some(notice => notice.level === "warning" && notice.message.includes(newerExpired))).toBe(false)
  })

  it("keeps untagged backups and deletes only verified owned backups when a damaged manifest sits in discovery", async () => {
    const { engine, saved, calls, seed, folder } = setup()
    const damaged = "backup-2026-08-03-020000/"
    const untagged = "backup-2026-08-02-020000/"
    folder(damaged)
    saved.set(damaged + "metadata.json", Buffer.from("{ not json"))
    folder(untagged, null)
    seed(untagged + "metadata.json", { Status: "Success", Items: indexed, Scope: { Included: ["DeviceConfigurations"] } })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const first = await complete(engine)
    expect(saved.has(damaged + "metadata.json")).toBe(true)
    expect(saved.has(untagged + "metadata.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    expect(calls.some(call => call.request.method === "DELETE" && call.name.startsWith(damaged))).toBe(false)
    expect(calls.some(call => call.request.method === "DELETE" && call.name.startsWith(untagged))).toBe(false)
    expect(first.results?.notices).toContainEqual(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining(damaged),
    }))
  })

  it("drops an earlier untagged candidate from the delete plan if a later candidate fails verification", async () => {
    const { engine, saved, calls, seed, folder } = setup()
    const untagged = "backup-2026-08-03-020000/"
    folder(untagged, null)
    seed(untagged + "metadata.json", { Status: "Success", Items: indexed, Scope: { Included: ["DeviceConfigurations"] } })
    folder(newerExpired)
    saved.delete(newerExpired + "DeviceConfigurations/Old.json")
    seed(newerExpired + "metadata.json", manifest)
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const first = await complete(engine)
    expect(saved.has(untagged + "metadata.json")).toBe(true)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    expect(calls.some(call => call.request.method === "DELETE" && call.name.startsWith(untagged))).toBe(false)
    expect(first.results?.notices).toContainEqual(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining(newerExpired),
    }))
  })

  it("does not count transient storage errors toward the 3 unreadable candidate failures", async () => {
    let failWithServerError = false
    const { engine, saved, seed, folder } = setup({
      override: (url, req) => {
        if (failWithServerError && req.method === "GET" && url.pathname.endsWith(`${newerExpired}metadata.json`)) {
          return new Response("server error", { status: 500 })
        }
      },
    })
    folder(newerExpired)
    saved.delete(newerExpired + "DeviceConfigurations/Old.json")
    seed(newerExpired + "metadata.json", manifest)
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = await complete(engine)
      expect(saved.has(newerExpired + "metadata.json")).toBe(true)
      expect(run.log.join("\n")).not.toContain("consecutive failed attempts")
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // A transient 500 must not count as the 3rd unreadable failure and must stop the run.
    folder(expired)
    seed(expired + "metadata.json", manifest)
    failWithServerError = true
    const transientJob = engine.start(request)
    await vi.advanceTimersByTimeAsync(30_000)
    await engine.waitForJob(transientJob)
    expect(transientJob.status).toBe("Completed")
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(transientJob.log.join("\n")).not.toContain("consecutive failed attempts")
    // Once storage answers again, the 3rd unreadable verification failure emits the persistent warning and cleans up expired.
    failWithServerError = false
    await vi.advanceTimersByTimeAsync(1_000)
    const fourth = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    expect(fourth.results?.notices).toContainEqual(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining("3 consecutive failed attempts"),
    }))
  })

  it("persists discovery progress when candidate metadata reads exhaust the byte budget and continues after the last discovered candidate", async () => {
    const c0 = "backup-2026-08-03-020000/"
    const c1 = "backup-2026-08-02-020000/"
    const c2 = "backup-2026-08-01-020000/"
    const padded = { ...manifest, Notes: "m".repeat(42_000) }
    const { engine, saved, calls, seed, folder } = setup({ limits: { candidates: 32, requests: 100, bytes: 100_000 } })
    for (const prefix of [c0, c1, c2]) {
      folder(prefix)
      seed(prefix + "metadata.json", padded)
    }
    // Run 1 discovers c0 and c1 (~85 KB) then hits the byte budget reading c2's metadata.
    const first = await complete(engine)
    expect(first.log.join("\n")).toContain("reached its storage budget")
    expect(saved.has(c0 + "metadata.json")).toBe(true)
    expect(saved.has(c1 + "metadata.json")).toBe(true)
    expect(saved.has(c2 + "metadata.json")).toBe(true)
    const beforeRun2 = calls.length
    // Run 2 continues after c1 (starts directly at c2 without re-reading c0 or c1) and deletes c2.
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    const run2Reads = calls.slice(beforeRun2).filter(call => call.request.method === "GET").map(call => call.name)
    expect(run2Reads.some(name => name.startsWith(c0) || name.startsWith(c1))).toBe(false)
    expect(saved.has(c2 + "metadata.json")).toBe(false)
    // Run 3 wraps around and deletes c0 and c1 now that c2 is gone.
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect(saved.has(c0 + "metadata.json")).toBe(false)
    expect(saved.has(c1 + "metadata.json")).toBe(false)
  })

  it("re-checks replacement file identities immediately before each candidate's deletes and stops on any mismatch", async () => {
    let newestPrefix = ""
    let tamperOn: "before-first" | "before-second" = "before-first"
    let tampered = false
    const { engine, saved, calls, seed, folder } = setup({
      count: 1,
      override: (url, req) => {
        if (req.method === "PUT" && !url.search && url.pathname.endsWith("/metadata.json")) {
          const match = /\/(backup-[^/]+\/)/.exec(url.pathname)
          if (match) newestPrefix = match[1]!
        }
        // Trigger tamper right before the first candidate's delete (when the last candidate finishes verification)
        // or during the first candidate's delete (before the second candidate's deletes start).
        if (!tampered && newestPrefix && tamperOn === "before-first"
          && req.method === "GET" && url.pathname.endsWith(`${expired}DeviceConfigurations/Old.json`)) {
          tampered = true
          seed(`${newestPrefix}DeviceConfigurations/Policy 0.json`, { id: "p0", modified: true })
        }
        if (!tampered && newestPrefix && tamperOn === "before-second"
          && req.method === "DELETE" && url.pathname.endsWith(`${newerExpired}${BACKUP_OWNER_FILE}`)) {
          tampered = true
          seed(`${newestPrefix}DeviceConfigurations/Policy 0.json`, { id: "p0", modified: true })
        }
      },
    })
    folder(newerExpired)
    seed(newerExpired + "metadata.json", manifest)
    folder(expired)
    seed(expired + "metadata.json", manifest)

    // Case 1: replacement changes before the first delete -> keeps both candidates.
    const first = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(calls.filter(call => call.request.method === "DELETE")).toEqual([])
    expect(first.log.join("\n")).toContain("changed before deletion")

    // Case 2: replacement changes between candidate 1 and candidate 2 -> stops before candidate 2.
    tamperOn = "before-second"
    tampered = false
    await vi.advanceTimersByTimeAsync(1_000)
    const second = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(false)
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(second.log.join("\n")).toContain("changed before deletion")
  })

  it.each(["key", "clock"] as const)("runs the recovery-key and clock guard before each planned backup's deletes (%s)", async change => {
    let triggered = false
    const { engine, saved, seed, folder, keyring } = setup({
      serverTime: () => now,
      override: (url, req) => {
        if (!triggered && req.method === "DELETE" && url.pathname.endsWith(`${newerExpired}${BACKUP_OWNER_FILE}`)) {
          triggered = true
          if (change === "key") keyring.splice(0, 1, Buffer.alloc(32, 9))
          else vi.setSystemTime(new Date(now.getTime() - 2 * 3_600_000))
        }
      },
    })
    folder(newerExpired)
    seed(newerExpired + "metadata.json", manifest)
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const job = await complete(engine)
    expect(saved.has(newerExpired + "metadata.json")).toBe(false)
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(job.log.join("\n")).toContain(change === "key" ? "recovery key changed" : "differs from Microsoft's time")
  })

  it("does not advance the cursor past planned deletes that never started when interrupted", async () => {
    const c0 = "backup-2026-08-03-020000/"
    const c1 = "backup-2026-08-02-020000/"
    const c2 = "backup-2026-08-01-020000/"
    let cancelBeforeFirstDelete = true
    let activeJobId = ""
    let engineRef!: BackupEngine
    const { engine, saved, seed, folder } = setup({
      limits: { candidates: 2, requests: 100, bytes: 100_000 },
      override: (url, req) => {
        if (cancelBeforeFirstDelete && req.method === "DELETE" && url.pathname.includes(c0)) {
          cancelBeforeFirstDelete = false
          engineRef.cancel(activeJobId)
          return new Promise(() => {})
        }
      },
    })
    engineRef = engine
    for (const prefix of [c0, c1, c2]) {
      folder(prefix)
      seed(prefix + "metadata.json", manifest)
    }
    const first = engine.start(request)
    activeJobId = first.id
    await engine.waitForJob(first)
    await vi.advanceTimersByTimeAsync(0)
    expect(first.status).toBe("Completed")
    expect(first.log.join("\n")).toContain("Retention was interrupted")
    expect(saved.has(c0 + "metadata.json")).toBe(true)
    expect(saved.has(c1 + "metadata.json")).toBe(true)
    expect(saved.has(c2 + "metadata.json")).toBe(true)
    // Next run must reconsider c0 instead of skipping past the unstarted window to c2.
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect(saved.has(c0 + "metadata.json")).toBe(false)
    expect(saved.has(c2 + "metadata.json")).toBe(true)
  })

  it("resumes a partially deleted Azure backup via the deletion journal after re-verifying coverage and preserves original ETags", async () => {
    const itemA = { id: "a" }
    const itemB = { id: "b" }
    const twoItemManifest = {
      TenantId: TENANT, Status: "Success", Scope: { Included: ["DeviceConfigurations"] },
      Items: {
        "DeviceConfigurations/a": { file: "A.json", hash: snapshotHash(itemA), sha256: createHash("sha256").update(JSON.stringify(itemA)).digest("hex") },
        "DeviceConfigurations/b": { file: "B.json", hash: snapshotHash(itemB), sha256: createHash("sha256").update(JSON.stringify(itemB)).digest("hex") },
      },
    }
    let blockB = true
    const { engine, saved, calls, seed } = setup({
      override: (url, req) => {
        if (blockB && req.method === "DELETE" && url.pathname.endsWith(`${expired}DeviceConfigurations/B.json`)) {
          return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
        }
      },
    })
    seed(expired + "DeviceConfigurations/A.json", itemA)
    seed(expired + "DeviceConfigurations/B.json", itemB)
    seed(expired + BACKUP_OWNER_FILE, owner)
    seed(expired + "metadata.json", twoItemManifest)

    // Run 1 deletes A.json then is refused on B.json; journal records remaining files.
    const first = await complete(engine)
    expect(first.log.join("\n")).toContain("Kept the remaining files in backup")
    expect(saved.has(expired + "DeviceConfigurations/A.json")).toBe(false)
    expect(saved.has(expired + "DeviceConfigurations/B.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(saved.has(expired + BACKUP_OWNER_FILE)).toBe(true)

    // If replacement coverage no longer covers DeviceConfigurations, remaining files stay kept.
    blockB = false
    for (const name of saved.keys()) if (name.startsWith(`${first.backupFolder}/`)) saved.delete(name)
    await vi.advanceTimersByTimeAsync(1_000)
    const narrowed = engine.start({ ...request, scope: { excluded: INTUNE_TYPES.map(type => type.folder) } })
    await engine.waitForJob(narrowed)
    await vi.advanceTimersByTimeAsync(0)
    expect(saved.has(expired + "DeviceConfigurations/B.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(true)

    // If a remaining file changed, its original ETag no longer matches so remaining files are kept.
    const originalB = saved.get(expired + "DeviceConfigurations/B.json")!
    seed(expired + "DeviceConfigurations/B.json", { id: "b", tampered: true })
    await vi.advanceTimersByTimeAsync(1_000)
    const modified = await complete(engine)
    expect(modified.log.join("\n")).toContain("changed before it could be deleted")
    expect(saved.has(expired + "metadata.json")).toBe(true)
    saved.set(expired + "DeviceConfigurations/B.json", originalB)

    // Once coverage holds and remaining files match their original ETags, Run 4 deletes only the remaining files.
    const beforeResume = calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect([...saved.keys()].some(name => name.startsWith(expired))).toBe(false)
    const resumedDeletes = calls.slice(beforeResume).filter(call => call.request.method === "DELETE").map(call => call.name)
    expect(resumedDeletes).toEqual([
      expired + "DeviceConfigurations/B.json",
      expired + "metadata.json",
      expired + BACKUP_OWNER_FILE,
    ])
  })

  it("rejects and discards tampered deletion journals with emptied types, foreign ownership, ownership mismatch, or protected targets", async () => {
    const key = `${TENANT}/contoso`
    const etagOf = (saved: Map<string, Buffer>, name: string) => `"${createHash("sha256").update(saved.get(name)!).digest("hex")}"`
    const appItem = { id: "app1" }
    const appManifest = {
      TenantId: TENANT, Status: "Success", Scope: { Included: ["Apps"] },
      Items: { "Apps/app1": { file: "App.json", hash: snapshotHash(appItem), sha256: createHash("sha256").update(JSON.stringify(appItem)).digest("hex") } },
    }

    // 1. Tampered journal with emptied types (both without noTypes and with forged noTypes: true) cannot delete an uncovered Apps backup.
    for (const tampered of [
      { prefix: expired, types: [], untagged: false },
      { prefix: expired, types: [], noTypes: false, untagged: false },
      { prefix: expired, types: [], noTypes: true, untagged: false },
      { prefix: expired, types: ["DeviceConfigurations"], noTypes: false, untagged: false },
    ]) {
      const { engine, saved, calls, seed, progressData } = setup()
      seed(expired + "Apps/App.json", appItem)
      seed(expired + BACKUP_OWNER_FILE, owner)
      seed(expired + "metadata.json", appManifest)
      const remaining = Object.fromEntries([...saved.keys()].filter(name => name.startsWith(expired)).map(name => [name, etagOf(saved, name)]))
      progressData.set(key, JSON.stringify({ reviews: {}, deletes: { [expired]: { ...tampered, remaining } } }))
      await complete(engine)
      expect(saved.has(expired + "Apps/App.json")).toBe(true)
      expect(saved.has(expired + "metadata.json")).toBe(true)
      expect(calls.filter(call => call.request.method === "DELETE")).toEqual([])
      expect(readRetentionProgress(progressData.get(key)).deletes).toBeUndefined()
    }

    // 2. Tampered journal pointing to another tenant's expired backup is rejected by ownership resolution and protects untagged backups too.
    {
      const theirs = "backup-2026-08-01-020000/"
      const untagged = "backup-2026-08-02-020000/"
      const { engine, saved, calls, seed, folder, progressData } = setup()
      folder(theirs, { ...owner, TenantId: OTHER })
      seed(theirs + "metadata.json", { ...manifest, TenantId: OTHER })
      folder(untagged, null)
      seed(untagged + "metadata.json", { Status: "Success", Items: indexed, Scope: { Included: ["DeviceConfigurations"] } })
      const remaining = Object.fromEntries([...saved.keys()].filter(name => name.startsWith(theirs)).map(name => [name, etagOf(saved, name)]))
      progressData.set(key, JSON.stringify({
        reviews: {},
        deletes: { [theirs]: { prefix: theirs, remaining, types: ["DeviceConfigurations"], noTypes: false, untagged: false } },
      }))
      await complete(engine)
      expect(saved.has(theirs + "metadata.json")).toBe(true)
      expect(saved.has(untagged + "metadata.json")).toBe(true)
      expect(calls.filter(call => call.request.method === "DELETE")).toEqual([])
      expect(readRetentionProgress(progressData.get(key)).deletes).toBeUndefined()
    }

    // 3. Tampered journal claiming untagged: false for an actually untagged backup is discarded.
    {
      const untagged = "backup-2026-08-01-020000/"
      const { engine, saved, calls, seed, folder, progressData } = setup()
      folder(untagged, null)
      seed(untagged + "metadata.json", { Status: "Success", Items: indexed, Scope: { Included: ["DeviceConfigurations"] } })
      const remaining = Object.fromEntries([...saved.keys()].filter(name => name.startsWith(untagged)).map(name => [name, etagOf(saved, name)]))
      progressData.set(key, JSON.stringify({
        reviews: {},
        deletes: { [untagged]: { prefix: untagged, remaining, types: ["DeviceConfigurations"], noTypes: false, untagged: false } },
      }))
      await complete(engine)
      expect(saved.has(untagged + "metadata.json")).toBe(true)
      expect(calls.filter(call => call.request.method === "DELETE")).toEqual([])
      expect(readRetentionProgress(progressData.get(key)).deletes).toBeUndefined()
    }

    // 4. Journals targeting the newest backup or the resumed anchor are discarded and never delete them.
    {
      const big = "p".repeat(70_000)
      const { engine, saved, calls, seed, folder, progressData } = setup({
        count: 2,
        limits: { candidates: 32, requests: 100, bytes: 110_000 },
        override: url => {
          if (url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) {
            return withBackupServerTime(Response.json({ id: url.pathname.split("/").at(-1), description: big }), new Date())
          }
        },
      })
      folder(expired)
      seed(expired + "metadata.json", manifest)
      const first = await complete(engine)
      const anchor = `${first.backupFolder}/`
      await vi.advanceTimersByTimeAsync(1_000)
      const nextLatest = "backup-2026-10-12-120001/"
      const stored = JSON.parse(progressData.get(key)!) as { latest?: string; reviews: Record<string, unknown> }
      const anchorRemaining = Object.fromEntries([...saved.keys()].filter(name => name.startsWith(anchor)).map(name => [name, etagOf(saved, name)]))
      progressData.set(key, JSON.stringify({
        ...stored,
        deletes: {
          [anchor]: { prefix: anchor, remaining: anchorRemaining, types: ["DeviceConfigurations"], noTypes: false, untagged: false },
          [nextLatest]: { prefix: nextLatest, remaining: { [nextLatest + "metadata.json"]: '"etag"' }, types: ["DeviceConfigurations"], noTypes: false, untagged: false },
        },
      }))
      const second = await complete(engine)
      expect(`${second.backupFolder}/`).toBe(nextLatest)
      expect(saved.has(anchor + "metadata.json")).toBe(true)
      expect(saved.has(nextLatest + "metadata.json")).toBe(true)
      expect(calls.some(call => call.request.method === "DELETE" && (call.name.startsWith(anchor) || call.name.startsWith(nextLatest)))).toBe(false)
      expect(readRetentionProgress(progressData.get(key)).deletes).toBeUndefined()
    }
  })

  it("resumes a genuinely typeless backup through the deletion journal with noTypes set", async () => {
    let blockOwner = true
    const { engine, saved, calls, seed, progressData } = setup({
      override: (url, req) => {
        if (blockOwner && req.method === "DELETE" && url.pathname.endsWith(`${expired}${BACKUP_OWNER_FILE}`)) {
          return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
        }
      },
    })
    seed(expired + BACKUP_OWNER_FILE, owner)
    seed(expired + "metadata.json", { TenantId: TENANT, Status: "Success", Scope: { Included: [] }, Items: {}, ItemCounts: { TotalPolicies: 0 } })

    await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    expect(saved.has(expired + BACKUP_OWNER_FILE)).toBe(true)
    const journal = readRetentionProgress(progressData.get(`${TENANT}/contoso`)).deletes?.[expired]
    expect(journal).toMatchObject({ prefix: expired, types: [], noTypes: true, untagged: false })

    blockOwner = false
    const beforeResume = calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    await complete(engine)
    expect([...saved.keys()].some(name => name.startsWith(expired))).toBe(false)
    expect(calls.slice(beforeResume).filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([expired + BACKUP_OWNER_FILE])
  })
})

describe("retention server time", () => {
  const expired = "backup-2026-08-01-020000/"
  const manifest = { TenantId: TENANT, Status: "Success", Items: indexed, Scope: { Included: ["DeviceConfigurations"] } }

  it.each([-2, 2])("skips retention on the first run when the clock differs by %s hours", async offset => {
    const { engine, saved, seed, folder } = setup({ serverTime: () => now })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    vi.setSystemTime(new Date(now.getTime() + offset * 3_600_000))
    const job = await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(true)
    expect(job.log.join("\n")).toContain("differs from Microsoft's time by more than one hour")
  })

  it("runs retention with a correct clock after a weekend shutdown", async () => {
    const { engine, saved, seed, folder } = setup()
    await complete(engine)
    folder(expired)
    seed(expired + "metadata.json", manifest)
    vi.setSystemTime(new Date(now.getTime() + 3 * 86_400_000))
    await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(false)
  })

  it("skips retention when offline or no trusted server time is available", async () => {
    const { engine, saved, seed, folder, calls } = setup({ serverTime: () => null })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const job = await complete(engine)
    expect(job.log.join("\n")).toContain("no server time was available")
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
    expect(saved.has(expired + "metadata.json")).toBe(true)
  })

  it("warns and does not delete when the backup cannot reach Microsoft", async () => {
    const { engine, saved, seed, folder, calls } = setup({ serverTime: () => null, override: url => {
      if (url.hostname === "graph.microsoft.com") throw new TypeError("Network unavailable")
    } })
    folder(expired)
    seed(expired + "metadata.json", manifest)
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(30_000)
    await engine.waitForJob(job)
    expect(job.status).toBe("Failed")
    expect(job.log.join("\n")).toContain("Retention was skipped because no server time was available")
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
    expect(saved.has(expired + "metadata.json")).toBe(true)
  })

  it("ignores future-dated backups, excludes them from replacement coverage, and calculates age from server time", async () => {
    const future = "backup-2026-11-01-020000/"
    const inside = "backup-2026-09-12-123000/"
    const appsOnly = "backup-2026-07-01-020000/"
    const appItem = { id: "app1" }
    const appManifest = {
      TenantId: TENANT, Status: "Success", Scope: { Included: ["Apps"] },
      Items: { "Apps/app1": { file: "App.json", hash: snapshotHash(appItem), sha256: createHash("sha256").update(JSON.stringify(appItem)).digest("hex") } },
    }
    const { engine, saved, seed, folder, calls } = setup({ serverTime: () => now })
    vi.setSystemTime(new Date(now.getTime() + 45 * 60_000))
    for (const prefix of [expired, inside]) {
      folder(prefix)
      seed(prefix + "metadata.json", manifest)
    }
    for (const prefix of [future, appsOnly]) {
      seed(prefix + "Apps/App.json", appItem)
      seed(prefix + BACKUP_OWNER_FILE, owner)
      seed(prefix + "metadata.json", appManifest)
    }
    const job = await complete(engine)
    expect(saved.has(future + "metadata.json")).toBe(true)
    expect(saved.has(appsOnly + "metadata.json")).toBe(true)
    expect(saved.has(inside + "metadata.json")).toBe(true)
    expect(saved.has(expired + "metadata.json")).toBe(false)
    expect(calls.some(call => call.name.startsWith(future))).toBe(false)
    expect(job.log.join("\n")).toContain("excluded them from the review")
  })
})

describe("retention progress and manifest validation", () => {
  const expired = "backup-2026-08-01-020000/"
  const manifest = { TenantId: TENANT, Status: "Success", Items: indexed, Scope: { Included: ["DeviceConfigurations"] } }

  it("discards malformed persisted retention progress and recovers cleanly", async () => {
    const invalidCases = [
      JSON.stringify({ reviews: { [expired]: {} } }),
      JSON.stringify({ cursor: 123, reviews: {} }),
      JSON.stringify({ latest: 456, reviews: {} }),
      JSON.stringify({ latestAttempts: -1, reviews: {} }),
      JSON.stringify({ latestAttempts: 1.5, reviews: {} }),
      JSON.stringify({ reviews: [] }),
      JSON.stringify({ reviews: { [expired]: { attempts: "bad", files: {} } } }),
      JSON.stringify({ reviews: { [expired]: { attempts: 0, files: [] } } }),
      JSON.stringify({ reviews: { [expired]: { attempts: 0, files: { "a.json": 123 } } } }),
      JSON.stringify({ reviews: { [expired]: { attempts: 0, files: {}, failures: -1 } } }),
      JSON.stringify({ reviews: { [expired]: { attempts: 0, files: {}, reason: 123 } } }),
      JSON.stringify({ reviews: {}, deletes: [] }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: expired, remaining: [], types: ["DeviceConfigurations"], noTypes: false, untagged: false } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: expired, remaining: {}, types: [1], noTypes: false, untagged: false } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: expired, remaining: {}, types: ["DeviceConfigurations"], noTypes: false, untagged: "no" } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { remaining: { [expired + "metadata.json"]: '"etag"' }, types: ["DeviceConfigurations"], noTypes: false, untagged: false } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: "backup-2026-08-02-020000/", remaining: { [expired + "metadata.json"]: '"etag"' }, types: ["DeviceConfigurations"], noTypes: false, untagged: false } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: expired, remaining: { ["backup-2026-08-02-020000/metadata.json"]: '"etag"' }, types: ["DeviceConfigurations"], noTypes: false, untagged: false } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: expired, remaining: { [expired + "metadata.json"]: "*" }, types: ["DeviceConfigurations"], noTypes: false, untagged: false } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: expired, remaining: { [expired + "metadata.json"]: '"etag"' }, types: [], untagged: false } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: expired, remaining: { [expired + "metadata.json"]: '"etag"' }, types: [], noTypes: false, untagged: false } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: expired, remaining: { [expired + "metadata.json"]: '"etag"' }, types: ["DeviceConfigurations"], noTypes: true, untagged: false } } }),
      JSON.stringify({ reviews: {}, deletes: { [expired]: { prefix: expired, remaining: { [expired + "DeviceConfigurations/Old.json"]: '"etag"' }, types: [], noTypes: true, untagged: false } } }),
    ]
    for (const raw of invalidCases) {
      expect(readRetentionProgress(raw)).toEqual({ reviews: {} })
    }
    const valid = {
      cursor: expired,
      latest: "backup-2026-10-12-120000/",
      latestAttempts: 1,
      reviews: { [expired]: { attempts: 1, files: { "DeviceConfigurations/Old.json": "abc" }, failures: 2, reason: "missing" } },
      deletes: {
        [expired]: { prefix: expired, remaining: { [expired + "metadata.json"]: '"etag"' }, types: ["DeviceConfigurations"], noTypes: false, untagged: false },
        "backup-2026-07-01-020000/": { prefix: "backup-2026-07-01-020000/", remaining: { "backup-2026-07-01-020000/metadata.json": '"etag"' }, types: [], noTypes: true, untagged: false },
      },
    }
    expect(readRetentionProgress(JSON.stringify(valid))).toEqual(valid)

    const { engine, saved, seed, folder, progressData } = setup()
    progressData.set(`${TENANT}/contoso`, JSON.stringify({ reviews: { [expired]: {} } }))
    folder(expired)
    seed(expired + "metadata.json", manifest)
    await complete(engine)
    expect(saved.has(expired + "metadata.json")).toBe(false)
  })

  it("rejects inconsistent TotalPolicies and ItemCounts before granting replacement coverage, while allowing valid empty and inventory-only backups", async () => {
    const appsExpired = "backup-2026-07-01-020000/"
    const appsHolder = "backup-2026-09-25-020000/"
    const appItem = { id: "app1" }
    const appIndexed = { "Apps/app1": { file: "App.json", hash: snapshotHash(appItem), sha256: createHash("sha256").update(JSON.stringify(appItem)).digest("hex") } }
    const appManifest = { TenantId: TENANT, Status: "Success", Scope: { Included: ["Apps"] }, Items: appIndexed, ItemCounts: { Apps: 1, TotalPolicies: 1 } }

    // Contradictory TotalPolicies: 1 with empty Items must not grant coverage for Apps.
    const { engine, saved, seed } = setup()
    seed(appsExpired + "Apps/App.json", appItem)
    seed(appsExpired + BACKUP_OWNER_FILE, owner)
    seed(appsExpired + "metadata.json", appManifest)
    seed(appsHolder + BACKUP_OWNER_FILE, owner)
    seed(appsHolder + "metadata.json", {
      TenantId: TENANT, Status: "Success", Failures: 0,
      Scope: { Included: ["Apps"] }, Items: {}, ItemCounts: { Apps: 0, TotalPolicies: 1 },
    })
    const job = await complete(engine)
    expect(saved.has(appsExpired + "metadata.json")).toBe(true)
    expect(job.results?.notices).toContainEqual(expect.objectContaining({ level: "warning", message: expect.stringContaining("policy total") }))

    // Nonzero folder count in Scope.Included with empty Items must also grant no coverage.
    const second = setup()
    second.seed(appsExpired + "Apps/App.json", appItem)
    second.seed(appsExpired + BACKUP_OWNER_FILE, owner)
    second.seed(appsExpired + "metadata.json", appManifest)
    second.seed(appsHolder + BACKUP_OWNER_FILE, owner)
    second.seed(appsHolder + "metadata.json", {
      TenantId: TENANT, Status: "Success", Failures: 0,
      Scope: { Included: ["Apps"] }, Items: {}, ItemCounts: { Apps: 1, TotalPolicies: 1 },
    })
    await complete(second.engine)
    expect(second.saved.has(appsExpired + "metadata.json")).toBe(true)

    // Valid empty backup with TotalPolicies: 0 and inventory-only backup (AutopilotDevices excluded from TotalPolicies) still pass and grant coverage.
    const third = setup()
    const device = { id: "ap1" }
    third.seed(appsExpired + "Apps/App.json", appItem)
    third.seed(appsExpired + BACKUP_OWNER_FILE, owner)
    third.seed(appsExpired + "metadata.json", appManifest)
    third.seed(appsHolder + "AutopilotDevices/Device.json", device)
    third.seed(appsHolder + BACKUP_OWNER_FILE, owner)
    third.seed(appsHolder + "metadata.json", {
      TenantId: TENANT, Status: "Success", Failures: 0,
      Scope: { Included: ["Apps", "AutopilotDevices"] },
      Items: { "AutopilotDevices/ap1": { file: "Device.json", hash: snapshotHash(device), sha256: createHash("sha256").update(JSON.stringify(device)).digest("hex") } },
      ItemCounts: { Apps: 0, AutopilotDevices: 1, TotalPolicies: 0 },
    })
    await complete(third.engine)
    expect(third.saved.has(appsExpired + "metadata.json")).toBe(false)
  })
})
