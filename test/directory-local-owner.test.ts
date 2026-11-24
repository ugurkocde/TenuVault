import { expect, it, vi } from "vitest"
import type { AccountInfo, AuthenticationResult } from "@azure/msal-node"
import type { SignedInAccount } from "../src/shared/ipc"
import { RESOURCE_SCOPES } from "../src/shared/constants"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { guardedGraphIO } from "../src/main/restore/graph-io"
import { restoreSignIn } from "../src/main/restore/restore-actor"

const msal = vi.hoisted(() => ({ accounts: [] as AccountInfo[], acquire: vi.fn<() => Promise<AuthenticationResult>>(async () => { throw new Error("Token refresh unavailable") }) }))
vi.mock("@azure/msal-node", async original => {
  const actual = await original<typeof import("@azure/msal-node")>()
  return { ...actual, PublicClientApplication: class {
    getAllAccounts = async () => msal.accounts
    acquireTokenSilent = msal.acquire
  } }
})
const { AuthManager } = await import("../src/main/auth/msal")
const tenant = "00000000-0000-4000-8000-000000000001", clientId = "00000000-0000-4000-8000-000000000002", userId = "00000000-0000-4000-8000-000000000003"
const homeTenant = "00000000-0000-4000-8000-000000000004"
const account: AccountInfo = { tenantId: tenant, homeAccountId: "home-user.home-tenant", localAccountId: userId, environment: "login.microsoftonline.com", username: "admin@example.test" }
function fixture() {
  const profiles = new Map<string, SignedInAccount & { homeAccountId: string }>([[tenant, { tenantId: tenant, clientId, homeAccountId: account.homeAccountId, username: account.username }]])
  const network = vi.fn(async () => { throw new Error("Network unavailable") }), browser = vi.fn(async () => {})
  const auth = new AuthManager({ fetch: network, openBrowser: browser, cachePlugin: () => ({ beforeCacheAccess: async () => {}, afterCacheAccess: async () => {} }), accountStore: {
    get: tenant => profiles.get(tenant) ?? null, set: profile => { profiles.set(profile.tenantId, profile) }, delete: tenant => { profiles.delete(tenant) }, list: () => [...profiles.values()],
  } })
  return { auth, network, browser, profiles }
}
it.each([false, true])("resolves the cached tenant owner without requesting a token for guest profile %s", async guest => {
  msal.acquire.mockClear()
  msal.accounts = [guest ? { ...account, tenantId: homeTenant, localAccountId: "home-user", tenantProfiles: new Map([[tenant, { tenantId: tenant, localAccountId: userId, username: account.username }]]) } : account]
  const { auth, network, browser } = fixture()
  await expect(auth.getAccessToken(tenant, clientId, "https://graph.microsoft.com/.default", true)).rejects.toThrow("Token refresh unavailable")
  msal.acquire.mockClear()
  expect(await auth.cachedAccountIdentity(tenant.toUpperCase())).toEqual({ tenantId: tenant, clientId, userId })
  expect(msal.acquire).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled()
})
it.each(["signed out", "missing cache", "another account", "another tenant", "missing user"])("refuses local owner verification for %s", async missing => {
  msal.acquire.mockClear(); msal.accounts = [account]
  const { auth, network, browser, profiles } = fixture()
  if (missing === "signed out") profiles.clear()
  if (missing === "missing cache") msal.accounts = []
  if (missing === "another account") msal.accounts = [{ ...account, homeAccountId: "other" }]
  if (missing === "another tenant") msal.accounts = [{ ...account, tenantId: homeTenant }]
  if (missing === "missing user") msal.accounts = [{ ...account, localAccountId: "" }]
  await expect(auth.cachedAccountIdentity(tenant)).rejects.toThrow("Sign in to this tenant before managing saved directory restores.")
  expect(msal.acquire).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled()
})

it.each([
  ["no new ID token", false, userId, true],
  ["scope omitted", true, userId, true],
  ["a different user in the bearer", false, "home-user", false],
] as const)("checks the cached admin and bearer permissions after a forced refresh with %s", async (_shape, hasAccount, oid, allowed) => {
  const guest = { ...account, tenantId: homeTenant, localAccountId: "home-user", tenantProfiles: new Map([[tenant, account]]) }
  msal.accounts = [guest]
  const { auth, profiles } = fixture()
  const folder = "AuthenticationFlowsPolicy"
  const permission = "Policy.ReadWrite.AuthenticationFlows"
  const bearer = `header.${Buffer.from(JSON.stringify({ tid: tenant, oid, appid: clientId, scp: permission })).toString("base64url")}.signature`
  msal.acquire.mockResolvedValueOnce({
    accessToken: bearer, account: hasAccount ? account : null, tenantId: hasAccount ? tenant : "",
    scopes: hasAccount ? [RESOURCE_SCOPES.graph] : [permission],
  } as AuthenticationResult)
  const result = await auth.getAccessToken(tenant, clientId, RESOURCE_SCOPES.graph, true)
  expect(msal.acquire).toHaveBeenLastCalledWith({ account: guest, authority: `https://login.microsoftonline.com/${tenant}`, scopes: [RESOURCE_SCOPES.graph], forceRefresh: true })
  const connect = () => restoreSignIn(tenant, profiles.get(tenant)!, result)
  if (!allowed) {
    expect(connect).toThrow("signed-in admin")
    return
  }
  const connection = connect()
  expect(connection.userId).toBe(userId)
  const references = { complete: true, principals: [], applications: [] }
  const io = guardedGraphIO(connection.token, { ...connection, applicationObjectId: "", servicePrincipalId: "", recoveryAccountIds: [] },
    async () => references, fetch, undefined, connection.authorization)
  await expect(io.references({
    key: "test", folder, sourceId: "policy", operation: "update",
    properties: restoreMatrixRow(folder)!.update!.properties, desired: {}, preview: "", requires: [],
  }, null, {})).resolves.toEqual(references)
})
