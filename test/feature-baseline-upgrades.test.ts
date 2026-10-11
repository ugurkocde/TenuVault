import { describe, expect, it } from "vitest"
import { routes } from "../src/main/features/baseline-upgrades"
import { comparePolicy, comparePolicySets, mergePolicy, policyMatchKey } from "../src/main/features/baseline-upgrades/merge"
import { offeredOver, resolveRunCommit, type BaselineSources } from "../src/main/features/baseline-upgrades/sources"
import type { OibPack } from "../src/main/oib/source"
import type { OibRun } from "../src/shared/oib/types"
import type { Item } from "../src/shared/intune/registry"
import { DOMAINS } from "../src/main/features/domains"
import { signals as baselineSignalsOf } from "../src/main/features/baseline-upgrades"
import { call, fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"
import { FakeTenant, setting, stringSetting, wire } from "./feature-change-sets-fakes"

const PATH = "/api/baseline-upgrades"
const OLD = "a".repeat(40)
const NEW = "b".repeat(40)

const integer = (id: string, value: number): Item => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, settingInstanceTemplateReference: null, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value, settingValueTemplateReference: null } } })
const text = (id: string, value: string): Item => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, settingInstanceTemplateReference: null, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationStringSettingValue", value } } })
const secret = (id: string): Item => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", value: "****", valueState: "encryptedValueToken" } } })
const policy = (name: string, settings: Item[], extra: Item = {}): Item => ({ name, description: "", platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], templateReference: { templateId: "" }, settings, ...extra })
const keysOf = (comparison: ReturnType<typeof comparePolicy>) => Object.fromEntries(comparison.settings.map((entry) => [entry.key, entry.kind]))

describe("three-way merge", () => {
  const base = policy("Win - OIB - Defender - v3.8", [setting("a", "a_1"), setting("b", "b_1"), setting("c", "c_1"), integer("n", 5), setting("gone", "gone_1")])

  it("classifies upstream changes, kept customizations, conflicts, deleted settings and data types", () => {
    const local = policy("Win - OIB - Defender - v3.8", [setting("a", "a_1"), setting("b", "b_LOCAL"), setting("c", "c_LOCAL"), integer("n", 5), setting("gone", "gone_1"), setting("mine", "mine_1")])
    const upstream = policy("Win - OIB - Defender - v4.0", [setting("a", "a_2"), setting("b", "b_1"), setting("c", "c_UP"), text("n", "5"), setting("new", "new_1")])
    const comparison = comparePolicy(base, local, upstream)
    expect(keysOf(comparison)).toEqual({ a: "upstream-changed", b: "local-kept", c: "conflict", n: "type-changed", new: "upstream-added", gone: "upstream-removed", mine: "local-kept" })
    expect(comparison.settings.filter((entry) => entry.needsResolution).map((entry) => entry.key).sort()).toEqual(["c", "n"])
    expect(comparison.fields.find((field) => field.field === "name")!.kind).toBe("upstream-changed")

    expect(() => mergePolicy(base, local, upstream, {})).toThrow(/resolution/)
    const merged = mergePolicy(base, local, upstream, { c: "local", n: "upstream" })
    const values = Object.fromEntries((merged.settings as Item[]).map((entry) => [(entry.settingInstance as Item).settingDefinitionId, JSON.stringify(entry.settingInstance)]))
    expect(values.a).toContain("a_2")
    expect(values.b).toContain("b_LOCAL")
    expect(values.c).toContain("c_LOCAL")
    expect(values.n).toContain("StringSettingValue")
    expect(values.mine).toContain("mine_1")
    expect(values.new).toContain("new_1")
    expect(values.gone).toBeUndefined()
    expect(merged.name).toBe("Win - OIB - Defender - v4.0")
    expect(merged.assignments).toBeUndefined()
  })

  it("keeps a deleted setting deleted when the tenant removed it and the release did not change it", () => {
    const local = policy("P", [setting("a", "a_1"), setting("b", "b_1"), setting("c", "c_1"), integer("n", 5)])
    const merged = mergePolicy(base, local, base, {})
    expect((merged.settings as Item[]).some((entry) => (entry.settingInstance as Item).settingDefinitionId === "gone")).toBe(false)
  })

  it("never merges secret or reference settings and keeps the tenant value", () => {
    const withSecret = policy("P", [secret("s")])
    const upstream = policy("P", [setting("s", "s_1")])
    const comparison = comparePolicy(withSecret, withSecret, upstream)
    expect(comparison.settings[0]!.kind).toBe("unsupported")
    expect(comparison.settings[0]!.local).toBe("(not shown)")
  })

  it("requires a resolution for every difference when the base is unknown", () => {
    const comparison = comparePolicy(null, policy("P", [setting("a", "a_1"), setting("b", "b_1")]), policy("P", [setting("a", "a_2"), setting("b", "b_1")]))
    expect(keysOf(comparison)).toEqual({ a: "unknown-base", b: "unchanged" })
    expect(comparison.settings[0]!.needsResolution).toBe(true)
  })

  it("blocks a changed platform or template", () => {
    expect(comparePolicy(base, base, { ...base, platforms: "macOS" }).blockers).toHaveLength(1)
  })

  it("ignores Graph null members and annotations when comparing", () => {
    const graphShaped = policy("P", [{ id: "7", settingInstance: { ...(setting("a", "a_1").settingInstance as Item), auditRuleInformation: null } }])
    expect(keysOf(comparePolicy(policy("P", [setting("a", "a_1")]), graphShaped, graphShaped))).toEqual({ a: "unchanged" })
  })

  it("compares whole baseline sets without reading a tenant", () => {
    const entry = (key: string, snapshot: Item) => ({ key, name: key, snapshot })
    const result = comparePolicySets([entry("x", base), entry("y", base)], [entry("x", base), entry("own", base)], [entry("x", base), entry("z", base)])
    expect(Object.fromEntries(result.map((item) => [item.key, item.kind]))).toEqual({ x: "matched", y: "local-missing", z: "added" })
  })

  it("matches OIB policies across versioned names and uses the commit a run recorded", () => {
    expect(policyMatchKey("Win - OIB - ES - Defender - v3.8")).toBe(policyMatchKey("Win - OIB - ES - Defender - v4.0"))
    expect(resolveRunCommit({ commit: OLD })).toBe(OLD)
    expect(resolveRunCommit({})).toBeNull()
    expect(resolveRunCommit({ commit: "1234567" })).toBeNull()
  })

  it("offers another main commit unless the installed version is newer", () => {
    const installed = { commit: OLD, reference: "OpenIntuneBaseline Windows v3.8 · 1234567" }
    expect(offeredOver({ commit: NEW, reference: "OpenIntuneBaseline Windows · main @ bbbbbbb" }, installed)).toBe(true)
    expect(offeredOver({ commit: OLD, reference: "OpenIntuneBaseline Windows · main @ aaaaaaa" }, installed)).toBe(false)
    expect(offeredOver({ commit: NEW, reference: "OpenIntuneBaseline Windows v3.7 · main @ bbbbbbb" }, installed)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------

const DEFENDER = "Win - OIB - Defender"
const FIREWALL = "Win - OIB - Firewall"

function pack(commit: string, version: string, items: Array<{ name: string; settings: Item[] }>): OibPack {
  return {
    platform: "windows",
    commit,
    reference: `OpenIntuneBaseline Windows ${version} · ${commit.slice(0, 7)}`,
    source: "",
    license: "GPL-3.0",
    items: items.map((item) => ({ folder: "ConfigurationPolicies", name: `${item.name} - ${version}`, source: `WINDOWS/NativeImport/${item.name}.json`, snapshot: policy(`${item.name} - ${version}`, item.settings) })),
  }
}

function setup(options: { plan?: "community" | "pro" | "msp"; unknownRelease?: boolean } = {}) {
  const deps = fakeDeps({ plans: { [TENANT_A]: options.plan ?? "pro", [TENANT_B]: "pro" } })
  const tenant = new FakeTenant(TENANT_A)
  const other = new FakeTenant(TENANT_B)
  wire(deps, [tenant, other])
  const oldPack = pack(OLD, "v3.8", [{ name: DEFENDER, settings: [setting("a", "a_1"), setting("b", "b_1"), setting("c", "c_1"), setting("gone", "gone_1")] }, { name: FIREWALL, settings: [setting("f", "f_1")] }])
  const newPack = pack(NEW, "v4.0", [{ name: DEFENDER, settings: [setting("a", "a_2"), setting("b", "b_1"), setting("c", "c_UP")] }, { name: FIREWALL, settings: [setting("f", "f_2")] }, { name: "Win - OIB - New", settings: [setting("x", "x_1")] }])
  const defender = tenant.addPolicy({ ...(policy(`${DEFENDER} - v3.8`, [setting("a", "a_1"), setting("b", "b_LOCAL"), setting("c", "c_LOCAL"), setting("gone", "gone_1")]) as Item & { name: string }), assignments: [{ id: "x", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }] })
  const firewall = tenant.addPolicy(policy(`${FIREWALL} - v3.8`, [setting("f", "f_1")]) as Item & { name: string })
  const run: OibRun = { runId: "5b0b4f4e-4e2a-4f7e-9a51-0d4f4c9b9a11", tenantId: TENANT_A, createdAt: "2026-09-01T10:00:00Z", kind: "deploy", platform: "windows", reference: `OpenIntuneBaseline Windows v3.8 · ${(options.unknownRelease ? "d".repeat(40) : OLD).slice(0, 7)}`, ...(options.unknownRelease ? { legacy: "quickstart" as const } : { commit: OLD }), backupFolder: "backup-1", updated: [], created: [{ folder: "ConfigurationPolicies", id: defender.id as string, name: `${DEFENDER} - v3.8` }, { folder: "ConfigurationPolicies", id: firewall.id as string, name: `${FIREWALL} - v3.8` }], failed: [] }
  const sources: BaselineSources = {
    runs: (tenantId) => (tenantId.toLowerCase() === TENANT_A ? [run] : []),
    releases: async () => ({ releases: [{ platform: "windows", tag: "v4.0", commit: NEW, reference: newPack.reference }, { platform: "windows", tag: "v3.8", commit: OLD, reference: oldPack.reference }] }),
    pack: async (_platform, commit) => {
      if (commit === OLD) return oldPack
      if (commit === NEW) return newPack
      throw new Error("not listed")
    },
    workspace: () => ({ policies: [], reference: "", creations: [] }),
  }
  const api = routes(deps, sources)
  const post = (body: Record<string, unknown>, tenantId = TENANT_A) => call(api, PATH, { tenantId, ...body })
  return { deps, tenant, other, defender, firewall, oldPack, newPack, run, post }
}

async function install(context: ReturnType<typeof setup>) {
  const recorded = await context.post({ action: "record-install", origin: "quickstart", runId: context.run.runId })
  expect(recorded.status).toBe(200)
  return recorded.body.install
}

/** Review and apply through this workflow's own change-set actions. */
async function approveAndApply(context: ReturnType<typeof setup>, id: string, changeSetId: string) {
  const preview = await context.post({ action: "change-preview", id, changeSetId })
  expect(preview.status).toBe(200)
  expect((await context.post({ action: "change-approve", id, changeSetId, contentHash: preview.body.contentHash, targetFingerprint: preview.body.targetFingerprint, reviewer: "Reviewer" })).status).toBe(200)
  expect((await context.post({ action: "change-apply", id, changeSetId, contentHash: preview.body.contentHash })).status).toBe(400)
  return context.post({ action: "change-apply", id, changeSetId, contentHash: preview.body.contentHash, confirm: true })
}

describe("/api/baseline-upgrades", () => {
  it("compares and merges substituted release content and preserves frozen source tokens", async () => {
    const context = setup()
    for (const content of [context.oldPack, context.newPack]) {
      for (const item of content.items) {
        (item.snapshot.settings as Item[]).push(stringSetting("org", "prefix/%OrganizationId%/suffix"))
      }
      (content.items[0]!.snapshot.settings as Item[]).push(stringSetting("endpoint", `https://example.test/${content.commit === OLD ? "old" : "new"}/%OrganizationId%`))
    }
    for (const live of [context.defender, context.firewall]) {
      (live.settings as Item[]).push(stringSetting("org", `prefix/${TENANT_A}/suffix`))
    }
    (context.defender.settings as Item[]).push(stringSetting("endpoint", `https://example.test/old/${TENANT_A}`))
    const installed = await install(context)
    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })
    expect(compared.status).toBe(200)
    for (const policy of compared.body.comparison.policies) {
      expect(policy.comparison.settings.find((entry: { key: string }) => entry.key === "org").kind).toBe("unchanged")
    }
    const defender = compared.body.comparison.policies.find((entry: { key: string }) => entry.key.includes("defender"))
    expect(defender.comparison.settings.find((entry: { key: string }) => entry.key === "endpoint").kind).toBe("upstream-changed")
    const upgrade = compared.body.upgrade
    expect(upgrade.unresolved).toBe(1)
    expect((await context.post({ action: "resolve", id: upgrade.id, settings: [{ policyKey: defender.key, settingKey: "c", choice: "local" }] })).status).toBe(200)
    const planned = await context.post({ action: "create-change-set", id: upgrade.id })
    expect(planned.status).toBe(200)
    expect(planned.body.upgrade.policies.find((entry: { key: string }) => entry.key === defender.key).resultingDeviations).toBe(2)
    expect(planned.body.upgrade.policies.find((entry: { key: string }) => entry.key.includes("firewall")).resultingDeviations).toBe(0)
    expect((await approveAndApply(context, upgrade.id, planned.body.changeSet.id)).body.changeSet.status).toBe("applied")
    const writes = context.tenant.calls.filter((entry) => entry.method !== "GET")
    expect(writes.map((entry) => entry.method).sort()).toEqual(["POST", "PUT", "PUT"])
    for (const write of writes) {
      expect(JSON.stringify(write.body)).toContain(`prefix/${TENANT_A}/suffix`)
      expect(JSON.stringify(write.body)).not.toContain("%OrganizationId%")
    }
    expect(JSON.stringify(context.tenant.policies.get(context.defender.id as string))).toContain(`https://example.test/new/${TENANT_A}`)
    for (const sourceId of [installed.sourceId, upgrade.to.sourceId]) {
      const source = context.deps.records.get<{ policies: unknown[] }>(DOMAINS.baselineInstalls, TENANT_A, sourceId)!
      expect(JSON.stringify(source.policies)).toContain("%OrganizationId%")
      expect(JSON.stringify(source.policies)).not.toContain(TENANT_A)
    }
    expect(JSON.stringify(context.oldPack)).toContain("%OrganizationId%")
    expect(JSON.stringify(context.newPack)).toContain("%OrganizationId%")
  })

  it("records provenance with the exact installed source per policy", async () => {
    const context = setup()
    const recorded = await install(context)
    expect(recorded.status).toBe("tracked")
    expect(recorded.commit).toBe(OLD)
    expect(recorded.policies.every((entry: { sourceId: string | null; supported: boolean }) => entry.sourceId && entry.supported)).toBe(true)
    const source = context.deps.records.get<{ kind: string; policies: Array<{ snapshot: Item }> }>(DOMAINS.baselineInstalls, TENANT_A, recorded.sourceId)!
    expect(source.kind).toBe("source")
    expect(JSON.stringify(source.policies)).not.toContain(context.defender.id as string)
    expect((await context.post({ action: "record-install", origin: "quickstart", runId: context.run.runId })).status).toBe(409)
  })

  it("upgrades while preserving customizations, stops on conflicts and records resolutions and versions", async () => {
    const context = setup()
    const installed = await install(context)
    const releases = await context.post({ action: "releases", installId: installed.id })
    expect(releases.body.releases.map((release: { commit: string }) => release.commit)).toEqual([NEW])
    expect((await baselineSignalsOf(context.deps, TENANT_A)).some((signal) => signal.key.startsWith("baseline-upgrade-available"))).toBe(true)

    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })
    expect(compared.status).toBe(200)
    const upgrade = compared.body.upgrade
    expect(upgrade.status).toBe("review")
    expect(upgrade.unresolved).toBe(1)
    const defenderEntry = compared.body.comparison.policies.find((entry: { key: string }) => entry.key.includes("defender")).comparison
    expect(Object.fromEntries(defenderEntry.settings.map((entry: { key: string; kind: string }) => [entry.key, entry.kind]))).toEqual({ a: "upstream-changed", b: "local-kept", c: "conflict", gone: "upstream-removed" })
    expect(upgrade.policies.find((entry: { kind: string }) => entry.kind === "added").choice).toBe("include")
    expect((await baselineSignalsOf(context.deps, TENANT_A)).some((signal) => signal.key.startsWith("baseline-conflicts"))).toBe(true)

    const blocked = await context.post({ action: "create-change-set", id: upgrade.id })
    expect(blocked.status).toBe(409)
    expect(context.tenant.writeCount()).toBe(0)

    const defenderKey = upgrade.policies.find((entry: { name: string }) => entry.name.includes("Defender")).key
    const resolved = await context.post({ action: "resolve", id: upgrade.id, settings: [{ policyKey: defenderKey, settingKey: "c", choice: "local" }] })
    expect(resolved.body.upgrade.status).toBe("ready")
    expect((await context.post({ action: "resolve", id: upgrade.id, settings: [{ policyKey: defenderKey, settingKey: "b", choice: "upstream" }] })).status).toBe(400)

    const created = await context.post({ action: "create-change-set", id: upgrade.id })
    expect(created.status).toBe(200)
    const changeSet = created.body.changeSet
    expect(changeSet.origin).toEqual({ workflow: "baseline-upgrade", recordId: upgrade.id })
    expect(changeSet.operations.map((operation: { action: string }) => operation.action).sort()).toEqual(["create", "update", "update"])
    expect(changeSet.operations.every((operation: { setsAssignments: boolean }) => !operation.setsAssignments)).toBe(true)
    expect(context.tenant.writeCount()).toBe(0)

    const applied = await approveAndApply(context, upgrade.id, changeSet.id)
    expect(applied.status).toBe(200)
    expect(applied.body.changeSet.status).toBe("applied")
    const live = context.tenant.policies.get(context.defender.id as string)!
    const values = JSON.stringify(live.settings)
    expect(values).toContain("a_2")
    expect(values).toContain("b_LOCAL")
    expect(values).toContain("c_LOCAL")
    expect(values).not.toContain("gone_1")
    expect(live.assignments).toHaveLength(1)
    expect(context.tenant.calls.filter((entry) => entry.method !== "GET").every((entry) => entry.journaled)).toBe(true)

    const listed = await context.post({ action: "list" })
    const finished = listed.body.upgrades[0]
    expect(finished.status).toBe("applied")
    expect(finished.customizationVersionFrom).toBe(1)
    expect(finished.customizationVersionTo).toBe(2)
    expect(finished.resultingCustomizationHash).toMatch(/^[0-9a-f]{64}$/)
    expect(finished.policies.find((entry: { key: string }) => entry.key === defenderKey).resolutions).toEqual({ c: "local" })
    const after = listed.body.installs[0]
    expect(after.commit).toBe(NEW)
    expect(after.customizationVersion).toBe(2)
    expect(after.policies).toHaveLength(3)
    expect(after.policies.every((entry: { sourceId: string }) => entry.sourceId === finished.to.sourceId)).toBe(true)

    // Rollback is previewed, created as a new change set and reviewed through the same route.
    const rollbackPreview = await context.post({ action: "change-rollback-preview", id: upgrade.id, changeSetId: changeSet.id })
    expect(rollbackPreview.status).toBe(200)
    expect(rollbackPreview.body.operations.length).toBe(3)
    const rollback = await context.post({ action: "change-rollback-create", id: upgrade.id, changeSetId: changeSet.id })
    expect(rollback.status).toBe(200)
    const rolledBack = await approveAndApply(context, upgrade.id, rollback.body.changeSet.id)
    expect(rolledBack.body.changeSet.status).toBe("applied")
    expect(JSON.stringify(context.tenant.policies.get(context.defender.id as string)!.settings)).toContain("gone_1")
    const reverted = await context.post({ action: "list" })
    expect(reverted.body.upgrades[0].status).toBe("rolled-back")
    expect(reverted.body.installs[0].policies).toHaveLength(2)
    expect(reverted.body.installs[0].policies.every((entry: { sourceId: string }) => entry.sourceId === installed.sourceId)).toBe(true)
    expect(reverted.body.installs[0].commit).toBe(OLD)
    expect(reverted.body.installs[0].status).toBe("tracked")
  })

  it("keeps a policy in its new change set after an earlier one was rejected and still finishes the upgrade", async () => {
    const context = setup()
    const installed = await install(context)
    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })
    const upgrade = compared.body.upgrade
    const defenderKey = upgrade.policies.find((entry: { name: string }) => entry.name.includes("Defender")).key
    await context.post({ action: "resolve", id: upgrade.id, settings: [{ policyKey: defenderKey, settingKey: "c", choice: "local" }] })
    const first = await context.post({ action: "create-change-set", id: upgrade.id })
    expect(first.status).toBe(200)
    expect((await context.post({ action: "change-reject", id: upgrade.id, changeSetId: first.body.changeSet.id })).status).toBe(200)
    expect((await context.post({ action: "get", id: upgrade.id })).body.upgrade.status).toBe("ready")

    const second = await context.post({ action: "create-change-set", id: upgrade.id })
    expect(second.status).toBe(200)
    const pending = (await context.post({ action: "list" })).body.upgrades[0]
    expect(pending.status).toBe("change-set")
    expect(pending.policies.filter((entry: { batch: string | null }) => entry.batch === second.body.changeSet.id)).toHaveLength(3)
    expect((await context.post({ action: "create-change-set", id: upgrade.id })).status).toBe(409)

    const applied = await approveAndApply(context, upgrade.id, second.body.changeSet.id)
    expect(applied.body.changeSet.status).toBe("applied")
    const listed = await context.post({ action: "list" })
    expect(listed.body.upgrades[0].status).toBe("applied")
    expect(listed.body.upgrades[0].customizationVersionTo).toBe(2)
    expect(listed.body.installs[0].customizationVersion).toBe(2)
  })

  it("refuses a change set when the tenant changed after the comparison", async () => {
    const context = setup()
    const installed = await install(context)
    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })
    const defenderKey = compared.body.upgrade.policies.find((entry: { name: string }) => entry.name.includes("Defender")).key
    await context.post({ action: "resolve", id: compared.body.upgrade.id, settings: [{ policyKey: defenderKey, settingKey: "c", choice: "upstream" }] })
    context.tenant.policies.get(context.firewall.id as string)!.settings = [setting("f", "f_EDITED")]
    const created = await context.post({ action: "create-change-set", id: compared.body.upgrade.id })
    expect(created.status).toBe(409)
    expect((await context.post({ action: "get", id: compared.body.upgrade.id })).body.upgrade.status).toBe("stale")
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("refuses without marking the upgrade stale when a tenant policy cannot be read", async () => {
    const context = setup()
    const installed = await install(context)
    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })
    const defenderKey = compared.body.upgrade.policies.find((entry: { name: string }) => entry.name.includes("Defender")).key
    await context.post({ action: "resolve", id: compared.body.upgrade.id, settings: [{ policyKey: defenderKey, settingKey: "c", choice: "upstream" }] })
    context.tenant.denyPolicyReads = true
    expect((await context.post({ action: "create-change-set", id: compared.body.upgrade.id })).status).toBe(502)
    expect((await context.post({ action: "get", id: compared.body.upgrade.id })).body.upgrade.status).toBe("ready")
    context.tenant.denyPolicyReads = false
    expect((await context.post({ action: "create-change-set", id: compared.body.upgrade.id })).status).toBe(200)
  })

  it("compares a policy without a recorded base manually inside a tracked baseline and can still apply it", async () => {
    const context = setup()
    const installed = await install(context)
    context.deps.records.update<{ policies: Array<{ name: string; sourceId: string | null }> }>(DOMAINS.baselineInstalls, TENANT_A, installed.id, (current) => ({ ...current, policies: current.policies.map((entry) => (entry.name.includes("Firewall") ? { ...entry, sourceId: null } : entry)) }), { actor: null, reason: "test" })
    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })
    const upgrade = compared.body.upgrade
    const firewall = upgrade.policies.find((entry: { name: string }) => entry.name.includes("Firewall"))
    expect(firewall.mode).toBe("manual")
    expect(compared.body.comparison.policies.find((entry: { key: string }) => entry.key === firewall.key).comparison.settings[0].kind).toBe("unknown-base")
    const defenderKey = upgrade.policies.find((entry: { name: string }) => entry.name.includes("Defender")).key
    await context.post({ action: "resolve", id: upgrade.id, settings: [{ policyKey: defenderKey, settingKey: "c", choice: "upstream" }, { policyKey: firewall.key, settingKey: "f", choice: "upstream" }] })
    const created = await context.post({ action: "create-change-set", id: upgrade.id })
    expect(created.status).toBe(200)
  })

  it("reports partial writes and records mixed provenance", async () => {
    const context = setup()
    const installed = await install(context)
    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })
    const upgrade = compared.body.upgrade
    const defenderKey = upgrade.policies.find((entry: { name: string }) => entry.name.includes("Defender")).key
    await context.post({ action: "resolve", id: upgrade.id, settings: [{ policyKey: defenderKey, settingKey: "c", choice: "upstream" }], policies: [{ policyKey: upgrade.policies.find((entry: { kind: string }) => entry.kind === "added").key, choice: "skip" }] })
    const created = await context.post({ action: "create-change-set", id: upgrade.id })
    const firewallOp = created.body.changeSet.operations.find((operation: { targetId: string }) => operation.targetId === context.firewall.id)
    context.tenant.failWrite = (method, path) => (method === "PUT" && path.includes(context.firewall.id as string) ? 400 : undefined)
    const applied = await approveAndApply(context, upgrade.id, created.body.changeSet.id)
    expect(applied.body.changeSet.status).toBe("partial")
    expect(firewallOp).toBeTruthy()
    const listed = await context.post({ action: "list" })
    expect(listed.body.upgrades[0].status).toBe("partial")
    expect(listed.body.installs[0].status).toBe("mixed")
    const firewall = listed.body.installs[0].policies.find((entry: { objectId: string }) => entry.objectId === context.firewall.id)
    expect(firewall.sourceId).toBe(installed.sourceId)
    expect((await baselineSignalsOf(context.deps, TENANT_A)).some((signal) => signal.key.startsWith("baseline-upgrade-partial"))).toBe(true)
  })

  it("offers a manual reviewed comparison when provenance is missing", async () => {
    const context = setup({ unknownRelease: true })
    const installed = await install(context)
    expect(installed.status).toBe("unknown-provenance")
    expect(installed.sourceId).toBeNull()
    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })
    expect(compared.body.upgrade.mode).toBe("manual")
    const firewall = compared.body.comparison.policies.find((entry: { key: string }) => entry.key.includes("firewall")).comparison
    expect(firewall.settings[0].kind).toBe("unknown-base")
    expect(compared.body.upgrade.status).toBe("review")
    expect((await context.post({ action: "create-change-set", id: compared.body.upgrade.id })).status).toBe(409)
    expect((await baselineSignalsOf(context.deps, TENANT_A)).some((signal) => signal.key.startsWith("baseline-provenance") && signal.state === "unknown")).toBe(true)
  })

  it("treats an unreadable tenant policy as unknown, not as matching", async () => {
    const context = setup()
    const installed = await install(context)
    context.tenant.denyPolicyReads = true
    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })
    expect(compared.body.upgrade.policies.filter((entry: { kind: string }) => entry.kind === "unreadable")).toHaveLength(2)
  })

  it("gates paid actions, keeps stored records readable after a downgrade and isolates tenants", async () => {
    const context = setup()
    const installed = await install(context)
    const compared = await context.post({ action: "compare", installId: installed.id, commit: NEW })

    expect((await context.post({ action: "change-preview", id: compared.body.upgrade.id, changeSetId: compared.body.upgrade.id })).status).toBe(404)
    const other = await context.post({ action: "get", id: compared.body.upgrade.id }, TENANT_B)
    expect(other.status).toBe(404)
    expect((await context.post({ action: "get", id: installed.id, kind: "install" }, TENANT_B)).status).toBe(404)
    expect((await context.post({ action: "record-install", origin: "quickstart", runId: context.run.runId }, TENANT_B)).status).toBe(404)

    const community = setup({ plan: "community" })
    const denied = await community.post({ action: "record-install", origin: "quickstart", runId: community.run.runId })
    expect(denied.status).toBe(402)
    expect(denied.body.upgrade).toBe("baselineUpgrades")

    // Downgrade: the same records stay readable, new work is refused.
    const downgraded = fakeDeps({ plans: { [TENANT_A]: "community" }, records: context.deps.records })
    const readOnly = routes(downgraded)
    const listed = await call(readOnly, PATH, { tenantId: TENANT_A, action: "list" })
    expect(listed.status).toBe(200)
    expect(listed.body.upgrades).toHaveLength(1)
    expect((await call(readOnly, PATH, { tenantId: TENANT_A, action: "compare", installId: installed.id, commit: NEW })).status).toBe(402)
  })
})
