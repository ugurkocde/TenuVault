import { describe, expect, it } from "vitest"
import type { ManualItemView } from "../src/shared/frameworks/cis-manual"
import type { RecommendationResult } from "../src/shared/frameworks/cis-recommendations"
import { filterManualItems, recommendationResultView, searchRecommendationResults } from "../src/shared/frameworks/recommendation-filter"

const result = (id: string, title: string, state: RecommendationResult["result"], settings: string[]): RecommendationResult =>
  ({ id, title, level: 1, result: state, settings: settings.map(setting => ({ id: setting, status: "Present", findingKeys: [] })), findingKeys: [] })
const results = [
  // Synthetic recommendations only: no benchmark text belongs in this repository.
  result("7.1.4.2", "Synthetic cloud check is enabled", "Pass", ["synthetic_policy_cloudcheck"]),
  result("7.1.2.1.1", "Synthetic startup check asks for a second factor", "Fail", ["synthetic_policy_startup_secondfactor"]),
  result("9.1", "Synthetic domain wall is on", "Not assessed", ["synthetic_wall_domainprofile_on"]),
]
const ids = (list: Array<{ id?: string; identifier?: string }>) => list.map(item => item.id ?? item.identifier)

describe("CIS recommendation result filter", () => {
  it("returns the same list without a search", () => {
    expect(searchRecommendationResults(results, "  ")).toBe(results)
    expect(recommendationResultView(results, "", "All").shown).toBe(results)
  })

  it("searches IDs, titles and setting IDs with every term", () => {
    expect(ids(searchRecommendationResults(results, "7.1"))).toEqual(["7.1.4.2", "7.1.2.1.1"])
    // "check" is in two titles and "enabled" in one: only an item with every term matches.
    expect(ids(searchRecommendationResults(results, "CHECK enabled"))).toEqual(["7.1.4.2"])
    expect(ids(searchRecommendationResults(results, "secondfactor"))).toEqual(["7.1.2.1.1"])
    expect(ids(searchRecommendationResults(results, "wall domainprofile"))).toEqual(["9.1"])
  })

  it("combines search and result", () => {
    expect(ids(recommendationResultView(results, "", "Fail").shown)).toEqual(["7.1.2.1.1"])
    expect(ids(recommendationResultView(results, "7.1", "Pass").shown)).toEqual(["7.1.4.2"])
    expect(recommendationResultView(results, "wall", "Pass").shown).toEqual([])
  })
})

describe("CIS recommendation result chips", () => {
  it("offers Review only when the Level has Review items, with counts that follow the search", () => {
    expect(recommendationResultView(results, "7.1", "All").options.map(option => `${option.value} ${option.count}`)).toEqual(["All 2", "Pass 1", "Fail 1", "Not assessed 0"])
    const withReview = [...results, result("1.1", "Synthetic reviewed setting", "Review", ["synthetic_review"])]
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
    manual("1.1.1", { title: "Synthetic default security check is off", audit: "Review the synthetic admin page" }),
    manual("2.4", { title: "Synthetic guest access is limited", remediation: "Set synthetic guest limits" }),
    manual("3.2", { hasText: false }),
  ]

  it("searches identifier, title and benchmark text", () => {
    expect(filterManualItems(items, "")).toBe(items)
    expect(ids(filterManualItems(items, "guest"))).toEqual(["2.4"])
    expect(ids(filterManualItems(items, "synthetic admin"))).toEqual(["1.1.1"])
    expect(ids(filterManualItems(items, "3.2"))).toEqual(["3.2"])
    expect(filterManualItems(items, "nothing like this")).toEqual([])
  })
})
