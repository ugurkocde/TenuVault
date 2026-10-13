import { describe, expect, it } from "vitest"
import { applyChangeSet, approveChangeSet, createChangeSet, getChangeSet, previewChangeSet } from "../src/main/features/change-sets/engine"
import { createListingMemo, listAll } from "../src/main/features/change-sets/graph"
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

  it("lists a type once in each check of one apply pass", async () => {
    const context = setup()
    const record = await threeCreates(context)
    const preview = await previewChangeSet(context.deps, TENANT_A, record.id)
    await approveChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, targetFingerprint: preview.targetFingerprint }, "Admin")
    context.tenant.calls = []
    const applied = await applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")
    expect(applied.status).toBe("applied")
    expect(listings(context.tenant)).toBe(2)
    expect(context.tenant.policies.size).toBe(3)
  })

  it("marks the set stale when a same-named policy appears during the pre-change backup", async () => {
    const context = setup()
    const record = await createChangeSet(context.deps, TENANT_A, {
      title: "Add one policy",
      operations: [{
        folder: "ConfigurationPolicies",
        action: "create" as const,
        proposed: { name: "Alpha", platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings: [setting("vendor_msft_firewall_enable", "vendor_msft_firewall_enable_true")] },
      }],
    }, "Admin")
    const preview = await previewChangeSet(context.deps, TENANT_A, record.id)
    await approveChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, targetFingerprint: preview.targetFingerprint }, "Admin")
    const api = context.deps.api
    let injected = false
    context.deps.api = async (path, tenantId, body = {}) => {
      if (path === "/api/backup/status" && !injected) {
        injected = true
        context.tenant.addPolicy({ name: "Alpha" })
      }
      return api(path, tenantId, body)
    }
    await expect(applyChangeSet(context.deps, TENANT_A, record.id, { contentHash: preview.contentHash, confirmed: true }, "Admin")).rejects.toThrow(/changed in the target tenant after approval/)
    expect(injected).toBe(true)
    expect(context.tenant.writeCount()).toBe(0)
    expect([...context.tenant.policies.values()].filter((policy) => policy.name === "Alpha")).toHaveLength(1)
    expect(getChangeSet(context.deps, TENANT_A, record.id).status).toBe("stale")
  })

  it("does not cache a rejected listing, so a later call in the same pass succeeds", async () => {
    const memo = createListingMemo()
    let attempts = 0
    const graph = async () => {
      attempts += 1
      if (attempts === 1) return { status: 500, body: { error: { message: "Transient failure" } } }
      return { status: 200, body: { value: [{ id: "policy-1", name: "Alpha" }] } }
    }
    await expect(listAll(graph as never, LISTING, memo)).rejects.toThrow(/Transient failure/)
    await expect(listAll(graph as never, LISTING, memo)).resolves.toEqual([{ id: "policy-1", name: "Alpha" }])
    expect(attempts).toBe(2)
    await expect(listAll(graph as never, LISTING, memo)).resolves.toEqual([{ id: "policy-1", name: "Alpha" }])
    expect(attempts).toBe(2)
  })

  it("shares one in-flight listing between concurrent callers", async () => {
    const memo = createListingMemo()
    let attempts = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const graph = async () => {
      attempts += 1
      await gate
      return { status: 200, body: { value: [{ id: "policy-1", name: "Alpha" }] } }
    }
    const first = listAll(graph as never, LISTING, memo)
    const second = listAll(graph as never, LISTING, memo)
    release!()
    await expect(first).resolves.toEqual([{ id: "policy-1", name: "Alpha" }])
    await expect(second).resolves.toEqual([{ id: "policy-1", name: "Alpha" }])
    expect(attempts).toBe(1)
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
