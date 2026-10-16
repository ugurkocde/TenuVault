import { describe, expect, it } from "vitest"
import { attachRecommendations } from "../src/shared/frameworks/cis-recommendations"
import { filterFindings, findingLevels, findingSearchText, hiddenSelectedKeys, NO_FINDING_FILTER } from "../src/shared/frameworks/finding-filter"
import { parsePolicies, type BaselinePolicy, type Finding } from "../src/shared/frameworks/policies"

const choice = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const flat = (id: string) => ({ settingInstance: { "@odata.type": choice, settingDefinitionId: id, choiceSettingValue: { value: `${id}_1`, children: [] } } })
const provenance = (level: string) => ({ schemaVersion: 1, benchmark: "synthetic-os", version: "9.9.9", level, sourceFile: "synthetic.json" })
const reference = "synthetic-os 9.9.9"
const policies: BaselinePolicy[] = attachRecommendations(parsePolicies([
  { name: `Defender - ${reference}`, platforms: "windows10", technologies: "mdm", description: "", provenance: provenance("Level 1"), settings: [flat("device_vendor_msft_policy_config_defender_allowcloudprotection"), flat("synthetic_beta")] },
  { name: `BitLocker - ${reference}`, platforms: "windows10", technologies: "mdm", description: "", provenance: provenance("Level 2"), settings: [flat("synthetic_bitlocker")] },
]), [
  { id: "18.10.1", title: "Ensure cloud protection is enabled", level: 1, settings: ["device_vendor_msft_policy_config_defender_allowcloudprotection"] },
  { id: "18.9.4", title: "Ensure drive encryption is required", level: 2, settings: ["synthetic_bitlocker"] },
])

const finding = (policyIndex: number, settingIndex: number, status: Finding["status"]): Finding => {
  const policy = policies[policyIndex]!
  const settingId = String((policy.settings[settingIndex]!.settingInstance as { settingDefinitionId: string }).settingDefinitionId)
  return { key: `${policyIndex}:${settingIndex}`, policyIndex, settingIndex, policyName: policy.name, settingId, status, recommended: null, observed: [] }
}
const findings = [finding(0, 0, "Missing"), finding(0, 1, "Present"), finding(1, 0, "Different")]
const text = (item: Finding) => findingSearchText(item, policies, reference)
const keys = (list: Finding[]) => list.map(item => item.key)

describe("Framework finding filter", () => {
  it("returns every finding without search or level", () => {
    expect(filterFindings(findings, policies, NO_FINDING_FILTER, text)).toBe(findings)
    expect(keys(filterFindings(findings, policies, { query: "  ", level: 0 }, text))).toEqual(["0:0", "0:1", "1:0"])
  })

  it("searches the setting ID, its readable name and the policy name", () => {
    expect(keys(filterFindings(findings, policies, { query: "allowcloudprotection", level: 0 }, text))).toEqual(["0:0"])
    expect(keys(filterFindings(findings, policies, { query: "BITLOCKER", level: 0 }, text))).toEqual(["1:0"])
    expect(keys(filterFindings(findings, policies, { query: "defender beta", level: 0 }, text))).toEqual(["0:1"])
  })

  it("searches recommendation IDs and titles", () => {
    expect(keys(filterFindings(findings, policies, { query: "18.10.1", level: 0 }, text))).toEqual(["0:0"])
    expect(keys(filterFindings(findings, policies, { query: "drive encryption", level: 0 }, text))).toEqual(["1:0"])
  })

  it("filters by CIS level, alone and with search", () => {
    expect(findingLevels(findings, policies)).toEqual([1, 2])
    expect(keys(filterFindings(findings, policies, { query: "", level: 2 }, text))).toEqual(["1:0"])
    expect(keys(filterFindings(findings, policies, { query: "defender", level: 1 }, text))).toEqual(["0:0", "0:1"])
    expect(keys(filterFindings(findings, policies, { query: "defender", level: 2 }, text))).toEqual([])
  })

  it("names selected findings that the search hides", () => {
    const shown = filterFindings(findings, policies, { query: "defender", level: 0 }, text)
    expect(hiddenSelectedKeys(new Set(["0:0", "1:0"]), shown)).toEqual(["1:0"])
    expect(hiddenSelectedKeys(new Set(["0:0"]), shown)).toEqual([])
  })

  it("counts findings of policies without a level as Level 1", () => {
    const plain = parsePolicies([{ name: "Pack policy", platforms: "windows10", technologies: "mdm", description: "", settings: [flat("synthetic_plain")] }])
    expect(findingLevels([{ ...findings[0]!, policyIndex: 0 }], plain)).toEqual([1])
  })
})
