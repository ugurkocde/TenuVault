import { afterEach, describe, expect, it, vi } from "vitest"
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { AppSourceStore } from "../src/main/app-sources/store"
import { AppSourceService } from "../src/main/app-sources/service"
import { ingestContent, type ContentEncryption } from "../src/main/app-backup/content-stream"
import { restoreCapturedApp } from "../src/main/app-backup/restore"
import { restoreGraph, putRestoreBlock, type RestoreGraph } from "../src/main/app-backup/restore-graph"
import { assertRestoredSettings, readRestoreSnapshot, restoreBody, snapshotHash, type AppRestoreSnapshot } from "../src/main/app-backup/restore-snapshot"
import { encryptRestoreContent, newRestoreSecrets } from "../src/main/app-backup/restore-encryption"

const tenant = "11111111-1111-1111-1111-111111111111", target = "22222222-2222-2222-2222-222222222222", appId = "33333333-3333-3333-3333-333333333333"
const identity = { tenantId: tenant, appId, contentVersion: "1", contentFileId: `sha256:${"a".repeat(64)}`, appType: "#microsoft.graph.win32LobApp" as const }
const snapshot: AppRestoreSnapshot = { schema: 1, tenantId: tenant, appId, contentVersion: "1", observedAt: "2026-11-14T12:00:00Z", origin: "capture", relationships: [], app: {
  id: appId, "@odata.type": "#microsoft.graph.win32LobApp", committedContentVersion: "1", displayName: "Example", description: "An example", publisher: "Example Ltd", fileName: "Example.intunewin", setupFilePath: "setup.exe", installCommandLine: "setup.exe /quiet", uninstallCommandLine: "setup.exe /uninstall", rules: [{ "@odata.type": "#microsoft.graph.win32LobAppPowerShellScriptRule", ruleType: "detection", scriptContent: "ZXhpdCAw" }], installExperience: { runAsAccount: "system", deviceRestartBehavior: "suppress" }, returnCodes: [{ returnCode: 0, type: "success" }], roleScopeTagIds: ["987"], assignments: [{ target: { groupId: randomUUID() } }], categories: [{ id: randomUUID() }], size: 9,
} }
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function* stream(buffer: Buffer) { for (let i = 0; i < buffer.length; i += 997) yield buffer.subarray(i, i + 997) }
async function fixture(configuration: AppRestoreSnapshot | null = snapshot, large = false) {
  const root = await mkdtemp(join(tmpdir(), "app-restore-")); roots.push(root)
  const master = randomBytes(32), store = new AppSourceStore(root, () => [master])
  const zip = new JSZip(); zip.file("setup.exe", randomBytes(large ? 5 * 1024 ** 2 : 128000)); const plain = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" })
  const key = randomBytes(32), iv = randomBytes(16), macKey = randomBytes(32), cipher = createCipheriv("aes-256-cbc", key, iv)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]), mac = createHmac("sha256", macKey).update(iv).update(encrypted).digest()
  const profile: ContentEncryption = { profileIdentifier: "ProfileVersion1", encryptionKey: key.toString("base64"), initializationVector: iv.toString("base64"), macKey: macKey.toString("base64"), mac: mac.toString("base64"), fileDigest: createHash("sha256").update(plain).digest("base64"), fileDigestAlgorithm: "SHA256" }
  const source = await store.capture(identity, identity, stream(Buffer.concat([mac, iv, encrypted])), profile, plain.length, "Example", undefined, configuration ?? undefined)
  return { root, master, store, source, plain }
}
function destination() {
  let app: Record<string, unknown> | null = null, versions = 0, file: Record<string, unknown> | null = null, wire: Buffer = Buffer.alloc(0)
  let failCreateResponse = false, assigned = false
  const blocks = new Map<string, Buffer>(), appId = randomUUID(); let fileId = randomUUID()
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = []
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); expect(init?.headers).not.toHaveProperty("authorization")
    if (url.searchParams.get("comp") === "block") blocks.set(url.searchParams.get("blockid")!, Buffer.from(init?.body as Uint8Array))
    else { const ids = [...String(init?.body).matchAll(/<Latest>([^<]+)<\/Latest>/g)].map(m => m[1]!); wire = Buffer.concat(ids.map(id => blocks.get(id)!)) }
    return new Response(null, { status: 201 })
  })
  const graph: RestoreGraph = vi.fn(async (method, url, body) => {
    calls.push([method, url, body]); const path = new URL(url).pathname
    if (path.endsWith("/mobileApps")) {
      if (method === "POST") { app = { ...body, id: appId }; if (failCreateResponse) { failCreateResponse = false; throw new Error("Lost create response") } return { id: appId } }
      return { value: app ? [app] : [] }
    }
    if (path.endsWith("/assignments")) return { value: assigned ? [{ id: "assigned" }] : [] }
    if (path.endsWith("/contentVersions")) { if (method === "POST") { versions++; file = null; return { id: String(versions) } } return { value: Array.from({ length: versions }, (_, i) => ({ id: String(i + 1) })) } }
    if (path.endsWith("/files")) {
      if (method === "POST") { fileId = randomUUID(); file = { ...body, id: fileId, isCommitted: false, uploadState: "azureStorageUriRequestSuccess", azureStorageUri: "https://example.blob.core.windows.net/upload/file?sig=private" }; return { id: fileId } }
      return { value: file ? [file] : [] }
    }
    if (path.endsWith("/renewUpload")) { file!.uploadState = "azureStorageUriRenewalSuccess"; return {} }
    if (path.endsWith("/commit")) {
      await ingestContent(stream(wire), body!.fileEncryptionInfo as ContentEncryption, file!.size as number, async () => {})
      Object.assign(file!, { uploadState: "commitFileSuccess", isCommitted: true }); return {}
    }
    if (path.endsWith(fileId)) return file!
    if (path.endsWith(appId)) { if (method === "PATCH") Object.assign(app!, body, { publishingState: "published" }); return app! }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  return { graph, fetcher, calls, get app() { return app }, get wire() { return wire }, loseCreate: () => { failCreateResponse = true }, assign: () => { assigned = true } }
}
const options = (d: ReturnType<typeof destination>, signal = new AbortController().signal) => ({ graph: d.graph, fetch: d.fetcher as typeof fetch, signal, progress: vi.fn(), wait: async () => {} })

describe("app restore snapshots", () => {
  it("retains full scripts encrypted, survives key rotation and rejects cross-tenant reads and tampering", async () => {
    const f = await fixture(), retained = new AppSourceStore(f.root, () => [randomBytes(32), f.master])
    expect(await retained.configuration(tenant, f.source.id)).toEqual(snapshot)
    const file = join(f.root, tenant, f.source.id, "configuration.tvm"), data = await readFile(file)
    expect(data.includes(Buffer.from("setup.exe"))).toBe(false)
    await expect(retained.configuration(target, f.source.id)).rejects.toThrow()
    data[data.length - 1]! ^= 1; await writeFile(file, data)
    await expect(retained.configuration(tenant, f.source.id)).rejects.toThrow()
  })
  it("enriches an installer-only backup once with matching current settings and retains large inline scripts", async () => {
    const f = await fixture(null)
    expect(await f.store.configuration(tenant, f.source.id)).toBeNull()
    const value = structuredClone(snapshot); value.origin = "current-settings"
    value.app.rules = [{ ruleType: "detection", scriptContent: Buffer.alloc(90000, 65).toString("base64") }]
    await f.store.saveConfiguration(tenant, f.source.id, value)
    expect(await f.store.configuration(tenant, f.source.id)).toEqual(value)
    await expect(f.store.saveConfiguration(tenant, f.source.id, value)).rejects.toMatchObject({ code: "EEXIST" })
    expect((await f.store.list(tenant)).sources).toEqual([f.source])
  })
  it("omits source identifiers, assignments, scope tags and readonly fields from create payloads", () => {
    const body = restoreBody(snapshot, "Restored")
    expect(body).toMatchObject({ displayName: "Restored", roleScopeTagIds: ["0"], rules: snapshot.app.rules })
    for (const field of ["id", "assignments", "categories", "size", "committedContentVersion"]) expect(body).not.toHaveProperty(field)
  })
  it.each(["relationship", "script", "missing-rules"])("refuses unsupported %s before writes", async mode => {
    const value = structuredClone(snapshot)
    if (mode === "relationship") value.relationships.push({ targetId: randomUUID() })
    if (mode === "script") value.app.activeInstallScript = { targetId: randomUUID() }
    if (mode === "missing-rules") value.app.rules = []
    const f = await fixture(value), d = destination()
    await expect(restoreCapturedApp(f.store, f.source, value, target, "Restored", options(d))).rejects.toThrow()
    expect(d.calls).toEqual([])
  })
  it("follows beta relationship paging and rejects a mismatched settings version", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snapshot.app)).mockResolvedValueOnce(Response.json({ value: [], "@odata.nextLink": `https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/${appId}/relationships?$skiptoken=x` })).mockResolvedValueOnce(Response.json({ value: [] }))
    const value = await readRestoreSnapshot(tenant, appId, "token", fetcher, "current-settings")
    expect(value.origin).toBe("current-settings"); expect(fetcher).toHaveBeenCalledTimes(3)
    const f = await fixture()
    await expect(f.store.saveConfiguration(tenant, f.source.id, { ...value, contentVersion: "2" })).rejects.toThrow("match")
  })
})

describe("cross-tenant restore engine", () => {
  it("waits for a new file's upload URI instead of renewing before allocation", async () => {
    const f = await fixture(), d = destination(), opts = options(d); let initial = true
    opts.graph = async (method, url, body) => {
      const value = await d.graph(method, url, body)
      if (method === "GET" && value.uploadState === "azureStorageUriRequestSuccess" && initial) { initial = false; return { ...value, uploadState: "success", azureStorageUri: null } }
      return value
    }
    await restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", opts)
    expect(initial).toBe(false)
    expect(d.calls.some(([, path]) => path.endsWith("/renewUpload"))).toBe(false)
  })
  it("renews an expired issued URI without sending an action body", async () => {
    const f = await fixture(), d = destination(), opts = options(d)
    opts.graph = async (method, url, body) => {
      const value = await d.graph(method, url, body)
      return value.uploadState === "azureStorageUriRequestSuccess" ? { ...value, azureStorageUriExpirationDateTime: new Date(Date.now() - 1000).toISOString() } : value
    }
    await restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", opts)
    const renewals = d.calls.filter(([, path]) => path.endsWith("/renewUpload"))
    expect(renewals).toHaveLength(1); expect(renewals[0]![2]).toBeUndefined()
  })
  it.each(["azureStorageUriRequestFailed", "azureStorageUriRenewalFailed", "azureStorageUriRequestTimedOut"])("retains a %s draft without unsupported cleanup or duplicate creation", async state => {
    const f = await fixture(), d = destination(), opts = options(d)
    opts.graph = async (method, url, body) => {
      const value = await d.graph(method, url, body)
      if (method === "GET" && value.uploadState) value.uploadState = state
      return value
    }
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", opts)).rejects.toThrow("cannot resume this failed upload")
    const writes = d.calls.filter(([method]) => method !== "GET").length
    await expect(restoreCapturedApp(new AppSourceStore(f.root, () => [f.master]), f.source, snapshot, target, "Restored", opts)).rejects.toThrow("retained for review")
    expect(d.calls.filter(([method]) => method !== "GET")).toHaveLength(writes)
    expect(d.calls.filter(([m, p]) => m === "POST" && p.endsWith("/mobileApps"))).toHaveLength(1)
    expect(d.calls.some(([, p]) => p.endsWith("/renewUpload"))).toBe(false)
    expect(d.fetcher).not.toHaveBeenCalled()
  })
  it("uploads a fresh encrypted installer, verifies commit, publishes unassigned and retries without duplicating", async () => {
    const f = await fixture(), d = destination(), opts = options(d)
    const result = await restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", opts)
    expect(result).toMatchObject({ tenantId: target, sourceId: f.source.id, contentVersion: "1" })
    const commit = d.calls.find(([, p]) => p.endsWith("/commit"))![2]!.fileEncryptionInfo as ContentEncryption
    const written: Buffer[] = []
    await ingestContent(stream(d.wire), commit, f.plain.length, async b => { written.push(Buffer.from(b)) })
    expect(Buffer.concat(written)).toEqual(f.plain)
    expect(await restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", opts)).toEqual(result)
    expect(d.calls.filter(([m, p]) => m === "POST" && p.endsWith("/mobileApps"))).toHaveLength(1)
    expect(d.calls.some(([m, p]) => m !== "GET" && p.endsWith("/assignments"))).toBe(false)
    expect(opts.progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "completed" }))
  })
  it("reconciles a successful create whose response was lost without a second create", async () => {
    const f = await fixture(), d = destination(); d.loseCreate()
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", options(d))).rejects.toThrow("Lost create")
    const restarted = new AppSourceStore(f.root, () => [f.master])
    await restoreCapturedApp(restarted, f.source, snapshot, target, "Restored", options(d))
    expect(d.calls.filter(([m, p]) => m === "POST" && p.endsWith("/mobileApps"))).toHaveLength(1)
  })
  it("cancels mid-upload without publishing, then resumes the same app after restart", async () => {
    const f = await fixture(snapshot, true), d = destination(), controller = new AbortController(), opts = options(d, controller.signal)
    opts.progress = vi.fn(value => { if (value.phase === "uploading" && value.uploadedBytes > 0) controller.abort() })
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", opts)).rejects.toThrow()
    expect(d.calls.some(([method]) => method === "PATCH")).toBe(false)
    await restoreCapturedApp(new AppSourceStore(f.root, () => [f.master]), f.source, snapshot, target, "Restored", options(d))
    expect(d.calls.filter(([m, p]) => m === "POST" && p.endsWith("/mobileApps"))).toHaveLength(1)
  })
  it("refuses to modify a draft that someone assigned and refuses a changed retry name", async () => {
    const f = await fixture(), d = destination(); d.loseCreate()
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", options(d))).rejects.toThrow()
    d.assign()
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", options(d))).rejects.toThrow("assigned")
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Different", options(d))).rejects.toThrow("different settings")
  })
  it.each(["missing-commit", "wrong-size", "failed-commit"])("does not publish or report success for %s", async mode => {
    const f = await fixture(), d = destination(), opts = options(d)
    opts.graph = async (method, url, body) => {
      const value = await d.graph(method, url, body)
      if (value.uploadState === "commitFileSuccess") {
        if (mode === "missing-commit") return { ...value, isCommitted: false }
        if (mode === "wrong-size") return { ...value, size: f.source.bytes + 1 }
        return { ...value, uploadState: "commitFileFailed" }
      }
      return value
    }
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", opts)).rejects.toThrow()
    expect(d.calls.some(([method]) => method === "PATCH")).toBe(false)
    expect(opts.progress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "completed" }))
  })
  it("keeps an ambiguous create fail-closed when no matching destination can be found", async () => {
    const f = await fixture(), d = destination(); d.loseCreate()
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", options(d))).rejects.toThrow()
    const opts = options(d)
    opts.graph = async (method, url, body) => method === "GET" && new URL(url).pathname.endsWith("/mobileApps") ? { value: [] } : d.graph(method, url, body)
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", opts)).rejects.toThrow("could not be confirmed")
    expect(d.calls.filter(([m, p]) => m === "POST" && p.endsWith("/mobileApps"))).toHaveLength(1)
  })
  it("authenticates a corrupt installer before any destination writes", async () => {
    const f = await fixture(), d = destination(), file = join(f.root, tenant, f.source.id, "artifact.tvs"), data = await readFile(file)
    data[data.length - 1]! ^= 1; await writeFile(file, data)
    await expect(restoreCapturedApp(f.store, f.source, snapshot, target, "Restored", options(d))).rejects.toThrow()
    expect(d.calls.every(([method]) => method === "GET")).toBe(true)
  })
})

it("binds service restore to both configured tenants, captured provenance and the reviewed settings hash", async () => {
  const f = await fixture(), restore = vi.fn(async () => ({ appId: randomUUID(), tenantId: target, name: "Restored", contentVersion: "1", sourceId: f.source.id }))
  const service = new AppSourceService({ restore, knownTenant: t => [tenant, target].includes(t), folder: () => f.root, keys: () => [f.master], setFolder: vi.fn(), pickFolder: vi.fn(), pickExport: vi.fn(), openFolder: vi.fn(), confirmNewStore: vi.fn(), checkDevice: vi.fn(), signIn: vi.fn(), details: vi.fn(), apps: vi.fn(), printDetails: vi.fn(), downloadScript: vi.fn() })
  expect((await service.restoreReview(tenant, f.source.id)).settingsHash).toBe(snapshotHash(snapshot))
  expect(() => service.restore(tenant, randomUUID(), f.source.id, randomUUID(), "Restored", snapshotHash(snapshot))).toThrow("configured")
  await expect(service.restore(tenant, randomUUID(), f.source.id, target, "Restored", "0".repeat(64))).rejects.toThrow("changed")
  await service.restore(tenant, randomUUID(), f.source.id, target, "Restored", snapshotHash(snapshot))
  expect(restore).toHaveBeenCalledOnce()
})

it("keeps destination tokens off storage and rejects foreign origins before fetching", async () => {
  const fetcher = vi.fn(async () => Response.json({ value: [] })), signal = new AbortController().signal
  const graph = restoreGraph(async () => "destination-token", fetcher, signal)
  await expect(graph("POST", "https://evil.test/beta/deviceAppManagement/mobileApps", {})).rejects.toThrow()
  await expect(putRestoreBlock("https://evil.test/file?sig=secret", { comp: "block" }, Buffer.from("test"), fetcher, signal)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
  await graph("GET", "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?$top=1")
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/beta/"), expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer destination-token" }), redirect: "error" }))
})

it("uses fresh ProfileVersion1 keys and refuses altered content on the second encryption pass", async () => {
  const plain = Buffer.from("captured installer"), expected = { bytes: plain.length, sha256: createHash("sha256").update(plain).digest("hex") }, secrets = newRestoreSecrets(), result: { profile?: ContentEncryption } = {}
  for await (const _ of encryptRestoreContent(stream(plain), secrets, expected, result)) { /* First verification pass. */ }
  expect(newRestoreSecrets()).not.toEqual(secrets)
  const altered = Buffer.from(plain); altered[0]! ^= 1
  const consume = async () => { for await (const _ of encryptRestoreContent(stream(altered), secrets, expected, {}, result.profile)) { /* Upload remains uncommitted. */ } }
  await expect(consume()).rejects.toThrow("integrity")
})

it.each([401, 403, 429, 503])("reports destination HTTP %s without leaking response data", async status => {
  const graph = restoreGraph(async () => "private-token", async () => new Response("secret-service-error", { status }), new AbortController().signal)
  await expect(graph("GET", "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps")).rejects.toThrow(`HTTP ${status}`)
  await expect(graph("GET", "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps")).rejects.not.toThrow("secret-service-error")
})

it.each([200, 204])("accepts Intune's empty HTTP %s acknowledgments only for void actions", async status => {
  const graph = restoreGraph(async () => "token", async () => new Response(null, { status }), new AbortController().signal)
  const base = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/11111111-1111-1111-1111-111111111111"
  const file = `${base}/microsoft.graph.win32LobApp/contentVersions/1/files/22222222-2222-2222-2222-222222222222`
  await expect(graph("POST", `${file}/renewUpload`, {})).resolves.toEqual({})
  await expect(graph("POST", `${file}/commit`, {})).resolves.toEqual({})
  await expect(graph("PATCH", base, {})).resolves.toEqual({})
  await expect(graph("GET", base)).rejects.toThrow("no metadata")
  await expect(graph("POST", `${base}/microsoft.graph.win32LobApp/contentVersions`, {})).rejects.toThrow("no metadata")
})
it("handles a streamed empty action response and sanitizes malformed metadata", async () => {
  const base = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps"
  const graph = restoreGraph(async () => "token", async () => new Response("", { status: 200 }), new AbortController().signal)
  await expect(graph("PATCH", `${base}/11111111-1111-1111-1111-111111111111`, {})).resolves.toEqual({})
  await expect(graph("POST", base, {})).rejects.toThrow("no metadata")
  const malformed = restoreGraph(async () => "token", async () => new Response("private truncated response", { status: 200 }), new AbortController().signal)
  await expect(malformed("GET", base)).rejects.toThrow("invalid metadata")
  await expect(malformed("GET", base)).rejects.not.toThrow("private truncated")
})

it("verifies that the destination retained detection scripts and installation settings", () => {
  const body = restoreBody(snapshot, "Restored"), actual = structuredClone(body)
  expect(() => assertRestoredSettings(body, actual)).not.toThrow()
  actual.rules = [{ ruleType: "detection", scriptContent: "changed" }]
  expect(() => assertRestoredSettings(body, actual)).toThrow("rules")
})
