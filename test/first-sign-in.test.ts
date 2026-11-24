import { resourcePackScopes, tenantPermissionPacks } from "../src/shared/services/permission-packs"
import { TENUVAULT_CLIENT_ID } from "../src/shared/tenant-connection"
import { LogLevel, type Configuration } from "@azure/msal-node"
import { describe, expect, it, vi } from "vitest"

const msal = vi.hoisted(() => ({
  interactive: vi.fn<(request: unknown) => Promise<unknown>>(),
  silent: vi.fn<(request: unknown) => Promise<unknown>>(),
  client: null as Configuration | null,
}))

vi.mock("@azure/msal-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/msal-node")>()
  class PublicClientApplication {
    constructor(configuration: Configuration) { msal.client = configuration }
    getAllAccounts = async () => []
    acquireTokenInteractive = msal.interactive
    acquireTokenSilent = msal.silent
  }
  return { ...actual, PublicClientApplication }
})
// The browser part is tested in loopback-sign-in.test.ts; here `msal.interactive` plays it.
vi.mock("../src/main/auth/loopback-sign-in", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/auth/loopback-sign-in")>()
  const { interactiveShim } = await import("./helpers/interactive-shim")
  return { ...actual, loopbackSignIn: interactiveShim((request) => msal.interactive(request)) }
})

const { AuthManager, SIGN_IN_TIMEOUT_MS, SignInCancelledError, firstSignInError } = await import("../src/main/auth/msal")
const { signInEvent } = await import("../src/main/setup-diagnostics/hooks")
const { FIRST_SIGN_IN_TIMEOUT_MESSAGE, offersSignInHandoff } = await import("../src/shared/app-registration")

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "33333333-3333-3333-3333-333333333333"

const openBrowser = vi.fn(async () => undefined)

function manager(fetchToken: typeof fetch = async () => new Response("{}")) {
  const store = new Map()
  return new AuthManager({
    fetch: fetchToken,
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
  it.each([
    ["AADSTS999999: User private.admin@example.test could not sign in", "The app registration could not be changed."],
    ["AADSTS53003: User private.admin@example.test was blocked", "Conditional Access blocked this sign-in"],
  ])("sanitizes a staged registration sign-in failure", async (description, message) => {
    msal.interactive.mockRejectedValueOnce(new Error(description))
    const cache = { beforeCacheAccess: async () => undefined, afterCacheAccess: async () => undefined }
    const failure = await manager().stageSignIn(TENANT, CLIENT, cache).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain(message)
    expect(String(failure)).not.toContain("private.admin@example.test")
    expect(String(failure)).not.toContain("AADSTS999999")
  })

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
  ])("never opens or keeps an address that is not Microsoft's login (%s)", async (url) => {
    let request: { openBrowser: (url: string) => Promise<void> } | undefined
    msal.interactive.mockImplementationOnce((value) => {
      request = value as typeof request
      return new Promise(() => undefined)
    })
    const auth = manager()
    const waiting = auth.signIn(TENANT, CLIENT)
    await Promise.resolve()
    expect(() => request!.openBrowser(url)).toThrow("Microsoft returned an unexpected sign-in address.")
    expect(openBrowser).not.toHaveBeenCalledWith(url)
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


async function tokenResponse(accessToken: string, scopes: string[], account: unknown) {
  const correlationId = crypto.randomUUID()
  await msal.client?.system?.networkClient?.sendPostRequestAsync("https://login.microsoftonline.com/token", { correlationId })
  return { account, accessToken, scopes, correlationId }
}

describe("TenuVault app token verification", () => {
  const cache = { beforeCacheAccess: async () => undefined, afterCacheAccess: async () => undefined }
  const account = { tenantId: TENANT, username: "example@example.test", homeAccountId: "fixture" }
  const token = (scopes: string[], claims: object = {}) => `header.${Buffer.from(JSON.stringify({ tid: TENANT, appid: TENUVAULT_CLIENT_ID, scp: scopes.join(" "), ...claims })).toString("base64url")}.signature`

  it("switches to the shared app with opaque Graph and Azure tokens", async () => {
    const { TenantConnections, TENANT_LIST_KEY } = await import("../src/main/auth/tenant-connections")
    const { connectionCoverage } = await import("../src/main/auth/connection-coverage")
    const { ModuleSettings } = await import("../src/main/services/settings")
    const entries = new Map<string, string>()
    const store = {
      get: (key: string) => entries.get(key) ?? null,
      set: (key: string, value: string) => { entries.set(key, value) },
      delete: (key: string) => { entries.delete(key) },
      setMany: (values: Record<string, string>, removed: string[] = []) => {
        for (const key of removed) entries.delete(key)
        for (const [key, value] of Object.entries(values)) entries.set(key, value)
      },
    }
    const settings = new ModuleSettings(store)
    const packs = tenantPermissionPacks({ intune: { access: "backup" } }, { azure: true, audit: false })
    const graphScopes = resourcePackScopes(packs, "graph")
    const graphGrant = graphScopes.map(scope => "https://graph.microsoft.com/" + scope)
    const rawTokens = [
      { access_token: "opaque-graph", scope: graphGrant.join(" ") },
      { access_token: "opaque-arm", scope: "user_impersonation" },
      { access_token: "opaque-storage", scope: "user_impersonation" },
    ]
    const auth = manager(async () => Response.json(rawTokens.shift()))
    const connections = new TenantConnections({
      store,
      signIn: { tenuvaultApp: tenant => auth.stageTenuVaultSignIn(tenant, cache, packs) },
      coverage: (tenant, method, bearer, requested, granted) => connectionCoverage(settings.get(tenant), method, bearer, requested, granted),
    })
    const profile = JSON.stringify([{ credentials: { tenantId: TENANT, appId: CLIENT }, resources: { storageAccountName: "fixture" } }])
    connections.enroll(TENANT, { method: "ownApp", clientId: CLIENT }, profile, { accessToken: "previous", account: { ...account, clientId: CLIENT } })
    const before = store.get(TENANT_LIST_KEY)
    msal.interactive.mockImplementationOnce(() => tokenResponse("opaque-graph", graphGrant, account))
    msal.silent.mockImplementationOnce(() => tokenResponse("opaque-arm", ["user_impersonation"], null))
      .mockImplementationOnce(() => tokenResponse("opaque-storage", ["user_impersonation"], null))
    await expect(connections.switch(TENANT, { method: "tenuvaultApp" })).resolves.toMatchObject({ missing: [], connection: { method: "tenuvaultApp", graphScopes } })
    expect(connections.get(TENANT)?.clientId).toBe(TENUVAULT_CLIENT_ID)
    expect(store.get(TENANT_LIST_KEY)).toBe(before)
  })

  it("does not stage MSAL's requested .default scope as a grant for an opaque bearer", async () => {
    const auth = manager(async () => Response.json({ access_token: "opaque-own" }))
    msal.interactive.mockImplementationOnce(() => tokenResponse("opaque-own", ["https://graph.microsoft.com/.default"], account))
    const staged = await auth.stageSignIn(TENANT, CLIENT, cache)
    expect(staged.accessToken).toBe("opaque-own")
    expect(staged.grantedScopes).toBeUndefined()
  })

  it("uses the selected Graph account when Azure refreshes omit identity metadata", async () => {
    const packs = tenantPermissionPacks({}, { azure: true, audit: false })
    const graphScopes = resourcePackScopes(packs, "graph")
    msal.interactive.mockResolvedValueOnce({ account, accessToken: token(graphScopes) })
    msal.silent.mockResolvedValueOnce({ accessToken: token(["user_impersonation"]) })
      .mockResolvedValueOnce({ accessToken: token(["user_impersonation"]) })
    await expect(manager().stageTenuVaultSignIn(TENANT, cache, packs)).resolves.toMatchObject({ account: { homeAccountId: account.homeAccountId } })
    expect(msal.silent).toHaveBeenLastCalledWith(expect.objectContaining({ account, forceRefresh: true }))
  })

  it.each([
    ["account", { account: { ...account, homeAccountId: "different" } }],
    ["tenant", { tenantId: CLIENT }],
    ["ID token", { idTokenClaims: { oid: CLIENT } }],
    ["bearer", { accessToken: token(["user_impersonation"], { oid: CLIENT }) }],
  ] as const)("rejects Azure refresh %s metadata that disagrees with the selected account", async (_field, metadata) => {
    const packs = tenantPermissionPacks({}, { azure: true, audit: false })
    msal.interactive.mockResolvedValueOnce({ account: { ...account, localAccountId: TENANT }, accessToken: token(resourcePackScopes(packs, "graph")) })
    msal.silent.mockResolvedValueOnce({ accessToken: token(["user_impersonation"]), ...metadata })
    await expect(manager().stageTenuVaultSignIn(TENANT, cache, packs)).rejects.toMatchObject({ message: expect.stringContaining("Azure Service Management") })
  })

  it("checks the selected pack with a fresh token and no consent prompt", async () => {
    const [basic] = tenantPermissionPacks({}, { azure: false, audit: false })
    const auth = manager()
    msal.interactive.mockResolvedValueOnce({ account, accessToken: token(["User.Read"]) })
    await expect(auth.signInForPack(TENANT, cache, basic!, true)).rejects.toMatchObject({ code: "AADSTS65001" })
    msal.interactive.mockResolvedValueOnce({ account, accessToken: token(["User.Read", "Organization.Read.All"]) })
    await expect(auth.signInForPack(TENANT, cache, basic!, true)).resolves.toBeUndefined()
    expect(msal.interactive).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: "none", scopes: ["openid", "profile", "offline_access", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Organization.Read.All"],
    }))
    expect(auth.accounts()).toEqual([])
  })

  it.each([{ tid: CLIENT }, { azp: CLIENT }, { appid: CLIENT }, { tid: undefined }, { appid: undefined }])(
    "refuses staged Graph token identity %j even when the account and scopes match",
    async claims => {
      const packs = tenantPermissionPacks({}, { azure: false, audit: false })
      msal.interactive.mockResolvedValueOnce({ account, accessToken: token(resourcePackScopes(packs, "graph"), claims) })
      const auth = manager()
      await expect(auth.stageTenuVaultSignIn(TENANT, cache, packs)).rejects.toMatchObject({ code: "switch_failed" })
      expect(auth.accounts()).toEqual([])
      expect(msal.silent).not.toHaveBeenCalled()
    },
  )

  it("requires a same-tenant Graph token and separate Azure tokens before staging the switch", async () => {
    const packs = tenantPermissionPacks({ intune: { access: "backup" } }, { azure: true, audit: false })
    const graphScopes = resourcePackScopes(packs, "graph")
    const auth = manager()
    msal.interactive.mockResolvedValueOnce({ account: { ...account, tenantId: CLIENT }, accessToken: token(graphScopes) })
    await expect(auth.stageTenuVaultSignIn(TENANT, cache, packs)).rejects.toMatchObject({ code: "wrong_tenant" })
    msal.interactive.mockResolvedValueOnce({ account, accessToken: token(graphScopes) })
    msal.silent.mockResolvedValueOnce({ account, accessToken: token(["user_impersonation"]) }).mockResolvedValueOnce({ account, scopes: [] })
    await expect(auth.stageTenuVaultSignIn(TENANT, cache, packs)).rejects.toMatchObject({ code: "AADSTS65001", message: expect.stringContaining("Azure Storage") })
    msal.interactive.mockResolvedValueOnce({ account, accessToken: token(graphScopes) })
    msal.silent.mockResolvedValueOnce({ account, accessToken: token(["user_impersonation"]) }).mockResolvedValueOnce({ account, accessToken: token(["user_impersonation"]) })
    await expect(auth.stageTenuVaultSignIn(TENANT, cache, packs)).resolves.toMatchObject({
      account: { clientId: TENUVAULT_CLIENT_ID, tenantId: TENANT }, graphScopes,
    })
    expect(msal.silent).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true, scopes: ["https://management.azure.com//user_impersonation"] }))
    expect(msal.silent).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true, scopes: ["https://storage.azure.com/user_impersonation"] }))
    expect(auth.accounts()).toEqual([])
  })
})

it("logs only fixed codes from the delegated MSAL logger", async () => {
  msal.interactive.mockResolvedValueOnce({ account: { tenantId: TENANT, username: "admin@example.test", homeAccountId: "account" } })
  await manager().signIn(TENANT, CLIENT)
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  try {
    const logger = msal.client?.system?.loggerOptions
    expect(logger?.piiLoggingEnabled).toBe(false)
    logger!.loggerCallback!(LogLevel.Warning, "AADSTS65001 for admin@example.test with private context", true)
    logger!.loggerCallback!(LogLevel.Warning, "private warning for admin@example.test", false)
    expect(log.mock.calls).toEqual([["[msal]", "AADSTS65001"], ["[msal]", "sign_in_warning"]])
  } finally {
    log.mockRestore()
  }
})
