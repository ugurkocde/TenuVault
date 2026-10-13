import { describe, expect, it } from "vitest"
import { applyChangeSet, approveChangeSet, createChangeSet, previewChangeSet } from "../src/main/features/change-sets/engine"
import { targetStateHash, staleTargets } from "../src/main/features/promotion/targets"
import type { TargetReads } from "../src/main/features/promotion/mapping"
import { fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"
import { FakeTenant, setting, wire } from "./feature-change-sets-fakes"

const LISTING = "deviceManagement/configurationPolicies?$select=id,name"

function setup() {
  const deps = fakeDeps({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro" } })
  const tenant = new FakeTenant(TENANT_A)
  const other = new FakeTenant(TENANT_B)
  wire(deps, [tenant, other], {})
  return { deps, tenant }
}

const listings = (tenant: FakeTenant, path = LISTING) => tenant.calls.filter((call) => call.method === "GET" && call.path === path).length

async function threeCreates(context: ReturnType<typeof setup>) {
  return createChangeSet(context.deps, TENANT_A, {
    title: "Add three policies",
    operations: ["Alpha", "Beta", "Gamma"].map((name) => ({
      folder: "ConfigurationPolicies",
      action: "create" as const,
      proposed: { name, platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings: [setting("vendor_msft_firewall_enable", "vendor_msft_firewall_enable_true")] },
    })),
  }, "Admin")
}

describe("change set listing reuse", () => {
  it("lists a type once in one preview pass and again in the next pass", async () => {
    const context = setup()
    const record = await threeCreates(context)
    expect(listings(context.tenant)).toBe(1)
    context.tenant.calls = []
    const first = await previewChangeSet(context.deps, TENANT_A, record.id)
    expect(first.operations).toHaveLength(3)
    expect(listings(context.tenant)).toBe(1)
    const second = await previewChangeSet(context.deps, TENANT_A, record.id)
    expect(second.targetFingerprint).toBe(first.targetFingerprint)
    expect(listings(context.tenant)).toBe(2)
  })

  it("lists a type once across the checks of one apply pass", async () => {
    const context = setup()
    const record = await threeCreates(context)
    const preview = await previewChangeSet(context.deps, TENANT_A, record.id)
    await approveChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, targetFingerprint: preview.targetFingerprint }, "Admin")
    context.tenant.calls = []
    const applied = await applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")
    expect(applied.status).toBe("applied")
    expect(listings(context.tenant)).toBe(1)
    expect(context.tenant.policies.size).toBe(3)
  })

})

describe("promotion stale check listing reuse", () => {
  it("lists each destination kind once for many items and again on the next check", async () => {
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro" } })
    const prod = new FakeTenant(TENANT_B)
    prod.filters = [{ id: "filter-1", displayName: "Filter", platform: "windows10AndLater", rule: "x", lastModifiedDateTime: "2026-09-01T10:00:00Z" }]
    prod.scopeTags.push({ id: "9", displayName: "Pilot" })
    prod.reusable = [{ id: "reusable-1", displayName: "Cert", settingDefinitionId: "s", lastModifiedDateTime: "2026-09-01T10:00:00Z", version: 1 }]
    wire(deps, [prod], {})
    const graph = await deps.graph(TENANT_B)
    const reads: TargetReads = { policyId: null, filterIds: ["filter-1"], scopeTagIds: ["9"], reusableSettingIds: ["reusable-1"], groupIds: [] }
    const hash = await targetStateHash(graph, reads)
    const items = ["One", "Two", "Three"].map((sourceName) => ({ sourceName, targetReads: reads, targetStateHash: hash }))
    prod.calls = []
    await expect(staleTargets(deps, TENANT_B, items)).resolves.toEqual([])
    expect(listings(prod, "deviceManagement/assignmentFilters?$select=id,displayName,platform,rule,lastModifiedDateTime")).toBe(1)
    expect(listings(prod, "deviceManagement/roleScopeTags?$select=id,displayName")).toBe(1)
    expect(listings(prod, "deviceManagement/reusablePolicySettings?$select=id,displayName,settingDefinitionId,lastModifiedDateTime,version")).toBe(1)
    await expect(staleTargets(deps, TENANT_B, items)).resolves.toEqual([])
    expect(listings(prod, "deviceManagement/assignmentFilters?$select=id,displayName,platform,rule,lastModifiedDateTime")).toBe(2)
  })
})
