import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { setTimeout } from "node:timers"
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

const HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" }
/** The largest answer body the listener reads. Microsoft's form_post answer is a few kilobytes. */
export const MAX_ANSWER_BYTES = 16 * 1024
/** How long the page for the accepted answer may take to reach the browser before its connection is dropped. */
const FLUSH_MS = 2000

/** Whether two strings are equal, in time that does not depend on where they differ. */
export function sameState(expected: string, received: string | null): boolean {
  if (received === null) return false
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(received, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Whether a posted answer belongs to this attempt and is one Microsoft sends: exactly one state,
 * equal to ours, and exactly one code or one error. Anything else leaves the attempt waiting.
 */
export function validAnswer(params: URLSearchParams, state: string): boolean {
  const states = params.getAll("state")
  const codes = params.getAll("code")
  const errors = params.getAll("error")
  return states.length === 1 && sameState(state, states[0]!) && codes.length + errors.length === 1 && (codes.length === 0 || codes[0] !== "")
}

/**
 * A listener on 127.0.0.1 and a random free port for one sign-in. Microsoft posts its answer to
 * `/` as a form (response_mode form_post, as MSAL's own interactive flow asks for), so the code and
 * the state never appear in an address or the browser history. The listener takes the first posted
 * answer that belongs to this attempt, answers it with the matching page and closes. Everything
 * else gets an error status and leaves the attempt waiting: other paths and methods, a wrong
 * content type, a body over MAX_ANSWER_BYTES, a missing, wrong or repeated state, and requests it
 * cannot parse.
 */
export async function openLoopback(pages: { successPage: string; errorPage: string }, state: string): Promise<{ port: number; answer: Promise<Answer>; close: () => void }> {
  let settle: (answer: Answer) => void = () => undefined
  const answer = new Promise<Answer>((resolve) => { settle = resolve })
  let accepted: Socket | null = null
  const sockets = new Set<Socket>()
  const reply = (response: ServerResponse, status: number) => {
    if (response.headersSent) return response.end()
    response.writeHead(status, HEADERS).end()
  }

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const target = request.url ?? ""
    const path = target.split("?", 1)[0]
    if (accepted || path !== "/") return reply(response, 404)
    if (request.method !== "POST") return reply(response, 405)
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return reply(response, 415)
    if (Number(request.headers["content-length"] ?? 0) > MAX_ANSWER_BYTES) {
      request.resume()
      return reply(response, 413)
    }
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    request.on("data", (chunk: Buffer) => {
      if (refused) return
      size += chunk.length
      if (size > MAX_ANSWER_BYTES) {
        refused = true
        reply(response, 413)
        return
      }
      chunks.push(chunk)
    })
    request.on("error", () => reply(response, 400))
    request.on("end", () => {
      if (refused) return
      try {
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
        if (accepted || !validAnswer(params, state)) return reply(response, accepted ? 404 : 400)
        accepted = request.socket
        response.writeHead(200, HEADERS).end(params.has("error") ? pages.errorPage : pages.successPage, () => close())
        settle(params)
      } catch {
        reply(response, 400)
      }
    })
  }

  const server: Server = createServer((request, response) => {
    // Nothing a request carries may throw out of here: an exception would end the main process.
    try {
      handle(request, response)
    } catch {
      reply(response, 400)
    }
  })
  server.on("connection", (socket: Socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  // Requests the HTTP parser rejects get a 400 and the connection is dropped.
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
    else socket.destroy()
  })

  // Stops listening and drops every connection, open or half open. Only the connection that
  // carries the page for the accepted answer may finish sending it, for a short while.
  const close = () => {
    if (server.listening) server.close()
    for (const socket of sockets) {
      if (socket === accepted) setTimeout(() => socket.destroy(), FLUSH_MS).unref()
      else socket.destroy()
    }
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
        responseMode: "form_post",
        ...(request.authority ? { authority: request.authority } : {}),
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.loginHint ? { loginHint: request.loginHint } : {}),
      }), stop)
    signal?.throwIfAborted()
    await unlessStopped(() => request.openBrowser(url), stop)
    const answer = await Promise.race([listener.answer, stop])
    listener.close()
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
