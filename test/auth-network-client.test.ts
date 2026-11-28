import { describe, expect, it, vi } from "vitest"
import { PublicClientApplication } from "@azure/msal-node"
import { TENUVAULT_CLIENT_ID } from "../src/shared/tenant-connection"
import { restoreSignIn } from "../src/main/restore/restore-actor"
import { fetchNetworkClient, msalTokenGrants } from "../src/main/auth/network-client"

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

it("keeps explicit response scopes apart from MSAL's scope fallback for the same requested set", async () => {
  const tenant = "11111111-1111-1111-1111-111111111111"
  const user = "22222222-2222-2222-2222-222222222222"
  const authority = `https://login.microsoftonline.com/${tenant}`
  const endpoint = `${authority}/oauth2/v2.0/token`
  const scope = "https://graph.microsoft.com/Policy.ReadWrite.Authorization"
  const now = Math.floor(Date.now() / 1000)
  const idToken = `header.${Buffer.from(JSON.stringify({ tid: tenant, oid: user, sub: "admin", iat: now, exp: now + 3600, aud: TENUVAULT_CLIENT_ID })).toString("base64url")}.signature`
  let sendScope = true
  let sendIdToken = true
  let accessToken = "opaque-graph"
  const grants = msalTokenGrants()
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/discovery/instance")) {
      return Response.json({ metadata: [{ preferred_network: url.host, preferred_cache: url.host, aliases: [url.host] }] })
    }
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ issuer: `${authority}/v2.0`, authorization_endpoint: `${authority}/oauth2/v2.0/authorize`, token_endpoint: endpoint })
    }
    expect(url.href.split("?")[0]).toBe(endpoint)
    return Response.json({
      access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: "fixture-refresh",
      ...(sendScope ? { scope } : {}),
      ...(sendIdToken ? { id_token: idToken, client_info: Buffer.from(JSON.stringify({ uid: user, utid: tenant })).toString("base64url") } : {}),
    })
  }
  const app = new PublicClientApplication({
    auth: { clientId: TENUVAULT_CLIENT_ID, authority },
    system: { networkClient: fetchNetworkClient(fetcher, grants.observe) },
  })
  const explicit = await app.acquireTokenByCode({ scopes: [scope], code: "fixture-code", redirectUri: "http://localhost" })
  const cachedAccount = explicit.account!
  const stored = { clientId: TENUVAULT_CLIENT_ID, homeAccountId: cachedAccount.homeAccountId }
  expect(explicit.scopes).toContain(scope)
  expect(restoreSignIn(tenant, stored, { ...explicit, cachedAccount, ...grants.forResult(explicit) }).authorization.scopes)
    .toEqual(["Policy.ReadWrite.Authorization"])

  const cached = await app.acquireTokenSilent({ account: cachedAccount, scopes: [scope] })
  expect(cached.fromCache).toBe(true)
  expect(grants.forResult(cached).grantedScopes).toEqual([scope])

  sendIdToken = false
  const silent = () => app.acquireTokenSilent({ account: cachedAccount, scopes: [scope], forceRefresh: true })
  const refreshed = await silent()
  expect(refreshed.account).toBeNull()
  expect(restoreSignIn(tenant, stored, { ...refreshed, cachedAccount, ...grants.forResult(refreshed) }).authorization.scopes)
    .toEqual(["Policy.ReadWrite.Authorization"])

  sendScope = false
  const omitted = await silent()
  expect(omitted.scopes).toContain(scope)
  expect(omitted.account).toBeNull()
  expect(grants.forResult(omitted).grantedScopes).toBeUndefined()
  expect(() => restoreSignIn(tenant, stored, { ...omitted, cachedAccount, ...grants.forResult(omitted) })).toThrow("signed-in admin")

  accessToken = `header.${Buffer.from(JSON.stringify({ tid: tenant, oid: user, azp: TENUVAULT_CLIENT_ID, scp: "Policy.ReadWrite.Authorization" })).toString("base64url")}.signature`
  const readable = await silent()
  expect(restoreSignIn(tenant, stored, { ...readable, cachedAccount, ...grants.forResult(readable) }).userId).toBe(user)
})
