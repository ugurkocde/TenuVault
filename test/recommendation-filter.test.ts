import { describe, expect, it } from "vitest"
import type { ManualItemView } from "../src/shared/frameworks/cis-manual"
import type { RecommendationResult } from "../src/shared/frameworks/cis-recommendations"
import { filterManualItems, recommendationResultView, searchRecommendationResults } from "../src/shared/frameworks/recommendation-filter"

const result = (id: string, title: string, state: RecommendationResult["result"], settings: string[]): RecommendationResult =>
  ({ id, title, level: 1, result: state, settings: settings.map(setting => ({ id: setting, status: "Present", findingKeys: [] })), findingKeys: [] })
const results = [
  result("18.10.43.5", "Ensure 'Turn on cloud protection' is set to 'Enabled'", "Pass", ["device_vendor_msft_policy_config_defender_allowcloudprotection"]),
  result("18.10.9.1.1", "Ensure 'Require additional authentication at startup' is set to 'Enabled'", "Fail", ["device_vendor_msft_policy_config_bitlocker_requireadditionalauthentication"]),
  result("45.1", "Ensure 'Enable Domain Network Firewall' is set to 'True'", "Not assessed", ["vendor_msft_firewall_mdmstore_domainprofile_enablefirewall"]),
]
const ids = (list: Array<{ id?: string; identifier?: string }>) => list.map(item => item.id ?? item.identifier)

describe("CIS recommendation result filter", () => {
  it("returns the same list without a search", () => {
    expect(searchRecommendationResults(results, "  ")).toBe(results)
    expect(recommendationResultView(results, "", "All").shown).toBe(results)
  })

  it("searches IDs, titles and setting IDs with every term", () => {
    expect(ids(searchRecommendationResults(results, "18.10"))).toEqual(["18.10.43.5", "18.10.9.1.1"])
    expect(ids(searchRecommendationResults(results, "CLOUD enabled"))).toEqual(["18.10.43.5"])
    expect(ids(searchRecommendationResults(results, "bitlocker"))).toEqual(["18.10.9.1.1"])
    expect(ids(searchRecommendationResults(results, "firewall domainprofile"))).toEqual(["45.1"])
  })

  it("combines search and result", () => {
    expect(ids(recommendationResultView(results, "", "Fail").shown)).toEqual(["18.10.9.1.1"])
    expect(ids(recommendationResultView(results, "18.10", "Pass").shown)).toEqual(["18.10.43.5"])
    expect(recommendationResultView(results, "firewall", "Pass").shown).toEqual([])
  })
})

describe("CIS recommendation result chips", () => {
  it("offers Review only when the Level has Review items, with counts that follow the search", () => {
    expect(recommendationResultView(results, "18.10", "All").options.map(option => `${option.value} ${option.count}`)).toEqual(["All 2", "Pass 1", "Fail 1", "Not assessed 0"])
    const withReview = [...results, result("1.1", "Ensure a reviewed setting", "Review", ["synthetic_review"])]
    expect(recommendationResultView(withReview, "", "Review").options.map(option => option.value)).toContain("Review")
    expect(ids(recommendationResultView(withReview, "", "Review").shown)).toEqual(["1.1"])
  })

  it("falls back to All when the selected chip is no longer offered", () => {
    const view = recommendationResultView(results, "", "Review")
    expect(view.result).toBe("All")
    expect(view.shown).toBe(results)
    expect(view.filtering).toBe(false)
  })
})

describe("CIS manual item filter", () => {
  const manual = (identifier: string, extra: Partial<ManualItemView>): ManualItemView =>
    ({ identifier, level: 1, hasText: true, fallback: "See the benchmark", fallbackUrl: "https://www.cisecurity.org/cis-benchmarks", state: "Manual", ...extra })
  const items = [
    manual("1.1.1", { title: "Ensure Security Defaults is disabled", audit: "Review the Entra admin center" }),
    manual("2.4", { title: "Ensure guest access is restricted", remediation: "Set guest user access restrictions" }),
    manual("3.2", { hasText: false }),
  ]

  it("searches identifier, title and benchmark text", () => {
    expect(filterManualItems(items, "")).toBe(items)
    expect(ids(filterManualItems(items, "guest"))).toEqual(["2.4"])
    expect(ids(filterManualItems(items, "entra admin"))).toEqual(["1.1.1"])
    expect(ids(filterManualItems(items, "3.2"))).toEqual(["3.2"])
    expect(filterManualItems(items, "nothing like this")).toEqual([])
  })
})
