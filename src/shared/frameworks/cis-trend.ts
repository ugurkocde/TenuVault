import { cisReadiness } from "./cis-readiness"
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
}

export interface CisTrendPoint {
  runId: string
  assessedAt: string
  benchmark: string
  version: string
  levels: CisTrendLevel[]
}

export function cisReadinessTrend(history: CisTrendHistoryEntry[], recommendationList?: RecommendationList, exceptions?: CisException[]): CisTrendPoint[] {
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
  const previousByLevel = new Map<KitLevel, { passRate: number | null; adjustedPassRate: number | null }>()
  return sorted.map(entry => {
    const summary = cisReadiness(entry.assessment, entry.policies, undefined, recommendationList, exceptions, entry.assessment.assessedAt)
    const levels: CisTrendLevel[] = summary.levels.map(level => {
      const previous = previousByLevel.get(level.level)
      const changeFromPrevious = previous && previous.passRate !== null && level.passRate !== null ? level.passRate - previous.passRate : null
      const adjustedChangeFromPrevious = previous && previous.adjustedPassRate !== null && level.adjustedPassRate !== null ? level.adjustedPassRate - previous.adjustedPassRate : null
      return {
        level: level.level,
        passRate: level.passRate,
        adjustedPassRate: level.adjustedPassRate,
        assessedSettings: level.assessedSettings,
        present: level.present,
        excepted: level.excepted,
        changeFromPrevious,
        adjustedChangeFromPrevious,
      }
    })
    for (const level of levels) previousByLevel.set(level.level, { passRate: level.passRate, adjustedPassRate: level.adjustedPassRate })
    return { runId: entry.assessment.runId, assessedAt: entry.assessment.assessedAt, benchmark: summary.benchmark, version: summary.version, levels }
  })
}
