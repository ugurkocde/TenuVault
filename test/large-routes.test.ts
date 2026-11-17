import { afterEach, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { ApiHost } from "../src/main/api/host"
import { POST as contents } from "../src/portal/app/api/list-backup-contents/route"
import { POST as compare } from "../src/portal/app/api/large-backup-page/route"
import { POST as download } from "../src/portal/app/api/download-backup/route"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
const tenant = "11111111-1111-1111-1111-111111111111", backup = "backup-2026-11-16-000000", before = "backup-2026-11-15-000000"
const snapshot = { id: "one" }, entry = { id: "one", file: "one.json", hash: snapshotHash(snapshot) }
const metadata = { TenantId: tenant, BackupFolder: backup, Status: "Success", Failures: 0, Coverage: "Complete", Items: {}, LargeItems: { DeviceConfigurations: { version: 1, count: 1, shards: 1, complete: true } }, Scope: { Included: ["DeviceConfigurations"] }, ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 } }
const body = { tenantId: tenant, appId: "client", clientSecret: "placeholder", subscriptionId: "local", resourceGroupName: "local", storageAccountName: "contoso", backupId: backup, largeInventory: true }
const request = (extra = {}) => new NextRequest("http://tenuvault.internal/api/test", { method: "POST", body: JSON.stringify({ ...body, ...extra }) })
afterEach(() => vi.unstubAllGlobals())
function install(foreign = false) {
  const read: string[] = []
  vi.stubGlobal("fetch", vi.fn(async input => {
    const url = new URL(String(input)); read.push(url.pathname + url.search)
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "storage" })
    if (url.pathname.endsWith("metadata.json")) return Response.json({ ...metadata, BackupFolder: url.pathname.includes(before) ? before : backup, TenantId: foreign ? "22222222-2222-2222-2222-222222222222" : tenant })
    if (url.pathname.endsWith("000000.json")) return Response.json([entry])
    if (url.pathname.endsWith("one.json")) return Response.json(snapshot)
    return new Response(null, { status: 404 })
  }))
  return read
}
it("serves one contents page without requesting a blob listing or snapshots", async () => {
  const reads = install()
  const response = await contents(request())
  expect(response.status).toBe(200)
  expect((await response.json()).content.groups[0].policies).toHaveLength(1)
  expect(reads.some(path => path.includes("comp=list") || path.endsWith("one.json"))).toBe(false)
})
it("compares a bounded inventory page after verifying ownership of both backups", async () => {
  const reads = install()
  const response = await compare(request({ baseline: before, folder: "DeviceConfigurations" }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ unchanged: 1, changes: [], next: null })
  expect(reads.filter(path => path.endsWith("metadata.json"))).toHaveLength(2)
  expect(reads.some(path => path.endsWith("one.json"))).toBe(false)
})
it("refuses a foreign inventory without reading its shards", async () => {
  const reads = install(true)
  expect((await compare(request({ baseline: before, folder: "DeviceConfigurations" }))).status).toBe(403)
  expect(reads.some(path => path.includes("_index"))).toBe(false)
})
it("streams large downloads through the host save destination rather than buffering for IPC", async () => {
  const reads = install()
  let bytes = 0
  const host = new ApiHost({ routes: { "/api/download-backup": { POST: download } }, saveDownload: async response => {
    expect(response.headers.get("content-type")).toBe("application/x-tar")
    for await (const chunk of response.body!) bytes += chunk.length
    return Response.json({ saved: true })
  } })
  const result = await host.handleIpc({ path: "/api/download-backup", method: "POST", headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) })
  expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({ saved: true })
  expect(bytes).toBeGreaterThan(2048)
  expect(reads.some(path => path.includes("comp=list"))).toBe(false)
})
it("validates the paging request before sending anything to Microsoft", async () => {
  const reads = install()
  expect((await compare(new NextRequest("http://tenuvault.internal/api/test", { method: "POST", body: "{}" }))).status).toBe(400)
  expect(reads).toEqual([])
})
