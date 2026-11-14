import { expect, it, vi } from "vitest"
import type { AuthenticationResult, DeviceCodeRequest } from "@azure/msal-node"
import { deviceCodeSignIn } from "../src/main/auth/device-code-sign-in"
import { AppSourceService, type AppSourceHost } from "../src/main/app-sources/service"

const tenant = "11111111-1111-1111-1111-111111111111", other = "22222222-2222-2222-2222-222222222222"
const challenge = { verificationUri: "https://login.microsoft.com/device", userCode: "ABCD12345", expiresIn: 900, deviceCode: "never-expose-this", interval: 5, message: "private server message" }
const result = { account: { tenantId: tenant } } as AuthenticationResult
it("binds authority to the selected tenant and returns only the public Microsoft challenge", async () => {
  const shown = vi.fn()
  await deviceCodeSignIn(tenant, async request => {
    expect(request.authority).toBe(`https://login.microsoftonline.com/${tenant}`)
    expect(request.timeout).toBe(900)
    request.deviceCodeCallback(challenge); return result
  }, shown, new AbortController().signal)
  expect(shown).toHaveBeenCalledWith({ verificationUri: challenge.verificationUri, userCode: challenge.userCode, expiresAt: expect.any(String) })
  expect(JSON.stringify(shown.mock.calls)).not.toContain(challenge.deviceCode)
})
it.each([
  { verificationUri: "https://microsoft.com.attacker.test/code" },
  { verificationUri: "http://microsoft.com/devicelogin" },
  { userCode: "<script>" }, { expiresIn: 0 }, { expiresIn: 3600 },
])("refuses malformed or non-Microsoft challenges: %j", async invalid => {
  const shown = vi.fn()
  await expect(deviceCodeSignIn(tenant, async request => { request.deviceCodeCallback({ ...challenge, ...invalid }); return result }, shown, new AbortController().signal)).rejects.toThrow("invalid device sign-in challenge")
  expect(shown).not.toHaveBeenCalled()
})
it("rejects an account for another tenant", async () => {
  await expect(deviceCodeSignIn(tenant, async () => ({ account: { tenantId: other } }) as AuthenticationResult, vi.fn(), new AbortController().signal)).rejects.toThrow("does not belong")
})
it("explains a rejected public-client registration without exposing the raw OAuth error", async () => {
  await expect(deviceCodeSignIn(tenant, async () => { throw new Error("post_request_failed: invalid_client") }, vi.fn(), new AbortController().signal)).rejects.toThrow("Check that Allow public client flows is enabled")
})
it("stops polling on cancellation and rejects late successful authentication", async () => {
  const control = new AbortController()
  await expect(deviceCodeSignIn(tenant, async (request: DeviceCodeRequest) => {
    control.abort(); expect(request.cancel).toBe(true); return result
  }, vi.fn(), control.signal)).rejects.toThrow()
})
it("does not start an already cancelled request or accept a non-tenant authority", async () => {
  const acquire = vi.fn(), control = new AbortController(); control.abort()
  await expect(deviceCodeSignIn(tenant, acquire, vi.fn(), control.signal)).rejects.toThrow()
  await expect(deviceCodeSignIn("common", acquire, vi.fn(), new AbortController().signal)).rejects.toThrow("configured destination")
  expect(acquire).not.toHaveBeenCalled()
})
function service(signInWithDeviceCode: AppSourceHost["signInWithDeviceCode"]) {
  return new AppSourceService({ knownTenant: (id: string) => [tenant, other].includes(id), signInWithDeviceCode } as AppSourceHost)
}
const code = { verificationUri: challenge.verificationUri, userCode: challenge.userCode, expiresAt: new Date(Date.now() + 900000).toISOString() }
it("shares a pending code per tenant and exposes completion without tokens", async () => {
  let finish!: () => void
  const host = vi.fn(async (_tenant, callback) => { callback(code); await new Promise<void>(resolve => { finish = resolve }) })
  const api = service(host), first = api.deviceSignIn(tenant)
  expect(api.deviceSignIn(tenant)).toBe(first)
  await expect(first).resolves.toEqual(code)
  expect(host).toHaveBeenCalledTimes(1); expect(api.deviceSignInStatus(other)).toBeNull()
  finish(); await vi.waitFor(() => expect(api.deviceSignInStatus(tenant)).toEqual({ status: "completed" }))
  api.close()
})
it("cancels only the selected tenant and promptly rejects before a code arrives", async () => {
  const signals = new Map<string, AbortSignal>()
  const api = service(async (id, _callback, signal) => { signals.set(id, signal); await new Promise<void>(() => {}) })
  const first = api.deviceSignIn(tenant), second = api.deviceSignIn(other)
  const rejected = expect(first).rejects.toThrow("cancelled"), secondRejected = expect(second).rejects.toThrow("cancelled")
  await Promise.resolve(); api.cancelDeviceSignIn(tenant); await rejected
  expect(signals.get(tenant)?.aborted).toBe(true); expect(signals.get(other)?.aborted).toBe(false)
  api.close(); await secondRejected
})
it("reports a failed or missing challenge without hanging the caller", async () => {
  const api = service(async () => {})
  await expect(api.deviceSignIn(tenant)).rejects.toThrow("did not provide")
  expect(api.deviceSignInStatus(tenant)?.status).toBe("failed")
  expect(() => api.deviceSignIn("33333333-3333-3333-3333-333333333333")).toThrow("no longer configured")
})
