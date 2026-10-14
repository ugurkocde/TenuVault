import { describe, expect, it } from "vitest"
import { benchmarkDisplayName, groupFindingsByPolicy, groupObservationsByValue, humanSettingLabel, policyDisplayName, statusMixText } from "../src/shared/frameworks/cis-display"
import type { Finding, Observation } from "../src/shared/frameworks/policies"

function finding(policyName: string, settingId: string, status: Finding["status"]): Finding {
  return { key: `${policyName}:${settingId}`, policyIndex: 0, settingIndex: 0, policyName, settingId, status, recommended: null, observed: [] }
}

describe("benchmarkDisplayName", () => {
  it("prettifies benchmark ids", () => {
    expect(benchmarkDisplayName("intune-windows11")).toBe("Windows11")
    expect(benchmarkDisplayName("fakebook-os")).toBe("Fakebook Os")
    expect(benchmarkDisplayName("intune-fakebook-os")).toBe("Fakebook Os")
    expect(benchmarkDisplayName("fakebook")).toBe("Fakebook")
    expect(benchmarkDisplayName("intune")).toBe("Intune")
    expect(benchmarkDisplayName("")).toBe("")
  })
})

describe("humanSettingLabel", () => {
  it("strips prefixes and humanizes", () => {
    expect(humanSettingLabel("device_vendor_msft_policy_config_fakebook_minimum_length")).toBe("Fakebook minimum length")
    expect(humanSettingLabel("device_vendor_msft_policy_fakebook_title")).toBe("Fakebook title")
    expect(humanSettingLabel("custom_fakebook_thing")).toBe("Custom fakebook thing")
  })
})

describe("policyDisplayName", () => {
  it("trims a trailing reference suffix only when it matches", () => {
    expect(policyDisplayName("Fakebook Alpha fakebook-os 9.9.9 Level 1", "fakebook-os 9.9.9 Level 1")).toBe("Fakebook Alpha")
    expect(policyDisplayName("Fakebook Alpha", "fakebook-os 9.9.9 Level 1")).toBe("Fakebook Alpha")
    expect(policyDisplayName("Fakebook Alpha", "")).toBe("Fakebook Alpha")
    expect(policyDisplayName("fakebook-os 9.9.9 Level 1", "fakebook-os 9.9.9 Level 1")).toBe("fakebook-os 9.9.9 Level 1")
  })
})

describe("groupFindingsByPolicy", () => {
  it("groups by policy preserving order and counts", () => {
    const groups = groupFindingsByPolicy([
      finding("Fakebook Alpha", "fakebook_a", "Present"),
      finding("Fakebook Beta", "fakebook_b", "Missing"),
      finding("Fakebook Alpha", "fakebook_c", "Missing"),
      finding("Fakebook Alpha", "fakebook_d", "Present"),
    ])
    expect(groups.map(g => g.policyName)).toEqual(["Fakebook Alpha", "Fakebook Beta"])
    expect(groups[0]?.total).toBe(3)
    expect(groups[0]?.counts).toEqual({ Present: 2, Different: 0, Missing: 1, Review: 0 })
    expect(statusMixText(groups[0]!.counts)).toBe("2 present, 1 missing")
    expect(groupFindingsByPolicy([])).toEqual([])
  })
})

describe("groupObservationsByValue", () => {
  it("groups identical comparable values and marks matches", () => {
    const recommended = { settingDefinitionId: "fakebook_mode", choiceSettingValue: { value: "fakebook_mode_1" } } as unknown as Finding["recommended"]
    const obs = (policyName: string, value: unknown): Observation => ({ policyId: policyName, policyName, value: value as Observation["value"] })
    const groups = groupObservationsByValue([
      obs("Fakebook One", { b: 1, a: 2 }),
      obs("Fakebook Two", { a: 2, b: 1 }),
      obs("Fakebook Three", { a: 9 }),
    ], { a: 2, b: 1 } as unknown as Finding["recommended"])
    expect(recommended).toBeDefined()
    expect(groups).toHaveLength(2)
    expect(groups[0]?.policyNames).toEqual(["Fakebook One", "Fakebook Two"])
    expect(groups[0]?.matchesRecommended).toBe(true)
    expect(groups[1]?.matchesRecommended).toBe(false)
    expect(groupObservationsByValue([], null)).toEqual([])
  })
})
