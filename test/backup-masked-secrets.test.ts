import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BackupEngine, type RunTokens } from "../src/main/backup/engine"
import { backupGaps } from "../src/main/backup/completeness"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../src/shared/constants"
import { compareBackups, type BackupFingerprint } from "../src/shared/intune/backup-changes"
import { readObject, withMaskedSecrets } from "../src/shared/intune/read"
import { typeForFolder, INTUNE_TYPES, type Item } from "../src/shared/intune/registry"
import { coveredFolders, restorableFolders } from "../src/shared/intune/scope"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"
const ACCOUNT = localStorageAccountName(TENANT)
const CONTAINER = "intune-backups"
const deviceConfigurations = typeForFolder("DeviceConfigurations")!
const only = (...folders: string[]) => ({ excluded: INTUNE_TYPES.filter((type) => !folders.includes(type.folder)).map((type) => type.folder) })

const profile = () => ({
  id: "cfg1",
  displayName: "Wi-Fi",
  omaSettings: [{ omaUri: "./Vendor/MSFT/WiFi/Key", isEncrypted: true, secretReferenceValueId: "ref1", value: "****" }],
  assignments: [],
})

/** An engine on local storage whose Graph decrypts OMA-URI values only when `decrypt` is on. */
function setup(options: { decrypt?: boolean; retentionDays?: number; excludedTypes?: string[] } = {}) {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-masked-")), [randomBytes(32)])
  const graphPaths: string[] = []
  let decrypt = options.decrypt ?? false
  let clock = Date.parse("2026-10-26T02:00:00Z")
  const engine = new BackupEngine({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
      const path = decodeURIComponent(url.pathname)
      graphPaths.push(path)
      if (path === "/beta/deviceManagement/deviceConfigurations") return Response.json({ value: [{ id: "cfg1", displayName: "Wi-Fi" }] })
      if (path === "/beta/deviceManagement/deviceConfigurations/cfg1") return Response.json(profile())
      if (path.includes("getOmaSettingPlainTextValue")) {
        return decrypt
          ? Response.json({ value: "plain-key" })
          : Response.json({ error: { code: "Forbidden", message: "Application must have one of the following scopes: DeviceManagementConfiguration.ReadWrite.All" } }, { status: 403 })
      }
      if (path.startsWith("/beta/")) return Response.json({ value: [] })
      throw new Error(`unexpected ${url}`)
    }) as typeof fetch,
    getToken: async () => "admin",
    unattendedTokens: () => ({ mode: "app-only", graph: async () => "reader", storage: async () => "", excludedTypes: options.excludedTypes }) satisfies RunTokens,
    retentionDays: () => options.retentionDays ?? 0,
    // Every run gets its own backup folder.
    now: () => new Date((clock += 60_000)),
  })
  const run = async (trigger: "manual" | "scheduled", scope = only("DeviceConfigurations")) => {
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: ACCOUNT, scope, trigger }))
    const read = async (name: string) => JSON.parse((await store.get(ACCOUNT, CONTAINER, `${job.backupFolder}/${name}`)).data.toString())
    return { job, metadata: await read("metadata.json"), read }
  }
  return { store, run, graphPaths, setDecrypt: (value: boolean) => { decrypt = value }, setClock: (iso: string) => { clock = Date.parse(iso) } }
}

describe("masked OMA-URI values", () => {
  it("saves a Backup Reader backup with the value masked and records it as not restorable", async () => {
    const { run } = setup()
    const { job, metadata, read } = await run("scheduled")

    expect(job.status).toBe("Completed")
    expect(job.failures).toBe(0)
    expect(job.progressMessage).toBe("Backup completed with 1 warning")
    expect(job.log.join("\n")).toContain("Saved 1 object with encrypted OMA-URI values masked")
    expect(metadata.AuthMode).toBe("app-only")
    expect(metadata.MaskedSecretItems).toEqual([{ Folder: "DeviceConfigurations", Id: "cfg1", Name: "Wi-Fi" }])
    const item = metadata.Items["DeviceConfigurations/cfg1"]
    expect(item.secretsMasked).toBe(true)
    expect(item.hashWithMaskedSecrets).toBe(item.hash)
    const saved = await read(`DeviceConfigurations/${item.file}`)
    expect(saved.omaSettings[0].value).toBe("****")
    expect(deviceConfigurations.restorable?.(saved)).toMatch(/masked OMA-URI value/)
    // Covered for comparisons, but not a full copy for restore or retention.
    expect(coveredFolders(metadata).has("DeviceConfigurations")).toBe(true)
    expect(restorableFolders(metadata).has("DeviceConfigurations")).toBe(false)
    expect(backupGaps(metadata, ["DeviceConfigurations"])!.missing).toEqual([{ reason: "masked", folders: ["DeviceConfigurations"] }])
  })

  it("still fails the object when a backup with the admin's sign-in cannot decrypt a value", async () => {
    const { run } = setup()
    const { job, metadata } = await run("manual")

    expect(job.failures).toBe(1)
    expect(metadata.AuthMode).toBe("delegated")
    expect(metadata.MaskedSecretItems).toBeUndefined()
    expect(metadata.Items["DeviceConfigurations/cfg1"]).toBeUndefined()
  })

  it("records a masked fingerprint in admin backups, so a later masked copy is not reported as changed", async () => {
    const { run, setDecrypt } = setup({ decrypt: true })
    const plain = await run("manual")
    expect(plain.metadata.Items["DeviceConfigurations/cfg1"].secretsMasked).toBeUndefined()
    expect(plain.metadata.Items["DeviceConfigurations/cfg1"].hashWithMaskedSecrets).toBeDefined()
    expect((await plain.read(`DeviceConfigurations/${plain.metadata.Items["DeviceConfigurations/cfg1"].file}`)).omaSettings[0].value).toBe("plain-key")

    setDecrypt(false)
    const masked = await run("scheduled")
    expect(compareBackups(plain.metadata as BackupFingerprint, masked.metadata as BackupFingerprint)).toEqual([])
    expect(compareBackups(masked.metadata as BackupFingerprint, plain.metadata as BackupFingerprint)).toEqual([])
  })

  it("leaves out types the Backup Reader has no permission for, without asking Graph, and records why", async () => {
    const { run, graphPaths } = setup({ excludedTypes: ["DeviceCategories"] })
    const { job, metadata } = await run("scheduled", only("DeviceConfigurations", "DeviceCategories"))

    expect(graphPaths.some((path) => path.includes("deviceCategories"))).toBe(false)
    expect(metadata.AppOnlyExcludedTypes).toEqual(["DeviceCategories"])
    expect(metadata.Scope.Included).not.toContain("DeviceCategories")
    expect(coveredFolders(metadata).has("DeviceCategories")).toBe(false)
    expect(backupGaps(metadata, ["DeviceCategories"])!.missing).toEqual([{ reason: "reader", folders: ["DeviceCategories"] }])
    expect(job.log.join("\n")).toContain("Manual backups include them.")
  })

  it("keeps the newest backup with plain values when later backups hold them masked", async () => {
    const { store, run, setDecrypt, setClock } = setup({ decrypt: true, retentionDays: 30 })
    // A plain backup made long before the retention period.
    setClock("2026-08-01T02:00:00Z")
    const old = (await run("manual")).job.backupFolder!

    setClock("2026-10-26T02:00:00Z")
    setDecrypt(false)
    await run("scheduled")
    const folders = new Set((await store.list(ACCOUNT, CONTAINER)).map((blob) => blob.name.split("/")[0]))
    expect(folders.has(old)).toBe(true)

    // Once a backup holds the values in plain text again, the old one may go.
    setDecrypt(true)
    await run("manual")
    const after = new Set((await store.list(ACCOUNT, CONTAINER)).map((blob) => blob.name.split("/")[0]))
    expect(after.has(old)).toBe(false)
  })
})

describe("readObject keepMasked", () => {
  const reader = (failure: Response | null) => ({
    get: async (path: string): Promise<Item> => {
      if (path.includes("getOmaSettingPlainTextValue")) {
        if (failure) throw Object.assign(new Error("refused"), { status: failure.status })
        return { id: "", value: "plain-key" }
      }
      return profile() as Item
    },
    list: async () => [],
  })

  it("throws on a refused plain-text read unless the caller keeps masked values", async () => {
    await expect(readObject(deviceConfigurations, "cfg1", reader(new Response(null, { status: 403 })))).rejects.toThrow("refused")
    const kept = await readObject(deviceConfigurations, "cfg1", reader(new Response(null, { status: 403 })), { keepMasked: (error) => (error as { status?: number }).status === 403 })
    expect((kept.omaSettings as Item[])[0]!.value).toBe("****")
  })

  it("rethrows errors the caller does not keep masked", async () => {
    await expect(
      readObject(deviceConfigurations, "cfg1", reader(new Response(null, { status: 500 })), { keepMasked: (error) => (error as { status?: number }).status === 403 }),
    ).rejects.toThrow("refused")
  })

  it("masks every encrypted value for the fingerprint and leaves other types alone", async () => {
    const plain = await readObject(deviceConfigurations, "cfg1", reader(null))
    expect((plain.omaSettings as Item[])[0]!.value).toBe("plain-key")
    const masked = withMaskedSecrets(deviceConfigurations, plain)!
    expect((masked.omaSettings as Item[])[0]!.value).toBe("****")
    // The snapshot itself is not changed.
    expect((plain.omaSettings as Item[])[0]!.value).toBe("plain-key")
    expect(withMaskedSecrets(typeForFolder("ConfigurationPolicies")!, { id: "x" })).toBeNull()
  })
})
