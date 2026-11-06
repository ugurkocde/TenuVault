import { Readable, Writable } from "node:stream"
import type { AuthInfo, ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from "electron"
import type { ProxyAuthAttempt } from "./proxy-auth"

/** Statuses whose responses never have a body, as in the Fetch standard. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

/** Header values reach Chromium as Latin-1 byte strings; this keeps UTF-8 values intact, as net.fetch does. */
function toByteString(value: string): string {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 255) return Buffer.from(value, "utf-8").toString("latin1")
  return value
}

/**
 * Chromium networking with proxy authentication: the system proxy (including PAC files) and the
 * operating system's trusted certificates apply, as with Electron's `net.fetch`.
 *
 * `net.fetch` cancels every authentication challenge, because it never listens for the request's
 * `login` event, and main-process requests do not raise the app `login` event either. A proxy
 * that answers 407 therefore failed every request. This is `net.fetch` on `net.request` (same
 * options, headers, redirects, aborts and body streaming) with that listener added: proxy
 * challenges go to `attempt()`, server challenges are cancelled as before.
 */
export function createChromiumFetch(
  request: (options: ClientRequestConstructorOptions) => ClientRequest,
  attempt: () => ProxyAuthAttempt,
): typeof fetch {
  return (input, init) => new Promise<Response>((resolve, reject) => {
    let req: Request
    try {
      req = new Request(input, init)
    } catch (error) {
      reject(error)
      return
    }
    const abortReason = () => req.signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
    const cancelBody = (reason: unknown) => {
      if (req.body) void req.body.cancel(reason).catch(() => undefined)
    }
    if (req.signal.aborted) {
      reject(abortReason())
      cancelBody(abortReason())
      return
    }
    const origin = req.headers.get("origin") ?? undefined
    // As in net.fetch: same-origin without an Origin header means the session's credentials apply.
    const credentials = req.credentials !== "same-origin" || origin ? req.credentials : "include"
    const client = request({
      method: req.method,
      url: req.url,
      origin,
      credentials,
      cache: req.cache,
      referrerPolicy: req.referrerPolicy,
      redirect: req.redirect,
    })
    let aborted = false
    req.signal.addEventListener("abort", () => {
      aborted = true
      reject(abortReason())
      cancelBody(abortReason())
      client.abort()
    }, { once: true })
    if (req.mode && (req.mode !== "cors" || origin)) client.setHeader("Sec-Fetch-Mode", req.mode)
    for (const [name, value] of req.headers) client.setHeader(name, value)

    const auth = attempt()
    client.on("login", (authInfo: AuthInfo, callback: (username?: string, password?: string) => void) => {
      auth.login(authInfo).then(
        (answer) => (answer && !aborted ? callback(answer.username, answer.password) : callback()),
        () => callback(),
      )
    })
    client.on("response", (message: IncomingMessage) => {
      if (aborted) return
      if (message.statusCode !== 407) auth.responded()
      try {
        const headers = new Headers()
        for (const [name, value] of Object.entries(message.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, toByteString(item))
          else if (typeof value === "string") headers.set(name, toByteString(value))
        }
        const body = NULL_BODY_STATUS.has(message.statusCode) || req.method === "HEAD"
          ? null
          : (Readable.toWeb(message as unknown as Readable) as ReadableStream<Uint8Array>)
        const response = new Response(body, { headers, status: message.statusCode, statusText: message.statusMessage })
        // Keeps the request alive while its body is read, as net.fetch does.
        Object.defineProperty(response, "__chromiumRequest", { value: client })
        resolve(response)
      } catch (error) {
        client.abort()
        reject(error)
      }
    })
    client.on("error", (error: Error) => reject(error))

    if (req.body) {
      req.body.pipeTo(Writable.toWeb(client as unknown as Writable)).then(() => client.end(), (error: unknown) => {
        client.abort()
        reject(error)
      })
    } else {
      client.end()
    }
  })
}
