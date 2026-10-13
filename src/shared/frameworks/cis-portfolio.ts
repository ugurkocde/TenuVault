import { cisReadiness } from "./cis-readiness"
import type { RecommendationList } from "./cis-manual"
import type { CisException } from "./cis-exceptions"
import type { KitLevel } from "./cis-kit"
import type { Assessment, BaselinePolicy } from "./policies"

export interface CisPortfolioHistoryEntry {
  assessment: Assessment
  policies: BaselinePolicy[]
}

export interface CisPortfolioWorkspace {
  history: CisPortfolioHistoryEntry[]
  recommendationList?: RecommendationList
  exceptions?: CisException[]
}

export interface CisPortfolioEntry {
  tenantId: string
  tenantName?: string | null
  workspace?: CisPortfolioWorkspace | null
  error?: string
}

export interface CisPortfolioLevel {
  level: KitLevel
  passRate: number | null
  adjustedPassRate: number | null
  excepted: number
  assessedSettings: number
}

export interface CisPortfolioRow {
  tenantId: string
  tenantName: string | null
  benchmark: string | null
  version: string | null
  assessedAt: string | null
  levels: CisPortfolioLevel[]
  error?: string
}

function effectiveRate(level: CisPortfolioLevel | undefined): number | null {
  if (!level) return null
  return level.adjustedPassRate ?? level.passRate
}

function rateFor(row: CisPortfolioRow, level: KitLevel): number | null {
  return effectiveRate(row.levels.find(item => item.level === level))
}

function compareRate(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

function nameOf(row: CisPortfolioRow): string {
  return row.tenantName ?? row.tenantId
}

export function cisPortfolioRows(entries: CisPortfolioEntry[]): CisPortfolioRow[] {
  const rows: CisPortfolioRow[] = entries.map(entry => {
    const tenantName = entry.tenantName ?? null
    if (entry.error) {
      return { tenantId: entry.tenantId, tenantName, benchmark: null, version: null, assessedAt: null, levels: [], error: entry.error }
    }
    const history = entry.workspace?.history ?? []
    if (!history.length) {
      return { tenantId: entry.tenantId, tenantName, benchmark: null, version: null, assessedAt: null, levels: [] }
    }
    let newest = history[0]!
    let newestTime = Date.parse(newest.assessment.assessedAt)
    if (!Number.isFinite(newestTime)) newestTime = Number.NEGATIVE_INFINITY
    for (let index = 1; index < history.length; index++) {
      const candidate = history[index]!
      const time = Date.parse(candidate.assessment.assessedAt)
      const value = Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
      if (value > newestTime) {
        newest = candidate
        newestTime = value
      }
    }
    const summary = cisReadiness(newest.assessment, newest.policies, undefined, entry.workspace?.recommendationList, entry.workspace?.exceptions, newest.assessment.assessedAt)
    return {
      tenantId: entry.tenantId,
      tenantName,
      benchmark: summary.benchmark,
      version: summary.version,
      assessedAt: newest.assessment.assessedAt,
      levels: summary.levels.map(level => ({ level: level.level, passRate: level.passRate, adjustedPassRate: level.adjustedPassRate, excepted: level.excepted, assessedSettings: level.assessedSettings })),
    }
  })
  return [...rows].sort((a, b) => {
    const aAssessed = a.assessedAt !== null
    const bAssessed = b.assessedAt !== null
    if (aAssessed !== bAssessed) return aAssessed ? -1 : 1
    if (aAssessed && bAssessed) {
      const level1 = compareRate(rateFor(a, 1), rateFor(b, 1))
      if (level1 !== 0) return level1
      const level2 = compareRate(rateFor(a, 2), rateFor(b, 2))
      if (level2 !== 0) return level2
      const aTime = Date.parse(a.assessedAt!)
      const bTime = Date.parse(b.assessedAt!)
      const aValue = Number.isFinite(aTime) ? aTime : Number.NEGATIVE_INFINITY
      const bValue = Number.isFinite(bTime) ? bTime : Number.NEGATIVE_INFINITY
      if (aValue !== bValue) return bValue - aValue
    }
    const byName = nameOf(a).localeCompare(nameOf(b))
    if (byName !== 0) return byName
    return a.tenantId.localeCompare(b.tenantId)
  })
}
