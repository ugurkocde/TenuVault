import type { ManualItemView } from "./cis-manual"
import type { RecommendationResult, RecommendationResultState } from "./cis-recommendations"
import { matchesTerms, searchTerms } from "../search"
import { settingDisplayName } from "./cis-display"
import type { SettingNames } from "../intune/drift"

/** Narrowing the CIS readiness recommendation results and manual lists by search text and result. */
export type RecommendationResultFilter = "All" | RecommendationResultState

/**
 * Results whose ID, title, setting definition IDs or setting display names match every search
 * term, before the result filter. Display names come from `names` when they were read, else from
 * a readable form of the id, as the list shows them.
 */
export function searchRecommendationResults(items: RecommendationResult[], query: string, names?: SettingNames): RecommendationResult[] {
  const terms = searchTerms(query)
  if (!terms.length) return items
  return items.filter(item => matchesTerms([item.id, item.title, ...item.settings.flatMap(setting => [setting.id, settingDisplayName(setting.id, names)])].join("\n").toLowerCase(), terms))
}

const RESULTS: RecommendationResultFilter[] = ["All", "Pass", "Fail", "Review", "Not assessed"]

/**
 * The result chips for one Level, with counts that follow the search, and the selection to apply.
 * Review is offered only when the Level has Review items; a selection whose chip is not offered,
 * such as Review after another assessment without Review items loads, falls back to All.
 */
export function recommendationResultView(items: RecommendationResult[], query: string, selected: RecommendationResultFilter, names?: SettingNames) {
  const searched = searchRecommendationResults(items, query, names)
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
