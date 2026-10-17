import { describe, expect, it } from "vitest"
import {
  addTenantIds,
  hiddenSelectedCount,
  pruneSelection,
  removeTenantIds,
  toggleTenantId,
  visibleSelectionState,
} from "../src/portal/lib/tenant-selection"

describe("tenant selection", () => {
  it("toggles a tenant on and off without mutating the input", () => {
    const selected = [1, 2]
    expect(toggleTenantId(selected, 3)).toEqual([1, 2, 3])
    expect(toggleTenantId(selected, 1)).toEqual([2])
    expect(selected).toEqual([1, 2])
  })

  it("select all adds only the visible tenants and never duplicates", () => {
    expect(addTenantIds([1, 9], [1, 2, 3])).toEqual([1, 9, 2, 3])
    expect(addTenantIds([1, 2], [1, 2])).toEqual([1, 2])
  })

  it("clearing visible tenants keeps tenants hidden by search selected", () => {
    expect(removeTenantIds([1, 2, 9], [1, 2])).toEqual([9])
    expect(removeTenantIds([9], [1, 2])).toEqual([9])
  })

  it("reports none, some, and all from the visible tenants only", () => {
    expect(visibleSelectionState([9], [1, 2])).toBe("none")
    expect(visibleSelectionState([1, 9], [1, 2])).toBe("some")
    expect(visibleSelectionState([1, 2, 9], [1, 2])).toBe("all")
    expect(visibleSelectionState([1, 2], [])).toBe("none")
  })

  it("counts selected tenants the search hides", () => {
    expect(hiddenSelectedCount([1, 2, 9], [1, 2])).toBe(1)
    expect(hiddenSelectedCount([1, 2], [1, 2])).toBe(0)
    expect(hiddenSelectedCount([9], [])).toBe(1)
  })

  it("prunes tenants that no longer exist", () => {
    expect(pruneSelection([1, 2, 3], [3, 1])).toEqual([1, 3])
    expect(pruneSelection([1, 2], [])).toEqual([])
  })
})
