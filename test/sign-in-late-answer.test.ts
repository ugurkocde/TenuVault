import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthorizationUrlRequest } from "@azure/msal-node"
import { answer, authCodeUrl, codeAnswer, listenerClosed } from "./helpers/fake-browser"

// The real loopback sign-in against a PublicClientApplication whose network parts are fakes:
// getAuthCodeUrl builds the address and acquireTokenByCode stands for the redemption, the only
// step that writes tokens to the cache.
const msal = vi.hoisted(() => ({
  getAuthCodeUrl: vi.fn(),
  acquireTokenByCode: vi.fn(),
  clearCache: vi.fn(async () => undefined),
}))
vi.mock("@azure/msal-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/msal-node")>()
  class PublicClientApplication {
    getAllAccounts = async () => []
    getAuthCodeUrl = msal.getAuthCodeUrl
    acquireTokenByCode = msal.acquireTokenByCode
    clearCache = msal.clearCache
  }
  return { ...actual, PublicClientApplication }
})
const provision = vi.hoisted(() => vi.fn())
vi.mock("../src/main/auth/registration-provisioning", () => ({ provisionRegistration: provision }))

const { AuthManager, SIGN_IN_TIMEOUT_MS } = await import("../src/main/auth/msal")
const { AppRegistrationSetup } = await import("../src/main/auth/app-registration-setup")

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "33333333-3333-3333-3333-333333333333"
const ACCOUNT = { tenantId: TENANT, username: "admin@contoso.example", homeAccountId: "home" }

let opened: string[] = []
let nextOpen: (url: string) => void = () => undefined
const browserOpens = () => new Promise<string>((resolve) => { nextOpen = resolve })
const openBrowser = async (url: string) => { opened.push(url); nextOpen(url) }

function manager() {
  const store = new Map<string, unknown>()
  const auth = new AuthManager({
    fetch: async () => new Response("{}"),
    cachePlugin: () => ({ beforeCacheAccess: async () => undefined, afterCacheAccess: async () => undefined }),
    openBrowser,
    accountStore: {
      get: (tenantId) => (store.get(tenantId) as never) ?? null,
      set: (profile) => void store.set(profile.tenantId, profile),
      delete: (tenantId) => void store.delete(tenantId),
      list: () => [...store.values()] as never,
    },
  })
  return { auth, store }
}

beforeEach(() => {
  opened = []
  msal.getAuthCodeUrl.mockReset().mockImplementation(async (request: AuthorizationUrlRequest) => authCodeUrl(request))
  msal.acquireTokenByCode.mockReset().mockResolvedValue({ account: ACCOUNT, accessToken: "token" })
  msal.clearCache.mockClear()
  provision.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe("first sign-in", () => {
  it("signs in when the browser answers, and redeems the code once", async () => {
    const { auth, store } = manager()
    const browser = browserOpens()
    const waiting = auth.signIn(TENANT, CLIENT)
    const url = await browser
    expect(auth.signInLink()).toBe(url)
    await answer(url, codeAnswer(url))
    await expect(waiting).resolves.toMatchObject({ tenantId: TENANT, username: ACCOUNT.username })
    expect(msal.acquireTokenByCode).toHaveBeenCalledOnce()
    expect(store.size).toBe(1)
    expect(auth.signInLink()).toBeNull()
    expect(auth.cancelInteractive()).toBe(false)
    expect(await listenerClosed(url)).toBe(true)
  })

  it("redeems nothing for a tab finished after Try again, and the new attempt still signs in", async () => {
    const { auth, store } = manager()
    let browser = browserOpens()
    const first = auth.signIn(TENANT, CLIENT)
    const oldUrl = await browser
    expect(auth.cancelInteractive()).toBe(true)
    await expect(first).rejects.toThrow("Sign-in cancelled.")
    expect(await listenerClosed(oldUrl)).toBe(true)
    await expect(answer(oldUrl, codeAnswer(oldUrl, "late-code"))).rejects.toThrow()
    expect(msal.acquireTokenByCode).not.toHaveBeenCalled()
    expect(store.size).toBe(0)

    browser = browserOpens()
    const second = auth.signIn(TENANT, CLIENT)
    const newUrl = await browser
    expect(new URL(newUrl).searchParams.get("state")).not.toBe(new URL(oldUrl).searchParams.get("state"))
    await answer(newUrl, codeAnswer(newUrl, "new-code"))
    await expect(second).resolves.toMatchObject({ tenantId: TENANT })
    expect(msal.acquireTokenByCode).toHaveBeenCalledOnce()
    expect(msal.acquireTokenByCode.mock.lastCall![0]).toMatchObject({ code: "new-code" })
  })

  it("redeems nothing for a tab finished after the 15 minute timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { auth, store } = manager()
    const browser = browserOpens()
    const waiting = auth.signIn(TENANT, CLIENT).then(() => null, (error: unknown) => error as Error)
    const url = await browser
    vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS)
    expect((await waiting)?.name).toBe("SignInTimeoutError")
    vi.useRealTimers()
    expect(await listenerClosed(url)).toBe(true)
    await expect(answer(url, codeAnswer(url, "late-code"))).rejects.toThrow()
    expect(msal.acquireTokenByCode).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
    expect(auth.signInLink()).toBeNull()
  })

  it("closes the listener after an error answer and after a mismatched state", async () => {
    const { auth } = manager()
    let browser = browserOpens()
    const settle = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as Error)
    let waiting = settle(auth.signIn(TENANT, CLIENT))
    let url = await browser
    await answer(url, { error: "invalid_request", error_description: "AADSTS50011: The redirect URI does not match.", state: new URL(url).searchParams.get("state")! })
    expect((await waiting)?.message).toContain("(AADSTS50011)")
    expect(await listenerClosed(url)).toBe(true)

    browser = browserOpens()
    waiting = settle(auth.signIn(TENANT, CLIENT))
    url = await browser
    await answer(url, { code: "c", state: "other" })
    expect((await waiting)?.message).toContain("does not belong to this sign-in")
    expect(await listenerClosed(url)).toBe(true)
    expect(msal.acquireTokenByCode).not.toHaveBeenCalled()
  })

  it("does not cancel a sign-in whose code is being redeemed", async () => {
    let release!: () => void
    msal.acquireTokenByCode.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ account: ACCOUNT, accessToken: "token" }) }))
    const { auth } = manager()
    const browser = browserOpens()
    const waiting = auth.signIn(TENANT, CLIENT)
    const url = await browser
    await answer(url, codeAnswer(url))
    await vi.waitFor(() => expect(msal.acquireTokenByCode).toHaveBeenCalled())
    expect(auth.cancelInteractive()).toBe(false)
    release()
    await expect(waiting).resolves.toMatchObject({ tenantId: TENANT })
  })
})

describe("setup sign-in", () => {
  it("redeems nothing for a tab finished after Try again or after the timeout", async () => {
    const setup = new AppRegistrationSetup({ fetch: vi.fn() as never, openBrowser, progress: vi.fn() })
    let browser = browserOpens()
    let running = setup.create()
    let url = await browser
    expect(setup.signInLink()).toBe(url)
    expect(setup.cancelSignIn()).toBe(true)
    await expect(running).rejects.toThrow("Sign-in cancelled.")
    expect(await listenerClosed(url)).toBe(true)
    await expect(answer(url, codeAnswer(url))).rejects.toThrow()

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    browser = browserOpens()
    running = setup.create().then(() => null as never, (error: unknown) => error as never)
    url = await browser
    vi.advanceTimersByTime(15 * 60_000)
    expect((await running as unknown as Error).message).toMatch(/^The sign-in in the browser was not completed within 15 minutes\./)
    vi.useRealTimers()
    expect(await listenerClosed(url)).toBe(true)
    expect(msal.acquireTokenByCode).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
    expect(msal.clearCache).toHaveBeenCalledTimes(2)
  })

  it("provisions after a live setup sign-in, in its own memory client", async () => {
    msal.acquireTokenByCode.mockResolvedValueOnce({ account: { tenantId: "tenant", username: "admin" }, accessToken: "ephemeral" })
    provision.mockResolvedValueOnce({ tenantId: "tenant", clientId: "client", username: "admin", reused: false, ready: true, missingConsent: [] })
    const setup = new AppRegistrationSetup({ fetch: vi.fn() as never, openBrowser, progress: vi.fn() })
    const browser = browserOpens()
    const running = setup.create()
    const url = await browser
    const request = msal.getAuthCodeUrl.mock.lastCall![0] as AuthorizationUrlRequest
    expect(request).toMatchObject({ prompt: "select_account", scopes: ["https://graph.microsoft.com/Application.ReadWrite.All", "https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All"] })
    await answer(url, codeAnswer(url))
    await expect(running).resolves.toMatchObject({ clientId: "client" })
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ token: "ephemeral" }))
    expect(await listenerClosed(url)).toBe(true)
    expect(msal.clearCache).toHaveBeenCalled()
  })
})
