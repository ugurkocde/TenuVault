import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Configuration } from "@azure/msal-node"
import type { LoopbackSignInRequest } from "../src/main/auth/loopback-sign-in"
const mock = vi.hoisted(() => ({ signIn: vi.fn(), clear: vi.fn(), config: null as Configuration | null }))
vi.mock("@azure/msal-node", () => ({ PublicClientApplication: class { constructor(config: Configuration) { mock.config = config }; clearCache = mock.clear } }))
vi.mock("../src/main/auth/loopback-sign-in", () => ({ loopbackSignIn: mock.signIn }))
import { AddPermissionsFlow, signInForPermissionAddition } from "../src/main/auth/add-permissions-flow"
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
