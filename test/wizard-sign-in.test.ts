import { afterEach, describe, expect, it, vi } from "vitest"
import type { StagedSignIn } from "../src/main/auth/tenant-connections"
import { WizardSignIn } from "../src/main/auth/wizard-sign-in"
import { GRAPH_CLI_CLIENT_ID, TENUVAULT_CLIENT_ID } from "../src/shared/tenant-connection"

const TENANT = "39cc968d-dd54-4f13-815b-ebbcff25e104"
const CHOICE = { intune: { access: "restore" } }
const account = (clientId: string) => ({ tenantId: TENANT, clientId, homeAccountId: "internal", username: "admin@example.test" })

function fixture() {
  const host = {
    connected: vi.fn((_tenant: string) => false),
    enabled: vi.fn(async () => true),
    stage: vi.fn(async (_tenant, method): Promise<StagedSignIn> => ({
      account: account(method === "graphCli" ? GRAPH_CLI_CLIENT_ID : TENUVAULT_CLIENT_ID),
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
  it.each(["graphCli", "tenuvaultApp"] as const)("reads the tenant name using the staged %s bearer", async method => {
    const { host, wizard } = fixture()
    const staged = await wizard.stage("", method, CHOICE)
    expect(staged).toMatchObject({ result: { organizationName: "Contoso Ltd" } })
    expect(host.fetch).toHaveBeenCalledWith("https://graph.microsoft.com/beta/organization?$select=id,displayName", expect.objectContaining({
      headers: { Authorization: "Bearer opaque" }, redirect: "error",
    }))
    expect(JSON.stringify(staged)).not.toContain("opaque")
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it.each([
    () => new Response(null, { status: 403 }),
    () => Response.json({ value: [{ id: GRAPH_CLI_CLIENT_ID, displayName: "Another tenant" }] }),
  ])("falls back to the signed-in tenant ID if its organization name is unavailable", async reply => {
    const { host, wizard } = fixture()
    host.fetch.mockImplementationOnce(async () => reply())
    const staged = await wizard.stage("", "graphCli", CHOICE)
    expect(staged).toMatchObject({ result: { account: { tenantId: TENANT }, organizationName: undefined } })
  })

  it("previews Start now without publishing a profile, then saves a backup-only choice", async () => {
    const { host, wizard } = fixture()
    const staged = await wizard.stage(TENANT, "graphCli", undefined)
    expect(staged).toMatchObject({ result: { coverage: [
      { service: "defender", readable: null }, { service: "entra", readable: null }, { service: "intune", readable: null },
    ] } })
    expect(JSON.stringify(staged)).not.toMatch(/id-proof|staged-cache|homeAccountId/)
    expect(host.enroll).not.toHaveBeenCalled()
    expect(wizard.trialContactProof(TENANT)).toBe("id-proof")
    const id = "result" in staged ? staged.result.id : ""
    expect(await wizard.finish(id, "profile", CHOICE)).toEqual({ result: true })
    expect(host.enroll).toHaveBeenCalledWith(expect.objectContaining({ method: "graphCli" }), "profile", { intune: { access: "backup" } })
    await expect(wizard.finish(id, "profile", CHOICE)).resolves.toMatchObject({ error: { code: "sign_in_required" } })
    expect(host.enroll).toHaveBeenCalledOnce()
    expect(host.releaseLicense).not.toHaveBeenCalled()
    expect(wizard.trialContactProof(TENANT)).toBeUndefined()
  })

  it.each(["graphCli", "tenuvaultApp"] as const)("leaves no organization activation after quitting %s before Storage", async method => {
    const { host, wizard } = fixture()
    // The service keeps the slot across app restarts, while the staged proof was in process memory.
    const slots = new Set<string>()
    host.checkLicense.mockImplementation(async () => { slots.add(TENANT) })
    const staged = await wizard.stage(TENANT, method, CHOICE)
    expect(staged).toHaveProperty("result.id")
    const id = "result" in staged ? staged.result.id : ""
    const restarted = new WizardSignIn(host)
    await expect(restarted.finish(id, "profile", CHOICE)).resolves.toMatchObject({ error: { code: "sign_in_required" } })
    expect(slots.size).toBe(0)
    expect(host.checkLicense).not.toHaveBeenCalled()
    const resumed = await restarted.stage(TENANT, method, CHOICE)
    expect("result" in resumed && await restarted.finish(resumed.result.id, "profile", CHOICE)).toEqual({ result: true })
    expect(host.checkLicense).toHaveBeenCalledOnce()
    expect(slots.has(TENANT)).toBe(true)
  })

  it("uses exactly the service choices checked at TenuVault app sign-in", async () => {
    const { host, wizard } = fixture()
    const request = { entra: { access: "backup" } }
    const staged = await wizard.stage(TENANT, "tenuvaultApp", request)
    expect(host.stage).toHaveBeenCalledWith(TENANT, "tenuvaultApp", request)
    const id = "result" in staged ? staged.result.id : ""
    expect(await wizard.finish(id, "profile", CHOICE)).toEqual({ result: true })
    expect(host.enroll).toHaveBeenCalledWith(expect.objectContaining({ method: "tenuvaultApp" }), "profile", request)
  })

  it("rejects a mismatched or connected tenant and a disabled method before enrolling", async () => {
    const { host, wizard } = fixture()
    host.connected.mockReturnValueOnce(true)
    expect(await wizard.stage(TENANT, "graphCli", undefined)).toMatchObject({ error: { code: "conflict" } })
    expect(host.stage).not.toHaveBeenCalled()
    host.enabled.mockResolvedValueOnce(false)
    expect(await wizard.stage(TENANT, "graphCli", undefined)).toMatchObject({ error: { code: "unavailable" } })
    expect(host.stage).not.toHaveBeenCalled()
    host.stage.mockResolvedValueOnce({
      account: { ...account(GRAPH_CLI_CLIENT_ID), tenantId: "different" },
      accessToken: "opaque", idToken: "proof", grantedScopes: [], cacheWrites: () => ({ key: "discarded-cache" }),
    })
    expect(await wizard.stage(TENANT, "graphCli", undefined)).toMatchObject({ error: { code: "wrong_tenant" } })
    expect(host.checkLicense).not.toHaveBeenCalled()
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it("rejects a duplicate found after resolving the signed-in tenant", async () => {
    const { host, wizard } = fixture()
    host.connected.mockImplementation(tenant => tenant === TENANT)
    expect(await wizard.stage("", "graphCli", undefined)).toMatchObject({ error: { code: "conflict" } })
    expect(host.stage).toHaveBeenCalledWith("organizations", "graphCli", undefined)
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
    const id = "result" in staged ? staged.result.id : ""
    expect(await wizard.finish(id, "profile", CHOICE)).toMatchObject({ error: { code: "AADSTS65001" } })
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it("enrolls partial TenuVault app access with all chosen services and only verified token scopes", async () => {
    const { host, wizard } = fixture()
    const choice = { intune: { access: "backup" }, defender: { access: "backup" } }
    const held = "DeviceManagementConfiguration.Read.All"
    const missing = "CustomDetection.Read.All"
    host.stage.mockResolvedValueOnce({
      ...(await host.stage(TENANT, "tenuvaultApp")),
      graphScopes: [held, missing, "offline_access"],
      grantedScopes: [held],
      missingOnboardingScopes: [missing],
    })
    const staged = await wizard.stage(TENANT, "tenuvaultApp", choice)
    expect(staged).toMatchObject({ result: { missing: [missing], coverage: expect.arrayContaining([
      expect.objectContaining({ service: "defender", readable: [] }),
      expect.objectContaining({ service: "intune", readable: expect.arrayContaining(["DeviceConfigurations"]) }),
    ]) } })
    const id = "result" in staged ? staged.result.id : ""
    expect(await wizard.finish(id, "profile", { intune: { access: "backup" } })).toEqual({ result: true })
    expect(host.enroll).toHaveBeenCalledWith(expect.objectContaining({
      staged: expect.objectContaining({ graphScopes: [held, "offline_access"] }),
    }), "profile", choice)
  })

  it("rechecks the flag at storage and expires staged sign-ins", async () => {
    vi.useFakeTimers()
    const { host, wizard } = fixture()
    const staged = await wizard.stage(TENANT, "graphCli", undefined)
    const id = "result" in staged ? staged.result.id : ""
    host.enabled.mockResolvedValueOnce(false)
    expect(await wizard.finish(id, "profile", CHOICE)).toMatchObject({ error: { code: "unavailable" } })
    vi.advanceTimersByTime(15 * 60_000)
    expect(await wizard.finish(id, "profile", CHOICE)).toMatchObject({ error: { code: "sign_in_required" } })
    expect(host.enroll).not.toHaveBeenCalled()
  })
})
