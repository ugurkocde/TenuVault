import { afterEach, expect, it, vi } from "vitest"
const execute = vi.hoisted(() => vi.fn(async () => ({ runId: "run", rows: [] })))
vi.mock("../src/main/restore/directory-dispatch", () => ({ directoryRestoreRequest: execute }))
import { POST } from "../src/portal/app/api/restore-directory/route"
import { requiredFeatures } from "../src/main/api/plan-gates"
import { tenantWriteTargets } from "../src/shared/tenant-writes"
const tenant = "00000000-0000-4000-8000-000000000001", path = "backup/Groups/00000000-0000-4000-8000-000000000010.json"
const base = { tenantId: tenant, appId: "app", clientSecret: "placeholder", storageAccountName: "store", backupId: "backup", path, action: "preview", stage: "object", mode: "replace" }
const request = (body: object) => new Request("http://localhost/api/restore-directory", { method: "POST", body: JSON.stringify(body) }) as Parameters<typeof POST>[0]
afterEach(() => { vi.unstubAllGlobals(); execute.mockClear() })
function world(owner = tenant) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("oauth2")) return Response.json({ access_token: "test-token" })
    if (url.endsWith("metadata.json")) return Response.json({ TenantId: owner })
    if (url.endsWith(".tenuvault-owner.json")) return new Response(null, { status: 404 })
    return Response.json({ id: "stored", displayName: "Owned group" })
  }))
}
it("reads the owned snapshot and ignores renderer identity and snapshot inputs", async () => {
  world()
  expect((await POST(request({ ...base, snapshot: { displayName: "Injected" }, actor: { userId: "injected" } }))).status).toBe(200)
  expect(execute).toHaveBeenCalledWith(tenant, expect.objectContaining({ snapshot: { id: "stored", displayName: "Owned group" }, origin: "restore" }), expect.objectContaining({ options: { stage: "object", exactMembers: false, exactOwners: false } }), expect.any(Function), undefined)
})
it("refuses another tenant, malformed stage, bulk paths and unrelated types", async () => {
  world("00000000-0000-4000-8000-000000000002")
  expect((await POST(request(base))).status).toBe(403)
  expect(execute).not.toHaveBeenCalled()
  expect((await POST(request({ ...base, stage: "all" }))).status).toBe(400)
  expect((await POST(request({ ...base, path: [path] }))).status).toBe(400)
  expect((await POST(request({ ...base, path: "backup/Organization/o.json" }))).status).toBe(409)
})
it("uses the replacement feature gate and first-write acknowledgement only for execution", () => {
  expect(requiredFeatures("/api/restore-directory", base)).toEqual(["replaceRestore"])
  expect(tenantWriteTargets("/api/restore-directory", base)).toEqual([])
  expect(tenantWriteTargets("/api/restore-directory", { ...base, action: "restore" })).toEqual([tenant])
  expect(tenantWriteTargets("/api/restore-directory", { ...base, action: "cancel" })).toEqual([])
})
