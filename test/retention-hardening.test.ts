import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { BlobWriter } from "../src/main/backup/blob-writer"
import {
  MAX_FRESH_BINDING_LENGTH,
  MAX_FRESH_FILE_NAME_LENGTH,
  MAX_FRESH_FILES,
  MAX_FRESH_PREFIX_LENGTH,
  MAX_FRESH_RECEIPT_LENGTH,
  MAX_FRESH_REPLACEMENTS,
  readRetentionProgress,
  type RetentionProgressStore,
} from "../src/main/backup/retention-progress"
import { verifyHalf } from "../src/main/backup/retention-verification"
import { legacyAzureReader, legacyRecoveryFingerprint, registerStorageToken } from "../src/main/storage/azure-seal"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { BlobProtectedError, LocalBlobStore } from "../src/main/storage/local-blob-store"
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

  it("discards oversized fresh verification state while accepting valid fresh entries within caps", () => {
    const expired = "backup-2026-08-01-020000/"
    const withFresh = (fresh: Record<string, unknown>) => ({
      reviews: {},
      deletions: {
        [expired]: {
          prefixes: [expired],
          remnant: false,
          folders: ["DeviceConfigurations"],
          remaining: { [`${expired}metadata.json`]: '"etag-1"' },
          deleted: [],
          fresh,
        },
      },
    })
    const valid = withFresh({
      "backup-2026-10-12-120000/": {
        binding: "a".repeat(64),
        files: { "DeviceConfigurations/Policy.json": "b".repeat(64) },
        done: false,
      },
    })
    expect(readRetentionProgress(JSON.stringify(valid))).toEqual(valid)

    const tooManyReplacements = Object.fromEntries(
      Array.from({ length: MAX_FRESH_REPLACEMENTS + 1 }, (_, i) => [`backup-${i}/`, { binding: "ok", files: {} }]),
    )
    const tooManyFiles = Object.fromEntries(
      Array.from({ length: MAX_FRESH_FILES + 1 }, (_, i) => [`DeviceConfigurations/p${i}.json`, "r"]),
    )
    const oversized = [
      withFresh(tooManyReplacements),
      withFresh({ [`${"p".repeat(MAX_FRESH_PREFIX_LENGTH)}/`]: { binding: "ok", files: {} } }),
      withFresh({ "backup-1/": { binding: "b".repeat(MAX_FRESH_BINDING_LENGTH + 1), files: {} } }),
      withFresh({ "backup-1/": { binding: "ok", files: tooManyFiles } }),
      withFresh({ "backup-1/": { binding: "ok", files: { [`${"f".repeat(MAX_FRESH_FILE_NAME_LENGTH + 1)}`]: "r" } } }),
      withFresh({ "backup-1/": { binding: "ok", files: { "DeviceConfigurations/a.json": "r".repeat(MAX_FRESH_RECEIPT_LENGTH + 1) } } }),
      withFresh({ "backup-1/": { binding: "ok", files: { "DeviceConfigurations/a.json": "" } } }),
    ]
    for (const bad of oversized) {
      expect(readRetentionProgress(JSON.stringify(bad))).toEqual({ reviews: {} })
    }
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
      // Without tampering the anchor resumes from its receipt, but the newest backup must also
      // be payload-verified before any delete (4721701675) and that check cannot finish within
      // the remaining byte budget, so deletion is deferred this run.
      if (!tamper) expect(second.log.join("\n")).toContain("reached its storage budget")
      expect(has(`${older}metadata.json`), second.log.join("\n")).toBe(true)
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

  it("4721701675: deletes nothing when the newest backup fails payload verification while a resumed older backup is the anchor", async () => {
    const progress = memoryStore()
    const progressKey = `${TENANT}/contoso/false`
    const big = "s".repeat(12_000)
    let hitBudgetOnce = true
    let tamperNewest = false
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
          return new Response(new Uint8Array(120_000), { status: 200, headers: { etag: '"oversized"' } })
        }
        // The newest backup's payload cannot be read back (the resumed anchor's payloads can).
        if (tamperNewest && req.method === "GET" && firstPrefix && !url.pathname.includes(firstPrefix) && url.pathname.endsWith("/Policy%200.json")) {
          return new Response(null, { status: 404 })
        }
        return undefined
      },
    })
    const older = "backup-2026-08-01-020000/"
    folder(older)
    seed(`${older}metadata.json`, COMPLETE_MANIFEST)

    const first = await runBackup(createEngine())
    firstPrefix = `${first.backupFolder}/`
    const savedAfterFirst = JSON.parse(progress.get(progressKey)!) as { latest?: string }
    expect(savedAfterFirst.latest).toBe(firstPrefix)
    const anchorPolicyReads = () => calls.filter(call => call.name === `${firstPrefix}DeviceConfigurations/Policy 0.json` && call.request.method === "GET").length
    expect(anchorPolicyReads()).toBe(1)

    // B is the anchor and verifies from its receipt, but newest C fails payload verification.
    tamperNewest = true
    await vi.advanceTimersByTimeAsync(1_000)
    await runBackup(createEngine())
    expect(has(`${older}metadata.json`)).toBe(true)
    expect(anchorPolicyReads()).toBe(1)

    // With the newest backup healthy again, the next run deletes the expired candidate.
    progress.set(progressKey, JSON.stringify(savedAfterFirst))
    tamperNewest = false
    await vi.advanceTimersByTimeAsync(1_000)
    const third = await runBackup(createEngine())
    expect(has(`${older}metadata.json`), third.log.join("\n")).toBe(false)
    expect(anchorPolicyReads()).toBe(1)
  })

  it("P3: persists newest-backup receipts across runs from a resumed anchor, reuses them on anchor fallback, and starts fresh when the newest backup changes", async () => {
    const progress = memoryStore()
    const progressKey = `${TENANT}/contoso/false`
    const big = "p".repeat(12_000)
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

    // Run 1: backup B hits byte budget after Policy 0 -> B becomes the resumed anchor.
    const first = await runBackup(createEngine())
    const prefixB = `${first.backupFolder}/`

    // Run 2: backup C is created; B finishes Policy 1 (complete receipt saved for B), C verifies Policy 0 and hits budget on Policy 1.
    await vi.advanceTimersByTimeAsync(1_000)
    const second = await runBackup(createEngine())
    const folderC = second.backupFolder!
    const prefixC = `${folderC}/`
    expect(has(`${older}metadata.json`)).toBe(true)

    const afterPartialC = readRetentionProgress(progress.get(progressKey))
    expect(afterPartialC.latest).toBe(prefixB)
    expect(afterPartialC.newest).toBe(prefixC)
    expect(afterPartialC.reviews[prefixC]?.files["DeviceConfigurations/Policy 0.json"]).toBeTruthy()
    const cPolicy0Reads = () => calls.filter(c => c.name === `${prefixC}DeviceConfigurations/Policy 0.json` && c.request.method === "GET").length
    const readsAfterPartialC = cPolicy0Reads()
    expect(readsAfterPartialC).toBe(1)

    const invokeApplyRetention = async (currentFolder: string) => {
      const engine = createEngine()
      const written = JSON.parse(saved.get(keyOf(`${currentFolder}/metadata.json`))!.toString("utf8")) as Record<string, unknown>
      const writer = new BlobWriter((engine as unknown as { deps: { fetch: typeof fetch } }).deps.fetch, "contoso", async () => "token")
      const pending: Array<(beforeDelete: () => void) => Promise<number>> = []
      const job = { id: "test-job", tenantId: TENANT, storageAccountName: "contoso", status: "Running", log: [] as string[], results: { notices: [] as Array<{ level: string; message: string }> } }
      const controller = new AbortController()
      const keyFingerprint = (engine as unknown as { deps: { recoveryKeyFingerprint?: () => string } }).deps.recoveryKeyFingerprint?.()
      await (engine as unknown as {
        applyRetention: (...args: unknown[]) => Promise<number>
      }).applyRetention(job, writer, currentFolder, written, pending, controller.signal, NOW.getTime() + 5_000, keyFingerprint, { candidates: 32, requests: 100, bytes: 20_000 })
      for (const task of pending) await task(() => {})
    }

    // Subcase A: Run 3 with SAME C finishes via persisted receipts and cleans up state.newest.
    const snapshotAfterPartialC = progress.get(progressKey)!
    await invokeApplyRetention(folderC)
    expect(cPolicy0Reads()).toBe(readsAfterPartialC)
    expect(has(`${older}metadata.json`)).toBe(false)
    const afterCompleteC = readRetentionProgress(progress.get(progressKey))
    expect(afterCompleteC.newest).toBeUndefined()
    expect(afterCompleteC.reviews[prefixC]).toBeUndefined()

    // Subcase B: restore partial C progress, then a new backup D is written while C still exists ->
    // C continues via its persisted receipt (does not re-read Policy 0) and deletes older.
    folder(older)
    seed(`${older}metadata.json`, COMPLETE_MANIFEST)
    progress.set(progressKey, snapshotAfterPartialC)
    const cReadsBeforeD = cPolicy0Reads()
    await vi.advanceTimersByTimeAsync(1_000)
    await runBackup(createEngine())
    expect(cPolicy0Reads()).toBe(cReadsBeforeD)
    expect(has(`${older}metadata.json`)).toBe(false)

    // Subcase C: restore partial C progress and remove C from storage -> next run clears C's receipts and starts fresh on E.
    folder(older)
    seed(`${older}metadata.json`, COMPLETE_MANIFEST)
    for (const key of saved.keys()) if (key.includes(prefixC)) saved.delete(key)
    progress.set(progressKey, snapshotAfterPartialC)
    await vi.advanceTimersByTimeAsync(1_000)
    const fifth = await runBackup(createEngine())
    const prefixE = `${fifth.backupFolder}/`
    const afterMissingC = readRetentionProgress(progress.get(progressKey))
    expect(afterMissingC.reviews[prefixC]).toBeUndefined()
    expect(afterMissingC.newest).toBe(prefixE)
    expect(calls.filter(c => c.name === `${prefixE}DeviceConfigurations/Policy 0.json` && c.request.method === "GET")).toHaveLength(1)

    // Subcase D: resumed anchor B becomes unreadable while C has persisted newest receipts -> fallback to C reuses C's Policy 0 receipt.
    folder(older)
    seed(`${older}metadata.json`, COMPLETE_MANIFEST)
    seed(`${prefixC}metadata.json`, JSON.parse(saved.get(keyOf(`${prefixE}metadata.json`))!.toString("utf8")))
    // Restore C's original files by re-seeding snapshotAfterPartialC with C present in a fresh run:
    // Verify fallback path directly using prefixE which already has persisted Policy 0 receipt!
    const snapshotAfterPartialE = progress.get(progressKey)!
    const ePolicy0Reads = () => calls.filter(c => c.name === `${prefixE}DeviceConfigurations/Policy 0.json` && c.request.method === "GET").length
    const readsAfterPartialE = ePolicy0Reads()
    seed(`${prefixB}DeviceConfigurations/Policy 0.json`, { id: "p0", description: "tampered" })
    progress.set(progressKey, snapshotAfterPartialE)
    await invokeApplyRetention(fifth.backupFolder!)
    expect(ePolicy0Reads()).toBe(readsAfterPartialE)
    expect(has(`${older}metadata.json`)).toBe(false)
  })

  it("round 7 item 4: bounded newest-backup verification finishes and deletes expired backups across consecutive BackupEngine runs", async () => {
    const progress = memoryStore()
    const big = "b".repeat(12_000)
    const { createEngine, has, seed, folder } = setupAzure({
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

    // Every scheduled BackupEngine run writes a new backup folder (~24 KB > 20 KB byte budget).
    // Bounded verification must continue its in-progress committed newest backup and delete
    // older within a small, bounded number of consecutive BackupEngine runs.
    let deletedRun = 0
    for (let run = 1; run <= 6; run++) {
      await runBackup(createEngine())
      if (!has(`${older}metadata.json`)) {
        deletedRun = run
        break
      }
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(deletedRun).toBeGreaterThan(0)
    expect(deletedRun).toBeLessThanOrEqual(6)
    expect(has(`${older}metadata.json`)).toBe(false)
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

  it("gates orphan untagged deletion journals on shared-container ownership and resumes once unshared", async () => {
    const progress = memoryStore()
    const progressKey = `${TENANT}/contoso/false`
    const orphanPrefix = "backup-2026-08-01-020000/"
    const otherTenantPrefix = "backup-2026-08-02-020000/"
    const otherTenant = "22222222-2222-2222-2222-222222222222"
    const { createEngine, has, saved, etags, keyOf, seed } = setupAzure({
      progress,
      override: (url, req) => {
        // Omit orphanPrefix from delimiter discovery so it enters the orphan journal path.
        if (req.method === "GET" && url.searchParams.get("comp") === "list" && url.searchParams.get("delimiter") === "/") {
          const prefix = url.searchParams.get("prefix") ?? ""
          const container = url.pathname.split("/")[1] ?? ""
          const names = [...saved.keys()]
            .filter(stored => stored.startsWith(`${container}/`))
            .map(stored => stored.slice(container.length + 1))
            .filter(stored => stored.startsWith(prefix) && !stored.startsWith(orphanPrefix))
          const entries = [...new Set(names.map(stored => {
            const rest = stored.slice(prefix.length)
            const cut = rest.indexOf("/")
            return cut >= 0 ? prefix + rest.slice(0, cut + 1) : stored
          }))].map(stored => stored.endsWith("/")
            ? `<BlobPrefix><Name>${stored}</Name></BlobPrefix>`
            : `<Blob><Name>${stored}</Name><Properties><Etag>${etags.get(`${container}/${stored}`) ?? '"x"'}</Etag></Properties></Blob>`)
          return new Response(`<Blobs>${entries.join("")}</Blobs>`)
        }
        return undefined
      },
    })
    const untaggedManifest = {
      Status: "Success",
      Failures: 0,
      Items: ITEMS,
      ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 },
      Scope: { Included: ["DeviceConfigurations"] },
    }
    seed(`${orphanPrefix}DeviceConfigurations/Old.json`, OLD_POLICY)
    seed(`${orphanPrefix}metadata.json`, untaggedManifest)
    seed(`${otherTenantPrefix}DeviceConfigurations/Old.json`, OLD_POLICY)
    seed(`${otherTenantPrefix}${BACKUP_OWNER_FILE}`, { Source: "TenuVault Desktop", TenantId: otherTenant })
    seed(`${otherTenantPrefix}metadata.json`, { ...COMPLETE_MANIFEST, TenantId: otherTenant })

    const remaining: Record<string, string> = {
      [`${orphanPrefix}DeviceConfigurations/Old.json`]: etags.get(keyOf(`${orphanPrefix}DeviceConfigurations/Old.json`))!,
      [`${orphanPrefix}metadata.json`]: etags.get(keyOf(`${orphanPrefix}metadata.json`))!,
    }
    // An orphan journal falsely claiming untagged: false on an untagged folder is discarded.
    progress.set(progressKey, JSON.stringify({
      reviews: {},
      deletions: {
        [orphanPrefix]: {
          prefixes: [orphanPrefix],
          remnant: false,
          folders: ["DeviceConfigurations"],
          untagged: false,
          remaining,
          deleted: [],
        },
      },
    }))
    const spoofed = await runBackup(createEngine())
    expect(has(`${orphanPrefix}metadata.json`), spoofed.log.join("\n")).toBe(true)
    expect(has(`${orphanPrefix}DeviceConfigurations/Old.json`)).toBe(true)
    expect(spoofed.log.join("\n")).toContain("Discarded deletion journal")

    // A valid untagged orphan journal is kept while another tenant shares the container.
    progress.set(progressKey, JSON.stringify({
      reviews: {},
      deletions: {
        [orphanPrefix]: {
          prefixes: [orphanPrefix],
          remnant: false,
          folders: ["DeviceConfigurations"],
          untagged: true,
          remaining,
          deleted: [],
        },
      },
    }))
    await vi.advanceTimersByTimeAsync(1_000)
    const sharedRun = await runBackup(createEngine())
    expect(has(`${orphanPrefix}metadata.json`), sharedRun.log.join("\n")).toBe(true)
    expect(has(`${orphanPrefix}DeviceConfigurations/Old.json`)).toBe(true)
    expect(sharedRun.log.join("\n")).toContain("not recorded as this tenant's")

    // Once the container is no longer shared, the untagged orphan journal resumes and cleans up.
    for (const key of Array.from(saved.keys())) {
      if (key.includes(otherTenantPrefix)) saved.delete(key)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    const unsharedRun = await runBackup(createEngine())
    expect(has(`${orphanPrefix}metadata.json`), unsharedRun.log.join("\n")).toBe(false)
    expect(has(`${orphanPrefix}DeviceConfigurations/Old.json`)).toBe(false)
  })

  it("blocks resuming an untagged deletion journal when another tenant later appears in the container", async () => {
    const progress = memoryStore()
    const target = "backup-2026-08-01-020000/"
    const otherTenantPrefix = "backup-2026-08-02-020000/"
    const otherTenant = "22222222-2222-2222-2222-222222222222"
    const secondPolicy = { id: "new" }
    let failSecondDelete = true
    const { createEngine, has, saved, seed } = setupAzure({
      progress,
      override: (url, req) => {
        if (failSecondDelete && req.method === "DELETE" && url.pathname.endsWith(`${target}DeviceConfigurations/New.json`)) {
          return new Response(null, { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
        }
        return undefined
      },
    })
    seed(`${target}DeviceConfigurations/Old.json`, OLD_POLICY)
    seed(`${target}DeviceConfigurations/New.json`, secondPolicy)
    seed(`${target}metadata.json`, {
      Status: "Success",
      Failures: 0,
      Items: { ...ITEMS, "DeviceConfigurations/new": { file: "New.json", sha256: sha256(secondPolicy) } },
      ItemCounts: { DeviceConfigurations: 2, TotalPolicies: 2 },
      Scope: { Included: ["DeviceConfigurations"] },
    })

    // Run 1 partially removes the untagged backup and records untagged: true in its journal.
    const run1 = await runBackup(createEngine())
    expect(has(`${target}DeviceConfigurations/Old.json`), run1.log.join("\n")).toBe(false)
    expect(has(`${target}DeviceConfigurations/New.json`)).toBe(true)
    expect(has(`${target}metadata.json`)).toBe(true)

    // Another tenant's backup appears before Run 2, making the container shared.
    failSecondDelete = false
    seed(`${otherTenantPrefix}DeviceConfigurations/Old.json`, OLD_POLICY)
    seed(`${otherTenantPrefix}${BACKUP_OWNER_FILE}`, { Source: "TenuVault Desktop", TenantId: otherTenant })
    seed(`${otherTenantPrefix}metadata.json`, { ...COMPLETE_MANIFEST, TenantId: otherTenant })
    await vi.advanceTimersByTimeAsync(1_000)
    const run2 = await runBackup(createEngine())
    expect(has(`${target}DeviceConfigurations/New.json`), run2.log.join("\n")).toBe(true)
    expect(has(`${target}metadata.json`)).toBe(true)

    // Once the other tenant's backup is gone, Run 3 resumes and finishes cleanup.
    for (const key of Array.from(saved.keys())) {
      if (key.includes(otherTenantPrefix)) saved.delete(key)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    const run3 = await runBackup(createEngine())
    expect(has(`${target}DeviceConfigurations/New.json`), run3.log.join("\n")).toBe(false)
    expect(has(`${target}metadata.json`)).toBe(false)
  })

  it("handles missing journaled remaining files on Azure by recording them and freshly re-verifying replacement coverage (crash and external deletion)", async () => {
    const progressKey = `${TENANT}/contoso/false`
    const target = "backup-2026-08-01-020000/"
    const secondPolicy = { id: "new" }
    const twoManifest = {
      ...COMPLETE_MANIFEST,
      Items: { ...ITEMS, "DeviceConfigurations/new": { file: "New.json", sha256: sha256(secondPolicy) } },
      ItemCounts: { DeviceConfigurations: 2, TotalPolicies: 2 },
    }

    // (a) Crash after DELETE of Old.json before journal update, with healthy replacement:
    // logs absent file, runs fresh replacement verification (no receipts), and finishes deleting remaining files.
    {
      const progress = memoryStore()
      const { createEngine, has, calls, etags, keyOf, seed } = setupAzure({ progress, count: 1 })
      seed(`${target}DeviceConfigurations/New.json`, secondPolicy)
      seed(`${target}${BACKUP_OWNER_FILE}`, OWNER)
      seed(`${target}metadata.json`, twoManifest)
      progress.set(progressKey, JSON.stringify({
        reviews: {},
        deletions: {
          [target]: {
            prefixes: [target],
            remnant: false,
            folders: ["DeviceConfigurations"],
            untagged: false,
            remaining: {
              [`${target}DeviceConfigurations/Old.json`]: '"etag-old"',
              [`${target}DeviceConfigurations/New.json`]: etags.get(keyOf(`${target}DeviceConfigurations/New.json`))!,
              [`${target}metadata.json`]: etags.get(keyOf(`${target}metadata.json`))!,
              [`${target}${BACKUP_OWNER_FILE}`]: etags.get(keyOf(`${target}${BACKUP_OWNER_FILE}`))!,
            },
            deleted: [],
          },
        },
      }))
      const job = await runBackup(createEngine())
      const replacementPolicy = `${job.backupFolder}/DeviceConfigurations/Policy 0.json`
      expect(has(`${target}DeviceConfigurations/New.json`), job.log.join("\n")).toBe(false)
      expect(has(`${target}metadata.json`)).toBe(false)
      expect(job.log.join("\n")).toContain("DeviceConfigurations/Old.json")
      expect(job.log.join("\n")).toContain("already absent")
      expect(calls.filter(c => c.request.method === "GET" && c.name === replacementPolicy)).toHaveLength(2)
    }

    // (b) External deletion of Old.json when replacement is corrupted before resume:
    // fresh re-verification fails, keeping journal (with absent recorded) and remaining files with a warning.
    {
      const progress = memoryStore()
      let corrupted = false
      let newestPrefix = ""
      const { createEngine, has, calls, etags, keyOf, seed } = setupAzure({
        progress,
        count: 1,
        override: (url, req) => {
          if (req.method === "PUT" && !url.search && url.pathname.endsWith("/metadata.json")) {
            const match = /\/(backup-[^/]+\/)metadata\.json$/.exec(url.pathname)
            if (match) newestPrefix = match[1]!
          }
          if (!corrupted && newestPrefix && req.method === "GET" && url.searchParams.get("comp") === "list" && url.searchParams.get("prefix") === target) {
            corrupted = true
            seed(`${newestPrefix}DeviceConfigurations/Policy 0.json`, { id: "p0", tampered: true })
          }
          return undefined
        },
      })
      seed(`${target}DeviceConfigurations/New.json`, secondPolicy)
      seed(`${target}${BACKUP_OWNER_FILE}`, OWNER)
      seed(`${target}metadata.json`, twoManifest)
      progress.set(progressKey, JSON.stringify({
        reviews: {},
        deletions: {
          [target]: {
            prefixes: [target],
            remnant: false,
            folders: ["DeviceConfigurations"],
            untagged: false,
            remaining: {
              [`${target}DeviceConfigurations/Old.json`]: '"etag-old"',
              [`${target}DeviceConfigurations/New.json`]: etags.get(keyOf(`${target}DeviceConfigurations/New.json`))!,
              [`${target}metadata.json`]: etags.get(keyOf(`${target}metadata.json`))!,
              [`${target}${BACKUP_OWNER_FILE}`]: etags.get(keyOf(`${target}${BACKUP_OWNER_FILE}`))!,
            },
            deleted: [],
          },
        },
      }))
      const job = await runBackup(createEngine())
      expect(corrupted).toBe(true)
      expect(has(`${target}DeviceConfigurations/New.json`)).toBe(true)
      expect(has(`${target}metadata.json`)).toBe(true)
      expect(calls.filter(c => c.request.method === "DELETE")).toEqual([])
      expect(job.log.join("\n")).toContain("DeviceConfigurations/Old.json")
      expect(job.log.join("\n")).toContain("replacement coverage could not be freshly verified")
      expect(readRetentionProgress(progress.get(progressKey)).deletions?.[target]?.absent).toEqual([`${target}DeviceConfigurations/Old.json`])
    }
  })

  it("handles missing journaled remaining files on local storage (crash and external deletion)", async () => {
    const account = localStorageAccountName(TENANT)
    const progressKey = `${TENANT}/${account}/false`
    const target = "backup-2026-08-01-020000/"
    const secondPolicy = { id: "new" }
    const twoManifest = {
      ...COMPLETE_MANIFEST,
      Items: { ...ITEMS, "DeviceConfigurations/new": { file: "New.json", sha256: sha256(secondPolicy) } },
      ItemCounts: { DeviceConfigurations: 2, TotalPolicies: 2 },
    }
    const etagOf = (blob: { etag?: string; lastModified: Date }) => blob.etag ?? `"0x${blob.lastModified.getTime().toString(16).toUpperCase()}"`

    // (a) Crash after local manifest delete before journal update: freshly re-verifies replacement and cleans up.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-ret-missing-local-a-")); tempRoots.push(root)
      const store = new LocalBlobStore(root, [randomBytes(32)])
      const progress = memoryStore()
      await store.createContainer(account, BACKUP_CONTAINER)
      await store.put(account, BACKUP_CONTAINER, `${target}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_POLICY)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${target}DeviceConfigurations/New.json`, Buffer.from(JSON.stringify(secondPolicy)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${target}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${target}metadata.json`, Buffer.from(JSON.stringify(twoManifest)), "application/json")
      const blobs = await store.list(account, BACKUP_CONTAINER, target)
      const remaining = Object.fromEntries(blobs.map(b => [b.name, etagOf(b)]))
      await store.delete(account, BACKUP_CONTAINER, `${target}metadata.json`)
      progress.set(progressKey, JSON.stringify({
        reviews: {},
        deletions: {
          [target]: { prefixes: [target], remnant: false, folders: ["DeviceConfigurations"], untagged: false, remaining, deleted: [] },
        },
      }))
      const replacementReads: string[] = []
      const fetchImpl: typeof fetch = async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        if (!localAccountFromUrl(url)) return withServerDate(Response.json({ value: [] }), NOW)
        if (req.method === "GET" && !url.search) replacementReads.push(decodeURIComponent(url.pathname))
        return handleLocalBlobRequest(store, req)
      }
      const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, retentionProgress: progress, now: () => NOW })
      const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: account, scope: DEVICE_CONFIG_SCOPE }))
      expect(job.status).toBe("Completed")
      expect(await store.list(account, BACKUP_CONTAINER, target)).toEqual([])
      expect(job.log.join("\n")).toContain("metadata.json")
      expect(job.log.join("\n")).toContain("already absent")
      expect(replacementReads.filter(p => p.endsWith(`/${job.backupFolder}/metadata.json`)).length).toBeGreaterThanOrEqual(2)
    }

    // (b) External deletion on resumed manifestless local backup when type is uncovered: keeps journal with absent and keeps remaining files.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-ret-missing-local-b-")); tempRoots.push(root)
      const store = new LocalBlobStore(root, [randomBytes(32)])
      const progress = memoryStore()
      await store.createContainer(account, BACKUP_CONTAINER)
      await store.put(account, BACKUP_CONTAINER, `${target}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_POLICY)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${target}DeviceConfigurations/New.json`, Buffer.from(JSON.stringify(secondPolicy)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${target}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${target}metadata.json`, Buffer.from(JSON.stringify(twoManifest)), "application/json")
      await store.delete(account, BACKUP_CONTAINER, `${target}metadata.json`)
      const blobs = await store.list(account, BACKUP_CONTAINER, target)
      const remaining = Object.fromEntries(blobs.map(b => [b.name, etagOf(b)]))
      await store.delete(account, BACKUP_CONTAINER, `${target}DeviceConfigurations/Old.json`)
      progress.set(progressKey, JSON.stringify({
        reviews: {},
        deletions: {
          [target]: { prefixes: [target], remnant: false, folders: ["DeviceConfigurations"], untagged: false, remaining, deleted: [`${target}metadata.json`] },
        },
      }))
      const fetchImpl: typeof fetch = async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        if (!localAccountFromUrl(url)) return withServerDate(Response.json({ value: [] }), NOW)
        return handleLocalBlobRequest(store, req)
      }
      const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, retentionProgress: progress, now: () => NOW })
      const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: account, scope: COMPLIANCE_ONLY_SCOPE }))
      expect(job.status).toBe("Completed")
      const stillThere = (await store.list(account, BACKUP_CONTAINER, target)).map(b => b.name)
      expect(stillThere).toContain(`${target}DeviceConfigurations/New.json`)
      expect(stillThere).toContain(`${target}${BACKUP_OWNER_FILE}`)
      expect(job.log.join("\n")).toContain("DeviceConfigurations/Old.json")
      expect(readRetentionProgress(progress.get(progressKey)).deletions?.[target]?.absent).toEqual([`${target}DeviceConfigurations/Old.json`])
    }
  })

  it("protects Azure replacement blobs with finite 60s leases during candidate deletes, renews long leases, blocks concurrent writes, and releases all leases", async () => {
    const expired = "backup-2026-08-01-020000/"
    const activeLeases = new Map<string, string>()
    const acquiredDurations: number[] = []
    const renewed: string[] = []
    const released: string[] = []
    let rivalWriteStatus = 0
    let rivalTried = false
    let newestPrefix = ""

    const leaseHandler = (url: URL, req: Request): Response | Promise<Response> | undefined => {
      const container = url.pathname.split("/")[1] ?? ""
      const name = decodeURIComponent(url.pathname.slice(`/${container}/`.length))
      if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
        const action = req.headers.get("x-ms-lease-action")
        if (action === "acquire") {
          return req.text().then(body => {
            expect(body).toBe("")
            acquiredDurations.push(Number(req.headers.get("x-ms-lease-duration")))
            if (activeLeases.has(name)) return new Response(null, { status: 409, headers: { "x-ms-error-code": "LeaseAlreadyPresent" } })
            const id = req.headers.get("x-ms-proposed-lease-id") || `lease-${activeLeases.size + 1}`
            activeLeases.set(name, id)
            return new Response(null, { status: 201, headers: { "x-ms-lease-id": id } })
          })
        }
        const id = req.headers.get("x-ms-lease-id") ?? ""
        if (activeLeases.get(name) !== id) return new Response(null, { status: 412, headers: { "x-ms-error-code": "LeaseIdMismatchWithLeaseOperation" } })
        if (action === "renew") {
          renewed.push(name)
          return new Response(null, { status: 200, headers: { "x-ms-lease-id": id } })
        }
        if (action === "release") {
          activeLeases.delete(name)
          released.push(name)
          return new Response(null, { status: 200 })
        }
      }
      if ((req.method === "PUT" || req.method === "DELETE") && !url.search && activeLeases.has(name)) {
        if (req.headers.get("x-ms-lease-id") !== activeLeases.get(name)) {
          return new Response(null, { status: 412, headers: { "x-ms-error-code": "LeaseIdMissing" } })
        }
      }
      if (req.method === "PUT" && !url.search && url.pathname.endsWith("/metadata.json")) {
        const match = /\/(backup-[^/]+\/)metadata\.json$/.exec(url.pathname)
        if (match) newestPrefix = match[1]!
      }
      if (!rivalTried && req.method === "DELETE" && name.startsWith(expired)) {
        rivalTried = true
        const target = `${newestPrefix}DeviceConfigurations/Policy 0.json`
        const res = leaseHandler(
          new URL(`https://contoso.blob.core.windows.net/intune-backups/${target}`),
          new Request(`https://contoso.blob.core.windows.net/intune-backups/${target}`, { method: "PUT", body: '{"tampered":true}' }),
        )
        rivalWriteStatus = res instanceof Response ? res.status : 200
        return new Promise<Response>(resolve => setTimeout(() => {
          first.saved.delete(first.keyOf(name))
          resolve(new Response(null, { status: 202 }))
        }, 35_000))
      }
      return undefined
    }

    const first = setupAzure({ count: 1, override: leaseHandler })
    first.folder(expired)
    first.seed(`${expired}metadata.json`, COMPLETE_MANIFEST)
    const jobPromise = runBackup(first.engine)
    await vi.advanceTimersByTimeAsync(40_000)
    await jobPromise
    expect(rivalTried).toBe(true)
    expect(rivalWriteStatus).toBe(412)
    expect(acquiredDurations).toEqual([60, 60, 60])
    expect(renewed.length).toBeGreaterThanOrEqual(3)
    expect(released).toHaveLength(3)
    expect(activeLeases.size).toBe(0)
    expect(first.has(`${expired}metadata.json`)).toBe(false)

    // Lease acquisition failure (409 and 403): skips deletes, warns, and releases prior leases.
    for (const status of [409, 403]) {
      activeLeases.clear()
      released.length = 0
      let acquires = 0
      const failed = setupAzure({
        count: 1,
        override: (url, req) => {
          const container = url.pathname.split("/")[1] ?? ""
          const name = decodeURIComponent(url.pathname.slice(`/${container}/`.length))
          if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
            const action = req.headers.get("x-ms-lease-action")
            if (action === "acquire") {
              acquires++
              if (acquires === 2) return new Response(null, { status, headers: { "x-ms-error-code": status === 409 ? "LeaseAlreadyPresent" : "AuthorizationPermissionMismatch" } })
              const id = req.headers.get("x-ms-proposed-lease-id") || `lease-${acquires}`
              activeLeases.set(name, id)
              return new Response(null, { status: 201, headers: { "x-ms-lease-id": id } })
            }
            if (action === "release") {
              activeLeases.delete(name)
              released.push(name)
              return new Response(null, { status: 200 })
            }
          }
          return undefined
        },
      })
      failed.folder(expired)
      failed.seed(`${expired}metadata.json`, COMPLETE_MANIFEST)
      const job = await runBackup(failed.engine)
      expect(failed.has(`${expired}metadata.json`)).toBe(true)
      expect(failed.calls.filter(c => c.request.method === "DELETE")).toEqual([])
      expect(job.log.join("\n")).toContain("could not be leased")
      expect(released).toHaveLength(1)
      expect(activeLeases.size).toBe(0)
    }
  })

  it("holds a cross-process retention lock file on local storage and blocks in-process writes to replacement prefixes", async () => {
    const account = localStorageAccountName(TENANT)
    const older = "backup-2026-08-01-020000/"

    // 1. In-process write attempt to the replacement AFTER the final check and BEFORE the first DELETE
    // is refused by LocalBlobStore's in-process write guard; protection is released in finally.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-ret-perdel-local-")); tempRoots.push(root)
      const store = new LocalBlobStore(root, [randomBytes(32)])
      await store.createContainer(account, BACKUP_CONTAINER)
      await store.put(account, BACKUP_CONTAINER, `${older}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_POLICY)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${older}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${older}metadata.json`, Buffer.from(JSON.stringify(COMPLETE_MANIFEST)), "application/json")
      let attemptedBeforeFirstDelete = false
      let blockedError: unknown
      let attemptedDuringDelete = false
      let blockedDuringDeleteError: unknown
      let currentFolder = ""
      const deletes: string[] = []
      const fetchImpl: typeof fetch = async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        if (!localAccountFromUrl(url)) {
          if (url.pathname.endsWith("/deviceConfigurations")) {
            return withServerDate(Response.json({ value: [{ id: "p0", displayName: "Policy 0" }] }), NOW)
          }
          return withServerDate(Response.json({ id: "p0", displayName: "Policy 0", assignments: [] }), NOW)
        }
        if (req.method === "DELETE") {
          const path = decodeURIComponent(url.pathname)
          deletes.push(path)
          if (!attemptedBeforeFirstDelete && path.endsWith(`${older}metadata.json`)) {
            attemptedBeforeFirstDelete = true
            try {
              await store.put(account, BACKUP_CONTAINER, `${currentFolder}/DeviceConfigurations/Policy 0.json`, Buffer.from(JSON.stringify({ id: "p0", modified: true })), "application/json")
            } catch (error) {
              blockedError = error
            }
          }
          const res = await handleLocalBlobRequest(store, req)
          if (!attemptedDuringDelete && path.endsWith(`${older}metadata.json`)) {
            attemptedDuringDelete = true
            try {
              await store.delete(account, BACKUP_CONTAINER, `${currentFolder}/metadata.json`)
            } catch (error) {
              blockedDuringDeleteError = error
            }
          }
          return res
        }
        return handleLocalBlobRequest(store, req)
      }
      const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, now: () => NOW })
      const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: account, scope: DEVICE_CONFIG_SCOPE })
      currentFolder = job.backupFolder!
      await engine.waitForJob(job)
      expect(attemptedBeforeFirstDelete).toBe(true)
      expect(blockedError).toBeInstanceOf(BlobProtectedError)
      expect(attemptedDuringDelete).toBe(true)
      expect(blockedDuringDeleteError).toBeInstanceOf(BlobProtectedError)
      expect(deletes.length).toBe(3)
      // Replacement remained intact and older was safely deleted.
      const replacementPolicy = JSON.parse((await store.get(account, BACKUP_CONTAINER, `${currentFolder}/DeviceConfigurations/Policy 0.json`)).data.toString())
      expect(replacementPolicy.modified).toBeUndefined()
      expect(await store.list(account, BACKUP_CONTAINER, older)).toEqual([])
      // After cleanup completes, the in-process guard is released.
      await expect(store.put(account, BACKUP_CONTAINER, `${currentFolder}/post-cleanup.json`, Buffer.from("{}"), "application/json")).resolves.toBeDefined()
    }

    // 2. Cross-process retention lock file in container dir prevents concurrent retention, and releases on finish.
    {
      const root = mkdtempSync(join(tmpdir(), "tv-ret-lock-local-")); tempRoots.push(root)
      const keys = [randomBytes(32)]
      const store = new LocalBlobStore(root, keys)
      const other = new LocalBlobStore(root, keys)
      await store.createContainer(account, BACKUP_CONTAINER)
      await store.put(account, BACKUP_CONTAINER, `${older}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_POLICY)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${older}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
      await store.put(account, BACKUP_CONTAINER, `${older}metadata.json`, Buffer.from(JSON.stringify(COMPLETE_MANIFEST)), "application/json")
      const lockId = await other.acquireRetentionLock(account, BACKUP_CONTAINER)
      let clock = NOW
      const fetchImpl: typeof fetch = async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        if (!localAccountFromUrl(url)) return withServerDate(Response.json({ value: [] }), clock)
        return handleLocalBlobRequest(store, req)
      }
      const createEngine = () => new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, now: () => clock })
      const eng1 = createEngine()
      const blocked = await eng1.waitForJob(eng1.start({ tenantId: TENANT, clientId: "client", storageAccountName: account, scope: DEVICE_CONFIG_SCOPE }))
      expect(blocked.status).toBe("Completed")
      expect(blocked.log.join("\n")).toContain("local retention lock could not be acquired")
      expect(await store.list(account, BACKUP_CONTAINER, older)).toHaveLength(3)

      await other.releaseRetentionLock(account, BACKUP_CONTAINER, lockId)
      clock = new Date(NOW.getTime() + 5_000)
      const eng2 = createEngine()
      const unblocked = await eng2.waitForJob(eng2.start({ tenantId: TENANT, clientId: "client", storageAccountName: account, scope: DEVICE_CONFIG_SCOPE }))
      expect(unblocked.status).toBe("Completed")
      expect(await store.list(account, BACKUP_CONTAINER, older)).toEqual([])
      const reacquired = await other.acquireRetentionLock(account, BACKUP_CONTAINER)
      await other.releaseRetentionLock(account, BACKUP_CONTAINER, reacquired)
    }
  })
})
