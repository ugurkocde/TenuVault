import { describe, expect, it, vi } from "vitest"

const msal = vi.hoisted(() => ({
  interactive: vi.fn<(request: unknown) => Promise<unknown>>(),
}))

vi.mock("@azure/msal-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/msal-node")>()
  class PublicClientApplication {
    getAllAccounts = async () => []
    acquireTokenInteractive = msal.interactive
  }
  return { ...actual, PublicClientApplication }
})

const { AuthManager, SignInCancelledError, firstSignInError } = await import("../src/main/auth/msal")

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "33333333-3333-3333-3333-333333333333"

const openBrowser = vi.fn(async () => undefined)

function manager() {
  const store = new Map()
  return new AuthManager({
    fetch: async () => new Response("{}"),
    cachePlugin: () => ({ beforeCacheAccess: async () => undefined, afterCacheAccess: async () => undefined }),
    openBrowser,
    accountStore: {
      get: (tenantId) => store.get(tenantId) ?? null,
      set: (profile) => void store.set(profile.tenantId, profile),
      delete: (tenantId) => void store.delete(tenantId),
      list: () => [...store.values()],
    },
  })
}

describe("firstSignInError", () => {
  it.each([
    ["AADSTS700016: Application with identifier 'x' was not found in the directory", "No app registration with this client ID exists in this tenant"],
    ["AADSTS90002: Tenant 'contoso.example' not found", "Microsoft does not know this tenant"],
    ["AADSTS50011: The redirect URI 'http://localhost:1234' does not match", "no http://localhost redirect URI"],
    ["AADSTS7000218: The request body must contain client_assertion or client_secret", "under Mobile and desktop applications"],
    ["AADSTS50020: User account from identity provider does not exist in tenant", "does not belong to the tenant"],
    ["AADSTS50105: The signed in user is not assigned to a role for the application", "not assigned to the TenuVault app registration"],
    ["AADSTS53000: Device is not in required device state: compliant", "compliant or registered device"],
    ["AADSTS53003: Access has been blocked by Conditional Access policies", "Conditional Access blocked this sign-in"],
  ])("explains %s", (message, expected) => {
    const result = firstSignInError(new Error(message)) as Error
    expect(result.message).toContain(expected)
    expect(result.message).toContain(/AADSTS\d+/.exec(message)![0])
  })

  it("explains missing admin consent like a later sign-in does", () => {
    const result = firstSignInError(new Error("AADSTS65001: The user or administrator has not consented")) as Error
    expect(result.message).toContain("has no admin consent for Microsoft Graph (AADSTS65001)")
  })

  it("keeps other errors unchanged", () => {
    const error = new Error("network down")
    expect(firstSignInError(error)).toBe(error)
    const cancelled = new SignInCancelledError()
    expect(firstSignInError(cancelled)).toBe(cancelled)
  })

  it("never uses an em dash", () => {
    for (const code of ["AADSTS700016", "AADSTS90002", "AADSTS53003"]) {
      expect((firstSignInError(new Error(code)) as Error).message).not.toContain("—")
    }
  })
})

describe("AuthManager sign-in", () => {
  it("maps a refused first sign-in to an actionable message", async () => {
    msal.interactive.mockRejectedValueOnce(new Error("AADSTS700016: Application not found"))
    await expect(manager().signIn(TENANT, CLIENT)).rejects.toThrow("No app registration with this client ID exists in this tenant")
  })

  it("stops waiting for a sign-in the admin cancels, and starts a new one afterwards", async () => {
    msal.interactive.mockImplementationOnce(() => new Promise(() => undefined))
    const auth = manager()
    const waiting = auth.signIn(TENANT, CLIENT)
    await Promise.resolve()
    auth.cancelInteractive()
    await expect(waiting).rejects.toThrow("Sign-in cancelled.")

    msal.interactive.mockResolvedValueOnce({ account: { tenantId: TENANT, username: "admin@contoso.com", homeAccountId: "home" } })
    await expect(auth.signIn(TENANT, CLIENT)).resolves.toMatchObject({ tenantId: TENANT, username: "admin@contoso.com" })
  })

  it("does not open the browser for a sign-in cancelled before MSAL opens it", async () => {
    let request: { openBrowser: (url: string) => Promise<void> } | undefined
    msal.interactive.mockImplementationOnce((value) => {
      request = value as typeof request
      return new Promise(() => undefined)
    })
    const auth = manager()
    const waiting = auth.signIn(TENANT, CLIENT)
    auth.cancelInteractive()
    await expect(waiting).rejects.toThrow("Sign-in cancelled.")
    await expect(request!.openBrowser("https://login.microsoftonline.com/")).rejects.toThrow("Sign-in cancelled.")
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it("leaves a reauthentication started elsewhere waiting when the first sign-in is cancelled", async () => {
    const other = "22222222-2222-2222-2222-222222222222"
    let finish: (value: unknown) => void = () => undefined
    msal.interactive.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    msal.interactive.mockImplementationOnce(() => new Promise(() => undefined))
    const auth = manager()
    const reauth = auth.reauthenticate(other, CLIENT)
    const waiting = auth.signIn(TENANT, CLIENT)
    await Promise.resolve()
    auth.cancelInteractive()
    await expect(waiting).rejects.toThrow("Sign-in cancelled.")

    finish({ account: { tenantId: other, username: "admin@fabrikam.com", homeAccountId: "home-2" } })
    await expect(reauth).resolves.toMatchObject({ tenantId: other, username: "admin@fabrikam.com" })
  })
})

it.each([undefined, { loginHint: "admin@example.test" }])("uses the browser session only with a login hint (%j)", async options => {
  msal.interactive.mockResolvedValueOnce({ account: { tenantId: TENANT, username: "admin", homeAccountId: "home" } })
  await manager().signIn(TENANT, CLIENT, options)
  const request = msal.interactive.mock.lastCall![0]
  if (options) {
    expect(request).toHaveProperty("loginHint", options.loginHint)
    expect(request).not.toHaveProperty("prompt")
  } else expect(request).toHaveProperty("prompt", "select_account")
})


it.each(["access_denied", "user_cancelled", "user_canceled"])("explains browser cancellation (%s)", code => {
  expect((firstSignInError(new Error(code)) as Error).message).toBe("The sign-in was cancelled in the browser. Sign in again to continue.")
})
