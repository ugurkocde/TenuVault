import { describe, expect, it } from "vitest"
import { attachRecommendations, definitionIds, packRecommendations, recommendationLabel, recommendationResults, recommendationsForFinding, recommendationTotals } from "../src/shared/frameworks/cis-recommendations"
import { cisReadiness } from "../src/shared/frameworks/cis-readiness"
import { comparePolicies, definitionStatus, parsePolicies, remediationPayload, type Assessment, type LandscapePolicy } from "../src/shared/frameworks/policies"
import { cisReadinessCsv, cisReadinessJson } from "../src/renderer/features/shared/governance-export"
import { workspaceExportCSV, workspaceExportJSON } from "../src/shared/compliance/export"

const choice = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const group = "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance"
const leaf = (id: string, value: string) => ({ "@odata.type": choice, settingDefinitionId: `synthetic_payload_${id}`, choiceSettingValue: { value: `synthetic_payload_${id}_${value}`, children: [] } })
const flat = (id: string, value = "on") => ({ settingInstance: { "@odata.type": choice, settingDefinitionId: id, choiceSettingValue: { value: `${id}_${value}`, children: [] } } })
const payload = (children: object[]) => ({ settingInstance: { "@odata.type": group, settingDefinitionId: "synthetic_payload", groupSettingCollectionValue: [{ children }] } })
const provenance = { schemaVersion: 1, benchmark: "synthetic-os", version: "9.9.9", level: "Level 1", sourceFile: "synthetic.json" }
const pack = parsePolicies([
  { name: "Synthetic flat", platforms: "windows10", technologies: "mdm", description: "", provenance, settings: [flat("synthetic_alpha"), flat("synthetic_beta")] },
  { name: "Synthetic payload", platforms: "macOS", technologies: "mdm", description: "", provenance, settings: [payload([leaf("one", "on"), leaf("two", "on"), leaf("three", "on")])] },
])
const recommendations = [
  { id: "1.1.1", title: "Synthetic leaf one", level: 1 as const, settings: ["synthetic_payload_one"] },
  { id: "1.1.2", title: "Synthetic leaf two", level: 1 as const, settings: ["synthetic_payload_two"] },
  { id: "1.1.10", title: "Synthetic leaf three and alpha", level: 1 as const, settings: ["synthetic_payload_three", "synthetic_alpha"] },
  { id: "1.2.1", title: "Synthetic beta", level: 1 as const, settings: ["synthetic_beta"] },
  { id: "1.3.1", title: "Synthetic not in pack", level: 1 as const, settings: ["synthetic_missing"] },
]
const policies = attachRecommendations(pack, recommendations)
const tenantPolicy = (id: string, platforms: string, settings: object[]): LandscapePolicy => ({ ...parsePolicies({ name: `Tenant ${id}`, platforms, technologies: "mdm", description: "", settings })[0]!, id })
// Two tenant payloads each hold part of the payload: the root finding is Different, but leaf by leaf
// one and three hold the recommended value, two differs, and beta is absent.
const tenant = [
  tenantPolicy("11111111-1111-1111-1111-111111111111", "macOS", [payload([leaf("one", "on"), leaf("two", "off"), leaf("extra", "kept")])]),
  tenantPolicy("22222222-2222-2222-2222-222222222222", "macOS", [payload([leaf("three", "on"), leaf("one", "on")])]),
  tenantPolicy("33333333-3333-3333-3333-333333333333", "windows10", [flat("synthetic_alpha")]),
]
const assess = (landscape: LandscapePolicy[]): Assessment => ({ runId: "run-1", tenantId: "11111111-1111-1111-1111-111111111111", frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", assessedAt: "2026-10-15T10:00:00Z", policyCount: landscape.length, findings: comparePolicies(policies, landscape) })

describe("pack recommendations", () => {
  it("lists every definition of a root, including grouped leaf children", () => {
    expect(definitionIds(pack[1]!.settings[0]!.settingInstance)).toEqual(["synthetic_payload", "synthetic_payload_one", "synthetic_payload_two", "synthetic_payload_three"])
  })

  it("attaches recommendations to the policies holding their settings, keeps unmatched ones on the first, and survives parsing", () => {
    expect(policies[0]!.recommendations?.map(item => item.id)).toEqual(["1.1.10", "1.2.1", "1.3.1"])
    expect(policies[1]!.recommendations?.map(item => item.id)).toEqual(["1.1.1", "1.1.2", "1.1.10"])
    expect(packRecommendations(policies).map(item => item.id)).toEqual(["1.1.10", "1.2.1", "1.3.1", "1.1.1", "1.1.2"])
    expect(parsePolicies(JSON.parse(JSON.stringify(policies)))).toEqual(policies)
    expect(() => parsePolicies([{ ...policies[0], recommendations: [{ id: "x", title: "t", level: 1, settings: ["a"] }] }])).toThrow("dotted numeric")
    expect(remediationPayload(policies[0]!, policies[0]!.settings, "synthetic")).not.toHaveProperty("recommendations")
  })

  it("attaches to each finding the recommendations of its root or leaf children", () => {
    expect(recommendationLabel(recommendationsForFinding(policies, { policyIndex: 0, settingIndex: 1 }))).toBe("1.2.1 Synthetic beta")
    expect(recommendationLabel(recommendationsForFinding(policies, { policyIndex: 1, settingIndex: 0 }))).toBe("1.1.1 Synthetic leaf one; 1.1.2 Synthetic leaf two; 1.1.10 Synthetic leaf three and alpha")
    expect(recommendationsForFinding(pack, { policyIndex: 0, settingIndex: 0 })).toEqual([])
  })

  it("judges one leaf across every tenant policy holding the root, with the comparison leaf rule", () => {
    const recommended = comparePolicies(pack, [])[2]!.recommended
    const values = tenant.slice(0, 2).map(policy => comparePolicies(pack, [policy])[2]!.observed[0]!.value)
    expect(definitionStatus(recommended, values, "synthetic_payload_one")).toBe("Present")
    expect(definitionStatus(recommended, values, "synthetic_payload_two")).toBe("Different")
    expect(definitionStatus(recommended, [values[1]!], "synthetic_payload_two")).toBe("Missing")
    expect(definitionStatus(recommended, values, "synthetic_payload_three")).toBe("Present")
    expect(definitionStatus(recommended, values, "synthetic_payload")).toBe("Different")
    expect(definitionStatus(recommended, [], "synthetic_payload")).toBe("Missing")
    expect(definitionStatus(recommended, values, "synthetic_payload_extra")).toBeNull()
  })

  it("passes a recommendation only when every mapped leaf passes, even when its grouped root finding is Different", () => {
    const run = assess(tenant)
    expect(run.findings.map(finding => finding.status)).toEqual(["Present", "Missing", "Different"])
    expect(recommendationResults(run, policies).map(item => [item.id, item.result, item.settings.map(setting => `${setting.id} ${setting.status}`).join(", ")])).toEqual([
      ["1.1.1", "Pass", "synthetic_payload_one Present"],
      ["1.1.2", "Fail", "synthetic_payload_two Different"],
      ["1.1.10", "Pass", "synthetic_payload_three Present, synthetic_alpha Present"],
      ["1.2.1", "Fail", "synthetic_beta Missing"],
      ["1.3.1", "Not assessed", "synthetic_missing Unmapped"],
    ])
    const conflicting = [...tenant, tenantPolicy("44444444-4444-4444-4444-444444444444", "macOS", [payload([leaf("one", "off")])])]
    expect(recommendationResults(assess(conflicting), policies).find(item => item.id === "1.1.1")?.result).toBe("Fail")
    expect(recommendationResults(assess([]), policies).find(item => item.id === "1.1.1")?.settings).toEqual([{ id: "synthetic_payload_one", status: "Missing" }])
    expect(recommendationResults(run, pack)).toEqual([])
  })

  it("adds recommendation totals and rows to readiness and its exports, and leaves packs without them unchanged", () => {
    const run = assess(tenant)
    const summary = cisReadiness(run, policies)
    expect(recommendationTotals(summary.levels[0]!.recommendations)).toEqual({ passed: 2, failed: 2, review: 0, notAssessed: 1 })
    const csv = cisReadinessCsv(summary)
    expect(csv.split("\r\n")[0]).toMatch(/Exceptions,Mapped settings$/)
    expect(csv).toContain("synthetic-os,9.9.9,1,,,,,,,,,,,,Fail,Recommendation,1.1.2,Synthetic leaf two,,,,synthetic_payload_two Different")
    const json = JSON.parse(cisReadinessJson(summary, null, "2026-10-15T10:00:00Z")) as { levels: Array<{ recommendations?: Array<{ id: string }>; recommendationTotals?: unknown }> }
    expect(json.levels[0]!.recommendationTotals).toEqual({ passed: 2, failed: 2, review: 0, notAssessed: 1 })
    expect(json.levels[0]!.recommendations?.[3]).toEqual({ id: "1.2.1", title: "Synthetic beta", level: 1, result: "Fail", settings: [{ id: "synthetic_beta", status: "Missing" }] })
    const plain = cisReadiness(run, pack)
    expect(plain.levels[0]!.recommendations).toEqual([])
    const plainCsv = cisReadinessCsv(plain)
    expect(plainCsv).not.toContain("Recommendation")
    expect(plainCsv.split("\r\n")[0]).toMatch(/Exceptions$/)
    expect(JSON.parse(cisReadinessJson(plain, null, "2026-10-15T10:00:00Z")).levels[0]).not.toHaveProperty("recommendations")
  })

  it("adds recommendation ids and titles to the findings exports only for packs that list recommendations", () => {
    const context = { exportedAt: "2026-10-15T10:00:00Z", tenantName: "Synthetic" }
    const run = assess(tenant)
    const csv = workspaceExportCSV({ assessment: run, policies }, context)
    expect(csv).toContain("Recommendation ID,Recommendation title,Pack policy,Setting")
    expect(csv).toContain("1.2.1,Synthetic beta,Synthetic flat,synthetic_beta,Missing")
    const findings = (JSON.parse(workspaceExportJSON({ assessment: run, policies }, context)) as { result: { assessment: { findings: Array<{ recommendations?: unknown }> } } }).result.assessment.findings
    expect(findings[1]!.recommendations).toEqual([{ id: "1.2.1", title: "Synthetic beta" }])
    const plainCsv = workspaceExportCSV({ assessment: run, policies: pack }, context)
    expect(plainCsv).not.toContain("Recommendation ID")
    expect(plainCsv).toContain("Pack policy,Setting,Status")
    const plainFindings = (JSON.parse(workspaceExportJSON({ assessment: run, policies: pack }, context)) as { result: { assessment: { findings: object[] } } }).result.assessment.findings
    expect(plainFindings[0]).not.toHaveProperty("recommendations")
  })
})
