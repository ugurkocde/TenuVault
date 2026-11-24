import { describe, expect, it, vi } from "vitest"

const msal = vi.hoisted(() => ({ silent: vi.fn<(request: { forceRefresh?: boolean; scopes: string[] }) => Promise<unknown>>() }))

vi.mock("@azure/msal-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/msal-node")>()
  class PublicClientApplication {
    getAllAccounts = async () => [{ homeAccountId: "home", username: "admin@contoso.com", tenantId: "11111111-1111-1111-1111-111111111111" }]
    acquireTokenSilent = msal.silent
  }
  return { ...actual, PublicClientApplication }
})

const { InteractionRequiredAuthError, ServerError } = await import("@azure/msal-node")
const { AuthManager, SignInRequiredError } = await import("../src/main/auth/msal")
const { signInFailure } = await import("../src/main/connection-health/failure")
const { RESOURCE_SCOPES } = await import("../src/shared/constants")

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "33333333-3333-3333-3333-333333333333"

function manager(signedIn = true) {
  const stored = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com", homeAccountId: "home" }
  return new AuthManager({
    fetch: async () => new Response("{}"),
    cachePlugin: () => ({ beforeCacheAccess: async () => undefined, afterCacheAccess: async () => undefined }),
    openBrowser: async () => { throw new Error("a silent request must never open the browser") },
    accountStore: { get: () => (signedIn ? stored : null), set: () => undefined, delete: () => undefined, list: () => [] },
  })
}

// The silent token request is the sign-in boundary connection health reads: what Microsoft
// answered has to leave it as structure, and the message an admin sees has to stay as it was.
describe("a silent token request Microsoft refused", () => {
  it("keeps the personalized banner distinct from the error message and carries validated refusal fields", async () => {
    msal.silent.mockRejectedValueOnce(new InteractionRequiredAuthError("interaction_required", "correlation", "AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication.", undefined, undefined, undefined, undefined, "50076"))
    const error = await manager().getAccessToken(TENANT, CLIENT, RESOURCE_SCOPES.graph).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SignInRequiredError)
    expect(error).toMatchObject({
      prompt: "Microsoft needs you to sign in again as admin@contoso.com for Microsoft Graph (interaction_required, AADSTS50076).",
      message: "Microsoft Graph (AADSTS50076). Sign in again to this tenant.",
      errorNo: "50076", errorCode: "interaction_required", scope: RESOURCE_SCOPES.graph, tenantId: TENANT, clientId: CLIENT,
    })
    expect(signInFailure(error)).toEqual({ class: "mfa", code: "AADSTS50076" })
  })

  it("carries nothing of Microsoft's description, which can name the account", async () => {
    msal.silent.mockRejectedValueOnce(new InteractionRequiredAuthError("interaction_required", "correlation", "AADSTS50105: The signed in user 'admin@contoso.com' is not assigned to a role.", undefined, undefined, undefined, '{"access_token":{}}', "50105"))
    const error = await manager().getAccessToken(TENANT, CLIENT, RESOURCE_SCOPES.graph).catch((caught: unknown) => caught)
    expect(Object.keys(error as object).sort()).toEqual(["clientId", "errorCode", "errorNo", "name", "scope", "tenantId"])
    expect(error).not.toHaveProperty("cause")
  })

  it("is a sign-in that ended, without any code, when nobody is signed in", async () => {
    const error = await manager(false).getAccessToken(TENANT, CLIENT, RESOURCE_SCOPES.graph).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ prompt: "You are not signed in to this tenant. Sign in to continue.", message: "Microsoft Graph (sign_in_required). Sign in again to this tenant." })
    expect(error).not.toHaveProperty("errorNo")
    expect(signInFailure(error)).toEqual({ class: "session" })
    expect(msal.silent).not.toHaveBeenCalled()
  })

  it("keeps the classification of a refusal that interaction cannot fix", async () => {
    const refused = new ServerError("unauthorized_client", "correlation", "AADSTS700016: Application was not found in the directory.", undefined, "700016", 400)
    msal.silent.mockRejectedValueOnce(refused)
    const error = await manager().getAccessToken(TENANT, CLIENT, RESOURCE_SCOPES.graph).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ServerError)
    expect(error).toMatchObject({ errorNo: "700016", errorCode: "unauthorized_client", status: 400 })
    expect(signInFailure(error)).toEqual({ class: "registration", code: "AADSTS700016" })
  })

  it("asks Microsoft for a new token when a check forces it", async () => {
    msal.silent.mockResolvedValueOnce({ accessToken: "token", fromCache: false })
    await expect(manager().getAccessToken(TENANT, CLIENT, RESOURCE_SCOPES.graph, true)).resolves.toMatchObject({ fromCache: false })
    expect(msal.silent).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true, scopes: [RESOURCE_SCOPES.graph] }))
  })
})
