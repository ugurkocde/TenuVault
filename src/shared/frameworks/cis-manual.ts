import type { KitLevel } from "./cis-kit"

/**
 * A locally imported recommendation list for one benchmark. The file is
 * supplied by the user on their own machine and is never bundled. Its shape:
 * a JSON object with benchmark, version and items. Each item has identifier,
 * level (1 or 2) and automated, plus optional title, description, impact,
 * audit and remediation text fields carried only when the user file has them.
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
const ITEM_FIELDS = new Set(["identifier", "level", "automated", ...TEXT_FIELDS])
const LIST_FIELDS = new Set(["benchmark", "version", "items"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validates one decoded recommendation list value, naming the first problem. */
export function validateRecommendationList(value: unknown): RecommendationList {
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

/** One manual item as shown in the readiness Manual section. */
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
  state: "Manual"
}

function toManualView(item: RecommendationListItem): ManualItemView {
  const hasText = Boolean(item.description?.trim() || item.impact?.trim() || item.audit?.trim() || item.remediation?.trim())
  return {
    identifier: item.identifier, level: item.level,
    ...(item.title ? { title: item.title } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.impact ? { impact: item.impact } : {}),
    ...(item.audit ? { audit: item.audit } : {}),
    ...(item.remediation ? { remediation: item.remediation } : {}),
    hasText, fallback: MANUAL_RECOMMENDATIONS_FALLBACK, fallbackUrl: MANUAL_RECOMMENDATIONS_URL, state: "Manual",
  }
}

/**
 * Manual items for one Level: imported items marked automated false, plus
 * denominator identifiers that were not assessed, deduplicated by identifier.
 * Imported items win because they may carry a title and text fields.
 */
export function manualItemsForLevel(list: RecommendationList | undefined, level: KitLevel, notAssessed: string[] = []): ManualItemView[] {
  const byId = new Map<string, ManualItemView>()
  for (const identifier of notAssessed) {
    if (!byId.has(identifier)) byId.set(identifier, toManualView({ identifier, level, automated: false }))
  }
  for (const item of list?.items ?? []) {
    if (item.level !== level || item.automated) continue
    byId.set(item.identifier, toManualView(item))
  }
  return [...byId.values()].sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }))
}
