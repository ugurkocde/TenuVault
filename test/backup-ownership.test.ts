import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { createHash } from "node:crypto"
import type { RetentionProgressStore } from "../src/main/backup/retention-progress"
import type { RetentionLimits } from "../src/main/backup/retention-budget"
import { afterEach, describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import { NextRequest } from "next/server"
import { BackupEngine } from "../src/main/backup/engine"
import { legacyAzureReader, registerStorageToken } from "../src/main/storage/azure-seal"
import { LEGACY_SEALED_MESSAGE } from "../src/shared/legacy-sealed"
import { sealLegacyAzure } from "./legacy-seal"
import { endlessBody } from "./helpers"
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
const oldPolicy = { id: "old" }
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const items = { "DeviceConfigurations/old": { file: "Old.json", sha256: sha256(oldPolicy) } }
const completeManifest = { TenantId: TENANT, Status: "Success", Items: items, Scope: { Included: ["DeviceConfigurations"] } }

function setup(options: { retention?: number; count?: number; limits?: RetentionLimits; progress?: RetentionProgressStore; override?: (url: URL, request: Request) => Response | Promise<Response> | undefined } = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const saved = new Map<string, Buffer>()
  const calls: Array<{ name: string; request: Request }> = []
  const etag = (name: string) => options.progress && saved.has(name) ? `"${createHash("sha256").update(saved.get(name)!).digest("hex")}"` : '"fixture"'
  const wireFetch: typeof fetch = async (input, init) => {
    const sent = new Request(input, init), url = new URL(sent.url)
    const name = decodeURIComponent(url.pathname.slice("/intune-backups/".length))
    calls.push({ name, request: sent })
    const overridden = options.override?.(url, sent)
    if (overridden) return overridden
    if (url.hostname === "graph.microsoft.com") {
      if (url.pathname.endsWith("/deviceCompliancePolicies")) return Response.json({ value: [] })
      return url.pathname.endsWith("/deviceConfigurations")
        ? Response.json({ value: Array.from({ length: options.count ?? 0 }, (_, index) => ({ id: `p${index}`, displayName: `Policy ${index}` })) })
        : Response.json({ id: url.pathname.split("/").at(-1), assignments: [] })
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
      return new Response(null, { status: 201 })
    }
    if (sent.method === "DELETE") {
      saved.delete(name)
      return new Response(null, { status: 202 })
    }
    return new Response(sent.method === "HEAD" || !saved.has(name) ? null : new Uint8Array(saved.get(name)!), { status: saved.has(name) ? 200 : 404, headers: { etag: etag(name) } })
  }
  registerStorageToken("token", TENANT)
  const fetch = legacyAzureReader(wireFetch, () => [master])
  const createEngine = () => new BackupEngine({ fetch, getToken: async () => { registerStorageToken("token", TENANT); return "token" },
    retentionDays: () => options.retention ?? 30, retentionLimits: options.limits, retentionProgress: options.progress })
  const engine = createEngine()
  /** A plain blob, as this version writes, or one sealed by an earlier version with `key`. */
  function seed(name: string, value: unknown, sealed = false, key = master) {
    const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    saved.set(name, sealed ? sealLegacyAzure(body, key, TENANT, new URL(`${base}${name}`)) : body)
  }
  function folder(prefix: string, marker: unknown = owner, sealed = false) {
    seed(`${prefix}DeviceConfigurations/Old.json`, oldPolicy, sealed)
    if (marker !== null) seed(`${prefix}${BACKUP_OWNER_FILE}`, marker, sealed)
  }
  return { engine, createEngine, fetch, saved, calls, seed, folder }
}

async function complete(engine: BackupEngine, scope = request.scope) {
  const job = engine.start({ ...request, scope })
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
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Failed", Failures: 0, Scope: { Excluded: [] }, Items: items, ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 } })
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
    expect(calls.filter(call => call.name.startsWith(prefix)).map(call => [call.request.method, call.name])).toEqual([["GET", `${prefix}metadata.json`], ["GET", `${prefix}${BACKUP_OWNER_FILE}`]])
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

  it("keeps just the unreadable legacy backup when the other backups can be verified", async () => {
    const { engine, saved, seed, folder } = setup()
    const plain = "backup-2026-08-01-020000/", legacy = "backup-2026-08-02-020000/", unopenable = "backup-2026-08-03-020000/"
    const manifest = { TenantId: TENANT, Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } }
    folder(plain)
    seed(`${plain}metadata.json`, manifest)
    folder(legacy, owner, true)
    seed(`${legacy}metadata.json`, manifest, true)
    folder(unopenable, owner, true)
    seed(`${unopenable}metadata.json`, manifest, true, Buffer.alloc(32, 9))
    const kept = [...saved.entries()].filter(([name]) => name.startsWith(unopenable))
    const job = await complete(engine)
    expect([...saved.keys()].some(name => name.startsWith(plain) || name.startsWith(legacy))).toBe(false)
    for (const [name, body] of kept) expect(saved.get(name)).toEqual(body)
    expect(job.log.join("\n")).toContain(`Could not read the metadata of 1 older backup: ${LEGACY_SEALED_MESSAGE.replace(/\.$/, "")}. Older backups were left in place.`)
  })

  it("never deletes another tenant's untagged backup when a damaged manifest sits in the container", async () => {
    const { engine, saved, seed, folder } = setup()
    const damaged = "backup-2026-08-01-020000/", theirs = "backup-2026-08-02-020000/"
    folder(damaged)
    saved.set(`${damaged}metadata.json`, Buffer.from("{ not json"))
    folder(theirs, { ...owner, TenantId: OTHER })
    seed(`${theirs}metadata.json`, { Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } })
    const original = new Map(saved)
    const job = await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
    expect(job.log.join("\n")).toContain("Could not read the metadata of 1 older backup: metadata.json is not valid JSON. Older backups were left in place.")
  })

  it("places an expired untagged backup by its ownership marker", async () => {
    const { engine, saved, seed, folder } = setup()
    const ours = "backup-2026-08-01-020000/", theirs = "backup-2026-08-02-020000/", damagedMarker = "backup-2026-08-03-020000/"
    for (const prefix of [ours, theirs]) seed(`${prefix}metadata.json`, { Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } })
    folder(ours)
    folder(theirs, { ...owner, TenantId: OTHER })
    folder(damagedMarker, { ...owner, TenantId: OTHER })
    const kept = [...saved.entries()].filter(([name]) => name.startsWith(theirs) || name.startsWith(damagedMarker))
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
    seed(`${legacy}metadata.json`, { Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } })
    const original = new Map(saved)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
  })

  it("keeps untagged backups when a manifestless folder's marker cannot be read", async () => {
    const { engine, saved, seed, folder } = setup()
    const abandoned = "backup-2026-08-01-020000/", legacy = "backup-2026-08-02-020000/"
    folder(abandoned, "{ damaged")
    folder(legacy, null)
    seed(`${legacy}metadata.json`, { Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } })
    const original = new Map(saved)
    await complete(engine)
    for (const [name, body] of original) expect(saved.get(name)).toEqual(body)
  })

  it("still ages out an untagged backup when nothing in the container shows another tenant", async () => {
    const { engine, saved, seed, folder } = setup()
    const abandoned = "backup-2026-08-01-020000/", legacy = "backup-2026-08-02-020000/"
    folder(abandoned)
    folder(legacy, null)
    seed(`${legacy}metadata.json`, { Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } })
    await complete(engine)
    expect([...saved.keys()].some((name) => name.startsWith(legacy))).toBe(false)
    expect(saved.has(`${abandoned}${BACKUP_OWNER_FILE}`)).toBe(true)
  })

  it("keeps an untagged backup whose marker is oversized and reviews other candidates", async () => {
    const big = endlessBody(40, new TextEncoder().encode('{"TenantId":"'))
    const oversized = "backup-2026-08-01-020000/", ours = "backup-2026-08-02-020000/"
    const { engine, saved, seed, folder } = setup({ override: (url, sent) => sent.method === "GET" && url.pathname.endsWith(`${oversized}${BACKUP_OWNER_FILE}`) ? new Response(big.body) : undefined })
    seed(`${oversized}metadata.json`, { Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } })
    folder(oversized)
    seed(`${ours}metadata.json`, { TenantId: TENANT, Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } })
    folder(ours)
    const job = await complete(engine)
    expect(saved.has(`${oversized}metadata.json`)).toBe(true)
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
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } })
    const first = await complete(engine)
    expect(first.log.join("\n")).toContain("protected by the storage account's immutability policy or legal hold")
    expect(saved.has(`${expired}metadata.json`)).toBe(true)
    expect(saved.has(`${expired}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(calls.filter(call => call.request.method === "DELETE").map(call => call.name)).toEqual([`${expired}DeviceConfigurations/Old.json`])
    await vi.advanceTimersByTimeAsync(1000)
    await complete(engine)
    expect(saved.has(`${expired}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(saved.has(`${expired}DeviceConfigurations/Old.json`)).toBe(true)
    expect(calls.some(call => call.request.method === "DELETE" && call.name.endsWith(BACKUP_OWNER_FILE))).toBe(false)
  })

  it("keeps the manifest after a conditional payload refusal and continues cleanup", async () => {
    const changed = "backup-2026-08-03-020000/", next = "backup-2026-08-02-020000/", deferred = "backup-2026-08-01-020000/"
    const { engine, saved, seed, folder } = setup({ limits: { candidates: 2, requests: 200, bytes: 100_000 }, override: (url, sent) => {
      if (sent.method === "DELETE" && url.pathname.endsWith(`${changed}DeviceConfigurations/New.json`)) {
        return new Response(null, { status: 412 })
      }
    } })
    const anotherPolicy = { id: "new" }
    for (const prefix of [changed, next, deferred]) {
      folder(prefix)
      seed(`${prefix}metadata.json`, completeManifest)
    }
    seed(`${changed}DeviceConfigurations/New.json`, anotherPolicy)
    seed(`${changed}metadata.json`, { ...completeManifest, Items: { ...items, "DeviceConfigurations/new": { file: "New.json", sha256: sha256(anotherPolicy) } } })
    const first = await complete(engine)
    expect(first.log.join("\n")).toContain("Retention partly removed")
    expect(first.log.join("\n")).toContain("changed during retention")
    expect(saved.has(`${changed}metadata.json`)).toBe(true)
    expect(saved.has(`${changed}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(saved.has(`${changed}DeviceConfigurations/Old.json`)).toBe(false)
    expect(saved.has(`${next}metadata.json`)).toBe(false)
    expect(saved.has(`${deferred}metadata.json`)).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    await complete(engine)
    expect(saved.has(`${deferred}metadata.json`)).toBe(false)
  })

  it("deletes ownership last after a complete retention deletion", async () => {
    const { engine, calls, seed, folder } = setup()
    const expired = "backup-2026-08-01-020000/"
    folder(expired)
    seed(`${expired}metadata.json`, { TenantId: TENANT, Status: "Success", Items: items, Scope: { Excluded: request.scope.excluded } })
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

describe("verified retention coverage", () => {
  it.each(["identity", "legacy snapshot hash", "byte hash"])("rejects a sealed policy that disagrees with its manifest %s", async mismatch => {
    const { engine, saved, calls, seed, folder } = setup()
    const older = "backup-2026-08-01-020000/"
    const newer = "backup-2026-09-01-020000/"
    folder(older)
    seed(`${older}metadata.json`, completeManifest)
    const actual = mismatch === "identity" ? { id: "other" } : { id: "old", description: "actual" }
    seed(`${newer}DeviceConfigurations/Old.json`, actual, true)
    seed(`${newer}metadata.json`, { ...completeManifest, Items: { "DeviceConfigurations/old": {
      file: "Old.json",
      hash: snapshotHash(mismatch === "legacy snapshot hash" ? oldPolicy : actual),
      ...(mismatch === "byte hash" ? { sha256: sha256(oldPolicy) } : {}),
    } } }, true)
    const job = await complete(engine)
    expect(saved.has(`${older}metadata.json`)).toBe(true)
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
    expect(job.log.join("\n")).toContain("does not match its manifest")
  })

  it.each(["missing", "damaged", "unauthenticated", "hash mismatch", "valid"])("checks every referenced policy before replacing the older copy: %s", async condition => {
    const { engine, saved, calls, seed, folder } = setup()
    const older = "backup-2026-08-01-020000/"
    const newer = "backup-2026-09-01-020000/"
    folder(older)
    seed(`${older}metadata.json`, completeManifest)
    seed(`${newer}metadata.json`, {
      ...completeManifest,
      Items: condition === "unauthenticated" ? { "DeviceConfigurations/old": { file: "Old.json" } } : items,
    })
    if (condition !== "missing") {
      const body = condition === "damaged" ? "{ malformed" : condition === "hash mismatch" ? { id: "old", changed: true } : oldPolicy
      seed(`${newer}DeviceConfigurations/Old.json`, body)
    }
    // A failed read supplies no coverage. Independent current coverage still permits cleanup.
    const scope = condition === "damaged" ? request.scope : { excluded: INTUNE_TYPES.filter(type => type.folder !== "CompliancePolicies").map(type => type.folder) }
    const job = await complete(engine, scope)
    expect(saved.has(`${older}metadata.json`)).toBe(!["valid", "damaged"].includes(condition))
    expect(saved.has(`${newer}metadata.json`)).toBe(true)
    const deletes = calls.filter(call => call.request.method === "DELETE")
    if (["valid", "damaged"].includes(condition)) expect(deletes.map(call => call.name)).toEqual([`${older}DeviceConfigurations/Old.json`, `${older}metadata.json`, `${older}${BACKUP_OWNER_FILE}`])
    else {
      expect(deletes).toEqual([])
      expect(job.log.join("\n")).toContain("could not be verified")
    }
  })

  it.each(["requests", "bytes"] as const)("keeps the expired backup when the %s budget is exhausted", async limit => {
    const limits = { candidates: 4, requests: 100, bytes: 100_000, [limit]: limit === "requests" ? 5 : 200 }
    const { engine, saved, calls, seed, folder } = setup({ limits })
    const older = "backup-2026-08-01-020000/"
    folder(older)
    seed(`${older}metadata.json`, completeManifest)
    const job = await complete(engine)
    const reads = calls.filter(call => ["GET", "DELETE"].includes(call.request.method) && new URL(call.request.url).hostname !== "graph.microsoft.com")
    expect(reads.filter(call => call.name.startsWith(older)).length).toBeLessThanOrEqual(limits.requests)
    expect(job.log.join("\n")).toContain("reached its storage budget")
    expect(saved.has(`${older}metadata.json`)).toBe(true)
    expect(calls.some(call => call.request.method === "DELETE")).toBe(false)
  })

  it("keeps an oversized candidate and resumes with smaller older backups", async () => {
    const { engine, saved, seed, folder } = setup({ limits: { candidates: 8, requests: 100, bytes: 32_000 } })
    const older = "backup-2026-08-01-020000/", oversized = "backup-2026-09-01-020000/"
    folder(older)
    seed(`${older}metadata.json`, completeManifest)
    const bigPolicy = { ...oldPolicy, settings: "a".repeat(64_000) }
    seed(`${oversized}DeviceConfigurations/Old.json`, bigPolicy)
    seed(`${oversized}metadata.json`, { ...completeManifest, Items: { "DeviceConfigurations/old": { file: "Old.json", sha256: sha256(bigPolicy) } } })
    const first = await complete(engine)
    expect(first.log.join("\n")).toContain(`Kept backup ${oversized} because retention reached its storage budget`)
    expect(saved.has(`${older}metadata.json`)).toBe(false)
    for (let run = 2; run <= 3; run++) {
      await vi.advanceTimersByTimeAsync(1000)
      const job = await complete(engine)
      expect(job.log.join("\n").includes("Retention has repeatedly kept")).toBe(run === 3)
    }
    expect(saved.has(`${oversized}metadata.json`)).toBe(true)
  })

  it.each([false, true])("resumes a byte-limited verification after restart and rechecks changed ETags (%s)", async changed => {
    const values = new Map<string, string>()
    const progress = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value) },
      delete: (key: string) => { values.delete(key) } }
    const { engine, createEngine, saved, calls, seed, folder } = setup({ progress, limits: { candidates: 8, requests: 100, bytes: 13_000 } })
    const older = "backup-2026-08-01-020000/"
    folder(older)
    const first = { id: "first", description: "a".repeat(8_000) }
    const second = { id: "second", description: "b".repeat(8_000) }
    const firstPath = `${older}DeviceConfigurations/First.json`
    const secondPath = `${older}DeviceConfigurations/Second.json`
    saved.delete(`${older}DeviceConfigurations/Old.json`)
    seed(firstPath, first)
    seed(secondPath, second)
    seed(`${older}metadata.json`, { ...completeManifest, Items: {
      "DeviceConfigurations/first": { file: "First.json", hash: snapshotHash(first) },
      "DeviceConfigurations/second": { file: "Second.json", hash: snapshotHash(second) },
    } })
    expect((await complete(engine)).log.join("\n")).toContain("reached its storage budget")
    expect(saved.has(`${older}metadata.json`)).toBe(true)
    if (changed) seed(firstPath, { ...first, description: "changed" })
    calls.length = 0
    await vi.advanceTimersByTimeAsync(1000)
    const resumed = await complete(createEngine())
    expect(saved.has(`${older}metadata.json`)).toBe(changed)
    expect(calls.some(call => call.name === firstPath && call.request.method === "GET")).toBe(changed)
    if (changed) expect(resumed.log.join("\n")).toContain("does not match its manifest")
  })

  it("continues with the next candidate after reaching the candidate limit", async () => {
    const { engine, saved, calls, seed, folder } = setup({ limits: { candidates: 1, requests: 25, bytes: 100_000 } })
    const older = "backup-2026-08-01-020000/", newer = "backup-2026-09-01-020000/"
    for (const prefix of [older, newer]) {
      folder(prefix)
      seed(`${prefix}metadata.json`, completeManifest)
    }
    const first = await complete(engine)
    expect(first.log.join("\n")).toContain("will continue reviewing older backups")
    expect(saved.has(`${newer}metadata.json`)).toBe(false)
    expect(saved.has(`${older}metadata.json`)).toBe(true)
    expect(calls.some(call => call.name === `${older}metadata.json` && call.request.method === "GET")).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await complete(engine)
    expect(saved.has(`${older}metadata.json`)).toBe(false)
    for (const call of calls.filter(call => call.request.method === "DELETE")) expect(call.request.headers.get("if-match")).toBe('"fixture"')
  })
})
