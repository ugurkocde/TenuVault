import { afterEach, describe, expect, it, vi } from "vitest"
import type { StagedSignIn } from "../src/main/auth/tenant-connections"
import { WizardSignIn } from "../src/main/auth/wizard-sign-in"
import { TENUVAULT_CLIENT_ID } from "../src/shared/tenant-connection"

const TENANT = "39cc968d-dd54-4f13-815b-ebbcff25e104"
const OTHER = "44444444-4444-4444-8444-444444444444"
const CHOICE = { intune: { access: "restore" } }
const account = (clientId: string) => ({ tenantId: TENANT, clientId, homeAccountId: "internal", username: "admin@example.test" })

function fixture() {
  const host = {
    connected: vi.fn((_tenant: string) => false),
    enabled: vi.fn(async () => true),
    stage: vi.fn(async (_tenant?: string, _method?: "tenuvaultApp", _choice?: unknown): Promise<StagedSignIn> => ({
      account: account(TENUVAULT_CLIENT_ID),
      accessToken: "opaque",
      idToken: "id-proof",
      grantedScopes: ["User.Read", "Organization.Read.All", "DeviceManagementConfiguration.Read.All"],
      cacheWrites: () => ({ key: "staged-cache" }),
    })),
    fetch: vi.fn<typeof fetch>(async () => Response.json({ value: [{ id: TENANT, displayName: "Contoso Ltd" }] })),
    startTrial: vi.fn(async () => undefined),
    checkLicense: vi.fn(async () => undefined),
    releaseLicense: vi.fn(async () => undefined),
    enroll: vi.fn(),
  }
  return { host, wizard: new WizardSignIn(host) }
}

afterEach(() => vi.useRealTimers())

describe("staged wizard sign-in", () => {
  it("reads the tenant name using the staged TenuVault app bearer", async () => {
    const { host, wizard } = fixture()
    const staged = await wizard.stage("", "tenuvaultApp", CHOICE)
    expect(staged).toMatchObject({ result: { organizationName: "Contoso Ltd" } })
    if ("result" in staged) {
      const { id } = staged.result
      expect(wizard.azureStorageSignIn("wrong-id", TENANT)).toBeUndefined()
      expect(wizard.azureStorageSignIn(id, OTHER)).toBeUndefined()
      expect(wizard.azureStorageSignIn(id, TENANT)?.account.clientId).toBe(TENUVAULT_CLIENT_ID)
      wizard.discard(id)
      expect(wizard.azureStorageSignIn(id, TENANT)).toBeUndefined()
    }
    expect(host.fetch).toHaveBeenCalledWith("https://graph.microsoft.com/beta/organization?$select=id,displayName", expect.objectContaining({
      headers: { Authorization: "Bearer opaque" }, redirect: "error",
    }))
    expect(JSON.stringify(staged)).not.toContain("opaque")
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it.each([
    () => new Response(null, { status: 403 }),
    () => Response.json({ value: [{ id: OTHER, displayName: "Another tenant" }] }),
  ])("falls back to the signed-in tenant ID if its organization name is unavailable", async reply => {
    const { host, wizard } = fixture()
    host.fetch.mockImplementationOnce(async () => reply())
    const staged = await wizard.stage("", "tenuvaultApp", CHOICE)
    expect(staged).toMatchObject({ result: { account: { tenantId: TENANT }, organizationName: undefined } })
  })

  it("leaves no organization activation after quitting TenuVault app before Storage", async () => {
    const { host, wizard } = fixture()
    // The service keeps the slot across app restarts, while the staged proof was in process memory.
    const slots = new Set<string>()
    host.checkLicense.mockImplementation(async () => { slots.add(TENANT) })
    const staged = await wizard.stage(TENANT, "tenuvaultApp", CHOICE)
    expect(staged).toHaveProperty("result.id")
    const id = "result" in staged ? staged.result.id : ""
    const restarted = new WizardSignIn(host)
    await expect(restarted.finish(id, "profile", CHOICE)).resolves.toMatchObject({ error: { code: "sign_in_required" } })
    expect(slots.size).toBe(0)
    expect(host.checkLicense).not.toHaveBeenCalled()
    const resumed = await restarted.stage(TENANT, "tenuvaultApp", CHOICE)
    expect("result" in resumed && await restarted.finish(resumed.result.id, "profile", CHOICE)).toEqual({ result: true })
    expect(host.checkLicense).toHaveBeenCalledOnce()
    expect(slots.has(TENANT)).toBe(true)
  })

  it("releases a license checked for pending Azure storage when onboarding is discarded", async () => {
    const { host, wizard } = fixture()
    const staged = await wizard.stage(TENANT, "tenuvaultApp", CHOICE)
    const id = "result" in staged ? staged.result.id : ""
    expect(host.checkLicense).not.toHaveBeenCalled()
    await expect(wizard.checkAzureStorageLicense(id, OTHER)).rejects.toThrow("Sign in again")
    await wizard.checkAzureStorageLicense(id, TENANT)
    expect(host.checkLicense).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ idToken: "id-proof" }))
    await wizard.discard(id)
    expect(host.releaseLicense).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ idToken: "id-proof" }))
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it("uses exactly the service choices checked at TenuVault app sign-in", async () => {
    const { host, wizard } = fixture()
    const request = { intune: { access: "backup" } }
    const staged = await wizard.stage(TENANT, "tenuvaultApp", request)
    expect(host.stage).toHaveBeenCalledWith(TENANT, "tenuvaultApp", request)
    const id = "result" in staged ? staged.result.id : ""
    expect(await wizard.finish(id, "profile", CHOICE)).toEqual({ result: true })
    expect(host.enroll).toHaveBeenCalledWith(expect.objectContaining({ method: "tenuvaultApp" }), "profile", request)
  })

  it("rejects a mismatched or connected tenant and a disabled method before enrolling", async () => {
    const { host, wizard } = fixture()
    host.connected.mockReturnValueOnce(true)
    expect(await wizard.stage(TENANT, "tenuvaultApp", CHOICE)).toMatchObject({ error: { code: "conflict" } })
    expect(host.stage).not.toHaveBeenCalled()
    host.enabled.mockResolvedValueOnce(false)
    expect(await wizard.stage(TENANT, "tenuvaultApp", CHOICE)).toMatchObject({ error: { code: "unavailable" } })
    expect(host.stage).not.toHaveBeenCalled()
    host.stage.mockResolvedValueOnce({
      account: { ...account(TENUVAULT_CLIENT_ID), tenantId: "different" },
      accessToken: "opaque", idToken: "proof", grantedScopes: [], cacheWrites: () => ({ key: "discarded-cache" }),
    })
    expect(await wizard.stage(TENANT, "tenuvaultApp", CHOICE)).toMatchObject({ error: { code: "wrong_tenant" } })
    expect(host.checkLicense).not.toHaveBeenCalled()
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it("rejects a duplicate found after resolving the signed-in tenant", async () => {
    const { host, wizard } = fixture()
    host.connected.mockImplementation(tenant => tenant === TENANT)
    expect(await wizard.stage("", "tenuvaultApp", CHOICE)).toMatchObject({ error: { code: "conflict" } })
    expect(host.stage).toHaveBeenCalledWith("organizations", "tenuvaultApp", CHOICE)
    expect(host.connected).toHaveBeenCalledWith(TENANT)
    expect(host.startTrial).not.toHaveBeenCalled()
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it("allows a coverage preview for the app and refuses to enroll without the selected scopes", async () => {
    const { host, wizard } = fixture()
    host.stage.mockResolvedValueOnce({
      ...(await host.stage(TENANT, "tenuvaultApp")),
      grantedScopes: ["User.Read", "Organization.Read.All"],
      missingOnboardingScopes: ["DeviceManagementApps.Read.All"],
    })
    const staged = await wizard.stage("", "tenuvaultApp", CHOICE)
    expect(staged).toMatchObject({ result: { missing: ["DeviceManagementApps.Read.All"] } })
    expect(host.startTrial).not.toHaveBeenCalled()
    expect(wizard.trialContactProof(TENANT)).toBeUndefined()
    const id = "result" in staged ? staged.result.id : ""
    expect(await wizard.finish(id, "profile", CHOICE)).toMatchObject({ error: { code: "AADSTS65001" } })
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it("enrolls partial TenuVault app access with all chosen services and only verified token scopes", async () => {
    const { host, wizard } = fixture()
    const choice = { intune: { access: "backup" }, entra: { access: "backup" }, conditionalAccess: { access: "backup" } }
    const held = "DeviceManagementConfiguration.Read.All"
    const missing = "Agreement.Read.All"
    host.stage.mockResolvedValueOnce({
      ...(await host.stage(TENANT, "tenuvaultApp")),
      graphScopes: [held, missing, "offline_access"],
      grantedScopes: [held],
      missingOnboardingScopes: [missing],
    })
    const staged = await wizard.stage(TENANT, "tenuvaultApp", { intune: { access: "backup" } })
    expect(staged).toMatchObject({ result: { missing: [missing], coverage: expect.arrayContaining([
      expect.objectContaining({ service: "entra", readable: [] }),
      expect.objectContaining({ service: "intune", readable: expect.arrayContaining(["DeviceConfigurations"]) }),
    ]) } })
    expect(host.startTrial).toHaveBeenCalledOnce()
    expect(wizard.trialContactProof(TENANT)).toBe("id-proof")
    const id = "result" in staged ? staged.result.id : ""
    expect(await wizard.finish(id, "profile", choice)).toEqual({ result: true })
    expect(host.enroll).toHaveBeenCalledWith(expect.objectContaining({
      staged: expect.objectContaining({ graphScopes: [held, "offline_access"] }),
    }), "profile", choice)
  })

  it("rechecks the flag at storage and expires staged sign-ins", async () => {
    vi.useFakeTimers()
    const { host, wizard } = fixture()
    const staged = await wizard.stage(TENANT, "tenuvaultApp", CHOICE)
    const id = "result" in staged ? staged.result.id : ""
    host.enabled.mockResolvedValueOnce(false)
    expect(await wizard.finish(id, "profile", CHOICE)).toMatchObject({ error: { code: "unavailable" } })
    vi.advanceTimersByTime(15 * 60_000)
    expect(await wizard.finish(id, "profile", CHOICE)).toMatchObject({ error: { code: "sign_in_required" } })
    expect(host.enroll).not.toHaveBeenCalled()
  })
})
