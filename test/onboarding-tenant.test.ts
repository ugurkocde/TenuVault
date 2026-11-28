import { expect, it, vi } from "vitest"
import { ORGANIZATIONS, resolveOnboardingTenant, signedInTenant } from "../src/main/auth/onboarding-tenant"

const TENANT = "4c1e5b0a-7d3f-4e2a-9b61-0f8d2c7a9e15"
const HOME = "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14"
const issuer = (tenant: string) => `https://login.microsoftonline.com/${tenant}/v2.0`

it("uses organizations for blank input and skips discovery for a tenant ID", async () => {
  const request = vi.fn<typeof fetch>()
  expect(await resolveOnboardingTenant("", request)).toBe(ORGANIZATIONS)
  expect(await resolveOnboardingTenant(TENANT.toUpperCase(), request)).toBe(TENANT)
  expect(request).not.toHaveBeenCalled()
})

it("resolves a guest's verified domain and accepts the target tenant from the ID token", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ issuer: issuer(TENANT) }))
  const tenant = await resolveOnboardingTenant(" Contoso.onmicrosoft.com ", request)
  expect(request).toHaveBeenCalledWith("https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0/.well-known/openid-configuration",
    expect.objectContaining({ redirect: "error" }))
  expect(signedInTenant(tenant, {
    account: { tenantId: TENANT }, tenantId: TENANT, idTokenClaims: { tid: TENANT },
  })).toBe(TENANT)
  expect(() => signedInTenant(tenant, { account: { tenantId: HOME }, idTokenClaims: { tid: HOME } })).toThrow("different tenant")
})

it.each([
  () => Response.json({ issuer: issuer("{tenantid}") }),
  () => Response.json({ issuer: `https://example.com/${TENANT}/v2.0` }),
  () => Response.json({ error: "not found" }, { status: 400 }),
  () => { throw new Error("offline") },
])("fails domain discovery instead of opening a browser against an unverified authority", async respond => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => respond())
  await expect(resolveOnboardingTenant("unverified.example", request)).rejects.toThrow("Could not find a Microsoft tenant")
})

it("binds an organizations sign-in to the ID token tid and rejects a missing or mismatched claim", () => {
  const account = { tenantId: TENANT }
  const token = (tid: string) => `header.${Buffer.from(JSON.stringify({ tid })).toString("base64url")}.signature`
  expect(signedInTenant(ORGANIZATIONS, { account, idToken: token(TENANT) })).toBe(TENANT)
  expect(() => signedInTenant(ORGANIZATIONS, { account })).toThrow("different tenant")
  expect(() => signedInTenant(ORGANIZATIONS, { account, idToken: token(HOME) })).toThrow("different tenant")
  expect(() => signedInTenant(HOME, { account, idToken: token(TENANT) })).toThrow("different tenant")
})
