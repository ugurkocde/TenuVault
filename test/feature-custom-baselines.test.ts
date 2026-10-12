import { describe, expect, it } from "vitest"
import { routes } from "../src/main/features/custom-baselines"
import { applyEdits, baselineEvidence, customPolicy, EditError, settingLabel, settingViews, stripForBaseline } from "../src/main/features/custom-baselines/model"
import type { CustomBaselineSources } from "../src/main/features/custom-baselines/service"
import type { OibPack } from "../src/main/oib/source"
import type { Item } from "../src/shared/intune/registry"
import { REDACTED } from "../src/main/features/change-sets/model"
import { createEvidenceManifest, frameworkRulesetSha256 } from "../src/shared/compliance/manifest"
import { ISO_27001, SOC_2, NIST_800_53 } from "../src/shared/compliance"
import { DOMAINS } from "../src/main/features/domains"
import type { Plan } from "../src/shared/plans"
import { call, fakeDeps, fakeOibSources, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"
import { FakeTenant, setting, stringSetting, wire } from "./feature-change-sets-fakes"

const PATH = "/api/custom-baselines"
const OLD = "a".repeat(40)
const NEW = "b".repeat(40)
const NEWER = "e".repeat(40)
const NEWEST = "f".repeat(40)

const integer = (id: string, value: number): Item => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, settingInstanceTemplateReference: null, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value, settingValueTemplateReference: null } } })
const text = (id: string, value: string): Item => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationStringSettingValue", value } } })
const secret = (id: string, value: string): Item => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", value, valueState: "encryptedValueToken" } } })
const policy = (name: string, settings: Item[], extra: Item = {}): Item => ({ name, description: "", platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], templateReference: { templateId: "" }, settings, ...extra })

const DEFENDER = "Win - OIB - Defender"
const FIREWALL = "Win - OIB - Firewall"
const ARCHIVE = "device_vendor_msft_policy_config_defender_allowarchivescanning"

function pack(commit: string, version: string, items: Array<{ name: string; settings: Item[] }>, extra: OibPack["items"] = []): OibPack {
  return {
    platform: "windows",
    commit,
    reference: `OpenIntuneBaseline Windows ${version} · ${commit.slice(0, 7)}`,
    source: "",
    license: "GPL-3.0",
    items: [...items.map((item) => ({ folder: "ConfigurationPolicies", name: `${item.name} - ${version}`, source: `WINDOWS/NativeImport/${item.name}.json`, snapshot: { id: "author-id", createdDateTime: "2025-01-01T00:00:00Z", "@odata.context": "x", ...policy(`${item.name} - ${version}`, item.settings), assignments: [{ target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }] } })), ...extra],
  }
}

const oldPack = pack(OLD, "v3.8", [
  { name: DEFENDER, settings: [setting(ARCHIVE, `${ARCHIVE}_1`), integer("n", 5), setting("c", "c_low"), text("t", "hello")] },
  { name: FIREWALL, settings: [setting("f", "f_1"), setting("g", "g_1")] },
], [{ folder: "CompliancePolicies", name: "Win - OIB - Compliance - v3.8", source: "x", snapshot: { displayName: "Win - OIB - Compliance - v3.8" } }])
const newPack = pack(NEW, "v4.0", [
  { name: DEFENDER, settings: [setting(ARCHIVE, `${ARCHIVE}_1`), integer("n", 5), setting("c", "c_high"), text("t", "hello"), setting("new", "new_1")] },
  { name: FIREWALL, settings: [setting("f", "f_2"), setting("g", "g_1")] },
  { name: "Win - OIB - Added", settings: [setting("x", "x_1")] },
])

const newerPack = pack(NEWER, "v4.1", [{ name: DEFENDER, settings: [setting(ARCHIVE, `${ARCHIVE}_1`), integer("n", 5)] }])
const newestPack = pack(NEWEST, "v4.2", [{ name: DEFENDER, settings: [setting(ARCHIVE, `${ARCHIVE}_0`), integer("n", 5)] }])

function setup(plans: Record<string, Plan> = { [TENANT_A]: "pro", [TENANT_B]: "pro" }, options: { sameLicense?: boolean } = {}) {
  const deps = fakeDeps({ plans, sameLicense: () => options.sameLicense ?? true })
  const tenantA = new FakeTenant(TENANT_A)
  const tenantB = new FakeTenant(TENANT_B)
  const tenantC = new FakeTenant(TENANT_C)
  const wired = wire(deps, [tenantA, tenantB, tenantC])
  const backupApi = deps.api
  const backups: Array<{ id: string; timestamp: string; status: string }> = []
  const backupItems = new Map<string, Item[]>()
  let skipped: string[] = []
  deps.api = async (path, tenantId, body) => {
    if (path === "/api/list-backups") return Response.json({ backups: tenantId.toLowerCase() === TENANT_A ? backups : [] })
    if (path === "/api/list-backup-contents") {
      const items = backupItems.get(String(body?.backupId)) ?? []
      return Response.json({ content: { metadata: { Status: "Success", Failures: 0, SkippedTypes: skipped }, groups: [{ folder: "ConfigurationPolicies", policies: items.map((_, index) => ({ path: `${String(body?.backupId)}/ConfigurationPolicies/p${index}.json` })) }] } })
    }
    if (path === "/api/restore-preview") {
      const items = backupItems.get(String(body?.backupId)) ?? []
      const paths = (body?.paths as string[]) ?? []
      return Response.json({ items: paths.map((entry) => ({ folder: "ConfigurationPolicies", snapshot: items[Number(/p(\d+)\.json$/.exec(entry)![1])] })) })
    }
    return backupApi(path, tenantId, body)
  }
  const workspacePolicies = [{ name: "Custom pack", platforms: "windows10", technologies: "mdm", description: "", settings: [{ settingInstance: setting("f", "f_1").settingInstance as Item }, { settingInstance: setting("zz", "zz_1").settingInstance as Item }] }]
  const sources: CustomBaselineSources = {
    releases: async () => ({ releases: [{ platform: "windows", tag: "v4.0", commit: NEW, reference: newPack.reference }, { platform: "windows", tag: "v3.8", commit: OLD, reference: oldPack.reference }] }),
    pack: async (_platform, commit) => {
      if (commit === OLD) return structuredClone(oldPack)
      if (commit === NEW) return structuredClone(newPack)
      if (commit === NEWER) return structuredClone(newerPack)
      if (commit === NEWEST) return structuredClone(newestPack)
      throw new Error("This commit is not an OIB release for the chosen platform.")
    },
    workspace: (_tenantId, frameworkId) => (frameworkId === "custom" ? { policies: workspacePolicies as never, reference: "Our standard r3", creations: [] } : { policies: [], reference: "", creations: [] }),
    ncsc: async () => ({ reference: "NCSC fixture", policies: [{ name: "NCSC - Defender", platforms: "windows10", technologies: "mdm", description: "", settings: [{ settingInstance: setting(ARCHIVE, `${ARCHIVE}_1`).settingInstance as Item }] }] as never }),
  }
  const api = routes(deps, sources)
  const post = (body: Record<string, unknown>, tenantId = TENANT_A) => call(api, PATH, { tenantId, ...body })
  const setBackups = (entries: typeof backups, items: Record<string, Item[]>, skip: string[] = []) => {
    backups.splice(0, backups.length, ...entries)
    for (const [id, list] of Object.entries(items)) backupItems.set(id, list)
    skipped = skip
  }
  return { deps, sources, tenantA, tenantB, tenantC, backups: wired.backups, post, setBackups }
}

type Context = ReturnType<typeof setup>

async function customize(context: Context, tenantId = TENANT_A) {
  const result = await context.post({ action: "customize", platform: "windows", commit: OLD, name: "Contoso Windows" }, tenantId)
  expect(result.status).toBe(200)
  return result.body.baseline
}

async function version(context: Context, id: string, number?: number, tenantId = TENANT_A) {
  const result = await context.post({ action: "get", id, ...(number ? { version: number } : {}) }, tenantId)
  expect(result.status).toBe(200)
  return result.body
}

async function approveAndApply(context: Context, id: string, changeSetId: string, tenantId = TENANT_A) {
  const preview = await context.post({ action: "change-preview", id, changeSetId }, tenantId)
  expect(preview.status).toBe(200)
  expect((await context.post({ action: "change-approve", id, changeSetId, contentHash: preview.body.contentHash, targetFingerprint: preview.body.targetFingerprint, reviewer: "Reviewer" }, tenantId)).status).toBe(200)
  return context.post({ action: "change-apply", id, changeSetId, contentHash: preview.body.contentHash, confirm: true }, tenantId)
}

describe("custom baseline model", () => {
  it("strips IDs, assignments, scope tags and annotations and masks secrets as not portable", () => {
    const stripped = stripForBaseline({ id: "x", "@odata.context": "c", roleScopeTagIds: ["5"], assignments: [{}], settingCount: 2, "#microsoft.graph.assign": {}, ...policy("P", [secret("s", "****"), secret("token", "encrypted-token-value"), setting("a", "a_1")]) })
    expect(stripped.snapshot.id).toBeUndefined()
    expect(stripped.snapshot.assignments).toBeUndefined()
    expect(stripped.snapshot.roleScopeTagIds).toBeUndefined()
    expect(stripped.snapshot["#microsoft.graph.assign"]).toBeUndefined()
    const json = JSON.stringify(stripped.snapshot)
    expect(json).not.toContain("****")
    expect(json).not.toContain("encrypted-token-value")
    expect(json).toContain(REDACTED)
    expect(stripped.nonPortable.map((entry) => entry.settingKey).sort()).toEqual(["s", "token"])
  })

  it("derives readable names and value kinds without network lookups", () => {
    expect(settingLabel(ARCHIVE)).toBe("defender allowarchivescanning")
    const views = settingViews(customPolicy("P", policy("P", [setting(ARCHIVE, `${ARCHIVE}_1`), integer("n", 5), secret("s", "****")])))
    expect(views.map((view) => view.leaves[0]!.kind)).toEqual(["boolean-choice", "integer", "secret"])
    expect(views[0]!.leaves[0]!.value).toBe("1")
    expect(views[2]!.leaves[0]!.value).toBeNull()
    const multi = settingViews(customPolicy("P", policy("P", [setting("scan", "scan_level_1")])))
    expect(multi[0]!.leaves[0]!.kind).toBe("choice")
  })

  it("validates edits by type and never edits secrets", () => {
    const policies = [customPolicy("P", policy("P", [setting(ARCHIVE, `${ARCHIVE}_1`), integer("n", 5), secret("s", "****"), text("t", "x")]))]
    const set = (settingKey: string, value: string | number) => ({ type: "set" as const, policyKey: policies[0]!.key, settingKey, path: "", value })
    expect(() => applyEdits(policies, [set("n", "five")])).toThrow(EditError)
    expect(() => applyEdits(policies, [set("s", "new secret")])).toThrow(/secret/)
    expect(() => applyEdits(policies, [set(ARCHIVE, "maybe")])).toThrow(EditError)
    expect(() => applyEdits(policies, [set("t", "****")])).toThrow(/masked/)
    const edited = applyEdits(policies, [set("n", "7"), set(ARCHIVE, `${ARCHIVE}_0`)])
    const views = settingViews(edited[0]!)
    expect(views.find((view) => view.key === "n")!.leaves[0]!.value).toBe(7)
    expect(views.find((view) => view.key === ARCHIVE)!.leaves[0]!.value).toBe("0")
    expect(settingViews(policies[0]!).find((view) => view.key === "n")!.leaves[0]!.value).toBe(5)
  })
})

describe("/api/custom-baselines", () => {
  it.each([TENANT_A, TENANT_B])("resolves placeholders for writes into %s and keeps sources and versions reusable", async (target) => {
    const context = setup()
    const content = pack(OLD, "v3.8", [
      { name: DEFENDER, settings: [stringSetting("org", "prefix/%OrganizationId%/%organizationid%/suffix")] },
      { name: FIREWALL, settings: [stringSetting("org", "%OrganizationId%")] },
    ])
    Object.assign(context.sources, fakeOibSources([content]))
    const baseline = await customize(context)
    const before = (await version(context, baseline.id)).version
    const tenant = target === TENANT_A ? context.tenantA : context.tenantB
    tenant.addPolicy(policy(content.items[1]!.name, [stringSetting("org", "old")]) as Item & { name: string })
    const deployed = await context.post({ action: "deploy", id: baseline.id, ...(target === TENANT_A ? {} : { sourceTenantId: TENANT_A, targetTenants: [{ tenantId: TENANT_A }] }) }, target)
    expect(deployed.status).toBe(200)
    expect(deployed.body.changeSet.operations.map((entry: { action: string }) => entry.action)).toEqual(["create", "update"])
    const applied = await approveAndApply(context, deployed.body.deployment.id, deployed.body.changeSet.id, target)
    expect(applied.body.changeSet.status).toBe("applied")
    const writes = tenant.calls.filter((entry) => entry.method !== "GET")
    expect(writes).toHaveLength(2)
    for (const write of writes) {
      expect(JSON.stringify(write.body)).toContain(target)
      expect(JSON.stringify(write.body)).not.toMatch(/%OrganizationId%/i)
    }
    expect(JSON.stringify(writes[0]!.body)).toContain(`prefix/${target}/${target}/suffix`)
    expect((await version(context, baseline.id)).version).toEqual(before)
    const source = context.deps.records.get(DOMAINS.baselineInstalls, TENANT_A, baseline.provenance.sourceId)!
    expect(JSON.stringify(source)).toContain("%OrganizationId%")
    expect(JSON.stringify(before)).toContain("%OrganizationId%")
    expect(JSON.stringify(content)).toContain("%OrganizationId%")
    expect((await context.post({ action: "deploy", id: baseline.id, ...(target === TENANT_A ? {} : { sourceTenantId: TENANT_A, targetTenants: [{ tenantId: TENANT_A }] }) }, target)).body.error).toContain("already matches")
  })

  it.each(["live", "backup"])("compares substituted Quick Start content from %s without a deviation", async (source) => {
    const context = setup()
    const content = pack(OLD, "v3.8", [{ name: DEFENDER, settings: [stringSetting("org", "prefix/%OrganizationId%/suffix")] }])
    Object.assign(context.sources, fakeOibSources([content]))
    const baseline = await customize(context)
    const live = context.tenantA.addPolicy(policy(content.items[0]!.name, [stringSetting("org", `prefix/${TENANT_A}/suffix`)]) as Item & { name: string })
    context.setBackups([{ id: "backup-2026-09-29-100000", timestamp: "2026-09-29T10:00:00Z", status: "Success" }], { "backup-2026-09-29-100000": [live] })
    const compared = await context.post({ action: "compare-tenant", id: baseline.id, source })
    expect(compared.status).toBe(200)
    expect(compared.body.comparison.counts).toMatchObject({ matched: 1, deviating: 0, differences: 0, unknownSettings: 0 })
    expect(compared.body.comparison.tenantPolicies[0].differences).toEqual([])
    expect(context.tenantA.writeCount()).toBe(0)
    expect(JSON.stringify((await version(context, baseline.id)).version)).toContain("%OrganizationId%")
  })

  it("customizes an OIB release into version 1 with provenance and per-policy base snapshots", async () => {
    const context = setup()
    const baseline = await customize(context)
    expect(baseline.currentVersion).toBe(1)
    expect(baseline.provenance).toMatchObject({ platform: "windows", commit: OLD, reference: oldPack.reference })
    expect(baseline.excluded.map((entry: { name: string }) => entry.name)).toEqual(["Win - OIB - Compliance - v3.8"])
    const source = context.deps.records.get<{ kind: string; origin: string; commit: string; policies: unknown[] }>(DOMAINS.baselineInstalls, TENANT_A, baseline.provenance.sourceId)!
    expect(source).toMatchObject({ kind: "source", origin: "oib", commit: OLD })
    const view = await version(context, baseline.id)
    expect(view.version.policies).toHaveLength(2)
    expect(JSON.stringify(view.version.policies)).not.toContain("author-id")
    expect(JSON.stringify(view.version)).not.toContain("allDevicesAssignmentTarget")
    expect(context.tenantA.calls).toHaveLength(0)
    expect((await context.post({ action: "customize", platform: "windows", commit: "d".repeat(40) })).status).toBe(502)
  })

  it("saves edits as immutable versions with notes and history", async () => {
    const context = setup()
    const baseline = await customize(context)
    const v1 = (await version(context, baseline.id)).version
    const defender = v1.policies.find((entry: { name: string }) => entry.name.includes("Defender"))
    const firewall = v1.policies.find((entry: { name: string }) => entry.name.includes("Firewall"))
    const saved = await context.post({ action: "save-version", id: baseline.id, fromVersion: 1, note: "Tighten Defender", edits: [
      { type: "set", policyKey: defender.key, settingKey: "n", path: "", value: 9 },
      { type: "set", policyKey: defender.key, settingKey: ARCHIVE, path: "", value: `${ARCHIVE}_0` },
      { type: "set", policyKey: defender.key, settingKey: "t", path: "", value: "contoso" },
      { type: "remove-setting", policyKey: defender.key, settingKey: "c" },
    ] })
    expect(saved.status).toBe(200)
    expect(saved.body.baseline.currentVersion).toBe(2)
    expect((await context.post({ action: "save-version", id: baseline.id, fromVersion: 1, note: "Late", edits: [{ type: "remove-policy", policyKey: firewall.key }] })).status).toBe(409)
    expect((await context.post({ action: "save-version", id: baseline.id, fromVersion: 2, note: "Bad", edits: [{ type: "set", policyKey: defender.key, settingKey: "n", path: "", value: "x" }] })).status).toBe(400)
    expect((await context.post({ action: "save-version", id: baseline.id, fromVersion: 2, note: "Nothing", edits: [] })).status).toBe(400)
    const renamed = await context.post({ action: "save-version", id: baseline.id, fromVersion: 2, name: "Contoso Windows standard", note: "Rename and drop firewall", edits: [{ type: "remove-policy", policyKey: firewall.key }] })
    expect(renamed.body.baseline).toMatchObject({ currentVersion: 3, name: "Contoso Windows standard" })
    expect(renamed.body.baseline.versions.map((entry: { version: number; note: string }) => [entry.version, entry.note])).toEqual([[1, `Created from ${oldPack.reference}.`], [2, "Tighten Defender"], [3, "Rename and drop firewall"]])
    const first = (await version(context, baseline.id, 1)).version
    expect(first.policies).toHaveLength(2)
    expect(first.policies[0].settings.find((entry: { key: string }) => entry.key === "n").leaves[0].value).toBe(5)
    const second = (await version(context, baseline.id, 2)).version
    expect(second.policies[0].settings.find((entry: { key: string }) => entry.key === "n").leaves[0].value).toBe(9)
    expect(second.policies[0].settings.some((entry: { key: string }) => entry.key === "c")).toBe(false)
  })

  it("deploys through the engine: creates and updates, never writes assignments, records version and tenant", async () => {
    const context = setup()
    const baseline = await customize(context)
    const existing = context.tenantA.addPolicy({ ...(policy(`${FIREWALL} - v3.7`, [setting("f", "f_OLD")]) as Item & { name: string }), roleScopeTagIds: ["7"], assignments: [{ id: "a1", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "44444444-4444-4444-4444-444444444444" } }] })
    const deployed = await context.post({ action: "deploy", id: baseline.id })
    expect(deployed.status).toBe(200)
    const { deployment, changeSet } = deployed.body
    expect(changeSet.origin).toEqual({ workflow: "custom-baseline", recordId: deployment.id })
    expect(changeSet.operations.map((operation: { action: string }) => operation.action).sort()).toEqual(["create", "update"])
    expect(changeSet.operations.every((operation: { setsAssignments: boolean }) => !operation.setsAssignments)).toBe(true)
    expect(context.tenantA.writeCount()).toBe(0)
    expect((await context.post({ action: "deploy", id: baseline.id })).status).toBe(409)

    const applied = await approveAndApply(context, deployment.id, changeSet.id)
    expect(applied.status).toBe(200)
    expect(applied.body.changeSet.status).toBe("applied")
    expect(context.backups).toEqual([TENANT_A])
    expect(context.tenantA.writeCount((entry) => entry.path.includes("/assign"))).toBe(0)
    expect(context.tenantA.calls.filter((entry) => entry.method !== "GET").every((entry) => entry.journaled && !JSON.stringify(entry.body ?? {}).includes("assignments"))).toBe(true)
    const updated = context.tenantA.policies.get(existing.id as string)!
    expect(JSON.stringify(updated.settings)).toContain("f_1")
    expect(updated.roleScopeTagIds).toEqual(["7"])
    expect((updated.assignments as Item[]).length).toBe(1)
    const created = [...context.tenantA.policies.values()].find((entry) => String(entry.name).startsWith(DEFENDER))!
    expect(created.assignments).toEqual([])
    expect(created.roleScopeTagIds).toEqual(["0"])

    const listed = await context.post({ action: "list" })
    expect(listed.body.deployments[0]).toMatchObject({ status: "applied", version: 1, baselineId: baseline.id })
    expect(listed.body.baselines[0].deployments).toEqual([expect.objectContaining({ targetTenantId: TENANT_A, version: 1, status: "applied" })])

    const rollback = await context.post({ action: "change-rollback-create", id: deployment.id, changeSetId: changeSet.id })
    expect(rollback.status).toBe(200)
    const rolled = await approveAndApply(context, deployment.id, rollback.body.changeSet.id)
    expect(rolled.body.changeSet.status).toBe("applied")
    expect(rolled.body.record.status).toBe("rolled-back")
    expect(context.tenantA.policies.has(created.id as string)).toBe(false)
  })

  it("rebases onto a newer release with conflicts, without touching the tenant", async () => {
    const context = setup()
    const baseline = await customize(context)
    const v1 = (await version(context, baseline.id)).version
    const defender = v1.policies.find((entry: { name: string }) => entry.name.includes("Defender"))
    const edited = await context.post({ action: "save-version", id: baseline.id, fromVersion: 1, note: "Our c", edits: [{ type: "set", policyKey: defender.key, settingKey: "c", path: "", value: "mid" }, { type: "set", policyKey: defender.key, settingKey: "n", path: "", value: 8 }] })
    expect(edited.status).toBe(200)
    const releases = await context.post({ action: "releases", id: baseline.id })
    expect(releases.body.releases.map((entry: { commit: string }) => entry.commit)).toEqual([NEW])

    const compared = await context.post({ action: "rebase-compare", id: baseline.id, commit: NEW })
    expect(compared.status).toBe(200)
    const rebase = compared.body.rebase
    expect(rebase.status).toBe("review")
    const entry = rebase.entries.find((item: { key: string }) => item.key === defender.key)
    expect(Object.fromEntries(entry.comparison.settings.map((setting: { key: string; kind: string }) => [setting.key, setting.kind]))).toMatchObject({ c: "conflict", n: "local-kept", new: "upstream-added" })
    expect(rebase.entries.find((item: { kind: string }) => item.kind === "added").choice).toBe("include")
    expect((await context.post({ action: "rebase-apply", rebaseId: rebase.id })).status).toBe(409)

    const resolved = await context.post({ action: "rebase-resolve", rebaseId: rebase.id, settings: [{ policyKey: defender.key, settingKey: "c", choice: "local" }] })
    expect(resolved.body.rebase.status).toBe("ready")
    const applied = await context.post({ action: "rebase-apply", rebaseId: rebase.id, note: "Reviewed by Sam" })
    expect(applied.status).toBe(200)
    expect(applied.body.baseline).toMatchObject({ currentVersion: 3, provenance: { commit: NEW, reference: newPack.reference } })
    const v3 = (await version(context, baseline.id, 3)).version
    const merged = v3.policies.find((item: { key: string }) => item.key === defender.key)
    const value = (key: string) => merged.settings.find((setting: { key: string }) => setting.key === key)?.leaves[0].value
    expect([value("c"), value("n"), value("new")]).toEqual(["mid", 8, "1"])
    expect(merged.name).toBe(`${DEFENDER} - v4.0`)
    expect(v3.policies.map((item: { name: string }) => item.name)).toContain("Win - OIB - Added - v4.0")
    expect(v3.base.commit).toBe(NEW)
    expect(context.tenantA.calls).toHaveLength(0)
  })

  it("keeps a policy kept in one rebase through the next rebase", async () => {
    const context = setup()
    const baseline = await customize(context)
    const first = (await context.post({ action: "rebase-compare", id: baseline.id, commit: NEWER })).body.rebase
    const firewall = first.entries.find((entry: { name: string }) => entry.name.includes("Firewall"))
    expect(firewall).toMatchObject({ kind: "removed", choice: "keep" })
    expect((await context.post({ action: "rebase-apply", rebaseId: first.id })).status).toBe(200)
    const second = (await context.post({ action: "rebase-compare", id: baseline.id, commit: NEWEST })).body.rebase
    expect(second.entries.find((entry: { key: string }) => entry.key === firewall.key)).toMatchObject({ kind: "removed", choice: "keep" })
    expect((await context.post({ action: "rebase-apply", rebaseId: second.id })).status).toBe(200)
    const latest = (await version(context, baseline.id)).version
    expect(latest.base.commit).toBe(NEWEST)
    expect(latest.policies.map((entry: { key: string }) => entry.key)).toContain(firewall.key)
  })

  it("creates a company baseline from a complete backup, with secrets not portable and blocked on deploy", async () => {
    const context = setup()
    context.setBackups([{ id: "backup-2026-09-29-100000", timestamp: "2026-09-29T10:00:00Z", status: "Success" }, { id: "backup-2026-09-30-100000", timestamp: "2026-09-30T10:00:00Z", status: "CompletedWithWarnings" }], {
      "backup-2026-09-29-100000": [
        { id: "11111111-aaaa-4aaa-8aaa-111111111111", ...policy("Company - Wi-Fi", [text("ssid", "Contoso"), secret("psk", "encrypted-token-value")]), assignments: [{ target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }], roleScopeTagIds: ["3"] },
        { id: "22222222-aaaa-4aaa-8aaa-222222222222", ...policy("Company - Defender", [setting(ARCHIVE, `${ARCHIVE}_1`)]) },
      ],
    })
    const options = await context.post({ action: "snapshots" })
    expect(options.body.snapshots.map((entry: { usable: boolean }) => entry.usable)).toEqual([true, false])
    expect((await context.post({ action: "from-snapshot", backupId: "backup-2026-09-30-100000" })).status).toBe(409)
    const created = await context.post({ action: "from-snapshot", backupId: "backup-2026-09-29-100000", name: "Company standard" })
    expect(created.status).toBe(200)
    const baseline = created.body.baseline
    expect(baseline).toMatchObject({ origin: "snapshot", provenance: { backupFolder: "backup-2026-09-29-100000" } })
    const all = JSON.stringify([...context.deps.store.values.values()])
    expect(all).not.toContain("encrypted-token-value")
    expect(all).not.toContain("11111111-aaaa")
    const view = (await version(context, baseline.id)).version
    const wifi = view.policies.find((entry: { name: string }) => entry.name === "Company - Wi-Fi")
    expect(wifi.nonPortable).toEqual([expect.objectContaining({ settingKey: "psk", reason: "secret" })])

    const deployed = await context.post({ action: "deploy", id: baseline.id })
    expect(deployed.status).toBe(200)
    expect(deployed.body.deployment.policies.find((entry: { name: string }) => entry.name === "Company - Wi-Fi")).toMatchObject({ action: "blocked" })
    expect(deployed.body.changeSet.operations).toHaveLength(1)
    // Removing the secret setting makes the policy deployable.
    const saved = await context.post({ action: "save-version", id: baseline.id, fromVersion: 1, note: "Drop the PSK", edits: [{ type: "remove-setting", policyKey: wifi.key, settingKey: "psk" }] })
    expect(saved.body.baseline.currentVersion).toBe(2)
    expect((await version(context, baseline.id)).version.policies.find((entry: { name: string }) => entry.name === "Company - Wi-Fi").nonPortable).toEqual([])

    context.setBackups([{ id: "backup-x", timestamp: "2026-09-30T10:00:00Z", status: "Success" }], { "backup-x": [policy("P", [setting("a", "a_1")])] }, ["ConfigurationPolicies"])
    expect((await context.post({ action: "from-snapshot", backupId: "backup-x" })).status).toBe(409)
  })

  it("compares a baseline with pack frameworks using the baseline as the policy set", async () => {
    const context = setup()
    const baseline = await customize(context)
    const oib = await context.post({ action: "compare-framework", id: baseline.id, framework: { kind: "oib", platform: "windows", commit: NEW } })
    expect(oib.status).toBe(200)
    const comparison = oib.body.comparison
    expect(comparison.label).toBe("Compared with baseline Contoso Windows v1, not with the live tenant.")
    expect(comparison.source).toMatchObject({ type: "pack", frameworkId: "oib", reference: newPack.reference })
    const status = Object.fromEntries(comparison.findings.map((finding: { policyName: string; settingId: string; status: string }) => [`${finding.policyName.split(" - ")[2]}:${finding.settingId}`, finding.status]))
    expect(status).toMatchObject({ [`Defender:${ARCHIVE}`]: "Present", "Defender:c": "Different", "Defender:new": "Missing", "Firewall:f": "Different", "Added:x": "Missing" })
    expect((await context.post({ action: "compare-framework", id: baseline.id, framework: { kind: "ncsc" } })).body.comparison.counts).toMatchObject({ Present: 1 })
    const workspace = await context.post({ action: "compare-framework", id: baseline.id, framework: { kind: "workspace", frameworkId: "custom" } })
    expect(workspace.body.comparison.counts).toMatchObject({ Present: 1, Missing: 1 })
    expect((await context.post({ action: "compare-framework", id: baseline.id, framework: { kind: "workspace", frameworkId: "cis-benchmarks" } })).status).toBe(403)
    expect(context.tenantA.calls).toHaveLength(0)
    const listed = await context.post({ action: "list" })
    expect(listed.body.comparisons).toHaveLength(3)
    expect(listed.body.comparisons[0].findings).toBeUndefined()
  })

  it("keeps native evidence a baseline cannot provide unknown, never matching or missing", async () => {
    const context = setup()
    const baseline = await customize(context)
    const result = await context.post({ action: "compare-framework", id: baseline.id, framework: { kind: "native", frameworkId: "nist-800-53" } })
    expect(result.status).toBe(200)
    const native = result.body.comparison.native
    const checks = native.assessment.capabilities.flatMap((capability: { checks: Array<{ result: string | null; assessmentStatus: string }> }) => capability.checks)
    expect(checks.some((check: { result: string | null }) => check.result === "missing")).toBe(false)
    expect(checks.some((check: { assessmentStatus: string }) => check.assessmentStatus === "unableToCheck")).toBe(true)
    expect(native.assessment.frameworks[0].controls.some((control: { status: string }) => control.status === "evidenceFound")).toBe(false)
    expect(native.assessment.capabilities.some((capability: { status: string }) => capability.status === "enforced" || capability.status === "noEvidence")).toBe(false)
    expect(result.body.comparison.label).toContain("not with the live tenant")
  })

  it("stores the selected native framework hash and scope for baseline comparisons", async () => {
    const context = setup()
    const baseline = await customize(context)
    for (const [frameworkId, definition] of [["iso-27001", ISO_27001], ["soc2", SOC_2]] as const) {
      const result = await context.post({ action: "compare-framework", id: baseline.id, framework: { kind: "native", frameworkId, scope: { platforms: ["windows"], essentialEightMaturityLevel: 1, defStanRiskLevel: 1 } } })
      expect(result.status).toBe(200)
      const native = result.body.comparison.native
      expect(native.assessment.scope.platforms).toEqual(["windows"])
      expect(native.assessment.frameworks[0].framework.id).toBe(definition.id)
      expect(native.rulesetSha256).toBe(await frameworkRulesetSha256(definition))
      expect(native.rulesetSha256).not.toBe(await frameworkRulesetSha256(NIST_800_53))
      const listed = await context.post({ action: "get", kind: "comparison", id: result.body.comparison.id })
      expect(listed.status).toBe(200)
      expect(listed.body.comparison.native.rulesetSha256).toBe(native.rulesetSha256)
    }
    expect(context.tenantA.calls).toHaveLength(0)
  })

  it("reports a baseline's Settings Catalog values as checks while other evidence stays unable to check", async () => {
    const policies = [customPolicy("P", policy("P", [setting("device_vendor_msft_policy_config_defender_allowrealtimemonitoring", "device_vendor_msft_policy_config_defender_allowrealtimemonitoring_1"), secret("s", "****")]))]
    const manifest = await createEvidenceManifest({ ...baselineEvidence(policies, "2026-09-30T12:00:00Z"), assessmentScope: { platforms: ["windows"] } })
    const coverage = Object.fromEntries(manifest.assessment.collectionCoverage.map((row) => [row.family, row.status]))
    expect(coverage).toMatchObject({ settingsCatalog: "complete", deviceConfigurations: "notCollected", conditionalAccessPolicies: "notCollected" })
    expect(JSON.stringify(baselineEvidence(policies, "2026-09-30T12:00:00Z"))).not.toContain(REDACTED)
  })

  it("compares a baseline version with the tenant from a backup and live", async () => {
    const context = setup()
    const baseline = await customize(context)
    const drifted = context.tenantA.addPolicy(policy(`${FIREWALL} - v3.8`, [setting("f", "f_CHANGED"), setting("g", "g_1")]) as Item & { name: string })
    const live = await context.post({ action: "compare-tenant", id: baseline.id, source: "live" })
    expect(live.status).toBe(200)
    const firewall = live.body.comparison.tenantPolicies.find((entry: { name: string }) => entry.name.includes("Firewall"))
    expect(firewall.state).toBe("matched")
    expect(firewall.differences.map((entry: { key: string }) => entry.key)).toEqual(["f"])
    expect(live.body.comparison.tenantPolicies.find((entry: { name: string }) => entry.name.includes("Defender")).state).toBe("missing")
    expect(context.tenantA.writeCount()).toBe(0)
    context.setBackups([{ id: "backup-2026-09-29-100000", timestamp: "2026-09-29T10:00:00Z", status: "Success" }], { "backup-2026-09-29-100000": [{ ...context.tenantA.policies.get(drifted.id as string)! }] })
    const fromBackup = await context.post({ action: "compare-tenant", id: baseline.id, source: "backup" })
    expect(fromBackup.status).toBe(200)
    expect(fromBackup.body.comparison.source).toMatchObject({ type: "backup", backupId: "backup-2026-09-29-100000" })
    expect(fromBackup.body.comparison.counts).toMatchObject({ deviating: 1, missing: 1 })
  })

  it("gates creation and deployment on Community while stored records stay readable", async () => {
    const plans: Record<string, Plan> = { [TENANT_A]: "pro" }
    const context = setup(plans)
    const baseline = await customize(context)
    const deployed = await context.post({ action: "deploy", id: baseline.id })
    expect(deployed.status).toBe(200)
    plans[TENANT_A] = "community"
    const downgraded = setup({ [TENANT_A]: "community" })
    Object.assign(downgraded.deps, { records: context.deps.records })
    const community = routes(downgraded.deps)
    const post = (body: Record<string, unknown>) => call(community, PATH, { tenantId: TENANT_A, ...body })
    for (const action of ["customize", "from-snapshot", "deploy", "save-version", "rebase-compare", "compare-framework", "compare-tenant", "snapshots", "change-apply"]) {
      expect((await post({ action, id: baseline.id, platform: "windows", commit: OLD })).status).toBe(402)
    }
    const listed = await post({ action: "list" })
    expect(listed.status).toBe(200)
    expect(listed.body.baselines).toHaveLength(1)
    expect((await post({ action: "get", id: baseline.id })).status).toBe(200)
    expect((await post({ action: "get", kind: "deployment", id: deployed.body.deployment.id })).body.changeSets).toHaveLength(1)
  })

  it("keeps baselines in their tenant; another tenant deploys only as a checked two-tenant action", async () => {
    const context = setup({ [TENANT_A]: "pro", [TENANT_B]: "pro" })
    const baseline = await customize(context)
    expect((await context.post({ action: "get", id: baseline.id }, TENANT_B)).status).toBe(404)
    expect((await context.post({ action: "deploy", id: baseline.id }, TENANT_B)).status).toBe(404)
    expect((await context.post({ action: "deploy", id: baseline.id, sourceTenantId: TENANT_A }, TENANT_B)).status).toBe(400)
    const deployed = await context.post({ action: "deploy", id: baseline.id, sourceTenantId: TENANT_A, targetTenants: [{ tenantId: TENANT_A }] }, TENANT_B)
    expect(deployed.status).toBe(200)
    expect(deployed.body.changeSet.targetTenantId).toBe(TENANT_B)
    expect(deployed.body.changeSet.sourceTenantId).toBe(TENANT_A)
    expect((await context.post({ action: "list" }, TENANT_A)).body.deployments).toHaveLength(0)
    expect((await context.post({ action: "get", id: baseline.id })).body.baseline.deployments).toEqual([expect.objectContaining({ targetTenantId: TENANT_B, version: 1 })])

    const otherLicense = setup({ [TENANT_A]: "pro", [TENANT_B]: "pro" }, { sameLicense: false })
    const foreign = await customize(otherLicense)
    expect((await otherLicense.post({ action: "deploy", id: foreign.id, sourceTenantId: TENANT_A, targetTenants: [{ tenantId: TENANT_A }] }, TENANT_B)).status).toBe(403)

    const msp = setup({ [TENANT_A]: "msp", [TENANT_C]: "msp" }, { sameLicense: false })
    const mspBaseline = await customize(msp)
    expect((await msp.post({ action: "deploy", id: mspBaseline.id, sourceTenantId: TENANT_A, targetTenants: [{ tenantId: TENANT_A }] }, TENANT_C)).status).toBe(200)
    const community = setup({ [TENANT_A]: "pro", [TENANT_B]: "community" })
    const proBaseline = await customize(community)
    expect((await community.post({ action: "deploy", id: proBaseline.id, sourceTenantId: TENANT_A, targetTenants: [{ tenantId: TENANT_A }] }, TENANT_B)).status).toBe(402)
  })
})
