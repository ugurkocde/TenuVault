import type { Drift, SettingNames } from "./drift"
import { settingLabel } from "./drift-format"
import { matchesTerms, searchTerms } from "../search"

/**
 * Narrowing a drift result on the Drift Detection page: search text, one change type and one
 * policy type. Exports use the same shown list.
 */
export interface DriftFilter {
  query: string
  change: Drift["changeType"] | "all"
  /** A policy type such as "Device Configuration", or "" for every type. */
  type: string
}

export const NO_DRIFT_FILTER: DriftFilter = { query: "", change: "all", type: "" }

export function driftFilterActive(filter: DriftFilter): boolean {
  return searchTerms(filter.query).length > 0 || filter.change !== "all" || filter.type !== ""
}

/** The lowercased text a search matches: item name, previous name, type, and each changed setting's name and path. */
export function driftSearchText(drift: Drift, names?: SettingNames): string {
  const settings = (drift.changes ?? []).flatMap(change => {
    const { label, path } = settingLabel(change, names)
    return [label, path]
  })
  return [drift.configName, drift.previousName ?? "", drift.type, ...settings].join("\n").toLowerCase()
}

/** Policy types present in the result, in alphabetical order. */
export function driftTypes(drifts: Drift[]): string[] {
  return [...new Set(drifts.map(drift => drift.type))].sort((a, b) => a.localeCompare(b))
}

/** The drifts that pass every part of the filter. `textOf` returns driftSearchText, usually from a cache. */
export function filterDrifts(drifts: Drift[], filter: DriftFilter, textOf: (drift: Drift) => string): Drift[] {
  const terms = searchTerms(filter.query)
  return drifts.filter(drift =>
    (filter.change === "all" || drift.changeType === filter.change)
    && (filter.type === "" || drift.type === filter.type)
    && (!terms.length || matchesTerms(textOf(drift), terms)))
}

/** "search: firewall; change: modified; type: Device Configuration", for exported reports. */
export function driftFilterText(filter: DriftFilter): string {
  const query = filter.query.trim()
  return [
    query ? `search: ${query}` : "",
    filter.change !== "all" ? `change: ${filter.change}` : "",
    filter.type ? `type: ${filter.type}` : "",
  ].filter(Boolean).join("; ")
}
