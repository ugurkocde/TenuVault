import { cisReadiness, headlineRate } from "./cis-readiness"
import type { RecommendationList } from "./cis-manual"
import type { CisException } from "./cis-exceptions"
import type { KitLevel } from "./cis-kit"
import type { Assessment, BaselinePolicy } from "./policies"

export interface CisTrendHistoryEntry {
  assessment: Assessment
  policies: BaselinePolicy[]
}

export interface CisTrendLevel {
  level: KitLevel
  passRate: number | null
  adjustedPassRate: number | null
  assessedSettings: number
  present: number
  excepted: number
  changeFromPrevious: number | null
  adjustedChangeFromPrevious: number | null
  /** Which rate the trend follows: recommendations when the pack lists them, settings otherwise. Absent means settings. */
  basis?: "recommendations" | "settings"
  recommendationPassRate?: number | null
  adjustedRecommendationPassRate?: number | null
}

/** The rate a trend level follows: the recommendation pass rate when available, else the settings pass rate. */
export function trendRate(level: CisTrendLevel): number | null {
  return level.basis === "recommendations" ? level.recommendationPassRate ?? null : level.passRate
}

export function adjustedTrendRate(level: CisTrendLevel): number | null {
  return level.basis === "recommendations" ? level.adjustedRecommendationPassRate ?? null : level.adjustedPassRate
}

export interface CisTrendPoint {
  runId: string
  assessedAt: string
  benchmark: string
  benchmarkName?: string | null
  version: string
  levels: CisTrendLevel[]
}

export interface CisDriftEntry {
  level: KitLevel
  previousRate: number
  currentRate: number
  previousAssessedAt: string
  assessedAt: string
  benchmark: string
  benchmarkName?: string | null
  version: string
  kind: "decline" | "below-bar"
}

/**
 * Contiguous runs of point indexes that can be joined in a sparkline for one
 * level. A run breaks at a missing level or null pass rate, and at a benchmark
 * or version change, so incomparable points are never connected.
 */
export function sparklineSegments(points: CisTrendPoint[], level: KitLevel): number[][] {
  const segments: number[][] = []
  let current: number[] = []
  const flush = () => {
    if (current.length) segments.push(current)
    current = []
  }
  points.forEach((point, index) => {
    const item = point.levels.find(entry => entry.level === level)
    if (!item || trendRate(item) === null) {
      flush()
      return
    }
    if (current.length) {
      const previous = points[current[current.length - 1]!]!
      const previousItem = previous.levels.find(entry => entry.level === level)
      if (previous.benchmark !== point.benchmark || previous.version !== point.version || (previousItem?.basis ?? "settings") !== (item.basis ?? "settings")) flush()
    }
    current.push(index)
  })
  flush()
  return segments
}

/**
 * Drift in the newest point of a trend, per level. Only the newest point is
 * considered, and only when its changeFromPrevious is not null, which already
 * means the benchmark and version are comparable and the immediate
 * predecessor had the level. A level drifts when its raw pass rate dropped
 * by at least 5 percentage points, or when it crossed from at least 0.90 to
 * below 0.90. Below-bar wins when both apply. Adjusted rates are never used.
 */
export function cisDriftSignals(points: CisTrendPoint[]): CisDriftEntry[] {
  if (points.length < 2) return []
  const newest = points[points.length - 1]!
  const previousPoint = points[points.length - 2]!
  const entries: CisDriftEntry[] = []
  for (const level of newest.levels) {
    const currentRate = trendRate(level)
    if (level.changeFromPrevious === null || currentRate === null) continue
    const previous = previousPoint.levels.find(entry => entry.level === level.level)
    const previousRate = previous ? trendRate(previous) : null
    if (previousRate === null) continue
    const belowBar = previousRate >= 0.9 && currentRate < 0.9
    const decline = previousRate - currentRate >= 0.05 - 1e-9
    if (!belowBar && !decline) continue
    entries.push({
      level: level.level,
      previousRate,
      currentRate,
      previousAssessedAt: previousPoint.assessedAt,
      assessedAt: newest.assessedAt,
      benchmark: newest.benchmark,
      ...(newest.benchmarkName ? { benchmarkName: newest.benchmarkName } : {}),
      version: newest.version,
      kind: belowBar ? "below-bar" : "decline",
    })
  }
  return entries
}

export function cisReadinessTrend(history: CisTrendHistoryEntry[], recommendationList?: RecommendationList, exceptions?: CisException[]): CisTrendPoint[] {
  // Stored history is newest first (workspaces unshift new assessments), so
  // keeping the first occurrence of a runId keeps the newest copy.
  const seen = new Set<string>()
  const deduped: CisTrendHistoryEntry[] = []
  for (const entry of history) {
    const runId = entry.assessment.runId
    if (seen.has(runId)) continue
    seen.add(runId)
    deduped.push(entry)
  }
  const sorted = [...deduped].sort((a, b) => {
    const diff = Date.parse(a.assessment.assessedAt) - Date.parse(b.assessment.assessedAt)
    if (diff !== 0) return diff
    return a.assessment.runId.localeCompare(b.assessment.runId)
  })
  const summaries = sorted.map(entry => {
    const assessedDate = entry.assessment.assessedAt.slice(0, 10)
    const applicable = (exceptions ?? []).filter(exception => exception.createdAt.slice(0, 10) <= assessedDate)
    return cisReadiness(entry.assessment, entry.policies, undefined, recommendationList, applicable, entry.assessment.assessedAt)
  })
  return sorted.map((entry, index) => {
    const summary = summaries[index]!
    const previousSummary = index > 0 ? summaries[index - 1] : undefined
    const comparable = previousSummary !== undefined && previousSummary.benchmark === summary.benchmark && previousSummary.version === summary.version
    const levels: CisTrendLevel[] = summary.levels.map(level => {
      const previous = comparable && previousSummary ? previousSummary.levels.find(item => item.level === level.level) : undefined
      // Change is measured on the headline rate, and only between points on the same basis.
      const current = headlineRate(level)
      const before = previous ? headlineRate(previous) : null
      const sameBasis = before !== null && before.basis === current.basis
      const changeFromPrevious = sameBasis && before.rate !== null && current.rate !== null ? current.rate - before.rate : null
      const adjustedChangeFromPrevious = sameBasis && before.adjusted !== null && current.adjusted !== null ? current.adjusted - before.adjusted : null
      return {
        level: level.level,
        passRate: level.passRate,
        adjustedPassRate: level.adjustedPassRate,
        assessedSettings: level.assessedSettings,
        present: level.present,
        excepted: level.excepted,
        changeFromPrevious,
        adjustedChangeFromPrevious,
        ...(current.basis === "recommendations" ? { basis: current.basis, recommendationPassRate: level.recommendationPassRate, adjustedRecommendationPassRate: level.adjustedRecommendationPassRate } : {}),
      }
    })
    return { runId: entry.assessment.runId, assessedAt: entry.assessment.assessedAt, benchmark: summary.benchmark, benchmarkName: summary.benchmarkName, version: summary.version, levels }
  })
}
