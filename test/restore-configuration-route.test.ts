import { afterEach, expect, it, vi } from "vitest"
import { POST } from "../src/portal/app/api/restore-configuration/route"
import { setIdentityRestoreDispatch, setIdentityRestorePreviews } from "../src/main/restore/dispatch"
import type { IdentityRestoreService } from "../src/main/restore/service"
import { requiredFeatures } from "../src/main/api/plan-gates"
import { tenantWriteTargets } from "../src/shared/tenant-writes"

const tenant = "00000000-0000-4000-8000-000000000001"
const path = "backup/AuthenticationFlowsPolicy/Flows.json"
const snapshot = { id: "AuthenticationFlowsPolicy", selfServiceSignUp: { isEnabled: false } }
const base = { tenantId: tenant, appId: "app", clientSecret: "placeholder", storageAccountName: "store", backupId: "backup", path, action: "preview", operation: "update" }
const request = (body: object) => new Request("http://localhost/api/restore-configuration", { method: "POST", body: JSON.stringify(body) }) as Parameters<typeof POST>[0]
afterEach(() => vi.unstubAllGlobals())
function world(owner = tenant) {
  const prepare = vi.fn(async () => ({ id: "run" })), review = vi.fn(async () => ({ fingerprint: "reviewed", kind: "authentication", changes: [] })), confirm = vi.fn(async () => {})
  setIdentityRestorePreviews({ prepare, review, confirm } as unknown as IdentityRestoreService)
  const restore = vi.fn(async () => ({ path, success: true }))
  setIdentityRestoreDispatch(restore)
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("oauth2")) return Response.json({ access_token: "test-token" })
    if (url.endsWith("metadata.json")) return Response.json({ TenantId: owner })
    if (url.endsWith(".tenuvault-owner.json")) return new Response(null, { status: 404 })
    if (url.endsWith("Flows.json")) return Response.json(snapshot)
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal("fetch", fetcher)
  return { prepare, review, confirm, restore, fetcher }
}
it("reads the owned snapshot instead of renderer values and requires separate confirmation", async () => {
  const state = world()
  const preview = await POST(request({ ...base, snapshot: { selfServiceSignUp: { isEnabled: true } }, allowRemoval: true }))
  expect(preview.status).toBe(200)
  expect(state.prepare).toHaveBeenCalledWith(tenant, expect.objectContaining({ path, snapshot }), "update", snapshot.id, true)
  expect(state.restore).not.toHaveBeenCalled()
  const result = await POST(request({ ...base, action: "restore", runId: "run", fingerprint: "reviewed" }))
  expect(result.status).toBe(200)
  expect(state.confirm).toHaveBeenCalledWith(tenant, "run", "reviewed")
  expect(state.restore).toHaveBeenCalledWith(tenant, expect.objectContaining({ path, snapshot, runId: "run" }))
})
it("refuses another tenant, unenabled types, bulk payloads and missing confirmation", async () => {
  const state = world("00000000-0000-4000-8000-000000000002")
  expect((await POST(request(base))).status).toBe(403)
  expect(state.prepare).not.toHaveBeenCalled()
  expect((await POST(request({ ...base, path: "backup/Organization/Org.json" }))).status).toBe(409)
  expect((await POST(request({ ...base, path: [path, path] }))).status).toBe(400)
  world()
  expect((await POST(request({ ...base, action: "restore" }))).status).toBe(409)
})
it("applies the existing replacement plan gate and first-write acknowledgement", () => {
  expect(requiredFeatures("/api/restore-configuration", base)).toEqual(["replaceRestore"])
  expect(tenantWriteTargets("/api/restore-configuration", base)).toEqual([])
  expect(tenantWriteTargets("/api/restore-configuration", { ...base, action: "restore" })).toEqual([tenant])
})
