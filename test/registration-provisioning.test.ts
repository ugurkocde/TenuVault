import { describe, expect, it, vi } from "vitest"
import { provisionRegistration } from "../src/main/auth/registration-provisioning"
import { CONSENT_ROLES, DESKTOP_APP_PERMISSIONS } from "../src/shared/app-registration"

const own = { displayName: "TenuVault Desktop", id: "app", appId: "client", notes: "Used by the TenuVault desktop app", signInAudience: "AzureADMyOrg", publicClient: { redirectUris: ["http://localhost"] }, createdDateTime: "2026-01-01" }
function fixture(options: { apps?: object[]; grants?: object[]; fail?: (url: URL, init: RequestInit, count: number) => Response | undefined; unknown?: number; missingResource?: boolean; appPrincipal?: object; probe?: () => Response } = {}) {
  // What the sign-in service was asked. Checked after the run: the probe swallows its own errors.
  const probes: { clientId: string | null; authorization: unknown }[] = []
  const calls: { url: URL; method: string; body?: Record<string, unknown> }[] = []
  const sleep = vi.fn(async () => undefined)
  const progress = vi.fn()
  const request = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? "GET"
    const body = init.body && !url.pathname.endsWith("devicecode") ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const failed = options.fail?.(url, init, calls.length)
    if (failed) return failed
    if (url.pathname.endsWith("devicecode")) {
      probes.push({ clientId: new URLSearchParams(String(init.body)).get("client_id"), authorization: (init.headers as Record<string, unknown>).Authorization })
      if (options.probe) return options.probe()
      return probes.length <= (options.unknown ?? 0) ? Response.json({ error: "unauthorized_client", error_codes: [700016] }, { status: 400 }) : Response.json({ device_code: "unused" })
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
      return Response.json(method === "GET" ? { value: options.appPrincipal ? [options.appPrincipal] : [] } : { id: "app-sp" })
    }
    if (url.pathname === "/beta/oauth2PermissionGrants" && method === "GET") return Response.json({ value: options.grants ?? [] })
    if (method === "DELETE" || method === "PATCH") return new Response(null, { status: 204 })
    if (method === "POST") return Response.json({ id: "grant" })
    throw new Error(`Unhandled ${url}`)
  }) as unknown as typeof fetch
  const run = (signal?: AbortSignal) => provisionRegistration({ fetch: request, token: "ephemeral", tenantId: "tenant", username: "admin", progress, sleep, signal })
  return { run, calls, sleep, progress, probes }
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
  it("reuses the oldest owned registration, unions scopes and creates missing grants", async () => {
    const f = fixture({ appPrincipal: { id: "app-sp" }, apps: [{ ...own, createdDateTime: "2025-01-01", appId: "older" }, own], grants: [{ id: "g", resourceId: "Microsoft Graph", consentType: "AllPrincipals", scope: "Extra.Scope User.Read" }, { id: "personal", resourceId: "Azure Storage", consentType: "Principal", scope: "user_impersonation" }] })
    expect(await f.run()).toMatchObject({ reused: true, clientId: "older" })
    expect(f.calls.some(c => c.url.pathname === "/beta/applications" && c.method === "POST")).toBe(false)
    expect(f.calls.find(c => c.method === "PATCH")?.body?.scope).toBe(`Extra.Scope ${DESKTOP_APP_PERMISSIONS[0]!.permissions.join(" ")}`)
    expect(f.calls.filter(c => c.url.pathname === "/beta/oauth2PermissionGrants" && c.method === "POST")).toHaveLength(2)
  })
  it.each([{ displayName: "Fabrikam Desktop" }, { notes: "foreign" }, { signInAudience: "AzureADMultipleOrgs" }, { publicClient: { redirectUris: [] } }])("does not reuse a foreign registration (%j)", async change => {
    expect(await fixture({ apps: [{ ...own, ...change }] }).run()).toMatchObject({ reused: false })
  })
  it("reuses another marked TenuVault name with no extra lookup requests", async () => {
    const f = fixture({ apps: [{ ...own, displayName: "TenuVault Desktop (Lab)" }] })
    expect(await f.run()).toMatchObject({ displayName: "TenuVault Desktop (Lab)", candidateCount: 1, reused: true })
    expect(f.calls.filter(c => c.method === "GET" && c.url.pathname.endsWith("servicePrincipals"))).toHaveLength(4)
    expect(f.calls.find(c => c.url.pathname.endsWith("applications"))!.url.searchParams.get("$filter")).toBe("startswith(displayName,'TenuVault')")
  })
  it.each([false, true])("prefers most tenant-wide consent and skips disabled candidates (%s)", async disabled => {
    const f = fixture({ appPrincipal: { id: "app-sp" }, apps: [own, { ...own, appId: "other", createdDateTime: "2025-01-01" }], fail: (url) => {
      if (url.pathname.endsWith("servicePrincipals") && url.searchParams.get("$filter") === "appId eq 'other'") return Response.json({ value: [{ id: "other-sp", accountEnabled: !disabled }] })
      if (url.pathname.endsWith("oauth2PermissionGrants") && url.searchParams.get("$filter") === "clientId eq 'other-sp'") return Response.json({ value: [{ id: "extra", resourceId: "custom", consentType: "AllPrincipals", scope: "Extra.Read Extra.Write" }] })
      return undefined
    } })
    expect(await f.run()).toMatchObject({ clientId: disabled ? "client" : "other", candidateCount: 2 })
    expect(f.calls.some(c => c.method === "DELETE" || c.method === "POST" && c.url.pathname.endsWith("applications"))).toBe(false)
    // Each extra enabled candidate costs two GETs, or one when disabled. Reuse cached reads.
    expect(f.calls.filter(c => c.method === "GET" && (c.url.pathname.endsWith("servicePrincipals") || c.url.pathname.endsWith("oauth2PermissionGrants")))).toHaveLength(disabled ? 6 : 7)
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
    // Microsoft's own reason stays in the message, for refusals that are not about the role.
    expect(error.message).toContain("failed")
    for (const role of CONSENT_ROLES) expect(error.message).toContain(role)
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(reused ? 0 : 1)
    if (!reused) expect(error.message).toContain("The half-created app registration was removed again.")
  })
  it("reports failed cleanup with the client ID", async () => {
    const f = fixture({ fail: (url, init) => init.method === "DELETE" || url.pathname === "/beta/oauth2PermissionGrants" && init.method === "POST" ? failure(403) : undefined })
    await expect(f.run()).rejects.toThrow("Cleanup failed. Delete app registration TenuVault Desktop (client id client)")
  })
  it("waits for an unknown registration to become known", async () => {
    const f = fixture({ unknown: 2 })
    expect(await f.run()).toMatchObject({ ready: true })
    expect(f.sleep.mock.calls).toEqual([[2000], [2000], [5000]])
  })
  it("returns IDs when Microsoft never publishes the registration", async () => {
    const f = fixture({ unknown: Infinity })
    expect(await f.run()).toMatchObject({ clientId: "client", ready: false })
    expect(f.calls.filter(c => c.url.pathname.endsWith("devicecode"))).toHaveLength(45)
    for (const probe of f.probes) expect(probe).toEqual({ clientId: "client", authorization: undefined })
  })
  it("asks the sign-in service about the new app without sending the setup token", async () => {
    const f = fixture({ unknown: 1 })
    await f.run()
    expect(f.probes).toEqual([{ clientId: "client", authorization: undefined }, { clientId: "client", authorization: undefined }])
  })
  it("takes any other refusal of the sign-in service as knowing the app", async () => {
    const f = fixture({ probe: () => Response.json({ error: "invalid_client", error_codes: [7000218] }, { status: 400 }) })
    expect(await f.run()).toMatchObject({ ready: true })
    expect(f.probes).toHaveLength(1)
  })
  it("keeps waiting while the sign-in service is unavailable", async () => {
    let calls = 0
    const f = fixture({ probe: () => ++calls < 3 ? Response.json({ error: "temporarily_unavailable" }, { status: 503 }) : Response.json({ device_code: "unused" }) })
    expect(await f.run()).toMatchObject({ ready: true })
    expect(f.probes).toHaveLength(3)
  })
  it("stops at a reused registration whose enterprise application is turned off, without touching consent", async () => {
    const f = fixture({ apps: [own], appPrincipal: { id: "app-sp", accountEnabled: false } })
    await expect(f.run()).rejects.toThrow("sign-in to its enterprise application is turned off")
    expect(f.calls.some(c => c.url.pathname.includes("oauth2PermissionGrants"))).toBe(false)
    expect(f.calls.some(c => c.method !== "GET")).toBe(false)
  })
  it("names the fields it reads when it lists app registrations and service principals", async () => {
    const f = fixture()
    await f.run()
    const select = (path: string) => f.calls.find(c => c.method === "GET" && c.url.pathname === path)!.url.searchParams.get("$select")
    expect(select("/beta/applications")).toBe("id,appId,displayName,notes,signInAudience,publicClient,createdDateTime")
    expect(select("/beta/servicePrincipals")).toBe("id,appId,accountEnabled,publishedPermissionScopes")
  })
  it("repeats a read that got no answer", async () => {
    let first = true
    const f = fixture({ fail: () => { if (first) { first = false; throw new TypeError("fetch failed") } return undefined } })
    expect(await f.run()).toMatchObject({ ready: true })
    expect(f.calls.filter(c => c.url.pathname === "/beta/servicePrincipals" && c.method === "GET").length).toBeGreaterThan(3)
  })
  it("does not repeat a write that got no answer, and removes the registration it created", async () => {
    const f = fixture({ fail: (url, init) => { if (url.pathname === "/beta/oauth2PermissionGrants" && init.method === "POST") throw new TypeError("fetch failed"); return undefined } })
    const error = await f.run().then(() => { throw new Error("Expected failure") }, caught => caught as Error)
    expect(error.message).toContain("The half-created app registration was removed again.")
    expect(error.message).toContain("Microsoft Graph did not answer")
    expect(f.calls.filter(c => c.url.pathname === "/beta/oauth2PermissionGrants" && c.method === "POST")).toHaveLength(1)
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(1)
  })
  it("sets a deadline on every Graph request", async () => {
    const signals: unknown[] = []
    const f = fixture({ fail: (_url, init) => { signals.push(init.signal); return undefined } })
    await f.run()
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal)
  })
  it("reports each phase in order", async () => {
    const f = fixture()
    await f.run()
    // The first report follows the sign-in at once, so the browser wait stops being cancellable.
    expect(f.progress.mock.calls.map(([value]) => value.phase)).toEqual(["registration", "registration", "consent", "publishing"])
    expect(f.calls[0]!.url.pathname).toBe("/beta/servicePrincipals")
  })
  it("caps a long Retry-After at one minute", async () => {
    let first = true
    const f = fixture({ fail: () => first ? (first = false, failure(429, "busy", { "Retry-After": "900" })) : undefined })
    await f.run()
    expect(f.sleep).toHaveBeenCalledWith(60_000)
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
