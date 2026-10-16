import { describe, expect, it } from "vitest"
import { cisFlowSteps, cisStage, isKitPackReference, kitLevelForPolicy, packReferenceForPolicy, packSettingCount } from "../src/shared/frameworks/cis-flow"
import type { BaselinePolicy } from "../src/shared/frameworks/policies"
import type { KitPack } from "../src/shared/frameworks/cis-kit"

function policy(overrides: Partial<BaselinePolicy> = {}): BaselinePolicy {
  return { name: "Policy", platforms: "windows10", technologies: "mdm", description: "", settings: [], ...overrides }
}

describe("cisFlowSteps", () => {
  it("marks step 1 current before a benchmark pack is loaded", () => {
    expect(cisFlowSteps(false, false)).toEqual([
      { step: 1, label: "Load benchmark", state: "current" },
      { step: 2, label: "Compare with tenant", state: "upcoming" },
      { step: 3, label: "Review results", state: "upcoming" },
    ])
  })

  it("completes step 1 and makes step 2 current once a pack is loaded", () => {
    expect(cisFlowSteps(true, false).map((item) => item.state)).toEqual(["complete", "current", "upcoming"])
  })

  it("completes steps 1 and 2 and makes step 3 current after assessment", () => {
    expect(cisFlowSteps(true, true).map((item) => item.state)).toEqual(["complete", "complete", "current"])
  })

  it("does not complete step 1 for an assessment without a loaded pack, and makes step 3 current", () => {
    expect(cisFlowSteps(false, true).map((item) => item.state)).toEqual(["upcoming", "complete", "current"])
    expect(cisFlowSteps(false, true).filter((item) => item.state === "current")).toHaveLength(1)
    expect(cisFlowSteps(false, true)[0]?.state).not.toBe("complete")
    expect(cisFlowSteps(false, true)[2]?.state).toBe("current")
  })

  it("makes step 2 current while a run is active, even over an older assessment", () => {
    expect(cisFlowSteps(true, true, true).map((item) => item.state)).toEqual(["complete", "current", "upcoming"])
    expect(cisFlowSteps(false, true, true).map((item) => item.state)).toEqual(["upcoming", "current", "upcoming"])
    expect(cisFlowSteps(true, true, true).filter((item) => item.state === "current")).toHaveLength(1)
    expect(cisFlowSteps(true, true, true)[1]?.step).toBe(2)
  })

  it("makes step 2 current while a first run is active", () => {
    expect(cisFlowSteps(true, false, true).map((item) => item.state)).toEqual(["complete", "current", "upcoming"])
    expect(cisFlowSteps(false, false, true).map((item) => item.state)).toEqual(["upcoming", "current", "upcoming"])
  })
})

describe("cisStage", () => {
  it("shows setup before any run or assessment", () => {
    expect(cisStage({ hasRun: false, hasAssessment: false, setupRequested: false })).toBe("setup")
  })

  it("shows running while a first run or a run started from setup is active", () => {
    expect(cisStage({ hasRun: true, hasAssessment: false, setupRequested: false })).toBe("running")
    expect(cisStage({ hasRun: true, hasAssessment: false, setupRequested: true })).toBe("running")
    expect(cisStage({ hasRun: true, hasAssessment: true, setupRequested: true })).toBe("running")
  })

  it("keeps the shown results on screen while they are re-run", () => {
    expect(cisStage({ hasRun: true, hasAssessment: true, setupRequested: false })).toBe("results")
  })

  it("shows results when an assessment exists and setup was not requested", () => {
    expect(cisStage({ hasRun: false, hasAssessment: true, setupRequested: false })).toBe("results")
  })

  it("shows setup when the user asked for it, keeping the assessment", () => {
    expect(cisStage({ hasRun: false, hasAssessment: true, setupRequested: true })).toBe("setup")
  })

  it("returns to results once a run completes and clears the setup request", () => {
    expect(cisStage({ hasRun: false, hasAssessment: true, setupRequested: false })).toBe("results")
    expect(cisStage({ hasRun: false, hasAssessment: false, setupRequested: true })).toBe("setup")
  })

  it("returns a failed run to the stage it started from", () => {
    expect(cisStage({ hasRun: false, hasAssessment: true, setupRequested: true })).toBe("setup")
    expect(cisStage({ hasRun: false, hasAssessment: true, setupRequested: false })).toBe("results")
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
