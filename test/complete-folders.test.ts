import { afterEach, describe, expect, it } from "vitest"
import { completeFolders } from "../src/main/backup/engine"
import { registerTestTypes, testType } from "./helpers/backup-fixture"

const largeType = testType("AuthorizationPolicy", "synthetic", { volume: "large", listOnly: true, apiVersion: "v1.0", inventory: true })
let undo: (() => void) | undefined
afterEach(() => { undo?.(); undo = undefined })

const manifest = (extra: Record<string, unknown>) => ({
  Status: "CompletedWithWarnings", Failures: 1, Coverage: "Incomplete",
  Scope: { Included: ["AuthorizationPolicy", "DeviceCategories", "ScopeTags"], Excluded: [] },
  FailedTypes: ["ScopeTags"],
  Outcomes: [{ Folder: "AuthorizationPolicy", Outcome: "saved" }, { Folder: "DeviceCategories", Outcome: "saved" }, { Folder: "ScopeTags", Outcome: "failed" }],
  ...extra,
})

describe("completeFolders", () => {
  it("credits a large type only with its complete inventory", () => {
    undo = registerTestTypes([largeType])
    // An outcome that claims a large type without its index, for example in an inconsistent imported archive.
    expect([...completeFolders(manifest({}))]).toEqual(["DeviceCategories"])
    expect([...completeFolders(manifest({ LargeItems: { AuthorizationPolicy: { version: 1, count: 1, shards: 1, complete: false } } }))]).toEqual(["DeviceCategories"])
    expect([...completeFolders(manifest({ LargeItems: { AuthorizationPolicy: { version: 1, count: 1, shards: 1, complete: true } } }))].sort()).toEqual(["AuthorizationPolicy", "DeviceCategories"])
  })

  it("never credits a failed type", () => {
    expect(completeFolders(manifest({})).has("ScopeTags")).toBe(false)
  })
})
