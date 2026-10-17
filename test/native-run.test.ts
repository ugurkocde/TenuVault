import { describe, expect, it } from "vitest"
import { nativeRunHeading, nativeRunSteps } from "../src/shared/compliance/native-run"

describe("nativeRunSteps", () => {
  it("marks the phase step current, earlier steps done and later steps waiting", () => {
    expect(nativeRunSteps("connecting").map(step => step.state)).toEqual(["current", "waiting", "waiting", "waiting"])
    expect(nativeRunSteps("collecting").map(step => step.state)).toEqual(["done", "current", "waiting", "waiting"])
    expect(nativeRunSteps("evaluating").map(step => step.state)).toEqual(["done", "done", "current", "waiting"])
    expect(nativeRunSteps("saving").map(step => step.state)).toEqual(["done", "done", "done", "current"])
  })

  it("shows every step done for a finished comparison, whatever its last phase", () => {
    expect(nativeRunSteps("saving", true).map(step => step.state)).toEqual(["done", "done", "done", "done"])
    expect(nativeRunSteps("collecting", true).map(step => step.state)).toEqual(["done", "done", "done", "done"])
  })

  it("keeps stable labels in comparison order", () => {
    expect(nativeRunSteps("connecting").map(step => step.label)).toEqual([
      "Connect to tenant",
      "Read tenant policies",
      "Compare with the framework",
      "Save comparison",
    ])
  })
})

describe("nativeRunHeading", () => {
  it("names each phase", () => {
    expect(nativeRunHeading("connecting")).toBe("Connecting to the tenant")
    expect(nativeRunHeading("collecting")).toBe("Reading tenant policies")
    expect(nativeRunHeading("evaluating")).toBe("Comparing with the framework")
    expect(nativeRunHeading("saving")).toBe("Saving the comparison")
  })

  it("names the finished comparison loading its result", () => {
    expect(nativeRunHeading("saving", true)).toBe("Finishing the comparison")
  })
})
