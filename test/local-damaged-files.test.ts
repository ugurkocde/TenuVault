import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { IncompleteInventoryError, LocalBlobStore } from "../src/main/storage/local-blob-store"
import { BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"
const account = localStorageAccountName(TENANT)
const CONTAINER = "intune-backups"
const OLD = "backup-2026-08-01-020000"
const NEW = "backup-2026-09-20-020000"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "tv-damaged-")); roots.push(root)
  const key = randomBytes(32)
  const store = new LocalBlobStore(root, [key])
  await store.createContainer(account, CONTAINER)
  return { root, key, store, dir: join(root, account, CONTAINER) }
}

/** A backup with a manifest that lists its two policy files, as the engine writes it. */
async function backup(store: LocalBlobStore, folder: string, manifest = true) {
  for (const id of ["a", "b"]) await store.put(account, CONTAINER, `${folder}/CompliancePolicies/${id}.json`, Buffer.from(`{"id":"${id}"}`), "application/json")
  await store.put(account, CONTAINER, `${folder}/${BACKUP_OWNER_FILE}`, Buffer.from(`{"TenantId":"${TENANT}"}`), "application/json")
  const metadata = manifest
    ? { Status: "Success", TenantId: TENANT, Items: { "CompliancePolicies/a": { file: "a.json" }, "CompliancePolicies/b": { file: "b.json" } } }
    : { Status: "Success" }
  await store.put(account, CONTAINER, `${folder}/metadata.json`, Buffer.from(JSON.stringify(metadata)), "application/json")
}

/** The encrypted file that holds a blob. */
async function fileOf(store: LocalBlobStore, name: string): Promise<string> {
  const entries = await (store as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(account, CONTAINER)
  return entries.get(name)!.file
}

/** Flips the last byte of a file (its body's authentication tag) or, with header, a header byte. Returns the original bytes. */
function damage(dir: string, file: string, header = false): Buffer {
  const path = join(dir, file)
  const original = readFileSync(path)
  const bytes = Buffer.from(original)
  const at = header ? 4 + 2 + 12 + 16 : bytes.length - 1
  bytes.writeUInt8(bytes.readUInt8(at) ^ 0xff, at)
  writeFileSync(path, bytes)
  return original
}

const text = async (store: LocalBlobStore, name: string) => (await store.get(account, CONTAINER, name)).data.toString()

describe("damaged local backup files", () => {
  it("keeps the healthy backups usable when a file of another backup is damaged", async () => {
    const { store, dir, root, key } = await setup()
    await backup(store, OLD)
    await backup(store, NEW)
    damage(dir, await fileOf(store, `${OLD}/CompliancePolicies/a.json`), true)

    const fresh = new LocalBlobStore(root, [key])
    // The healthy backup reads and lists as before.
    expect(await text(fresh, `${NEW}/CompliancePolicies/a.json`)).toBe('{"id":"a"}')
    expect((await fresh.list(account, CONTAINER, `${NEW}/`)).map((blob) => blob.name)).toHaveLength(4)
    // The damaged file is traced to its backup through the manifest: only that backup is unavailable.
    await expect(fresh.list(account, CONTAINER, `${OLD}/`)).rejects.toThrow(`Backup ${OLD} is unavailable: 1 file listed in its manifest is missing or damaged.`)
    await expect(fresh.get(account, CONTAINER, `${OLD}/CompliancePolicies/b.json`)).rejects.toBeInstanceOf(IncompleteInventoryError)
    const report = await fresh.damage(account, CONTAINER)
    expect(report.files).toMatchObject([{ reason: "it is damaged, or was encrypted with a key this device does not have", backup: OLD }])
    expect([...report.unavailable.keys()]).toEqual([OLD])
    expect(report.unattributed).toBe(0)
    // A listing of every backup still names both folders, so history can show the unavailable one.
    const folders = new Set((await fresh.list(account, CONTAINER)).map((blob) => blob.name.split("/")[0]))
    expect([...folders].sort()).toEqual([OLD, NEW])
  })

  it("traces a damaged manifest and a damaged ownership marker to their backup", async () => {
    for (const name of ["metadata.json", BACKUP_OWNER_FILE]) {
      const { store, dir, root, key } = await setup()
      await backup(store, OLD)
      await backup(store, NEW)
      damage(dir, await fileOf(store, `${OLD}/${name}`), true)
      const fresh = new LocalBlobStore(root, [key])
      expect((await fresh.damage(account, CONTAINER)).files).toMatchObject([{ backup: OLD }])
      await expect(fresh.list(account, CONTAINER, `${OLD}/`)).rejects.toBeInstanceOf(IncompleteInventoryError)
      expect(await text(fresh, `${NEW}/metadata.json`)).toContain('"Status":"Success"')
    }
  })

  it("keeps backups with a complete manifest usable next to a file that cannot be traced", async () => {
    const { store, dir, root, key } = await setup()
    await backup(store, NEW)
    await backup(store, OLD, false)
    // A file made with another installation's key cannot be traced to any backup.
    const foreign = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-foreign-")), [randomBytes(32)])
    await foreign.createContainer(account, CONTAINER)
    await foreign.put(account, CONTAINER, "backup-2026-07-01-020000/metadata.json", Buffer.from("{}"), "application/json")
    const [foreignFile] = readdirSync(join((foreign as unknown as { root: string }).root, account, CONTAINER))
    writeFileSync(join(dir, foreignFile!), readFileSync(join((foreign as unknown as { root: string }).root, account, CONTAINER, foreignFile!)))

    const fresh = new LocalBlobStore(root, [key])
    const report = await fresh.damage(account, CONTAINER)
    expect(report).toMatchObject({ unattributed: 1, files: [{ file: foreignFile, reason: "it is damaged, or was encrypted with a key this device does not have", backup: null }] })
    // The manifest proves the new backup complete; the older one without a manifest cannot be checked.
    expect(await text(fresh, `${NEW}/CompliancePolicies/b.json`)).toBe('{"id":"b"}')
    await expect(fresh.list(account, CONTAINER, `${OLD}/`)).rejects.toThrow("has no manifest")
    // A blob that is not listed may be in the unreadable file, so it is not reported as missing.
    await expect(fresh.get(account, CONTAINER, "backup-2026-07-01-020000/metadata.json")).rejects.toThrow("may be in one of them")
  })

  it("deletes nothing while any file is damaged, and again once the damage is resolved", async () => {
    const { store, dir } = await setup()
    await backup(store, OLD)
    await backup(store, NEW)
    const newFiles = await Promise.all(["metadata.json", BACKUP_OWNER_FILE, "CompliancePolicies/a.json", "CompliancePolicies/b.json"].map((name) => fileOf(store, `${NEW}/${name}`)))
    const damaged = newFiles[2]!
    damage(dir, damaged, true)
    // Retention lists the folder before it deletes; the listing finds the file damaged in place.
    await store.list(account, CONTAINER)
    await expect(store.delete(account, CONTAINER, `${OLD}/metadata.json`)).rejects.toThrow("Nothing in the backup folder is deleted until this is resolved")
    expect(readdirSync(dir)).toHaveLength(8)

    // The damaged file cannot be recovered and is removed: its backup now misses a manifest item,
    // so it stays unavailable and nothing is deleted yet.
    rmSync(join(dir, damaged))
    await expect(store.delete(account, CONTAINER, `${OLD}/metadata.json`)).rejects.toThrow("1 backup is unavailable")
    // Once the rest of that backup is removed as well, deleting works again.
    for (const file of newFiles) rmSync(join(dir, file), { force: true })
    await store.delete(account, CONTAINER, `${OLD}/metadata.json`)
    expect(readdirSync(dir)).toHaveLength(3)
  })

  it("notices a damaged file restored in place and makes its backup available again", async () => {
    const { store, dir } = await setup()
    await backup(store, OLD)
    await backup(store, NEW)
    const file = await fileOf(store, `${OLD}/CompliancePolicies/b.json`)
    const original = damage(dir, file, true)
    await expect(store.list(account, CONTAINER, `${OLD}/`)).rejects.toBeInstanceOf(IncompleteInventoryError)
    writeFileSync(join(dir, file), original)
    expect(await store.list(account, CONTAINER, `${OLD}/`)).toHaveLength(4)
    expect(await store.damage(account, CONTAINER)).toMatchObject({ files: [], unattributed: 0 })
    await store.delete(account, CONTAINER, `${OLD}/metadata.json`)
  })

  it("refuses a damaged body when it is read, with a refusal retrying cannot change", async () => {
    const { store, dir } = await setup()
    await backup(store, OLD)
    damage(dir, await fileOf(store, `${OLD}/CompliancePolicies/a.json`))
    const response = await handleLocalBlobRequest(store, new Request(`https://${account}.blob.core.windows.net/${CONTAINER}/${OLD}/CompliancePolicies/a.json`))
    expect(response.status).toBe(409)
    expect(await response.text()).toContain(`${OLD}/CompliancePolicies/a.json could not be read: it is damaged, or was encrypted with a key this device does not have.`)
    expect(await text(store, `${OLD}/CompliancePolicies/b.json`)).toBe('{"id":"b"}')
  })

  it("pauses retention with the reason in the backup log and still saves the new backup", async () => {
    const { store, dir } = await setup()
    await backup(store, OLD)
    await backup(store, NEW)
    damage(dir, await fileOf(store, `${NEW}/CompliancePolicies/a.json`), true)
    const graph = (url: URL) => Response.json(url.pathname.endsWith("/assignments") ? { value: [] } : { value: [] })
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      return localAccountFromUrl(url) ? handleLocalBlobRequest(store, request) : graph(url)
    }) as typeof fetch
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, now: () => new Date("2026-09-24T12:00:00Z") })
    const job = await engine.waitForJob(engine.get(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)!)
    expect(job.status).toBe("Completed")
    const log = job.log.join("\n")
    expect(log).toContain("Retention is paused. 1 file in the backup folder could not be read and 1 backup is unavailable. Nothing in the backup folder is deleted until this is resolved")
    expect(log).not.toContain("Removed")
    // The expired backup is still there, next to the one just written.
    const folders = new Set((await store.list(account, CONTAINER)).map((blob) => blob.name.split("/")[0]))
    expect([...folders].sort()).toEqual([OLD, NEW, "backup-2026-09-24-120000"])
  })
})

describe("backup history with damaged local files", () => {
  it("lists an unavailable backup with its reason next to the usable ones, in both list modes", async () => {
    const { store, dir } = await setup()
    await backup(store, OLD)
    await backup(store, NEW)
    damage(dir, await fileOf(store, `${OLD}/CompliancePolicies/a.json`), true)
    const { NextRequest } = await import("../src/main/api/next-server-shim")
    const { POST: listBackups } = await import("../src/portal/app/api/list-backups/route")
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "token" })
      if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
      throw new Error(`unexpected ${url}`)
    }))
    try {
      for (const summary of [false, true]) {
        const body = { tenantId: TENANT, appId: CLIENT, clientSecret: "x", storageAccountName: account, subscriptionId: "local", resourceGroupName: "local", summary }
        const response = await listBackups(new NextRequest("http://tenuvault.internal/api/list-backups", { method: "POST", body: JSON.stringify(body) }))
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.damagedFiles).toBe(1)
        const byId = Object.fromEntries(data.backups.map((entry: { id: string }) => [entry.id, entry]))
        expect(byId[NEW]).toMatchObject({ status: "Success", totalPolicies: 2 })
        expect(byId[OLD]).toMatchObject({ status: "unavailable" })
        expect(byId[OLD].error).toContain(`Backup ${OLD} is unavailable: 1 file listed in its manifest is missing or damaged.`)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
