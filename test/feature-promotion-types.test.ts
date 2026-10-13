import { describe, expect, it } from "vitest"
import { routes } from "../src/main/features/promotion"
import { DOMAINS } from "../src/main/features/domains"
import type { PromotionRecord } from "../src/main/features/promotion/engine"
import type { ChangeSetContent, ChangeSetRecord } from "../src/main/features/change-sets/model"
import { CONTENT_DOMAIN } from "../src/main/features/change-sets/engine"
import type { Item } from "../src/shared/intune/registry"
import { call, fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"
import { FakeTenant, wire } from "./feature-change-sets-fakes"

const PATH = "/api/promotion"
const DEV_GROUP = "aaaaaaaa-0000-0000-0000-00000000000c"
const PROD_GROUP = "bbbbbbbb-0000-0000-0000-00000000000c"
const DEV_FILTER = "aaaaaaaa-0000-0000-0000-00000000000d"
const PROD_FILTER = "bbbbbbbb-0000-0000-0000-00000000000d"

type Folder = "CompliancePolicies" | "DeviceConfigurations" | "EndpointSecurityIntents"

const assignment = (groupId: string, filterId: string | null = null): Item => ({
  id: "a1",
  source: "direct",
  target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId, deviceAndAppManagementAssignmentFilterId: filterId, deviceAndAppManagementAssignmentFilterType: filterId ? "include" : "none" },
} as unknown as Item)

function setup() {
  const deps = fakeDeps({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro" }, sameLicense: () => true })
  const dev = new FakeTenant(TENANT_A)
  const prod = new FakeTenant(TENANT_B)
  const wired = wire(deps, [dev, prod])
  dev.scopeTags.push({ id: "4", displayName: "Pilot" })
  prod.scopeTags.push({ id: "9", displayName: "Pilot" })
  dev.groups.set(DEV_GROUP, { id: DEV_GROUP, displayName: "Pilot devices" })
  prod.groups.set(PROD_GROUP, { id: PROD_GROUP, displayName: "Pilot devices" })
  dev.filters = [{ id: DEV_FILTER, displayName: "Corporate", platform: "windows10AndLater", rule: "(device.deviceOwnership -eq \"Corporate\")" }]
  prod.filters = [{ id: PROD_FILTER, displayName: "Corporate", platform: "windows10AndLater", rule: "(device.deviceOwnership -eq \"Corporate\")" }]
  const api = routes(deps)
  const post = (body: Record<string, unknown>) => call(api, PATH, { tenantId: TENANT_B, targetTenants: [{ tenantId: TENANT_A }], sourceTenantId: TENANT_A, ...body })
  return { deps, dev, prod, post, ...wired }
}

const MAPPINGS = [
  { kind: "scopeTag", sourceId: "4", targetId: "9", confirmed: true },
  { kind: "group", sourceId: DEV_GROUP, targetId: PROD_GROUP, confirmed: true },
  { kind: "filter", sourceId: DEV_FILTER, targetId: PROD_FILTER, confirmed: true },
]

function addSource(context: ReturnType<typeof setup>, folder: Folder, name: string): Item {
  const base = { displayName: name, roleScopeTagIds: ["0", "4"], assignments: [assignment(DEV_GROUP, DEV_FILTER)] }
  if (folder === "CompliancePolicies") return context.dev.addCompliance(base)
  if (folder === "DeviceConfigurations") return context.dev.addDeviceConfig({ ...base, defenderBlockAdobeReader: true } as Partial<Item> & { displayName: string })
  return context.dev.addIntent(base)
}

function addDestination(context: ReturnType<typeof setup>, folder: Folder, name: string, tags: string[] = ["9"]): Item {
  const base = { displayName: name, roleScopeTagIds: tags, assignments: [] as Item[] }
  if (folder === "CompliancePolicies") return context.prod.addCompliance(base)
  if (folder === "DeviceConfigurations") return context.prod.addDeviceConfig(base)
  return context.prod.addIntent(base)
}

function destinationItems(context: ReturnType<typeof setup>, folder: Folder): Item[] {
  if (folder === "CompliancePolicies") return [...context.prod.compliance.values()]
  if (folder === "DeviceConfigurations") return [...context.prod.deviceConfigs.values()]
  return [...context.prod.intents.values()]
}

async function planAndApply(context: ReturnType<typeof setup>, folder: Folder, sourceId: string, destinationId?: string, includeAssignments = true) {
  const planned = await context.post({ action: "plan", title: "Promote", includeAssignments, items: [{ sourceId, destinationId: destinationId ?? null, folder }], mappings: MAPPINGS })
  expect(planned.status).toBe(200)
  const promotion = planned.body.promotion as PromotionRecord & { id: string }
  expect(promotion.status).toBe("in-review")
  const preview = await context.post({ action: "preview", id: promotion.id })
  expect(preview.status).toBe(200)
  const approval = await context.post({ action: "approve", id: promotion.id, contentHash: preview.body.changeSet.contentHash, targetFingerprint: preview.body.changeSet.targetFingerprint })
  expect(approval.status).toBe(200)
  const applied = await context.post({ action: "apply", id: promotion.id, contentHash: preview.body.changeSet.contentHash, confirm: true })
  expect(applied.status).toBe(200)
  expect(applied.body.promotion.status).toBe("applied")
  return promotion
}

describe("promotion of compliance, endpoint security and device configuration policies", () => {
  it.each(["CompliancePolicies", "DeviceConfigurations", "EndpointSecurityIntents"] as Folder[])("plans, previews and applies a create with mapped scope tags and assignments: %s", async (folder) => {
    const context = setup()
    const source = addSource(context, folder, "Baseline A")
    await planAndApply(context, folder, source.id as string)
    const created = destinationItems(context, folder)
    expect(created).toHaveLength(1)
    expect(created[0]!.displayName).toBe("Baseline A")
    expect(created[0]!.roleScopeTagIds).toEqual(["0", "9"])
    const assignments = created[0]!.assignments as Item[]
    expect(assignments).toHaveLength(1)
    expect((assignments[0]!.target as Item).groupId).toBe(PROD_GROUP)
    expect((assignments[0]!.target as Item).deviceAndAppManagementAssignmentFilterId).toBe(PROD_FILTER)
    expect((assignments[0]!.target as Item).deviceAndAppManagementAssignmentFilterType).toBe("include")
    expect(JSON.stringify(created)).not.toContain("aaaaaaaa-")
    expect(context.dev.writeCount()).toBe(0)
    expect(context.backups).toEqual([TENANT_B])
  })

  it.each(["CompliancePolicies", "DeviceConfigurations", "EndpointSecurityIntents"] as Folder[])("warns on a same-name destination on create and keeps destination tags on update: %s", async (folder) => {
    const context = setup()
    const source = addSource(context, folder, "Shared name")
    addDestination(context, folder, "Shared name")
    const planned = await context.post({ action: "plan", title: "x", items: [{ sourceId: source.id, folder }], mappings: MAPPINGS })
    const promotion = planned.body.promotion as PromotionRecord & { id: string }
    expect(promotion.items[0]!.findings.some((finding) => finding.code === "display-name-only" && finding.severity === "warning")).toBe(true)

    const updateContext = setup()
    const updateSource = addSource(updateContext, folder, "Shared name")
    const existing = addDestination(updateContext, folder, "Shared name", ["9"])
    const updated = await planAndApply(updateContext, folder, updateSource.id as string, existing.id as string, false)
    expect(updated.items[0]!.folder).toBe(folder)
    const kept = destinationItems(updateContext, folder).find((entry) => entry.id === existing.id)!
    expect(kept.roleScopeTagIds).toEqual(["9"])
    const changeSet = updateContext.deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, TENANT_B, updated.changeSetId!)!
    const content = updateContext.deps.records.get<ChangeSetContent>(CONTENT_DOMAIN, TENANT_B, changeSet.proposalId)!
    expect(content.entries["op-1"]!.body!.roleScopeTagIds).toEqual(["9"])
  })

  it.each(["CompliancePolicies", "DeviceConfigurations", "EndpointSecurityIntents"] as Folder[])("creates unassigned when assignments are not included: %s", async (folder) => {
    const context = setup()
    const source = addSource(context, folder, "Unassigned A")
    await planAndApply(context, folder, source.id as string, undefined, false)
    const created = destinationItems(context, folder)
    expect(created).toHaveLength(1)
    expect(created[0]!.assignments).toEqual([])
  })

  it("lists policies for each supported folder through the registry paths", async () => {
    const context = setup()
    addSource(context, "CompliancePolicies", "Compliance A")
    addSource(context, "DeviceConfigurations", "Device A")
    addSource(context, "EndpointSecurityIntents", "Intent A")
    for (const [folder, name] of [["CompliancePolicies", "Compliance A"], ["DeviceConfigurations", "Device A"], ["EndpointSecurityIntents", "Intent A"]] as const) {
      const listed = await context.post({ action: "policies", folder })
      expect(listed.status).toBe(200)
      expect(listed.body.source.map((entry: { name: string }) => entry.name)).toContain(name)
      expect(listed.body.source[0].folder).toBe(folder)
    }
    const rejected = await context.post({ action: "policies", folder: "GroupPolicyConfigurations" })
    expect(rejected.status).toBe(400)
  })

  it("blocks a type promotion cannot handle explicitly and writes nothing", async () => {
    const context = setup()
    const source = context.dev.addGroupPolicy({ displayName: "ADMX A", roleScopeTagIds: ["0"] })
    const response = await context.post({ action: "plan", title: "x", items: [{ sourceId: source.id, folder: "GroupPolicyConfigurations" }], mappings: [] })
    expect(response.status).toBe(200)
    const promotion = response.body.promotion as PromotionRecord & { id: string }
    expect(promotion.status).toBe("blocked")
    expect(promotion.changeSetId).toBeNull()
    expect(promotion.items[0]!.blocked).toBe(true)
    expect(promotion.items[0]!.findings.some((finding) => finding.code === "unsupported-type" && finding.severity === "blocking")).toBe(true)
    expect(context.prod.writeCount()).toBe(0)
    expect((await context.post({ action: "apply", id: promotion.id, contentHash: "0".repeat(64), confirm: true })).status).toBe(409)
  })
})
