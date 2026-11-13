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
import { suggestsCreatingByHand } from "../src/shared/app-registration"
const host = () => ({ fetch: vi.fn() as unknown as typeof fetch, openBrowser: vi.fn(async () => undefined), progress: vi.fn() })
beforeEach(() => { vi.clearAllMocks() })
it("uses an isolated memory client, setup scopes and the chosen tenant", async () => {
  const h = host()
  state.interactive.mockImplementationOnce(async (request: InteractiveRequest) => {
    await request.openBrowser("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize")
    expect(request.prompt).toBe("select_account")
    expect(request.scopes).toEqual(["https://graph.microsoft.com/Application.ReadWrite.All", "https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All"])
    // The browser is in front when the sign-in ends, so its page leads with what to do next.
    expect(request.successTemplate).toContain("<h1 style=\"font-size:1.6rem;margin:0 0 .6rem\">Go back to TenuVault</h1>")
    expect(request.successTemplate).toContain("TenuVault is setting up the app registration and continues there")
    // A green tick that draws itself, drawn at once for people who prefer reduced motion.
    expect(request.successTemplate).toContain('stroke="#16a34a"')
    expect(request.successTemplate).toContain("prefers-reduced-motion:reduce")
    expect(request.errorTemplate).toContain('stroke="#dc2626"')
    expect(request.errorTemplate).not.toContain("#16a34a")
    // The page loads nothing from anywhere: no script, no link, no image.
    for (const template of [request.successTemplate, request.errorTemplate]) expect(template).not.toMatch(/<script|<link|<img|https?:/)
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
it.each(["AADSTS65001: The user or administrator has not consented.", "AADSTS90094: Admin consent is required."])("says who can approve the setup when Microsoft refuses the approval (%s)", async message => {
  state.interactive.mockRejectedValueOnce(new Error(message))
  const error = await new AppRegistrationSetup(host()).create().then(() => null, caught => caught as Error)
  expect(error?.message).toContain("Microsoft did not let this account approve the setup")
  // A Privileged Role Administrator can grant the consent, but not always create the app registration.
  expect(error?.message).toContain("Global Administrator, Cloud Application Administrator or Application Administrator")
  expect(error?.message).not.toContain("Privileged Role Administrator")
  expect(error?.message).toContain("Nothing was changed.")
  expect(state.provision).not.toHaveBeenCalled()
  expect(state.clear).toHaveBeenCalled()
})

it("tells an admin who declined the approval that they declined it, not that they may not give it", () => {
  const message = (setupSignInError(new Error("AADSTS65004: User declined to consent to access the app.")) as Error).message
  expect(message).toBe(`You declined Microsoft's request to approve Microsoft Graph Command Line Tools (AADSTS65004). Select Try again and accept it, or use "Someone else is the admin?". Nothing was changed.`)
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
    // The setup script signs in through the same app, so it is not offered as the way around it.
    expect(message).toContain("the setup and the setup script sign in through")
    expect(message).not.toContain("Use the setup script instead")
    expect(suggestsCreatingByHand(message)).toBe(true)
    expect(message).toMatch(/Nothing was changed\.$/)
  }
})
it("names Microsoft Graph Command Line Tools and the manual route when Conditional Access blocks the setup sign-in", () => {
  const message = (setupSignInError(new Error("AADSTS53003: Access has been blocked by Conditional Access policies.")) as Error).message
  expect(message).toMatch(/^Conditional Access blocked the sign-in to Microsoft Graph Command Line Tools/)
  expect(message).toContain("(AADSTS53003)")
  // The policy may be about the device or the location, which the manual route does not get around.
  expect(message).toContain("If it asks for a compliant device or an allowed location, sign in from one and select Try again.")
  expect(message).toContain("If it blocks Microsoft Graph Command Line Tools, create the app registration by hand")
  expect(suggestsCreatingByHand(message)).toBe(true)
  expect(message).toMatch(/Nothing was changed\.$/)
})
it("keeps the shared wording for tenant, account and device refusals", () => {
  const device = (setupSignInError(new Error("AADSTS53000: Device is not in required device state.")) as Error).message
  expect(device).toMatch(/\(AADSTS53000\) Nothing was changed\.$/)
  expect(suggestsCreatingByHand(device)).toBe(false)
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
    // Microsoft's own error pages never return, so the timeout names both ways on.
    expect(error?.message).toContain("Someone else is the admin?")
    expect(suggestsCreatingByHand(error!.message)).toBe(true)
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
    state.provision.mockResolvedValueOnce({ tenantId: "tenant", clientId: "client", username: "admin", reused: false, ready: true, displayName: "TenuVault Desktop", candidateCount: 0, missingConsent: [] })
    await new AppRegistrationSetup(host()).create()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it("passes cancellation through after the browser sign-in has finished", async () => {
  state.interactive.mockResolvedValueOnce({ account: { tenantId: "tenant", username: "admin" }, accessToken: "ephemeral" })
  let started!: () => void
  const provisioning = new Promise<void>(resolve => { started = resolve })
  state.provision.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Sign-in cancelled.")), { once: true })
    started()
  }))
  const setup = new AppRegistrationSetup(host())
  const pending = setup.create()
  await provisioning
  setup.cancel()
  await expect(pending).rejects.toThrow("Sign-in cancelled.")
  expect(state.clear).toHaveBeenCalled()
})

it("reports how the setup sign-in and the provisioning ended, with codes and never messages", async () => {
  const report = vi.fn()
  const result = { tenantId: "tenant", clientId: "client", username: "admin@contoso.com", reused: true, ready: true, displayName: "TenuVault Desktop", candidateCount: 1, missingConsent: [] }
  state.interactive.mockResolvedValueOnce({ account: { tenantId: "tenant", username: "admin@contoso.com" }, accessToken: "ephemeral" })
  state.provision.mockResolvedValueOnce(result)
  await new AppRegistrationSetup({ ...host(), report }).create()
  expect(report.mock.calls.map(([event]) => event)).toEqual([
    { name: "setup_signin", props: { result: "ok" } },
    { name: "registration", props: { result: "reused" } },
  ])

  report.mockClear()
  state.interactive.mockRejectedValueOnce(new Error("AADSTS53003: Access has been blocked for admin@contoso.com."))
  await expect(new AppRegistrationSetup({ ...host(), report }).create()).rejects.toThrow("Conditional Access")
  expect(report.mock.calls.map(([event]) => event)).toEqual([{ name: "setup_signin", props: { result: "failed", code: "AADSTS53003" } }])

  report.mockClear()
  state.interactive.mockResolvedValueOnce({ account: { tenantId: "tenant", username: "admin" }, accessToken: "ephemeral" })
  state.provision.mockImplementationOnce(async ({ progress }: { progress: (value: { phase: string }) => void }) => {
    progress({ phase: "consent" })
    throw Object.assign(new Error("Graph POST failed: Insufficient privileges for contoso"), { status: 403 })
  })
  await expect(new AppRegistrationSetup({ ...host(), report }).create()).rejects.toThrow("Insufficient privileges")
  expect(report.mock.calls.at(-1)?.[0]).toEqual({ name: "registration", props: { result: "failed", phase: "consent", code: "HTTP_403" } })

  report.mockClear()
  state.interactive.mockResolvedValueOnce({ account: { tenantId: "tenant" }, accessToken: "ephemeral" })
  await expect(new AppRegistrationSetup({ ...host(), report }).create()).rejects.toThrow("did not return the tenant")
  expect(report.mock.calls.map(([event]) => event)).toEqual([{ name: "setup_signin", props: { result: "failed", code: "other" } }])
})

it("reports a cancelled sign-in, a cancelled provisioning and a timeout", async () => {
  const report = vi.fn()
  state.interactive.mockImplementationOnce(() => new Promise(() => {}))
  const cancelled = new AppRegistrationSetup({ ...host(), report })
  const pending = cancelled.create()
  cancelled.cancel()
  await expect(pending).rejects.toThrow("Sign-in cancelled.")
  expect(report).toHaveBeenLastCalledWith({ name: "setup_signin", props: { result: "cancelled" } })

  state.interactive.mockResolvedValueOnce({ account: { tenantId: "tenant", username: "admin" }, accessToken: "ephemeral" })
  let started!: () => void
  const provisioning = new Promise<void>(resolve => { started = resolve })
  state.provision.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Sign-in cancelled.")), { once: true })
    started()
  }))
  const stopped = new AppRegistrationSetup({ ...host(), report })
  const running = stopped.create()
  await provisioning
  stopped.cancel()
  await expect(running).rejects.toThrow("Sign-in cancelled.")
  expect(report).toHaveBeenLastCalledWith({ name: "registration", props: { result: "cancelled", phase: "registration" } })

  vi.useFakeTimers()
  try {
    state.interactive.mockImplementationOnce(() => new Promise(() => {}))
    const outcome = new AppRegistrationSetup({ ...host(), report }).create().then(() => null, caught => caught as Error)
    await vi.advanceTimersByTimeAsync(SETUP_SIGN_IN_TIMEOUT_MS)
    expect((await outcome)?.name).toBe("SignInTimeoutError")
    expect(report).toHaveBeenLastCalledWith({ name: "setup_signin", props: { result: "timeout" } })
  } finally { vi.useRealTimers() }
})

it.each([
  Object.assign(new Error("user_cancelled: User cancelled the flow."), { errorCode: "user_cancelled" }),
  Object.assign(new Error("authentication_canceled"), { errorCode: "authentication_canceled" }),
  new Error("access_denied: The user denied the request."),
])("reports MSAL's own cancellation codes as cancelled, never as an error (%s)", async error => {
  const report = vi.fn()
  state.interactive.mockRejectedValueOnce(error)
  await expect(new AppRegistrationSetup({ ...host(), report }).create()).rejects.toThrow()
  expect(report.mock.calls.map(([event]) => event)).toEqual([{ name: "setup_signin", props: { result: "cancelled" } }])
})

it("reports access_denied with an AADSTS code as a failure", async () => {
  const report = vi.fn()
  state.interactive.mockRejectedValueOnce(new Error("access_denied: AADSTS65004 User declined to consent."))
  await expect(new AppRegistrationSetup({ ...host(), report }).create()).rejects.toThrow()
  expect(report).toHaveBeenCalledWith({ name: "setup_signin", props: { result: "failed", code: "AADSTS65004" } })
})
