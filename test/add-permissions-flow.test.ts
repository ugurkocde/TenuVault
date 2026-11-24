import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Configuration } from "@azure/msal-node"
import type { LoopbackSignInRequest } from "../src/main/auth/loopback-sign-in"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
const mock = vi.hoisted(() => ({ signIn: vi.fn(), clear: vi.fn(), config: null as Configuration | null }))
vi.mock("@azure/msal-node", () => ({ PublicClientApplication: class { constructor(config: Configuration) { mock.config = config }; clearCache = mock.clear } }))
vi.mock("../src/main/auth/loopback-sign-in", () => ({ loopbackSignIn: mock.signIn }))
import { AddPermissionsFlow, permissionAdditionScopes, signInForPermissionAddition, verifyPermissionAdditionToken } from "../src/main/auth/add-permissions-flow"
import { additionConnection, additionGraph } from "./fixtures/registration-additions"
const tenant = additionConnection.tenantId
const controllers: AddPermissionsFlow[] = []
beforeEach(() => { vi.clearAllMocks(); mock.signIn.mockResolvedValue({ accessToken: "ephemeral", account: additionConnection }) })
afterEach(() => { for (const flow of controllers.splice(0)) flow.cancel(tenant); vi.useRealTimers() })
function fixture() {
  const fake = additionGraph()
  const host = { fetch: fake.request, connection: vi.fn(async () => structuredClone(additionConnection)), signIn: vi.fn(async () => "ephemeral"), refresh: vi.fn(async () => {}) }
  const flow = new AddPermissionsFlow(host); controllers.push(flow)
  return { flow, host, ...fake }
}
function token(claims: object) { return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature` }
// Execute the actual host wiring so tests cover both token acquisition boundaries in index.ts.
function connectedFlow(original: { accessToken: string; scopes: string[] }, refreshed = original, method = "ownApp") {
  const fake = additionGraph()
  const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8")
  const source = main.slice(main.indexOf("  const permissionAdditions = new AddPermissionsFlow("), main.indexOf('  handleTrusted("services:previewAddition"'))
  const health = { check: vi.fn(async () => {}) }
  const auth = { getAccessToken: vi.fn(async (_tenant: string, _client: string, _scope: string, force?: boolean) => force ? refreshed : original) }
  const signIn = vi.fn(async () => "ephemeral")
  const context = { AddPermissionsFlow, permissionAdditionScopes, verifyPermissionAdditionToken, chromiumFetch: fake.request,
    connections: { get: () => ({ method }) }, capabilities: { requireWrite: () => undefined }, connectedTenant: () => tenant, accounts: new Map([[tenant, additionConnection]]), tenantProfile: () => additionConnection,
    moduleSettings: { get: () => ({}) }, additionPermissions: () => additionConnection.allowed, auth,
    RESOURCE_SCOPES: { graph: "https://graph.microsoft.com/.default" }, signInForPermissionAddition: signIn, shell: {}, health }
  const flow: AddPermissionsFlow = new Function(...Object.keys(context), `${transformSync(source, { loader: "ts" }).code}\nreturn permissionAdditions`)(...Object.values(context))
  controllers.push(flow)
  return { flow, auth, health, signIn, ...fake }
}
it("directs shared sign-in to its own consent flow before acquiring any setup token", async () => {
  const { flow, writes, auth, signIn } = connectedFlow({ accessToken: token({ scp: "User.Read" }), scopes: [] }, undefined, "tenuvaultApp")
  await expect(flow.preview(tenant, ["Policy.Read.All"])).rejects.toThrow("Review the TenuVault app packs")
  expect(auth.getAccessToken).not.toHaveBeenCalled()
  expect(signIn).not.toHaveBeenCalled()
  expect(writes).toEqual([])
})

it.each([{ scopes: ["https://graph.microsoft.com/User.Read"] }, { scopes: ["https://graph.microsoft.com/.default", "openid", "profile"] }])("reads connected and refreshed delegated claims instead of MSAL response scopes $scopes", async ({ scopes }) => {
  const { flow, writes, auth, health } = connectedFlow(
    { accessToken: token({ scp: "user.read" }), scopes },
    { accessToken: token({ scp: "USER.READ policy.read.all" }), scopes },
  )
  const preview = await flow.preview(tenant, ["Policy.Read.All"])
  expect(preview.consent).toEqual(["Policy.Read.All"])
  expect((await flow.confirm(tenant, preview.id)).state).toBe("complete")
  expect(writes).toHaveLength(2)
  expect(auth.getAccessToken).toHaveBeenLastCalledWith(tenant, additionConnection.clientId, "https://graph.microsoft.com/.default", true)
  expect(health.check).toHaveBeenCalledWith(tenant, "again")
})
it("reports a partial result when only MSAL response scopes contain an approved addition", async () => {
  const { flow } = connectedFlow({ accessToken: token({ scp: "User.Read" }), scopes: ["User.Read", "Policy.Read.All"] })
  const preview = await flow.preview(tenant, ["Policy.Read.All"])
  const result = await flow.confirm(tenant, preview.id)
  expect(result.state).toBe("partial")
  expect(result.message).toContain("The refreshed token still lacks Policy.Read.All")
})
it.each([token({ roles: ["User.Read", "Policy.Read.All"] }), "unreadable", token({})])("refuses unreadable or application claims at both connected token boundaries", async accessToken => {
  const invalid = { accessToken, scopes: ["User.Read", "Policy.Read.All"] }
  const previewHost = connectedFlow(invalid)
  await expect(previewHost.flow.preview(tenant, ["Policy.Read.All"])).rejects.toThrow("delegated Graph account")
  expect(previewHost.signIn).not.toHaveBeenCalled()
  expect(previewHost.writes).toEqual([])
  const refreshHost = connectedFlow({ accessToken: token({ scp: "User.Read" }), scopes: [] }, invalid)
  const preview = await refreshHost.flow.preview(tenant, ["Policy.Read.All"])
  const result = await refreshHost.flow.confirm(tenant, preview.id)
  expect(result.state).toBe("partial")
  expect(result.message).toContain("delegated Graph account")
})
it("uses the exact setup-only scopes in an ephemeral Microsoft client with a tenant and account hint", async () => {
  const browser = vi.fn(async () => {})
  mock.signIn.mockImplementation(async (request: LoopbackSignInRequest) => {
    expect(request.loginHint).toBe(additionConnection.username)
    expect(request.scopes).toEqual(["https://graph.microsoft.com/Application.ReadWrite.All", "https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All"])
    await request.openBrowser("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize")
    return { account: additionConnection, accessToken: "ephemeral" }
  })
  expect(await signInForPermissionAddition(additionConnection, fetch, browser, new AbortController().signal)).toBe("ephemeral")
  expect(mock.config?.auth).toEqual({ clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e", authority: `https://login.microsoftonline.com/${tenant}` })
  expect(mock.config).not.toHaveProperty("cache")
  expect(mock.clear).toHaveBeenCalledOnce()
  expect(browser).toHaveBeenCalledOnce()
})
it.each(["tenantId", "username", "homeAccountId"])("rejects another %s after setup sign-in", async field => {
  mock.signIn.mockResolvedValue({ accessToken: "ephemeral", account: { ...additionConnection, [field]: "different" } })
  await expect(signInForPermissionAddition(additionConnection, fetch, async () => {}, new AbortController().signal)).rejects.toThrow("same tenant and account")
  expect(mock.clear).toHaveBeenCalledOnce()
})
it("refuses non-Microsoft browser addresses and clears privileged cache on failure", async () => {
  mock.signIn.mockImplementation((request: LoopbackSignInRequest) => request.openBrowser("https://elsewhere.test"))
  await expect(signInForPermissionAddition(additionConnection, fetch, async () => {}, new AbortController().signal)).rejects.toThrow("unexpected sign-in address")
  expect(mock.clear).toHaveBeenCalledOnce()
})
it("keeps the preview server-side and refreshes health after verified changes", async () => {
  const { flow, host } = fixture()
  const preview = await flow.preview(tenant, ["Policy.Read.All"])
  expect(JSON.stringify(preview)).not.toContain("ephemeral")
  const result = await flow.confirm(tenant, preview.id)
  expect(result.state).toBe("complete")
  expect(host.refresh).toHaveBeenCalledWith(additionConnection, ["Policy.Read.All"])
  await expect(flow.confirm(tenant, preview.id)).rejects.toThrow("expired")
})
it("reports refresh failures as partial with an escape route", async () => {
  const { flow, host } = fixture()
  host.refresh.mockRejectedValue(new Error("The refreshed token still lacks Policy.Read.All."))
  const preview = await flow.preview(tenant, ["Policy.Read.All"])
  const result = await flow.confirm(tenant, preview.id)
  expect(result.state).toBe("partial")
  expect(result.message).toContain("sign in again")
  expect(result.message).toContain("Policy.Read.All")
})
it("does not refresh when state changed since preview", async () => {
  const { flow, host, state } = fixture()
  const preview = await flow.preview(tenant, ["Policy.Read.All"])
  state.grants[0]!.scope += " Other.Read"
  expect((await flow.confirm(tenant, preview.id)).state).toBe("changed")
  expect(host.refresh).not.toHaveBeenCalled()
})
it.each(["preview", "confirm"])("refuses a connection change during %s", async phase => {
  const { flow, host, writes } = fixture()
  if (phase === "preview") host.connection.mockResolvedValueOnce(additionConnection).mockResolvedValue({ ...additionConnection, username: "other" })
  if (phase === "preview") await expect(flow.preview(tenant, ["Policy.Read.All"])).rejects.toThrow("changed")
  else {
    const preview = await flow.preview(tenant, ["Policy.Read.All"])
    host.connection.mockResolvedValue({ ...additionConnection, allowed: [] })
    await expect(flow.confirm(tenant, preview.id)).rejects.toThrow("changed")
  }
  expect(writes).toEqual([])
})
it("cancels a preview, rejects a forged receipt and expires privileged sessions", async () => {
  vi.useFakeTimers()
  const { flow } = fixture()
  const preview = await flow.preview(tenant, ["Policy.Read.All"])
  await expect(flow.confirm(tenant, "forged")).rejects.toThrow("expired")
  flow.cancel(tenant)
  await expect(flow.confirm(tenant, preview.id)).rejects.toThrow("expired")
  const next = await flow.preview(tenant, ["Policy.Read.All"])
  await vi.advanceTimersByTimeAsync(600_000)
  await expect(flow.confirm(tenant, next.id)).rejects.toThrow("expired")
})
it("cancels a pending sign-in and rejects parallel previews", async () => {
  const { flow, host } = fixture()
  let finish!: (token: string) => void
  host.signIn.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = flow.preview(tenant, ["Policy.Read.All"])
  await vi.waitFor(() => expect(host.signIn).toHaveBeenCalled())
  await expect(flow.preview(tenant, ["Policy.Read.All"])).rejects.toThrow("already running")
  flow.cancel(tenant); finish("ephemeral")
  await expect(pending).rejects.toThrow()
})
it.each([{ tenantId: "bad", names: ["Policy.Read.All"] }, { tenantId: tenant, names: [] }, { tenantId: tenant, names: [7] }, { tenantId: tenant, names: ["Directory.ReadWrite.All"] }])("rejects invalid or unchosen inputs before sign-in", async ({ tenantId, names }) => {
  const { flow, host, writes } = fixture()
  await expect(flow.preview(tenantId, names)).rejects.toThrow("Choose")
  expect(host.signIn).not.toHaveBeenCalled()
  expect(writes).toEqual([])
})
it("refreshes after declarations were saved but a later consent change stopped the flow", async () => {
  const { flow, host, state, writes } = fixture()
  const preview = await flow.preview(tenant, ["Policy.Read.All"])
  let checks = 0
  host.connection.mockImplementation(async () => {
    if (++checks === 3) state.grants[0]!.scope = "User.Read Concurrent.Read"
    return structuredClone(additionConnection)
  })
  const result = await flow.confirm(tenant, preview.id)
  expect(result.state).toBe("changed")
  expect(result.message).toContain("Declarations were written")
  expect(writes).toHaveLength(1)
  expect(host.refresh).toHaveBeenCalledWith(additionConnection, ["Policy.Read.All"])
})
