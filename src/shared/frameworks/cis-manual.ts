import type { KitLevel } from "./cis-kit"

/**
 * A recommendation list for one benchmark: imported locally by internal
 * certification tooling, or downloaded with a pack from the delivery service
 * for one Level. It is never bundled. Its shape: a JSON object with benchmark,
 * version and items. Each item has identifier, level (1 or 2) and automated,
 * plus optional title, description, impact, audit and remediation text fields.
 */

export const MANUAL_RECOMMENDATIONS_FALLBACK = "Not all recommendations from the CIS Benchmarks are included in this tool. Please refer to the CIS website to access the free CIS Benchmarks PDFs for manual assessment instructions."
export const MANUAL_RECOMMENDATIONS_URL = "https://www.cisecurity.org/cis-benchmarks"

export interface RecommendationListItem {
  identifier: string
  level: KitLevel
  automated: boolean
  title?: string
  description?: string
  impact?: string
  audit?: string
  remediation?: string
}

export interface RecommendationList {
  benchmark: string
  version: string
  items: RecommendationListItem[]
}

const TEXT_FIELDS = ["title", "description", "impact", "audit", "remediation"] as const
export const MAX_LIST_ITEMS = 5000
export const MAX_LIST_TITLE_LENGTH = 1000
export const MAX_LIST_TEXT_LENGTH = 50_000

/** Limits a downloaded list must meet. Stored lists are read without them, so no saved workspace becomes unreadable. */
export interface RecommendationListLimits { maxItems: number; maxTitleLength: number; maxTextLength: number }
export const DELIVERED_LIST_LIMITS: RecommendationListLimits = { maxItems: MAX_LIST_ITEMS, maxTitleLength: MAX_LIST_TITLE_LENGTH, maxTextLength: MAX_LIST_TEXT_LENGTH }
const ITEM_FIELDS = new Set(["identifier", "level", "automated", ...TEXT_FIELDS])
const LIST_FIELDS = new Set(["benchmark", "version", "items"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validates one decoded recommendation list value, naming the first problem. */
export function validateRecommendationList(value: unknown, limits?: RecommendationListLimits): RecommendationList {
  if (!isRecord(value)) throw new Error("The recommendation list must be a JSON object with benchmark, version and items.")
  for (const key of Object.keys(value)) {
    if (!LIST_FIELDS.has(key)) throw new Error(`The recommendation list has an unknown field: ${key}. Expected benchmark, version and items.`)
  }
  const benchmarkValue = value.benchmark
  if (typeof benchmarkValue !== "string" || !/^[a-z0-9-]+$/.test(benchmarkValue.trim()) || !benchmarkValue.trim()) {
    throw new Error("The recommendation list benchmark must be a benchmark id using lowercase letters, numbers and hyphens.")
  }
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error("The recommendation list version must be a non-empty string.")
  }
  if (!Array.isArray(value.items)) throw new Error("The recommendation list items must be an array.")
  if (!value.items.length) throw new Error("The recommendation list items must contain at least one item.")
  if (limits && value.items.length > limits.maxItems) throw new Error(`The recommendation list items must contain at most ${limits.maxItems} items.`)
  const seen = new Set<string>()
  const items: RecommendationListItem[] = value.items.map((entry, index) => {
    const label = `Recommendation list item ${index + 1}`
    if (!isRecord(entry)) throw new Error(`${label}: expected an object with identifier, level and automated.`)
    for (const key of Object.keys(entry)) {
      if (!ITEM_FIELDS.has(key)) throw new Error(`${label}: unknown field: ${key}. Expected identifier, level, automated and optional title, description, impact, audit and remediation.`)
    }
    if (typeof entry.identifier !== "string" || !entry.identifier.trim() || /\s/.test(entry.identifier.trim())) {
      throw new Error(`${label}: identifier must be a non-empty string without spaces.`)
    }
    if (entry.level !== 1 && entry.level !== 2) throw new Error(`${label}: level must be 1 or 2.`)
    if (typeof entry.automated !== "boolean") throw new Error(`${label}: automated must be true or false.`)
    const item: RecommendationListItem = { identifier: entry.identifier.trim(), level: entry.level, automated: entry.automated }
    for (const field of TEXT_FIELDS) {
      const fieldValue = entry[field]
      if (fieldValue === undefined) continue
      if (typeof fieldValue !== "string") throw new Error(`${label}: ${field} must be a string when present.`)
      const limit = limits ? (field === "title" ? limits.maxTitleLength : limits.maxTextLength) : Infinity
      if (fieldValue.length > limit) throw new Error(`${label}: ${field} must be at most ${limit} characters.`)
      if (fieldValue.trim()) item[field] = fieldValue.trim()
    }
    const key = `${item.level}:${item.identifier}`
    if (seen.has(key)) throw new Error(`${label}: duplicate identifier ${item.identifier} for Level ${item.level}.`)
    seen.add(key)
    return item
  })
  return { benchmark: benchmarkValue.trim(), version: value.version.trim(), items }
}

/** Parses and strictly validates one recommendation list file as text. */
export function parseRecommendationList(text: string): RecommendationList {
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new Error("The recommendation list file is not valid JSON.") }
  return validateRecommendationList(value)
}

export interface BreakoutListRow { identifier: string; level: KitLevel | null; buildKitName: string; title?: string }

function isManualBucket(buildKitName: string): boolean { return /\bmanual\b/i.test(buildKitName) }

/**
 * Builds a recommendation list from breakout workbook rows. Rows in the
 * manual bucket build kit become automated false, every other row becomes
 * automated true. The workbook title is carried when the row has one. Rows
 * without a Level are skipped because the list shape requires a Level.
 */
export function recommendationListFromBreakout(rows: BreakoutListRow[], benchmark: { id: string; version: string }): RecommendationList {
  if (!/^[a-z0-9-]+$/.test(benchmark.id)) throw new Error("The benchmark id must use lowercase letters, numbers and hyphens.")
  if (!benchmark.version.trim()) throw new Error("The benchmark version must be a non-empty string.")
  const seen = new Set<string>()
  const items: RecommendationListItem[] = []
  for (const row of rows) {
    const identifier = row.identifier.trim()
    if (!identifier || row.level === null) continue
    const key = `${row.level}:${identifier}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      identifier, level: row.level, automated: !isManualBucket(row.buildKitName),
      ...(row.title?.trim() ? { title: row.title.trim() } : {}),
    })
  }
  items.sort((a, b) => a.level - b.level || a.identifier.localeCompare(b.identifier, undefined, { numeric: true }))
  return validateRecommendationList({ benchmark: benchmark.id, version: benchmark.version, items })
}

/** Serializes a recommendation list in the documented file shape. */
export function serializeRecommendationList(list: RecommendationList): string {
  return `${JSON.stringify(validateRecommendationList(list), null, 2)}\n`
}

/**
 * One item of the readiness Manual section. Manual: CIS classifies it as a manual check.
 * Not assessed: CIS classifies it as automated, but the pack does not cover it.
 */
export interface ManualItemView {
  identifier: string
  level: KitLevel
  title?: string
  description?: string
  impact?: string
  audit?: string
  remediation?: string
  hasText: boolean
  fallback: string
  fallbackUrl: string
  state: "Manual" | "Not assessed"
}

function toManualView(item: RecommendationListItem, state: ManualItemView["state"]): ManualItemView {
  const hasText = Boolean(item.description?.trim() || item.impact?.trim() || item.audit?.trim() || item.remediation?.trim())
  return {
    identifier: item.identifier, level: item.level,
    ...(item.title ? { title: item.title } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.impact ? { impact: item.impact } : {}),
    ...(item.audit ? { audit: item.audit } : {}),
    ...(item.remediation ? { remediation: item.remediation } : {}),
    hasText, fallback: MANUAL_RECOMMENDATIONS_FALLBACK, fallbackUrl: MANUAL_RECOMMENDATIONS_URL, state,
  }
}

/**
 * Items for one Level that TenuVault does not check: list items marked automated false and
 * denominator identifiers marked manual (state Manual), and automated identifiers the pack did
 * not assess (state Not assessed). Deduplicated by identifier, Manual first, and each carries the
 * title and text of its list item when the list has one.
 */
export function manualItemsForLevel(list: RecommendationList | undefined, level: KitLevel, notAssessed: string[] = [], manual: string[] = []): ManualItemView[] {
  const fromList = new Map((list?.items ?? []).filter(item => item.level === level).map(item => [item.identifier, item] as const))
  const byId = new Map<string, ManualItemView>()
  const add = (identifier: string, state: ManualItemView["state"]) => {
    if (!byId.has(identifier)) byId.set(identifier, toManualView({ ...(fromList.get(identifier) ?? { level, automated: state !== "Manual" }), identifier }, state))
  }
  for (const item of fromList.values()) if (!item.automated) add(item.identifier, "Manual")
  for (const identifier of manual) add(identifier, "Manual")
  for (const identifier of notAssessed) add(identifier, "Not assessed")
  return [...byId.values()].sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }))
}
