import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { CryptoProvider, ServerError, type AuthenticationResult, type PublicClientApplication } from "@azure/msal-node"

/**
 * The interactive authorization code flow with PKCE, run by the app instead of by MSAL's
 * acquireTokenInteractive, so the app owns the loopback listener. MSAL 7 builds and keeps its own
 * listener, which stays open after the app stops waiting: a browser tab finished later would still
 * have its code redeemed into the token cache. Here every attempt has its own listener on
 * 127.0.0.1, which takes one answer and is closed when the attempt ends in any way. A late answer
 * reaches no listener, and no code is redeemed for an attempt the app gave up on.
 *
 * Tokens are still redeemed by MSAL (acquireTokenByCode), through the same client and its cache.
 */
export interface LoopbackSignInRequest {
  app: PublicClientApplication
  scopes: string[]
  authority?: string
  prompt?: string
  loginHint?: string
  /** Opens the Microsoft sign-in address in the browser. Checks the address first. */
  openBrowser: (url: string) => Promise<void>
  /** The page the browser shows after an answer with a code, and after an error answer. */
  successPage: string
  errorPage: string
  /** Ends the attempt: closes the listener and rejects with the abort reason, before any code is redeemed. */
  signal?: AbortSignal
  /**
   * Called when the browser answered with a code and the app is about to redeem it. From here
   * the attempt no longer waits for the browser, so a cancel or timeout no longer applies to it.
   */
  onAnswer?: () => void
}

/** The parameters of the one answer the listener accepted. */
type Answer = URLSearchParams

/** Thrown when the answer's state does not belong to this attempt. Nothing is redeemed. */
export class SignInStateMismatchError extends Error {
  constructor() {
    super("The answer from the browser does not belong to this sign-in, so it was not used. Nothing was signed in. Sign in again.")
    this.name = "SignInStateMismatchError"
  }
}

const HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" }

/** Whether two strings are equal, in time that does not depend on where they differ. */
export function sameState(expected: string, received: string | null): boolean {
  if (received === null) return false
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(received, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * A listener on 127.0.0.1 and a random free port for one sign-in. It takes the first GET on `/`
 * that carries a code or an error, answers it with the matching page and closes. Other requests,
 * such as the browser asking for a favicon, get a 404 and leave the attempt waiting.
 */
export async function openLoopback(pages: { successPage: string; errorPage: string }, state: string): Promise<{ port: number; answer: Promise<Answer>; close: () => void }> {
  let settle: (answer: Answer) => void = () => undefined
  const answer = new Promise<Answer>((resolve) => { settle = resolve })
  let answered = false
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const params = url.searchParams
    if (answered || request.method !== "GET" || url.pathname !== "/" || (!params.has("code") && !params.has("error"))) {
      response.writeHead(404, HEADERS).end()
      return
    }
    answered = true
    const ok = !params.has("error") && sameState(state, params.get("state"))
    response.writeHead(200, HEADERS).end(ok ? pages.successPage : pages.errorPage, () => close())
    settle(params)
  })
  // Stops accepting connections and drops idle ones; a page being sent still reaches the browser.
  const close = () => {
    if (!server.listening) return
    server.close()
    server.closeIdleConnections()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? ` (${String((error as { code: unknown }).code)})` : ""
    throw new Error(`TenuVault could not open a local port for the Microsoft sign-in${code}. Check that no security software blocks connections to 127.0.0.1 on this computer, then sign in again.`, { cause: error })
  }
  return { port: (server.address() as AddressInfo).port, answer, close }
}

/** Waits for `work` unless the attempt ends first; a late failure of `work` is then ignored. */
function unlessStopped<T>(work: () => Promise<T>, stop: Promise<never>): Promise<T> {
  const running = Promise.resolve().then(work)
  running.catch(() => undefined)
  return Promise.race([running, stop])
}

/** Rejects with the signal's reason once it aborts. */
function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

export async function loopbackSignIn(request: LoopbackSignInRequest): Promise<AuthenticationResult> {
  const { signal } = request
  signal?.throwIfAborted()
  const state = randomBytes(32).toString("base64url")
  const listener = await openLoopback(request, state)
  const stop = aborted(signal)
  stop.catch(() => undefined)
  try {
    const { verifier, challenge } = await new CryptoProvider().generatePkceCodes()
    const redirectUri = `http://localhost:${listener.port}`
    const url = await unlessStopped(() => request.app.getAuthCodeUrl({
        scopes: request.scopes,
        redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        state,
        responseMode: "query",
        ...(request.authority ? { authority: request.authority } : {}),
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.loginHint ? { loginHint: request.loginHint } : {}),
      }), stop)
    signal?.throwIfAborted()
    await unlessStopped(() => request.openBrowser(url), stop)
    const answer = await Promise.race([listener.answer, stop])
    listener.close()
    if (!sameState(state, answer.get("state"))) throw new SignInStateMismatchError()
    const error = answer.get("error")
    if (error) throw new ServerError(error, "", answer.get("error_description") ?? undefined, answer.get("error_subcode") ?? undefined)
    const code = answer.get("code")
    if (!code) throw new Error("Microsoft did not return an authorization code for this sign-in.")
    // The last point the attempt can still be abandoned: past it, the code is redeemed.
    signal?.throwIfAborted()
    request.onAnswer?.()
    return await request.app.acquireTokenByCode(
      {
        code,
        codeVerifier: verifier,
        redirectUri,
        scopes: request.scopes,
        ...(request.authority ? { authority: request.authority } : {}),
      },
      { code, ...(answer.get("client_info") ? { client_info: answer.get("client_info")! } : {}) },
    )
  } finally {
    listener.close()
  }
}
