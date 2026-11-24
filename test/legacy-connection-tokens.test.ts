import { afterEach, expect, it, vi } from "vitest"
import { ApiHost } from "../src/main/api/host"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { AuthManager } from "../src/main/auth/msal"
import { ConnectionCapabilities } from "../src/main/auth/connection-capabilities"
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

const TENANT = "11111111-1111-1111-1111-111111111111"
const DESTINATION = "22222222-2222-2222-2222-222222222222"
const CLIENT = "33333333-3333-3333-3333-333333333333"
const DESTINATION_CLIENT = "44444444-4444-4444-4444-444444444444"
const graph = "https://graph.microsoft.com/beta/"
const blob = "https://example.blob.core.windows.net/intune-backups/"
const tokenFor = (tenant: string, scope: string) => `opaque-${tenant}-${new URL(scope).hostname}`
const headers = (token: string) => ({ authorization: `Bearer ${token}` })

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const clientFor = (tenant: string) => tenant === TENANT ? CLIENT : DESTINATION_CLIENT
  const account = (tenantId: string) => ({ tenantId, clientId: clientFor(tenantId), username: "fixture@example.test", homeAccountId: "account" })
  const cap = new ConnectionCapabilities(tenant => ({
    version: 1, origin: "legacy", method: "ownApp", clientId: clientFor(tenant), createdAt: "", updatedAt: "",
  }))
  msal.acquire.mockReset().mockImplementation(async ({ authority, scopes }) => ({
    accessToken: tokenFor(authority.split("/").at(-1)!, scopes[0]),
    scopes, expiresOn: new Date(Date.now() + 60_000),
  }))
  const auth = new AuthManager({
    fetch: vi.fn(),
    accountStore: { get: account, set: vi.fn(), list: vi.fn(), delete: vi.fn() },
    cachePlugin: () => ({ beforeCacheAccess: vi.fn(), afterCacheAccess: vi.fn() }),
    openBrowser: async () => {},
    authorizeConnection: (tenant, client, scope) => cap.requireConnection(tenant, client, scope),
    authorizeIssuedToken: (tenant, client, scope, result) => cap.requireIssuedToken(tenant, client, scope, result.accessToken, result),
  })
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const tenant = url.pathname.includes("destination") ? DESTINATION : TENANT
    const scope = url.hostname === "management.azure.com" ? RESOURCE_SCOPES.management
      : url.hostname.endsWith(".blob.core.windows.net") ? RESOURCE_SCOPES.storage : RESOURCE_SCOPES.graph
    expect(request.headers.get("authorization")).toBe(`Bearer ${tokenFor(tenant, scope)}`)
    if (url.hostname === "management.azure.com") {
      return Response.json({ value: url.pathname === "/subscriptions" ? [{ subscriptionId: TENANT, displayName: "Fixture" }] : [] })
    }
    if (request.method === "PUT") return new Response(null, { status: 201 })
    if (url.pathname.includes("/metadata.json")) return Response.json({ TenantId: TENANT })
    return Response.json({ value: [], id: "result" })
  })
  const getToken = (tenant: string, client: string, scope: string, fresh?: boolean) => auth.getAccessToken(tenant, client, scope, fresh)
  const fetch = createBridgedFetch({
    fetch: network, dispatch: vi.fn(), getDelegatedToken: getToken,
    authorizeRequest: (url, input, init, tenant) => cap.authorizeRequest(url, input, init, tenant),
  })
  const routeToken = async (scope: string, tenant = TENANT) => {
    const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_secret: DELEGATED_CLIENT_SECRET, client_id: clientFor(tenant), scope }),
    })
    expect(response.ok).toBe(true)
    return (await response.json()).access_token as string
  }
  const dispatch = (path: string, handler: () => Promise<Response>, extra: object = {}) => {
    const host = new ApiHost({ bindConnections: ids => cap.bindConnections(ids), routes: { [path]: { POST: handler } } })
    return host.dispatch(new Request("https://desktop.test" + path, {
      method: "POST", body: JSON.stringify({ tenantId: TENANT, appId: CLIENT, clientSecret: DELEGATED_CLIENT_SECRET, ...extra }),
    }))
  }
  return { cap, getToken, fetch, routeToken, dispatch, network }
}

it.each(["scheduled", "tray"] as const)("completes a %s backup with opaque Graph and Azure Blob tokens", async trigger => {
  const f = fixture()
  const engine = new BackupEngine({
    fetch: f.fetch, getToken: async (...args) => (await f.getToken(...args)).accessToken,
  })
  const job = engine.start({ tenantId: TENANT, clientId: CLIENT, trigger, storageAccountName: "example",
    scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) } })
  expect((await engine.waitForJob(job)).status).toBe("Completed")
  expect(f.network.mock.calls.some(([url]) => String(url).startsWith(graph))).toBe(true)
  expect(f.network.mock.calls.some(([url, init]) => String(url).startsWith(blob) && init?.method === "PUT")).toBe(true)
})

it("discovers ARM subscriptions through the Azure resource route", async () => {
  const f = fixture()
  vi.stubGlobal("fetch", f.fetch)
  const host = new ApiHost({ bindConnections: ids => f.cap.bindConnections(ids), routes: { "/api/list-azure-resources": { POST: listAzureResources } } })
  const response = await host.dispatch(new Request("https://desktop.test/api/list-azure-resources", {
    method: "POST", body: JSON.stringify({ tenantId: TENANT, appId: CLIENT, clientSecret: DELEGATED_CLIENT_SECRET }),
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ subscriptions: [{ id: TENANT }] })
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

it("uses opaque source Blob and destination Graph tokens for Copy to Tenants", async () => {
  const f = fixture()
  const response = await f.dispatch("/api/restore-backup", async () => {
    const storageToken = await f.routeToken(RESOURCE_SCOPES.storage)
    const targetToken = await f.routeToken(RESOURCE_SCOPES.graph, DESTINATION)
    await f.fetch(blob + "backup/metadata.json", { headers: headers(storageToken) })
    await graphCaller(targetToken, f.fetch, { tenant: DESTINATION })("POST", graph + "deviceManagement/configurationPolicies/destination", { name: "fixture" })
    return Response.json({ ok: true })
  }, { targetTenants: [{ tenantId: DESTINATION, appId: DESTINATION_CLIENT }] })
  expect(response.status).toBe(200)
  expect(f.network).toHaveBeenCalledTimes(2)
})
