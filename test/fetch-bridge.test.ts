import { describe, expect, it, vi } from "vitest"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { DELEGATED_CLIENT_SECRET, INTERNAL_API_ORIGIN, localStorageAccountName } from "../src/shared/constants"
import { withRouteTenant } from "../src/main/storage/blob-emulator"
import { encryptedAzureFetch } from "../src/main/storage/azure-seal"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"

/** The exact request shape the shared route code sends. */
function routeTokenRequest(fetchImpl: typeof fetch, secret: string, scope = "https://graph.microsoft.com/.default") {
  return fetchImpl(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT, client_secret: secret, scope, grant_type: "client_credentials" }),
  })
}

describe("createBridgedFetch", () => {
  it("answers placeholder client credential requests with a delegated token", async () => {
    const realFetch = vi.fn<typeof fetch>()
    const getDelegatedToken = vi.fn(async () => ({ accessToken: "delegated-token", expiresOn: new Date(Date.now() + 600_000) }))
    const bridged = createBridgedFetch({ dispatch: vi.fn(), getDelegatedToken, fetch: realFetch })

    const response = await routeTokenRequest(bridged, DELEGATED_CLIENT_SECRET, "https://management.azure.com/.default")
    const body = (await response.json()) as { access_token: string; expires_in: number; token_type: string }

    expect(response.ok).toBe(true)
    expect(body.access_token).toBe("delegated-token")
    expect(body.token_type).toBe("Bearer")
    expect(body.expires_in).toBeGreaterThan(590)
    expect(getDelegatedToken).toHaveBeenCalledWith(TENANT, CLIENT, "https://management.azure.com/.default", false)
    expect(realFetch).not.toHaveBeenCalled()
  })

  it("needs no Azure Storage token for a route on local storage", async () => {
    const realFetch = vi.fn<typeof fetch>()
    const getDelegatedToken = vi.fn(async () => {
      throw new Error("AADSTS65001: no consent for Azure Storage")
    })
    const bridged = createBridgedFetch({ dispatch: vi.fn(), getDelegatedToken, fetch: realFetch })
    const storage = "https://storage.azure.com/.default"

    const local = await withRouteTenant(TENANT, () => routeTokenRequest(bridged, DELEGATED_CLIENT_SECRET, storage), localStorageAccountName(TENANT))
    expect(local.ok).toBe(true)
    expect(getDelegatedToken).not.toHaveBeenCalled()

    // Azure storage accounts, other tenants' local stores and other scopes still need the real token.
    for (const [account, scope] of [["mystorageaccount", storage], [localStorageAccountName("33333333-3333-3333-3333-333333333333"), storage], [localStorageAccountName(TENANT), "https://graph.microsoft.com/.default"]]) {
      const response = await withRouteTenant(TENANT, () => routeTokenRequest(bridged, DELEGATED_CLIENT_SECRET, scope), account)
      expect(response.status).toBe(401)
    }
    expect(getDelegatedToken).toHaveBeenCalledTimes(3)
    expect(realFetch).not.toHaveBeenCalled()
  })

  it("never sends the placeholder secret to Microsoft", async () => {
    const realFetch = vi.fn<typeof fetch>()
    const bridged = createBridgedFetch({
      dispatch: vi.fn(),
      getDelegatedToken: async () => {
        throw new Error("Your license has expired.")
      },
      fetch: realFetch,
    })

    const response = await routeTokenRequest(bridged, DELEGATED_CLIENT_SECRET)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error_description: "Your license has expired." })
    expect(realFetch).not.toHaveBeenCalled()
  })

  it("passes real client secrets through to Microsoft untouched", async () => {
    const realFetch = vi.fn<typeof fetch>(async () => Response.json({ access_token: "app-token" }))
    const getDelegatedToken = vi.fn()
    const bridged = createBridgedFetch({ dispatch: vi.fn(), getDelegatedToken, fetch: realFetch })

    await routeTokenRequest(bridged, "real-secret")
    expect(getDelegatedToken).not.toHaveBeenCalled()
    const sent = realFetch.mock.calls[0]![0] as Request
    expect(await sent.text()).toContain("client_secret=real-secret")
  })

  it("applies the license check to every client credentials request", async () => {
    const realFetch = vi.fn<typeof fetch>()
    const getDelegatedToken = vi.fn()
    const bridged = createBridgedFetch({
      dispatch: vi.fn(),
      getDelegatedToken,
      authorizeTenant: () => {
        throw new Error("All licensed tenants are in use.")
      },
      fetch: realFetch,
    })

    for (const secret of [DELEGATED_CLIENT_SECRET, "real-secret"]) {
      const response = await routeTokenRequest(bridged, secret)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error_description: "All licensed tenants are in use." })
    }
    expect(getDelegatedToken).not.toHaveBeenCalled()
    expect(realFetch).not.toHaveBeenCalled()
  })

  it("dispatches calls to the internal API origin in-process", async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }))
    const realFetch = vi.fn<typeof fetch>()
    const bridged = createBridgedFetch({ dispatch, getDelegatedToken: vi.fn(), fetch: realFetch })

    await bridged(`${INTERNAL_API_ORIGIN}/api/audit/log`, { method: "POST", body: "{}" })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(realFetch).not.toHaveBeenCalled()
  })

  it("leaves Graph and Azure calls alone", async () => {
    const realFetch = vi.fn<typeof fetch>(async () => new Response("{}"))
    const bridged = createBridgedFetch({ dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: realFetch })
    await bridged("https://graph.microsoft.com/v1.0/organization", { headers: { Authorization: "Bearer x" } })
    expect(realFetch).toHaveBeenCalledWith("https://graph.microsoft.com/v1.0/organization", {
      headers: { Authorization: "Bearer x" },
    })
  })

  it("applies the license check to local backup storage", async () => {
    const handleLocalBlob = vi.fn(async () => new Response("ok"))
    const authorizeTenant = vi.fn(async (tenant: string) => {
      if (tenant !== TENANT) throw new Error("A TenuVault license is required for this tenant.")
    })
    const bridged = createBridgedFetch({ dispatch: vi.fn(), getDelegatedToken: vi.fn(), authorizeTenant, handleLocalBlob })

    expect(await (await bridged(`https://tvlocal-${TENANT}.blob.core.windows.net/intune-backups?restype=container`)).text()).toBe("ok")
    const other = "33333333-3333-3333-3333-333333333333"
    const denied = await bridged(`https://tvlocal-${other}.blob.core.windows.net/intune-backups?restype=container`)
    expect(denied.status).toBe(403)
    expect(await denied.text()).toContain("A TenuVault license is required")
    expect(authorizeTenant.mock.calls).toEqual([[TENANT], [other]])
    expect(handleLocalBlob).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["a token", Response.json({ token_type: "Bearer", access_token: "fresh-storage-token", expires_in: 3600 }), "fresh-storage-token", true],
    ["a network sign-in page", new Response("<html><body>Sign in to the network</body></html>", { status: 200, headers: { "content-type": "text/html" } }), "unissued-storage-token", false],
  ] as const)("returns %s answering an Azure Storage token request and registers only a token", async (_kind, answer, token, registered) => {
    const bridged = createBridgedFetch({ dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: async () => answer.clone() })
    const response = await routeTokenRequest(bridged, "secret", "https://storage.azure.com/.default")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(await answer.clone().text())
    // A registered token binds Azure Storage uploads to the tenant, so the sealed upload is sent.
    const storage = vi.fn(async () => new Response(null, { status: 201 }))
    const upload = encryptedAzureFetch(storage, () => [Buffer.alloc(32, 1)], () => undefined)("https://contoso.blob.core.windows.net/intune-backups/backup-1/policy.json", {
      method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: "{}",
    })
    if (registered) await expect(upload).resolves.toMatchObject({ status: 201 })
    else await expect(upload).rejects.toThrow("Backup tenant context is unavailable")
    expect(storage).toHaveBeenCalledTimes(registered ? 1 : 0)
  })
})

describe("createBridgedFetch token URLs", () => {
  it("refuses a token URL whose tenant path URL parsing would rewrite, before licensing or signing in", async () => {
    const realFetch = vi.fn<typeof fetch>()
    const authorizeTenant = vi.fn()
    const getDelegatedToken = vi.fn(async () => ({ accessToken: "delegated-token", expiresOn: null }))
    const bridged = createBridgedFetch({ dispatch: vi.fn(), getDelegatedToken, authorizeTenant, fetch: realFetch })
    for (const tenant of [`x/../${TENANT}`, `x/./../${TENANT}`, `x/%2e%2e/${TENANT}`]) {
      const response = await bridged(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: "POST",
        body: new URLSearchParams({ client_id: CLIENT, client_secret: DELEGATED_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
      })
      expect(response.status).toBe(400)
    }
    expect(authorizeTenant).not.toHaveBeenCalled()
    expect(getDelegatedToken).not.toHaveBeenCalled()
    expect(realFetch).not.toHaveBeenCalled()
    // A plain tenant ID still works.
    expect((await routeTokenRequest(bridged, DELEGATED_CLIENT_SECRET)).ok).toBe(true)
  })
})
