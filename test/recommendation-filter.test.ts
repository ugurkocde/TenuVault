import { describe, expect, it } from "vitest"
import type { ManualItemView } from "../src/shared/frameworks/cis-manual"
import type { RecommendationResult } from "../src/shared/frameworks/cis-recommendations"
import { filterManualItems, filterRecommendationResults, searchRecommendationResults } from "../src/shared/frameworks/recommendation-filter"

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
    expect(filterRecommendationResults(results, "", "All")).toBe(results)
  })

  it("searches IDs, titles and setting IDs with every term", () => {
    expect(ids(searchRecommendationResults(results, "18.10"))).toEqual(["18.10.43.5", "18.10.9.1.1"])
    expect(ids(searchRecommendationResults(results, "CLOUD enabled"))).toEqual(["18.10.43.5"])
    expect(ids(searchRecommendationResults(results, "bitlocker"))).toEqual(["18.10.9.1.1"])
    expect(ids(searchRecommendationResults(results, "firewall domainprofile"))).toEqual(["45.1"])
  })

  it("combines search and result", () => {
    expect(ids(filterRecommendationResults(results, "", "Fail"))).toEqual(["18.10.9.1.1"])
    expect(ids(filterRecommendationResults(results, "18.10", "Pass"))).toEqual(["18.10.43.5"])
    expect(filterRecommendationResults(results, "firewall", "Pass")).toEqual([])
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
