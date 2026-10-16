import { compareAssessments, exclusionsText, headlineExceptions, headlineRate, readinessFor } from "./cis-readiness"
import type { RecommendationList } from "./cis-manual"
import { localDate, type CisException } from "./cis-exceptions"
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
  /** How this Level was compared: the first of its series, a changed pack, or compared with previousRunId. */
  comparison?: "first" | "pack-changed" | "compared"
  /** The earlier run of the same benchmark, version and Level this Level was compared with. */
  previousRunId?: string
  /** Exclusions in use for this Level, judged on exclusionsAsOf, as readinessFor counts them. */
  exclusions?: number
  /** Ids of those exclusions, from the same headline. */
  exclusionIds?: string[]
  exclusionsAsOf?: string
}

/** The rate a trend level follows: the recommendation pass rate when available, else the settings pass rate. */
export function trendRate(level: CisTrendLevel): number | null {
  return level.basis === "recommendations" ? level.recommendationPassRate ?? null : level.passRate
}

export function adjustedTrendRate(level: CisTrendLevel): number | null {
  return level.basis === "recommendations" ? level.adjustedRecommendationPassRate ?? null : level.adjustedPassRate
}

/** The exclusions text of a trend Level, built like the headline's so the row matches the CIS page. */
export function trendExclusionsText(level: CisTrendLevel): string | null {
  return exclusionsText({ basis: level.basis ?? "settings", rate: trendRate(level), adjusted: level.exclusions ? adjustedTrendRate(level) : null, exclusions: level.exclusions ?? 0 })
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
 * level. A run breaks at a missing level or null pass rate, at a benchmark or
 * version change, and where the trend did not compare a point with the one
 * before it (a changed pack), so incomparable points are never connected.
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
      const notCompared = (item.comparison !== undefined && item.comparison !== "compared") || (item.previousRunId !== undefined && item.previousRunId !== previous.runId)
      if (notCompared || previous.benchmark !== point.benchmark || previous.version !== point.version || (previousItem?.basis ?? "settings") !== (item.basis ?? "settings")) flush()
    }
    current.push(index)
  })
  flush()
  return segments
}

/**
 * Drift in the newest point of each benchmark, version and Level, compared with
 * the run the trend compared it with: the previous run of the same benchmark,
 * version and Level with the same pack. A Level switch, another benchmark run in
 * between or a changed pack never raises drift, because changeFromPrevious is
 * then null. A level drifts when its raw headline rate dropped by at least 5
 * percentage points, or when it crossed from at least 0.90 to below 0.90.
 * Below-bar wins when both apply. Exclusions are never used, so adding or
 * removing an exclusion neither raises nor hides drift.
 */
export function cisDriftSignals(points: CisTrendPoint[]): CisDriftEntry[] {
  const newestOf = new Map<string, { index: number; level: CisTrendLevel }>()
  points.forEach((point, index) => {
    for (const level of point.levels) newestOf.set(JSON.stringify([point.benchmark, point.version, level.level]), { index, level })
  })
  const entries: CisDriftEntry[] = []
  for (const { index, level } of newestOf.values()) {
    const newest = points[index]!
    const currentRate = trendRate(level)
    if (level.changeFromPrevious === null || currentRate === null) continue
    // The run compared with, or for points without a recorded one, the previous point of the same series.
    let previousPoint: CisTrendPoint | undefined
    if (level.previousRunId !== undefined) previousPoint = points.find(point => point.runId === level.previousRunId)
    else for (let at = index - 1; at >= 0 && !previousPoint; at--) {
      const candidate = points[at]!
      if (candidate.benchmark === newest.benchmark && candidate.version === newest.version && candidate.levels.some(entry => entry.level === level.level)) previousPoint = candidate
    }
    const previous = previousPoint?.levels.find(entry => entry.level === level.level)
    const previousRate = previous ? trendRate(previous) : null
    if (!previousPoint || previousRate === null) continue
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

/** A value with object keys sorted at every depth; array order is kept, as it is part of the content. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
}

/** A short fingerprint of the pack a run assessed: its reference and every policy as compared. */
function packFingerprint(entry: CisTrendHistoryEntry): string {
  // Only what defines the assessed content: display names such as benchmarkName are left out.
  const provenance = (policy: BaselinePolicy) => ["benchmark", "version", "level"].map(key => policy.provenance?.[key] ?? null)
  const text = JSON.stringify(canonical([entry.assessment.reference, entry.policies.map(policy => [policy.name, policy.platforms, provenance(policy), policy.settings, (policy.recommendations ?? []).map(item => [item.id, item.level, item.settings])])]))
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0
  return `${text.length}:${hash.toString(16)}`
}

/**
 * Trend points oldest first. Rates come from readinessFor, so every point shows the rate the
 * CIS page shows for that run. Change compares a Level only with the previous run of the same
 * benchmark, version and Level, and only when that run assessed the same pack (same reference
 * and policies); otherwise it is "first" or "pack-changed" with no change.
 */
export function cisReadinessTrend(history: CisTrendHistoryEntry[], recommendationList?: RecommendationList, exceptions?: CisException[], todayISO: string = localDate()): CisTrendPoint[] {
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
  const sorted = [...deduped].sort(compareAssessments)
  const workspace = { history: deduped, ...(recommendationList ? { recommendationList } : {}), ...(exceptions ? { exceptions } : {}) }
  const summaries = sorted.map(entry => readinessFor(entry, workspace, todayISO))
  const fingerprints = sorted.map(packFingerprint)
  return sorted.map((entry, index) => {
    const summary = summaries[index]!
    const levels: CisTrendLevel[] = summary.levels.map(level => {
      let previousIndex = -1
      for (let at = index - 1; at >= 0 && previousIndex < 0; at--) {
        const candidate = summaries[at]!
        if (candidate.benchmark === summary.benchmark && candidate.version === summary.version && candidate.levels.some(item => item.level === level.level)) previousIndex = at
      }
      const comparison = previousIndex < 0 ? "first" as const : fingerprints[previousIndex] === fingerprints[index] ? "compared" as const : "pack-changed" as const
      const previous = comparison === "compared" ? summaries[previousIndex]!.levels.find(item => item.level === level.level) : undefined
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
        comparison,
        ...(comparison === "compared" ? { previousRunId: sorted[previousIndex]!.assessment.runId } : {}),
        exclusions: headlineExceptions(level).length,
        exclusionIds: headlineExceptions(level).map(exception => exception.id),
        exclusionsAsOf: level.exclusionsAsOf,
        ...(current.basis === "recommendations" ? { basis: current.basis, recommendationPassRate: level.recommendationPassRate, adjustedRecommendationPassRate: level.adjustedRecommendationPassRate } : {}),
      }
    })
    return { runId: entry.assessment.runId, assessedAt: entry.assessment.assessedAt, benchmark: summary.benchmark, benchmarkName: summary.benchmarkName, version: summary.version, levels }
  })
}

/** The change cell of a trend Level: first assessment, pack changed, not available, or the change in percentage points. */
export function trendChangeText(level: Pick<CisTrendLevel, "comparison" | "changeFromPrevious">): string {
  if (level.comparison === "first") return "First assessment"
  if (level.comparison === "pack-changed") return "Pack changed, not compared"
  if (level.changeFromPrevious === null) return "Not available"
  const points = Math.round(level.changeFromPrevious * 1000) / 10
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pp`
}

export interface CisTrendGroup {
  key: string
  benchmark: string
  benchmarkName?: string | null
  version: string
  /** Points of this benchmark and version, newest first. */
  points: CisTrendPoint[]
}

/** Trend points grouped by benchmark and version, the group with the newest assessment first, each newest first. */
export function trendGroups(points: CisTrendPoint[]): CisTrendGroup[] {
  const groups = new Map<string, CisTrendGroup>()
  for (const point of [...points].reverse()) {
    const key = JSON.stringify([point.benchmark, point.version])
    const group = groups.get(key) ?? { key, benchmark: point.benchmark, benchmarkName: point.benchmarkName ?? null, version: point.version, points: [] }
    group.points.push(point)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** A current headline that counts an exclusion: the newest run of a benchmark, version and Level. */
export interface CisExclusionUse {
  benchmark: string
  benchmarkName?: string | null
  version: string
  level: KitLevel
}

/**
 * Which current headlines count each exclusion: for every benchmark, version and Level, the
 * exclusions of its newest run. The exclusions panel names them, so removing an exclusion that
 * another benchmark uses is never silent.
 */
export function exclusionUse(points: CisTrendPoint[]): Map<string, CisExclusionUse[]> {
  const newest = new Map<string, { point: CisTrendPoint; level: CisTrendLevel }>()
  for (const point of points) for (const level of point.levels) newest.set(JSON.stringify([point.benchmark, point.version, level.level]), { point, level })
  const uses = new Map<string, CisExclusionUse[]>()
  for (const { point, level } of newest.values()) for (const id of level.exclusionIds ?? []) {
    uses.set(id, [...(uses.get(id) ?? []), { benchmark: point.benchmark, benchmarkName: point.benchmarkName ?? null, version: point.version, level: level.level }])
  }
  return uses
}
