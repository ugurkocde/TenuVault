import { describe, expect, it } from "vitest"
import { filterValidations, NO_VALIDATION_FILTER, validationFilterActive, validationFilterView, validationResultOf, type ValidationFilterItem } from "../src/shared/oib/validation-filter"
import type { OibPlatform, PolicyValidation } from "../src/shared/oib/types"

interface Item { name: string; tenant: string; platform: OibPlatform; status?: PolicyValidation["status"] }
const items: Item[] = [
  { name: "Win - OIB - ES - Defender Antivirus - D - AV Configuration - v3.6", tenant: "Win - OIB - ES - Defender Antivirus", platform: "windows", status: "compliant" },
  { name: "Win - OIB - SC - Microsoft Edge - D - Security - v3.7", tenant: "Edge baseline", platform: "windows", status: "drifted" },
  { name: "MacOS - OIB - Compliance - U - Device Security - v1.0", tenant: "macOS compliance", platform: "macos", status: "error" },
  { name: "MacOS - OIB - Custom - D - Login Window - v1.0", tenant: "Login window", platform: "macos", status: "unsupported" },
  { name: "Win - OIB - TP - Defender Firewall - D - Rules - v3.6", tenant: "Firewall rules", platform: "windows" },
]
const describe_ = (item: Item): ValidationFilterItem => ({ text: [item.name, item.tenant], platform: item.platform, status: item.status })
const names = (list: Item[]) => list.map(item => item.tenant)

describe("Policy Validation filter", () => {
  it("groups statuses without a setting-level result as not validated", () => {
    expect(validationResultOf("compliant")).toBe("compliant")
    expect(validationResultOf("unsupported")).toBe("other")
    expect(validationResultOf(undefined)).toBe("other")
  })

  it("shows every policy without a filter", () => {
    expect(validationFilterActive(NO_VALIDATION_FILTER)).toBe(false)
    expect(filterValidations(items, NO_VALIDATION_FILTER, describe_)).toEqual(items)
  })

  it("searches OIB and tenant policy names with every term", () => {
    expect(names(filterValidations(items, { ...NO_VALIDATION_FILTER, query: "defender" }, describe_))).toEqual(["Win - OIB - ES - Defender Antivirus", "Firewall rules"])
    expect(names(filterValidations(items, { ...NO_VALIDATION_FILTER, query: "EDGE baseline" }, describe_))).toEqual(["Edge baseline"])
  })

  it("combines result, platform and search", () => {
    expect(names(filterValidations(items, { ...NO_VALIDATION_FILTER, result: "other" }, describe_))).toEqual(["Login window", "Firewall rules"])
    expect(names(filterValidations(items, { query: "", result: "other", platform: "macos" }, describe_))).toEqual(["Login window"])
    expect(names(filterValidations(items, { query: "oib", result: "drifted", platform: "windows" }, describe_))).toEqual(["Edge baseline"])
  })

  it("counts results within the search and platform, and drops a platform no longer listed", () => {
    const view = validationFilterView(items, { query: "", result: "all", platform: "windows" }, describe_)
    expect(view.platforms).toEqual(["windows", "macos"])
    expect([view.count("all"), view.count("compliant"), view.count("drifted"), view.count("error"), view.count("other")]).toEqual([3, 1, 1, 0, 1])
    const stale = validationFilterView(items.filter(item => item.platform === "windows"), { query: "", result: "all", platform: "macos" }, describe_)
    expect(stale.effective.platform).toBe("")
    expect(stale.active).toBe(false)
    expect(stale.shown).toHaveLength(3)
  })
})
