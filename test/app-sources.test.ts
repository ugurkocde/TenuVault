import { appendFileSync } from "node:fs"
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp, symlink, lstat, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { build } from "esbuild"
import { AppSourceStore } from "../src/main/app-sources/store"
import { AppSourceService, type AppSourceHost } from "../src/main/app-sources/service"
import { BackupKeys } from "../src/main/backup/keys"

const tenant = "11111111-1111-1111-1111-111111111111", other = "22222222-2222-2222-2222-222222222222"
const roots: string[] = []
const master = randomBytes(32)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() { const value = await mkdtemp(join(tmpdir(), "app-source-test-")); roots.push(value); return value }
async function packageFile(folder: string, options: { extra?: string; xml?: string; bytes?: number } = {}) {
  const zip = new JSZip()
  zip.file("IntuneWinPackage/Metadata/Detection.xml", options.xml ?? "<ApplicationInfo><EncryptionInfo/></ApplicationInfo>")
  zip.file("IntuneWinPackage/Contents/IntunePackage.intunewin", randomBytes(options.bytes ?? 1024 * 1024 + 256))
  if (options.extra) zip.file(options.extra, "unsafe")
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" })
  const file = join(folder, `${randomUUID()}.intunewin`); await writeFile(file, data)
  return { file, data }
}

describe("streaming app source store", () => {
  it("does not create missing folders while listing or attempting an export", async () => {
    const folder = await root(), base = join(folder, "missing"), store = new AppSourceStore(base, () => [master])
    expect((await store.list(tenant)).sources).toEqual([])
    await expect(store.export(tenant, randomUUID(), join(folder, "out.intunewin"))).rejects.toThrow("unavailable")
    await expect(lstat(base)).rejects.toMatchObject({ code: "ENOENT" })
    await mkdir(base)
    expect((await store.list(tenant)).sources).toEqual([])
    expect(await readdir(base)).toEqual([])
  })
  it("lists and exports a retained read-only store using local export journals", async () => {
    const folder = await root(), input = await packageFile(folder), base = join(folder, "store"), journals = join(folder, "local-jobs")
    const writer = new AppSourceStore(base, () => [master]), item = await writer.attach(tenant, input.file, "App")
    const retained = new AppSourceStore(base, () => [master], journals)
    await chmod(base, 0o500); await chmod(join(base, tenant), 0o500)
    try {
      expect((await retained.list(tenant)).sources).toEqual([item])
      await retained.export(tenant, item.id, join(folder, "original.intunewin"))
      expect((await readFile(join(folder, "original.intunewin"))).equals(input.data)).toBe(true)
      expect(await readdir(join(base, tenant))).toEqual([item.id])
      expect(await readdir(join(journals, tenant))).toEqual([])
    } finally { await chmod(base, 0o700); await chmod(join(base, tenant), 0o700) }
  })
  it.each(["owner", "export", "manifest"])("quarantines oversized %s metadata without attempting decryption", async kind => {
    const folder = await root(), base = join(folder, "store"), id = randomUUID(), keys = vi.fn(() => [master])
    const directory = join(base, tenant, kind === "owner" ? `.staging-${id}` : kind === "manifest" ? id : "")
    await mkdir(directory, { recursive: true })
    const metadata = join(directory, kind === "owner" ? "owner.tvm" : kind === "manifest" ? "manifest.tvm" : `.export-${id}.tvm`)
    await writeFile(metadata, Buffer.alloc(64 * 1024 + 1))
    const result = await new AppSourceStore(base, keys).list(tenant)
    expect(result.sources).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(keys).not.toHaveBeenCalled()
    expect((await lstat(metadata)).size).toBe(64 * 1024 + 1)
  })
  it.each(["owner", "export", "manifest"])("quarantines linked %s metadata without reading its target", async kind => {
    const folder = await root(), base = join(folder, "store"), id = randomUUID(), keys = vi.fn(() => [master])
    const directory = join(base, tenant, kind === "owner" ? `.staging-${id}` : kind === "manifest" ? id : "")
    await mkdir(directory, { recursive: true })
    const metadata = join(directory, kind === "owner" ? "owner.tvm" : kind === "manifest" ? "manifest.tvm" : `.export-${id}.tvm`)
    const target = join(folder, "keep.tvm"); await writeFile(target, "TVM1do not follow")
    await symlink(target, metadata)
    const result = await new AppSourceStore(base, keys).list(tenant)
    expect(result.sources).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(keys).not.toHaveBeenCalled()
    expect((await lstat(metadata)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, "utf8")).toBe("TVM1do not follow")
  })
  it("retains exact original bytes and rebuilds a tenant catalog from the folder and imported TVK2 keys", async () => {
    const folder = await root(), input = await packageFile(folder)
    const values = new Map<string, string>()
    const kv = { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v) }, delete: (k: string) => { values.delete(k) } }
    const keys = new BackupKeys(kv)
    expect(keys.existingKeyring()).toEqual([])
    const first = new AppSourceStore(join(folder, "store"), () => keys.keyring())
    const item = await first.attach(tenant, input.file, "Finance app")
    const ciphertext = await readFile(join(folder, "store", tenant, item.id, "artifact.tvs"))
    expect(ciphertext.includes(Buffer.from("ApplicationInfo"))).toBe(false)
    expect((await first.list(other)).sources).toEqual([])
    const bundle = keys.exportRecoveryKey()
    const freshValues = new Map<string, string>()
    const fresh = new BackupKeys({ get: k => freshValues.get(k) ?? null, set: (k, v) => { freshValues.set(k, v) }, delete: k => { freshValues.delete(k) } })
    fresh.importRecoveryKey(bundle)
    const store = new AppSourceStore(join(folder, "store"), () => fresh.existingKeyring())
    expect((await store.list(tenant)).sources).toEqual([item])
    const destination = join(folder, "export.intunewin")
    await store.export(tenant, item.id, destination)
    expect((await readFile(destination)).equals(input.data)).toBe(true)
    // New key becomes current; old artifacts still decrypt with the retained keyring.
    fresh.importRecoveryKey("TVK2." + randomBytes(32).toString("base64url"))
    await store.export(tenant, item.id, join(folder, "rotated.intunewin"))
    expect((await readFile(join(folder, "rotated.intunewin"))).equals(input.data)).toBe(true)
  }, 20_000)
  it.each(["tamper", "truncate", "reorder", "wrong-key", "wrong-tenant", "wrong-source"])("rejects %s without publishing plaintext or replacing an existing destination", async mode => {
    const folder = await root(), input = await packageFile(folder), base = join(folder, "store")
    const store = new AppSourceStore(base, () => [master]), item = await store.attach(tenant, input.file, "App")
    const artifact = join(base, tenant, item.id, "artifact.tvs"), data = await readFile(artifact)
    let chosen = store, selectedTenant = tenant, selectedId = item.id
    if (mode === "tamper") { data[45] = data[45]! ^ 1; await writeFile(artifact, data) }
    if (mode === "truncate") await writeFile(artifact, data.subarray(0, data.length - 9))
    if (mode === "reorder") {
      const firstEnd = 4 + 5 + data.readUInt32BE(5), secondEnd = firstEnd + 5 + data.readUInt32BE(firstEnd + 1)
      await writeFile(artifact, Buffer.concat([data.subarray(0, 4), data.subarray(firstEnd, secondEnd), data.subarray(4, firstEnd), data.subarray(secondEnd)]))
    }
    if (mode === "wrong-key") chosen = new AppSourceStore(base, () => [randomBytes(32)])
    if (mode === "wrong-tenant") { await cp(join(base, tenant, item.id), join(base, other, item.id), { recursive: true }); selectedTenant = other }
    if (mode === "wrong-source") { selectedId = randomUUID(); await cp(join(base, tenant, item.id), join(base, tenant, selectedId), { recursive: true }) }
    const destination = join(folder, "keep.intunewin"); await writeFile(destination, "keep")
    await expect(chosen.export(selectedTenant, selectedId, destination)).rejects.toThrow()
    expect(await readFile(destination, "utf8")).toBe("keep")
    expect((await readdir(folder)).filter(n => n.startsWith(".tenuvault-export-"))).toEqual([])
    expect((await readdir(join(base, selectedTenant))).filter(n => n.startsWith(".export-"))).toEqual([])
  })
  it("refuses a successful overwrite and handles cancellation without publishing a source", async () => {
    const folder = await root(), input = await packageFile(folder), base = join(folder, "store")
    const store = new AppSourceStore(base, () => [master])
    const aborted = new AbortController(); aborted.abort()
    await expect(store.attach(tenant, input.file, "Cancelled", aborted.signal)).rejects.toThrow()
    expect((await store.list(tenant)).sources).toEqual([])
    const item = await store.attach(tenant, input.file, "App"), destination = join(folder, "existing.intunewin")
    await writeFile(destination, "existing")
    await expect(store.export(tenant, item.id, destination)).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(destination, "utf8")).toBe("existing")
  })
  it("rejects a source that changes after inspection and leaves no committed or staging record", async () => {
    const folder = await root(), input = await packageFile(folder), base = join(folder, "store")
    const store = new AppSourceStore(base, () => [master]); let checks = 0
    const signal = { throwIfAborted() { if (++checks === 2) appendFileSync(input.file, "changed") } } as AbortSignal
    await expect(store.attach(tenant, input.file, "App", signal)).rejects.toThrow("changed during import")
    expect((await store.list(tenant)).sources).toEqual([])
    expect((await readdir(join(base, tenant))).some(n => n.startsWith(".staging-"))).toBe(false)
  })
  it("cancels after the first plaintext export chunk and preserves the existing destination", async () => {
    const folder = await root(), input = await packageFile(folder), base = join(folder, "store")
    const store = new AppSourceStore(base, () => [master]), item = await store.attach(tenant, input.file, "App")
    const destination = join(folder, "keep.intunewin"); await writeFile(destination, "keep"); let checks = 0
    const signal = { throwIfAborted() { if (++checks === 3) throw new Error("cancelled midstream") } } as AbortSignal
    await expect(store.export(tenant, item.id, destination, signal)).rejects.toThrow("cancelled midstream")
    expect(await readFile(destination, "utf8")).toBe("keep")
    expect((await readdir(folder)).some(n => n.startsWith(".tenuvault-export-"))).toBe(false)
    expect((await readdir(join(base, tenant))).some(n => n.startsWith(".export-"))).toBe(false)
  })
  it.each(["../outside", "CON.txt", "IntuneWinPackage/Metadata/DETECTION.XML", "bad:stream"])("rejects unsafe or duplicate ZIP entry %s", async extra => {
    const folder = await root(), input = await packageFile(folder, { extra })
    await expect(new AppSourceStore(join(folder, "store"), () => [master]).attach(tenant, input.file, "App")).rejects.toThrow()
  })
  it.each(["<!DOCTYPE ApplicationInfo [<!ENTITY a SYSTEM 'file:///etc/passwd'>]><ApplicationInfo><EncryptionInfo>&a;</EncryptionInfo></ApplicationInfo>", "<ApplicationInfo>"])("rejects unsafe or malformed XML", async xml => {
    const folder = await root(), input = await packageFile(folder, { xml })
    await expect(new AppSourceStore(join(folder, "store"), () => [master]).attach(tenant, input.file, "App")).rejects.toThrow()
  })
})

describe("crash recovery", () => {
  let bundle: string
  beforeAll(async () => {
    // Bundled once so real child-process termination can interrupt the store, bypassing finally.
    bundle = join(tmpdir(), `app-sources-${randomUUID()}.cjs`)
    await build({ entryPoints: ["src/main/app-sources/store.ts"], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" })
  })
  it("reconciles plaintext from a terminated export without touching an existing destination", async () => {
    const folder = await root(), input = await packageFile(folder), base = join(folder, "store")
    const store = new AppSourceStore(base, () => [master]), item = await store.attach(tenant, input.file, "App")
    const destination = join(folder, "keep.intunewin"); await writeFile(destination, "keep")
    const script = `const {AppSourceStore}=require(${JSON.stringify(bundle)});let calls=0;new AppSourceStore(${JSON.stringify(base)},()=>[Buffer.from(${JSON.stringify(master.toString("hex"))},'hex')]).export(${JSON.stringify(tenant)},${JSON.stringify(item.id)},${JSON.stringify(destination)},{throwIfAborted(){if(++calls===3)process.exit(37)}}).catch(()=>process.exit(9));`
    expect(spawnSync(process.execPath, ["-e", script], { timeout: 4000 }).status).toBe(37)
    expect((await readdir(folder)).some(n => n.startsWith(".tenuvault-export-"))).toBe(true)
    expect((await store.list(tenant)).sources).toHaveLength(1)
    await store.list(tenant)
    expect((await readdir(folder)).some(n => n.startsWith(".tenuvault-export-"))).toBe(false)
    expect(await readFile(destination, "utf8")).toBe("keep")
  }, 20_000)
  afterAll(async () => { await rm(bundle, { force: true }) })
  it("preserves a published export after death between publication and temporary-file cleanup", async () => {
    const folder = await root(), input = await packageFile(folder), base = join(folder, "store"), journals = join(folder, "local-jobs")
    const store = new AppSourceStore(base, () => [master], journals), item = await store.attach(tenant, input.file, "App"), destination = join(folder, "exported.intunewin")
    const script = `const fs=require('node:fs/promises'),link=fs.link;fs.link=async(...args)=>{await link(...args);process.exit(37)};const {AppSourceStore}=require(${JSON.stringify(bundle)});new AppSourceStore(${JSON.stringify(base)},()=>[Buffer.from(${JSON.stringify(master.toString("hex"))},'hex')],${JSON.stringify(journals)}).export(${JSON.stringify(tenant)},${JSON.stringify(item.id)},${JSON.stringify(destination)}).catch(()=>process.exit(9));`
    expect(spawnSync(process.execPath, ["-e", script], { timeout: 4000 }).status).toBe(37)
    expect((await readdir(folder)).some(n => n.startsWith(".tenuvault-export-"))).toBe(true)
    await store.list(tenant); await store.list(tenant)
    expect((await readdir(folder)).some(n => n.startsWith(".tenuvault-export-"))).toBe(false)
    expect((await readFile(destination)).equals(input.data)).toBe(true)
  }, 20_000)
  it("quarantines an incomplete import owned by another host", async () => {
    const folder = await root(), input = await packageFile(folder), base = join(folder, "store")
    const script = `require('node:os').hostname=()=> 'another-device';const {AppSourceStore}=require(${JSON.stringify(bundle)});let calls=0;new AppSourceStore(${JSON.stringify(base)},()=>[Buffer.from(${JSON.stringify(master.toString("hex"))},'hex')]).attach(${JSON.stringify(tenant)},${JSON.stringify(input.file)},'App',{throwIfAborted(){if(++calls===2)process.exit(37)}}).catch(()=>process.exit(9));`
    expect(spawnSync(process.execPath, ["-e", script], { timeout: 4000 }).status).toBe(37)
    const store = new AppSourceStore(base, () => [master])
    expect(await store.list(tenant)).toMatchObject({ sources: [], warnings: [expect.stringContaining("not completed")] })
    await store.list(tenant)
    expect((await readdir(join(base, tenant))).filter(n => n.startsWith(".staging-"))).toHaveLength(1)
  }, 20_000)
  it.each([1, 2, 3, 7, 0])("reconciles process death at checkpoint %s idempotently", async checkpoint => {
    const folder = await root(), input = await packageFile(folder, { bytes: 3 * 1024 * 1024 }), base = join(folder, "store")
    const script = `const {AppSourceStore}=require(${JSON.stringify(bundle)});let calls=0;new AppSourceStore(${JSON.stringify(base)},()=>[Buffer.from(${JSON.stringify(master.toString("hex"))},'hex')]).attach(${JSON.stringify(tenant)},${JSON.stringify(input.file)},'App',{throwIfAborted(){if(++calls===${checkpoint})process.exit(37)}}).then(()=>process.exit(37)).catch(()=>process.exit(9));`
    const child = spawnSync(process.execPath, ["-e", script], { timeout: 4000 })
    expect(child.status).toBe(37)
    const store = new AppSourceStore(base, () => [master])
    const expected = checkpoint === 0 ? 1 : 0
    expect((await store.list(tenant)).sources).toHaveLength(expected)
    expect((await store.list(tenant)).sources).toHaveLength(expected)
    expect((await readdir(join(base, tenant))).some(n => n.startsWith(".staging-"))).toBe(false)
    if (expected) { const id = (await store.list(tenant)).sources[0]!.id; await store.export(tenant, id, join(folder, "restored.intunewin")); expect((await readFile(join(folder, "restored.intunewin"))).equals(input.data)).toBe(true) }
  }, 20_000)
})

describe("trusted local source actions", () => {
  async function setup() {
    const folder = await root(), input = await packageFile(folder)
    const host: AppSourceHost = { knownTenant: id => id === tenant || id === other, folder: () => join(folder, "sources"), setFolder: vi.fn(), keys: () => [master], ensureKeys: vi.fn(), authorizeAttach: vi.fn(async () => {}), pickFolder: async () => folder, pickPackage: async () => input.file, pickExport: async () => null, checkDevice: vi.fn() }
    return { folder, input, host, service: new AppSourceService(host) }
  }
  it.each(["tenant", "renamed-tenant", "artifact"])("refuses a reconnect at the wrong %s folder level", async kind => {
    const { folder, host, service } = await setup(), id = randomUUID()
    const selected = join(folder, kind === "tenant" ? tenant.toUpperCase() : "retained")
    await mkdir(join(selected, id), { recursive: true })
    await writeFile(join(selected, kind === "artifact" ? "manifest.tvm" : `${id}/manifest.tvm`), "retained")
    host.pickFolder = async () => selected
    await expect(service.chooseStore(tenant)).rejects.toThrow("source store's")
    expect(host.setFolder).not.toHaveBeenCalled()
    expect((await readdir(selected)).includes(tenant)).toBe(false)
  })
  it("blocks attaching to an unreadable source store before minting keys", async () => {
    const { folder, host, service } = await setup(), directory = join(folder, "sources", tenant, randomUUID())
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "manifest.tvm"), "unreadable")
    await expect(service.attach(tenant, randomUUID(), "App")).rejects.toThrow("matching recovery key")
    expect(host.ensureKeys).not.toHaveBeenCalled()
    expect(await readdir(join(folder, "sources", tenant))).toHaveLength(1)
  })
  it("locks store selection during jobs and rechecks after the picker returns", async () => {
    const { folder, host, service } = await setup()
    let pickedFolder!: (value: string) => void, pickedPackage!: (value: null) => void
    host.pickFolder = vi.fn(() => new Promise<string>(resolve => { pickedFolder = resolve }))
    host.pickPackage = () => new Promise(resolve => { pickedPackage = resolve })
    const choice = service.chooseStore(tenant), job = service.attach(tenant, randomUUID(), "App")
    await vi.waitFor(() => expect(pickedPackage).toBeTypeOf("function"))
    await expect(service.chooseStore(tenant)).rejects.toThrow("Finish or cancel")
    pickedFolder(folder)
    await expect(choice).rejects.toThrow("started while the folder picker")
    expect(host.setFolder).not.toHaveBeenCalled()
    pickedPackage(null); expect(await job).toBe(false)
  })
  it("ignores cancellation from a different tenant", async () => {
    const { input, host, service } = await setup(), operation = randomUUID()
    let pickedPackage!: (value: string) => void
    host.pickPackage = () => new Promise(resolve => { pickedPackage = resolve })
    const job = service.attach(tenant, operation, "App")
    await vi.waitFor(() => expect(pickedPackage).toBeTypeOf("function"))
    service.cancel(other, operation); pickedPackage(input.file)
    expect(await job).toBe(true)
  })
  it("keeps offline export independent of entitlement, rejects unknown/cross tenants, and never mints a key on an empty listing", async () => {
    const folder = await root(), input = await packageFile(folder), ensureKeys = vi.fn()
    const host: AppSourceHost = { knownTenant: id => id === tenant || id === other, folder: () => join(folder, "sources"), setFolder: vi.fn(), keys: () => [master], ensureKeys, authorizeAttach: vi.fn(async () => {}), pickFolder: async () => null, pickPackage: async () => input.file, pickExport: async () => join(folder, "original.intunewin"), checkDevice: vi.fn() }
    const service = new AppSourceService(host)
    expect((await service.list(tenant)).sources).toEqual([]); expect(ensureKeys).not.toHaveBeenCalled()
    await expect(service.list("not-a-tenant")).rejects.toThrow()
    expect(await service.attach(tenant, randomUUID(), "App")).toBe(true)
    const id = (await service.list(tenant)).sources[0]!.id
    await expect(service.export(other, randomUUID(), id)).rejects.toThrow("does not belong")
    host.authorizeAttach = async () => { throw new Error("not entitled") }
    await expect(service.attach(tenant, randomUUID(), "Not allowed")).rejects.toThrow("not entitled")
    expect(await service.export(tenant, randomUUID(), id)).toBe(true)
    expect((await readFile(join(folder, "original.intunewin"))).equals(input.data)).toBe(true)
  })
})
