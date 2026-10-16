import type { ManualItemView } from "./cis-manual"
import type { RecommendationResult, RecommendationResultState } from "./cis-recommendations"
import { matchesTerms, searchTerms } from "../search"

/** Narrowing the CIS readiness recommendation results and manual lists by search text and result. */
export type RecommendationResultFilter = "All" | RecommendationResultState

/** Results whose ID, title or setting definition IDs match every search term, before the result filter. */
export function searchRecommendationResults(items: RecommendationResult[], query: string): RecommendationResult[] {
  const terms = searchTerms(query)
  if (!terms.length) return items
  return items.filter(item => matchesTerms([item.id, item.title, ...item.settings.map(setting => setting.id)].join("\n").toLowerCase(), terms))
}

export function filterRecommendationResults(items: RecommendationResult[], query: string, result: RecommendationResultFilter): RecommendationResult[] {
  const searched = searchRecommendationResults(items, query)
  return result === "All" ? searched : searched.filter(item => item.result === result)
}

/** Manual items whose identifier, title or benchmark text match every search term. */
export function filterManualItems(items: ManualItemView[], query: string): ManualItemView[] {
  const terms = searchTerms(query)
  if (!terms.length) return items
  return items.filter(item => matchesTerms([item.identifier, item.title, item.description, item.impact, item.audit, item.remediation].filter(Boolean).join("\n").toLowerCase(), terms))
}
