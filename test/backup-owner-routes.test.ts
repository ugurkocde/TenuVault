import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST as restoreBackup } from "../src/portal/app/api/restore-backup/route"
import { POST as restoreValidate } from "../src/portal/app/api/restore-validate/route"
import { POST as restorePreview } from "../src/portal/app/api/restore-preview/route"
import { POST as listBackupContents } from "../src/portal/app/api/list-backup-contents/route"
import { POST as downloadBackup } from "../src/portal/app/api/download-backup/route"
import { POST as backupChanges } from "../src/portal/app/api/backup-changes/route"
import { ownedBy } from "../src/portal/lib/policies/backup-owner"

const OWN = "11111111-1111-1111-1111-111111111111"
const OTHER = "22222222-2222-2222-2222-222222222222"
const backupId = "backup-2026-09-25-120000"
const policyPath = `${backupId}/DeviceConfigurations/Example.json`
const snapshot = { id: "original", displayName: "Example", "@odata.type": "#microsoft.graph.windows10CustomConfiguration", omaSettings: [] }
const base = { tenantId: OWN, appId: "app", clientSecret: "placeholder", storageAccountName: "storage", backupId, subscriptionId: "sub", resourceGroupName: "rg" }
const request = (path: string, data: object) => new NextRequest(`http://tenuvault.internal${path}`, { method: "POST", body: JSON.stringify(data) })
afterEach(() => vi.unstubAllGlobals())

/** Stubs token and blob reads; records every Graph call. */
function stubStorage(blobs: Record<string, unknown>) {
  const graph: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
    if (url.hostname.endsWith(".blob.core.windows.net")) {
      if (url.searchParams.get("comp") === "list") {
        const prefix = url.searchParams.get("prefix") ?? ""
        const names = Object.keys(blobs).filter((name) => name.startsWith(prefix))
        const body = url.searchParams.get("delimiter")
          ? [...new Set(names.map((name) => name.split("/")[0]))].map((name) => `<BlobPrefix><Name>${name}/</Name></BlobPrefix>`).join("")
          : names.map((name) => `<Blob><Name>${name}</Name><Properties><Content-Length>2</Content-Length></Properties></Blob>`).join("")
        return new Response(`<EnumerationResults><Blobs>${body}</Blobs><NextMarker></NextMarker></EnumerationResults>`)
      }
      const name = url.pathname.split("/").slice(2).map(decodeURIComponent).join("/")
      if (!(name in blobs)) return new Response("", { status: 404 })
      return Response.json(blobs[name], { headers: { "x-tenuvault-authenticated": "true" } })
    }
    graph.push(`${init?.method ?? "GET"} ${url.pathname}`)
    return Response.json({ id: "created" }, { status: 201 })
  }))
  return graph
}

const routes: Array<[string, (request: NextRequest) => Promise<Response>, object]> = [
  ["/api/restore-backup", restoreBackup as never, { restoreType: "selective", selectedPolicies: [{ path: policyPath }] }],
  ["/api/restore-validate", restoreValidate as never, {}],
  ["/api/restore-preview", restorePreview as never, { paths: [policyPath] }],
  ["/api/list-backup-contents", listBackupContents as never, {}],
  ["/api/download-backup", downloadBackup as never, {}],
  ["/api/backup-changes", backupChanges as never, {}],
]

describe("backup routes refuse another tenant's backup", () => {
  it.each(routes)("%s answers 403 for a backup recorded for another tenant, before any Graph call", async (path, handler, extra) => {
    const graph = stubStorage({ [`${backupId}/metadata.json`]: { TenantId: OTHER, Status: "Success" }, [policyPath]: snapshot })
    const response = await handler(request(path, { ...base, ...extra }))
    expect(response.status).toBe(403)
    expect((await response.json()).error).toMatch(/another tenant/)
    expect(graph).toEqual([])
  })

  it.each(routes)("%s still serves the tenant's own backup", async (path, handler, extra) => {
    stubStorage({ [`${backupId}/metadata.json`]: { TenantId: OWN.toUpperCase(), Status: "Success" }, [policyPath]: snapshot })
    const response = await handler(request(path, { ...base, ...extra }))
    expect(response.status).not.toBe(403)
  })

  it("compares changes only with an older backup of the same tenant", async () => {
    const older = "backup-2026-09-24-120000"
    const foreign = "backup-2026-09-25-000000"
    const fingerprint = (tenantId: string) => ({ TenantId: tenantId, Status: "Success", Items: {}, SkippedTypes: [], FailedTypes: [], ExcludedTypes: [] })
    stubStorage({
      [`${backupId}/metadata.json`]: fingerprint(OWN),
      [`${foreign}/metadata.json`]: fingerprint(OTHER),
      [`${older}/metadata.json`]: fingerprint(OWN),
    })
    const response = await backupChanges(request("/api/backup-changes", base))
    expect(response.status).toBe(200)
    expect((await response.json()).comparedWith).toBe(older)
  })

  it("allows older backups that record no tenant", () => {
    expect(ownedBy(null, OWN)).toBe(true)
    expect(ownedBy({ Status: "Success" }, OWN)).toBe(true)
    expect(ownedBy({ TenantId: OTHER }, OWN)).toBe(false)
  })
})

describe("backups without metadata and unreadable metadata", () => {
  const marker = `${backupId}/.tenuvault-owner.json`

  it.each(routes)("%s refuses a backup without metadata whose ownership marker names another tenant", async (path, handler, extra) => {
    const graph = stubStorage({ [marker]: { TenantId: OTHER }, [policyPath]: snapshot })
    const response = await handler(request(path, { ...base, ...extra }))
    expect(response.status).toBe(403)
    expect(graph).toEqual([])
  })

  it.each(routes)("%s refuses metadata sealed for another tenant instead of treating it as legacy", async (path, handler, extra) => {
    stubStorage({ [policyPath]: snapshot })
    const sealed = Object.assign(new Error("sealed"), { name: "FetchApplicationError" })
    const inner = globalThis.fetch
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("metadata.json") ? Promise.reject(sealed) : inner(input, init)))
    const response = await handler(request(path, { ...base, ...extra }))
    expect(response.status).toBe(403)
  })

  it("revert-policy refuses to restore a file from another tenant's backup", async () => {
    const { POST: revertPolicy } = await import("../src/portal/app/api/revert-policy/route")
    const graph = stubStorage({ [`${backupId}/metadata.json`]: { TenantId: OTHER }, [policyPath]: snapshot })
    const response = await revertPolicy(request("/api/revert-policy", { ...base, action: "restore", policyId: "original", policyType: "DeviceConfigurations", backupPath: policyPath }) as never)
    expect(response.status).toBe(403)
    expect(graph).toEqual([])
  })
})
