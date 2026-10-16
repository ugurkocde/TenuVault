import { countedItems, type CountedItem } from "../../../shared/compliance/counted"
import type { NativeAssessment } from "../../../shared/compliance/native"
import type { ControlStatus } from "../../../shared/compliance/types"
import { rankGap, type Ranking } from "./gap-ranking"
import { countedGaps, partialCollection, type CountedGap } from "./gaps"
import type { HistoryRead } from "./history"
import {
  assessedAt,
  buildTrend,
  freshness,
  identityOf,
  scoreRun,
  type AssessmentIdentity,
  type BaselineScore,
  type Freshness,
  type IncompatibleRun,
  type TrendPoint,
} from "./formula"

/** Pure projections of saved comparisons into what the scores screen shows. */

export interface RankedGap extends CountedGap {
  ranking: Ranking
}

/** What one counted item is: a framework capability (native comparisons) or an expected setting (OIB). */
export type ScoreUnit = "capability" | "setting"

export interface LatestScore {
  identity: AssessmentIdentity
  /** Detail of the version for display, such as the OIB source commit; null when the version says it all. */
  versionDetail: string | null
  unit: ScoreUnit
  /** Framework references without a configuration check; each is counted once as unknown. */
  uncheckedReferences: number
  freshness: Freshness
  score: BaselineScore
  /** Collection families that were not fully read; non-empty means partial evidence. */
  incompleteCollection: string[]
  /** Capabilities counted different or missing: always counts.different + counts.missing for native comparisons. */
  gapCount: number
  topGaps: RankedGap[]
}

/** A trend point, flagged when its collection was partial: its denominator can change with no tenant change. */
export interface ScoreTrendPoint extends TrendPoint {
  partial: boolean
}

/** A saved result that is kept in history but sets no score, with the reason. */
export interface HistoryOnlyRun {
  runId: string
  assessedAt: string
  reason: string
}

export interface FrameworkScore {
  frameworkId: string
  frameworkName: string
  /**
   * not-assessed: no saved comparison. unavailable: the saved comparisons could not be read.
   * history-only: saved results exist but none can set a score (scored under older rules, or
   * OIB single-policy validations only); they are listed in historyOnly.
   */
  state: "scored" | "not-scored" | "not-assessed" | "unavailable" | "history-only"
  message: string | null
  latest: LatestScore | null
  trend: ScoreTrendPoint[]
  incompatible: IncompatibleRun[]
  historyOnly: HistoryOnlyRun[]
}

const TOP_GAPS = 5

/** Gaps of a run ranked by the documented gap criteria (gap-ranking.ts), highest first. */
export function rankedGaps(run: NativeAssessment): RankedGap[] {
  const incomplete = partialCollection(run)
  return countedGaps(run)
    .map((gap) => ({ ...gap, ranking: rankGap(gap, incomplete) }))
    .sort((a, b) => b.ranking.score - a.ranking.score || a.capabilityName.localeCompare(b.capabilityName))
}

export function latestScore(run: NativeAssessment, now: Date, topGaps = TOP_GAPS): LatestScore {
  const gaps = rankedGaps(run)
  return {
    identity: identityOf(run),
    versionDetail: null,
    unit: "capability",
    uncheckedReferences: (run.assessment.frameworks[0]?.controls ?? []).filter((control) => control.unavailableCheck && control.unavailableCheck.assessmentStatus !== "outsideScope").length,
    freshness: freshness(run, now),
    score: scoreRun(run),
    incompleteCollection: partialCollection(run),
    gapCount: gaps.length,
    topGaps: gaps.slice(0, topGaps),
  }
}

/**
 * The comparison a score card and its detail show: the newest by collection time. The card,
 * the detail and the framework page link all use this one rule.
 */
export function newestRun(runs: NativeAssessment[]): NativeAssessment | undefined {
  return [...runs].sort((a, b) => Date.parse(assessedAt(b)) - Date.parse(assessedAt(a)))[0]
}

export const OLDER_RULES_MESSAGE = "Scored under older rules. Compare again to score."

/** One framework's score card from its saved history. */
export function frameworkScore(read: HistoryRead, now: Date): FrameworkScore {
  const base = { frameworkId: read.frameworkId, frameworkName: read.frameworkName }
  if (read.status === "unavailable") return { ...base, state: "unavailable", message: read.error, latest: null, trend: [], incompatible: [], historyOnly: [] }
  const historyOnly = read.olderRuns.map(({ run, reason }) => ({ runId: run.runId, assessedAt: assessedAt(run), reason: `${OLDER_RULES_MESSAGE} ${reason}` })).sort((a, b) => Date.parse(b.assessedAt) - Date.parse(a.assessedAt))
  const run = newestRun(read.runs)
  if (!run && historyOnly[0]) return { ...base, state: "history-only", message: historyOnly[0].reason, latest: null, trend: [], incompatible: [], historyOnly }
  if (!run) return { ...base, state: "not-assessed", message: read.notice ?? "No saved comparison. Compare this framework on the Frameworks page first.", latest: null, trend: [], incompatible: [], historyOnly }
  const latest = latestScore(run, now)
  const { trend, incompatible } = buildTrend(read.runs)
  const partial = new Set(read.runs.filter((item) => partialCollection(item).length > 0).map((item) => item.runId))
  return { ...base, frameworkName: latest.identity.frameworkName || read.frameworkName, state: latest.score.state, message: latest.score.reason ?? read.notice, latest, trend: trend.map((point) => ({ ...point, partial: partial.has(point.runId) })), incompatible, historyOnly }
}

export interface ControlRow {
  id: string
  title: string
  status: ControlStatus
  capabilityIds: string[]
  gapCapabilityIds: string[]
  unavailable: string | null
}

export interface FrameworkDetail {
  identity: AssessmentIdentity
  versionDetail: string | null
  unit: ScoreUnit
  freshness: Freshness
  score: BaselineScore
  incompleteCollection: string[]
  /** Every counted item with its counted result and reason; they add up to score.counts. Empty for OIB. */
  items: CountedItem[]
  gaps: RankedGap[]
  controls: ControlRow[]
  unassessedNote: string | null
}

/** Drill-down of one saved comparison to every counted capability, every gap and its source controls. */
export function frameworkDetail(run: NativeAssessment, now: Date): FrameworkDetail {
  const gaps = rankedGaps(run)
  const gapIds = new Set(gaps.map((gap) => gap.capabilityId))
  const framework = run.assessment.frameworks[0]
  return {
    identity: identityOf(run),
    versionDetail: null,
    unit: "capability",
    freshness: freshness(run, now),
    score: scoreRun(run),
    incompleteCollection: partialCollection(run),
    items: countedItems(run),
    gaps,
    controls: (framework?.controls ?? []).map((control) => ({
      id: control.control.id,
      title: control.control.title,
      status: control.status,
      capabilityIds: control.capabilityIds,
      gapCapabilityIds: control.capabilityIds.filter((id) => gapIds.has(id)),
      unavailable: control.unavailableCheck ? (control.unavailableCheck.reason ?? "No configuration check exists for this requirement.") : null,
    })),
    unassessedNote: framework?.framework.note ?? null,
  }
}
