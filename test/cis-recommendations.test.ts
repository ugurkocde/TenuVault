import { describe, expect, it } from "vitest"
import { attachRecommendations, definitionIds, recommendationLabel, recommendationResults, recommendationsForFinding } from "../src/shared/frameworks/cis-recommendations"
import { cisReadiness } from "../src/shared/frameworks/cis-readiness"
import { parsePolicies, remediationPayload, type Assessment, type Finding } from "../src/shared/frameworks/policies"
import { cisReadinessCsv, cisReadinessJson } from "../src/renderer/features/shared/governance-export"
import { workspaceExportCSV, workspaceExportJSON } from "../src/shared/compliance/export"

const choice = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const group = "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance"
const flat = (id: string) => ({ settingInstance: { "@odata.type": choice, settingDefinitionId: id, choiceSettingValue: { value: `${id}_on`, children: [] } } })
const grouped = { settingInstance: { "@odata.type": group, settingDefinitionId: "synthetic_payload", groupSettingCollectionValue: [{ children: [
  { "@odata.type": choice, settingDefinitionId: "synthetic_payload_one", choiceSettingValue: { value: "on", children: [] } },
  { "@odata.type": choice, settingDefinitionId: "synthetic_payload_two", choiceSettingValue: { value: "on", children: [] } },
] }] } }
const provenance = { schemaVersion: 1, benchmark: "synthetic-os", version: "9.9.9", level: "Level 1", sourceFile: "synthetic.json" }
const pack = parsePolicies([
  { name: "Synthetic flat", platforms: "windows10", technologies: "mdm", description: "", provenance, settings: [flat("synthetic_alpha"), flat("synthetic_beta")] },
  { name: "Synthetic payload", platforms: "macOS", technologies: "mdm", description: "", provenance, settings: [grouped] },
])
const recommendations = [
  { id: "1.10.1", title: "Synthetic grouped leaf", level: 1 as const, settings: ["synthetic_payload_two"] },
  { id: "1.2.1", title: "Synthetic alpha and beta", level: 1 as const, settings: ["synthetic_alpha", "synthetic_beta"] },
  { id: "1.2.2", title: "Synthetic beta only", level: 1 as const, settings: ["synthetic_beta"] },
  { id: "1.3.1", title: "Synthetic not in pack", level: 1 as const, settings: ["synthetic_missing"] },
]
const policies = attachRecommendations(pack, recommendations)
const finding = (policyIndex: number, settingIndex: number, settingId: string, status: Finding["status"]): Finding =>
  ({ key: `${policyIndex}:${settingIndex}`, policyIndex, settingIndex, policyName: policies[policyIndex]!.name, settingId, status, recommended: null, observed: [] })
const assessment = (statuses: Finding["status"][]): Assessment => ({ runId: "run-1", tenantId: "11111111-1111-1111-1111-111111111111", frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", assessedAt: "2026-10-15T10:00:00Z", policyCount: 2,
  findings: [finding(0, 0, "synthetic_alpha", statuses[0]!), finding(0, 1, "synthetic_beta", statuses[1]!), finding(1, 0, "synthetic_payload", statuses[2]!)] })

describe("pack recommendations", () => {
  it("lists every definition of a root, including grouped leaf children", () => {
    expect(definitionIds(grouped.settingInstance)).toEqual(["synthetic_payload", "synthetic_payload_one", "synthetic_payload_two"])
  })

  it("attaches each recommendation to the pack policies holding one of its settings, and survives parsing", () => {
    expect(policies[0]!.recommendations?.map(item => item.id)).toEqual(["1.2.1", "1.2.2"])
    expect(policies[1]!.recommendations?.map(item => item.id)).toEqual(["1.10.1"])
    expect(parsePolicies(JSON.parse(JSON.stringify(policies)))).toEqual(policies)
    expect(() => parsePolicies([{ ...policies[0], recommendations: [{ id: "x", title: "t", level: 1, settings: ["a"] }] }])).toThrow("dotted numeric")
    expect(remediationPayload(policies[0]!, policies[0]!.settings, "synthetic")).not.toHaveProperty("recommendations")
  })

  it("matches a finding by its root definition or one of its leaf children", () => {
    expect(recommendationLabel(recommendationsForFinding(policies, { policyIndex: 0, settingIndex: 1 }))).toBe("1.2.1 Synthetic alpha and beta; 1.2.2 Synthetic beta only")
    expect(recommendationLabel(recommendationsForFinding(policies, { policyIndex: 1, settingIndex: 0 }))).toBe("1.10.1 Synthetic grouped leaf")
    expect(recommendationsForFinding(pack, { policyIndex: 0, settingIndex: 0 })).toEqual([])
  })

  it("passes a recommendation only when every mapped finding is Present and fails on Different or Missing", () => {
    expect(recommendationResults(assessment(["Present", "Present", "Present"]), policies).map(item => [item.id, item.result])).toEqual([["1.2.1", "Pass"], ["1.2.2", "Pass"], ["1.10.1", "Pass"]])
    expect(recommendationResults(assessment(["Present", "Different", "Missing"]), policies).map(item => [item.id, item.result])).toEqual([["1.2.1", "Fail"], ["1.2.2", "Fail"], ["1.10.1", "Fail"]])
    expect(recommendationResults(assessment(["Present", "Review", "Present"]), policies).map(item => [item.id, item.result])).toEqual([["1.2.1", "Review"], ["1.2.2", "Review"], ["1.10.1", "Pass"]])
    expect(recommendationResults(assessment(["Present", "Present", "Present"]), pack)).toEqual([])
  })

  it("adds recommendation results to readiness and its exports, and leaves packs without them unchanged", () => {
    const run = assessment(["Present", "Missing", "Present"])
    const summary = cisReadiness(run, policies)
    expect(summary.levels[0]!.recommendations.map(item => [item.id, item.result, item.findingKeys])).toEqual([["1.2.1", "Fail", ["0:0", "0:1"]], ["1.2.2", "Fail", ["0:1"]], ["1.10.1", "Pass", ["1:0"]]])
    expect(cisReadinessCsv(summary)).toContain("synthetic-os,9.9.9,1,,,,,,,,,,,,Fail,Recommendation,1.2.1,Synthetic alpha and beta")
    const json = JSON.parse(cisReadinessJson(summary, null, "2026-10-15T10:00:00Z")) as { levels: Array<{ recommendations?: unknown }> }
    expect(json.levels[0]!.recommendations).toEqual([{ id: "1.2.1", title: "Synthetic alpha and beta", result: "Fail" }, { id: "1.2.2", title: "Synthetic beta only", result: "Fail" }, { id: "1.10.1", title: "Synthetic grouped leaf", result: "Pass" }])
    const plain = cisReadiness(run, pack)
    expect(plain.levels[0]!.recommendations).toEqual([])
    expect(cisReadinessCsv(plain)).not.toContain("Recommendation,")
    expect(JSON.parse(cisReadinessJson(plain, null, "2026-10-15T10:00:00Z")).levels[0]).not.toHaveProperty("recommendations")
  })

  it("adds recommendation id and title to the findings exports only for packs that list recommendations", () => {
    const context = { exportedAt: "2026-10-15T10:00:00Z", tenantName: "Synthetic" }
    const run = assessment(["Present", "Missing", "Present"])
    const csv = workspaceExportCSV({ assessment: run, policies }, context)
    expect(csv).toContain("Recommendation ID,Recommendation title,Pack policy,Setting")
    expect(csv).toContain("1.2.1; 1.2.2,Synthetic alpha and beta; Synthetic beta only,Synthetic flat,synthetic_beta,Missing")
    const findings = (JSON.parse(workspaceExportJSON({ assessment: run, policies }, context)) as { result: { assessment: { findings: Array<{ recommendations?: unknown }> } } }).result.assessment.findings
    expect(findings[2]!.recommendations).toEqual([{ id: "1.10.1", title: "Synthetic grouped leaf" }])
    const plainCsv = workspaceExportCSV({ assessment: run, policies: pack }, context)
    expect(plainCsv).not.toContain("Recommendation ID")
    expect(plainCsv).toContain("Pack policy,Setting,Status")
    const plainFindings = (JSON.parse(workspaceExportJSON({ assessment: run, policies: pack }, context)) as { result: { assessment: { findings: object[] } } }).result.assessment.findings
    expect(plainFindings[0]).not.toHaveProperty("recommendations")
  })
})
