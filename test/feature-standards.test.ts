import { describe, expect, it } from "vitest"
import { routes, signals } from "../src/main/features/standards"
import { buildStandardPolicies, diffVersions, effectiveConfiguration, migrateParameters, parseParameterDefs, resolveParameters, type Overlay } from "../src/main/features/standards/model"
import { DOMAINS } from "../src/main/features/domains"
import { SHARED_SCOPE } from "../src/main/features/records"
import type { Item } from "../src/shared/intune/registry"
import type { Plan } from "../src/shared/plans"
import type { BaselineSources } from "../src/main/features/baseline-upgrades/sources"
import type { OibPack } from "../src/main/oib/source"
import { call, fakeDeps, fakeOibSources, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"
import { FakeTenant, referenceSetting, setting, stringSetting, wire } from "./feature-change-sets-fakes"

const PATH = "/api/standards"
const REF_DEF = "device_vendor_msft_policy_privilegemanagement_elevationrules_{elevationrulename}_signaturesource"
const REUSABLE = "5c3a1f9e-3a6b-4c1e-9f2d-7b8a6c5d4e3f"

const integer = (id: string, value: number): Item => ({ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value } } })
const text = (id: string, value: string): Item => ({ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationStringSettingValue", value } } })
const secret = (id: string): Item => ({ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", value: "x" } } })
const policy = (name: string, settings: Item[]): Item => ({ name, description: "", platforms: "windows10", technologies: "mdm", templateReference: { templateId: "" }, settings })

const PARAMETERS = [
  { name: "lock-minutes", label: "Lock after minutes", type: "integer", required: true, default: 15, min: 1, max: 60 },
  { name: "banner", label: "Banner text", type: "string", required: true },
]
const POLICIES = [policy("Std - Device lock", [integer("lock", 10), text("banner", "placeholder"), setting("camera", "camera_0")]), policy("Std - Defender", [setting("scan", "scan_1")])]
const BINDINGS = [{ policyKey: "std - device lock", settingDefinitionId: "lock", parameter: "lock-minutes" }, { policyKey: "std - device lock", settingDefinitionId: "banner", parameter: "banner" }]

describe("golden standard model", () => {
  const defs = parseParameterDefs(PARAMETERS)
  const version = { parameters: defs, policies: buildStandardPolicies(POLICIES, defs, BINDINGS) }

  it("validates parameter schemas and values", () => {
    expect(() => parseParameterDefs([{ name: "x", type: "integer", default: 99, max: 10 }])).toThrow(/default/)
    expect(() => parseParameterDefs([{ name: "r", type: "reference", default: REUSABLE }])).toThrow(/no default/)
    expect(() => parseParameterDefs([{ name: "Bad Name", type: "string" }])).toThrow()
    const resolved = resolveParameters(defs, { "lock-minutes": "70", unknown: "x" })
    expect(resolved.problems.map((problem) => problem.kind).sort()).toEqual(["blocker", "blocker", "warning"])
  })

  it("keeps secrets and unbound tenant references out of reusable content", () => {
    expect(() => buildStandardPolicies([policy("P", [secret("s")])], [], [])).toThrow(/secret/)
    expect(() => buildStandardPolicies([policy("P", [referenceSetting(REUSABLE)])], [], [])).toThrow(/reference parameter/)
    const refDefs = parseParameterDefs([{ name: "signer", type: "reference", required: true }])
    expect(buildStandardPolicies([policy("P", [referenceSetting(REUSABLE)])], refDefs, [{ policyKey: "p", settingDefinitionId: REF_DEF, parameter: "signer" }])).toHaveLength(1)
    expect(() => buildStandardPolicies(POLICIES, defs, [{ policyKey: "std - device lock", settingDefinitionId: "camera", parameter: "lock-minutes" }, BINDINGS[1]!])).toThrow(/does not fit/)
  })

  it("rejects nested and collection references, blanks the bound root reference and binds only root values", () => {
    const refDefs = parseParameterDefs([{ name: "signer", type: "reference", required: false }])
    expect(refDefs[0]!.required).toBe(true)
    const nested: Item = { settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance", settingDefinitionId: "group", groupSettingCollectionValue: [{ children: [referenceSetting(REUSABLE).settingInstance as Item] }] } }
    expect(() => buildStandardPolicies([policy("P", [nested])], refDefs, [{ policyKey: "p", settingDefinitionId: "group", parameter: "signer" }])).toThrow(/references a tenant-specific object/)
    const rootWithNested: Item = { settingInstance: { ...(referenceSetting(REUSABLE).settingInstance as Item), extra: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationReferenceSettingValue", value: REUSABLE } } }
    expect(() => buildStandardPolicies([policy("P", [rootWithNested])], refDefs, [{ policyKey: "p", settingDefinitionId: REF_DEF, parameter: "signer" }])).toThrow(/tenant-specific/)
    const collection: Item = { settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingCollectionInstance", settingDefinitionId: "refs", simpleSettingCollectionValue: [{ "@odata.type": "#microsoft.graph.deviceManagementConfigurationReferenceSettingValue", value: REUSABLE }] } }
    expect(() => buildStandardPolicies([policy("P", [collection])], refDefs, [{ policyKey: "p", settingDefinitionId: "refs", parameter: "signer" }])).toThrow(/tenant-specific/)
    const numbers: Item = { settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingCollectionInstance", settingDefinitionId: "ports", simpleSettingCollectionValue: [{ "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value: 443 }] } }
    const intDefs = parseParameterDefs([{ name: "port", type: "integer", default: 443 }])
    expect(() => buildStandardPolicies([policy("P", [numbers])], intDefs, [{ policyKey: "p", settingDefinitionId: "ports", parameter: "port" }])).toThrow(/does not fit/)
    const built = buildStandardPolicies([policy("P", [referenceSetting(REUSABLE)])], refDefs, [{ policyKey: "p", settingDefinitionId: REF_DEF, parameter: "signer" }])
    expect(JSON.stringify(built)).not.toContain(REUSABLE)
  })

  it("renders the effective configuration with parameters and an overlay kept apart from the base", () => {
    const overlay: Overlay = { settings: [{ policyKey: "std - defender", instance: setting("scan", "scan_0").settingInstance as Item }, { policyKey: "std - defender", instance: setting("extra", "extra_1").settingInstance as Item }], removals: [{ policyKey: "std - device lock", settingDefinitionId: "camera" }], exceptions: [] }
    const result = effectiveConfiguration(version, { banner: "Contoso" }, overlay)
    expect(result.problems).toEqual([])
    const lock = JSON.stringify(result.policies[0]!.snapshot)
    expect(lock).toContain('"value":15')
    expect(lock).toContain("Contoso")
    expect(lock).not.toContain("camera")
    expect(JSON.stringify(result.policies[1]!.snapshot)).toContain("scan_0")
    expect(JSON.stringify(result.policies[1]!.snapshot)).toContain("extra_1")
    expect(JSON.stringify(version.policies)).toContain("scan_1")
  })

  it("reports conflicting overlays", () => {
    const overlay: Overlay = {
      settings: [
        { policyKey: "std - device lock", instance: integer("lock", 5).settingInstance as Item },
        { policyKey: "std - defender", instance: setting("scan", "scan_0").settingInstance as Item },
        { policyKey: "std - defender", instance: setting("scan", "scan_2").settingInstance as Item },
        { policyKey: "std - device lock", instance: text("camera", "on").settingInstance as Item },
        { policyKey: "missing policy", instance: setting("x", "x").settingInstance as Item },
      ],
      removals: [],
      exceptions: [{ policyKey: "std - defender", settingDefinitionId: "scan", reason: "r", approver: "a", expiresAt: "2027-01-01T00:00:00Z", status: "approved" }],
    }
    const problems = effectiveConfiguration(version, { banner: "x" }, overlay).problems
    const messages = problems.map((problem) => `${problem.kind}:${problem.message}`)
    expect(messages.some((message) => message.startsWith("conflict") && message.includes("parameter"))).toBe(true)
    expect(messages.some((message) => message.includes("more than once"))).toBe(true)
    expect(messages.some((message) => message.includes("data type"))).toBe(true)
    expect(messages.some((message) => message.includes("approved exception"))).toBe(true)
    expect(messages.some((message) => message.startsWith("blocker") && message.includes("not in this standard version"))).toBe(true)
  })

  it("migrates renamed and deleted parameters without dropping values silently", () => {
    const next = parseParameterDefs([{ name: "lock-after", type: "integer", default: 15, renamedFrom: "lock-minutes" }, { name: "owner", type: "string", required: true }])
    const migrated = migrateParameters(defs, next, { "lock-minutes": 20, banner: "Contoso" })
    expect(migrated.values).toEqual({ "lock-after": 20 })
    expect(migrated.notes.map((note) => note.kind).sort()).toEqual(["missing", "removed", "renamed"])
  })

  it("diffs versions including parameters", () => {
    const nextDefs = parseParameterDefs([PARAMETERS[0]])
    const next = { parameters: nextDefs, policies: buildStandardPolicies([policy("Std - Device lock", [integer("lock", 10), setting("camera", "camera_1")])], nextDefs, [BINDINGS[0]!]) }
    const messages = diffVersions(version, next).map((entry) => entry.message)
    expect(messages).toEqual(expect.arrayContaining(["camera changed.", "banner removed.", 'Policy "Std - Defender" removed.', 'Parameter "banner" removed.']))
  })
})

// ---------------------------------------------------------------------------------------------

function setup(plans: Record<string, Plan> = { [TENANT_A]: "msp", [TENANT_B]: "msp", [TENANT_C]: "msp" }, sources?: BaselineSources) {
  let now = new Date("2026-09-30T12:00:00Z")
  const deps = fakeDeps({ plans, now: () => now })
  const tenants = [new FakeTenant(TENANT_A), new FakeTenant(TENANT_B), new FakeTenant(TENANT_C)]
  wire(deps, tenants)
  const api = routes(deps, sources)
  const post = (body: Record<string, unknown>, tenantId = TENANT_A) => call(api, PATH, { tenantId, ...body })
  return { deps, customer: tenants[1]!, other: tenants[2]!, post, advance: (days: number) => { now = new Date(now.getTime() + days * 86_400_000) } }
}

async function publish(context: ReturnType<typeof setup>) {
  const created = await context.post({ action: "standard-create", standardKey: "workstation", name: "Workstation", changeNotes: "First version", source: { type: "manual", reference: "MSP workstation standard" }, policies: POLICIES, parameters: PARAMETERS, bindings: BINDINGS })
  expect(created.status).toBe(200)
  return created.body.standard
}

async function applyAdoption(context: ReturnType<typeof setup>, id: string, changeSetId: string, tenantId = TENANT_B) {
  const preview = await context.post({ action: "standard-change-preview", id, changeSetId }, tenantId)
  expect(preview.status).toBe(200)
  expect((await context.post({ action: "standard-change-approve", id, changeSetId, contentHash: preview.body.contentHash, targetFingerprint: preview.body.targetFingerprint }, tenantId)).status).toBe(200)
  return context.post({ action: "standard-change-apply", id, changeSetId, contentHash: preview.body.contentHash, confirm: true }, tenantId)
}

describe("/api/standards", () => {
  it.each([TENANT_B, TENANT_C])("adopts OIB placeholders for customer %s and keeps shared versions reusable", async (target) => {
    const content: OibPack = {
      platform: "windows", commit: "a".repeat(40), reference: "OpenIntuneBaseline Windows v1", source: "", license: "GPL-3.0",
      items: ["Created", "Updated"].map((name) => ({ folder: "ConfigurationPolicies", name, source: `${name}.json`, snapshot: policy(name, [stringSetting("org", "prefix/%OrganizationId%/suffix")]) })),
    }
    const context = setup(undefined, fakeOibSources([content]))
    const published = await context.post({ action: "standard-create", standardKey: "oib", name: "OIB", changeNotes: "First version", source: { type: "oib", platform: "windows", commit: content.commit } })
    expect(published.status).toBe(200)
    const version = published.body.standard
    const tenant = target === TENANT_B ? context.customer : context.other
    const existing = tenant.addPolicy({ name: "Customer policy", settings: [stringSetting("org", "old")] })
    const adoption = await context.post({ action: "standard-adopt", versionId: version.id }, target)
    expect(adoption.status).toBe(200)
    const id = adoption.body.adoption.id
    expect((await context.post({ action: "standard-configure", id, mappings: [{ policyKey: "created", objectId: null }, { policyKey: "updated", objectId: existing.id }] }, target)).status).toBe(200)
    const planned = await context.post({ action: "standard-plan", id }, target)
    expect(planned.status).toBe(200)
    expect((await applyAdoption(context, id, planned.body.changeSet.id, target)).body.changeSet.status).toBe("applied")
    const writes = tenant.calls.filter((entry) => entry.method !== "GET")
    expect(writes.map((entry) => entry.method)).toEqual(["POST", "PUT"])
    for (const write of writes) {
      expect(JSON.stringify(write.body)).toContain(`prefix/${target}/suffix`)
      expect(JSON.stringify(write.body)).not.toContain("%OrganizationId%")
    }
    expect((await context.post({ action: "standard-preview", id }, target)).body.policies.map((entry: { action: string }) => entry.action)).toEqual(["none", "none"])
    const assessed = await context.post({ action: "standard-assess", id }, target)
    expect(assessed.status).toBe(200)
    expect(assessed.body.state.deviations).toBe(0)
    const stored = context.deps.records.get(DOMAINS.standards, SHARED_SCOPE, version.id)!
    expect(stored).toMatchObject(version)
    expect(JSON.stringify(stored)).toContain("%OrganizationId%")
    expect(JSON.stringify(stored)).not.toContain(target)
    expect(JSON.stringify(content)).toContain("%OrganizationId%")
  })

  it("gates customizations to Pro and reusable standards to MSP, and keeps records readable after a downgrade", async () => {
    const community = setup({ [TENANT_A]: "community" })
    const denied = await community.post({ action: "create-customization", title: "Camera on", settingKey: "camera", reason: "Kiosks", owner: "IT" })
    expect(denied.status).toBe(402)
    expect((await community.post({ action: "list-customizations" })).status).toBe(200)

    const pro = setup({ [TENANT_A]: "pro" })
    const created = await pro.post({ action: "create-customization", title: "Camera on", settingKey: "camera", policyName: "Win - OIB - Device - v3.8", value: "camera_1", reason: "Kiosks need the camera", owner: "IT Ops" })
    expect(created.status).toBe(200)
    const revised = await pro.post({ action: "revise-customization", id: created.body.customization.id, owner: "Security", why: "Ownership moved" })
    expect(revised.body.customization.version).toBe(2)
    expect(revised.body.customization.history).toHaveLength(2)
    const standard = await pro.post({ action: "standard-create", standardKey: "x", name: "X", changeNotes: "n", source: { type: "manual", reference: "r" }, policies: POLICIES, parameters: PARAMETERS, bindings: BINDINGS })
    expect(standard.status).toBe(402)
    expect(standard.body.upgrade).toBe("goldenStandards")
    expect((await pro.post({ action: "portfolio-adoptions", targetTenants: [] })).status).toBe(402)
    expect((await community.post({ action: "get-standard-diff", fromId: "5c3a1f9e-3a6b-4c1e-9f2d-7b8a6c5d4e3f", toId: "5c3a1f9e-3a6b-4c1e-9f2d-7b8a6c5d4e3f" })).status).toBe(404)

    const downgraded = fakeDeps({ plans: { [TENANT_A]: "community" }, records: pro.deps.records })
    const listed = await call(routes(downgraded), PATH, { tenantId: TENANT_A, action: "list-customizations" })
    expect(listed.body.customizations).toHaveLength(1)
    expect((await call(routes(downgraded), PATH, { tenantId: TENANT_A, action: "retire-customization", id: created.body.customization.id, why: "x" })).status).toBe(402)
  })

  it("publishes immutable versions without tenant evidence and refuses stale source versions", async () => {
    const context = setup()
    const v1 = await publish(context)
    expect(v1.version).toBe(1)
    expect(v1.tenantId).toBe(SHARED_SCOPE)
    const stored = context.deps.records.list(DOMAINS.standards, SHARED_SCOPE)
    for (const id of [TENANT_A, TENANT_B, TENANT_C]) expect(JSON.stringify(stored.map(({ history: _h, ...rest }) => rest))).not.toContain(id)

    const leaking = await context.post({ action: "standard-create", standardKey: "leak", name: "Leak", changeNotes: "n", source: { type: "manual", reference: "r" }, policies: [{ ...POLICIES[1], description: `Copied from ${TENANT_B}` }] })
    expect(leaking.status).toBe(400)

    const v2 = await context.post({ action: "standard-publish-version", previousVersionId: v1.id, name: "Workstation", changeNotes: "Scan off", source: { type: "manual", reference: "r2" }, policies: [POLICIES[0], policy("Std - Defender", [setting("scan", "scan_0")])], parameters: PARAMETERS, bindings: BINDINGS })
    expect(v2.body.standard.version).toBe(2)
    const stale = await context.post({ action: "standard-publish-version", previousVersionId: v1.id, name: "Workstation", changeNotes: "Other", source: { type: "manual", reference: "r3" }, policies: POLICIES.slice(0, 1), parameters: PARAMETERS, bindings: BINDINGS })
    expect(stale.status).toBe(409)
    const diff = await context.post({ action: "get-standard-diff", fromId: v1.id, toId: v2.body.standard.id })
    expect(diff.body.diff).toEqual([{ policyKey: "std - defender", settingKey: "scan", change: "changed", message: "scan changed." }])
  })

  it("adopts per customer through a reviewed change set, never changes a tenant on a new version, and tracks deviation", async () => {
    const context = setup()
    const v1 = await publish(context)
    const existing = context.customer.addPolicy({ name: "Customer Defender", settings: [setting("scan", "scan_0")], roleScopeTagIds: ["7"] })

    const adopted = await context.post({ action: "standard-adopt", versionId: v1.id }, TENANT_B)
    const id = adopted.body.adoption.id
    let preview = await context.post({ action: "standard-preview", id }, TENANT_B)
    expect(preview.body.ready).toBe(false)
    expect(preview.body.problems.filter((problem: { message: string }) => problem.message.includes("Choose whether"))).toHaveLength(2)
    expect(preview.body.problems.some((problem: { message: string }) => problem.message.includes("Banner text"))).toBe(true)

    await context.post({ action: "standard-configure", id, parameters: { banner: "Contoso" }, mappings: [{ policyKey: "std - device lock", objectId: "0ab1c2d3-0000-4000-8000-000000000000" }, { policyKey: "std - defender", objectId: existing.id }] }, TENANT_B)
    preview = await context.post({ action: "standard-preview", id }, TENANT_B)
    expect(preview.body.problems.some((problem: { message: string }) => problem.message.includes("no longer exists"))).toBe(true)
    expect((await context.post({ action: "standard-plan", id }, TENANT_B)).status).toBe(409)
    expect(context.customer.writeCount()).toBe(0)

    await context.post({ action: "standard-configure", id, mappings: [{ policyKey: "std - device lock", objectId: null }, { policyKey: "std - defender", objectId: existing.id }] }, TENANT_B)
    preview = await context.post({ action: "standard-preview", id }, TENANT_B)
    expect(preview.body.ready).toBe(true)
    expect(preview.body.policies.map((row: { action: string }) => row.action)).toEqual(["create", "update"])
    const planned = await context.post({ action: "standard-plan", id }, TENANT_B)
    expect(planned.status).toBe(200)
    expect(planned.body.changeSet.origin).toEqual({ workflow: "standard-adoption", recordId: id })
    expect(planned.body.changeSet.operations.every((operation: { setsAssignments: boolean }) => !operation.setsAssignments)).toBe(true)
    expect(context.customer.writeCount()).toBe(0)

    const applied = await applyAdoption(context, id, planned.body.changeSet.id)
    expect(applied.body.changeSet.status).toBe("applied")
    expect(context.customer.policies.get(existing.id as string)!.roleScopeTagIds).toEqual(["7"])
    let record = (await context.post({ action: "get-adoption", id }, TENANT_B)).body
    expect(record.adoption.adoptedVersion).toBe(1)
    expect(record.adoption.mappings.find((mapping: { policyKey: string }) => mapping.policyKey === "std - device lock").objectId).toBeTruthy()
    expect(record.state.freshness).toBe("unknown")

    // A new base version changes nothing by itself.
    const writes = context.customer.writeCount()
    const v2 = await context.post({ action: "standard-publish-version", previousVersionId: v1.id, name: "Workstation", changeNotes: "Rename and drop banner", source: { type: "manual", reference: "r2" }, policies: [policy("Std - Device lock", [integer("lock", 10), setting("camera", "camera_0")]), POLICIES[1]], parameters: [{ ...PARAMETERS[0], name: "lock-after", renamedFrom: "lock-minutes" }], bindings: [{ ...BINDINGS[0], parameter: "lock-after" }] })
    expect(v2.status).toBe(200)
    expect(context.customer.writeCount()).toBe(writes)
    record = (await context.post({ action: "get-adoption", id }, TENANT_B)).body
    expect(record.adoption.adoptedVersion).toBe(1)
    expect(record.state.pendingUpgrade).toBe(true)
    expect((await signals(context.deps, TENANT_B)).some((signal) => signal.key.startsWith("standard-upgrade"))).toBe(true)

    // Assessments compare with what was applied, not with later unapplied configuration edits.
    await context.post({ action: "standard-configure", id, parameters: { banner: "Changed later" } }, TENANT_B)
    const clean = await context.post({ action: "standard-assess", id }, TENANT_B)
    expect(clean.body.state.deviations).toBe(0)
    expect(clean.body.adoption.adoptedParameters).toEqual({ "lock-minutes": 15, banner: "Contoso" })

    // Deviation: a live change is found; an approved exception is shown, never as a match.
    const defender = context.customer.policies.get(existing.id as string)!
    defender.settings = [setting("scan", "scan_9")]
    let assessed = await context.post({ action: "standard-assess", id }, TENANT_B)
    expect(assessed.body.state.deviations).toBe(1)
    expect(assessed.body.state.freshness).toBe("fresh")
    await context.post({ action: "standard-configure", id, overlay: { settings: [], removals: [], exceptions: [{ policyKey: "std - defender", settingDefinitionId: "scan", reason: "Pilot", approver: "CISO", expiresAt: "2027-01-01T00:00:00Z", status: "approved" }] } }, TENANT_B)
    assessed = await context.post({ action: "standard-assess", id }, TENANT_B)
    expect(assessed.body.state.deviations).toBe(0)
    expect(assessed.body.adoption.lastAssessment.counts.excepted).toBe(1)
    context.advance(8)
    expect((await context.post({ action: "get-adoption", id }, TENANT_B)).body.state.freshness).toBe("stale")

    // Moving to v2 is a reviewed diff with parameter migration.
    const retargeted = await context.post({ action: "standard-configure", id, versionId: v2.body.standard.id }, TENANT_B)
    expect(retargeted.body.adoption.parameters).toEqual({})
    expect(retargeted.body.adoption.migrationNotes.map((note: { kind: string }) => note.kind)).toEqual(["removed"])
    preview = await context.post({ action: "standard-preview", id }, TENANT_B)
    expect(preview.body.versionDiff.length).toBeGreaterThan(0)
    expect((await context.post({ action: "standard-plan", id }, TENANT_B)).status).toBe(409)
    const upgraded = await context.post({ action: "standard-plan", id, acknowledgeMigration: true }, TENANT_B)
    expect(upgraded.status).toBe(200)
    expect((await applyAdoption(context, id, upgraded.body.changeSet.id)).body.changeSet.status).toBe("applied")
    record = (await context.post({ action: "get-adoption", id }, TENANT_B)).body
    expect(record.adoption.adoptedVersion).toBe(2)
    // The last assessment was of version 1, so it no longer describes the tenant.
    expect(record.state.freshness).toBe("stale")
  })

  it("finishes the adoption rollback when a partial rollback is retried", async () => {
    const context = setup()
    const v1 = await publish(context)
    const existing = context.customer.addPolicy({ name: "Customer Defender", settings: [setting("scan", "scan_0")] })
    const id = (await context.post({ action: "standard-adopt", versionId: v1.id }, TENANT_B)).body.adoption.id
    await context.post({ action: "standard-configure", id, parameters: { banner: "Contoso" }, mappings: [{ policyKey: "std - device lock", objectId: null }, { policyKey: "std - defender", objectId: existing.id }] }, TENANT_B)
    const planned = await context.post({ action: "standard-plan", id }, TENANT_B)
    const adopting = planned.body.changeSet.id
    expect((await applyAdoption(context, id, adopting)).body.changeSet.status).toBe("applied")

    const rollback = await context.post({ action: "standard-change-rollback-create", id, changeSetId: adopting }, TENANT_B)
    expect(rollback.status).toBe(200)
    context.customer.failWrite = (method) => (method === "DELETE" ? 400 : undefined)
    expect((await applyAdoption(context, id, rollback.body.changeSet.id)).body.changeSet.status).toBe("partial")
    let record = (await context.post({ action: "get-adoption", id }, TENANT_B)).body.adoption
    expect(record.status).toBe("partial")
    expect(record.adoptedVersion).toBe(1)

    context.customer.failWrite = undefined
    const preview = await context.post({ action: "standard-change-preview", id, changeSetId: rollback.body.changeSet.id }, TENANT_B)
    const retried = await context.post({ action: "standard-change-apply", id, changeSetId: rollback.body.changeSet.id, contentHash: preview.body.contentHash, confirm: true }, TENANT_B)
    expect(retried.body.changeSet.status).toBe("applied")
    record = (await context.post({ action: "get-adoption", id }, TENANT_B)).body.adoption
    expect(record).toMatchObject({ status: "draft", adoptedVersionId: null, adoptedParameters: null, adoptedChangeSetId: null, previousAdopted: null })
  })

  it("isolates customers strictly and reports portfolios only for named tenants", async () => {
    const context = setup()
    const v1 = await publish(context)
    const adoption = (await context.post({ action: "standard-adopt", versionId: v1.id }, TENANT_B)).body.adoption
    expect((await context.post({ action: "get-adoption", id: adoption.id }, TENANT_C)).status).toBe(404)
    expect((await context.post({ action: "standard-preview", id: adoption.id }, TENANT_C)).status).toBe(404)
    expect((await context.post({ action: "standard-configure", id: adoption.id, parameters: { banner: "x" } }, TENANT_C)).status).toBe(404)
    expect((await context.post({ action: "list-adoptions" }, TENANT_C)).body.adoptions).toEqual([])
    expect(context.deps.records.list(DOMAINS.adoptions, TENANT_A)).toEqual([])

    const portfolio = await context.post({ action: "portfolio-adoptions", targetTenants: [{ tenantId: TENANT_B }] })
    expect(portfolio.status).toBe(200)
    expect(portfolio.body.tenants.map((entry: { tenantId: string }) => entry.tenantId)).toEqual([TENANT_A, TENANT_B])
    expect(portfolio.body.tenants[1].adoptions[0].pendingUpgrade).toBe(true)

    const mixed = setup({ [TENANT_A]: "msp", [TENANT_B]: "pro" })
    expect((await mixed.post({ action: "portfolio-adoptions", targetTenants: [{ tenantId: TENANT_B }] })).status).toBe(402)
    const v = await publish(mixed)
    expect((await mixed.post({ action: "standard-adopt", versionId: v.id }, TENANT_B)).status).toBe(402)
  })

  it("validates target-specific references and missing parameter values", async () => {
    const context = setup()
    const refPolicies = [policy("Std - EPM", [referenceSetting(REUSABLE)])]
    const standard = (await context.post({ action: "standard-create", standardKey: "epm", name: "EPM", changeNotes: "n", source: { type: "manual", reference: "r" }, policies: refPolicies, parameters: [{ name: "signer", type: "reference", required: true }], bindings: [{ policyKey: "std - epm", settingDefinitionId: REF_DEF, parameter: "signer" }] })).body.standard
    expect(JSON.stringify(standard.policies)).not.toContain(REUSABLE)
    const id = (await context.post({ action: "standard-adopt", versionId: standard.id }, TENANT_B)).body.adoption.id
    await context.post({ action: "standard-configure", id, parameters: { signer: "9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d" }, mappings: [{ policyKey: "std - epm", objectId: null }] }, TENANT_B)
    let preview = await context.post({ action: "standard-preview", id }, TENANT_B)
    expect(preview.body.problems.some((problem: { message: string }) => problem.message.includes("does not exist in this tenant"))).toBe(true)
    context.customer.reusable.push({ id: "9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d", displayName: "Signer" })
    preview = await context.post({ action: "standard-preview", id }, TENANT_B)
    expect(preview.body.ready).toBe(true)
  })
})
