import { describe, expect, it } from "vitest"
import { benchmarkDisplayName, deviatingFindingKeys, groupFindingsByPolicy, groupObservationsByValue, humanSettingLabel, policyDisplayName, statusMixText, trendSummaryText } from "../src/shared/frameworks/cis-display"
import type { Finding, Json, Observation } from "../src/shared/frameworks/policies"
import type { AssignmentEvidence } from "../src/shared/frameworks/evidence"

function finding(policyIndex: number, policyName: string, settingId: string, status: Finding["status"]): Finding {
  return { key: `${policyIndex}:${settingId}`, policyIndex, settingIndex: 0, policyName, settingId, status, recommended: null, observed: [] }
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
  it("groups by policyIndex preserving order and counts", () => {
    const groups = groupFindingsByPolicy([
      finding(0, "Fakebook Alpha", "fakebook_a", "Present"),
      finding(1, "Fakebook Beta", "fakebook_b", "Missing"),
      finding(0, "Fakebook Alpha", "fakebook_c", "Missing"),
      finding(0, "Fakebook Alpha", "fakebook_d", "Present"),
    ])
    expect(groups.map(g => g.policyIndex)).toEqual([0, 1])
    expect(groups.map(g => g.policyName)).toEqual(["Fakebook Alpha", "Fakebook Beta"])
    expect(groups[0]?.total).toBe(3)
    expect(groups[0]?.counts).toEqual({ Present: 2, Different: 0, Missing: 1, Review: 0 })
    expect(statusMixText(groups[0]!.counts)).toBe("2 present, 1 missing")
    expect(groupFindingsByPolicy([])).toEqual([])
  })

  it("keeps distinct policies with the same display name in separate groups", () => {
    const groups = groupFindingsByPolicy([
      finding(0, "Fakebook Shared", "fakebook_a", "Present"),
      finding(1, "Fakebook Shared", "fakebook_b", "Missing"),
      finding(0, "Fakebook Shared", "fakebook_c", "Present"),
      finding(2, "Fakebook Shared", "fakebook_d", "Review"),
    ])
    expect(groups).toHaveLength(3)
    expect(groups.map(g => g.policyIndex)).toEqual([0, 1, 2])
    expect(groups.map(g => g.policyName)).toEqual(["Fakebook Shared", "Fakebook Shared", "Fakebook Shared"])
    expect(groups[0]?.total).toBe(2)
    expect(groups[0]?.counts).toEqual({ Present: 2, Different: 0, Missing: 0, Review: 0 })
    expect(groups[1]?.total).toBe(1)
    expect(groups[1]?.counts).toEqual({ Present: 0, Different: 0, Missing: 1, Review: 0 })
    expect(groups[2]?.total).toBe(1)
    expect(groups[2]?.counts).toEqual({ Present: 0, Different: 0, Missing: 0, Review: 1 })
  })
})

describe("deviatingFindingKeys", () => {
  it("selects every Different and Missing finding and never Present or Review ones", () => {
    const findings = [finding(0, "A", "one", "Present"), finding(0, "A", "two", "Different"), finding(1, "B", "three", "Missing"), finding(1, "B", "four", "Review")]
    expect(deviatingFindingKeys(findings)).toEqual(["0:two", "1:three"])
    expect(deviatingFindingKeys([])).toEqual([])
  })
})

describe("groupObservationsByValue", () => {
  it("marks a grouped observation with extra children as matching the recommendation", () => {
    const child = (id: string): Json => ({ settingDefinitionId: id, choiceSettingValue: { value: `${id}_on`, children: [] } })
    const root = (children: Json[]): Json => ({ settingDefinitionId: "fakebook_payload", groupSettingCollectionValue: [{ children }] })
    const groups = groupObservationsByValue([{ policyId: "p1", policyName: "Tenant", value: root([child("one"), child("extra")]) }], root([child("one")]))
    expect(groups[0]?.matchesRecommended).toBe(true)
  })

  const assigned: AssignmentEvidence = { state: "configured", targets: [{ kind: "allDevices" }], limitations: [] }
  const unassigned: AssignmentEvidence = { state: "unassigned", targets: [], limitations: [] }

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

  it("keeps the same value with Assigned versus Unassigned targeting in separate groups", () => {
    const obs = (policyName: string, targeting: AssignmentEvidence): Observation => ({ policyId: policyName, policyName, value: { a: 2 } as Observation["value"], targeting })
    const groups = groupObservationsByValue([
      obs("Fakebook Assigned", assigned),
      obs("Fakebook Unassigned", unassigned),
    ], { a: 2 } as unknown as Finding["recommended"])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.policyNames).toEqual(["Fakebook Assigned"])
    expect(groups[1]?.policyNames).toEqual(["Fakebook Unassigned"])
    expect(groups[0]?.observations[0]?.targeting?.state).toBe("configured")
    expect(groups[1]?.observations[0]?.targeting?.state).toBe("unassigned")
  })

  it("merges the same value with the same targeting", () => {
    const obs = (policyName: string, targeting: AssignmentEvidence): Observation => ({ policyId: policyName, policyName, value: { a: 2 } as Observation["value"], targeting })
    const sameAssigned: AssignmentEvidence = { state: "configured", targets: [{ kind: "allDevices" }], limitations: [] }
    const groups = groupObservationsByValue([
      obs("Fakebook One", assigned),
      obs("Fakebook Two", sameAssigned),
    ], { a: 2 } as unknown as Finding["recommended"])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.policyNames).toEqual(["Fakebook One", "Fakebook Two"])
    expect(groups[0]?.observations).toHaveLength(2)
  })

  it("keeps the same value apart when targets or limitations differ", () => {
    const obs = (policyName: string, targeting: AssignmentEvidence): Observation => ({ policyId: policyName, policyName, value: { a: 2 } as Observation["value"], targeting })
    const groupTarget: AssignmentEvidence = { state: "review", targets: [{ kind: "group", groupId: "fakebook-group-1" }], limitations: ["Group membership and exclusion overlap require separate validation."] }
    const otherGroupTarget: AssignmentEvidence = { state: "review", targets: [{ kind: "group", groupId: "fakebook-group-2" }], limitations: ["Group membership and exclusion overlap require separate validation."] }
    const groups = groupObservationsByValue([
      obs("Fakebook One", groupTarget),
      obs("Fakebook Two", otherGroupTarget),
      obs("Fakebook Three", { state: "configured", targets: [{ kind: "allDevices" }], limitations: ["Assignment filter evaluation and device applicability are not observed."] }),
      obs("Fakebook Four", assigned),
    ], { a: 2 } as unknown as Finding["recommended"])
    expect(groups).toHaveLength(4)
  })
})

describe("trendSummaryText", () => {
  const formatDate = (value: string) => (value === "2026-10-14T00:00:00.000Z" ? "Oct 14, 2026" : value)

  it("names every level present in the latest point", () => {
    const text = trendSummaryText({ assessedAt: "2026-10-14T00:00:00.000Z", levels: [{ level: 1, passRate: 0.687 }, { level: 2, passRate: 0.41 }] }, 3, formatDate)
    expect(text).toBe("Trend: Level 1 68.7%, Level 2 41% on Oct 14, 2026, 3 assessments")
  })

  it("uses only the levels present in that point", () => {
    const text = trendSummaryText({ assessedAt: "2026-10-14T00:00:00.000Z", levels: [{ level: 2, passRate: 0.41 }] }, 1, formatDate)
    expect(text).toBe("Trend: Level 2 41% on Oct 14, 2026, first assessment")
  })

  it("returns not available when there is no point", () => {
    expect(trendSummaryText(undefined, 0, formatDate)).toBe("Trend: Not available yet")
    expect(trendSummaryText({ assessedAt: "2026-10-14T00:00:00.000Z", levels: [] }, 1, formatDate)).toBe("Trend: Not available yet")
  })
})
