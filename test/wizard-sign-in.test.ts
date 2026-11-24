import { afterEach, describe, expect, it, vi } from "vitest"
import { WizardSignIn } from "../src/main/auth/wizard-sign-in"
import { GRAPH_CLI_CLIENT_ID, TENUVAULT_CLIENT_ID } from "../src/shared/tenant-connection"

const TENANT = "39cc968d-dd54-4f13-815b-ebbcff25e104"
const CHOICE = { intune: { access: "restore" } }
const account = (clientId: string) => ({ tenantId: TENANT, clientId, homeAccountId: "internal", username: "admin@example.test" })

function fixture() {
  const host = {
    connected: vi.fn(() => false),
    enabled: vi.fn(async () => true),
    stage: vi.fn(async (_tenant, method) => ({
      account: account(method === "graphCli" ? GRAPH_CLI_CLIENT_ID : TENUVAULT_CLIENT_ID),
      accessToken: "opaque",
      idToken: "id-proof",
      grantedScopes: ["User.Read", "Organization.Read.All"],
      cacheWrites: () => ({ key: "staged-cache" }),
    })),
    startTrial: vi.fn(async () => undefined),
    checkLicense: vi.fn(async () => undefined),
    releaseLicense: vi.fn(async () => undefined),
    enroll: vi.fn(),
  }
  return { host, wizard: new WizardSignIn(host) }
}

afterEach(() => vi.useRealTimers())

describe("staged wizard sign-in", () => {
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
