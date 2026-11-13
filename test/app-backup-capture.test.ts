import { afterEach, describe, expect, it, vi } from "vitest"
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { build } from "esbuild"
import JSZip from "jszip"
import { ingestContent, type ContentEncryption } from "../src/main/app-backup/content-stream"
import { AppSourceStore } from "../src/main/app-sources/store"
import { bindCapture } from "../src/main/app-backup/capture-identity"
import { downloadCapturedContent } from "../src/main/app-backup/capture-download"
import type { CaptureIdentity } from "../src/shared/app-sources/types"

const tenant = "11111111-1111-1111-1111-111111111111", other = "22222222-2222-2222-2222-222222222222"
const identity: CaptureIdentity = { tenantId: tenant, appId: randomUUID(), contentFileId: randomUUID(), contentVersion: "3", appType: "#microsoft.graph.win32LobApp" }
const roots: string[] = []
afterEach(async () => { for (const folder of roots.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function workspace() {
  const folder = await mkdtemp(join(tmpdir(), "intune-capture-")); roots.push(folder)
  const master = randomBytes(32), base = join(folder, "store"), store = new AppSourceStore(base, () => [master])
  return { folder, base, master, store }
}
function encrypt(plain: Buffer) {
  const key = randomBytes(32), iv = randomBytes(16), macKey = randomBytes(32)
  const cipher = createCipheriv("aes-256-cbc", key, iv), ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  const mac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest()
  const profile: ContentEncryption = { profileIdentifier: "ProfileVersion1", fileDigestAlgorithm: "SHA256", encryptionKey: key.toString("base64"), initializationVector: iv.toString("base64"), macKey: macKey.toString("base64"), mac: mac.toString("base64"), fileDigest: createHash("sha256").update(plain).digest("base64") }
  return { profile, wire: Buffer.concat([mac, iv, ciphertext]) }
}
async function* stream(bytes: Buffer, chunk = 997) { for (let at = 0; at < bytes.length; at += chunk) yield bytes.subarray(at, at + chunk) }
async function zipFile() { const zip = new JSZip(); zip.file("setup.exe", randomBytes(1024 * 1024 + 123)); return zip.generateAsync({ type: "nodebuffer", compression: "STORE" }) }

describe("authenticated Intune content stream", () => {
  it.each([1, 15, 16, 17, 31, 48, 49, 997, 2 * 1024 * 1024])("handles header/cipher boundaries with %i-byte reads", async chunk => {
    const plain = randomBytes(chunk === 1 ? 128 : 129031), { wire, profile } = encrypt(plain), written: Buffer[] = []
    const result = await ingestContent(stream(wire, chunk), profile, plain.length, async part => { expect(part.length).toBeLessThanOrEqual(65536); written.push(Buffer.from(part)) })
    expect(Buffer.concat(written).equals(plain)).toBe(true)
    expect(result).toEqual({ bytes: plain.length, encryptedBytes: wire.length, sha256: createHash("sha256").update(plain).digest("hex"), encryptedSha256: createHash("sha256").update(wire).digest("hex") })
  })
  it.each(["mac", "iv", "ciphertext", "digest", "key", "short-header", "truncated", "extra", "size", "algorithm", "base64"])("rejects %s without returning a receipt", async mode => {
    const plain = randomBytes(1024), fixture = encrypt(plain), profile = { ...fixture.profile }
    let wire = Buffer.from(fixture.wire), size = plain.length
    if (mode === "mac") wire[0] = wire[0]! ^ 1
    if (mode === "iv") wire[32] = wire[32]! ^ 1
    if (mode === "ciphertext") wire[64] = wire[64]! ^ 1
    if (mode === "digest") profile.fileDigest = randomBytes(32).toString("base64")
    if (mode === "key") profile.encryptionKey = randomBytes(32).toString("base64")
    if (mode === "short-header") wire = wire.subarray(0, 40)
    if (mode === "truncated") wire = wire.subarray(0, -1)
    if (mode === "extra") wire = Buffer.concat([wire, Buffer.from([0])])
    if (mode === "size") size--
    if (mode === "algorithm") Object.assign(profile, { fileDigestAlgorithm: "SHA1" })
    if (mode === "base64") profile.encryptionKey += "!"
    await expect(ingestContent(stream(wire), profile, size, async () => {})).rejects.toThrow()
  })
  it("clears transient plaintext buffers and stops its producer when the sink fails", async () => {
    const plain = randomBytes(200000), { wire, profile } = encrypt(plain), held: Buffer[] = []
    let closed = false
    async function* input() { try { yield wire } finally { closed = true } }
    await expect(ingestContent(input(), profile, plain.length, async part => { held.push(part); throw new Error("disk full") })).rejects.toThrow("disk full")
    expect(closed).toBe(true)
    expect(held.every(bytes => bytes.every(byte => byte === 0))).toBe(true)
  })
})

it("retains only a fingerprint of opaque service identifiers, with exact response binding", () => {
  const opaque = "service-content-".repeat(15), fingerprint = `sha256:${createHash("sha256").update(opaque).digest("hex")}`
  const expected = { ...identity, contentFileId: fingerprint }
  expect(bindCapture(expected, expected).contentFileId).toBe(fingerprint)
  expect(JSON.stringify(bindCapture(expected, expected))).not.toContain(opaque)
  expect(() => bindCapture(expected, { ...expected, contentFileId: `sha256:${"0".repeat(64)}` })).toThrow("does not match")
  expect(() => bindCapture(expected, { ...expected, contentFileId: opaque })).toThrow("Invalid")
})

describe("captured installer publication", () => {
  it("publishes authenticated content with its identity, survives reconnect and exports the payload exactly", async () => {
    const { folder, base, master, store } = await workspace(), plain = await zipFile(), { wire, profile } = encrypt(plain)
    const item = await store.capture(identity, identity, stream(wire), profile, plain.length, "Finance")
    expect(item).toMatchObject({ provenance: "intune-capture", format: "win32-source-zip", receipt: { schema: 1, ...identity }, bytes: plain.length })
    const reconnect = new AppSourceStore(base, () => [randomBytes(32), master])
    expect((await reconnect.list(tenant)).sources).toEqual([item])
    expect(await reconnect.capturedSource(tenant, item.id)).toEqual(item)
    await reconnect.export(tenant, item.id, join(folder, "sources.zip"))
    // Compare every byte without the object matcher's costly per-index traversal.
    expect((await readFile(join(folder, "sources.zip"))).equals(plain)).toBe(true)
    const artifact = await readFile(join(base, tenant, item.id, "artifact.tvs"))
    expect(artifact.includes(plain.subarray(0, 100))).toBe(false)
    const serialized = JSON.stringify(item)
    for (const secret of [profile.encryptionKey, profile.macKey, profile.initializationVector]) expect(serialized).not.toContain(secret)
    const wrongKey = new AppSourceStore(base, () => [randomBytes(32)])
    expect((await wrongKey.list(tenant)).unreadableSources).toBe(true)
    await expect(wrongKey.capture(identity, identity, stream(wire), profile, plain.length, "Wrong key")).rejects.toThrow("matching recovery key")
    expect(await readdir(join(base, tenant))).toEqual([item.id])
    await expect(reconnect.capturedSource(other, item.id)).rejects.toThrow()
  })
  it.each(["tamper", "digest", "truncated", "not-zip", "cancel", "disconnect"])("never lists or leaves plaintext for a %s capture", async mode => {
    const { base, store } = await workspace(), plain = mode === "not-zip" ? randomBytes(1000) : await zipFile(), { wire, profile } = encrypt(plain)
    const abort = new AbortController()
    if (mode === "tamper") wire[64] = wire[64]! ^ 1
    if (mode === "digest") profile.fileDigest = randomBytes(32).toString("base64")
    async function* input() {
      yield wire.subarray(0, 800000)
      expect((await store.list(tenant)).sources).toEqual([])
      if (mode === "cancel") abort.abort()
      if (mode === "disconnect") throw new Error("helper disconnected")
      yield wire.subarray(800000, mode === "truncated" ? -1 : undefined)
    }
    await expect(store.capture(identity, identity, input(), profile, plain.length, "Finance", abort.signal)).rejects.toThrow()
    expect((await store.list(tenant)).sources).toEqual([])
    expect(await readdir(join(base, tenant))).toEqual([])
  })
  it.each(["tenantId", "appId", "contentVersion", "contentFileId", "appType"] as const)("refuses mismatched %s before reading any content", async field => {
    const { store } = await workspace(), plain = await zipFile(), { wire, profile } = encrypt(plain)
    const returned = { ...identity, [field]: field === "contentVersion" ? "4" : field === "appType" ? "#microsoft.graph.macOSDmgApp" : other }
    const read = vi.fn(() => stream(wire))
    await expect(store.capture(identity, returned as CaptureIdentity, { [Symbol.asyncIterator]: read }, profile, plain.length, "Finance")).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
  it("refuses local archives as restore inputs and cannot upgrade them using their file label", async () => {
    const { folder, store } = await workspace(), zip = new JSZip()
    zip.file("IntuneWinPackage/Metadata/Detection.xml", "<ApplicationInfo><EncryptionInfo/></ApplicationInfo>")
    zip.file("IntuneWinPackage/Contents/IntunePackage.intunewin", randomBytes(128))
    const file = join(folder, "local.intunewin"); await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }))
    const item = await store.attach(tenant, file, "Intune capture")
    await expect(store.capturedSource(tenant, item.id)).rejects.toThrow("Local archives cannot be restored")
  })
  it("snapshots the expected identity rather than keeping a mutable helper object", () => {
    const input = { ...identity }, result = bindCapture(input, input)
    input.contentVersion = "4"
    expect(result.contentVersion).toBe("3")
  })
  it.each(["../escape.exe", "CON.exe", "folder./setup.exe"])("refuses an authenticated ZIP containing unsafe path %s", async name => {
    const { store } = await workspace(), zip = new JSZip(); zip.file(name, "installer")
    const plain = await zip.generateAsync({ type: "nodebuffer" }), { wire, profile } = encrypt(plain)
    await expect(store.capture(identity, identity, stream(wire), profile, plain.length, "Finance")).rejects.toThrow()
    expect((await store.list(tenant)).sources).toEqual([])
  })
  it.each([false, true])("reconciles real process death with published=%s, without retaining plaintext", async published => {
    const { folder, base, master, store } = await workspace(), plain = await zipFile(), { wire, profile } = encrypt(plain)
    const bundle = join(folder, "store.cjs"), payload = join(folder, "encrypted.bin"), runner = join(folder, "crash.cjs")
    await build({ entryPoints: ["src/main/app-sources/store.ts"], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" })
    await writeFile(payload, wire)
    await writeFile(runner, `const {AppSourceStore}=require(${JSON.stringify(bundle)});const wire=require('node:fs').readFileSync(${JSON.stringify(payload)});async function* input(){yield wire.subarray(0,1100000);${published ? "" : "process.exit(37);"}yield wire.subarray(1100000)}new AppSourceStore(${JSON.stringify(base)},()=>[Buffer.from(${JSON.stringify(master.toString("hex"))},'hex')]).capture(${JSON.stringify(identity)},${JSON.stringify(identity)},input(),${JSON.stringify(profile)},${plain.length},'Finance').then(()=>process.exit(37)).catch(()=>process.exit(9));`)
    expect(spawnSync(process.execPath, [runner], { timeout: 10000 }).status).toBe(37)
    for (let i = 0; i < 2; i++) expect((await store.list(tenant)).sources).toHaveLength(published ? 1 : 0)
    const entries = await readdir(join(base, tenant))
    expect(entries.some(name => name.startsWith(".staging-"))).toBe(false)
    if (published) {
      const item = (await store.list(tenant)).sources[0]!
      await store.export(tenant, item.id, join(folder, "result.zip"))
      expect((await readFile(join(folder, "result.zip"))).equals(plain)).toBe(true)
    }
  }, 20000)
})

describe("content download boundary", () => {
  const url = "https://content.manage.microsoft.com/fixture?token=do-not-log"
  it("streams into encrypted storage without forwarding authentication or following redirects", async () => {
    const { store } = await workspace(), plain = await zipFile(), { wire, profile } = encrypt(plain)
    const fetcher = vi.fn(async () => new Response(wire, { headers: { "content-length": String(wire.length) } }))
    const result = await downloadCapturedContent(store, identity, { identity, downloadUrl: url, encryption: profile, bytes: plain.length }, "Finance", { fetch: fetcher })
    expect(result.provenance).toBe("intune-capture")
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, { method: "GET", redirect: "error", credentials: "omit", signal: expect.any(AbortSignal) })
    expect(JSON.stringify(result)).not.toContain("do-not-log")
  })
  it.each(["http://content.manage.microsoft.com/a", "https://manage.microsoft.com.attacker.test/a", "https://user@content.manage.microsoft.com/a", "https://content.manage.microsoft.com:8443/a", "https://127.0.0.1/a", "https://content.manage.microsoft.com/a#fragment"])("rejects unsupported download URL %s before the request", async downloadUrl => {
    const { store } = await workspace(), { profile } = encrypt(randomBytes(100)), fetcher = vi.fn()
    await expect(downloadCapturedContent(store, identity, { identity, downloadUrl, encryption: profile, bytes: 100 }, "Finance", { fetch: fetcher })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([302, 403, 404, 500])("rejects HTTP %s and never publishes content", async status => {
    const { store } = await workspace(), { profile } = encrypt(randomBytes(100)), cancel = vi.fn()
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status }))
    await expect(downloadCapturedContent(store, identity, { identity, downloadUrl: url, encryption: profile, bytes: 100 }, "Finance", { fetch: fetcher })).rejects.toThrow(`HTTP ${status}`)
    expect(cancel).toHaveBeenCalled()
    expect((await store.list(tenant)).sources).toEqual([])
  })
  it("redacts transport errors and rejects wrong lengths and pre-cancelled requests", async () => {
    const { store } = await workspace(), { profile } = encrypt(randomBytes(100))
    const content = { identity, downloadUrl: url, encryption: profile, bytes: 100 }
    await expect(downloadCapturedContent(store, identity, content, "Finance", { fetch: async () => { throw new Error(url) } })).rejects.toThrow("could not be started")
    await expect(downloadCapturedContent(store, identity, content, "Finance", { fetch: async () => new Response("bad", { headers: { "content-length": "3" } }) })).rejects.toThrow("unexpected length")
    const fetcher = vi.fn()
    await expect(downloadCapturedContent(store, identity, content, "Finance", { fetch: fetcher, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
