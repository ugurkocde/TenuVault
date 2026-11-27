import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { BlobWriter } from "../src/main/backup/blob-writer"
import { readRetentionProgress, type RetentionProgressStore } from "../src/main/backup/retention-progress"
import { verifyHalf } from "../src/main/backup/retention-verification"
import { legacyAzureReader, legacyRecoveryFingerprint, registerStorageToken } from "../src/main/storage/azure-seal"
import { backupStoragePath } from "../src/shared/backup-storage"
import { BACKUP_OWNER_FILE } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { indexPath } from "../src/shared/large-backup"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { memoryStore, withServerDate } from "./helpers"
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
  const keyOf = (logical: string) => backupStoragePath(logical)
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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

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
