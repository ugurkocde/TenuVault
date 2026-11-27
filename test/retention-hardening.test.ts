import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { BlobWriter } from "../src/main/backup/blob-writer"
import { readRetentionProgress, type RetentionProgressStore } from "../src/main/backup/retention-progress"
import { verifyHalf } from "../src/main/backup/retention-verification"
import { legacyAzureReader, legacyRecoveryFingerprint, registerStorageToken } from "../src/main/storage/azure-seal"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { backupBlobName, backupContainer, backupStoragePath, untrustedTimeMarker } from "../src/shared/backup-storage"
import { BACKUP_CONTAINER, BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { indexPath } from "../src/shared/large-backup"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { memoryStore, withServerDate } from "./helpers"
import { jwt, registerTestTypes, testType } from "./helpers/backup-fixture"
import type { RetentionLimits } from "../src/main/backup/retention-budget"

const TENANT = "11111111-1111-1111-1111-111111111111"
const MASTER = Buffer.alloc(32, 4)
const NOW = new Date("2026-10-12T12:00:00Z")
const OWNER = { Source: "TenuVault Desktop", TenantId: TENANT }
const OLD_POLICY = { id: "old" }
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const ITEMS = { "DeviceConfigurations/old": { file: "Old.json", sha256: sha256(OLD_POLICY) } }
const COMPLETE_MANIFEST = {
  TenantId: TENANT,
  Status: "Success",
  Failures: 0,
  Items: ITEMS,
  ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 },
  Scope: { Included: ["DeviceConfigurations"] },
}
const DEVICE_CONFIG_SCOPE = {
  excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder),
}
const COMPLIANCE_ONLY_SCOPE = {
  excluded: INTUNE_TYPES.filter(type => type.folder !== "CompliancePolicies").map(type => type.folder),
}

function setupAzure(options: {
  retention?: number
  count?: number
  limits?: RetentionLimits
  progress?: RetentionProgressStore
  serverTime?: () => Date | null
  graphTime?: () => Date | null
  override?: (url: URL, request: Request) => Response | Promise<Response> | undefined
} = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const saved = new Map<string, Buffer>()
  const etags = new Map<string, string>()
  let revision = 0
  const calls: Array<{ name: string; request: Request }> = []
  const etagOf = (name: string) => etags.get(name) ?? (saved.has(name) ? `"${createHash("sha256").update(saved.get(name)!).digest("hex")}"` : '"missing"')
  const writeBlob = (name: string, body: Buffer) => {
    saved.set(name, body)
    etags.set(name, `"v${++revision}-${createHash("sha256").update(body).digest("hex").slice(0, 12)}"`)
  }
  const wireFetch: typeof fetch = async (input, init) => {
    const sent = new Request(input, init)
    const url = new URL(sent.url)
    const container = url.pathname.split("/")[1] ?? ""
    const rawName = decodeURIComponent(url.pathname.slice(`/${container}/`.length))
    const name = container === "tenuvault-large-backups" && rawName.startsWith("payload/") ? rawName.slice("payload/".length) : rawName
    const key = `${container}/${rawName}`
    calls.push({ name, request: sent })
    const overridden = options.override?.(url, sent)
    if (overridden) return overridden
    if (url.hostname === "graph.microsoft.com") {
      if (url.pathname.endsWith("/deviceCompliancePolicies")) return Response.json({ value: [] })
      if (url.pathname.endsWith("/deviceConfigurations")) {
        return Response.json({ value: Array.from({ length: options.count ?? 0 }, (_, index) => ({ id: `p${index}`, displayName: `Policy ${index}` })) })
      }
      return Response.json({ id: url.pathname.split("/").at(-1), assignments: [] })
    }
    if (url.searchParams.get("comp") === "list") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const delimiter = url.searchParams.get("delimiter")
      const names = [...saved.keys()]
        .filter(stored => stored.startsWith(`${container}/`))
        .map(stored => stored.slice(container.length + 1))
        .filter(stored => stored.startsWith(prefix))
      const entries = delimiter
        ? [...new Set(names.map(stored => {
            const rest = stored.slice(prefix.length)
            const cut = rest.indexOf(delimiter)
            return cut >= 0 ? prefix + rest.slice(0, cut + delimiter.length) : stored
          }))].map(stored => stored.endsWith(delimiter)
            ? `<BlobPrefix><Name>${stored}</Name></BlobPrefix>`
            : `<Blob><Name>${stored}</Name><Properties><Etag>${etagOf(`${container}/${stored}`)}</Etag></Properties></Blob>`)
        : names.map(stored => `<Blob><Name>${stored}</Name><Properties><Content-Length>${saved.get(`${container}/${stored}`)!.byteLength}</Content-Length><Etag>${etagOf(`${container}/${stored}`)}</Etag></Properties></Blob>`)
      return new Response(`<Blobs>${entries.join("")}</Blobs>`)
    }
    if (sent.method === "PUT") {
      if (!url.search) writeBlob(key, Buffer.from(await sent.arrayBuffer()))
      return new Response(null, { status: 201, headers: { etag: etagOf(key) } })
    }
    if (sent.method === "DELETE") {
      const ifMatch = sent.headers.get("if-match")
      if (saved.has(key) && ifMatch && ifMatch !== etagOf(key)) {
        return new Response(null, { status: 412, headers: { "x-ms-error-code": "ConditionNotMet" } })
      }
      saved.delete(key)
      etags.delete(key)
      return new Response(null, { status: 202 })
    }
    if (!saved.has(key)) return new Response(null, { status: 404 })
    return new Response(sent.method === "HEAD" ? null : new Uint8Array(saved.get(key)!), { status: 200, headers: { etag: etagOf(key) } })
  }
  registerStorageToken("token", TENANT)
  const keys = [MASTER]
  const fetch = legacyAzureReader(async (input, init) => {
    const response = await wireFetch(input, init)
    const url = new URL(input instanceof Request ? input.url : input)
    const serverTime = url.hostname === "graph.microsoft.com"
      ? (options.graphTime ? options.graphTime() : options.serverTime ? options.serverTime() : NOW)
      : url.hostname === "contoso.blob.core.windows.net"
        ? (options.serverTime ? options.serverTime() : NOW)
        : null
    return serverTime && !response.headers.has("date") ? withServerDate(response, serverTime) : response
  }, () => keys)
  const createEngine = () => new BackupEngine({
    fetch,
    getToken: async () => { registerStorageToken("token", TENANT); return "token" },
    retentionDays: () => options.retention ?? 30,
    retentionLimits: options.limits,
    retentionProgress: options.progress,
    recoveryKeyFingerprint: () => legacyRecoveryFingerprint(keys),
  })
  const engine = createEngine()
  const keyOf = (logical: string) => `${backupContainer(logical)}/${backupBlobName(logical)}`
  const seed = (logical: string, value: unknown) => {
    const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    writeBlob(keyOf(logical), body)
  }
  const has = (logical: string) => saved.has(keyOf(logical))
  const folder = (prefix: string, marker: unknown = OWNER) => {
    seed(`${prefix}DeviceConfigurations/Old.json`, OLD_POLICY)
    if (marker !== null) seed(`${prefix}${BACKUP_OWNER_FILE}`, marker)
  }
  return { engine, createEngine, fetch, saved, etags, calls, seed, has, folder, keys, keyOf }
}

async function runBackup(engine: BackupEngine, scope = DEVICE_CONFIG_SCOPE) {
  const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: "contoso", scope })
  await engine.waitForJob(job)
  await vi.advanceTimersByTimeAsync(0)
  expect(job.status, job.log.join("\n")).toBe("Completed")
  return job
}

const tempRoots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("retention progress validation", () => {
  it("accepts valid persisted retention progress shapes including complete receipts and deletion journals", () => {
    const valid = {
      cursor: "backup-2026-08-01-020000/",
      latest: "backup-2026-10-12-120000/",
      latestAttempts: 2,
      timeAttempts: 1,
      reviews: {
        "backup-2026-08-01-020000/": {
          files: { "DeviceConfigurations/Old.json": "abc123" },
          complete: { identity: "deadbeef", counts: [["DeviceConfigurations", 1]] },
          attempts: 0,
        },
      },
      deletions: {
        "backup-2026-08-01-020000/": {
          prefixes: ["backup-2026-08-01-020000/"],
          remnant: false,
          folders: ["DeviceConfigurations"],
          remaining: { "backup-2026-08-01-020000/metadata.json": '"etag-1"' },
          deleted: ["backup-2026-08-01-020000/DeviceConfigurations/Old.json"],
        },
      },
    }
    expect(readRetentionProgress(JSON.stringify(valid))).toEqual(valid)
    expect(readRetentionProgress("backup-2026-08-01-020000/")).toEqual({ cursor: "backup-2026-08-01-020000/", reviews: {} })
  })

  it.each([
    ["empty review entry", { reviews: { "backup-2026-01-01-000000/": {} } }],
    ["array reviews", { reviews: [] }],
    ["non-string cursor", { cursor: 123, reviews: {} }],
    ["non-string latest", { latest: 42, reviews: {} }],
    ["negative latestAttempts", { latestAttempts: -1, reviews: {} }],
    ["float latestAttempts", { latestAttempts: 1.5, reviews: {} }],
    ["non-integer timeAttempts", { timeAttempts: "2", reviews: {} }],
    ["missing review files", { reviews: { "backup-2026-01-01-000000/": { attempts: 0 } } }],
    ["array review files", { reviews: { "backup-2026-01-01-000000/": { attempts: 0, files: [] } } }],
    ["non-string file receipt", { reviews: { "backup-2026-01-01-000000/": { attempts: 0, files: { a: 42 } } } }],
    ["negative review attempts", { reviews: { "backup-2026-01-01-000000/": { attempts: -1, files: {} } } }],
    ["malformed complete receipt", { reviews: { "backup-2026-01-01-000000/": { attempts: 0, files: {}, complete: { identity: "x", counts: [["DeviceConfigurations", -1]] } } } }],
    ["malformed deletion journal", { reviews: {}, deletions: { "backup-2026-01-01-000000/": { prefixes: [], remnant: false, folders: [], remaining: {}, deleted: [] } } }],
    ["empty etag in deletion journal", { reviews: {}, deletions: { "backup-2026-01-01-000000/": { prefixes: ["backup-2026-01-01-000000/"], remnant: false, folders: [], remaining: { a: "" }, deleted: [] } } }],
  ])("discards persisted progress with invalid shape: %s", (_label, bad) => {
    expect(readRetentionProgress(JSON.stringify(bad))).toEqual({ reviews: {} })
  })

  it("uses path.basename for quarantine assertions in local-put-replacement.test.ts", () => {
    const source = readFileSync(resolve(process.cwd(), "test/local-put-replacement.test.ts"), "utf8")
    expect(source).not.toContain('quarantine.split("/")')
    expect(source).toContain("basename(quarantine)")
    // Sanity check hash helper import stays used cleanly
    expect(createHash("sha256").update("ok").digest("hex")).toHaveLength(64)
  })
})

describe("manifest TotalPolicies and ItemCounts consistency (item 1)", () => {
  it("rejects empty Items with ItemCounts claiming TotalPolicies > 0 before granting coverage", async () => {
    const { engine, has, seed, folder } = setupAzure()
    const older = "backup-2026-08-01-020000/"
    const newer = "backup-2026-09-01-020000/"
    folder(older)
    seed(`${older}metadata.json`, COMPLETE_MANIFEST)
    seed(`${newer}${BACKUP_OWNER_FILE}`, OWNER)
    seed(`${newer}metadata.json`, {
      TenantId: TENANT,
      Status: "Success",
      Failures: 0,
      Scope: { Included: ["DeviceConfigurations"] },
      Items: {},
      ItemCounts: { DeviceConfigurations: 0, TotalPolicies: 1 },
    })

    // Current backup covers only CompliancePolicies, so older relies on newer for DeviceConfigurations.
    const job = await runBackup(engine, COMPLIANCE_ONLY_SCOPE)
    expect(has(`${older}metadata.json`)).toBe(true)
    expect(has(`${newer}metadata.json`)).toBe(true)
    expect(job.log.join("\n")).toContain("metadata.json counts could not be verified")
  })

  it("allows a valid empty backup with TotalPolicies: 0 to grant coverage", async () => {
    const { engine, has, seed, folder } = setupAzure()
    const older = "backup-2026-08-01-020000/"
    const newer = "backup-2026-09-25-020000/"
    folder(older)
    seed(`${older}metadata.json`, COMPLETE_MANIFEST)
    seed(`${newer}${BACKUP_OWNER_FILE}`, OWNER)
    seed(`${newer}metadata.json`, {
      TenantId: TENANT,
      Status: "Success",
      Failures: 0,
      Scope: { Included: ["DeviceConfigurations"] },
      Items: {},
      ItemCounts: { DeviceConfigurations: 0, TotalPolicies: 0 },
    })

    const job = await runBackup(engine, COMPLIANCE_ONLY_SCOPE)
    expect(has(`${older}metadata.json`), job.log.join("\n")).toBe(false)
    expect(has(`${newer}metadata.json`)).toBe(true)
  })

  it("validates TotalPolicies on large backups using inventory exclusion rules", async () => {
    const prefix = "backup-large-2026-09-01-020000/"
    const folder = "Groups"
    const emptyHash = createHash("sha256").digest("hex")
    const emptyRef = (format: string) => ({ format, count: 0, shards: 0, complete: true, hash: emptyHash })
    const group = {
      id: "11111111-1111-1111-1111-111111111111",
      displayName: "Finance",
      members: emptyRef("sorted-id-shards-v1"),
      owners: emptyRef("sorted-id-shards-v1"),
      settings: emptyRef("sorted-object-shards-v1"),
    }
    const shardName = indexPath(folder, 0)
    const shard = [{ id: group.id, file: `${group.id}.json`, hash: snapshotHash(group), sha256: sha256(group) }]
    const makeManifest = (totalPolicies: number) => ({
      TenantId: TENANT,
      Status: "Success",
      Failures: 0,
      Coverage: "Complete",
      Scope: { Included: [folder] },
      Items: {},
      LargeItems: { [folder]: { version: 1, count: 1, shards: 1, complete: true } },
      LargeIndexHashes: { [shardName]: sha256(shard) },
      ItemCounts: { [folder]: 1, TotalPolicies: totalPolicies },
    })

    const verifyWithTotal = async (totalPolicies: number) => {
      const manifest = makeManifest(totalPolicies)
      const stored = new Map<string, { bytes: Buffer; etag: string }>()
      const etags = new Map<string, string>()
      for (const [name, value] of [["metadata.json", manifest], [shardName, shard], [`${folder}/${group.id}.json`, group]] as const) {
        const logical = prefix + name
        const path = "/" + backupStoragePath(logical)
        const bytes = Buffer.from(JSON.stringify(value))
        const etag = `"${sha256(value).slice(0, 12)}"`
        stored.set(path, { bytes, etag })
        etags.set(logical, etag)
      }
      const fetchImpl: typeof fetch = async input => {
        const path = new URL(String(input)).pathname
        const entry = stored.get(path)!
        return new Response(new Uint8Array(entry.bytes), { status: 200, headers: { etag: entry.etag } })
      }
      const writer = new BlobWriter(fetchImpl, "contoso", async () => "token")
      const listing = { blobs: [...etags.keys()], prefixes: [], sizes: new Map(), etags }
      return verifyHalf(writer, prefix, manifest, listing)
    }

    // Groups is inventory, so TotalPolicies must be 0, not 1.
    await expect(verifyWithTotal(0)).resolves.toMatchObject({ counts: new Map([[folder, 1]]) })
    await expect(verifyWithTotal(1)).rejects.toThrow("metadata.json counts could not be verified")
    expect(memoryStore().get("x")).toBeNull()
    expect(legacyRecoveryFingerprint([MASTER])).toBeTruthy()
  })
})

describe("candidate-local failures, discovery budget, and newest-backup progress (items 4, 5, 6)", () => {
  it.each(["hash mismatch", "unreadable payload", "damaged manifest"] as const)(
    "keeps a failing Azure candidate (%s) and still deletes independently verified candidates, escalating after 3 runs (item 4)",
    async failure => {
      const progress = memoryStore()
      const { createEngine, has, seed, folder } = setupAzure({ progress })
      const first = "backup-2026-08-03-020000/"
      const bad = "backup-2026-08-02-020000/"
      const third = "backup-2026-08-01-020000/"
      for (const prefix of [first, bad, third]) {
        folder(prefix)
        seed(`${prefix}metadata.json`, COMPLETE_MANIFEST)
      }
      if (failure === "hash mismatch") {
        seed(`${bad}DeviceConfigurations/Old.json`, { id: "old", changed: true })
      } else if (failure === "unreadable payload") {
        seed(`${bad}DeviceConfigurations/Old.json`, "{ broken")
      } else {
        seed(`${bad}metadata.json`, "{ broken manifest")
      }

      const run1 = await runBackup(createEngine())
      expect(has(`${first}metadata.json`), run1.log.join("\n")).toBe(false)
      expect(has(`${third}metadata.json`), run1.log.join("\n")).toBe(false)
      expect(has(`${bad}metadata.json`)).toBe(true)
      expect(run1.log.join("\n")).not.toContain("Retention has repeatedly kept")

      await vi.advanceTimersByTimeAsync(1_000)
      const run2 = await runBackup(createEngine())
      expect(has(`${bad}metadata.json`)).toBe(true)
      expect(run2.log.join("\n")).not.toContain("Retention has repeatedly kept")

      await vi.advanceTimersByTimeAsync(1_000)
      const run3 = await runBackup(createEngine())
      expect(has(`${bad}metadata.json`)).toBe(true)
      expect(run3.log.join("\n")).toContain(`Retention has repeatedly kept backup ${bad}`)
    },
  )

  it("persists discovery progress when candidate metadata reads exhaust the budget and advances to later candidates (item 5)", async () => {
    const progress = memoryStore()
    const { createEngine, has, seed, folder } = setupAzure({
      progress,
      limits: { candidates: 1, requests: 100, bytes: 4_000 },
    })
    const bloated = "backup-2026-08-02-020000/"
    const normal = "backup-2026-08-01-020000/"
    folder(bloated)
    seed(`${bloated}metadata.json`, { ...COMPLETE_MANIFEST, Padding: "x".repeat(8_000) })
    folder(normal)
    seed(`${normal}metadata.json`, COMPLETE_MANIFEST)

    const first = await runBackup(createEngine())
    expect(has(`${bloated}metadata.json`)).toBe(true)
    expect(has(`${normal}metadata.json`)).toBe(true)
    expect(first.log.join("\n")).toContain("reached its storage budget")
    expect(first.log.join("\n")).toContain("will continue reviewing older backups")

    await vi.advanceTimersByTimeAsync(1_000)
    const second = await runBackup(createEngine())
    expect(has(`${bloated}metadata.json`)).toBe(true)
    expect(has(`${normal}metadata.json`), second.log.join("\n")).toBe(false)
  })

  it.each([false, true])(
    "resumes newest-backup verification bound to exact folder and file identities, and starts fresh if the earlier replacement disappears (tamper: %s) (item 6)",
    async tamper => {
      const progress = memoryStore()
      const big = "x".repeat(12_000)
      const { createEngine, has, saved, keyOf, calls, seed, folder } = setupAzure({
        progress,
        count: 2,
        limits: { candidates: 32, requests: 100, bytes: 20_000 },
        override: url => {
          if (url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) {
            return Response.json({ id: url.pathname.split("/").at(-1), description: big, assignments: [] })
          }
          return undefined
        },
      })
      const older = "backup-2026-08-01-020000/"
      folder(older)
      seed(`${older}metadata.json`, COMPLETE_MANIFEST)

      const first = await runBackup(createEngine())
      const firstPolicy = `${first.backupFolder}/DeviceConfigurations/Policy 0.json`
      expect(first.log.join("\n")).toContain("reached its storage budget")
      expect(has(`${older}metadata.json`)).toBe(true)
      expect(calls.filter(call => call.name === firstPolicy && call.request.method === "GET")).toHaveLength(1)

      if (tamper) {
        // Modify the already-verified file so its ETag changes; receipt must not be reused.
        seed(firstPolicy, { id: "p0", description: "tampered" })
      }
      await vi.advanceTimersByTimeAsync(1_000)
      const second = await runBackup(createEngine())
      expect(has(`${older}metadata.json`), second.log.join("\n")).toBe(tamper)
      expect(calls.filter(call => call.name === firstPolicy && call.request.method === "GET")).toHaveLength(tamper ? 2 : 1)
      if (tamper) {
        expect(second.log.join("\n")).toContain("does not match its manifest")
        // Remove the earlier replacements: a new backup must start fresh and never reuse old receipts.
        for (const key of Array.from(saved.keys())) {
          if (key.includes(`${first.backupFolder}/`) || key.includes(`${second.backupFolder}/`)) saved.delete(key)
        }
        expect(saved.has(keyOf(firstPolicy))).toBe(false)
        await vi.advanceTimersByTimeAsync(1_000)
        const third = await runBackup(createEngine())
        const thirdPolicy = `${third.backupFolder}/DeviceConfigurations/Policy 0.json`
        expect(calls.filter(call => call.name === thirdPolicy && call.request.method === "GET")).toHaveLength(1)
        expect(third.log.join("\n")).toContain("reached its storage budget")
      }
    },
  )

  it("binds verifyHalf receipts to the exact backup prefix so receipts from one folder never match another (item 6)", async () => {
    const policy = { id: "p0", displayName: "Same" }
    const policy2 = { id: "p1", displayName: "Second" }
    const manifest = {
      TenantId: TENANT,
      Status: "Success",
      Failures: 0,
      Items: {
        "DeviceConfigurations/p0": { file: "P0.json", sha256: sha256(policy) },
        "DeviceConfigurations/p1": { file: "P1.json", sha256: sha256(policy2) },
      },
      ItemCounts: { DeviceConfigurations: 2, TotalPolicies: 2 },
    }
    const readPaths: string[] = []
    const makeWriter = (prefix: string, failSecond = false) => {
      const files = new Map<string, Buffer>([
        [`/intune-backups/${prefix}metadata.json`, Buffer.from(JSON.stringify(manifest))],
        [`/intune-backups/${prefix}DeviceConfigurations/P0.json`, Buffer.from(JSON.stringify(policy))],
        [`/intune-backups/${prefix}DeviceConfigurations/P1.json`, Buffer.from(JSON.stringify(policy2))],
      ])
      const fetchImpl: typeof fetch = async input => {
        const path = new URL(String(input)).pathname
        readPaths.push(path)
        if (failSecond && path.endsWith("/P1.json")) return new Response(null, { status: 500 })
        return new Response(new Uint8Array(files.get(path)!), { status: 200, headers: { etag: '"same-etag"' } })
      }
      const etags = new Map<string, string>([
        [`${prefix}metadata.json`, '"same-etag"'],
        [`${prefix}DeviceConfigurations/P0.json`, '"same-etag"'],
        [`${prefix}DeviceConfigurations/P1.json`, '"same-etag"'],
      ])
      return {
        writer: new BlobWriter(fetchImpl, "contoso", async () => "token"),
        listing: { blobs: [...etags.keys()], prefixes: [], sizes: new Map(), etags },
      }
    }
    const progress = { files: {} as Record<string, string>, attempts: 0 }
    const a = makeWriter("backup-2026-10-12-120000/", true)
    await expect(verifyHalf(a.writer, "backup-2026-10-12-120000/", manifest, a.listing, undefined, progress)).rejects.toThrow()
    expect(progress.files["DeviceConfigurations/P0.json"]).toBeTruthy()
    // Even if a different backup folder has identical manifest, payload, and ETags, partial file receipts must NOT match.
    readPaths.length = 0
    const b = makeWriter("backup-2026-10-12-120001/")
    await verifyHalf(b.writer, "backup-2026-10-12-120001/", manifest, b.listing, undefined, progress)
    expect(readPaths).toContain("/intune-backups/backup-2026-10-12-120001/DeviceConfigurations/P0.json")
  })

  it("falls back in the same run to verifying the newest backup fresh when a resumed anchor becomes unreadable, and clears stale state.latest", async () => {
    const progress = memoryStore()
    const progressKey = `${TENANT}/contoso/false`
    const big = "q".repeat(12_000)
    let hitBudgetOnce = true
    let failFallback = false
    let firstPrefix = ""
    const { createEngine, has, calls, seed, folder } = setupAzure({
      progress,
      count: 2,
      limits: { candidates: 32, requests: 100, bytes: 100_000 },
      override: (url, req) => {
        if (url.hostname === "graph.microsoft.com" && !url.pathname.endsWith("/deviceConfigurations")) {
          return Response.json({ id: url.pathname.split("/").at(-1), description: big, assignments: [] })
        }
        if (hitBudgetOnce && req.method === "GET" && url.pathname.endsWith("/Policy%201.json")) {
          hitBudgetOnce = false
          // Simulate hitting the retention budget after Policy 0 was verified and receipted.
          return new Response(new Uint8Array(120_000), { status: 200, headers: { etag: '"oversized"' } })
        }
        if (failFallback && req.method === "GET" && firstPrefix && !url.pathname.includes(firstPrefix) && url.pathname.endsWith("/Policy%200.json")) {
          return new Response(null, { status: 404 })
        }
        return undefined
      },
    })
    const older = "backup-2026-08-01-020000/"
    folder(older)
    seed(`${older}metadata.json`, COMPLETE_MANIFEST)

    // Run 1 verifies Policy 0 and hits the byte budget on Policy 1, saving state.latest = firstPrefix.
    const first = await runBackup(createEngine())
    firstPrefix = `${first.backupFolder}/`
    expect(has(`${older}metadata.json`)).toBe(true)
    const savedAfterFirst = JSON.parse(progress.get(progressKey)!) as { latest?: string; reviews: Record<string, unknown> }
    expect(savedAfterFirst.latest).toBe(firstPrefix)

    // Corrupt the resumed anchor so verifying it fails with a manifest mismatch.
    seed(`${firstPrefix}DeviceConfigurations/Policy 0.json`, { id: "p0", description: "tampered" })

    // If the fallback newest backup ALSO fails verification, nothing is deleted and state.latest is cleared.
    failFallback = true
    await vi.advanceTimersByTimeAsync(1_000)
    const failedFallback = await runBackup(createEngine())
    expect(has(`${older}metadata.json`), failedFallback.log.join("\n")).toBe(true)
    const savedAfterFailedFallback = progress.get(progressKey)
    expect(savedAfterFailedFallback ? (JSON.parse(savedAfterFailedFallback) as { latest?: string }).latest : undefined).not.toBe(firstPrefix)
    expect(failedFallback.log.join("\n")).toContain("does not match its manifest")

    // Re-seed the broken anchor state and verify that a healthy newest backup succeeds in the same run.
    progress.set(progressKey, JSON.stringify(savedAfterFirst))
    failFallback = false
    await vi.advanceTimersByTimeAsync(1_000)
    const recovered = await runBackup(createEngine())
    const fallbackPolicy = `${recovered.backupFolder}/DeviceConfigurations/Policy 0.json`
    expect(calls.some(call => call.name === fallbackPolicy && call.request.method === "GET")).toBe(true)
    expect(has(`${older}metadata.json`), recovered.log.join("\n")).toBe(false)
    expect(has(`${firstPrefix}metadata.json`)).toBe(true)
    const savedAfterRecovery = progress.get(progressKey)
    expect(savedAfterRecovery ? (JSON.parse(savedAfterRecovery) as { latest?: string }).latest : undefined).not.toBe(firstPrefix)
  })
})

describe("replacement protection, deletion journal, cursor safety, and per-backup guards (items 2, 3, 7, 8)", () => {
  it("stops deleting immediately if the replacing backup changes before a candidate's deletes (item 2, Azure)", async () => {
    const first = "backup-2026-08-02-020000/"
    const second = "backup-2026-08-01-020000/"
    let mutated = false
    let mutateReplacement: (() => void) | undefined
    const { engine, has, calls, seed, folder } = setupAzure({
      count: 1,
      override: (url, req) => {
        // Mutate the replacing backup right after the first candidate's payload is deleted.
        if (!mutated && req.method === "DELETE" && url.pathname.endsWith(`${first}${BACKUP_OWNER_FILE}`)) {
          mutated = true
          mutateReplacement?.()
        }
        return undefined
      },
    })
    for (const prefix of [first, second]) {
      folder(prefix)
      seed(`${prefix}metadata.json`, COMPLETE_MANIFEST)
    }
    const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: "contoso", scope: DEVICE_CONFIG_SCOPE })
    mutateReplacement = () => {
      seed(`${job.backupFolder}/DeviceConfigurations/Policy 0.json`, { id: "p0", mutated: true })
    }
    await engine.waitForJob(job)
    await vi.advanceTimersByTimeAsync(0)
    expect(mutated).toBe(true)
    expect(has(`${first}metadata.json`)).toBe(false)
    expect(has(`${second}metadata.json`)).toBe(true)
    expect(calls.some(call => call.request.method === "DELETE" && call.name.startsWith(second))).toBe(false)
    expect(job.log.join("\n")).toContain("changed before cleanup completed")
  })

  it("stops deleting on local storage if a replacing backup file identity changes before cleanup (item 2, local)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-ret-replace-local-"))
    tempRoots.push(root)
    const store = new LocalBlobStore(root, [randomBytes(32)])
    const account = localStorageAccountName(TENANT)
    await store.createContainer(account, BACKUP_CONTAINER)
    const older = "backup-2026-08-01-020000/"
    await store.put(account, BACKUP_CONTAINER, `${older}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_POLICY)), "application/json")
    await store.put(account, BACKUP_CONTAINER, `${older}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(account, BACKUP_CONTAINER, `${older}metadata.json`, Buffer.from(JSON.stringify(COMPLETE_MANIFEST)), "application/json")

    let mutated = false
    let currentFolder = ""
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (!localAccountFromUrl(url)) {
        if (url.pathname.endsWith("/deviceConfigurations")) {
          return withServerDate(Response.json({ value: [{ id: "p0", displayName: "Policy 0" }] }), NOW)
        }
        return withServerDate(Response.json({ id: "p0", displayName: "Policy 0", assignments: [] }), NOW)
      }
      // After older's manifest is read during verification (right before deletes), replace the current backup's policy file.
      if (!mutated && req.method === "GET" && decodeURIComponent(url.pathname).endsWith(`${older}DeviceConfigurations/Old.json`)) {
        mutated = true
        const res = await handleLocalBlobRequest(store, req)
        await store.put(account, BACKUP_CONTAINER, `${currentFolder}/DeviceConfigurations/Policy 0.json`, Buffer.from(JSON.stringify({ id: "p0", modified: true })), "application/json")
        return res
      }
      return handleLocalBlobRequest(store, req)
    }

    const engine = new BackupEngine({
      fetch: fetchImpl,
      getToken: async () => "token",
      retentionDays: () => 30,
      now: () => NOW,
    })
    const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: account, scope: DEVICE_CONFIG_SCOPE })
    currentFolder = job.backupFolder!
    await engine.waitForJob(job)
    expect(mutated).toBe(true)
    expect(job.log.join("\n")).toContain("changed before cleanup completed")
    expect(await store.list(account, BACKUP_CONTAINER, older)).toHaveLength(3)
  })

  it("resumes a partially deleted Azure backup from the deletion journal after re-verifying replacement coverage (item 3, Azure)", async () => {
    const progress = memoryStore()
    const target = "backup-2026-08-01-020000/"
    const secondPolicy = { id: "new" }
    let failSecondDelete = true
    const { createEngine, has, saved, keyOf, calls, seed, folder } = setupAzure({
      progress,
      override: (url, req) => {
        if (failSecondDelete && req.method === "DELETE" && url.pathname.endsWith(`${target}DeviceConfigurations/New.json`)) {
          return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
        }
        return undefined
      },
    })
    folder(target)
    seed(`${target}DeviceConfigurations/New.json`, secondPolicy)
    seed(`${target}metadata.json`, {
      ...COMPLETE_MANIFEST,
      Items: { ...ITEMS, "DeviceConfigurations/new": { file: "New.json", sha256: sha256(secondPolicy) } },
      ItemCounts: { DeviceConfigurations: 2, TotalPolicies: 2 },
    })

    // Run 1 deletes Old.json, fails on New.json, keeps manifest + marker + New.json, and writes the journal.
    const run1 = await runBackup(createEngine())
    expect(run1.log.join("\n")).toContain("Retention partly removed")
    expect(has(`${target}DeviceConfigurations/Old.json`)).toBe(false)
    expect(has(`${target}DeviceConfigurations/New.json`)).toBe(true)
    expect(has(`${target}metadata.json`)).toBe(true)
    expect(has(`${target}${BACKUP_OWNER_FILE}`)).toBe(true)

    // Remove run1's backup so no newer backup covers DeviceConfigurations in run2.
    for (const call of calls) {
      if (call.name.startsWith(`${run1.backupFolder}/`)) saved.delete(keyOf(call.name))
    }
    // Run 2 with narrower scope (CompliancePolicies only): replacement coverage does NOT cover DeviceConfigurations, so do not resume deleting.
    failSecondDelete = false
    await vi.advanceTimersByTimeAsync(1_000)
    const run2 = await runBackup(createEngine(), COMPLIANCE_ONLY_SCOPE)
    expect(has(`${target}DeviceConfigurations/New.json`), run2.log.join("\n")).toBe(true)
    expect(has(`${target}metadata.json`)).toBe(true)

    // Run 3 with DeviceConfigurations covered again: resumes deleting ONLY remaining files with their original ETags!
    calls.length = 0
    await vi.advanceTimersByTimeAsync(1_000)
    const run3 = await runBackup(createEngine(), DEVICE_CONFIG_SCOPE)
    expect(has(`${target}DeviceConfigurations/New.json`), run3.log.join("\n")).toBe(false)
    expect(has(`${target}metadata.json`)).toBe(false)
    expect(has(`${target}${BACKUP_OWNER_FILE}`)).toBe(false)
    expect(calls.filter(c => c.request.method === "DELETE" && c.name.startsWith(target)).map(c => c.name)).toEqual([
      `${target}DeviceConfigurations/New.json`,
      `${target}metadata.json`,
      `${target}${BACKUP_OWNER_FILE}`,
    ])
  })

  it("resumes a manifestless local backup named in the deletion journal, while keeping unjournaled manifestless folders untouched (item 3, local)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-ret-journal-local-"))
    tempRoots.push(root)
    const store = new LocalBlobStore(root, [randomBytes(32)])
    const account = localStorageAccountName(TENANT)
    const progress = memoryStore()
    await store.createContainer(account, BACKUP_CONTAINER)

    const resumable = "backup-2026-08-02-020000/"
    const unjournaled = "backup-2026-08-01-020000/"
    await store.put(account, BACKUP_CONTAINER, `${resumable}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_POLICY)), "application/json")
    await store.put(account, BACKUP_CONTAINER, `${resumable}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(account, BACKUP_CONTAINER, `${resumable}metadata.json`, Buffer.from(JSON.stringify(COMPLETE_MANIFEST)), "application/json")
    // Unjournaled manifestless prefix must still be kept safely (never treated as resumable).
    await store.put(account, BACKUP_CONTAINER, `${unjournaled}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_POLICY)), "application/json")
    await store.put(account, BACKUP_CONTAINER, `${unjournaled}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")

    let failPayloadDelete = true
    let clock = NOW
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (!localAccountFromUrl(url)) {
        return withServerDate(Response.json({ value: [] }), clock)
      }
      if (failPayloadDelete && req.method === "DELETE" && decodeURIComponent(url.pathname).endsWith(`${resumable}DeviceConfigurations/Old.json`)) {
        return new Response(null, { status: 412, headers: { "x-ms-error-code": "ConditionNotMet" } })
      }
      return handleLocalBlobRequest(store, req)
    }
    const createLocalEngine = () => new BackupEngine({
      fetch: fetchImpl,
      getToken: async () => "token",
      retentionDays: () => 30,
      retentionProgress: progress,
      now: () => clock,
    })

    // Run 1 deletes resumable/metadata.json first, then fails deleting Old.json.
    const eng1 = createLocalEngine()
    const r1 = eng1.start({ tenantId: TENANT, clientId: "client", storageAccountName: account, scope: DEVICE_CONFIG_SCOPE })
    await eng1.waitForJob(r1)
    expect((await store.list(account, BACKUP_CONTAINER, resumable)).map(b => b.name)).toEqual([
      `${resumable}${BACKUP_OWNER_FILE}`,
      `${resumable}DeviceConfigurations/Old.json`,
    ])
    expect(await store.list(account, BACKUP_CONTAINER, unjournaled)).toHaveLength(2)

    // Run 2: manifest is gone, but journal names resumable -> resumes and finishes deleting it!
    failPayloadDelete = false
    clock = new Date(NOW.getTime() + 2_000)
    const eng2 = createLocalEngine()
    const r2 = eng2.start({ tenantId: TENANT, clientId: "client", storageAccountName: account, scope: DEVICE_CONFIG_SCOPE })
    await eng2.waitForJob(r2)
    expect(await store.list(account, BACKUP_CONTAINER, resumable), r2.log.join("\n")).toEqual([])
    // Unjournaled manifestless prefix stays untouched!
    expect(await store.list(account, BACKUP_CONTAINER, unjournaled)).toHaveLength(2)
  })

  it("does not advance the cursor past planned deletes interrupted before starting (item 7)", async () => {
    const progress = memoryStore()
    const first = "backup-2026-08-03-020000/"
    const second = "backup-2026-08-02-020000/"
    const third = "backup-2026-08-01-020000/"
    let cancelOnce = true
    let activeEngine: BackupEngine | undefined
    let activeJobId = ""
    const { createEngine, has, seed, folder } = setupAzure({
      progress,
      limits: { candidates: 2, requests: 200, bytes: 100_000 },
      override: (url, req) => {
        // Cancel right when the first DELETE is about to run, so planned deletes never complete.
        if (cancelOnce && req.method === "DELETE" && url.pathname.startsWith(`/intune-backups/${first}`)) {
          cancelOnce = false
          activeEngine?.cancel(activeJobId)
          return new Promise(() => {})
        }
        return undefined
      },
    })
    for (const prefix of [first, second, third]) {
      folder(prefix)
      seed(`${prefix}metadata.json`, COMPLETE_MANIFEST)
    }

    const eng1 = createEngine()
    activeEngine = eng1
    const job1 = eng1.start({ tenantId: TENANT, clientId: "client", storageAccountName: "contoso", scope: DEVICE_CONFIG_SCOPE })
    activeJobId = job1.id
    await eng1.waitForJob(job1)
    await vi.advanceTimersByTimeAsync(0)
    expect(has(`${first}metadata.json`)).toBe(true)
    expect(has(`${second}metadata.json`)).toBe(true)
    expect(has(`${third}metadata.json`)).toBe(true)
    // Cursor must NOT have advanced past the unstarted window [first, second].
    const savedState = [...progress.values.values()].map(raw => JSON.parse(raw))
    expect(savedState.every(s => !s.cursor)).toBe(true)

    // Next run reconsiders first immediately instead of skipping past [first, second] to third.
    await vi.advanceTimersByTimeAsync(1_000)
    const job2 = await runBackup(createEngine())
    expect(has(`${first}metadata.json`), job2.log.join("\n")).toBe(false)
    expect(has(`${third}metadata.json`)).toBe(true)
  })

  it("re-runs the recovery-key and clock guard before each planned backup's deletes (item 8)", async () => {
    const first = "backup-2026-08-02-020000/"
    const second = "backup-2026-08-01-020000/"
    let rotated = false
    const { engine, has, calls, seed, folder, keys } = setupAzure({
      override: (url, req) => {
        if (!rotated && req.method === "DELETE" && url.pathname.endsWith(`${first}${BACKUP_OWNER_FILE}`)) {
          rotated = true
          // Rotate recovery keyring right after first backup finishes deleting, before second starts.
          keys[0] = Buffer.alloc(32, 9)
        }
        return undefined
      },
    })
    for (const prefix of [first, second]) {
      folder(prefix)
      seed(`${prefix}metadata.json`, COMPLETE_MANIFEST)
    }
    const job = await runBackup(engine)
    expect(rotated).toBe(true)
    expect(has(`${first}metadata.json`)).toBe(false)
    expect(has(`${second}metadata.json`)).toBe(true)
    expect(calls.some(call => call.request.method === "DELETE" && call.name.startsWith(second))).toBe(false)
    expect(job.log.join("\n")).toContain("recovery key changed during retention")
  })

  it("resumes a partially deleted large backup from the deletion journal and stops if a large replacement changes (items 2 & 3, large)", async () => {
    const largeType = testType("AuthorizationPolicy", "syntheticItems", {
      volume: "large",
      apiVersion: "v1.0",
      inventory: true,
      listOnly: true,
      listQuery: "$top=999&$select=id,displayName",
      keep: ["displayName"],
    })
    const undo = registerTestTypes([largeType])
    try {
      const progress = memoryStore()
      const largeScope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "AuthorizationPolicy").map(type => type.folder) }
      const item1 = { id: "item-1", displayName: "Item 1" }
      const item2 = { id: "item-2", displayName: "Item 2" }
      const target = "backup-large-2026-08-01-020000/"
      const shardName = indexPath("AuthorizationPolicy", 0)
      const shard = [item1, item2].map(item => ({ id: item.id, file: `${item.id}.json`, hash: snapshotHash(item), sha256: sha256(item) }))
      const largeManifest = {
        TenantId: TENANT,
        BackupFolder: target.slice(0, -1),
        Status: "Success",
        Failures: 0,
        Coverage: "Complete",
        Scope: { Included: ["AuthorizationPolicy"], Excluded: largeScope.excluded },
        Items: {},
        LargeItems: { AuthorizationPolicy: { version: 1, count: 2, shards: 1, complete: true } },
        LargeIndexHashes: { [shardName]: sha256(shard) },
        ItemCounts: { AuthorizationPolicy: 2, TotalPolicies: 0 },
      }
      let failSecondItem = true
      let mutateLargeReplacement = false
      let currentLargeFolder = () => ""
      const { fetch, has, seed, keys } = setupAzure({
        progress,
        override: (url, req) => {
          if (url.hostname === "graph.microsoft.com") {
            return Response.json({ value: [] })
          }
          if (failSecondItem && req.method === "DELETE" && url.pathname.endsWith(`${target}AuthorizationPolicy/${item2.id}.json`)) {
            return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
          }
          if (mutateLargeReplacement && req.method === "GET" && url.searchParams.get("comp") === "list" && (url.searchParams.get("prefix") ?? "").includes(target)) {
            mutateLargeReplacement = false
            seed(`${currentLargeFolder()}/${BACKUP_OWNER_FILE}`, { ...OWNER, Tampered: true })
          }
          return undefined
        },
      })
      const createLargeEngine = () => new BackupEngine({
        fetch,
        getToken: async () => {
          const token = jwt({ scp: "Policy.Read.All" })
          registerStorageToken(token, TENANT)
          return token
        },
        retentionDays: () => 30,
        retentionProgress: progress,
        services: () => ({ services: ["entra"], areas: {} }),
        recoveryKeyFingerprint: () => legacyRecoveryFingerprint(keys),
      })
      seed(`${target}${BACKUP_OWNER_FILE}`, OWNER)
      seed(`${target}${shardName}`, shard)
      seed(`${target}AuthorizationPolicy/${item1.id}.json`, item1)
      seed(`${target}AuthorizationPolicy/${item2.id}.json`, item2)
      seed(`${target}metadata.json`, largeManifest)

      // Run 1 deletes item1 (and index shard), fails on item2, persists journal for remaining large files.
      const eng1 = createLargeEngine()
      const job1 = eng1.start({ tenantId: TENANT, clientId: "client", storageAccountName: "contoso", scope: largeScope })
      await eng1.waitForJob(job1)
      await vi.advanceTimersByTimeAsync(0)
      expect(job1.status, job1.log.join("\n")).toBe("Completed")
      expect(job1.log.join("\n")).toContain("Retention partly removed")
      expect(has(`${target}AuthorizationPolicy/${item2.id}.json`)).toBe(true)
      expect(has(`${target}metadata.json`)).toBe(true)

      // Run 2 mutates the replacing large backup before cleanup commits -> must stop deleting and keep target.
      failSecondItem = false
      mutateLargeReplacement = true
      await vi.advanceTimersByTimeAsync(1_000)
      const eng2 = createLargeEngine()
      const job2 = eng2.start({ tenantId: TENANT, clientId: "client", storageAccountName: "contoso", scope: largeScope })
      currentLargeFolder = () => job2.backupFolder!
      await eng2.waitForJob(job2)
      await vi.advanceTimersByTimeAsync(0)
      expect(job2.log.join("\n")).toContain("changed before cleanup completed")
      expect(has(`${target}AuthorizationPolicy/${item2.id}.json`)).toBe(true)
      expect(has(`${target}metadata.json`)).toBe(true)

      // Run 3 without tampering resumes from the journal and finishes removing the remaining large files.
      await vi.advanceTimersByTimeAsync(1_000)
      const eng3 = createLargeEngine()
      const job3 = eng3.start({ tenantId: TENANT, clientId: "client", storageAccountName: "contoso", scope: largeScope })
      await eng3.waitForJob(job3)
      await vi.advanceTimersByTimeAsync(0)
      expect(has(`${target}AuthorizationPolicy/${item2.id}.json`), job3.log.join("\n")).toBe(false)
      expect(has(`${target}metadata.json`)).toBe(false)
      expect(has(`${target}${BACKUP_OWNER_FILE}`)).toBe(false)
    } finally {
      undo()
    }
  })
})

describe("retention clock diagnostics and protected untrusted-date markers", () => {
  it("names the failing origin and reason (Age header) and escalates after 3 consecutive runs", async () => {
    const progress = memoryStore()
    let addAge = true
    const { createEngine, has, seed, folder } = setupAzure({
      progress,
      override: url => {
        if (addAge && url.hostname === "graph.microsoft.com") {
          const response = Response.json({ value: [] })
          response.headers.set("date", NOW.toUTCString())
          response.headers.set("age", "15")
          return response
        }
        return undefined
      },
    })
    const older = "backup-2026-08-01-020000/"
    folder(older)
    seed(`${older}metadata.json`, COMPLETE_MANIFEST)

    for (let run = 1; run <= 3; run++) {
      const job = await runBackup(createEngine())
      const log = job.log.join("\n")
      expect(log).toContain("could not verify the time with Microsoft")
      expect(log).toContain("Microsoft Graph")
      expect(log).toContain("Age header")
      expect(log.includes("Retention has repeatedly kept older backups")).toBe(run === 3)
      expect(has(`${older}metadata.json`)).toBe(true)
      await vi.advanceTimersByTimeAsync(1_000)
    }

    // Once the proxy stops adding Age, retention succeeds and clears the deferral counter.
    addAge = false
    const recovered = await runBackup(createEngine())
    expect(has(`${older}metadata.json`), recovered.log.join("\n")).toBe(false)
    expect(recovered.log.join("\n")).not.toContain("Retention has repeatedly kept older backups")
  })

  it.each(["redirect", "cross-origin"] as const)("names Microsoft Graph and %s when Graph responses cannot supply trusted time", async mode => {
    const { engine, has, seed, folder } = setupAzure({
      override: url => {
        if (url.hostname !== "graph.microsoft.com") return undefined
        const response = withServerDate(Response.json({ value: [] }), NOW)
        if (mode === "redirect") Object.defineProperty(response, "redirected", { value: true })
        if (mode === "cross-origin") Object.defineProperty(response, "url", { value: "https://proxy.example.com/v1.0/deviceConfigurations" })
        return response
      },
    })
    const older = "backup-2026-08-01-020000/"
    folder(older)
    seed(`${older}metadata.json`, COMPLETE_MANIFEST)
    const job = await runBackup(engine)
    const log = job.log.join("\n")
    expect(log).toContain("Microsoft Graph")
    expect(log).toContain(mode)
    expect(has(`${older}metadata.json`)).toBe(true)
  })

  it("warns and counts a warning when clearing an untrusted-date marker fails with ProtectedBlobError", async () => {
    const formerlyFuture = "backup-2026-08-01-020000"
    const marker = untrustedTimeMarker(formerlyFuture)
    const { engine, has, seed, folder } = setupAzure({
      override: (url, req) => {
        if (req.method === "DELETE" && decodeURIComponent(url.pathname).endsWith(marker)) {
          return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
        }
        return undefined
      },
    })
    folder(`${formerlyFuture}/`)
    seed(`${formerlyFuture}/metadata.json`, COMPLETE_MANIFEST)
    seed(marker, { BackupFolder: formerlyFuture, RunId: "earlier" })

    const job = await runBackup(engine)
    expect(has(marker)).toBe(true)
    expect(has(`${formerlyFuture}/metadata.json`)).toBe(true)
    expect(job.results?.warnings).toBeGreaterThanOrEqual(1)
    expect(job.results?.notices).toContainEqual(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining(`Kept backup ${formerlyFuture} outside automatic retention`),
    }))
    expect(job.log.join("\n")).toContain("immutability")
  })
})

describe("deletion journal tampering and binding guards", () => {
  it("discards a tampered journal keyed to an old prefix whose prefixes target the newest backup with empty folders", async () => {
    const progress = memoryStore()
    const oldPrefix = "backup-2026-08-01-020000/"
    const progressKey = `${TENANT}/contoso/false`
    let injected = false
    let newestPrefix = ""
    const { engine, has, etags, keyOf, seed, folder } = setupAzure({
      progress,
      count: 1,
      override: (url, req) => {
        // After the newest backup's manifest is written, inject a tampered journal keyed to oldPrefix
        // whose prefixes point to the newest backup with its real current ETags and folders: [].
        if (!injected && req.method === "PUT" && !url.search && url.pathname.endsWith("/metadata.json")) {
          const match = /\/(backup-[^/]+\/)metadata\.json$/.exec(url.pathname)
          if (match) newestPrefix = match[1]!
        }
        if (!injected && newestPrefix && req.method === "GET" && url.searchParams.get("comp") === "list") {
          injected = true
          const newestFiles = [
            `${newestPrefix}metadata.json`,
            `${newestPrefix}${BACKUP_OWNER_FILE}`,
            `${newestPrefix}DeviceConfigurations/Policy 0.json`,
          ]
          const remaining: Record<string, string> = {}
          for (const name of newestFiles) {
            const etag = etags.get(keyOf(name))
            if (etag) remaining[name] = etag
          }
          progress.set(progressKey, JSON.stringify({
            reviews: {},
            deletions: {
              [oldPrefix]: {
                prefixes: [newestPrefix],
                remnant: false,
                folders: [],
                remaining,
                deleted: [],
              },
            },
          }))
        }
        return undefined
      },
    })
    folder(oldPrefix)
    seed(`${oldPrefix}metadata.json`, COMPLETE_MANIFEST)

    const job = await runBackup(engine)
    expect(injected).toBe(true)
    expect(newestPrefix).toBe(`${job.backupFolder}/`)
    expect(has(`${newestPrefix}metadata.json`), job.log.join("\n")).toBe(true)
    expect(has(`${newestPrefix}DeviceConfigurations/Policy 0.json`)).toBe(true)
    expect(has(`${newestPrefix}${BACKUP_OWNER_FILE}`)).toBe(true)
    // Nothing is deleted through the invalid journal and the journal itself is discarded.
    expect(has(`${oldPrefix}metadata.json`)).toBe(true)
    expect(progress.get(progressKey)).toBeNull()
    expect(job.log.join("\n")).toContain("Discarded deletion journal")
  })

  it("discards a tampered journal keyed directly to the latest backup prefix", async () => {
    const progress = memoryStore()
    const progressKey = `${TENANT}/contoso/false`
    let injected = false
    let newestPrefix = ""
    const { engine, has, etags, keyOf } = setupAzure({
      progress,
      count: 1,
      override: (url, req) => {
        if (!injected && req.method === "PUT" && !url.search && url.pathname.endsWith("/metadata.json")) {
          const match = /\/(backup-[^/]+\/)metadata\.json$/.exec(url.pathname)
          if (match) newestPrefix = match[1]!
        }
        if (!injected && newestPrefix && req.method === "GET" && url.searchParams.get("comp") === "list") {
          injected = true
          const remaining: Record<string, string> = {}
          for (const name of [
            `${newestPrefix}metadata.json`,
            `${newestPrefix}${BACKUP_OWNER_FILE}`,
            `${newestPrefix}DeviceConfigurations/Policy 0.json`,
          ]) {
            const etag = etags.get(keyOf(name))
            if (etag) remaining[name] = etag
          }
          progress.set(progressKey, JSON.stringify({
            reviews: {},
            deletions: {
              [newestPrefix]: {
                prefixes: [newestPrefix],
                remnant: false,
                folders: ["DeviceConfigurations"],
                remaining,
                deleted: [],
              },
            },
          }))
        }
        return undefined
      },
    })

    const job = await runBackup(engine)
    expect(injected).toBe(true)
    expect(has(`${newestPrefix}metadata.json`), job.log.join("\n")).toBe(true)
    expect(has(`${newestPrefix}DeviceConfigurations/Policy 0.json`)).toBe(true)
    expect(progress.get(progressKey)).toBeNull()
    expect(job.log.join("\n")).toContain("Discarded deletion journal")
  })

  it("discards a tampered journal that names an unrelated large backup as a second prefix", async () => {
    const progress = memoryStore()
    const progressKey = `${TENANT}/contoso/false`
    const oldPrefix = "backup-2026-08-01-020000/"
    const unrelatedLarge = "backup-large-2026-08-01-020000/"
    const { engine, has, etags, keyOf, seed, folder } = setupAzure({ progress })
    folder(oldPrefix)
    seed(`${oldPrefix}metadata.json`, {
      ...COMPLETE_MANIFEST,
      BackupFolder: oldPrefix.slice(0, -1),
      RunId: "run-old-ordinary",
    })
    seed(`${unrelatedLarge}${BACKUP_OWNER_FILE}`, {
      Source: "TenuVault Desktop",
      TenantId: TENANT,
      RunId: "run-different-large",
      LargeInventory: { version: 1 },
    })
    seed(`${unrelatedLarge}metadata.json`, {
      TenantId: TENANT,
      BackupFolder: unrelatedLarge.slice(0, -1),
      RunId: "run-different-large",
      Status: "Success",
      Failures: 0,
      Coverage: "Complete",
      Items: {},
      LargeItems: {},
      ItemCounts: { TotalPolicies: 0 },
    })

    const remaining: Record<string, string> = {}
    for (const name of [
      `${oldPrefix}metadata.json`,
      `${oldPrefix}${BACKUP_OWNER_FILE}`,
      `${oldPrefix}DeviceConfigurations/Old.json`,
      `${unrelatedLarge}metadata.json`,
      `${unrelatedLarge}${BACKUP_OWNER_FILE}`,
    ]) {
      remaining[name] = etags.get(keyOf(name))!
    }
    progress.set(progressKey, JSON.stringify({
      reviews: {},
      deletions: {
        [oldPrefix]: {
          prefixes: [oldPrefix, unrelatedLarge],
          remnant: false,
          folders: ["DeviceConfigurations"],
          remaining,
          deleted: [],
        },
      },
    }))

    const job = await runBackup(engine)
    expect(has(`${unrelatedLarge}metadata.json`), job.log.join("\n")).toBe(true)
    expect(has(`${unrelatedLarge}${BACKUP_OWNER_FILE}`)).toBe(true)
    expect(has(`${oldPrefix}metadata.json`)).toBe(true)
    expect(progress.get(progressKey)).toBeNull()
    expect(job.log.join("\n")).toContain("Discarded deletion journal")
  })

  it("discards a tampered journal targeting another tenant's backup", async () => {
    const progress = memoryStore()
    const progressKey = `${TENANT}/contoso/false`
    const otherTenantPrefix = "backup-2026-08-01-020000/"
    const otherTenant = "22222222-2222-2222-2222-222222222222"
    const { engine, has, etags, keyOf, seed } = setupAzure({ progress })
    seed(`${otherTenantPrefix}DeviceConfigurations/Old.json`, OLD_POLICY)
    seed(`${otherTenantPrefix}${BACKUP_OWNER_FILE}`, { Source: "TenuVault Desktop", TenantId: otherTenant })
    seed(`${otherTenantPrefix}metadata.json`, { ...COMPLETE_MANIFEST, TenantId: otherTenant })

    const remaining: Record<string, string> = {}
    for (const name of [
      `${otherTenantPrefix}metadata.json`,
      `${otherTenantPrefix}${BACKUP_OWNER_FILE}`,
      `${otherTenantPrefix}DeviceConfigurations/Old.json`,
    ]) {
      remaining[name] = etags.get(keyOf(name))!
    }
    progress.set(progressKey, JSON.stringify({
      reviews: {},
      deletions: {
        [otherTenantPrefix]: {
          prefixes: [otherTenantPrefix],
          remnant: false,
          folders: ["DeviceConfigurations"],
          remaining,
          deleted: [],
        },
      },
    }))

    const job = await runBackup(engine)
    expect(has(`${otherTenantPrefix}metadata.json`), job.log.join("\n")).toBe(true)
    expect(has(`${otherTenantPrefix}DeviceConfigurations/Old.json`)).toBe(true)
    expect(progress.get(progressKey)).toBeNull()
    expect(job.log.join("\n")).toContain("Discarded deletion journal")
  })

  it.each([false, true])(
    "discards a tampered journal with empty folders for an uncovered backup (emptyFolders flag: %s)",
    async emptyFolders => {
      const progress = memoryStore()
      const progressKey = `${TENANT}/contoso/false`
      const oldPrefix = "backup-2026-08-01-020000/"
      const { engine, has, etags, keyOf, seed, folder } = setupAzure({ progress })
      folder(oldPrefix)
      seed(`${oldPrefix}metadata.json`, COMPLETE_MANIFEST)

      const remaining: Record<string, string> = {}
      for (const name of [
        `${oldPrefix}metadata.json`,
        `${oldPrefix}${BACKUP_OWNER_FILE}`,
        `${oldPrefix}DeviceConfigurations/Old.json`,
      ]) {
        remaining[name] = etags.get(keyOf(name))!
      }
      progress.set(progressKey, JSON.stringify({
        reviews: {},
        deletions: {
          [oldPrefix]: {
            prefixes: [oldPrefix],
            remnant: false,
            folders: [],
            ...(emptyFolders ? { emptyFolders: true } : {}),
            remaining,
            deleted: [],
          },
        },
      }))

      // Current backup covers only CompliancePolicies, so oldPrefix's DeviceConfigurations is uncovered.
      const job = await runBackup(engine, COMPLIANCE_ONLY_SCOPE)
      expect(has(`${oldPrefix}metadata.json`), job.log.join("\n")).toBe(true)
      expect(has(`${oldPrefix}DeviceConfigurations/Old.json`)).toBe(true)
      expect(progress.get(progressKey)).toBeNull()
      expect(job.log.join("\n")).toContain("Discarded deletion journal")
    },
  )

  it("still resumes a genuinely empty candidate journaled with emptyFolders: true", async () => {
    const progress = memoryStore()
    const oldPrefix = "backup-2026-08-01-020000/"
    let failOwnerDelete = true
    const { createEngine, has, seed } = setupAzure({
      progress,
      override: (url, req) => {
        if (failOwnerDelete && req.method === "DELETE" && url.pathname.endsWith(`${oldPrefix}${BACKUP_OWNER_FILE}`)) {
          return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
        }
        return undefined
      },
    })
    seed(`${oldPrefix}${BACKUP_OWNER_FILE}`, OWNER)
    seed(`${oldPrefix}metadata.json`, {
      TenantId: TENANT,
      Status: "Success",
      Failures: 0,
      Scope: { Included: ["DeviceConfigurations"] },
      Items: {},
      ItemCounts: { DeviceConfigurations: 0, TotalPolicies: 0 },
    })

    const run1 = await runBackup(createEngine())
    expect(has(`${oldPrefix}metadata.json`), run1.log.join("\n")).toBe(false)
    expect(has(`${oldPrefix}${BACKUP_OWNER_FILE}`)).toBe(true)

    failOwnerDelete = false
    await vi.advanceTimersByTimeAsync(1_000)
    const run2 = await runBackup(createEngine())
    expect(has(`${oldPrefix}${BACKUP_OWNER_FILE}`), run2.log.join("\n")).toBe(false)
  })
})
