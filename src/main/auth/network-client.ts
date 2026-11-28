import type { AuthenticationResult, INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node"
import { accessTokenDigest } from "./token-identity"

type TokenResponseObserver = (body: unknown, correlationId: string) => void

/** An absent scope list means the acquisition supplied no evidence of a grant. */
export type TokenGrant = { grantedScopes?: readonly string[] }

export function msalTokenGrants() {
  const grants = new Map<string, { correlationId: string; scopes: string[]; expiresAt: number }>()
  return {
    observe(body: unknown, correlationId: string) {
      const response = body as { access_token?: unknown; scope?: unknown; expires_in?: unknown } | null
      if (typeof response?.access_token !== "string" || !response.access_token) return
      const now = Date.now()
      for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key)
      const key = accessTokenDigest(response.access_token)
      if (typeof response.scope !== "string" || !response.scope.trim()) {
        grants.delete(key)
        return
      }
      const seconds = Number(response.expires_in)
      grants.set(key, { correlationId, scopes: response.scope.trim().split(/\s+/), expiresAt: now + (seconds > 0 && Number.isFinite(seconds) ? seconds : 60) * 1000 })
    },
    forResult(result: AuthenticationResult): TokenGrant {
      if (!result.accessToken) return {}
      const grant = grants.get(accessTokenDigest(result.accessToken))
      // MSAL also caches its requested-scope fallback. Reuse only evidence seen in this process.
      if (!grant || grant.expiresAt <= Date.now() || (!result.fromCache && grant.correlationId !== result.correlationId)) return {}
      return { grantedScopes: grant.scopes }
    },
  }
}

/**
 * MSAL networking on the fetch this app chooses (in production the bridged Chromium fetch, so
 * Microsoft token traffic follows the system proxy including PAC files and the operating
 * system's trusted certificates, like every other request the app makes).
 *
 * MSAL's default client calls the bare global fetch. That happened to be the right fetch here
 * because bootstrap replaces `globalThis.fetch`, but an msal-node upgrade that brings its own
 * HTTP stack would silently lose proxy and OS certificate support for token traffic alone,
 * behind corporate SSL inspection first. Passing the network module explicitly removes that
 * dependency on MSAL internals and on bootstrap order.
 *
 * Response and error shapes mirror MSAL's own HttpClient so messages stay the same.
 */
export function fetchNetworkClient(fetchImpl: typeof fetch, observeTokenResponse?: TokenResponseObserver): INetworkModule {
  async function send<T>(url: string, method: "GET" | "POST", options?: NetworkRequestOptions, timeout?: number): Promise<NetworkResponse<T>> {
    const controller = new AbortController()
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : undefined
    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers: options?.headers ?? {},
        ...(method === "POST" ? { body: options?.body ?? "" } : {}),
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Request timeout")
      throw new Error(`Network request failed: ${error instanceof Error ? error.message : "unknown"}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    try {
      const body = (await response.json()) as T
      if (observeTokenResponse && method === "POST" && response.ok && options?.correlationId) {
        observeTokenResponse(body, options.correlationId)
      }
      return { headers, body, status: response.status }
    } catch (error) {
      throw new Error(`Failed to parse response: ${error instanceof Error ? error.message : "unknown"}`)
    }
  }

  return {
    sendGetRequestAsync: (url, options, timeout) => send(url, "GET", options, timeout),
    sendPostRequestAsync: (url, options) => send(url, "POST", options),
  }
}
