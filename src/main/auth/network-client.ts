import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node"

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
export function fetchNetworkClient(fetchImpl: typeof fetch): INetworkModule {
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
      return { headers, body: (await response.json()) as T, status: response.status }
    } catch (error) {
      throw new Error(`Failed to parse response: ${error instanceof Error ? error.message : "unknown"}`)
    }
  }

  return {
    sendGetRequestAsync: (url, options, timeout) => send(url, "GET", options, timeout),
    sendPostRequestAsync: (url, options) => send(url, "POST", options),
  }
}
