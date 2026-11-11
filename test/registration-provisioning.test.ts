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
    // The stable endpoint only: the beta one names fields differently and was never run for real.
    expect(url.pathname).toMatch(/^\/v1\.0\//)
    if (url.pathname === "/v1.0/applications") return method === "GET" ? Response.json({ value: options.apps ?? [] }) : Response.json(own)
    if (url.pathname === "/v1.0/servicePrincipals") {
      const filter = url.searchParams.get("$filter") ?? ""
      const resource = DESKTOP_APP_PERMISSIONS.find(r => filter.includes(r.appId) || body?.appId === r.appId)
      if (resource) {
        const principal = { id: resource.api, oauth2PermissionScopes: resource.permissions.map((value, i) => ({ id: `${resource.api}-${i}`, value })) }
        return Response.json(method === "GET" ? { value: options.missingResource ? [] : [principal] } : principal)
      }
      return Response.json(method === "GET" ? { value: options.appPrincipal ? [options.appPrincipal] : [] } : { id: "app-sp" })
    }
    if (url.pathname === "/v1.0/oauth2PermissionGrants" && method === "GET") return Response.json({ value: options.grants ?? [] })
    if (method === "DELETE" || method === "PATCH") return new Response(null, { status: 204 })
    if (method === "POST") return Response.json({ id: "grant" })
    throw new Error(`Unhandled ${url}`)
  }) as unknown as typeof fetch
  const run = (signal?: AbortSignal) => provisionRegistration({ fetch: request, token: "ephemeral", tenantId: "tenant", username: "admin", progress, sleep, signal })
  return { run, calls, sleep, progress, probes }
}
// Tenant-wide admin consent on Microsoft Graph that covers Intune: what marks a registration as one
// an administrator already trusted.
const INTUNE = "DeviceManagementApps.ReadWrite.All"
const consent = (scope = INTUNE, id = "g") => ({ id, resourceId: "Microsoft Graph", consentType: "AllPrincipals", scope })
const trusted = { appPrincipal: { id: "app-sp" }, grants: [consent()] }
const failure = (status: number, message = "failed", headers?: HeadersInit) => Response.json({ error: { message } }, { status, headers })
describe("registration provisioning", () => {
  it("creates the default registration, service principal and all consent bodies", async () => {
    const f = fixture({ missingResource: true })
    expect(await f.run()).toMatchObject({ clientId: "client", reused: false, ready: true })
    const app = f.calls.find(c => c.url.pathname === "/v1.0/applications" && c.method === "POST")!
    expect(app.body).toEqual({ displayName: "TenuVault Desktop", signInAudience: "AzureADMyOrg", notes: "Used by the TenuVault desktop app. Delegated permissions only, no credentials.", publicClient: { redirectUris: ["http://localhost"] }, requiredResourceAccess: DESKTOP_APP_PERMISSIONS.map(r => ({ resourceAppId: r.appId, resourceAccess: r.permissions.map((_, i) => ({ id: `${r.api}-${i}`, type: "Scope" })) })) })
    expect(f.calls.find(c => c.body?.appId === "client")?.body?.tags).toEqual(["HideApp", "WindowsAzureActiveDirectoryIntegratedApp"])
    expect(f.calls.filter(c => c.url.pathname === "/v1.0/oauth2PermissionGrants" && c.method === "POST").map(c => c.body)).toEqual(DESKTOP_APP_PERMISSIONS.map(r => ({ clientId: "app-sp", consentType: "AllPrincipals", resourceId: r.api, scope: r.permissions.join(" ") })))
  })
  it("uses the oldest approved registration as it is, writes nothing, and reports what its consent lacks", async () => {
    const f = fixture({ appPrincipal: { id: "app-sp" }, apps: [{ ...own, createdDateTime: "2025-01-01", appId: "older" }, own], grants: [consent(`Extra.Scope User.Read ${INTUNE}`), { id: "personal", resourceId: "Azure Storage", consentType: "Principal", scope: "user_impersonation" }] })
    expect(await f.run()).toMatchObject({
      reused: true, clientId: "older",
      // A user's own consent is not tenant-wide, so Azure Storage counts as lacking.
      missingConsent: [...DESKTOP_APP_PERMISSIONS[0]!.permissions.filter(scope => scope !== "User.Read" && scope !== INTUNE), "user_impersonation (Azure Service Management)", "user_impersonation (Azure Storage)"],
    })
    // Only reads go to Microsoft Graph: the one write-free request left is the sign-in service's probe.
    expect(f.calls.filter(c => c.method !== "GET").map(c => c.url.pathname)).toEqual(["/tenant/oauth2/v2.0/devicecode"])
  })
  it("reports nothing as lacking when the reused registration has the whole default consent", async () => {
    const grants = DESKTOP_APP_PERMISSIONS.map((resource, i) => ({ id: `g${i}`, resourceId: resource.api, consentType: "AllPrincipals", scope: resource.permissions.join(" ") }))
    expect(await fixture({ appPrincipal: { id: "app-sp" }, apps: [own], grants }).run()).toMatchObject({ reused: true, missingConsent: [] })
  })
  it("does not add a Microsoft API the tenant has not used yet while it uses an existing registration", async () => {
    // Microsoft Graph is there, the two Azure APIs are not.
    const f = fixture({ ...trusted, apps: [own], fail: (url, init) => (init.method ?? "GET") === "GET" && url.pathname.endsWith("servicePrincipals") && /797f4846|e406a681/.test(url.searchParams.get("$filter") ?? "") ? Response.json({ value: [] }) : undefined })
    expect(await f.run()).toMatchObject({ reused: true, missingConsent: expect.arrayContaining(["user_impersonation (Azure Service Management)", "user_impersonation (Azure Storage)"]) })
    expect(f.calls.some(c => c.method === "POST" && c.url.pathname.endsWith("servicePrincipals"))).toBe(false)
  })
  it.each([
    { displayName: "Fabrikam Desktop" }, { notes: "foreign" }, { signInAudience: "AzureADMultipleOrgs" }, { publicClient: { redirectUris: [] } },
    // No longer what TenuVault makes: it can answer somewhere else, or it holds a credential.
    { publicClient: { redirectUris: ["http://localhost", "https://example.invalid/callback"] } },
    { web: { redirectUris: ["https://example.invalid/callback"] } }, { spa: { redirectUris: ["https://example.invalid/callback"] } },
    { passwordCredentials: [{ keyId: "secret" }] }, { keyCredentials: [{ keyId: "certificate" }] },
  ])("does not reuse a foreign registration, even one with admin consent (%j)", async change => {
    const f = fixture({ ...trusted, apps: [{ ...own, id: "foreign-app", appId: "foreign", ...change }] })
    expect(await f.run()).toMatchObject({ clientId: "client", reused: false, candidateCount: 0 })
    expect(f.calls.some(c => c.url.searchParams.get("$filter")?.includes("foreign"))).toBe(false)
  })
  it("reuses one that also has the redirect addresses Microsoft offers for desktop apps", async () => {
    const f = fixture({ ...trusted, apps: [{ ...own, publicClient: { redirectUris: ["http://localhost", "https://login.microsoftonline.com/common/oauth2/nativeclient", "ms-appx-web://Microsoft.AAD.BrokerPlugin/client"] } }] })
    expect(await f.run()).toMatchObject({ clientId: "client", reused: true })
  })
  // A registration somebody put into the tenant: TenuVault's name, note and redirect address, and
  // a client ID of its own. Any member of a tenant can create one and stays its owner.
  const planted = (state: { principal?: object | null; grants?: object[] }) => fixture({
    apps: [{ ...own, id: "planted-app", appId: "planted" }],
    fail: (url) => {
      const filter = url.searchParams.get("$filter")
      if (url.pathname.endsWith("servicePrincipals") && filter === "appId eq 'planted'") return Response.json({ value: state.principal === null ? [] : [state.principal ?? { id: "planted-sp" }] })
      if (url.pathname.endsWith("oauth2PermissionGrants") && filter === "clientId eq 'planted-sp'") return Response.json({ value: state.grants ?? [] })
      return undefined
    },
  })
  it.each<[string, { principal?: object | null; grants?: object[] }]>([
    ["has no enterprise application", { principal: null }],
    ["has no consent", {}],
    ["has only the consent a user gave for themselves", { grants: [{ ...consent(), consentType: "Principal", principalId: "user" }] }],
    ["has tenant-wide consent that covers nothing of Intune", { grants: [consent("User.Read Organization.Read.All")] }],
    ["has tenant-wide consent for another API only", { grants: [{ ...consent(), resourceId: "custom-api" }] }],
    ["has sign-in turned off and no consent", { principal: { id: "planted-sp", accountEnabled: false } }],
  ])("creates its own registration and gives no consent to one that %s", async (_name, state) => {
    const f = planted(state)
    expect(await f.run()).toMatchObject({ clientId: "client", reused: false, candidateCount: 0 })
    expect(f.calls.some(c => c.method === "POST" && c.url.pathname === "/v1.0/applications")).toBe(true)
    // Nothing is written to it: no enterprise application, no consent, no change.
    for (const call of f.calls.filter(c => c.method !== "GET")) expect(`${call.url.href} ${JSON.stringify(call.body ?? {})}`).not.toContain("planted")
    expect(f.calls.filter(c => c.method === "POST" && c.url.pathname.endsWith("oauth2PermissionGrants")).map(c => c.body?.clientId)).toEqual(DESKTOP_APP_PERMISSIONS.map(() => "app-sp"))
  })
  it("reuses another marked TenuVault name with no extra lookup requests", async () => {
    const f = fixture({ ...trusted, apps: [{ ...own, displayName: "TenuVault Desktop (Lab)" }] })
    expect(await f.run()).toMatchObject({ displayName: "TenuVault Desktop (Lab)", candidateCount: 1, reused: true })
    expect(f.calls.filter(c => c.method === "GET" && c.url.pathname.endsWith("servicePrincipals"))).toHaveLength(4)
    expect(f.calls.filter(c => c.method === "GET" && c.url.pathname.endsWith("oauth2PermissionGrants"))).toHaveLength(1)
    expect(f.calls.find(c => c.url.pathname.endsWith("applications"))!.url.searchParams.get("$filter")).toBe("startswith(displayName,'TenuVault')")
  })
  // Two registrations that carry the note and admin consent: "client" from 2026 and "other" from 2025.
  const two = (other: { principal?: object | null; grants?: object[] }, mine: object[] = [consent()]) => fixture({
    appPrincipal: { id: "app-sp" }, apps: [own, { ...own, id: "other-app", appId: "other", displayName: "TenuVault Desktop (Lab)", createdDateTime: "2025-01-01" }], grants: mine,
    fail: (url) => {
      const filter = url.searchParams.get("$filter")
      if (url.pathname.endsWith("servicePrincipals") && filter === "appId eq 'other'") return Response.json({ value: other.principal === null ? [] : [other.principal ?? { id: "other-sp" }] })
      if (url.pathname.endsWith("oauth2PermissionGrants") && filter === "clientId eq 'other-sp'") return Response.json({ value: other.grants ?? [consent()] })
      return undefined
    },
  })
  it("prefers the registration whose consent covers more of TenuVault's permissions, such as one a switch added", async () => {
    const f = two({}, [consent(`${INTUNE} Mail.Send`)])
    expect(await f.run()).toMatchObject({ clientId: "client", displayName: "TenuVault Desktop", candidateCount: 2, reused: true })
  })
  it("does not count consent for anything TenuVault does not use", async () => {
    // Unrelated consent on the older one must not be what decides: the newer one covers more of TenuVault's.
    const f = two({ grants: [consent(), { id: "x", resourceId: "custom-api", consentType: "AllPrincipals", scope: "A.Read B.Read C.Read" }] }, [consent(`${INTUNE} User.Read`)])
    expect(await f.run()).toMatchObject({ clientId: "client", candidateCount: 2 })
  })
  it("among equals uses the oldest, and names it", async () => {
    const f = two({})
    expect(await f.run()).toMatchObject({ clientId: "other", displayName: "TenuVault Desktop (Lab)", candidateCount: 2, reused: true })
    expect(f.calls.some(c => c.method === "DELETE" || c.method === "POST" && c.url.pathname.endsWith("applications"))).toBe(false)
    // Each candidate costs two reads, and the chosen one's reads are not repeated.
    expect(f.calls.filter(c => c.method === "GET" && (c.url.pathname.endsWith("servicePrincipals") || c.url.pathname.endsWith("oauth2PermissionGrants")))).toHaveLength(7)
  })
  it("skips a registration whose enterprise application has sign-in turned off while another one matches", async () => {
    const f = two({ principal: { id: "other-sp", accountEnabled: false } })
    expect(await f.run()).toMatchObject({ clientId: "client", candidateCount: 2 })
    expect(f.calls.filter(c => c.method === "GET" && (c.url.pathname.endsWith("servicePrincipals") || c.url.pathname.endsWith("oauth2PermissionGrants")))).toHaveLength(7)
  })
  it("passes over a registration without an enterprise application and does not create one for it", async () => {
    const f = two({ principal: null })
    expect(await f.run()).toMatchObject({ clientId: "client", candidateCount: 1, reused: true })
    expect(f.calls.some(c => c.method === "POST" && c.url.pathname.endsWith("servicePrincipals"))).toBe(false)
  })
  it("changes nothing when every matching registration has sign-in turned off, and names the one it found", async () => {
    const f = fixture({ grants: [consent()], appPrincipal: { id: "app-sp", accountEnabled: false }, apps: [own, { ...own, id: "other-app", appId: "other", displayName: "TenuVault Desktop (Lab)", createdDateTime: "2025-01-01" }], fail: (url) => url.pathname.endsWith("servicePrincipals") && url.searchParams.get("$filter") === "appId eq 'other'" ? Response.json({ value: [{ id: "other-sp", accountEnabled: false }] }) : undefined })
    await expect(f.run()).rejects.toThrow('"TenuVault Desktop (Lab)" (client id other), but sign-in to its enterprise application is turned off')
    expect(f.calls.some(c => c.method !== "GET")).toBe(false)
  })
  it.each([404, 400])("retries replication errors (%i)", async status => {
    let attempts = 0
    const f = fixture({ fail: (url, init) => url.pathname === "/v1.0/servicePrincipals" && init.method === "POST" && ++attempts < 3 ? failure(status, "does not reference a valid application object") : undefined })
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
    const f = fixture({ fail: (url, init) => url.pathname === "/v1.0/applications" && init.method === "POST" ? failure(503) : undefined })
    await expect(f.run()).rejects.toThrow("failed")
    expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1)
  })
  it("reports 403 and removes the application it created", async () => {
    const f = fixture({ fail: (url, init) => url.pathname === "/v1.0/oauth2PermissionGrants" && init.method === "POST" ? failure(403) : undefined })
    const error = await f.run().then(() => { throw new Error("Expected failure") }, error => error as Error)
    expect(error.message).toContain("signed-in account admin")
    // Microsoft's own reason stays in the message, for refusals that are not about the role.
    expect(error.message).toContain("failed")
    for (const role of CONSENT_ROLES) expect(error.message).toContain(role)
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(1)
    expect(error.message).toContain("The half-created app registration was removed again.")
  })
  it("never deletes or changes a registration it did not create, whatever Microsoft Graph answers to writes", async () => {
    const f = fixture({ ...trusted, apps: [own], fail: (url, init) => url.origin === "https://graph.microsoft.com" && (init.method ?? "GET") !== "GET" ? failure(403) : undefined })
    expect(await f.run()).toMatchObject({ reused: true, clientId: "client" })
    expect(f.calls.some(c => c.url.origin === "https://graph.microsoft.com" && c.method !== "GET")).toBe(false)
  })
  it("reports failed cleanup with the client ID", async () => {
    const f = fixture({ fail: (url, init) => init.method === "DELETE" || url.pathname === "/v1.0/oauth2PermissionGrants" && init.method === "POST" ? failure(403) : undefined })
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
    const f = fixture({ apps: [own], grants: [consent()], appPrincipal: { id: "app-sp", accountEnabled: false } })
    await expect(f.run()).rejects.toThrow("sign-in to its enterprise application is turned off")
    expect(f.calls.some(c => c.method !== "GET")).toBe(false)
  })
  it("names the fields it reads when it lists app registrations and service principals", async () => {
    const f = fixture()
    await f.run()
    const select = (path: string) => f.calls.find(c => c.method === "GET" && c.url.pathname === path)!.url.searchParams.get("$select")
    expect(select("/v1.0/applications")).toBe("id,appId,displayName,notes,signInAudience,publicClient,web,spa,passwordCredentials,keyCredentials,createdDateTime")
    expect(select("/v1.0/servicePrincipals")).toBe("id,appId,accountEnabled,oauth2PermissionScopes")
  })
  it("repeats a read that got no answer", async () => {
    let first = true
    const f = fixture({ fail: () => { if (first) { first = false; throw new TypeError("fetch failed") } return undefined } })
    expect(await f.run()).toMatchObject({ ready: true })
    expect(f.calls.filter(c => c.url.pathname === "/v1.0/servicePrincipals" && c.method === "GET").length).toBeGreaterThan(3)
  })
  it("does not repeat a write that got no answer, and removes the registration it created", async () => {
    const f = fixture({ fail: (url, init) => { if (url.pathname === "/v1.0/oauth2PermissionGrants" && init.method === "POST") throw new TypeError("fetch failed"); return undefined } })
    const error = await f.run().then(() => { throw new Error("Expected failure") }, caught => caught as Error)
    expect(error.message).toContain("The half-created app registration was removed again.")
    expect(error.message).toContain("Microsoft Graph did not answer")
    expect(f.calls.filter(c => c.url.pathname === "/v1.0/oauth2PermissionGrants" && c.method === "POST")).toHaveLength(1)
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
    // The first report follows the sign-in at once.
    expect(f.progress.mock.calls.map(([value]) => value.phase)).toEqual(["registration", "registration", "consent", "publishing"])
    expect(f.calls[0]!.url.pathname).toBe("/v1.0/servicePrincipals")
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
    const f = fixture({ fail: () => Response.json({ value: [], "@odata.nextLink": "https://example.invalid/v1.0/applications" }) })
    await expect(f.run()).rejects.toThrow("Unexpected Graph paging address")
    expect(f.calls).toHaveLength(1)
  })
})

it("cancels provisioning and still cleans up the new registration", async () => {
  const controller = new AbortController()
  const f = fixture({ fail: (url, init) => {
    if (url.pathname.endsWith("oauth2PermissionGrants") && init.method === "POST") controller.abort()
    return undefined
  } })
  await expect(f.run(controller.signal)).rejects.toThrow("Sign-in cancelled.")
  expect(f.calls.some(call => call.method === "DELETE")).toBe(true)
  expect(f.probes).toHaveLength(0)
})

it.each([false, true])("cancels a publication sleep promptly and keeps the committed registration, ready: %s", async ready => {
  const controller = new AbortController()
  const f = fixture({ unknown: ready ? 0 : 99 })
  let sleeping!: () => void
  const started = new Promise<void>(resolve => { sleeping = resolve })
  f.sleep.mockImplementationOnce(() => { sleeping(); return new Promise(() => {}) })
  const pending = f.run(controller.signal)
  await started
  controller.abort()
  // This run created the registration, so the cancel says that it stays and is used next time.
  await expect(pending).rejects.toThrow('Setup was cancelled. The app registration "TenuVault Desktop" (client id client) stays in your tenant, and the next setup uses it.')
  expect(f.probes).toHaveLength(1)
  expect(f.calls.some(call => call.method === "DELETE")).toBe(false)
})

it("cancels a publication request in flight", async () => {
  const controller = new AbortController()
  const f = fixture()
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("devicecode")) {
      controller.abort()
      expect(init?.signal?.aborted).toBe(true)
      throw new Error("aborted")
    }
    return Response.json({ value: [] })
  })
  // Use the normal fixture through provisioning, then block only the publication probe.
  const pending = provisionRegistration({
    fetch: async (input, init) => String(input).includes("devicecode") ? request(input, init) : Response.json(
      String(input).includes("applications") ? { value: [own] } :
      String(input).includes("oauth2PermissionGrants") ? { value: [consent()] } :
      { value: [{ id: String(input).includes("00000003") ? "Microsoft Graph" : "app-sp" }] }),
    token: "ephemeral", tenantId: "tenant", username: "admin", signal: controller.signal, progress: f.progress,
  })
  await expect(pending).rejects.toThrow("Sign-in cancelled.")
  expect(request).toHaveBeenCalledOnce()
})

it("lets a create request in flight finish when cancelled, then removes what it created", async () => {
  const controller = new AbortController()
  let createSignal: AbortSignal | null | undefined
  const f = fixture({ fail: (url, init) => {
    if (url.pathname === "/v1.0/applications" && init.method === "POST") { createSignal = init.signal; controller.abort() }
    return undefined
  } })
  await expect(f.run(controller.signal)).rejects.toThrow("The half-created app registration was removed again. Sign-in cancelled.")
  // The admin's cancel never cut the POST off, so its answer carried the ID the cleanup deletes.
  expect(createSignal?.aborted).toBe(false)
  expect(f.calls.filter(call => call.method === "DELETE").map(call => call.url.pathname)).toEqual(["/v1.0/applications/app"])
  expect(f.probes).toHaveLength(0)
})

it("ends a Graph retry wait at once when cancelled", async () => {
  const controller = new AbortController()
  let first = true
  const f = fixture({ fail: () => first ? (first = false, failure(429, "busy", { "Retry-After": "60" })) : undefined })
  f.sleep.mockImplementationOnce(() => { controller.abort(); return new Promise(() => {}) })
  await expect(f.run(controller.signal)).rejects.toThrow("Sign-in cancelled.")
  expect(f.sleep).toHaveBeenCalledExactlyOnceWith(60_000)
  expect(f.calls).toHaveLength(1)
})

it("sends a cancel during the last consent request through the cleanup", async () => {
  const controller = new AbortController()
  let grants = 0
  const f = fixture({ fail: (url, init) => {
    if (url.pathname === "/v1.0/oauth2PermissionGrants" && init.method === "POST" && ++grants === DESKTOP_APP_PERMISSIONS.length) controller.abort()
    return undefined
  } })
  await expect(f.run(controller.signal)).rejects.toThrow("The half-created app registration was removed again. Sign-in cancelled.")
  expect(grants).toBe(DESKTOP_APP_PERMISSIONS.length)
  expect(f.calls.filter(call => call.method === "DELETE")).toHaveLength(1)
  expect(f.probes).toHaveLength(0)
})
