import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyCisRemediation, approveCisRemediation, createCisRollback, listCisRemediations, OFFLINE_PREVIEW_NOTICE, planCisRemediation, previewCisRemediation, previewCisRollback, RECOMPARE_NOTICE } from "../src/main/features/cis-remediation/engine"
import { applyChangeSet, approveChangeSet, previewChangeSet } from "../src/main/features/change-sets/engine"
import { setInternalCisBenchmarksEnabled } from "../src/main/frameworks/service"
import type { Finding } from "../src/shared/frameworks/policies"
import { fakeDeps, TENANT_A } from "./feature-helpers"
import { FakeTenant, setting, wire } from "./feature-change-sets-fakes"
import type { Item } from "../src/shared/intune/registry"
import { rootMatches, type Json } from "../src/shared/frameworks/policies"

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

  it("keeps the benchmark display name beside the unchanged reference", async () => {
    const context = setup()
    const named = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", benchmarkName: " Synthetic Benchmark ", policies, findings: [], selectedPolicyIndexes: [0] }, "Admin")
    expect(named).toMatchObject({ reference: "synthetic 1.0", benchmarkName: "Synthetic Benchmark" })
    const unnamed = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [], selectedPolicyIndexes: [0] }, "Admin")
    expect(unnamed).toMatchObject({ reference: "synthetic 1.0", benchmarkName: null })
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

  it("does not start the pre-change backup when access is revoked during the final observation", async () => {
    const context = setup()
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Missing", policyName: "Fakebook Beta", settingId: DEF_B })], selectedFindingKeys: ["1:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    const graphFor = context.deps.graph
    let reads = 0
    context.deps.graph = async (...args) => {
      const graph = await graphFor(...args)
      return async (method, path, body, options) => {
        const response = await graph(method, path, body, options)
        if (method === "GET") {
          reads += 1
          if (reads === 1) setInternalCisBenchmarksEnabled(false)
        }
        return response
      }
    }
    await expect(applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin"))
      .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    expect(context.backups).toEqual([])
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("does not make nested planning reads after access is revoked during the policy detail read", async () => {
    const context = setup()
    const existing = context.tenant.addPolicy({ name: "Tenant Alpha", settings: [setting(DEF_A, "fake-off")] })
    const graphFor = context.deps.graph
    const readPaths: string[] = []
    context.deps.graph = async (...args) => {
      const graph = await graphFor(...args)
      return async (method, path, body, options) => {
        if (method === "GET") {
          readPaths.push(path)
          if (readPaths.length === 1) setInternalCisBenchmarksEnabled(false)
        }
        return graph(method, path, body, options)
      }
    }
    await expect(planCisRemediation(context.deps, TENANT_A, {
      title: "Deploy", reference: "synthetic 1.0", policies,
      findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed: [{ policyId: existing.id as string, policyName: "Tenant Alpha", value: null }] })],
      selectedFindingKeys: ["0:0"],
    }, "Admin")).rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    expect(readPaths).toHaveLength(1)
  })

  it("writes nothing when access is revoked during the pre-change backup", async () => {
    const context = setup()
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Missing", policyName: "Fakebook Beta", settingId: DEF_B })], selectedFindingKeys: ["1:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    const api = context.deps.api
    context.deps.api = async (path, tenantId, body) => {
      const response = await api(path, tenantId, body)
      if (path === "/api/backup/status") setInternalCisBenchmarksEnabled(false)
      return response
    }
    await expect(applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin"))
      .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    expect(context.backups).toEqual([TENANT_A])
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("stops before later writes and read-back when access is revoked during the write phase", async () => {
    const context = setup()
    const existing = context.tenant.addPolicy({ name: "Tenant Alpha", settings: [setting(DEF_A, "fake-off")] })
    const findings = [
      finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed: [{ policyId: existing.id as string, policyName: "Tenant Alpha", value: null }] }),
      finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Missing", policyName: "Fakebook Beta", settingId: DEF_B }),
    ]
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings, selectedFindingKeys: ["0:0", "1:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    const graphFor = context.deps.graph
    let revoked = false
    let readsAfterRevocation = 0
    context.deps.graph = async (...args) => {
      const graph = await graphFor(...args)
      return async (method, path, body, options) => {
        if (method === "GET" && revoked) readsAfterRevocation += 1
        return graph(method, path, body, options)
      }
    }
    context.tenant.failWrite = (_method, _path, count) => {
      if (count === 1) {
        revoked = true
        setInternalCisBenchmarksEnabled(false)
      }
      return undefined
    }
    const result = await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    expect(result.changeSet.status).toBe("uncertain")
    expect(Object.values(result.changeSet.results).map((operation) => operation.status)).toContain("uncertain")
    expect(Object.values(result.changeSet.results).map((operation) => operation.status)).not.toContain("verified")
    expect(readsAfterRevocation).toBe(0)
    expect(Object.values(result.changeSet.results).some((operation) => operation.message?.includes("CIS comparisons are coming soon"))).toBe(true)
    expect([...context.tenant.policies.values()].some((policy) => policy.name === "[Baseline] Fakebook Beta")).toBe(false)
    expect(JSON.stringify(context.tenant.policies.get(existing.id as string)?.settings)).toContain("fake-on")
  })

  it("does not persist approval when access is revoked during the approval preview", async () => {
    const context = setup()
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Missing", policyName: "Fakebook Beta", settingId: DEF_B })], selectedFindingKeys: ["1:0"] }, "Admin")
    const preview = await previewCisRemediation(context.deps, TENANT_A, deployment.id)
    const graphFor = context.deps.graph
    let reads = 0
    context.deps.graph = async (...args) => {
      const graph = await graphFor(...args)
      return async (method, path, body) => {
        if (method === "GET") {
          reads += 1
          if (reads === 1) setInternalCisBenchmarksEnabled(false)
        }
        return graph(method, path, body)
      }
    }
    await expect(approveCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, targetFingerprint: preview.changeSet.targetFingerprint, reviewer: "Reviewer" }, "Admin"))
      .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    setInternalCisBenchmarksEnabled(true)
    const after = await previewCisRemediation(context.deps, TENANT_A, deployment.id)
    expect(after.changeSet.status).toBe("in-review")
    expect(after.changeSet.approval.valid).toBe(false)
  })

  it("does not write on retry when access is revoked during target observation", async () => {
    const context = setup()
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Missing", policyName: "Fakebook Beta", settingId: DEF_B })], selectedFindingKeys: ["1:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    context.tenant.failWrite = (_method, _path, count) => count === 1 ? 400 : undefined
    const first = await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    expect(first.changeSet.status).toBe("failed")
    expect([...context.tenant.policies.values()].some((policy) => policy.name === "[Baseline] Fakebook Beta")).toBe(false)

    const graphFor = context.deps.graph
    let reads = 0
    context.deps.graph = async (...args) => {
      const graph = await graphFor(...args)
      return async (method, path, body) => {
        if (method === "GET") {
          reads += 1
          if (reads === 1) setInternalCisBenchmarksEnabled(false)
        }
        return graph(method, path, body)
      }
    }
    const retry = await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    expect(retry.changeSet.status).toBe("failed")
    expect(Object.values(retry.changeSet.results).some((operation) => operation.message?.includes("CIS comparisons are coming soon"))).toBe(true)
    expect([...context.tenant.policies.values()].some((policy) => policy.name === "[Baseline] Fakebook Beta")).toBe(false)
    expect(context.tenant.writeCount()).toBe(1)
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

  it("stops reading a rollback preview when access is revoked during the first operation read", async () => {
    const context = setup()
    const existing = context.tenant.addPolicy({ name: "Tenant Alpha", settings: [setting(DEF_A, "fake-off")] })
    const findings = [
      finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed: [{ policyId: existing.id as string, policyName: "Tenant Alpha", value: null }] }),
      finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Missing", policyName: "Fakebook Beta", settingId: DEF_B }),
    ]
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings, selectedFindingKeys: ["0:0", "1:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")

    const createdId = [...context.tenant.policies.values()].find((policy) => policy.name === "[Baseline] Fakebook Beta")!.id as string
    const graphFor = context.deps.graph
    let reads = 0
    const readPaths: string[] = []
    context.deps.graph = async (...args) => {
      const graph = await graphFor(...args)
      return async (method, path, body) => {
        if (method === "GET") {
          reads += 1
          readPaths.push(path)
          if (reads === 1) setInternalCisBenchmarksEnabled(false)
        }
        return graph(method, path, body)
      }
    }
    await expect(previewCisRollback(context.deps, TENANT_A, deployment.id))
      .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    expect(readPaths.some((path) => path.includes(createdId))).toBe(false)
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
    expect(listCisRemediations(context.deps, TENANT_A)[0]).toMatchObject({ id: deployment.id, status: "applied", rollbackChangeSetId: rollback.id, rollbackStatus: "in-review" })
    expect(listCisRemediations(context.deps, TENANT_A)[0]).not.toHaveProperty("history")
    const rollbackPreview2 = await previewChangeSet(context.deps, TENANT_A, rollback.id)
    await approveChangeSet(context.deps, TENANT_A, rollback.id, { contentHash: rollbackPreview2.contentHash, targetFingerprint: rollbackPreview2.targetFingerprint, reviewer: "Reviewer" }, "Admin")
    const applied = await applyChangeSet(context.deps, TENANT_A, rollback.id, { contentHash: rollbackPreview2.contentHash, confirmed: true }, "Admin")
    expect(applied.status).toBe("applied")
    expect(listCisRemediations(context.deps, TENANT_A)[0]).toMatchObject({ id: deployment.id, rollbackStatus: "applied" })
    expect([...context.tenant.policies.values()].some((policy) => policy.name === "[Baseline] Fakebook Beta")).toBe(false)
    expect(context.tenant.policies.get(existing.id as string)?.description).toBe("before")
    expect(context.audits.length).toBeGreaterThanOrEqual(2)
  })

  it("updates every conflicting tenant policy that differs and leaves one already holding the value alone", async () => {
    const context = setup()
    const matching = context.tenant.addPolicy({ name: "Tenant Matching", settings: [{ id: "0", ...policies[0]!.settings[0]! }] })
    const first = context.tenant.addPolicy({ name: "Tenant Conflict One", settings: [setting(DEF_A, "fake-off")] })
    const second = context.tenant.addPolicy({ name: "Tenant Conflict Two", settings: [setting(DEF_A, "fake-other")] })
    const observed = [matching, first, second].map((policy) => ({ policyId: policy.id as string, policyName: policy.name as string, value: null }))
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed })], selectedFindingKeys: ["0:0"] }, "Admin")
    expect(deployment.items.map((item) => [item.action, item.targetId])).toEqual([["update", first.id], ["update", second.id]])
    const { preview } = await approveFlow(context, deployment.id)
    await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    const puts = context.tenant.calls.filter((call) => call.method === "PUT")
    expect(puts.some((call) => call.path.includes(matching.id as string))).toBe(false)
    for (const policy of [first, second]) expect(JSON.stringify(context.tenant.policies.get(policy.id as string)?.settings)).toContain("fake-on")
  })

  it("refuses to plan when every observed tenant policy already holds the recommended value", async () => {
    const context = setup()
    const matching = context.tenant.addPolicy({ name: "Tenant Matching", settings: [{ id: "0", ...policies[0]!.settings[0]! }] })
    await expect(planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed: [{ policyId: matching.id as string, policyName: "Tenant Matching", value: null }] })], selectedFindingKeys: ["0:0"] }, "Admin"))
      .rejects.toMatchObject({ status: 409 })
  })

  it("merges every selected setting a tenant policy holds into one update and puts Missing settings into the new policy", async () => {
    const context = setup()
    const pack = [{ ...policyJson("Fakebook Combined", DEF_A, "fake-on"), settings: [policyJson("x", DEF_A, "fake-on").settings[0]!, policyJson("x", DEF_B, "fake-on").settings[0]!] }, policyJson("Fakebook Gamma", "fakebook_setting_gamma", "fake-on")]
    const existing = context.tenant.addPolicy({ name: "Tenant Alpha", settings: [setting(DEF_A, "fake-off"), setting("fakebook_setting_gamma", "fake-off")] })
    const observed = [{ policyId: existing.id as string, policyName: "Tenant Alpha", value: null }]
    const findings = [
      finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", policyName: "Fakebook Combined", observed }),
      finding({ key: "0:1", policyIndex: 0, settingIndex: 1, status: "Missing", policyName: "Fakebook Combined", settingId: DEF_B }),
      finding({ key: "1:0", policyIndex: 1, settingIndex: 0, status: "Different", policyName: "Fakebook Gamma", settingId: "fakebook_setting_gamma", observed }),
    ]
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies: pack, findings, selectedFindingKeys: ["0:0", "0:1", "1:0"] }, "Admin")
    expect(deployment.items).toHaveLength(2)
    expect(deployment.items.find((item) => item.action === "update")).toMatchObject({ targetId: existing.id, findingKeys: ["0:0", "1:0"] })
    expect(deployment.items.find((item) => item.action === "create")).toMatchObject({ policyIndex: 0, findingKeys: ["0:1"] })
    const { preview } = await approveFlow(context, deployment.id)
    await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    const updated = JSON.stringify(context.tenant.policies.get(existing.id as string)?.settings)
    expect(updated).not.toContain(DEF_B)
    expect(updated).not.toContain("fake-off")
    const created = [...context.tenant.policies.values()].find((policy) => policy.name === "[Baseline] Fakebook Combined")!
    expect(JSON.stringify(created.settings)).toContain(DEF_B)
    expect(JSON.stringify(created.settings)).not.toContain(DEF_A)
  })

  it("keeps the template reference and setting template references of a template-based target", async () => {
    const context = setup()
    const templated: Item = { settingInstance: { "@odata.type": choice, settingDefinitionId: DEF_A, settingInstanceTemplateReference: { settingInstanceTemplateId: "synthetic-instance-template" }, choiceSettingValue: { value: "fake-off", children: [], settingValueTemplateReference: { settingValueTemplateId: "synthetic-value-template", useTemplateDefault: false } } } }
    const existing = context.tenant.addPolicy({ name: "Tenant Endpoint Security", templateReference: { templateId: "synthetic-template_1", templateFamily: "endpointSecurityAntivirus", templateDisplayName: "Synthetic", templateDisplayVersion: "1" }, settings: [templated] })
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies, findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", observed: [{ policyId: existing.id as string, policyName: "Tenant Endpoint Security", value: null }] })], selectedFindingKeys: ["0:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    const put = context.tenant.calls.find((call) => call.method === "PUT" && call.path.includes(existing.id as string))!
    expect((put.body!.templateReference as Item).templateId).toBe("synthetic-template_1")
    const instance = ((put.body!.settings as Item[])[0]!.settingInstance as Item)
    expect(instance.settingInstanceTemplateReference).toEqual({ settingInstanceTemplateId: "synthetic-instance-template" })
    expect(instance.choiceSettingValue).toMatchObject({ value: "fake-on", settingValueTemplateReference: { settingValueTemplateId: "synthetic-value-template", useTemplateDefault: false } })
  })

  it("keeps extra tenant children when it remediates a grouped root and changes only the recommended leaves", async () => {
    const context = setup()
    const group = "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance"
    const child = (id: string, value: string): Item => ({ "@odata.type": choice, settingDefinitionId: id, choiceSettingValue: { value, children: [] } })
    const root = (children: Item[]): Item => ({ "@odata.type": group, settingDefinitionId: "fakebook_payload", groupSettingCollectionValue: [{ children }] })
    const pack = [{ name: "Fakebook Payload", platforms: "windows10", technologies: "mdm", description: "synthetic", settings: [{ settingInstance: root([child("fakebook_payload_one", "fake-on"), child("fakebook_payload_two", "fake-on")]) }] }]
    const existing = context.tenant.addPolicy({ name: "Tenant Payload", settings: [{ settingInstance: root([child("fakebook_payload_one", "fake-on"), child("fakebook_payload_two", "fake-off"), child("fakebook_payload_extra", "fake-extra")]) }] })
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies: pack, findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", policyName: "Fakebook Payload", settingId: "fakebook_payload", observed: [{ policyId: existing.id as string, policyName: "Tenant Payload", value: null }] })], selectedFindingKeys: ["0:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    const children = (((context.tenant.policies.get(existing.id as string)!.settings as Item[])[0]!.settingInstance as Item).groupSettingCollectionValue as Item[])[0]!.children as Item[]
    expect(children.map((entry) => [entry.settingDefinitionId, (entry.choiceSettingValue as Item).value])).toEqual([["fakebook_payload_one", "fake-on"], ["fakebook_payload_two", "fake-on"], ["fakebook_payload_extra", "fake-extra"]])
  })

  it("keeps tenant group collection entries beyond the pack entries, in order, and merges the matched entry", async () => {
    const context = setup()
    const group = "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance"
    const child = (id: string, value: string): Item => ({ "@odata.type": choice, settingDefinitionId: id, choiceSettingValue: { value, children: [] } })
    const root = (entries: Item[][]): Item => ({ "@odata.type": group, settingDefinitionId: "fakebook_payload", groupSettingCollectionValue: entries.map((children) => ({ children })) })
    const pack = [{ name: "Fakebook Payload", platforms: "windows10", technologies: "mdm", description: "synthetic", settings: [{ settingInstance: root([[child("fakebook_payload_one", "fake-on")]]) }] }]
    const existing = context.tenant.addPolicy({ name: "Tenant Payload", settings: [{ settingInstance: root([[child("fakebook_payload_one", "fake-off"), child("fakebook_payload_extra", "fake-extra")], [child("fakebook_payload_other", "fake-second")], [child("fakebook_payload_other", "fake-third")]]) }] })
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies: pack, findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", policyName: "Fakebook Payload", settingId: "fakebook_payload", observed: [{ policyId: existing.id as string, policyName: "Tenant Payload", value: null }] })], selectedFindingKeys: ["0:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    const entries = (((context.tenant.policies.get(existing.id as string)!.settings as Item[])[0]!.settingInstance as Item).groupSettingCollectionValue as Item[])
    expect(entries.map((entry) => (entry.children as Item[]).map((item) => `${String(item.settingDefinitionId)}=${String((item.choiceSettingValue as Item).value)}`))).toEqual([
      ["fakebook_payload_one=fake-on", "fakebook_payload_extra=fake-extra"],
      ["fakebook_payload_other=fake-second"],
      ["fakebook_payload_other=fake-third"],
    ])
  })

  it.each([
    ["clears a nested simple collection to the empty recommended list", [], ["fake-a", "fake-b"]],
    ["replaces a nested simple collection with the recommended values exactly", ["fake-c"], ["fake-a", "fake-b"]],
  ])("%s, and the comparison then reads the root as matching", async (_name, recommended, tenantValues) => {
    const context = setup()
    const group = "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance"
    const list = (values: string[]): Item => ({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingCollectionInstance", settingDefinitionId: "fakebook_payload_list",
      simpleSettingCollectionValue: values.map((value) => ({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationStringSettingValue", value })) })
    const flag = (value: string): Item => ({ "@odata.type": choice, settingDefinitionId: "fakebook_payload_flag", choiceSettingValue: { value, children: [] } })
    const root = (children: Item[]): Item => ({ "@odata.type": group, settingDefinitionId: "fakebook_payload", groupSettingCollectionValue: [{ children }] })
    const packRoot = root([list(recommended), flag("fake-on")])
    const pack = [{ name: "Fakebook Payload", platforms: "windows10", technologies: "mdm", description: "synthetic", settings: [{ settingInstance: packRoot }] }]
    const existing = context.tenant.addPolicy({ name: "Tenant Payload", settings: [{ settingInstance: root([list(tenantValues), flag("fake-on"), flag("fake-extra-is-ignored")].map((entry, index) => index === 2 ? { ...entry, settingDefinitionId: "fakebook_payload_extra" } : entry)) }] })
    expect(rootMatches(packRoot as Json, (context.tenant.policies.get(existing.id as string)!.settings as Item[])[0]!.settingInstance as Json)).toBe(false)
    const deployment = await planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies: pack, findings: [finding({ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Different", policyName: "Fakebook Payload", settingId: "fakebook_payload", observed: [{ policyId: existing.id as string, policyName: "Tenant Payload", value: null }] })], selectedFindingKeys: ["0:0"] }, "Admin")
    const { preview } = await approveFlow(context, deployment.id)
    await applyCisRemediation(context.deps, TENANT_A, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
    const instance = (context.tenant.policies.get(existing.id as string)!.settings as Item[])[0]!.settingInstance as Item
    const children = ((instance.groupSettingCollectionValue as Item[])[0]!.children as Item[])
    expect(((children.find((entry) => entry.settingDefinitionId === "fakebook_payload_list")!.simpleSettingCollectionValue as Item[]).map((entry) => entry.value))).toEqual(recommended)
    expect(children.some((entry) => entry.settingDefinitionId === "fakebook_payload_extra")).toBe(true)
    expect(rootMatches(packRoot as Json, instance as Json)).toBe(true)
  })

  it("counts operations against the change-set limit", async () => {
    const context = setup()
    const pack = Array.from({ length: 26 }, (_, index) => policyJson(`Fakebook ${index}`, `fakebook_setting_${index}`, "fake-on"))
    const findings = pack.map((_, index) => finding({ key: `${index}:0`, policyIndex: index, settingIndex: 0, status: "Missing", settingId: `fakebook_setting_${index}` }))
    await expect(planCisRemediation(context.deps, TENANT_A, { title: "Deploy", reference: "synthetic 1.0", policies: pack, findings, selectedFindingKeys: findings.map((entry) => entry.key) }, "Admin"))
      .rejects.toThrow("at most 25")
    expect(context.tenant.calls).toEqual([])
  })
})
