import { request } from "node:http"
import { randomBytes } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { buildConsentUrl, consentIssue, HANDOFF_REDIRECT, PackConsentFlow, parseConsentCallback } from "../src/main/auth/pack-consent"
import { PACK_CONSENT_ERRORS } from "../src/shared/pack-consent"
import { TENUVAULT_CLIENT_ID } from "../src/shared/tenant-connection"
import { servicePack, tenantPermissionPacks, type PermissionPack } from "../src/shared/services/permission-packs"

const TENANT = "aaaaaaaa-1111-1111-1111-111111111111"
const ANOTHER = "bbbbbbbb-1111-1111-1111-111111111111"
const state = randomBytes(32).toString("base64url")
const pack = servicePack("intune", "backup")
const reply = (extra: Record<string, string> = {}) => new URLSearchParams({ state, tenant: TENANT, admin_consent: "True", ...extra })

describe("admin consent", () => {
  it("uses the tenant, fixed public client, explicit resource scopes, registered redirect and state", () => {
    const url = new URL(buildConsentUrl(TENANT, pack, "http://localhost:45000", state))
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0/adminconsent`)
    expect(url.searchParams.get("client_id")).toBe(TENUVAULT_CLIENT_ID)
    expect(url.searchParams.get("state")).toBe(state)
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:45000")
    expect(url.searchParams.get("scope")).toBe(pack.scopes.map(scope => `https://graph.microsoft.com/${scope}`).join(" "))
    const resources = tenantPermissionPacks({}, { azure: true, audit: false })
    const storage = resources.find(pack => pack.resource === "storage")!
    const management = resources.find(pack => pack.resource === "management")!
    expect(new URL(buildConsentUrl(TENANT, management, HANDOFF_REDIRECT, state)).searchParams.get("scope")).toBe("https://management.azure.com//user_impersonation")
    expect(new URL(buildConsentUrl(TENANT, storage, HANDOFF_REDIRECT, state)).searchParams.get("scope")).toBe("https://storage.azure.com/user_impersonation")
    expect(() => buildConsentUrl("organizations", pack, HANDOFF_REDIRECT, state)).toThrow()
    const onboarding = new URL(buildConsentUrl("organizations", { ...pack, id: "onboarding-backup" }, HANDOFF_REDIRECT, state))
    expect(onboarding.pathname).toBe("/organizations/v2.0/adminconsent")
    expect(parseConsentCallback(reply({ tenant: ANOTHER }), "organizations", state)).toMatchObject({ status: "received" })
    expect(parseConsentCallback(reply({ tenant: "organizations" }), "organizations", state)).toMatchObject({ status: "error" })
    expect(() => buildConsentUrl(TENANT, pack, "https://example.test", state)).toThrow()
    expect(() => buildConsentUrl(TENANT, pack, "http://localhost:99999", state)).toThrow()
    expect(() => buildConsentUrl(TENANT, pack, HANDOFF_REDIRECT, "")).toThrow()
  })

  it("validates state and tenant and treats the scope as a browser receipt", () => {
    expect(parseConsentCallback(reply({ scope: "User.Read Organization.Read.All" }), TENANT, state)).toEqual({ status: "received", scopes: ["User.Read", "Organization.Read.All"] })
    expect(parseConsentCallback(reply({ state: "tampered" }), TENANT, state)).toMatchObject({ status: "error", issue: { code: "invalid_callback" } })
    expect(parseConsentCallback(reply({ tenant: ANOTHER }), TENANT, state)).toMatchObject({ status: "error", issue: { code: "wrong_tenant" } })
    const duplicate = reply()
    duplicate.append("state", state)
    expect(parseConsentCallback(duplicate, TENANT, state)).toMatchObject({ status: "error", issue: { code: "invalid_callback" } })
    expect(parseConsentCallback(reply({ admin_consent: "False" }), TENANT, state)).toMatchObject({ status: "error" })
  })

  it.each(Object.entries(PACK_CONSENT_ERRORS))("gives an actionable next step for %s", (code, message) => {
    const description = code === "graph_forbidden" ? "Graph status 403" : code === "intune_unlicensed" ? "Intune tenant is not licensed" : code
    expect(consentIssue(description)).toEqual({ code, message })
    expect(parseConsentCallback(reply({ error: "consent_required", error_description: description }), TENANT, state))
      .toEqual({ status: "error", issue: { code, message } })
  })

  it("accepts error callbacks without a tenant and never returns the raw description", () => {
    const example = new URLSearchParams({ state, error: "access_denied", error_description: "AADSTS65004 account@example.test" })
    const response = parseConsentCallback(example, TENANT, state)
    expect(response).toMatchObject({ status: "error", issue: { code: "AADSTS65004" } })
    expect(JSON.stringify(response)).not.toContain("account@example.test")
  })

  it("opens the local listener and ignores invalid or wrong-tenant browser responses", async () => {
    const statuses: number[] = []
    const openBrowser = async (url: string) => {
      const params = new URL(url).searchParams
      const redirect = new URL(params.get("redirect_uri")!)
      expect(redirect.hostname).toBe("localhost")
      const callback = (query: URLSearchParams, host: string) => new Promise<number>((resolve, reject) => {
        request({ hostname: "127.0.0.1", port: redirect.port, path: `/?${query}`, headers: { Host: host } }, response => {
          response.resume()
          resolve(response.statusCode!)
        }).on("error", reject).end()
      })
      const valid = reply({ state: params.get("state")!, scope: "User.Read" })
      for (const paramsOfReply of [
        reply({ state: "wrong" }),
        reply({ state: params.get("state")!, tenant: ANOTHER }),
      ]) statuses.push(await callback(paramsOfReply, redirect.host))
      for (const host of [`foreign.example.test:${redirect.port}`, "localhost:0", redirect.host]) {
        statuses.push(await callback(valid, host))
        if (statuses.at(-1) === 200) break
      }
    }
    const flow = new PackConsentFlow({ plan: async () => [pack], openBrowser, signInForPack: async () => undefined })
    await expect(flow.act(TENANT, pack.id, "open")).resolves.toEqual({ status: "received" })
    expect(statuses).toEqual([400, 400, 400, 400, 200])
  })

  it("hands off one named pack and stays waiting until a fresh pack check succeeds", async () => {
    const openBrowser = vi.fn(async () => undefined)
    const signInForPack = vi.fn<(_tenant: string, _pack: PermissionPack, _check: boolean) => Promise<void>>()
      .mockRejectedValueOnce(new Error("AADSTS90095"))
      .mockRejectedValueOnce(new Error("AADSTS65001"))
      .mockResolvedValueOnce(undefined)
    const flow = new PackConsentFlow({ plan: async () => [pack], openBrowser, signInForPack })
    const handoff = await flow.act(TENANT, pack.id, "handoff")
    expect(handoff).toMatchObject({ status: "handoff", message: expect.stringContaining(pack.label) })
    expect(openBrowser).not.toHaveBeenCalled()
    await expect(flow.act(TENANT, "entra-privileged", "handoff")).resolves.toMatchObject({ status: "error" })
    await expect(flow.act(TENANT, pack.id, "request")).resolves.toMatchObject({ status: "waiting", issue: { code: "AADSTS90095" } })
    await expect(flow.act(TENANT, pack.id, "check")).resolves.toMatchObject({ status: "waiting", issue: { code: "AADSTS65001" } })
    await expect(flow.act(TENANT, pack.id, "check")).resolves.toEqual({ status: "verified" })
    expect(signInForPack.mock.calls).toEqual([[TENANT, pack, false], [TENANT, pack, true], [TENANT, pack, true]])
  })
})
