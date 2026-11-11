import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { folderToOpen } from "../src/main/backup/local-inventory"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"
import { damageKinds, LocalBlobStore, type InventoryDamage } from "../src/main/storage/local-blob-store"
import { BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"
import { DAMAGE_KINDS_HEADER, damagedFileKindsFrom } from "../src/shared/damaged-files"

const TENANT = "11111111-1111-1111-1111-111111111111"
const account = localStorageAccountName(TENANT)
const CONTAINER = "intune-backups"
const FOLDER = "backup-2026-09-20-020000"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, account, CONTAINER, "locked.tvb"), 0o600) } catch { /* Only the os test locks a file. */ }
    rmSync(root, { recursive: true, force: true })
  }
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "tv-kinds-")); roots.push(root)
  const key = randomBytes(32)
  const store = new LocalBlobStore(root, [key])
  await store.createContainer(account, CONTAINER)
  return { root, key, store, dir: join(root, account, CONTAINER) }
}

async function backup(store: LocalBlobStore) {
  await store.put(account, CONTAINER, `${FOLDER}/CompliancePolicies/a.json`, Buffer.from('{"id":"a"}'), "application/json")
  await store.put(account, CONTAINER, `${FOLDER}/${BACKUP_OWNER_FILE}`, Buffer.from(`{"TenantId":"${TENANT}"}`), "application/json")
  await store.put(account, CONTAINER, `${FOLDER}/metadata.json`, Buffer.from(JSON.stringify({ Status: "Success", TenantId: TENANT, Items: { "CompliancePolicies/a": { file: "a.json" } } })), "application/json")
}

async function fileOf(store: LocalBlobStore, name: string): Promise<string> {
  const entries = await (store as unknown as { entries: (a: string, c: string) => Promise<Map<string, { file: string }>> }).entries(account, CONTAINER)
  return entries.get(name)!.file
}

const kindsOf = async (store: LocalBlobStore) => (await store.damage(account, CONTAINER)).files.map(({ kind, code }) => ({ kind, ...(code ? { code } : {}) }))

describe("kinds of damaged local backup files", () => {
  it("classifies a file no key on this device opens as key", async () => {
    const { root, key } = await setup()
    await new LocalBlobStore(root, [randomBytes(32)]).put(account, CONTAINER, `${FOLDER}/CompliancePolicies/a.json`, Buffer.from("{}"), "application/json")
    expect(await kindsOf(new LocalBlobStore(root, [key]))).toEqual([{ kind: "key" }])
  })

  it("classifies a file the file system refuses as os, with its error code", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const { dir, store } = await setup()
    writeFileSync(join(dir, "locked.tvb"), Buffer.concat([Buffer.from("TVB2"), randomBytes(80)]))
    chmodSync(join(dir, "locked.tvb"), 0o000)
    expect(await kindsOf(store)).toEqual([{ kind: "os", code: "EACCES" }])
  })

  it("classifies two files that hold the same backup item as duplicate", async () => {
    const { root, key, store } = await setup()
    await store.put(account, CONTAINER, `${FOLDER}/CompliancePolicies/a.json`, Buffer.from("{}"), "application/json")
    // A device with another key cannot see the first file, so it writes the same item to a file of its own.
    const second = randomBytes(32)
    await new LocalBlobStore(root, [second]).put(account, CONTAINER, `${FOLDER}/CompliancePolicies/a.json`, Buffer.from("{}"), "application/json")
    expect(await kindsOf(new LocalBlobStore(root, [key, second]))).toEqual([{ kind: "duplicate" }, { kind: "duplicate" }])
  })

  it("classifies a truncated or invalid file as damaged", async () => {
    const { dir, store } = await setup()
    writeFileSync(join(dir, `${"a".repeat(40)}.tvb`), Buffer.concat([Buffer.from("TVB2"), Buffer.from([0xff, 0xff]), randomBytes(20)]))
    writeFileSync(join(dir, `${"b".repeat(40)}.tvb`), Buffer.from("not a backup file at all"))
    expect(await kindsOf(store)).toEqual([{ kind: "damaged" }, { kind: "damaged" }])
  })

  it("keeps the kind of a damaged body on disk, and classifies records written before kinds were kept", async () => {
    const { root, key, store, dir } = await setup()
    await backup(store)
    const file = await fileOf(store, `${FOLDER}/CompliancePolicies/a.json`)
    const path = join(dir, file)
    const bytes = readFileSync(path)
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1)
    writeFileSync(path, bytes)
    const reader = new LocalBlobStore(root, [key])
    await reader.list(account, CONTAINER)
    await expect(reader.get(account, CONTAINER, `${FOLDER}/CompliancePolicies/a.json`)).rejects.toThrow("could not be read")
    const remembered = JSON.parse(readFileSync(join(dir, ".tenuvault-damaged.json"), "utf8")) as Record<string, { stamp: string; reason: string; kind?: string }>
    expect(remembered[file]).toMatchObject({ kind: "key", reason: "it is damaged, or was encrypted with a key this device does not have" })
    expect(await kindsOf(new LocalBlobStore(root, [key]))).toEqual([{ kind: "key" }])

    // An earlier version wrote only the stamp and the reason.
    for (const [reason, expected] of [
      ["it could not be read (EIO)", { kind: "os", code: "EIO" }],
      ["it is damaged, or was encrypted with a key this device does not have", { kind: "key" }],
      ["it is damaged or incomplete", { kind: "damaged" }],
    ] as const) {
      writeFileSync(join(dir, ".tenuvault-damaged.json"), JSON.stringify({ [file]: { stamp: remembered[file]!.stamp, reason } }))
      expect(await kindsOf(new LocalBlobStore(root, [key]))).toEqual([expected])
    }
  })

  it("shares the named files out between the kinds", () => {
    const damage: InventoryDamage = {
      files: [
        ...Array.from({ length: 12 }, (_, index) => ({ file: `${index.toString(16).padStart(40, "0")}.tvb`, reason: "", kind: "key" as const, backup: null })),
        { file: `${"e".repeat(40)}.tvb`, reason: "", kind: "os", code: "EACCES", backup: null },
        { file: `${"f".repeat(40)}.tvb`, reason: "", kind: "os", code: "EPERM", backup: null },
        { file: `${"d".repeat(40)}.tvb`, reason: "", kind: "os", code: "EACCES", backup: null },
      ],
      unavailable: new Map(),
      unattributed: 15,
    }
    const kinds = damageKinds(damage)
    expect(kinds.counts).toEqual({ key: 12, os: 3, duplicate: 0, damaged: 0 })
    expect(kinds.codes).toEqual(["EACCES", "EPERM"])
    expect(kinds.names.key).toHaveLength(7)
    expect(kinds.names.os).toHaveLength(3)
    expect(damageKinds({ files: [], unavailable: new Map(), unattributed: 0 }).names).toEqual({ key: [], os: [], duplicate: [], damaged: [] })
  })

  it("sends the kinds with the container properties, next to the existing headers", async () => {
    const { dir, store } = await setup()
    await backup(store)
    const bad = `${"c".repeat(40)}.tvb`
    writeFileSync(join(dir, bad), Buffer.from("not a backup file at all"))
    const response = await handleLocalBlobRequest(store, new Request(`https://${account}.blob.core.windows.net/${CONTAINER}?restype=container`, { method: "HEAD" }))
    expect(response.headers.get("x-tenuvault-unreadable-files")).toBe("1")
    expect(response.headers.get("x-tenuvault-unreadable-file-names")).toBe(bad)
    expect(damagedFileKindsFrom(JSON.parse(response.headers.get(DAMAGE_KINDS_HEADER)!))).toEqual({ counts: { key: 0, os: 0, duplicate: 0, damaged: 1 }, codes: [], names: { key: [], os: [], duplicate: [], damaged: [bad] } })
  })
})

describe("damage kinds from untrusted JSON", () => {
  it("drops names and codes that are not file names or error codes, and refuses other shapes", () => {
    expect(damagedFileKindsFrom({ counts: { key: 2 }, codes: ["EACCES", "rm -rf", "EACCES"], names: { key: ["ab12.tvb", "../x.tvb", 3] } }))
      .toEqual({ counts: { key: 2, os: 0, duplicate: 0, damaged: 0 }, codes: ["EACCES"], names: { key: ["ab12.tvb"], os: [], duplicate: [], damaged: [] } })
    expect(damagedFileKindsFrom(null)).toBeNull()
    expect(damagedFileKindsFrom([])).toBeNull()
    expect(damagedFileKindsFrom({ counts: { key: -1 }, codes: [], names: {} })).toBeNull()
    expect(damagedFileKindsFrom({ counts: { key: "2" }, codes: [], names: {} })).toBeNull()
    expect(damagedFileKindsFrom({ counts: {}, codes: "EACCES", names: {} })).toBeNull()
  })
})

describe("the folder Open backup folder shows", () => {
  it("is the tenant's backup folder when it exists, otherwise the root", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-open-")); roots.push(root)
    expect(await folderToOpen(root, undefined)).toBe(root)
    expect(await folderToOpen(root, null)).toBe(root)
    expect(await folderToOpen(root, TENANT)).toBe(root)
    mkdirSync(join(root, account, CONTAINER), { recursive: true })
    expect(await folderToOpen(root, TENANT)).toBe(join(root, account, CONTAINER))
    expect(await folderToOpen(root, TENANT.toUpperCase())).toBe(join(root, account, CONTAINER))
  })

  it("refuses anything but a tenant ID, so the folder never leaves the root", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-open-")); roots.push(root)
    for (const value of ["../..", "..", `${TENANT}/../..`, "/etc", "", 42, {}, ["x"]]) {
      await expect(folderToOpen(root, value)).rejects.toThrow("Unknown tenant.")
    }
  })
})
