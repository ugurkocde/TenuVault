import { afterEach, describe, expect, it } from "vitest"
import { accumulateCisFindings, CIS_STATUS_RETRY_DELAYS_MS, cisRunDisplayPhase, cisRunHeading, cisRunReceivedLabel, cisRunSteps, cisRunTallies, emptyCisRunAccumulation, pollCisStatus, resolveCisRunCompletion, type CisRunPack } from "../src/shared/frameworks/cis-run"
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

describe("pollCisStatus", () => {
  const waits: number[] = []
  const wait = async (ms: number) => { waits.push(ms) }
  afterEach(() => { waits.splice(0) })

  it("does not end a run on one failed status request: it re-polls with backoff", async () => {
    let calls = 0
    const read = async () => { calls += 1; if (calls === 1) throw new Error("Request failed (500)."); return { phase: "reading" } }
    await expect(pollCisStatus(read, { wait })).resolves.toEqual({ phase: "reading" })
    expect(calls).toBe(2)
    expect(waits).toEqual([CIS_STATUS_RETRY_DELAYS_MS[0]])
  })

  it("backs off further on each failure and reports the error after a few attempts", async () => {
    let calls = 0
    const read = async () => { calls += 1; throw new TypeError("Failed to fetch") }
    await expect(pollCisStatus(read, { wait })).rejects.toThrow("Failed to fetch")
    expect(calls).toBe(CIS_STATUS_RETRY_DELAYS_MS.length + 1)
    expect(waits).toEqual([...CIS_STATUS_RETRY_DELAYS_MS])
    expect([...CIS_STATUS_RETRY_DELAYS_MS]).toEqual([...CIS_STATUS_RETRY_DELAYS_MS].sort((a, b) => a - b))
  })

  it("fails at once on an answer that will not change, and stops retrying for a run no longer followed", async () => {
    const gone = Object.assign(new Error("Assessment job not found."), { status: 404 })
    let calls = 0
    await expect(pollCisStatus(async () => { calls += 1; throw gone }, { wait, retryable: error => (error as { status?: number }).status !== 404 })).rejects.toBe(gone)
    expect(calls).toBe(1)
    calls = 0
    await expect(pollCisStatus(async () => { calls += 1; throw new Error("offline") }, { wait, current: () => false })).rejects.toThrow("offline")
    expect(calls).toBe(1)
    expect(waits).toEqual([])
  })
})

describe("run screen phase and heading", () => {
  it("shows connecting until the tenant policy list arrives, not 0 of 0 policies read", () => {
    expect(cisRunDisplayPhase({ phase: "reading", total: 0 })).toBe("connecting")
    expect(cisRunDisplayPhase({ phase: "reading", total: 3 })).toBe("reading")
    expect(cisRunDisplayPhase({ phase: "comparing", total: 0 })).toBe("comparing")
  })

  it("names the current phase instead of a fixed in-progress heading", () => {
    expect(cisRunHeading("connecting")).toBe("Connecting to the tenant")
    expect(cisRunHeading("reading")).toBe("Reading tenant policies")
    expect(cisRunHeading("comparing")).toBe("Comparing with the benchmark")
    expect(cisRunHeading("saving")).toBe("Saving the assessment")
    expect(cisRunHeading("done")).toBe("Assessment complete")
    expect(cisRunHeading("saving", true)).toBe("Re-running assessment: saving the assessment")
  })
})
