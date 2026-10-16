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

const RESULTS: RecommendationResultFilter[] = ["All", "Pass", "Fail", "Review", "Not assessed"]

/**
 * The result chips for one Level, with counts that follow the search, and the selection to apply.
 * Review is offered only when the Level has Review items; a selection whose chip is not offered,
 * such as Review after another assessment without Review items loads, falls back to All.
 */
export function recommendationResultView(items: RecommendationResult[], query: string, selected: RecommendationResultFilter) {
  const searched = searchRecommendationResults(items, query)
  const options = RESULTS.filter(state => state !== "Review" || items.some(item => item.result === "Review"))
    .map(state => ({ value: state, label: state, count: state === "All" ? searched.length : searched.filter(item => item.result === state).length }))
  const result = options.some(option => option.value === selected) ? selected : "All"
  return { options, result, shown: result === "All" ? searched : searched.filter(item => item.result === result), filtering: searched !== items || result !== "All" }
}

/** Manual items whose identifier, title or benchmark text match every search term. */
export function filterManualItems(items: ManualItemView[], query: string): ManualItemView[] {
  const terms = searchTerms(query)
  if (!terms.length) return items
  return items.filter(item => matchesTerms([item.identifier, item.title, item.description, item.impact, item.audit, item.remediation].filter(Boolean).join("\n").toLowerCase(), terms))
}
