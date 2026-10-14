import { describe, expect, it } from "vitest"
import { accumulateCisFindings, cisRunReceivedLabel, cisRunSteps, cisRunTallies, emptyCisRunAccumulation, resolveCisRunCompletion, type CisRunPack } from "../src/shared/frameworks/cis-run"
import type { BaselinePolicy, Finding } from "../src/shared/frameworks/policies"

function finding(key: string, status: Finding["status"] = "Present"): Finding {
  return {
    key,
    policyIndex: 0,
    settingIndex: 0,
    policyName: "Policy",
    settingId: key,
    status,
    recommended: {},
    observed: [],
  } as unknown as Finding
}

describe("accumulateCisFindings", () => {
  it("appends disjoint slices in arrival order and advances the cursor", () => {
    const first = accumulateCisFindings(emptyCisRunAccumulation(), [finding("a"), finding("b")], 2)
    expect(first.findings.map(item => item.key)).toEqual(["a", "b"])
    expect(first.since).toBe(2)
    const second = accumulateCisFindings(first, [finding("c")], 3)
    expect(second.findings.map(item => item.key)).toEqual(["a", "b", "c"])
    expect(second.since).toBe(3)
  })

  it("does not duplicate findings when a slice is polled again", () => {
    const slice = [finding("a"), finding("b")]
    const first = accumulateCisFindings(emptyCisRunAccumulation(), slice, 2)
    const repeated = accumulateCisFindings(first, slice, 2)
    expect(repeated.findings.map(item => item.key)).toEqual(["a", "b"])
    expect(repeated.since).toBe(2)
  })

  it("deduplicates only the overlap in a partially repeated slice", () => {
    const first = accumulateCisFindings(emptyCisRunAccumulation(), [finding("a"), finding("b")], 2)
    const next = accumulateCisFindings(first, [finding("b"), finding("c")], 3)
    expect(next.findings.map(item => item.key)).toEqual(["a", "b", "c"])
    expect(next.since).toBe(3)
  })

  it("advances the cursor on an empty slice without changing findings", () => {
    const first = accumulateCisFindings(emptyCisRunAccumulation(), [finding("a")], 1)
    const next = accumulateCisFindings(first, [], 4)
    expect(next.findings).toBe(first.findings)
    expect(next.since).toBe(4)
  })

  it("never moves the cursor backwards", () => {
    const first = accumulateCisFindings(emptyCisRunAccumulation(), [finding("a")], 5)
    expect(accumulateCisFindings(first, [], 2).since).toBe(5)
  })
})

describe("cisRunTallies", () => {
  it("counts each status from the findings received so far", () => {
    const tallies = cisRunTallies([finding("a", "Present"), finding("b", "Present"), finding("c", "Missing"), finding("d", "Different"), finding("e", "Review")])
    expect(tallies).toEqual({ Present: 2, Different: 1, Missing: 1, Review: 1 })
  })

  it("returns zero counts with no findings", () => {
    expect(cisRunTallies([])).toEqual({ Present: 0, Different: 0, Missing: 0, Review: 0 })
  })
})

describe("resolveCisRunCompletion", () => {
  const policy = (name: string) => ({ name, platforms: "windows10", technologies: "mdm", description: "", settings: [] }) as unknown as BaselinePolicy
  const captured: CisRunPack = { policies: [policy("A"), policy("B")], reference: "Fakebook OS 9.9.9 Level 1" }

  it("returns the captured pack when the completed job assessed it", () => {
    expect(resolveCisRunCompletion(captured, { reference: captured.reference, packPolicies: 2 })).toBe(captured)
  })

  it("discards the completion when the job used a different reference", () => {
    expect(resolveCisRunCompletion(captured, { reference: "Fakebook OS 9.9.9 Level 2", packPolicies: 2 })).toBeNull()
  })

  it("discards the completion when the job compared a different number of pack policies", () => {
    expect(resolveCisRunCompletion(captured, { reference: captured.reference, packPolicies: 1 })).toBeNull()
    expect(resolveCisRunCompletion(captured, { reference: captured.reference, packPolicies: 3 })).toBeNull()
  })
})

describe("cisRunReceivedLabel", () => {
  it("labels the received count as partial without a total", () => {
    expect(cisRunReceivedLabel(0)).toBe("0 findings received so far (partial results)")
    expect(cisRunReceivedLabel(1)).toBe("1 finding received so far (partial results)")
    expect(cisRunReceivedLabel(7)).toBe("7 findings received so far (partial results)")
    expect(cisRunReceivedLabel(7)).not.toContain(" of ")
  })
})

describe("cisRunSteps", () => {
  it("marks Connect current while connecting", () => {
    expect(cisRunSteps("connecting").map(step => step.state)).toEqual(["current", "waiting", "waiting", "waiting"])
  })

  it("marks reading progress through the step list", () => {
    expect(cisRunSteps("reading").map(step => step.state)).toEqual(["done", "current", "waiting", "waiting"])
    expect(cisRunSteps("comparing").map(step => step.state)).toEqual(["done", "done", "current", "waiting"])
    expect(cisRunSteps("saving").map(step => step.state)).toEqual(["done", "done", "done", "current"])
  })

  it("marks every step done when done and keeps the labels stable", () => {
    expect(cisRunSteps("done").map(step => step.state)).toEqual(["done", "done", "done", "done"])
    expect(cisRunSteps("done").map(step => step.label)).toEqual(["Connect to tenant", "Read tenant policies", "Compare with the benchmark", "Save assessment"])
  })
})
