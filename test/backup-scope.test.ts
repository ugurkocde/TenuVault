import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { BackupScopes } from "../src/main/backup/scopes"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { coveredFolders, DEFAULT_SCOPE, describeScope, EVERYTHING, includedTypes, LEGACY_FOLDERS, normalizeScope, presetOf } from "../src/shared/intune/scope"
import { compareBackups, summarize } from "../src/shared/intune/backup-changes"
import { comparableSnapshot, sameSnapshot } from "../src/shared/intune/compare"
import { memoryStore } from "./helpers"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"
const ALL = INTUNE_TYPES.map((type) => type.folder)

describe("backup scope", () => {
  it("keeps only known folders in registry order and names the presets", () => {
    expect(normalizeScope({ excluded: ["Apps", "Nope", "DeviceConfigurations", "Apps"] })).toEqual({ excluded: ["DeviceConfigurations", "Apps"] })
    expect(presetOf(EVERYTHING)).toBe("everything")
    expect(presetOf(DEFAULT_SCOPE)).toBe("policies")
    expect(DEFAULT_SCOPE.excluded).toEqual(["Apps"])
    expect(presetOf({ excluded: ["Branding"] })).toBe("custom")
    expect(describeScope({ excluded: ["Branding", "Apps"] })).toBe(`${ALL.length - 2} of ${ALL.length} types`)
    expect(includedTypes(DEFAULT_SCOPE).some((type) => type.folder === "Apps")).toBe(false)
  })

  it("treats backups without a scope as complete, minus types they could not read", () => {
    expect(coveredFolders({}).size).toBe(ALL.length)
    const covered = coveredFolders({ Scope: { Excluded: ["Apps"] }, SkippedTypes: ["PowerShellScripts"], FailedTypes: ["Branding"] })
    expect(["Apps", "PowerShellScripts", "Branding"].some((folder) => covered.has(folder))).toBe(false)
    expect(covered.size).toBe(ALL.length - 3)
  })

  it("counts only the types a backup recorded as attempted as covered", () => {
    const included = ALL.filter((folder) => folder !== "Branding")
    expect(coveredFolders({ Scope: { Excluded: [], Included: included } }).has("Branding")).toBe(false)
    // A type the older backup never attempted is not reported as added in the newer one.
    const older = { Scope: { Excluded: [], Included: included }, Items: { "DeviceConfigurations/1": { file: "A.json", hash: "a" } } }
    const newer = { Scope: { Excluded: [], Included: ALL }, Items: { "DeviceConfigurations/1": { file: "A.json", hash: "a" }, "Branding/1": { file: "B.json", hash: "b" } } }
    expect(summarize(compareBackups(older, newer))).toEqual({ added: 0, modified: 0, removed: 0 })
  })

  it("reads backups without a recorded list as covering only the types known before it was recorded", () => {
    expect(LEGACY_FOLDERS.every((folder) => ALL.includes(folder))).toBe(true)
    expect([...coveredFolders({ Scope: { Excluded: ["Apps"] } })].sort()).toEqual(LEGACY_FOLDERS.filter((folder) => folder !== "Apps").sort())
  })
})

describe("BackupScopes", () => {
  it("defaults to everything except apps, and keeps everything for tenants scheduled before scopes existed", () => {
    const store = memoryStore()
    const scopes = new BackupScopes(store)
    scopes.migrate(["AAAA-SCHEDULED"])
    expect(scopes.get("aaaa-scheduled")).toEqual({ scope: { excluded: [] }, saved: true })
    expect(scopes.get("new-tenant")).toEqual({ scope: { excluded: ["Apps"] }, saved: false })
    // Migration runs once: later schedules do not reset saved choices.
    scopes.set("aaaa-scheduled", { excluded: ["Branding"] })
    new BackupScopes(store).migrate(["AAAA-SCHEDULED"])
    expect(new BackupScopes(store).get("AAAA-SCHEDULED").scope).toEqual({ excluded: ["Branding"] })
  })
})

describe("snapshot comparison", () => {
  it("ignores timestamps, versions and annotations but not settings", () => {
    const a = { id: "1", displayName: "A", version: 3, lastModifiedDateTime: "x", "settings@odata.context": "c", settings: [{ id: "s", value: 1, createdDateTime: "y" }] }
    const b = { id: "1", displayName: "A", version: 4, lastModifiedDateTime: "z", settings: [{ id: "s", value: 1 }] }
    expect(sameSnapshot(a, b)).toBe(true)
    expect(sameSnapshot(a, { ...b, settings: [{ id: "s", value: 2 }] })).toBe(false)
    expect(JSON.stringify(comparableSnapshot({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}')
  })

  it("does not let a __proto__ key in a Graph payload replace the copy's prototype", () => {
    const copy = comparableSnapshot(JSON.parse('{"b":1,"__proto__":{"polluted":true},"a":{"__proto__":{"polluted":true},"c":2}}')) as Record<string, unknown>
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(copy.a)).toBe(Object.prototype)
    expect((copy as { polluted?: unknown }).polluted).toBeUndefined()
    expect(JSON.stringify(copy)).toBe('{"a":{"c":2},"b":1}')
  })

  it("compares only types both backups hold", () => {
    const older = { Items: { "Apps/1": { file: "A.json", hash: "x" }, "DeviceConfigurations/2": { file: "D.json", hash: "d1" }, "DeviceConfigurations/3": { file: "E.json", hash: "e" } } }
    const newer = { Scope: { Excluded: ["Apps"] }, Items: { "DeviceConfigurations/2": { file: "D.json", hash: "d2" }, "DeviceConfigurations/4": { file: "F.json", hash: "f" } } }
    const changes = compareBackups(older, newer)
    expect(summarize(changes)).toEqual({ added: 1, modified: 1, removed: 1 })
    expect(changes.find((change) => change.change === "modified")).toMatchObject({ folder: "DeviceConfigurations", id: "2", previousFile: "D.json" })
    expect(changes.some((change) => change.folder === "Apps")).toBe(false)
  })
})

function engineSetup(graph: (url: URL) => Response, options: { retentionDays?: number; now?: string } = {}) {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-scope-")), [randomBytes(32)])
  const account = localStorageAccountName(TENANT)
  const requested: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
    requested.push(decodeURIComponent(url.pathname + url.search))
    return graph(url)
  }) as typeof fetch
  const engine = new BackupEngine({
    fetch: fetchImpl,
    getToken: async () => "token",
    retentionDays: () => options.retentionDays ?? 0,
    now: options.now ? () => new Date(options.now!) : undefined,
    concurrency: 4,
  })
  return { engine, store, account, requested }
}

async function finished(engine: BackupEngine, id: string) {
  return engine.waitForJob(engine.get(id)!)
}

const listOf = (path: string, items: Array<Record<string, unknown>>) => ({ path: `/beta/${path}`, items })
function graphWith(...lists: Array<{ path: string; items: Array<Record<string, unknown>> }>) {
  return (url: URL) => {
    const list = lists.find((entry) => entry.path === url.pathname)
    if (list && !url.search) return Response.json({ value: list.items })
    if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
    const id = url.pathname.split("/").pop()
    return Response.json({ id, detail: true, lastModifiedDateTime: String(Math.random()) })
  }
}

describe("BackupEngine with a scope", () => {
  it("reads and writes only the chosen types, and records scope, trigger and item fingerprints", async () => {
    const { engine, store, account, requested } = engineSetup(
      graphWith(
        listOf("deviceManagement/deviceConfigurations", [{ id: "dc1", displayName: "Same" }, { id: "dc2", displayName: "Same" }, { id: "dc3", displayName: "Other" }]),
        listOf("deviceAppManagement/mobileApps", [{ id: "app1", displayName: "Reader" }]),
      ),
    )
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: { excluded: ["Apps"] }, trigger: "scheduled" }).id)
    expect(job.status).toBe("Completed")
    expect(requested.some((path) => path.includes("mobileApps"))).toBe(false)
    const names = (await store.list(account, "intune-backups")).map((blob) => blob.name.replace(/^backup-[\d-]+\//, "")).sort()
    // Names are chosen in list order, so parallel reads never swap which duplicate gets the suffix.
    expect(names).toEqual([".tenuvault-owner.json", "DeviceConfigurations/Other.json", "DeviceConfigurations/Same (dc2).json", "DeviceConfigurations/Same.json", "metadata.json"])
    const metadata = JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString())
    expect(metadata).toMatchObject({ Trigger: "scheduled", Scope: { Excluded: ["Apps"] }, FailedTypes: [] })
    expect(metadata.ItemCounts.Apps).toBeUndefined()
    expect(Object.keys(metadata.Items)).toEqual(["DeviceConfigurations/dc1", "DeviceConfigurations/dc2", "DeviceConfigurations/dc3"])
    expect(metadata.Items["DeviceConfigurations/dc2"].file).toBe("Same (dc2).json")
  })

  it("gives unchanged items the same fingerprint in every backup", async () => {
    const { engine, store, account } = engineSetup(graphWith(listOf("deviceManagement/deviceConfigurations", [{ id: "dc1", displayName: "A" }])))
    const first = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: { excluded: ["Apps"] } }).id)
    await new Promise((r) => setTimeout(r, 1100))
    const second = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: { excluded: ["Apps"] } }).id)
    const read = async (folder?: string) => JSON.parse((await store.get(account, "intune-backups", `${folder}/metadata.json`)).data.toString())
    expect(summarize(compareBackups(await read(first.backupFolder), await read(second.backupFolder)))).toEqual({ added: 0, modified: 0, removed: 0 })
  })

  it("keeps the newest backup of types a narrower backup leaves out, even past retention", async () => {
    const { engine, store, account } = engineSetup(graphWith(), { retentionDays: 30, now: "2026-09-24T12:00:00Z" })
    await store.createContainer(account, "intune-backups")
    const put = (name: string, body: unknown) => store.put(account, "intune-backups", name, Buffer.from(JSON.stringify(body)), "application/json")
    // Oldest: a full backup. Middle: also expired, but without apps. Both are past retention.
    await put("backup-2026-07-01-020000/metadata.json", { Status: "Success", Scope: { Excluded: [] } })
    await put("backup-2026-07-01-020000/Apps/Reader.json", {})
    await put("backup-2026-06-01-020000/metadata.json", { Status: "Success", Scope: { Excluded: [] } })
    await put("backup-2026-08-01-020000/metadata.json", { Status: "Success", Scope: { Excluded: ["Apps"] } })
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: { excluded: ["Apps"] } }).id)
    expect(job.status).toBe("Completed")
    const folders = new Set((await store.list(account, "intune-backups")).map((blob) => blob.name.split("/")[0]))
    // July holds the newest copy of apps, so it stays; June and August are removed.
    expect([...folders].sort()).toEqual(["backup-2026-07-01-020000", "backup-2026-09-24-120000"])
    expect(job.log.join("\n")).toContain("Kept 1 older backup because it holds the newest copy of types this backup leaves out.")
  })

  it("pauses every reader when Graph throttles one request", async () => {
    let throttledAt = 0
    const times: number[] = []
    const items = Array.from({ length: 12 }, (_, index) => ({ id: `dc${index}`, displayName: `P${index}` }))
    const { engine, account } = engineSetup((url) => {
      if (url.pathname === "/beta/deviceManagement/deviceConfigurations" && !url.search) return Response.json({ value: items })
      if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
      if (url.pathname.endsWith("/dc3") && !throttledAt) {
        throttledAt = Date.now()
        return new Response("", { status: 429, headers: { "retry-after": "0.3" } })
      }
      if (throttledAt) times.push(Date.now())
      return Response.json({ id: url.pathname.split("/").pop() })
    })
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: EVERYTHING }).id)
    expect(job.status).toBe("Completed")
    expect(times.length).toBeGreaterThan(0)
    expect(Math.min(...times) - throttledAt).toBeGreaterThanOrEqual(250)
  })

  it("stops once with the reason when Graph rejects the sign-in partway through", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ id: `dc${index}`, displayName: `P${index}` }))
    const { engine, account } = engineSetup((url) => {
      if (url.pathname === "/beta/deviceManagement/deviceConfigurations" && !url.search) return Response.json({ value: items })
      if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
      return Response.json({ error: { message: "Lifetime validation failed, the token is expired." } }, { status: 401 })
    })
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, scope: EVERYTHING }).id)
    expect(job.status).toBe("Failed")
    expect(job.exception).toMatch(/token is expired/)
    expect(job.log.filter((line) => line.includes("Could not back up"))).toHaveLength(0)
  })
})
