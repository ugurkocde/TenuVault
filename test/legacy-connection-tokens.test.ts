import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SecureStore } from "../src/main/storage/secure-store"
import { TenantConnections, TENANT_LIST_KEY } from "../src/main/auth/tenant-connections"
import { accountStore } from "../src/main/auth/stores"
import { POST as restoreBackup } from "../src/portal/app/api/restore-backup/route"
import { POST as detectDrifts } from "../src/portal/app/api/detect-drifts/route"
import { routes as reportRoutes } from "../src/main/features/reports"
import { POST as restorePreview } from "../src/portal/app/api/restore-preview/route"
import { ApiHost, type RouteModule } from "../src/main/api/host"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { AuthManager } from "../src/main/auth/msal"
import { ConnectionCapabilities } from "../src/main/auth/connection-capabilities"
import { routes as promotionRoutes } from "../src/main/features/promotion"
import { routes as syncRoutes } from "../src/main/features/sync"
import { fakeDeps } from "./feature-helpers"
import { planGuard } from "../src/main/api/plan-gates"
import { BackupEngine } from "../src/main/backup/engine"
import { DELEGATED_CLIENT_SECRET, RESOURCE_SCOPES } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { graphCaller } from "../src/portal/lib/policies/graph-restore"
import { POST as listAzureResources } from "../src/portal/app/api/list-azure-resources/route"

const msal = vi.hoisted(() => ({ acquire: vi.fn() }))
vi.mock("@azure/msal-node", async importOriginal => ({
  ...await importOriginal<typeof import("@azure/msal-node")>(),
  PublicClientApplication: class {
    acquireTokenSilent = msal.acquire
    getAllAccounts = async () => [{ homeAccountId: "account", username: "fixture@example.test" }]
  },
}))

const TENANT = "a1111111-1111-1111-1111-11111111111b"
const DESTINATION = "22222222-2222-2222-2222-222222222222"
const CLIENT = "c3333333-3333-3333-3333-33333333333d"
const DESTINATION_CLIENT = "44444444-4444-4444-4444-444444444444"
const graph = "https://graph.microsoft.com/beta/"
const blob = "https://example.blob.core.windows.net/intune-backups/"
const tokenFor = (tenant: string, scope: string) => `opaque-${tenant}-${new URL(scope).hostname}`
const headers = (token: string) => ({ authorization: `Bearer ${token}` })

let dir: string | undefined
afterEach(() => {
  vi.unstubAllGlobals()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function fixture(mixed = false, dispatchInternal: (request: Request) => Promise<Response> = vi.fn()) {
  const clientFor = (tenant: string) => tenant === TENANT ? CLIENT : DESTINATION_CLIENT
  const account = (tenantId: string) => ({ tenantId, clientId: clientFor(tenantId), username: "fixture@example.test", homeAccountId: "account" })
  dir = mkdtempSync(join(tmpdir(), "tv-legacy-connection-"))
  const file = join(dir, "settings")
  const cipher = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const original = new SecureStore(file, cipher)
  const tenantId = mixed ? TENANT.replace("a", "A") : TENANT
  const clientId = mixed ? CLIENT.replace("c", "C") : CLIENT
  original.set(TENANT_LIST_KEY, JSON.stringify([
    { credentials: { tenantId, appId: clientId } },
    { credentials: { tenantId: DESTINATION, appId: DESTINATION_CLIENT } },
  ]))
  const accounts = accountStore(original)
  accounts.set({ ...account(TENANT), tenantId, clientId })
  accounts.set(account(DESTINATION))
  const saved = new SecureStore(file, cipher)
  const connections = new TenantConnections({ store: saved, coverage: () => [], signIn: {} })
  connections.migrate()
  expect(connections.get(TENANT)?.clientId).toBe(clientId)
  const cap = new ConnectionCapabilities(tenant => connections.get(tenant))
  msal.acquire.mockReset().mockImplementation(async ({ authority, scopes }) => ({
    accessToken: tokenFor(authority.split("/").at(-1)!.toLowerCase(), scopes[0]),
    scopes, expiresOn: new Date(Date.now() + 60_000),
  }))
  const auth = new AuthManager({
    fetch: vi.fn(),
    accountStore: accountStore(saved),
    cachePlugin: () => ({ beforeCacheAccess: vi.fn(), afterCacheAccess: vi.fn() }),
    openBrowser: async () => {},
    authorizeConnection: (tenant, client, scope) => cap.requireConnection(tenant, client, scope),
    authorizeIssuedToken: (tenant, client, scope, result) => cap.requireIssuedToken(tenant, client, scope, result.accessToken, result),
  })
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === "login.microsoftonline.com") {
      const form = new URLSearchParams(await request.text())
      expect(form.get("client_secret")).toBe("fixture-secret")
      return Response.json({ access_token: tokenFor(TENANT, form.get("scope")!), expires_in: 3600 })
    }
    const tenant = url.pathname.includes("destination") ? DESTINATION : TENANT
    const scope = url.hostname === "management.azure.com" ? RESOURCE_SCOPES.management
      : url.hostname.endsWith(".blob.core.windows.net") ? RESOURCE_SCOPES.storage : RESOURCE_SCOPES.graph
    expect(request.headers.get("authorization")).toBe(`Bearer ${tokenFor(tenant, scope)}`)
    if (url.hostname === "management.azure.com") {
      return Response.json({ value: url.pathname === "/subscriptions" ? [{ subscriptionId: TENANT, displayName: "Fixture" }] : [] })
    }
    if (request.method === "PUT") return new Response(null, { status: 201 })
    if (url.pathname.includes("/metadata.json")) return Response.json({ TenantId: TENANT })
    if (url.pathname.endsWith("/policy.json") || url.pathname.endsWith("/result")) return Response.json({ id: "result", displayName: "Policy" })
    if (url.hostname.endsWith(".blob.core.windows.net")) return new Response(null, { status: 404 })
    return Response.json({ value: [], id: "result" })
  })
  const getToken = (tenant: string, client: string, scope: string, fresh?: boolean) => auth.getAccessToken(tenant, client, scope, fresh)
  const fetch = createBridgedFetch({
    fetch: network, dispatch: dispatchInternal, getDelegatedToken: getToken,
    authorizeRequest: (url, input, init, tenant) => cap.authorizeRequest(url, input, init, tenant),
    bindOwnClientCredentials: (tenant, client, scope, token, expiresIn) => cap.bindOwnClientCredentials(tenant, client, scope, token, expiresIn),
  })
  const routeToken = async (scope: string, tenant = TENANT) => {
    const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_secret: DELEGATED_CLIENT_SECRET, client_id: clientFor(tenant), scope }),
    })
    expect(response.ok).toBe(true)
    return (await response.json()).access_token as string
  }
  const dispatch = (path: string, handler: NonNullable<RouteModule["POST"]>, extra: object = {}) => {
    const host = new ApiHost({ bindConnections: ids => cap.bindConnections(ids), routes: { [path]: { POST: handler } } })
    return host.dispatch(new Request("https://desktop.test" + path, {
      method: "POST", body: JSON.stringify({ tenantId: TENANT, appId: CLIENT, clientSecret: DELEGATED_CLIENT_SECRET, ...extra }),
    }))
  }
  return { cap, getToken, fetch, routeToken, dispatch, network, clientId, tenantId }
}

it.each(["scheduled", "tray"] as const)("completes a %s backup with opaque Graph and Azure Blob tokens", async trigger => {
  const f = fixture(trigger === "scheduled")
  const engine = new BackupEngine({
    fetch: f.fetch, getToken: async (...args) => (await f.getToken(...args)).accessToken,
  })
  const job = engine.start({ tenantId: f.tenantId, clientId: f.clientId, trigger, storageAccountName: "example",
    scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) } })
  expect((await engine.waitForJob(job)).status).toBe("Completed")
  expect(f.network.mock.calls.some(([url]) => String(url).startsWith(graph))).toBe(true)
  expect(f.network.mock.calls.some(([url, init]) => String(url).startsWith(blob) && init?.method === "PUT")).toBe(true)
})

it("binds an opaque Blob token from an older client credential profile", async () => {
  const f = fixture()
  const response = await f.dispatch("/api/list-backups", async () => {
    const issued = await f.fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
      method: "POST", body: new URLSearchParams({
        grant_type: "client_credentials", client_secret: "fixture-secret", client_id: CLIENT, scope: RESOURCE_SCOPES.storage,
      }),
    })
    const { access_token } = await issued.json()
    return f.fetch(blob + "backup/metadata.json", { headers: headers(access_token) })
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ TenantId: TENANT })
  expect(msal.acquire).not.toHaveBeenCalled()
})

it("discovers ARM subscriptions with a persisted mixed-case legacy profile", async () => {
  const f = fixture(true)
  vi.stubGlobal("fetch", f.fetch)
  const host = new ApiHost({ bindConnections: ids => f.cap.bindConnections(ids), routes: { "/api/list-azure-resources": { POST: listAzureResources } } })
  const response = await host.dispatch(new Request("https://desktop.test/api/list-azure-resources", {
    method: "POST", body: JSON.stringify({ tenantId: f.tenantId, appId: CLIENT, clientSecret: DELEGATED_CLIENT_SECRET }),
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ subscriptions: [{ id: TENANT }] })
})


it("previews a live restore with a persisted mixed-case legacy profile", async () => {
  const f = fixture(true)
  vi.stubGlobal("fetch", f.fetch)
  const path = "backup/DeviceConfigurations/policy.json"
  const response = await f.dispatch("/api/restore-preview", restorePreview, {
    tenantId: f.tenantId, appId: f.clientId, storageAccountName: "example", backupId: "backup", paths: [path], live: true,
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ items: [{ path, name: "Policy", live: "same" }] })
})

it.each([
  ["Graph reads for local backup routes", "/api/backup", "GET", "deviceManagement/deviceConfigurations"],
  ["policy restore", "/api/restore-backup", "POST", "deviceManagement/configurationPolicies"],
  ["OpenIntuneBaseline deployment", "/api/oib", "POST", "deviceManagement/configurationPolicies"],
  ["drift revert", "/api/revert-policy", "PATCH", "deviceManagement/configurationPolicies/policy"],
  ["live reports", "/api/reports", "GET", "deviceManagement/auditEvents"],
] as const)("dispatches %s with the opaque Graph token acquired for the admitted tenant", async (_flow, route, method, path) => {
  const f = fixture()
  const response = await f.dispatch(route, async () => {
    const token = await f.routeToken(RESOURCE_SCOPES.graph)
    const call = graphCaller(token, f.fetch, { tenant: TENANT })
    await call(method, graph + path, method === "GET" ? undefined : { name: "fixture" })
    return Response.json({ ok: true })
  })
  expect(response.status).toBe(200)
  expect(f.network).toHaveBeenCalledOnce()
})

it("copies a backup through the restore route using source Blob and destination Graph tokens", async () => {
  const f = fixture()
  const backupId = "backup-2026-09-25-120000"
  f.network.mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname.endsWith(".blob.core.windows.net")) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${tokenFor(TENANT, RESOURCE_SCOPES.storage)}`)
      if (url.pathname.endsWith("/metadata.json")) return Response.json({ Status: "Success", TenantId: TENANT })
      if (url.pathname.endsWith("/policy.json")) return Response.json({
        id: "original", displayName: "Policy", "@odata.type": "#microsoft.graph.windows10CustomConfiguration", omaSettings: [],
      })
      return new Response(null, { status: 404 })
    }
    expect(url.pathname).toBe("/beta/deviceManagement/deviceConfigurations")
    expect(request.method).toBe("POST")
    expect(request.headers.get("authorization")).toBe(`Bearer ${tokenFor(DESTINATION, RESOURCE_SCOPES.graph)}`)
    return Response.json({ id: "copied" }, { status: 201 })
  })
  vi.stubGlobal("fetch", f.fetch)
  const response = await f.dispatch("/api/restore-backup", restoreBackup, {
    backupId, storageAccountName: "example", restoreType: "selective", mode: "copy",
    selectedPolicies: [{ path: `${backupId}/DeviceConfigurations/policy.json` }],
    targetTenants: [{ tenantId: DESTINATION, appId: DESTINATION_CLIENT }],
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ success: true, details: { restoredCount: 1, results: [{ targetTenantId: DESTINATION }] } })
})

it("passes own-registration bearers through without requiring a known token or route match", async () => {
  const f = fixture()
  const response = await f.dispatch("/api/reports", async () => {
    const dest = tokenFor(DESTINATION, RESOURCE_SCOPES.graph)
    return f.fetch(graph + "destination", { headers: headers(dest) })
  })
  expect(response.status).toBe(200)
  expect(f.network).toHaveBeenCalledOnce()
})

it.each([
  ["/api/promotion", { action: "policies", sourceTenantId: DESTINATION, targetTenants: [{ tenantId: DESTINATION }] }],
  ["/api/sync", { action: "target-objects", kind: "scopeTag", targetTenantId: DESTINATION }],
] as const)("admits the validated second tenant in %s", async (path, body) => {
  const f = fixture()
  const deps = fakeDeps({ plans: { [TENANT]: "msp", [DESTINATION]: "msp" } })
  deps.graph = async tenant => {
    const token = await f.routeToken(RESOURCE_SCOPES.graph, tenant)
    return async (method, _path, payload) => {
      const response = await f.fetch(graph + (tenant === DESTINATION ? "destination" : "source"), {
        method, headers: headers(token), body: payload ? JSON.stringify(payload) : undefined,
      })
      return { status: response.status, body: await response.json() }
    }
  }
  const host = new ApiHost({
    routes: { ...promotionRoutes(deps), ...syncRoutes(deps) },
    bindConnections: tenants => {
      expect(tenants).toEqual([TENANT, DESTINATION])
      return f.cap.bindConnections(tenants)
    },
    guard: planGuard(deps.plan),
  })
  const response = await host.dispatch(new Request("https://desktop.test" + path, {
    method: "POST", body: JSON.stringify({ tenantId: TENANT, ...body }),
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(path === "/api/promotion" ? { source: [], destination: [] } : { objects: [], readable: true })
  expect(f.network).toHaveBeenCalledTimes(path === "/api/promotion" ? 2 : 1)
})

it("checks drift across two tenants and generates a report under each tenant's own sign-in", async () => {
  const f = fixture(false, request => host.dispatch(request))
  const tenantIds = [TENANT, DESTINATION]
  const backups = ["backup-2026-09-24-120000", "backup-2026-09-25-120000"]
  const storageReads = new Set<string>()
  const auditReads = new Set<string>()
  f.network.mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const tenant = url.hostname.startsWith("destination") || url.searchParams.get("fixtureTenant") === DESTINATION ? DESTINATION : TENANT
    if (url.hostname === "graph.microsoft.com") {
      expect(url.pathname).toBe("/beta/deviceManagement/auditEvents")
      expect(request.headers.get("authorization")).toBe(`Bearer ${tokenFor(tenant, RESOURCE_SCOPES.graph)}`)
      auditReads.add(tenant)
      return Response.json({ value: [] })
    }
    expect(request.headers.get("authorization")).toBe(`Bearer ${tokenFor(tenant, RESOURCE_SCOPES.storage)}`)
    storageReads.add(tenant)
    if (url.pathname.endsWith("/metadata.json")) return Response.json({ Status: "Success", TenantId: tenant })
    if (url.searchParams.has("delimiter") && url.pathname === "/intune-backups") {
      return new Response(backups.map(id => `<BlobPrefix><Name>${id}/</Name></BlobPrefix>`).join(""))
    }
    return new Response("<EnumerationResults><Blobs /></EnumerationResults>")
  })
  vi.stubGlobal("fetch", f.fetch)
  const deps = fakeDeps({ plans: { [TENANT]: "msp", [DESTINATION]: "msp" } })
  const requestBody = (tenantId: string) => ({
    tenantId, appId: tenantId === TENANT ? CLIENT : DESTINATION_CLIENT, clientSecret: DELEGATED_CLIENT_SECRET,
    storageAccountName: tenantId === TENANT ? "example" : "destination",
  })
  deps.api = (path, tenantId, body) => f.fetch("http://tenuvault.internal" + path, {
    method: "POST", body: JSON.stringify({ ...requestBody(tenantId), ...body }),
  })
  deps.graph = async tenantId => {
    const token = await f.routeToken(RESOURCE_SCOPES.graph, tenantId)
    return graphCaller(token, (input, init) => f.fetch(String(input) + "&fixtureTenant=" + tenantId, init))
  }
  const host = new ApiHost({
    routes: { ...reportRoutes(deps), "/api/detect-drifts": { POST: detectDrifts },
      "/api/revert-metadata": { POST: () => Response.json({ reverts: {} }) } },
    bindConnections: ids => f.cap.bindConnections(ids), guard: planGuard(deps.plan),
  })
  function dispatch(path: string, body: object) {
    return host.dispatch(new Request("http://tenuvault.internal" + path, { method: "POST", body: JSON.stringify(body) }))
  }
  for (const tenantId of tenantIds) {
    const drift = await dispatch("/api/detect-drifts", {
      ...requestBody(tenantId), bulk: true, targetTenants: tenantIds.filter(id => id !== tenantId).map(tenantId => ({ tenantId })),
    })
    expect(drift.status).toBe(200)
    expect(await drift.json()).toMatchObject({ backupsAnalyzed: 2 })
    const report = await dispatch("/api/reports", { tenantId, action: "generate" })
    expect(report.status).toBe(200)
    expect(await report.json()).toMatchObject({ report: { audit: "included", unchanged: true } })
  }
  expect(storageReads).toEqual(new Set(tenantIds))
  expect(auditReads).toEqual(new Set(tenantIds))
})
