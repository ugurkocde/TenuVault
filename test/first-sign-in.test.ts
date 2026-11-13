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

const { AuthManager, SIGN_IN_TIMEOUT_MS, SignInCancelledError, firstSignInError } = await import("../src/main/auth/msal")
const { signInEvent } = await import("../src/main/setup-diagnostics/hooks")
const { FIRST_SIGN_IN_TIMEOUT_MESSAGE, offersSignInHandoff } = await import("../src/shared/app-registration")

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
    ["AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication", "complete the MFA prompt in the browser"],
    ["AADSTS50079: Due to a configuration change made by your administrator, you are required to use multi-factor authentication", "Microsoft requires multifactor authentication for this sign-in"],
    ["AADSTS90094: Administrator consent is required", "Ask a Global Administrator, Cloud Application Administrator or Application Administrator to grant admin consent"],
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
    for (const code of ["AADSTS700016", "AADSTS90002", "AADSTS53003", "AADSTS50076", "AADSTS50079", "AADSTS90094"]) {
      const message = (firstSignInError(new Error(code)) as Error).message
      expect(message).not.toMatch(/[\u2013\u2014]| - /)
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

describe("first sign-in recovery", () => {
  const URL = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/authorize?client_id=c&state=s"

  it("stops waiting after 15 minutes with a timeout that diagnostics record as timeout", async () => {
    vi.useFakeTimers()
    try {
      msal.interactive.mockImplementationOnce(() => new Promise(() => undefined))
      const outcome = manager().signIn(TENANT, CLIENT).then(() => null, (caught: unknown) => caught as Error)
      let settled = false
      void outcome.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const error = await outcome
      expect(SIGN_IN_TIMEOUT_MS).toBe(15 * 60_000)
      expect(error?.name).toBe("SignInTimeoutError")
      expect(error?.message).toBe(FIRST_SIGN_IN_TIMEOUT_MESSAGE)
      expect(error?.message).toContain("Try again")
      expect(error?.message).toContain("copy the instructions for your admin")
      expect(signInEvent(error)).toEqual({ name: "signin", props: { result: "timeout" } })
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not time out a sign-in that finished in time", async () => {
    vi.useFakeTimers()
    try {
      msal.interactive.mockResolvedValueOnce({ account: { tenantId: TENANT, username: "admin@contoso.com", homeAccountId: "home" } })
      await expect(manager().signIn(TENANT, CLIENT)).resolves.toMatchObject({ tenantId: TENANT })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the exact address it opened while the sign-in waits and forgets it when the sign-in ends", async () => {
    let request: { openBrowser: (url: string) => Promise<void> } | undefined
    let finish: (value: unknown) => void = () => undefined
    msal.interactive.mockImplementationOnce((value) => {
      request = value as typeof request
      return new Promise((resolve) => { finish = resolve })
    })
    const auth = manager()
    const waiting = auth.signIn(TENANT, CLIENT)
    await Promise.resolve()
    expect(auth.signInLink()).toBeNull()
    await request!.openBrowser(URL)
    expect(openBrowser).toHaveBeenLastCalledWith(URL)
    expect(auth.signInLink()).toBe(URL)
    finish({ account: { tenantId: TENANT, username: "admin@contoso.com", homeAccountId: "home" } })
    await waiting
    expect(auth.signInLink()).toBeNull()
  })

  it("forgets the address when the sign-in is cancelled", async () => {
    let request: { openBrowser: (url: string) => Promise<void> } | undefined
    msal.interactive.mockImplementationOnce((value) => {
      request = value as typeof request
      return new Promise(() => undefined)
    })
    const auth = manager()
    const waiting = auth.signIn(TENANT, CLIENT)
    await Promise.resolve()
    await request!.openBrowser(URL)
    expect(auth.signInLink()).toBe(URL)
    auth.cancelInteractive()
    await expect(waiting).rejects.toThrow("Sign-in cancelled.")
    expect(auth.signInLink()).toBeNull()
  })

  it.each([
    "https://example.invalid/authorize",
    "http://login.microsoftonline.com/authorize",
    "https://login.microsoftonline.com.example.invalid/authorize",
    "https://user:secret@login.microsoftonline.com/authorize",
  ])("never keeps an address that is not Microsoft's login (%s)", async (url) => {
    let request: { openBrowser: (url: string) => Promise<void> } | undefined
    msal.interactive.mockImplementationOnce((value) => {
      request = value as typeof request
      return new Promise(() => undefined)
    })
    const auth = manager()
    const waiting = auth.signIn(TENANT, CLIENT)
    await Promise.resolve()
    await request!.openBrowser(url)
    expect(auth.signInLink()).toBeNull()
    auth.cancelInteractive()
    await expect(waiting).rejects.toThrow("Sign-in cancelled.")
  })

  it("keeps no address for a reauthentication", async () => {
    let request: { openBrowser: (url: string) => Promise<void> } | undefined
    msal.interactive.mockImplementationOnce((value) => {
      request = value as typeof request
      return new Promise(() => undefined)
    })
    const auth = manager()
    void auth.reauthenticate(TENANT, CLIENT)
    await Promise.resolve()
    await request!.openBrowser(URL)
    expect(auth.signInLink()).toBeNull()
  })
})

describe("offersSignInHandoff", () => {
  const codes = ["AADSTS53000", "AADSTS53001", "AADSTS53003", "AADSTS65001", "AADSTS90094", "AADSTS50076", "AADSTS50079"]

  it.each(codes)("offers the handoff for %s as the first sign-in explains it", (code) => {
    const message = (firstSignInError(new Error(`${code}: refused`)) as Error).message
    expect(offersSignInHandoff(message)).toBe(true)
  })

  it.each(["AADSTS700016", "AADSTS90002", "AADSTS900023", "AADSTS50011", "AADSTS7000218", "AADSTS50020", "AADSTS50105", "AADSTS65004", "AADSTS530030", "AADSTS500761"])("offers nothing for %s", (code) => {
    const mapped = firstSignInError(new Error(`${code}: refused`))
    expect(offersSignInHandoff(mapped instanceof Error ? mapped.message : String(mapped))).toBe(false)
  })

  it("offers nothing for errors without a code or the timeout", () => {
    expect(offersSignInHandoff("network down")).toBe(false)
    expect(offersSignInHandoff(FIRST_SIGN_IN_TIMEOUT_MESSAGE)).toBe(false)
  })
})

describe("AADSTS50079", () => {
  it("states the MFA requirement first, then the remedy for managed and for federated accounts", () => {
    const message = (firstSignInError(new Error("AADSTS50079: MFA registration required")) as Error).message
    expect(message.indexOf("requires multifactor authentication")).toBe(message.indexOf("Microsoft requires") + "Microsoft ".length)
    expect(message.indexOf("requires multifactor authentication")).toBeLessThan(message.indexOf("register your security info"))
    expect(message).toContain("If your account is managed in Entra ID, register your security info at https://mysignins.microsoft.com/security-info")
    expect(message).toContain("that provider must supply the MFA claim")
  })
})

describe("cancelInteractive", () => {
  it("says whether a first sign-in was waiting for the browser", async () => {
    msal.interactive.mockImplementationOnce(() => new Promise(() => undefined))
    const auth = manager()
    expect(auth.cancelInteractive()).toBe(false)
    const waiting = auth.signIn(TENANT, CLIENT)
    await Promise.resolve()
    expect(auth.cancelInteractive()).toBe(true)
    await expect(waiting).rejects.toThrow("Sign-in cancelled.")
    expect(auth.cancelInteractive()).toBe(false)
  })

  it("cancels nothing once the browser step has ended", async () => {
    msal.interactive.mockResolvedValueOnce({ account: { tenantId: TENANT, username: "admin@contoso.com", homeAccountId: "home" } })
    const auth = manager()
    await expect(auth.signIn(TENANT, CLIENT)).resolves.toMatchObject({ tenantId: TENANT })
    expect(auth.cancelInteractive()).toBe(false)
  })
})
