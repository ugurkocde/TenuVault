import { describe, expect, it, vi } from "vitest"
import { provisionRegistration } from "../src/main/auth/registration-provisioning"
import { CONSENT_ROLES, DESKTOP_APP_PERMISSIONS } from "../src/shared/app-registration"

const own = { id: "app", appId: "client", notes: "Used by the TenuVault desktop app", signInAudience: "AzureADMyOrg", publicClient: { redirectUris: ["http://localhost"] }, createdDateTime: "2026-01-01" }
function fixture(options: { apps?: object[]; grants?: object[]; fail?: (url: URL, init: RequestInit, count: number) => Response | undefined; unknown?: number; missingResource?: boolean } = {}) {
  let probes = 0
  const calls: { url: URL; method: string; body?: Record<string, unknown> }[] = []
  const sleep = vi.fn(async () => undefined)
  const checkTenant = vi.fn(async () => undefined)
  const request = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? "GET"
    const body = init.body && !url.pathname.endsWith("devicecode") ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const failed = options.fail?.(url, init, calls.length)
    if (failed) return failed
    if (url.pathname.endsWith("devicecode")) {
      expect(init.headers).not.toHaveProperty("Authorization")
      expect(new URLSearchParams(String(init.body)).get("client_id")).toBe("client")
      return ++probes <= (options.unknown ?? 0) ? Response.json({ error: "unauthorized_client", error_codes: [700016] }, { status: 400 }) : Response.json({ device_code: "unused" })
    }
    expect(url.origin).toBe("https://graph.microsoft.com")
    expect(url.pathname).toMatch(/^\/beta\//)
    if (url.pathname === "/beta/applications") return method === "GET" ? Response.json({ value: options.apps ?? [] }) : Response.json(own)
    if (url.pathname === "/beta/servicePrincipals") {
      const filter = url.searchParams.get("$filter") ?? ""
      const resource = DESKTOP_APP_PERMISSIONS.find(r => filter.includes(r.appId) || body?.appId === r.appId)
      if (resource) {
        const principal = { id: resource.api, publishedPermissionScopes: resource.permissions.map((value, i) => ({ id: `${resource.api}-${i}`, value })) }
        return Response.json(method === "GET" ? { value: options.missingResource ? [] : [principal] } : principal)
      }
      return Response.json(method === "GET" ? { value: [] } : { id: "app-sp" })
    }
    if (url.pathname === "/beta/oauth2PermissionGrants" && method === "GET") return Response.json({ value: options.grants ?? [] })
    if (method === "DELETE" || method === "PATCH") return new Response(null, { status: 204 })
    if (method === "POST") return Response.json({ id: "grant" })
    throw new Error(`Unhandled ${url}`)
  }) as unknown as typeof fetch
  const run = (signal?: AbortSignal) => provisionRegistration({ fetch: request, token: "ephemeral", tenantId: "tenant", username: "admin", checkTenant, progress: vi.fn(), sleep, signal })
  return { run, calls, sleep, checkTenant }
}
const failure = (status: number, message = "failed", headers?: HeadersInit) => Response.json({ error: { message } }, { status, headers })
describe("registration provisioning", () => {
  it("creates the default registration, service principal and all consent bodies", async () => {
    const f = fixture({ missingResource: true })
    expect(await f.run()).toMatchObject({ clientId: "client", reused: false, ready: true })
    const app = f.calls.find(c => c.url.pathname === "/beta/applications" && c.method === "POST")!
    expect(app.body).toEqual({ displayName: "TenuVault Desktop", signInAudience: "AzureADMyOrg", notes: "Used by the TenuVault desktop app. Delegated permissions only, no credentials.", publicClient: { redirectUris: ["http://localhost"] }, requiredResourceAccess: DESKTOP_APP_PERMISSIONS.map(r => ({ resourceAppId: r.appId, resourceAccess: r.permissions.map((_, i) => ({ id: `${r.api}-${i}`, type: "Scope" })) })) })
    expect(f.calls.find(c => c.body?.appId === "client")?.body?.tags).toEqual(["HideApp", "WindowsAzureActiveDirectoryIntegratedApp"])
    expect(f.calls.filter(c => c.url.pathname === "/beta/oauth2PermissionGrants" && c.method === "POST").map(c => c.body)).toEqual(DESKTOP_APP_PERMISSIONS.map(r => ({ clientId: "app-sp", consentType: "AllPrincipals", resourceId: r.api, scope: r.permissions.join(" ") })))
  })
  it("reuses the newest owned registration, unions scopes and creates missing grants", async () => {
    const f = fixture({ apps: [{ ...own, createdDateTime: "2025-01-01", appId: "older" }, own], grants: [{ id: "g", resourceId: "Microsoft Graph", consentType: "AllPrincipals", scope: "Extra.Scope User.Read" }, { id: "personal", resourceId: "Azure Storage", consentType: "Principal", scope: "user_impersonation" }] })
    expect(await f.run()).toMatchObject({ reused: true })
    expect(f.calls.some(c => c.url.pathname === "/beta/applications" && c.method === "POST")).toBe(false)
    expect(f.calls.find(c => c.method === "PATCH")?.body?.scope).toBe(`Extra.Scope ${DESKTOP_APP_PERMISSIONS[0]!.permissions.join(" ")}`)
    expect(f.calls.filter(c => c.url.pathname === "/beta/oauth2PermissionGrants" && c.method === "POST")).toHaveLength(2)
  })
  it.each([{ notes: "foreign" }, { signInAudience: "AzureADMultipleOrgs" }, { publicClient: { redirectUris: [] } }])("does not reuse a foreign registration (%j)", async change => {
    expect(await fixture({ apps: [{ ...own, ...change }] }).run()).toMatchObject({ reused: false })
  })
  it.each([404, 400])("retries replication errors (%i)", async status => {
    let attempts = 0
    const f = fixture({ fail: (url, init) => url.pathname === "/beta/servicePrincipals" && init.method === "POST" && ++attempts < 3 ? failure(status, "does not reference a valid application object") : undefined })
    await f.run()
    expect(f.sleep).toHaveBeenCalledWith(3000)
    expect(attempts).toBe(3)
  })
  it("honors Retry-After", async () => {
    let first = true
    const f = fixture({ fail: () => first ? (first = false, failure(429, "busy", { "Retry-After": "8" })) : undefined })
    await f.run()
    expect(f.sleep).toHaveBeenCalledWith(8000)
  })
  it("does not retry ambiguous create failures", async () => {
    const f = fixture({ fail: (url, init) => url.pathname === "/beta/applications" && init.method === "POST" ? failure(503) : undefined })
    await expect(f.run()).rejects.toThrow("failed")
    expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1)
  })
  it.each([false, true])("reports 403 and rolls back only a new application (reused %s)", async reused => {
    const f = fixture({ apps: reused ? [own] : [], fail: (url, init) => url.pathname === "/beta/oauth2PermissionGrants" && init.method === "POST" ? failure(403) : undefined })
    const error = await f.run().then(() => { throw new Error("Expected failure") }, error => error as Error)
    expect(error.message).toContain("signed-in account admin")
    for (const role of CONSENT_ROLES) expect(error.message).toContain(role)
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(reused ? 0 : 1)
    if (!reused) expect(error.message).toContain("was removed")
  })
  it("reports failed cleanup with the client ID", async () => {
    const f = fixture({ fail: (url, init) => init.method === "DELETE" || url.pathname === "/beta/oauth2PermissionGrants" && init.method === "POST" ? failure(403) : undefined })
    await expect(f.run()).rejects.toThrow("Cleanup failed. Delete app registration TenuVault Desktop (client id client)")
  })
  it("waits for an unknown registration to become known", async () => {
    const f = fixture({ unknown: 2 })
    expect(await f.run()).toMatchObject({ ready: true })
    expect(f.sleep.mock.calls).toEqual([[2000], [2000], [2000]])
  })
  it("returns IDs when Microsoft never publishes the registration", async () => {
    const f = fixture({ unknown: Infinity })
    expect(await f.run()).toMatchObject({ clientId: "client", ready: false })
    expect(f.calls.filter(c => c.url.pathname.endsWith("devicecode"))).toHaveLength(45)
  })
  it("refuses the plan before any Graph write or read", async () => {
    const f = fixture()
    f.checkTenant.mockRejectedValueOnce(new Error("Community limit"))
    await expect(f.run()).rejects.toThrow("Community limit")
    expect(f.calls).toHaveLength(0)
  })
  it("cancels before provisioning", async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(f.run(controller.signal)).rejects.toThrow("Sign-in cancelled.")
    expect(f.calls).toHaveLength(0)
  })
  it("rejects a paging link outside Graph without sending a token", async () => {
    const f = fixture({ fail: () => Response.json({ value: [], "@odata.nextLink": "https://example.invalid/beta/applications" }) })
    await expect(f.run()).rejects.toThrow("Unexpected Graph paging address")
    expect(f.calls).toHaveLength(1)
  })
})
