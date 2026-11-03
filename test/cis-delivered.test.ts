import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleFramework, setCisBenchmarksPlanProvider, setCisEntitlementProvider, setInternalCisBenchmarksEnabled } from "../src/main/frameworks/service"
import { CIS_POLICIES_NOT_DELIVERED, isDeliveredSubset, MAX_DELIVERED_PACKS, policyDigest, withDeliveredPack } from "../src/main/frameworks/cis-delivered"
import { loadWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { planCisRemediation } from "../src/main/features/cis-remediation/engine"
import { parsePolicies, type BaselinePolicy, type RecordJson } from "../src/shared/frameworks/policies"
import { fakeDeps, TENANT_A } from "./feature-helpers"
import { FakeTenant, wire } from "./feature-change-sets-fakes"

// Synthetic content only: no CIS recommendation text.
const tenantId = TENANT_A
const appId = "22222222-2222-2222-2222-222222222222"
const choice = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (name: string, def: string) => ({ name, platforms: "windows10", technologies: "mdm", description: "Synthetic profile", settings: [{ settingInstance: { "@odata.type": choice, settingDefinitionId: def, choiceSettingValue: { value: "fake-on" } } }] })
const pack = { benchmark: "fakebook-os", version: "9.9.9", level: 1 as const, policies: [policy("Fakebook Alpha", "fakebook_setting_alpha"), policy("Fakebook Beta", "fakebook_setting_beta")] }
const noList = () => Response.json({ ok: false, error: "not published" }, { status: 404 })
const roundTrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** A delivery service and an empty Graph tenant: packs and lists from the service, no policies in Intune. */
function stubNetwork() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/cis/v1/lists/")) return noList()
    if (url.includes("/cis/v1/packs/")) return Response.json(pack)
    if (url.includes("oauth2")) return Response.json({ access_token: "test" })
    return Response.json({ value: [] })
  }))
}

async function deliver(): Promise<BaselinePolicy[]> {
  await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })
  // The renderer reads the pack from the workspace and sends it back as JSON.
  return roundTrip((await handleFramework({ action: "workspace-load", tenantId, frameworkId: "cis-benchmarks" }) as { policies: BaselinePolicy[] }).policies)
}

const request = (body: Record<string, unknown>) => handleFramework(body as RecordJson)
const save = (policies: unknown[]) => request({ action: "workspace-save", tenantId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9 Level 1", policies })
const assess = (policies: unknown[]) => request({ action: "assess", tenantId, appId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9 Level 1", policies })
const assessStart = (policies: unknown[]) => request({ action: "assess-start", tenantId, appId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9 Level 1", policies })
const REFUSED = { status: 403, message: CIS_POLICIES_NOT_DELIVERED }

describe("CIS Benchmarks policies must be delivered by this installation", () => {
  const originalBase = process.env.TENUVAULT_CIS_CONTENT_BASE_URL
  beforeEach(() => {
    const data = new Map<string, string>()
    setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
    setInternalCisBenchmarksEnabled(false)
    setCisEntitlementProvider(() => "test-entitlement")
    setCisBenchmarksPlanProvider(() => "pro")
    process.env.TENUVAULT_CIS_CONTENT_BASE_URL = "https://content.example.test/"
    stubNetwork()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setInternalCisBenchmarksEnabled(null)
    setCisEntitlementProvider(null)
    setCisBenchmarksPlanProvider(null)
    if (originalBase === undefined) delete process.env.TENUVAULT_CIS_CONTENT_BASE_URL
    else process.env.TENUVAULT_CIS_CONTENT_BASE_URL = originalBase
  })

  it("records each delivered pack by its policy digests, never from a workspace save", async () => {
    const delivered = await deliver()
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    expect(workspace.deliveredPacks).toEqual([{ benchmark: "fakebook-os", version: "9.9.9", level: 1, policies: delivered.map(policyDigest) }])
    // A save carrying its own delivered record does not change what was delivered.
    await request({ action: "workspace-save", tenantId, frameworkId: "cis-benchmarks", reference: "r", policies: delivered, deliveredPacks: [{ benchmark: "x", version: "1.0.0", level: 1, policies: ["0".repeat(64)] }] })
    expect(loadWorkspace(tenantId, "cis-benchmarks").deliveredPacks).toEqual(workspace.deliveredPacks)
  })

  it("accepts the delivered pack and any subset of it for save, assessment and remediation planning", async () => {
    const delivered = await deliver()
    // Removing an alternative profile policy is a subset and keeps working.
    for (const policies of [delivered, [delivered[1]!], []]) await expect(save(policies)).resolves.toMatchObject({ frameworkId: "cis-benchmarks" })
    await expect(assess(delivered)).resolves.toMatchObject({ frameworkId: "cis-benchmarks" })
    await expect(assess([delivered[0]!])).resolves.toMatchObject({ frameworkId: "cis-benchmarks" })
    const deps = fakeDeps({ plans: { [tenantId]: "pro" } })
    wire(deps, [new FakeTenant(tenantId)])
    const finding = { key: "0:0", policyIndex: 0, settingIndex: 0, status: "Missing" as const, policyName: "Fakebook Beta", settingId: "fakebook_setting_beta", recommended: null, observed: [] }
    await expect(planCisRemediation(deps, tenantId, { title: "Deploy", reference: "fakebook-os 9.9.9 Level 1", policies: [delivered[1]!], findings: [finding], selectedFindingKeys: ["0:0"] }, "Admin")).resolves.toMatchObject({ changeSetId: expect.any(String) })
  })

  it("refuses changed, foreign, mixed and repeated policies on save, assess, assess-start and remediation planning", async () => {
    const delivered = await deliver()
    const changed = roundTrip(delivered)
    ;(changed[0]!.settings[0]!.settingInstance as { choiceSettingValue: { value: string } }).choiceSettingValue.value = "fake-off"
    const foreign = [policy("Converted Kit Policy", "fakebook_setting_gamma")]
    const before = loadWorkspace(tenantId, "cis-benchmarks")
    for (const policies of [changed, foreign, [delivered[0]!, foreign[0]!], [delivered[0]!, delivered[0]!]]) {
      await expect(save(policies)).rejects.toMatchObject(REFUSED)
      await expect(assess(policies)).rejects.toMatchObject(REFUSED)
      await expect(assessStart(policies)).rejects.toMatchObject(REFUSED)
    }
    // Nothing refused reached the workspace.
    expect(loadWorkspace(tenantId, "cis-benchmarks").policies).toEqual(before.policies)
    const deps = fakeDeps({ plans: { [tenantId]: "pro" } })
    const tenant = new FakeTenant(tenantId)
    wire(deps, [tenant])
    const finding = { key: "0:0", policyIndex: 0, settingIndex: 0, status: "Missing" as const, policyName: "Converted Kit Policy", settingId: "fakebook_setting_gamma", recommended: null, observed: [] }
    await expect(planCisRemediation(deps, tenantId, { title: "Deploy", reference: "kit", policies: foreign, findings: [finding], selectedFindingKeys: ["0:0"] }, "Admin")).rejects.toMatchObject(REFUSED)
    expect(tenant.writeCount()).toBe(0)
  })

  it("keeps the internal claim's Build Kit path unchanged", async () => {
    setInternalCisBenchmarksEnabled(true)
    const foreign = [policy("Converted Kit Policy", "fakebook_setting_gamma")]
    await expect(save(foreign)).resolves.toMatchObject({ frameworkId: "cis-benchmarks" })
    await expect(assess(foreign)).resolves.toMatchObject({ frameworkId: "cis-benchmarks" })
  })

  it("leaves other frameworks unchecked", async () => {
    await expect(handleFramework({ action: "workspace-save", tenantId, frameworkId: "microsoft", reference: "r", policies: [policy("Own", "fakebook_setting_gamma")] })).resolves.toMatchObject({ frameworkId: "microsoft" })
  })
})

describe("delivered pack records", () => {
  const policies = parsePolicies(pack.policies)
  it("hash the same regardless of key order and match subsets of one pack only", () => {
    const reordered = policies.map(item => Object.fromEntries(Object.entries(item).reverse()) as BaselinePolicy)
    expect(reordered.map(policyDigest)).toEqual(policies.map(policyDigest))
    const packs = withDeliveredPack(withDeliveredPack(undefined, { benchmark: "a-os", version: "1.0.0", level: 1 }, [policies[0]!]), { benchmark: "b-os", version: "1.0.0", level: 1 }, [policies[1]!])
    expect(isDeliveredSubset(packs, [policies[0]!])).toBe(true)
    expect(isDeliveredSubset(packs, [policies[1]!])).toBe(true)
    // Policies of two different packs are not one delivered pack.
    expect(isDeliveredSubset(packs, policies)).toBe(false)
    expect(isDeliveredSubset(undefined, [policies[0]!])).toBe(false)
  })
  it("keeps the newest packs and does not repeat the same pack", () => {
    let packs = withDeliveredPack(undefined, { benchmark: "a-os", version: "1.0.0", level: 1 }, policies)
    packs = withDeliveredPack(packs, { benchmark: "a-os", version: "1.0.0", level: 1 }, policies)
    expect(packs).toHaveLength(1)
    for (let index = 0; index < MAX_DELIVERED_PACKS + 3; index += 1) packs = withDeliveredPack(packs, { benchmark: `os-${index}`, version: "1.0.0", level: 1 }, policies)
    expect(packs).toHaveLength(MAX_DELIVERED_PACKS)
    expect(packs.at(-1)?.benchmark).toBe(`os-${MAX_DELIVERED_PACKS + 2}`)
  })
})
