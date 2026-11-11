import { beforeEach, expect, it, vi } from "vitest"
import type { Configuration, InteractiveRequest } from "@azure/msal-node"

const state = vi.hoisted(() => ({ interactive: vi.fn(), clear: vi.fn(async () => undefined), configuration: null as Configuration | null, provision: vi.fn() }))
vi.mock("@azure/msal-node", async original => {
  const actual = await original<typeof import("@azure/msal-node")>()
  return { ...actual, PublicClientApplication: class {
    constructor(configuration: Configuration) { state.configuration = configuration }
    acquireTokenInteractive = state.interactive
    clearCache = state.clear
  } }
})
vi.mock("../src/main/auth/registration-provisioning", () => ({ provisionRegistration: state.provision }))
import { AppRegistrationSetup } from "../src/main/auth/app-registration-setup"
const host = () => ({ fetch: vi.fn() as unknown as typeof fetch, openBrowser: vi.fn(async () => undefined), progress: vi.fn() })
beforeEach(() => { vi.clearAllMocks() })
it("uses an isolated memory client, setup scopes and the chosen tenant", async () => {
  const h = host()
  state.interactive.mockImplementationOnce(async (request: InteractiveRequest) => {
    await request.openBrowser("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize")
    expect(request.prompt).toBe("select_account")
    expect(request.scopes).toEqual(["https://graph.microsoft.com/Application.ReadWrite.All", "https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All"])
    expect(request.successTemplate).toContain("TenuVault is now setting up the app registration")
    return { account: { tenantId: "tenant", username: "admin" }, accessToken: "ephemeral" }
  })
  state.provision.mockResolvedValueOnce({ tenantId: "tenant", clientId: "client", username: "admin", reused: false, ready: true })
  const result = await new AppRegistrationSetup(h).create({ tenant: "example.test" })
  expect(state.configuration?.auth.authority).toBe("https://login.microsoftonline.com/example.test")
  expect(state.configuration).not.toHaveProperty("cache")
  expect(state.configuration?.system?.networkClient).toBeDefined()
  expect(state.provision).toHaveBeenCalledWith(expect.objectContaining({ token: "ephemeral", tenantId: "tenant", username: "admin" }))
  expect(result).not.toHaveProperty("token")
  expect(state.clear).toHaveBeenCalled()
})
it("cancels the browser wait, refuses a late browser open and clears a late answer", async () => {
  let request!: InteractiveRequest
  let finish!: (value: unknown) => void
  state.interactive.mockImplementationOnce((value: InteractiveRequest) => { request = value; return new Promise(resolve => { finish = resolve }) })
  const h = host()
  const setup = new AppRegistrationSetup(h)
  const pending = setup.create()
  setup.cancel()
  await expect(pending).rejects.toThrow("Sign-in cancelled.")
  expect(() => request.openBrowser("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize")).toThrow("Sign-in cancelled.")
  finish({ account: { tenantId: "late", username: "admin" }, accessToken: "late" })
  await Promise.resolve()
  expect(state.provision).not.toHaveBeenCalled()
  expect(h.openBrowser).not.toHaveBeenCalled()
  expect(state.clear).toHaveBeenCalledTimes(2)
})
it("refuses browser URLs outside Microsoft login", async () => {
  state.interactive.mockImplementationOnce(async (request: InteractiveRequest) => { await request.openBrowser("https://example.invalid/") })
  const h = host()
  await expect(new AppRegistrationSetup(h).create()).rejects.toThrow("unexpected sign-in address")
  expect(h.openBrowser).not.toHaveBeenCalled()
  expect(state.provision).not.toHaveBeenCalled()
})
it.each(["AADSTS65004: User declined to consent to access the app.", "AADSTS90094: Admin consent is required."])("says who can approve the setup when Microsoft refuses the approval (%s)", async message => {
  state.interactive.mockRejectedValueOnce(new Error(message))
  const error = await new AppRegistrationSetup(host()).create().then(() => null, caught => caught as Error)
  expect(error?.message).toContain("Microsoft did not let this account approve the setup")
  expect(error?.message).toContain("Global Administrator, Privileged Role Administrator or Cloud Application Administrator")
  expect(error?.message).toContain("Nothing was changed.")
  expect(state.provision).not.toHaveBeenCalled()
  expect(state.clear).toHaveBeenCalled()
})

it("says that nothing was changed when the setup sign-in fails for another reason", async () => {
  state.interactive.mockRejectedValueOnce(new Error("invalid_grant: AADSTS9002313: Invalid request."))
  await expect(new AppRegistrationSetup(host()).create()).rejects.toThrow("AADSTS9002313: Invalid request. Nothing was changed.")
  expect(state.provision).not.toHaveBeenCalled()
})
