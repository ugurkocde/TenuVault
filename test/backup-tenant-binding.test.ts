import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { ApiHost } from "../src/main/api/host"
import { NextRequest } from "../src/main/api/next-server-shim"
import { handleLocalBlobRequest, localAccountFromUrl, withRouteTenant } from "../src/main/storage/blob-emulator"
import { IncompleteInventoryError, LocalBlobStore, WRITE_FORMAT } from "../src/main/storage/local-blob-store"
import { POST as listBackups } from "../src/portal/app/api/list-backups/route"
import { localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER = "33333333-3333-3333-3333-333333333333"
const CLIENT = "22222222-2222-2222-2222-222222222222"
const ACCOUNT = localStorageAccountName(TENANT)
const CONTAINER = "intune-backups"

afterEach(() => vi.unstubAllGlobals())

/** Writes a file exactly as the released version 1 format did ("TVB1", container-only AADs and file-name HMAC). */
function writeV1(root: string, master: Buffer, account: string, container: string, name: string, data: string, contentType = "application/json") {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32))
  const encryption = derive("tenuvault-backup-encryption-v1")
  const naming = derive("tenuvault-backup-naming-v1")
  const seal = (plain: Buffer, aad: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", encryption, iv)
    cipher.setAAD(Buffer.from(aad))
    const body = Buffer.concat([cipher.update(plain), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), body])
  }
  const file = `${createHmac("sha256", naming).update(`${container}/${name}`).digest("hex").slice(0, 40)}.tvb`
  const header = seal(Buffer.from(JSON.stringify({ name, contentType, created: new Date("2026-09-01T00:00:00Z") })), `header:${container}`)
  const body = seal(Buffer.from(data), `${container}/${name}`)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(header.length)
  const dir = join(root, account, container)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), Buffer.concat([Buffer.from("TVB1"), length, header, body]))
  return file
}

/** Reads a blob with only the released version 1 rules, as earlier app versions do. */
function readV1(root: string, master: Buffer, account: string, container: string, name: string) {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32))
  const encryption = derive("tenuvault-backup-encryption-v1")
  const unseal = (sealed: Buffer, aad: string) => {
    const decipher = createDecipheriv("aes-256-gcm", encryption, sealed.subarray(0, 12))
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(sealed.subarray(12, 28))
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()])
  }
  const file = `${createHmac("sha256", derive("tenuvault-backup-naming-v1")).update(`${container}/${name}`).digest("hex").slice(0, 40)}.tvb`
  const raw = readFileSync(join(root, account, container, file))
  if (raw.subarray(0, 4).toString() !== "TVB1") throw new Error("Not a TVB1 file")
  const length = raw.readUInt16BE(4)
  const header = JSON.parse(unseal(raw.subarray(6, 6 + length), `header:${container}`).toString())
  return { file, header, data: unseal(raw.subarray(6 + length), `${container}/${name}`).toString() }
}

const text = async (store: LocalBlobStore, account: string, name: string) => (await store.get(account, CONTAINER, name)).data.toString()

describe("local store format compatibility", () => {
  it("lists and decrypts backups written in the released version 1 format", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-v1-"))
    const master = randomBytes(32)
    writeV1(root, master, ACCOUNT, CONTAINER, "backup-2026-09-01-020000/DeviceConfigurations/A.json", '{"id":"a"}')
    writeV1(root, master, ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json", JSON.stringify({ Status: "Success", Items: { "DeviceConfigurations/a": { file: "A.json", hash: "x" } } }))

    const store = new LocalBlobStore(root, [master])
    expect((await store.list(ACCOUNT, CONTAINER)).map((blob) => blob.name)).toEqual(["backup-2026-09-01-020000/DeviceConfigurations/A.json", "backup-2026-09-01-020000/metadata.json"])
    expect(await text(store, ACCOUNT, "backup-2026-09-01-020000/DeviceConfigurations/A.json")).toBe('{"id":"a"}')
    expect(JSON.parse(await text(store, ACCOUNT, "backup-2026-09-01-020000/metadata.json"))).toMatchObject({ Status: "Success" })
  })

  it("writes new files and overwrites in version 2 by default, keeping an overwritten version 1 file's name", async () => {
    expect(WRITE_FORMAT).toBe(2)
    const root = mkdtempSync(join(tmpdir(), "tv-v2-default-"))
    const master = randomBytes(32)
    const legacy = writeV1(root, master, ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json", '{"v":1}')
    const store = new LocalBlobStore(root, [master])
    await store.put(ACCOUNT, CONTAINER, "backup-2026-09-30-020000/metadata.json", Buffer.from('{"new":true}'), "application/json")
    await store.put(ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json", Buffer.from('{"v":"overwritten"}'), "application/json")

    const dir = join(root, ACCOUNT, CONTAINER)
    expect(readdirSync(dir).map((file) => readFileSync(join(dir, file)).subarray(0, 4).toString())).toEqual(["TVB2", "TVB2"])
    expect(readdirSync(dir)).toContain(legacy)
    const fresh = new LocalBlobStore(root, [master])
    expect(await text(fresh, ACCOUNT, "backup-2026-09-30-020000/metadata.json")).toBe('{"new":true}')
    expect(await text(fresh, ACCOUNT, "backup-2026-09-01-020000/metadata.json")).toBe('{"v":"overwritten"}')
  })

  it("still writes version 1 when asked, byte-compatible with the released version 1 format", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-v1-"))
    const master = randomBytes(32)
    const legacy = writeV1(root, master, ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json", '{"v":1}')
    const store = new LocalBlobStore(root, [master], 1)
    await store.put(ACCOUNT, CONTAINER, "backup-2026-09-30-020000/metadata.json", Buffer.from('{"new":true}'), "application/json")
    await store.put(ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json", Buffer.from('{"v":"overwritten"}'), "application/json")

    const dir = join(root, ACCOUNT, CONTAINER)
    expect(readdirSync(dir).map((file) => readFileSync(join(dir, file)).subarray(0, 4).toString())).toEqual(["TVB1", "TVB1"])
    const created = readV1(root, master, ACCOUNT, CONTAINER, "backup-2026-09-30-020000/metadata.json")
    expect(created).toMatchObject({ data: '{"new":true}', header: { name: "backup-2026-09-30-020000/metadata.json", contentType: "application/json" } })
    const overwritten = readV1(root, master, ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json")
    expect(overwritten).toMatchObject({ file: legacy, data: '{"v":"overwritten"}' })
    expect(readdirSync(dir).sort()).toEqual([created.file, legacy].sort())
  })

  it("lists a mixed container of version 1 files (older master key included) and version 2 files", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-v1-"))
    const old = randomBytes(32)
    writeV1(root, old, ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json", '{"old":true}')
    const current = randomBytes(32)
    await new LocalBlobStore(root, [current, old], 1).put(ACCOUNT, CONTAINER, "backup-2026-09-15-020000/metadata.json", Buffer.from('{"v1":true}'), "application/json")
    await new LocalBlobStore(root, [current, old]).put(ACCOUNT, CONTAINER, "backup-2026-09-30-020000/metadata.json", Buffer.from('{"new":true}'), "application/json")

    const files = readdirSync(join(root, ACCOUNT, CONTAINER)).map((file) => readFileSync(join(root, ACCOUNT, CONTAINER, file)).subarray(0, 4).toString())
    expect(files.sort()).toEqual(["TVB1", "TVB1", "TVB2"])
    const store = new LocalBlobStore(root, [current, old])
    expect((await store.list(ACCOUNT, CONTAINER)).map((blob) => blob.name)).toEqual([
      "backup-2026-09-01-020000/metadata.json",
      "backup-2026-09-15-020000/metadata.json",
      "backup-2026-09-30-020000/metadata.json",
    ])
    expect(await text(store, ACCOUNT, "backup-2026-09-01-020000/metadata.json")).toBe('{"old":true}')
    expect(await text(store, ACCOUNT, "backup-2026-09-15-020000/metadata.json")).toBe('{"v1":true}')
    expect(await text(store, ACCOUNT, "backup-2026-09-30-020000/metadata.json")).toBe('{"new":true}')
  })

  it("with format 2, rewrites an overwritten version 1 file as version 2 under the same file name", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-v1-"))
    const master = randomBytes(32)
    const file = writeV1(root, master, ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json", '{"v":1}')
    const store = new LocalBlobStore(root, [master], 2)
    await store.put(ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json", Buffer.from('{"v":2}'), "application/json")

    expect(readdirSync(join(root, ACCOUNT, CONTAINER))).toEqual([file])
    expect(readFileSync(join(root, ACCOUNT, CONTAINER, file)).subarray(0, 4).toString()).toBe("TVB2")
    expect(await text(new LocalBlobStore(root, [master]), ACCOUNT, "backup-2026-09-01-020000/metadata.json")).toBe('{"v":2}')
  })

  it("rejects duplicate headers: two files that claim the same blob", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-v1-"))
    const master = randomBytes(32)
    const file = writeV1(root, master, ACCOUNT, CONTAINER, "backup-2026-09-01-020000/metadata.json", "{}")
    const dir = join(root, ACCOUNT, CONTAINER)
    copyFileSync(join(dir, file), join(dir, `${"0".repeat(40)}.tvb`))
    await expect(new LocalBlobStore(root, [master]).list(ACCOUNT, CONTAINER)).rejects.toBeInstanceOf(IncompleteInventoryError)
  })
})

describe("version 2 binds files to their tenant", () => {
  const setup = async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-v2-"))
    const master = randomBytes(32)
    const store = new LocalBlobStore(root, [master])
    for (const account of [ACCOUNT, localStorageAccountName(OTHER)]) {
      await store.createContainer(account, CONTAINER)
      await store.put(account, CONTAINER, "backup-2026-09-30-020000/metadata.json", Buffer.from(`{"tenant":"${account}"}`), "application/json")
    }
    return { root, master, store }
  }

  it("names files with the account, so the same blob gets a different file per tenant", async () => {
    const { root, master } = await setup()
    expect(readFileSync(join(root, ACCOUNT, CONTAINER, readdirSync(join(root, ACCOUNT, CONTAINER))[0]!)).subarray(0, 4).toString()).toBe("TVB2")
    expect(await text(new LocalBlobStore(root, [master]), ACCOUNT, "backup-2026-09-30-020000/metadata.json")).toBe(`{"tenant":"${ACCOUNT}"}`)
    expect(readdirSync(join(root, ACCOUNT, CONTAINER))).not.toEqual(readdirSync(join(root, localStorageAccountName(OTHER), CONTAINER)))
  })

  it("does not read a file copied into another tenant's folder", async () => {
    const { root, master } = await setup()
    const from = join(root, localStorageAccountName(OTHER), CONTAINER)
    const [file] = readdirSync(from)
    copyFileSync(join(from, file!), join(root, ACCOUNT, CONTAINER, file!))
    await expect(new LocalBlobStore(root, [master]).list(ACCOUNT, CONTAINER)).rejects.toBeInstanceOf(IncompleteInventoryError)
  })

  it("does not read a file that was renamed or moved to another container", async () => {
    const { root, master, store } = await setup()
    await store.put(ACCOUNT, CONTAINER, "backup-2026-09-30-020000/Other.json", Buffer.from("{}"), "application/json")
    const dir = join(root, ACCOUNT, CONTAINER)
    const [first, second] = readdirSync(dir)
    renameSync(join(dir, first!), join(dir, "swap"))
    renameSync(join(dir, second!), join(dir, first!))
    renameSync(join(dir, "swap"), join(dir, second!))
    await expect(new LocalBlobStore(root, [master]).list(ACCOUNT, CONTAINER)).rejects.toBeInstanceOf(IncompleteInventoryError)

    const other = join(root, ACCOUNT, "tenant-metadata")
    mkdirSync(other)
    copyFileSync(join(dir, first!), join(other, first!))
    await expect(new LocalBlobStore(root, [master]).list(ACCOUNT, "tenant-metadata")).rejects.toBeInstanceOf(IncompleteInventoryError)
  })

  it.skipIf(process.platform === "win32")("creates backup folders readable only by the current user", async () => {
    const { root } = await setup()
    expect(statSync(join(root, ACCOUNT)).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, ACCOUNT, CONTAINER)).mode & 0o777).toBe(0o700)
  })
})

describe("local blob emulator tenant binding", () => {
  const setup = async () => {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-bind-")), [randomBytes(32)])
    for (const tenant of [TENANT, OTHER]) await store.createContainer(localStorageAccountName(tenant), CONTAINER)
    const list = (tenant: string) => handleLocalBlobRequest(store, new Request(`https://${localStorageAccountName(tenant)}.blob.core.windows.net/${CONTAINER}?restype=container&comp=list`))
    return { store, list }
  }

  it("serves a route only the local backups of the tenant in its request", async () => {
    const { list } = await setup()
    expect((await withRouteTenant(TENANT, () => list(TENANT))).status).toBe(200)
    expect((await withRouteTenant(TENANT.toUpperCase(), () => list(TENANT))).status).toBe(200)
    expect((await withRouteTenant(TENANT, () => list(OTHER))).status).toBe(403)
    expect((await withRouteTenant(undefined, () => list(TENANT))).status).toBe(403)
    // Outside any route (scheduled backups) the account name alone decides, as before.
    expect((await list(OTHER)).status).toBe(200)
  })

  it("binds routes dispatched by the API host, including work they start", async () => {
    const { list } = await setup()
    let later: Promise<Response> | undefined
    const host = new ApiHost({
      routes: {
        "/api/probe": {
          POST: async (request: NextRequest) => {
            const { target } = await request.json()
            later = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => list(target))
            return list(target)
          },
        },
      },
    })
    const call = (tenantId: string, target: string) =>
      host.dispatch(new Request("http://tenuvault.internal/api/probe", { method: "POST", body: JSON.stringify({ tenantId, target }) }))
    expect((await call(TENANT, TENANT)).status).toBe(200)
    expect((await later!).status).toBe(200)
    expect((await call(TENANT, OTHER)).status).toBe(403)
    expect((await later!).status).toBe(403)
  })
})

function fakeGraph(url: URL): Response {
  if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
  return Response.json({ id: url.pathname.split("/").pop() })
}

async function finished(engine: BackupEngine, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = engine.get(id)!
    if (job.status !== "Running") return job
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error("backup did not finish")
}

describe("retention is scoped to the backup's tenant", () => {
  const retentionSetup = async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-retention-"))
    const master = randomBytes(32)
    const store = new LocalBlobStore(root, [master])
    await store.createContainer(ACCOUNT, CONTAINER)
    const put = (name: string, body: unknown) => store.put(ACCOUNT, CONTAINER, name, Buffer.from(JSON.stringify(body)), "application/json")
    const engine = new BackupEngine({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        return localAccountFromUrl(url) ? handleLocalBlobRequest(store, request) : fakeGraph(url)
      }) as typeof fetch,
      getToken: async () => "token",
      retentionDays: () => 30,
      now: () => new Date("2026-09-24T12:00:00Z"),
    })
    const run = async (options: { tenantId?: string; excluded?: string[] } = {}) => {
      const job = await finished(engine, engine.start({ tenantId: options.tenantId ?? TENANT, clientId: CLIENT, storageAccountName: ACCOUNT, scope: { excluded: options.excluded ?? [] } }).id)
      const folders = new Set((await store.list(ACCOUNT, CONTAINER)).map((blob) => blob.name.split("/")[0]))
      return { job, folders: [...folders].sort(), log: job.log.join("\n") }
    }
    return { root, master, store, put, run }
  }

  it("records the tenant and, in a container another tenant also uses, removes only this tenant's expired backups", async () => {
    const { root, master, store, put, run } = await retentionSetup()
    await put("backup-2026-07-01-020000/metadata.json", { Status: "Success", TenantId: TENANT.toUpperCase() })
    await put("backup-2026-07-02-020000/metadata.json", { Status: "Success", TenantId: OTHER })
    await put("backup-2026-07-03-020000/metadata.json", { Status: "Success" })
    await put("backup-2026-07-04-020000/DeviceConfigurations/A.json", {})
    await put("backup-2026-07-05-020000/metadata.json", "not an object")
    // Written by the released version 1 format, before backups recorded their tenant.
    writeV1(root, master, ACCOUNT, CONTAINER, "backup-2026-07-06-020000/metadata.json", JSON.stringify({ Status: "Success" }))

    const { job, folders, log } = await run({ tenantId: TENANT.toUpperCase() })
    expect(job.status).toBe("Completed")
    expect(JSON.parse(await text(store, ACCOUNT, `${job.backupFolder}/metadata.json`)).TenantId).toBe(TENANT)
    expect(folders).toEqual([
      "backup-2026-07-02-020000",
      "backup-2026-07-03-020000",
      "backup-2026-07-04-020000",
      "backup-2026-07-05-020000",
      "backup-2026-07-06-020000",
      "backup-2026-09-24-120000",
    ])
    expect(log).toContain("Removed 1 backup older than 30 days.")
    expect(log).toContain("Kept 5 older backups not recorded as this tenant's")
  })

  it("prunes backups from earlier versions when no other tenant uses the container", async () => {
    const { root, master, put, run } = await retentionSetup()
    await put("backup-2026-07-01-020000/metadata.json", { Status: "Success", TenantId: TENANT })
    await put("backup-2026-07-03-020000/metadata.json", { Status: "Success" })
    writeV1(root, master, ACCOUNT, CONTAINER, "backup-2026-07-06-020000/metadata.json", JSON.stringify({ Status: "Success" }))
    // Without metadata the owner is unknown, so it stays.
    await put("backup-2026-07-04-020000/DeviceConfigurations/A.json", {})
    await put("backup-2026-09-20-020000/metadata.json", { Status: "Success" })

    const { folders, log } = await run()
    expect(folders).toEqual(["backup-2026-07-04-020000", "backup-2026-09-20-020000", "backup-2026-09-24-120000"])
    expect(log).toContain("Removed 3 backups older than 30 days.")
    expect(log).toContain("Kept 1 older backup not recorded as this tenant's")
  })

  it("counts a backup from an earlier version as the newest copy of a type only when no other tenant uses the container", async () => {
    // Single tenant: the untagged August backup holds the newest copy of apps, so it stays and the tagged July one goes.
    const single = await retentionSetup()
    await single.put("backup-2026-08-01-020000/metadata.json", { Status: "Success", Scope: { Excluded: [] } })
    await single.put("backup-2026-07-01-020000/metadata.json", { Status: "Success", Scope: { Excluded: [] }, TenantId: TENANT })
    const one = await single.run({ excluded: ["Apps"] })
    expect(one.folders).toEqual(["backup-2026-08-01-020000", "backup-2026-09-24-120000"])
    expect(one.log).toContain("Kept 1 older backup because it holds the newest copy of types this backup leaves out.")

    // Shared: the untagged backup may be the other tenant's, so the tagged July backup keeps the newest copy of apps.
    const shared = await retentionSetup()
    await shared.put("backup-2026-08-01-020000/metadata.json", { Status: "Success", Scope: { Excluded: [] } })
    await shared.put("backup-2026-07-15-020000/metadata.json", { Status: "Success", Scope: { Excluded: [] }, TenantId: OTHER })
    await shared.put("backup-2026-07-01-020000/metadata.json", { Status: "Success", Scope: { Excluded: [] }, TenantId: TENANT })
    const two = await shared.run({ excluded: ["Apps"] })
    expect(two.folders).toEqual(["backup-2026-07-01-020000", "backup-2026-07-15-020000", "backup-2026-08-01-020000", "backup-2026-09-24-120000"])
    expect(two.log).toContain("Kept 1 older backup because it holds the newest copy of types this backup leaves out.")
    expect(two.log).toContain("Kept 2 older backups not recorded as this tenant's")
  })
})

describe("backup listing is scoped to the tenant", () => {
  it("leaves out backups recorded as another tenant's and keeps legacy ones", async () => {
    const owners: Record<string, unknown> = {
      "backup-2026-09-20-020000": { Status: "Success", TenantId: TENANT.toUpperCase() },
      "backup-2026-09-21-020000": { Status: "Success", TenantId: OTHER },
      "backup-2026-09-22-020000": { Status: "Success" },
    }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
      if (url.pathname.endsWith("metadata.json")) return Response.json(owners[url.pathname.split("/")[2]!])
      if (url.searchParams.get("delimiter")) return new Response(Object.keys(owners).map((name) => `<BlobPrefix><Name>${name}/</Name></BlobPrefix>`).join(""))
      return new Response(`<Blobs><Blob><Name>${url.searchParams.get("prefix")}metadata.json</Name><Properties><Content-Length>7</Content-Length></Properties></Blob></Blobs>`)
    }))
    const request = new NextRequest("http://tenuvault.internal/api/list-backups", {
      method: "POST",
      body: JSON.stringify({ tenantId: TENANT, appId: "app", clientSecret: "test", storageAccountName: "store", subscriptionId: "local", resourceGroupName: "local" }),
    })
    const { backups } = await (await listBackups(request)).json()
    expect(backups.map((backup: { id: string }) => backup.id)).toEqual(["backup-2026-09-22-020000", "backup-2026-09-20-020000"])
  })
})
