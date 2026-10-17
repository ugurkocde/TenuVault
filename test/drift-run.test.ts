import { describe, expect, it } from "vitest"
import { driftRunHeading, driftRunSteps } from "../src/shared/intune/drift-run"

describe("driftRunSteps", () => {
  it("marks the phase step current, earlier steps done and later steps waiting", () => {
    expect(driftRunSteps("checking").map(step => step.state)).toEqual(["current", "waiting", "waiting", "waiting"])
    expect(driftRunSteps("listing").map(step => step.state)).toEqual(["done", "current", "waiting", "waiting"])
    expect(driftRunSteps("comparing").map(step => step.state)).toEqual(["done", "done", "current", "waiting"])
    expect(driftRunSteps("history").map(step => step.state)).toEqual(["done", "done", "done", "current"])
  })

  it("shows every step done for a finished scan, whatever its last phase", () => {
    expect(driftRunSteps("history", true).map(step => step.state)).toEqual(["done", "done", "done", "done"])
    expect(driftRunSteps("comparing", true).map(step => step.state)).toEqual(["done", "done", "done", "done"])
  })

  it("keeps stable labels in scan order", () => {
    expect(driftRunSteps("checking").map(step => step.label)).toEqual([
      "Check the backups",
      "List backed-up policies",
      "Compare the backups",
      "Check revert history",
    ])
  })
})

describe("driftRunHeading", () => {
  it("names each phase", () => {
    expect(driftRunHeading("checking")).toBe("Checking the backups")
    expect(driftRunHeading("listing")).toBe("Listing backed-up policies")
    expect(driftRunHeading("comparing")).toBe("Comparing the backups")
    expect(driftRunHeading("history")).toBe("Checking the revert history")
  })

  it("names the finished scan loading its result", () => {
    expect(driftRunHeading("history", true)).toBe("Finishing the comparison")
  })
})
