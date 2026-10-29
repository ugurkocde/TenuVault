import type { ApiResponse, TenuVaultBridge } from "../../shared/ipc"
import { ACKNOWLEDGEMENT_REQUIRED, isAcknowledgementRequired } from "../../shared/disclaimer"
import { requestAcknowledgement } from "./disclaimer"

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * Returns the `/api/...` path (with query) when `raw` targets the app's own API, else null.
 *
 * The packaged app is served from file://, so "/api/x" resolves against the page URL.
 * On Windows that keeps the drive letter ("file:///C:/api/x"), which is stripped here.
 */
export function resolveApiPath(raw: string, base: string): string | null {
  if (raw.startsWith("/api/")) return raw
  const url = new URL(raw, base)
  const page = new URL(base)
  if (url.protocol !== page.protocol || url.host !== page.host) return null
  const match = /^(?:\/[A-Za-z]:)?(\/api\/.*)$/.exec(url.pathname)
  return match?.[1] ? `${match[1]}${url.search}` : null
}

/**
 * Routes the shared pages' `fetch("/api/...")` calls to the main-process API host over
 * IPC. Everything else uses the normal `fetch`.
 */
export function installFetchBridge(bridge: TenuVaultBridge): void {
  const nativeFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const path = resolveApiPath(raw, window.location.href)
    if (!path) return nativeFetch(input, init)

    // The IPC call itself cannot be cancelled, but aborting must still reject the fetch and
    // discard the answer, as a native fetch would. Callers rely on that to drop stale results.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    signal?.throwIfAborted()

    // Normalise every body type (string, FormData, Blob, ...) through Request.
    const request = new Request(`http://tenuvault.internal${path}`, {
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: init?.headers ?? (input instanceof Request ? input.headers : undefined),
      body: init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : undefined),
      signal,
    })
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer())

    const send = async (): Promise<ApiResponse> => {
      signal?.throwIfAborted()
      if (!signal) return bridge.api({ method: request.method, path, headers: Object.fromEntries(request.headers.entries()), body })
      let onAbort: (() => void) | undefined
      try {
        return await Promise.race([
          bridge.api({ method: request.method, path, headers: Object.fromEntries(request.headers.entries()), body }),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(signal.reason)
            signal.addEventListener("abort", onAbort, { once: true })
          }),
        ])
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort)
      }
    }
    let response = await send()
    // A write to a tenant that has not accepted the disclaimer: ask, then send it again.
    for (let attempt = 0; attempt < 2 && response.status === ACKNOWLEDGEMENT_REQUIRED; attempt++) {
      const tenantIds = acknowledgementTenants(response)
      if (!tenantIds || !(await requestAcknowledgement(tenantIds))) break
      response = await send()
    }

    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : new Uint8Array(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/** The tenants a 428 answer asks the disclaimer for, or null when it is another kind of 428. */
function acknowledgementTenants(response: ApiResponse): string[] | null {
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(response.body))
    return isAcknowledgementRequired(body) ? body.acknowledgement.tenantIds : null
  } catch {
    return null
  }
}
