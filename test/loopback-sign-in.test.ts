import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AuthorizationUrlRequest, PublicClientApplication } from "@azure/msal-node"
import { loopbackSignIn, sameState, SignInStateMismatchError, type LoopbackSignInRequest } from "../src/main/auth/loopback-sign-in"
import { firstSignInError } from "../src/main/auth/msal"
import { signInResult } from "../src/main/setup-diagnostics/events"
import { answer, authCodeUrl, codeAnswer, listenerClosed } from "./helpers/fake-browser"

const RESULT = { accessToken: "token", account: { tenantId: "tenant", username: "admin@contoso.example", homeAccountId: "home" } }

function fakeApp() {
  return {
    getAuthCodeUrl: vi.fn(async (request: AuthorizationUrlRequest) => authCodeUrl(request)),
    acquireTokenByCode: vi.fn(async (..._args: unknown[]) => RESULT),
  }
}

/** Starts a sign-in and resolves with the address it opened in the browser. */
function start(overrides: Partial<LoopbackSignInRequest> = {}) {
  const app = fakeApp()
  let opened!: (url: string) => void
  const browser = new Promise<string>((resolve) => { opened = resolve })
  const openBrowser = vi.fn(async (url: string) => opened(url))
  const outcome = loopbackSignIn({
    app: app as unknown as PublicClientApplication,
    scopes: ["https://graph.microsoft.com/.default"],
    authority: "https://login.microsoftonline.com/tenant",
    openBrowser,
    successPage: "<p>signed in</p>",
    errorPage: "<p>failed</p>",
    ...overrides,
  })
  const settled = outcome.then(() => null, (error: unknown) => error as Error)
  return { app, browser, openBrowser, outcome, settled }
}

afterEach(() => { vi.useRealTimers() })

describe("loopbackSignIn", () => {
  it("signs in with PKCE and a state of its own, and redeems the code once through MSAL", async () => {
    const onAnswer = vi.fn()
    const { app, browser, outcome } = start({ prompt: "select_account", onAnswer })
    const url = await browser
    const request = app.getAuthCodeUrl.mock.lastCall![0]
    expect(request.redirectUri).toMatch(/^http:\/\/localhost:\d+$/)
    expect(request).toMatchObject({ codeChallengeMethod: "S256", responseMode: "query", prompt: "select_account", authority: "https://login.microsoftonline.com/tenant" })
    expect(request.state!.length).toBeGreaterThanOrEqual(43)

    const page = await answer(url, codeAnswer(url))
    expect(await page.text()).toBe("<p>signed in</p>")
    await expect(outcome).resolves.toBe(RESULT)
    expect(onAnswer).toHaveBeenCalledOnce()
    expect(app.acquireTokenByCode).toHaveBeenCalledOnce()
    const [tokenRequest, payload] = app.acquireTokenByCode.mock.lastCall! as [{ code: string; codeVerifier: string; redirectUri: string; scopes: string[] }, { code: string; client_info?: string }]
    expect(tokenRequest).toMatchObject({ code: "auth-code", redirectUri: request.redirectUri, scopes: ["https://graph.microsoft.com/.default"], authority: "https://login.microsoftonline.com/tenant" })
    // The verifier belongs to the challenge that went to Microsoft.
    expect(createHash("sha256").update(tokenRequest.codeVerifier).digest("base64url")).toBe(request.codeChallenge)
    expect(payload).toEqual({ code: "auth-code", client_info: "eyJ1aWQiOiJ1In0" })
    expect(await listenerClosed(url)).toBe(true)
  })

  it("passes a login hint and leaves out the prompt when there is none", async () => {
    const { app, browser, outcome } = start({ loginHint: "admin@contoso.example" })
    const url = await browser
    expect(app.getAuthCodeUrl.mock.lastCall![0]).toMatchObject({ loginHint: "admin@contoso.example" })
    expect(app.getAuthCodeUrl.mock.lastCall![0]).not.toHaveProperty("prompt")
    await answer(url, codeAnswer(url))
    await outcome
  })

  it("rejects an answer with another state and redeems nothing", async () => {
    const { app, browser, settled } = start()
    const url = await browser
    const page = await answer(url, { code: "stolen", state: "not-this-sign-in" })
    expect(await page.text()).toBe("<p>failed</p>")
    expect(await settled).toBeInstanceOf(SignInStateMismatchError)
    expect(app.acquireTokenByCode).not.toHaveBeenCalled()
    expect(await listenerClosed(url)).toBe(true)
  })

  it("rejects an answer without a state", async () => {
    const { app, browser, settled } = start()
    const url = await browser
    await answer(url, { code: "no-state" })
    expect(await settled).toBeInstanceOf(SignInStateMismatchError)
    expect(app.acquireTokenByCode).not.toHaveBeenCalled()
  })

  it("maps Microsoft's error answers as before, and redeems nothing", async () => {
    const { app, browser, settled } = start()
    const url = await browser
    const state = new URL(url).searchParams.get("state")!
    const page = await answer(url, { error: "access_denied", error_description: "AADSTS53003: Access has been blocked by Conditional Access policies.", state })
    expect(await page.text()).toBe("<p>failed</p>")
    const error = await settled
    expect(error).toMatchObject({ name: "ServerError", errorCode: "access_denied" })
    expect(error?.message).toContain("AADSTS53003")
    expect((firstSignInError(error) as Error).message).toMatch(/^Conditional Access blocked this sign-in\..*\(AADSTS53003\)$/)
    expect(signInResult(error)).toBe("failed")
    expect(app.acquireTokenByCode).not.toHaveBeenCalled()
    expect(await listenerClosed(url)).toBe(true)
  })

  it("reports a cancel in the browser as cancelled", async () => {
    const { browser, settled } = start()
    const url = await browser
    await answer(url, { error: "access_denied", error_description: "The user has cancelled.", state: new URL(url).searchParams.get("state")! })
    const error = await settled
    expect(signInResult(error)).toBe("cancelled")
    expect((firstSignInError(error) as Error).message).toBe("The sign-in was cancelled in the browser. Sign in again to continue.")
  })

  it("ignores unrelated requests without ending the sign-in", async () => {
    const { app, browser, outcome } = start()
    const url = await browser
    const loopback = new URL(new URL(url).searchParams.get("redirect_uri")!).port
    expect((await fetch(`http://127.0.0.1:${loopback}/favicon.ico`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${loopback}/`)).status).toBe(404)
    expect((await answer(url, codeAnswer(url), "/other")).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${loopback}/?${new URLSearchParams(codeAnswer(url))}`, { method: "POST" })).status).toBe(404)
    expect(app.acquireTokenByCode).not.toHaveBeenCalled()
    await answer(url, codeAnswer(url))
    await expect(outcome).resolves.toBe(RESULT)
  })

  it("takes one answer only", async () => {
    let release!: () => void
    const redeeming = new Promise<void>((resolve) => { release = resolve })
    const app = fakeApp()
    app.acquireTokenByCode.mockImplementationOnce(async () => { await redeeming; return RESULT })
    let opened!: (url: string) => void
    const browser = new Promise<string>((resolve) => { opened = resolve })
    const outcome = loopbackSignIn({ app: app as unknown as PublicClientApplication, scopes: ["s"], openBrowser: async (url) => opened(url), successPage: "ok", errorPage: "no" })
    const url = await browser
    await answer(url, codeAnswer(url, "first"))
    expect(await listenerClosed(url)).toBe(true)
    release()
    await outcome
    expect(app.acquireTokenByCode).toHaveBeenCalledOnce()
  })

  it("closes the listener and redeems nothing when the attempt is abandoned while it waits", async () => {
    const controller = new AbortController()
    const onAnswer = vi.fn()
    const { app, browser, settled } = start({ signal: controller.signal, onAnswer })
    const url = await browser
    const reason = new Error("Sign-in cancelled.")
    controller.abort(reason)
    expect(await settled).toBe(reason)
    expect(await listenerClosed(url)).toBe(true)
    expect(app.acquireTokenByCode).not.toHaveBeenCalled()
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("never opens the browser for an attempt abandoned before", async () => {
    const controller = new AbortController()
    const app = fakeApp()
    let release!: (url: string) => void
    app.getAuthCodeUrl.mockImplementationOnce((request) => new Promise((resolve) => { release = () => resolve(authCodeUrl(request)) }))
    const openBrowser = vi.fn(async () => undefined)
    const outcome = loopbackSignIn({ app: app as unknown as PublicClientApplication, scopes: ["s"], openBrowser, successPage: "ok", errorPage: "no", signal: controller.signal }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(app.getAuthCodeUrl).toHaveBeenCalled())
    const url = authCodeUrl(app.getAuthCodeUrl.mock.lastCall![0])
    controller.abort(new Error("Sign-in cancelled."))
    release(url)
    expect(await outcome).toMatchObject({ message: "Sign-in cancelled." })
    expect(openBrowser).not.toHaveBeenCalled()
    expect(await listenerClosed(url)).toBe(true)
  })

  it("closes the listener when the browser cannot be opened", async () => {
    let refused = ""
    const { app, settled } = start({ openBrowser: async (url) => { refused = url; throw new Error("Microsoft returned an unexpected sign-in address.") } })
    expect((await settled)?.message).toBe("Microsoft returned an unexpected sign-in address.")
    expect(await listenerClosed(refused)).toBe(true)
    expect(app.acquireTokenByCode).not.toHaveBeenCalled()
  })

  it("compares states in constant time and only equal ones match", () => {
    expect(sameState("abc", "abc")).toBe(true)
    expect(sameState("abc", "abd")).toBe(false)
    expect(sameState("abc", "abcd")).toBe(false)
    expect(sameState("abc", null)).toBe(false)
  })
})
