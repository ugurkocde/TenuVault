import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as fileSystem from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { localInventoryProblem } from "../src/main/backup/local-inventory"
import { LocalBlobStore, type Version } from "../src/main/storage/local-blob-store"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open) }
})

const TENANT_A = "11111111-1111-1111-1111-111111111111"
const TENANT_B = "22222222-2222-2222-2222-222222222222"
const account = (tenant: string) => `tvlocal-${tenant}`
const CONTAINER = "intune-backups"

afterEach(() => {
  vi.mocked(fileSystem.open).mockClear()
})

/** Checks `tenant` through `store`, in the folder the store was created for. */
const inventoryProblem = (store: LocalBlobStore, tenant: string): Promise<string | null> => localInventoryProblem(store, (store as unknown as { root: string }).root, tenant)
const folder = () => mkdtempSync(join(tmpdir(), "tv-inventory-"))
const containerDir = (root: string, tenant = TENANT_A) => join(root, account(tenant), CONTAINER)
const files = (root: string, tenant = TENANT_A) => readdirSync(containerDir(root, tenant)).sort()

/** Writes backups for `tenant` into `root` with a store holding `keys`, and returns that store. */
async function backups(root: string, keys: Buffer[], tenant = TENANT_A, names = ["backup-1/policy-0.json", "backup-1/policy-1.json"], format?: Version) {
  const store = new LocalBlobStore(root, keys, format)
  await store.createContainer(account(tenant), CONTAINER)
  for (const name of names) await store.put(account(tenant), CONTAINER, name, Buffer.from("{}"), "application/json")
  return store
}

/**
 * Copies every backup file of `tenant` in `from` into the same tenant folder in `to`. A header
 * is bound to its file name, so a copied file stays as readable as it was.
 */
function copyFiles(from: string, to: string, tenant = TENANT_A) {
  mkdirSync(containerDir(to, tenant), { recursive: true })
  for (const file of files(from, tenant)) writeFileSync(join(containerDir(to, tenant), file), readFileSync(join(containerDir(from, tenant), file)))
}

/** Past magic, header length, IV and tag: the first byte of the header ciphertext. */
const HEADER = 4 + 2 + 12 + 16

/** Flips one byte of a file in place (by default the last, part of its body's authentication tag) and returns the original. */
function corrupt(path: string, offset?: number): Buffer {
  const original = readFileSync(path)
  const damaged = Buffer.from(original)
  const at = offset ?? damaged.length - 1
  damaged.writeUInt8(damaged.readUInt8(at) ^ 0xff, at)
  writeFileSync(path, damaged)
  return original
}

describe("localInventoryProblem", () => {
  it("reports nothing for readable backups, including ones made with an older key in the keyring", async () => {
    const root = folder()
    const older = randomBytes(32)
    const store = await backups(root, [older])
    expect(await inventoryProblem(store, TENANT_A)).toBeNull()
    expect(await inventoryProblem(new LocalBlobStore(root, [randomBytes(32), older]), TENANT_A)).toBeNull()
    // The tenant id is matched to its folder in any case.
    expect(await inventoryProblem(store, TENANT_A.toUpperCase())).toBeNull()
  })

  it("reports nothing for a missing or empty folder", async () => {
    const key = [randomBytes(32)]
    expect(await inventoryProblem(new LocalBlobStore(join(tmpdir(), `tv-missing-${randomBytes(4).toString("hex")}`), key), TENANT_A)).toBeNull()
    const empty = folder()
    expect(await inventoryProblem(new LocalBlobStore(empty, key), TENANT_A)).toBeNull()
    mkdirSync(containerDir(empty), { recursive: true })
    expect(await inventoryProblem(new LocalBlobStore(empty, key), TENANT_A)).toBeNull()
  })

  it("reports backups made with another installation's key, in either file format", async () => {
    for (const format of [1, 2] as const) {
      const root = folder()
      await backups(root, [randomBytes(32)], TENANT_A, undefined, format)
      const problem = await inventoryProblem(new LocalBlobStore(root, [randomBytes(32)]), TENANT_A)
      expect(problem).toContain("could not be read")
    }
  })

  it("reports one foreign file among many readable ones", async () => {
    const root = folder()
    const own = [randomBytes(32)]
    const store = await backups(root, own, TENANT_A, Array.from({ length: 30 }, (_, i) => `backup-1/policy-${i}.json`))
    const scratch = folder()
    await backups(scratch, [randomBytes(32)], TENANT_A, ["backup-1/foreign.json"])
    copyFiles(scratch, root)
    expect(files(root)).toHaveLength(31)
    expect(await inventoryProblem(store, TENANT_A)).toContain("1 encrypted file(s) could not be read")
  })

  it("reports a TVB1 and a TVB2 file for the same blob", async () => {
    const key = [randomBytes(32)]
    const root = folder()
    await backups(root, key, TENANT_A, ["backup-1/policy.json"], 1)
    const scratch = folder()
    await backups(scratch, key, TENANT_A, ["backup-1/policy.json"], 2)
    copyFiles(scratch, root)
    expect(files(root)).toHaveLength(2)
    expect(await inventoryProblem(new LocalBlobStore(root, key), TENANT_A)).toContain("could not be read")
  })

  it("reports a backup whose metadata.json body is damaged", async () => {
    const root = folder()
    const key = [randomBytes(32)]
    const store = await backups(root, key, TENANT_A, ["backup-1/metadata.json"])
    corrupt(join(containerDir(root), files(root)[0]!))
    expect(await inventoryProblem(new LocalBlobStore(root, key), TENANT_A)).toContain("key this device does not have")
    expect(await inventoryProblem(store, TENANT_A)).toContain("key this device does not have")
  })

  it("reports files listed in a backup's manifest that are missing", async () => {
    const root = folder()
    const store = new LocalBlobStore(root, [randomBytes(32)])
    await store.createContainer(account(TENANT_A), CONTAINER)
    const metadata = { Items: { "policies/one": { file: "one.json" } } }
    await store.put(account(TENANT_A), CONTAINER, "backup-1/policies/one.json", Buffer.from("{}"), "application/json")
    const [item] = files(root)
    await store.put(account(TENANT_A), CONTAINER, "backup-1/metadata.json", Buffer.from(JSON.stringify(metadata)), "application/json")
    expect(await inventoryProblem(store, TENANT_A)).toBeNull()
    rmSync(join(containerDir(root), item!))
    expect(await inventoryProblem(store, TENANT_A)).toContain("listed in the manifest are missing")
  })

  it("follows a file damaged and then restored in place under the same name", async () => {
    const root = folder()
    const key = [randomBytes(32)]
    const store = await backups(root, key, TENANT_A, ["backup-1/metadata.json", "backup-1/policy.json"])
    expect(await inventoryProblem(store, TENANT_A)).toBeNull()
    const path = join(containerDir(root), files(root)[0]!)
    // Damaged after a clean check: the cached inventory must not hide it.
    const original = corrupt(path, HEADER)
    expect(await inventoryProblem(store, TENANT_A)).toContain("could not be read")
    writeFileSync(path, original)
    expect(await inventoryProblem(store, TENANT_A)).toBeNull()
  })

  it("reports a blob overwritten with a newer key that this store does not have", async () => {
    const root = folder()
    const oldKey = randomBytes(32)
    const store = await backups(root, [oldKey])
    expect(await inventoryProblem(store, TENANT_A)).toBeNull()
    const before = files(root)
    // Another installation that imported the old key overwrites a blob; the file keeps its name.
    await backups(root, [randomBytes(32), oldKey], TENANT_A, ["backup-1/policy-0.json"])
    expect(files(root)).toEqual(before)
    expect(await inventoryProblem(store, TENANT_A)).toContain("could not be read")
  })

  it("checks only the given tenant", async () => {
    const root = folder()
    const own = [randomBytes(32)]
    const store = await backups(root, own, TENANT_A)
    await backups(root, [randomBytes(32)], TENANT_B)
    expect(await inventoryProblem(store, TENANT_A)).toBeNull()
    expect(await inventoryProblem(store, TENANT_B)).toContain("could not be read")
  })

  it("checks only the backup container", async () => {
    const root = folder()
    const own = [randomBytes(32)]
    const store = await backups(root, own)
    const other = new LocalBlobStore(root, [randomBytes(32)])
    await other.createContainer(account(TENANT_A), "audit-logs")
    await other.put(account(TENANT_A), "audit-logs", "record.json", Buffer.from("{}"), "application/json")
    expect(await inventoryProblem(store, TENANT_A)).toBeNull()
  })

  it("reads no file again while a readable folder is unchanged, and every file while it is unreadable", async () => {
    const root = folder()
    const own = [randomBytes(32)]
    const names = Array.from({ length: 20 }, (_, i) => `backup-1/policy-${i}.json`)
    await backups(root, own, TENANT_A, names)
    const store = new LocalBlobStore(root, own)
    expect(await inventoryProblem(store, TENANT_A)).toBeNull()
    vi.mocked(fileSystem.open).mockClear()
    expect(await inventoryProblem(store, TENANT_A)).toBeNull()
    expect(vi.mocked(fileSystem.open).mock.calls.length).toBe(0)

    const foreign = new LocalBlobStore(root, [randomBytes(32)])
    expect(await inventoryProblem(foreign, TENANT_A)).not.toBeNull()
    vi.mocked(fileSystem.open).mockClear()
    expect(await inventoryProblem(foreign, TENANT_A)).not.toBeNull()
    expect(vi.mocked(fileSystem.open).mock.calls.length).toBe(20)
  })

  it("reports no problem for a complete backup that retention prunes while it is checked", async () => {
    const root = folder()
    const key = randomBytes(32)
    const items = Array.from({ length: 12 }, (_, index) => `policy-${index}.json`)
    const store = await backups(root, [key], TENANT_A, items.map((file) => `backup-1/policies/${file}`))
    const manifest = { Items: Object.fromEntries(items.map((file) => [`policies/${file}`, { file }])) }
    await store.put(account(TENANT_A), CONTAINER, "backup-1/metadata.json", Buffer.from(JSON.stringify(manifest)), "application/json")
    const check = new LocalBlobStore(root, [key])
    expect(await inventoryProblem(check, TENANT_A)).toBeNull()
    // Retention removes the manifest first, then the items. A check starts before every deletion
    // through its own store, the way the warning can refresh while retention prunes.
    const checks: Promise<string | null>[] = []
    for (const name of ["backup-1/metadata.json", ...items.map((file) => `backup-1/policies/${file}`)]) {
      checks.push(inventoryProblem(check, TENANT_A))
      await store.delete(account(TENANT_A), CONTAINER, name)
    }
    expect(await Promise.all(checks)).toEqual(checks.map(() => null))
    expect(files(root)).toEqual([])
    expect(await inventoryProblem(check, TENANT_A)).toBeNull()
  }, 20_000)

  it("treats a file removed between listing and reading as removed, not unreadable", async () => {
    const root = folder()
    const key = [randomBytes(32)]
    await backups(root, key, TENANT_A, ["backup-1/policy-0.json", "backup-1/policy-1.json", "backup-1/policy-2.json"])
    const [gone] = files(root)
    const path = join(containerDir(root), gone!)
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    // Retention deletes the file after the folder was listed, before its header is opened.
    vi.mocked(fileSystem.open).mockImplementation(async (file, ...rest) => {
      if (file === path) rmSync(path, { force: true })
      return actual.open(file, ...rest)
    })
    try {
      const listed = await new LocalBlobStore(root, key).list(account(TENANT_A), CONTAINER)
      expect(listed).toHaveLength(2)
    } finally {
      vi.mocked(fileSystem.open).mockImplementation(actual.open)
    }
  })

  it("does not report a manifest removed between listing and reading", async () => {
    const root = folder()
    const key = [randomBytes(32)]
    const store = await backups(root, key, TENANT_A, ["backup-1/policies/one.json"])
    await store.put(account(TENANT_A), CONTAINER, "backup-1/metadata.json", Buffer.from(JSON.stringify({ Items: { "policies/one": { file: "one.json" } } })), "application/json")
    const check = new LocalBlobStore(root, key)
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    // Retention removes the manifest and its item once every header has been read.
    let opened = 0
    vi.mocked(fileSystem.open).mockImplementation(async (file, ...rest) => {
      const handle = await actual.open(file, ...rest)
      if (String(file).endsWith(".tvb") && ++opened === 2) for (const name of files(root)) rmSync(join(containerDir(root), name))
      return handle
    })
    try {
      // The second read of the folder finds it empty.
      expect(await check.list(account(TENANT_A), CONTAINER)).toEqual([])
    } finally {
      vi.mocked(fileSystem.open).mockImplementation(actual.open)
    }
  })

  it("does not report a failed read while the folder keeps changing", async () => {
    const root = folder()
    mkdirSync(containerDir(root), { recursive: true })
    let writes = 0
    const changing = { list: vi.fn(async () => {
      writeFileSync(join(containerDir(root), `write-${writes++}.tmp`), "")
      throw new Error("Backup inventory is incomplete: 1 encrypted file(s) could not be read.")
    }) }
    expect(await localInventoryProblem(changing, root, TENANT_A)).toBeNull()
    expect(changing.list).toHaveBeenCalledTimes(3)
  })

  it("returns the message of a failed read", async () => {
    const failing = { list: vi.fn().mockRejectedValue(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) }
    expect(await localInventoryProblem(failing, folder(), TENANT_A)).toBe("EACCES: permission denied")
    expect(failing.list).toHaveBeenCalledWith(account(TENANT_A), CONTAINER)
  })
})
