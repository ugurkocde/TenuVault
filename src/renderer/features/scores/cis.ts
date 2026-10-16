import { benchmarkTitle } from "../../../shared/frameworks/cis-display"
import type { CisPortfolioWorkspace } from "../../../shared/frameworks/cis-portfolio"
import { cisReadiness, headlineRate } from "../../../shared/frameworks/cis-readiness"
import type { KitLevel } from "../../../shared/frameworks/cis-kit"

export interface CisScoreLevel {
  level: KitLevel
  basis: "recommendations" | "settings"
  /** The raw measured rate in percent with one decimal, as the CIS page shows it; null when not available. */
  rate: number | null
  /** The rate with active exclusions counted as passed; null when no exclusion applies. */
  adjusted: number | null
  /** Active exclusions that apply to this Level. */
  exclusions: number
}

export interface CisScoreCard {
  key: string
  title: string
  version: string
  runId: string
  assessedAt: string
  levels: CisScoreLevel[]
}

/**
 * The CIS workspace a card may show: only from a successful read made after the tab opened. A
 * failed refetch keeps the cached data in the query but must not show it as current.
 */
export function freshCisWorkspace<T>(query: { status: "pending" | "error" | "success"; data: T | undefined; dataUpdatedAt: number }, mountedAt: number): T | undefined {
  return query.status === "success" && query.dataUpdatedAt >= mountedAt ? query.data : undefined
}

/** The CIS page formats a rate as Math.round(rate * 1000) / 10; the card uses the same arithmetic. */
const percent = (rate: number | null) => (rate === null ? null : Math.round(rate * 1000) / 10)

/**
 * One card per saved CIS benchmark of a tenant: the newest saved assessment of each benchmark,
 * read with cisReadiness the way the CIS page reads its headline (the workspace recommendation
 * list and exceptions). The raw rate is the headline; the adjusted rate is shown only when
 * exclusions apply. Assessments of another tenant are ignored. Without internal CIS access
 * there are no cards at all.
 */
export function cisScoreCards(access: boolean, workspace: CisPortfolioWorkspace | null | undefined, tenantId: string): CisScoreCard[] {
  if (!access) return []
  const tenant = tenantId.toLowerCase()
  const time = (at: string) => {
    const value = Date.parse(at)
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
  }
  const history = (workspace?.history ?? [])
    .filter((entry) => entry.assessment.tenantId.toLowerCase() === tenant)
    .sort((a, b) => time(b.assessment.assessedAt) - time(a.assessment.assessedAt))
  const cards = new Map<string, CisScoreCard>()
  for (const entry of history) {
    const readiness = cisReadiness(entry.assessment, entry.policies, undefined, workspace?.recommendationList, workspace?.exceptions)
    if (cards.has(readiness.benchmark)) continue
    cards.set(readiness.benchmark, {
      key: readiness.benchmark,
      title: benchmarkTitle(readiness.benchmark, readiness.benchmarkName),
      version: readiness.version,
      runId: entry.assessment.runId,
      assessedAt: entry.assessment.assessedAt,
      levels: readiness.levels.map((level) => {
        const head = headlineRate(level)
        const exclusions = level.exceptions.length
        return { level: level.level, basis: head.basis, rate: percent(head.rate), adjusted: exclusions && head.adjusted !== null ? percent(head.adjusted) : null, exclusions }
      }),
    })
  }
  return [...cards.values()]
}
