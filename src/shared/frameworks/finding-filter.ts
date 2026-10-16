import { humanSettingLabel, policyDisplayName } from "./cis-display"
import { kitLevelForPolicy } from "./cis-flow"
import type { KitLevel } from "./cis-kit"
import { recommendationsForFinding } from "./cis-recommendations"
import type { BaselinePolicy, Finding } from "./policies"
import { matchesTerms, searchTerms } from "../search"

/** Narrowing framework findings by search text and CIS level. The status chips apply on top. */
export interface FindingFilter {
  query: string
  /** A CIS level, or 0 for every level. */
  level: KitLevel | 0
}

export const NO_FINDING_FILTER: FindingFilter = { query: "", level: 0 }

/** The lowercased text a search matches: setting ID and readable name, policy name, and recommendation IDs and titles. */
export function findingSearchText(finding: Finding, policies: BaselinePolicy[], reference?: string): string {
  const recommendations = recommendationsForFinding(policies, finding).flatMap(recommendation => [recommendation.id, recommendation.title])
  return [finding.settingId, humanSettingLabel(finding.settingId), finding.policyName, policyDisplayName(finding.policyName, reference), ...recommendations].join("\n").toLowerCase()
}

/** The CIS levels the findings belong to, lowest first. Packs without levels count as Level 1. */
export function findingLevels(findings: Finding[], policies: BaselinePolicy[]): KitLevel[] {
  return [...new Set(findings.map(finding => kitLevelForPolicy(policies[finding.policyIndex])))].sort((a, b) => a - b)
}

/** The findings that match the search and level. `textOf` returns findingSearchText, usually from a cache. */
export function filterFindings(findings: Finding[], policies: BaselinePolicy[], filter: FindingFilter, textOf: (finding: Finding) => string): Finding[] {
  const terms = searchTerms(filter.query)
  if (!terms.length && !filter.level) return findings
  return findings.filter(finding =>
    (!filter.level || kitLevelForPolicy(policies[finding.policyIndex]) === filter.level)
    && (!terms.length || matchesTerms(textOf(finding), terms)))
}
