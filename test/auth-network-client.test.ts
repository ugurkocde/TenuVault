import { describe, expect, it, vi } from "vitest"
import { fetchNetworkClient } from "../src/main/auth/network-client"

describe("fetchNetworkClient", () => {
  it("sends GET through the given fetch and answers in MSAL's shape", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ token_endpoint: "https://example.invalid/token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch
    const client = fetchNetworkClient(fetchImpl)
    const result = await client.sendGetRequestAsync<{ token_endpoint: string }>("https://example.invalid/openid")
    expect(result.status).toBe(200)
    expect(result.body.token_endpoint).toBe("https://example.invalid/token")
    expect(result.headers["content-type"]).toContain("application/json")
    expect(fetchImpl).toHaveBeenCalledWith("https://example.invalid/openid", expect.objectContaining({ method: "GET" }))
  })

  it("sends POST bodies and headers unchanged", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "token" })) as unknown as typeof fetch
    const client = fetchNetworkClient(fetchImpl)
    const result = await client.sendPostRequestAsync<{ access_token: string }>("https://example.invalid/token", {
      body: "grant_type=refresh_token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    expect(result.body.access_token).toBe("token")
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.invalid/token",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=refresh_token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )
  })

  it("reports a stalled GET as a request timeout, like MSAL's own client", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })) as unknown as typeof fetch
    const client = fetchNetworkClient(fetchImpl)
    await expect(client.sendGetRequestAsync("https://example.invalid/slow", {}, 10)).rejects.toThrow("Request timeout")
  })

  it("prefixes transport failures and unparseable answers like MSAL's own client", async () => {
    const down = fetchNetworkClient((async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch)
    await expect(down.sendPostRequestAsync("https://example.invalid/token")).rejects.toThrow("Network request failed: fetch failed")

    const html = fetchNetworkClient((async () => new Response("<html>blocked</html>", { status: 200 })) as unknown as typeof fetch)
    await expect(html.sendGetRequestAsync("https://example.invalid/openid")).rejects.toThrow(/^Failed to parse response: /)
  })
})
