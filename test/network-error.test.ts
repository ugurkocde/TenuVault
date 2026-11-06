import { describe, expect, it } from "vitest"
import { networkFailure, ProxyAuthRequiredError, rejectProxyAuthResponses, withNetworkErrors } from "../src/main/api/network-error"

const failing = (error: unknown): typeof fetch => async () => { throw error }

describe("withNetworkErrors", () => {
  it.each([
    [new Error("net::ERR_PROXY_CONNECTION_FAILED"), "proxy settings", "ERR_PROXY_CONNECTION_FAILED"],
    [new Error("net::ERR_CERT_AUTHORITY_INVALID"), "trusted certificates", "ERR_CERT_AUTHORITY_INVALID"],
    [new Error("net::ERR_NAME_NOT_RESOLVED"), "allow HTTPS requests to graph.microsoft.com", "ERR_NAME_NOT_RESOLVED"],
    // Node's fetch keeps the reason on error.cause.
    [new TypeError("fetch failed", { cause: Object.assign(new Error("self signed"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }) }), "trusted certificates", "SELF_SIGNED_CERT_IN_CHAIN"],
    [new TypeError("fetch failed", { cause: Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }), "timed out", "UND_ERR_CONNECT_TIMEOUT"],
  ])("names the host, guidance and cause for %s", async (error, guidance, code) => {
    const request = withNetworkErrors(failing(error))("https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations")
    await expect(request).rejects.toThrow(`graph.microsoft.com could not be reached.`)
    await expect(request).rejects.toThrow(guidance)
    await expect(request).rejects.toThrow(`(${code})`)
    await expect(request).rejects.toMatchObject({ cause: error })
  })

  it("reads the host from Request and URL inputs", async () => {
    const wrapped = withNetworkErrors(failing(new TypeError("fetch failed")))
    await expect(wrapped(new Request("https://login.microsoftonline.com/x/oauth2/v2.0/token", { method: "POST", body: "a=b" }))).rejects.toThrow("login.microsoftonline.com could not be reached")
    await expect(wrapped(new URL("https://example.blob.core.windows.net/intune-backups"))).rejects.toThrow("example.blob.core.windows.net could not be reached")
  })

  it("passes aborts and timeouts through unchanged so callers can tell them apart", async () => {
    for (const name of ["AbortError", "TimeoutError"]) {
      const error = new DOMException("stopped", name)
      await expect(withNetworkErrors(failing(error))("https://graph.microsoft.com/")).rejects.toBe(error)
    }
  })

  it("returns responses untouched, including HTTP errors", async () => {
    const response = new Response("denied", { status: 403 })
    expect(await withNetworkErrors(async () => response)("https://graph.microsoft.com/")).toBe(response)
  })
})

describe("proxy authentication", () => {
  it("names proxy authentication for Chromium's proxy auth codes", async () => {
    for (const code of ["ERR_PROXY_AUTH_REQUESTED", "ERR_PROXY_AUTH_UNSUPPORTED", "ERR_UNEXPECTED_PROXY_AUTH"]) {
      const request = withNetworkErrors(failing(new Error(`net::${code}`)))("https://graph.microsoft.com/beta/")
      await expect(request).rejects.toThrow("The proxy on this network requires a sign-in.")
      await expect(request).rejects.toThrow(`(${code})`)
    }
  })

  it("turns a 407 answer into a proxy authentication failure", async () => {
    const proxied = rejectProxyAuthResponses(async () => new Response("<html>Proxy sign-in</html>", { status: 407 }))
    await expect(proxied("https://www.tenuvault.com/")).rejects.toBeInstanceOf(ProxyAuthRequiredError)
    expect(networkFailure(new ProxyAuthRequiredError(), "www.tenuvault.com")).toEqual({
      code: "HTTP 407",
      guidance: expect.stringContaining("requires a sign-in"),
    })
    const request = withNetworkErrors(proxied)("https://graph.microsoft.com/beta/")
    await expect(request).rejects.toThrow("graph.microsoft.com could not be reached. The proxy on this network requires a sign-in.")
    await expect(request).rejects.toThrow("(HTTP 407)")
  })

  it("passes every other answer through", async () => {
    const response = new Response("denied", { status: 401 })
    expect(await rejectProxyAuthResponses(async () => response)("https://graph.microsoft.com/")).toBe(response)
  })
})
