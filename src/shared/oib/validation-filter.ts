import { matchesTerms, searchTerms } from "../search"
import { OIB_PLATFORMS, type OibPlatform, type PolicyValidation } from "./types"

/**
 * Narrowing the Policy Validation list by search text, result and platform. "other" covers
 * policies without a setting-level result: not validated yet, or a type that is not validated.
 */
export type ValidationResultFilter = "all" | "compliant" | "drifted" | "error" | "other"

export interface ValidationFilter {
  query: string
  result: ValidationResultFilter
  /** A platform, or "" for every platform. */
  platform: OibPlatform | ""
}

export const NO_VALIDATION_FILTER: ValidationFilter = { query: "", result: "all", platform: "" }

/** What the filter reads from one list row. `text` holds the names a search matches. */
export interface ValidationFilterItem {
  text: string[]
  platform: OibPlatform
  status?: PolicyValidation["status"]
}

export function validationResultOf(status?: PolicyValidation["status"]): Exclude<ValidationResultFilter, "all"> {
  return status === "compliant" || status === "drifted" || status === "error" ? status : "other"
}

export function validationFilterActive(filter: ValidationFilter): boolean {
  return searchTerms(filter.query).length > 0 || filter.result !== "all" || filter.platform !== ""
}

/** The items that pass every part of the filter, in their original order. */
export function filterValidations<T>(items: T[], filter: ValidationFilter, describe: (item: T) => ValidationFilterItem): T[] {
  const terms = searchTerms(filter.query)
  return items.filter(item => {
    const { text, platform, status } = describe(item)
    return (filter.platform === "" || platform === filter.platform)
      && (filter.result === "all" || validationResultOf(status) === filter.result)
      && (!terms.length || matchesTerms(text.join("\n").toLowerCase(), terms))
  })
}

/**
 * Everything the list needs at once: the platforms present (in the platform picker order), the
 * filter with a platform that is no longer listed reset to every platform, the shown items, and
 * per-result counts that follow the search and platform.
 */
export function validationFilterView<T>(items: T[], filter: ValidationFilter, describe: (item: T) => ValidationFilterItem) {
  const present = new Set(items.map(item => describe(item).platform))
  const platforms = (Object.keys(OIB_PLATFORMS) as OibPlatform[]).filter(platform => present.has(platform))
  const effective: ValidationFilter = { ...filter, platform: filter.platform && present.has(filter.platform) ? filter.platform : "" }
  const searched = filterValidations(items, { ...effective, result: "all" }, describe)
  const count = (result: ValidationResultFilter) => result === "all" ? searched.length : searched.filter(item => validationResultOf(describe(item).status) === result).length
  return { platforms, effective, active: validationFilterActive(effective), shown: filterValidations(items, effective, describe), count }
}
