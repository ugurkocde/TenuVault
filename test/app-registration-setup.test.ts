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
import { AppRegistrationSetup, SETUP_SIGN_IN_TIMEOUT_MS, setupLoginHint, setupSignInError } from "../src/main/auth/app-registration-setup"
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

it("explains a refusal of Microsoft's sign-in app as that, not as a problem with the tenant's app registration", () => {
  for (const code of ["AADSTS700016", "AADSTS7000112", "AADSTS50105"]) {
    const message = (setupSignInError(new Error(`${code}: refused`)) as Error).message
    expect(message).toContain("Microsoft Graph Command Line Tools")
    expect(message).toContain(code)
    expect(message).not.toMatch(/setup script printed|client ID exists/)
    expect(message).toMatch(/Nothing was changed\.$/)
  }
})
it("keeps the shared wording for tenant, account and Conditional Access refusals", () => {
  expect((setupSignInError(new Error("AADSTS53003: blocked")) as Error).message).toMatch(/^Conditional Access blocked this sign-in\..*Nothing was changed\.$/)
  expect((setupSignInError(new Error("access_denied")) as Error).message).toBe("The sign-in was cancelled in the browser. Sign in again to continue. Nothing was changed.")
})
it("shows Microsoft's own words for a refusal it has no better text for", () => {
  // AADSTS50011 has a text for the tenant's app registration, which would mislead here.
  expect((setupSignInError(new Error("AADSTS50011: The redirect URI does not match.")) as Error).message).toBe("AADSTS50011: The redirect URI does not match. Nothing was changed.")
})
it.each(["https://evil.example", "a b", "contoso", "x".repeat(300) + ".com", 42])("refuses a tenant that is not a tenant ID or a domain (%s)", async tenant => {
  await expect(new AppRegistrationSetup(host()).create({ tenant: tenant as string })).rejects.toThrow("Enter a valid tenant ID or domain.")
  expect(state.interactive).not.toHaveBeenCalled()
})
it("runs one setup at a time", async () => {
  state.interactive.mockImplementationOnce(() => new Promise(() => {}))
  const setup = new AppRegistrationSetup(host())
  const first = setup.create()
  await expect(setup.create()).rejects.toThrow("Setup is already running.")
  setup.cancel()
  await expect(first).rejects.toThrow("Sign-in cancelled.")
})
it("skips the account picker only for the registration and account of the setup that just ran", () => {
  const expected = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", username: "admin@contoso.test" }
  expect(setupLoginHint(expected, expected.tenantId.toUpperCase(), expected.clientId, "admin@contoso.test")).toBe("admin@contoso.test")
  for (const [tenant, clientId, hint] of [
    [expected.tenantId, expected.clientId, "someone.else@contoso.test"],
    [expected.tenantId, "33333333-3333-4333-8333-333333333333", expected.username],
    ["contoso.onmicrosoft.com", expected.clientId, expected.username],
    [expected.tenantId, expected.clientId, undefined],
    [expected.tenantId, expected.clientId, 42],
  ]) expect(setupLoginHint(expected, tenant, clientId, hint)).toBeUndefined()
  expect(setupLoginHint(null, expected.tenantId, expected.clientId, expected.username)).toBeUndefined()
})

it("stops waiting for the browser after 15 minutes and discards a later answer", async () => {
  vi.useFakeTimers()
  try {
    let finish!: (value: unknown) => void
    state.interactive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const setup = new AppRegistrationSetup(host())
    const pending = setup.create()
    const outcome = pending.then(() => null, caught => caught as Error)
    await vi.advanceTimersByTimeAsync(SETUP_SIGN_IN_TIMEOUT_MS - 1000)
    expect(state.clear).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    const error = await outcome
    expect(error?.message).toMatch(/^The sign-in in the browser was not completed within 15 minutes\..*Nothing was changed\.$/)
    expect(state.provision).not.toHaveBeenCalled()
    // An answer that arrives afterwards creates nothing, and a new setup can start.
    finish({ account: { tenantId: "late", username: "admin" }, accessToken: "late" })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.provision).not.toHaveBeenCalled()
    state.interactive.mockImplementationOnce(() => new Promise(() => {}))
    const next = setup.create()
    setup.cancel()
    await expect(next).rejects.toThrow("Sign-in cancelled.")
  } finally { vi.useRealTimers() }
})
it("does not keep a timer running after a setup that finished", async () => {
  vi.useFakeTimers()
  try {
    state.interactive.mockResolvedValueOnce({ account: { tenantId: "tenant", username: "admin" }, accessToken: "ephemeral" })
    state.provision.mockResolvedValueOnce({ tenantId: "tenant", clientId: "client", username: "admin", reused: false, ready: true, displayName: "TenuVault Desktop", candidateCount: 0 })
    await new AppRegistrationSetup(host()).create()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
