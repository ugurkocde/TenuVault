import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyCisRemediation, approveCisRemediation, createCisRollback, OFFLINE_PREVIEW_NOTICE, planCisRemediation, previewCisRemediation, previewCisRollback, RECOMPARE_NOTICE } from "../src/main/features/cis-remediation/engine"
import { applyChangeSet, approveChangeSet, previewChangeSet } from "../src/main/features/change-sets/engine"
import { setInternalCisBenchmarksEnabled } from "../src/main/frameworks/service"
import type { Finding } from "../src/shared/frameworks/policies"
import { fakeDeps, TENANT_A } from "./feature-helpers"
import { FakeTenant, setting, wire } from "./feature-change-sets-fakes"

const DEF_A = "fakebook_setting_alpha"
const DEF_B = "fakebook_setting_beta"
const choice = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policyJson = (name: string, def: string, value: string) => ({ name, platforms: "windows10", technologies: "mdm", description: "synthetic", settings: [{ settingInstance: { "@odata.type": choice, settingDefinitionId: def, choiceSettingValue: { value } } }] })
const policies = [policyJson("Fakebook Alpha", DEF_A, "fake-on"), policyJson("Fakebook Beta", DEF_B, "fake-on")]

function setup(options: { backup?: "ok" | "fail" | "no-start" } = {}) {
  const deps = fakeDeps({ plans: { [TENANT_A]: "pro" } })
  const tenant = new FakeTenant(TENANT_A)
  const wired = wire(deps, [tenant], options)
  const audits: unknown[] = []
  const api = deps.api
  deps.api = async (path, tenantId, body) => { if (path === "/api/audit/log") audits.push(body); return api(path, tenantId, body) }
  return { deps, tenant, audits, ...wired }
}

function finding(partial: Partial<Finding> & Pick<Finding, "key" | "policyIndex" | "settingIndex" | "status">): Finding {
  return { policyName: "Fakebook Alpha", settingId: DEF_A, recommended: null, observed: [], ...partial }
}

async function approveFlow(context: ReturnType<typeof setup>, id: string) {
  const preview = await previewCisRemediation(context.deps, TENANT_A, id)
  const approved = await approveCisRemediation(context.deps, TENANT_A, id, { contentHash: preview.changeSet.contentHash, targetFingerprint: preview.changeSet.targetFingerprint, reviewer: "Reviewer" }, "Admin")
  return { preview, approved }
}

beforeEach(() => setInternalCisBenchmarksEnabled(true))
afterEach(() => setInternalCisBenchmarksEnabled(null))

describe("CIS remediation deploy", () => {
  it("refuses when the internal flag is off, before any write", async () => {
    setInternalCisBenchmarksEnabled(false)
    const context = setup()
    await expect(planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Missing" })], selectedFindingKeys: ["0:0"] }, "Admin")).rejects.toMatchObject({ status: 403 })
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("previews with no write calls, honest offline notice and per policy in-place exposure", async () => {
    const context = setup()
    const existing = context.tenant.addPolicy({ name: "Tenant Alpha", settings: [setting(DEF_A, "fake-off")], assignments: [{ id: "a1", source: "direct", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }] })
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed: [{ policyId: existing.id as string, policyName: "Tenant Alpha", value: null }] })], selectedFindingKeys: ["0:0"] }, "Admin")
    const writesBefore = context.tenant.writeCount()
    const preview = await previewCisRemediation(context.deps, TENANT_A, deployment.id)
    expect(context.tenant.writeCount()).toBe(writesBefore)
    expect(context.tenant.calls.filter((call) => call.method !== "GET")).toEqual([])
    expect(preview.offlineNotice).toBe(OFFLINE_PREVIEW_NOTICE)
    expect(preview.changeSet.notice).toContain("not a tenant dry run")
    expect(preview.policies[0]).toMatchObject({ inPlace: true, assignedExposure: true, assignmentCount: 1 })
    expect(preview.policies[0]!.note).toContain("keeps that broad exposure")
    expect(preview.unassignedNotice).toContain("no assignments")
  })

  it("applies only selected findings, creates unassigned and never copies assignments, with backup and audit", async () => {
    const context = setup()
    const existing = context.tenant.addPolicy({ name: "Tenant Alpha", settings: [setting(DEF_A, "fake-off")], assignments: [{ id: "a1", source: "direct", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }] })
    const findings = [
      finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed: [{ policyId: existing.id as string, policyName: "Tenant Alpha", value: null }] }),
      finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Missing", policyName: "Fakebook Beta", settingId: DEF_B }),
    ]
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings, selectedFindingKeys: ["0:0", "1:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    expect(preview.changeSet.operations.every((operation) => operation.action === "create" || operation.action === "update")).toBe(true)
    const result = await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    expect(result.changeSet.status).toBe("applied")
    expect(result.changeSet.operations.every((operation) => !operation.setsAssignments)).toBe(true)
    expect(context.backups).toEqual([TENANT_A])
    expect(context.audits.length).toBeGreaterThanOrEqual(1)
    const created = [...context.tenant.policies.values()].find((policy) => policy.name === "[Baseline] Fakebook Beta")!
    expect(created.assignments).toEqual([])
    expect(context.tenant.policies.get(existing.id as string)?.assignments).toHaveLength(1)
    // Re-running the comparison inputs: the updated setting now matches the benchmark value.
    const updated = context.tenant.policies.get(existing.id as string)!
    expect(JSON.stringify(updated.settings)).toContain(DEF_A)
    expect(JSON.stringify(updated.settings)).toContain("fake-on")
  })

  it("handles a name collision exactly as change sets do: warns, creates another, never overwrites", async () => {
    const context = setup()
    const collision = context.tenant.addPolicy({ name: "[Baseline] Fakebook Alpha", description: "keep me" })
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [], selectedPolicyIndexes: [0] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    expect(preview.changeSet.operations[0]!.warnings.join(" ")).toContain("already exist")
    const result = await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    expect(result.changeSet.status).toBe("applied")
    expect(context.tenant.policies.get(collision.id as string)?.description).toBe("keep me")
    expect([...context.tenant.policies.values()].filter((policy) => policy.name === "[Baseline] Fakebook Alpha")).toHaveLength(2)
    const created = [...context.tenant.policies.values()].find((policy) => policy.name === "[Baseline] Fakebook Alpha" && policy.id !== collision.id)!
    expect(created.assignments).toEqual([])
  })

  it("aborts before any write when the pre-change backup fails", async () => {
    const context = setup({ backup: "fail" })
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Missing", policyName: "Fakebook Beta", settingId: DEF_B })], selectedFindingKeys: ["1:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    await expect(applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")).rejects.toThrow()
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("aborts as stale when the tenant changed after approval", async () => {
    const context = setup()
    const existing = context.tenant.addPolicy({ name: "Tenant Alpha", settings: [setting(DEF_A, "fake-off")] })
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed: [{ policyId: existing.id as string, policyName: "Tenant Alpha", value: null }] })], selectedFindingKeys: ["0:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    context.tenant.policies.get(existing.id as string)!.description = "edited elsewhere"
    await expect(applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")).rejects.toMatchObject({ status: 409 })
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("rolls back exactly the recorded creates and setting changes, then offers re-comparison", async () => {
    const context = setup()
    const existing = context.tenant.addPolicy({ name: "Tenant Alpha", settings: [setting(DEF_A, "fake-off")], description: "before" })
    const findings = [
      finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed: [{ policyId: existing.id as string, policyName: "Tenant Alpha", value: null }] }),
      finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Missing", policyName: "Fakebook Beta", settingId: DEF_B }),
    ]
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings, selectedFindingKeys: ["0:0", "1:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    expect([...context.tenant.policies.values()].some((policy) => policy.name === "[Baseline] Fakebook Beta")).toBe(true)
    const rollbackPreview = await previewCisRollback(context.deps, TENANT_A, deployment.id)
    expect(rollbackPreview.recompareNotice).toBe(RECOMPARE_NOTICE)
    const rollback = await createCisRollback(context.deps, TENANT_A, deployment.id, {}, "Admin")
    const rollbackPreview2 = await previewChangeSet(context.deps, TENANT_A, rollback.id)
    await approveChangeSet(context.deps, TENANT_A, rollback.id, { contentHash: rollbackPreview2.contentHash, targetFingerprint: rollbackPreview2.targetFingerprint, reviewer: "Reviewer" }, "Admin")
    const applied = await applyChangeSet(context.deps, TENANT_A, rollback.id, { contentHash: rollbackPreview2.contentHash, confirmed: true }, "Admin")
    expect(applied.status).toBe("applied")
    expect([...context.tenant.policies.values()].some((policy) => policy.name === "[Baseline] Fakebook Beta")).toBe(false)
    expect(context.tenant.policies.get(existing.id as string)?.description).toBe("before")
    expect(context.audits.length).toBeGreaterThanOrEqual(2)
  })
})
