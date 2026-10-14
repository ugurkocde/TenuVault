import { describe, expect, it } from "vitest"
import { cisFlowSteps, isKitPackReference, kitLevelForPolicy, packReferenceForPolicy, packSettingCount } from "../src/shared/frameworks/cis-flow"
import type { BaselinePolicy } from "../src/shared/frameworks/policies"
import type { KitPack } from "../src/shared/frameworks/cis-kit"

function policy(overrides: Partial<BaselinePolicy> = {}): BaselinePolicy {
  return { name: "Policy", platforms: "windows10", technologies: "mdm", description: "", settings: [], ...overrides }
}

describe("cisFlowSteps", () => {
  it("marks step 1 current before a kit is converted", () => {
    expect(cisFlowSteps(false, false)).toEqual([
      { step: 1, label: "Import kit", state: "current" },
      { step: 2, label: "Choose level and compare", state: "upcoming" },
      { step: 3, label: "Review results", state: "upcoming" },
    ])
  })

  it("completes step 1 and makes step 2 current after conversion", () => {
    expect(cisFlowSteps(true, false).map((item) => item.state)).toEqual(["complete", "current", "upcoming"])
  })

  it("completes steps 1 and 2 and makes step 3 current after assessment", () => {
    expect(cisFlowSteps(true, true).map((item) => item.state)).toEqual(["complete", "complete", "current"])
  })

  it("shows a single current step when an assessment exists without conversion state", () => {
    expect(cisFlowSteps(false, true).map((item) => item.state)).toEqual(["complete", "complete", "current"])
    expect(cisFlowSteps(false, true).filter((item) => item.state === "current")).toHaveLength(1)
  })
})

describe("packSettingCount", () => {
  it("sums root settings across policies", () => {
    const pack = { policies: [policy({ settings: [{}, {}] as BaselinePolicy["settings"] }), policy({ settings: [{}] as BaselinePolicy["settings"] })] } as unknown as Pick<KitPack, "policies">
    expect(packSettingCount(pack)).toBe(3)
  })

  it("returns zero for an empty pack", () => {
    expect(packSettingCount({ policies: [] })).toBe(0)
  })
})

describe("kitLevelForPolicy", () => {
  it("reads Level 2 from provenance", () => {
    expect(kitLevelForPolicy(policy({ provenance: { level: "Level 2" } }))).toBe(2)
  })

  it("defaults to Level 1 without provenance", () => {
    expect(kitLevelForPolicy(policy())).toBe(1)
    expect(kitLevelForPolicy(undefined)).toBe(1)
  })
})

describe("isKitPackReference", () => {
  it("matches a converted pack reference", () => {
    expect(isKitPackReference("bench 1.0.0 Level 1", ["bench 1.0.0 Level 1"], [])).toBe(true)
  })

  it("matches the provenance reference after a workspace reload", () => {
    const loaded = policy({ provenance: { benchmark: "bench", version: "1.0.0", level: "Level 2" } })
    expect(packReferenceForPolicy(loaded)).toBe("bench 1.0.0 Level 2")
    expect(isKitPackReference("bench 1.0.0 Level 2", [], [loaded])).toBe(true)
  })

  it("does not match a manual reference", () => {
    expect(isKitPackReference("approved baseline rev 3", ["bench 1.0.0 Level 1"], [policy()])).toBe(false)
    expect(isKitPackReference("", ["bench 1.0.0 Level 1"], [])).toBe(false)
  })
})
