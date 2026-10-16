import { levelHeadline, packBenchmark, readinessFor, type CisHeadline } from "./cis-readiness"
import type { RecommendationList } from "./cis-manual"
import { localDate, type CisException } from "./cis-exceptions"
import type { KitLevel } from "./cis-kit"
import type { Assessment, BaselinePolicy } from "./policies"
import { allows, type Plan } from "../plans"

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
  /** Which rate the portfolio shows and ranks: recommendations when the pack lists them, settings otherwise. */
  basis: "recommendations" | "settings"
  /** Present when the pack lists recommendations; ranking then follows these instead of the settings rates. */
  recommendationPassRate?: number | null
  adjustedRecommendationPassRate?: number | null
  excepted: number
  assessedSettings: number
  /** The headline the CIS page shows for this run: raw rate, label and the rate with exclusions. */
  headline: CisHeadline
}

export interface CisPortfolioRow {
  tenantId: string
  tenantName: string | null
  benchmark: string | null
  benchmarkName?: string | null
  version: string | null
  assessedAt: string | null
  levels: CisPortfolioLevel[]
  /** The tenant has saved assessments, but none of the selected benchmark and version. */
  otherBenchmark?: boolean
  error?: string
}

/** One benchmark and version the portfolio can compare tenants on. */
export interface CisPortfolioBenchmark {
  benchmark: string
  version: string
  benchmarkName: string | null
  /** Tenants with at least one saved assessment of it. */
  tenants: number
}

function effectiveRate(level: CisPortfolioLevel | undefined): number | null {
  if (!level) return null
  if (level.basis === "recommendations") return level.recommendationPassRate ?? null
  return level.passRate
}

/** The rate a portfolio shows and ranks for one Level: the raw headline rate, as on the CIS page. */
export function portfolioRate(level: CisPortfolioLevel | undefined): number | null {
  return effectiveRate(level)
}

function rateFor(row: CisPortfolioRow, level: KitLevel): { basis: CisPortfolioLevel["basis"]; rate: number | null } {
  const item = row.levels.find(entry => entry.level === level)
  return { basis: item?.basis ?? "settings", rate: effectiveRate(item) }
}

/**
 * Orders two rows on one Level. Rates are only compared on the same basis: a
 * recommendation rate and a settings rate measure different things, so rows
 * ranked by recommendations come first and settings rows follow. Rows without
 * a rate stay last, as before.
 */
function compareLevel(a: ReturnType<typeof rateFor>, b: ReturnType<typeof rateFor>): number {
  if (a.rate !== null && b.rate !== null && a.basis !== b.basis) return a.basis === "recommendations" ? -1 : 1
  return compareRate(a.rate, b.rate)
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

function dedupeTenants(entries: CisPortfolioEntry[]): CisPortfolioEntry[] {
  const seenTenants = new Set<string>()
  return entries.filter(entry => {
    const key = entry.tenantId.toLowerCase()
    if (seenTenants.has(key)) return false
    seenTenants.add(key)
    return true
  })
}

function sameBenchmark(entry: CisPortfolioHistoryEntry, workspace: CisPortfolioWorkspace | null | undefined, selected: Pick<CisPortfolioBenchmark, "benchmark" | "version">): boolean {
  const pack = packBenchmark(entry.policies, workspace?.recommendationList)
  return pack.benchmark === selected.benchmark && pack.version === selected.version
}

/**
 * The benchmarks and versions saved for the tenants of a portfolio, the one most tenants
 * assessed first, then the most recently assessed. Only assessments of the tenant itself count.
 */
export function portfolioBenchmarks(entries: CisPortfolioEntry[]): CisPortfolioBenchmark[] {
  const found = new Map<string, CisPortfolioBenchmark & { newest: number }>()
  for (const entry of dedupeTenants(entries)) {
    if (entry.error) continue
    const keys = new Set<string>()
    for (const item of entry.workspace?.history ?? []) {
      if (item.assessment.tenantId.toLowerCase() !== entry.tenantId.toLowerCase()) continue
      const pack = packBenchmark(item.policies, entry.workspace?.recommendationList)
      const key = JSON.stringify([pack.benchmark, pack.version])
      const time = Date.parse(item.assessment.assessedAt)
      const current = found.get(key) ?? { benchmark: pack.benchmark, version: pack.version, benchmarkName: pack.benchmarkName, tenants: 0, newest: Number.NEGATIVE_INFINITY }
      if (!keys.has(key)) current.tenants += 1
      keys.add(key)
      if (Number.isFinite(time) && time > current.newest) current.newest = time
      current.benchmarkName ??= pack.benchmarkName
      found.set(key, current)
    }
  }
  return [...found.values()]
    .sort((a, b) => b.tenants - a.tenants || b.newest - a.newest || (a.benchmarkName ?? a.benchmark).localeCompare(b.benchmarkName ?? b.benchmark) || a.version.localeCompare(b.version))
    .map(({ newest: _newest, ...benchmark }) => benchmark)
}

/**
 * Portfolio rows that compare tenants on one benchmark and version: each tenant's newest saved
 * assessment of it, read with readinessFor so the rate is the one the CIS page shows for that
 * run. Without a selection the benchmark most tenants assessed is used. Tenants without an
 * assessment of it show as not assessed.
 */
export function cisPortfolioRows(entries: CisPortfolioEntry[], selected: Pick<CisPortfolioBenchmark, "benchmark" | "version"> | null = portfolioBenchmarks(entries)[0] ?? null, todayISO: string = localDate()): CisPortfolioRow[] {
  const deduped = dedupeTenants(entries)
  const rows: CisPortfolioRow[] = deduped.map(entry => {
    const tenantName = entry.tenantName ?? null
    if (entry.error) {
      return { tenantId: entry.tenantId, tenantName, benchmark: null, version: null, assessedAt: null, levels: [], error: entry.error }
    }
    const saved = entry.workspace?.history ?? []
    const history = selected ? saved.filter(item => sameBenchmark(item, entry.workspace, selected)) : saved
    if (!history.length) {
      return { tenantId: entry.tenantId, tenantName, benchmark: null, version: null, assessedAt: null, levels: [], ...(saved.length ? { otherBenchmark: true } : {}) }
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
    if (newest.assessment.tenantId.toLowerCase() !== entry.tenantId.toLowerCase()) {
      return { tenantId: entry.tenantId, tenantName, benchmark: null, version: null, assessedAt: null, levels: [], error: "The saved assessment belongs to a different tenant." }
    }
    const summary = readinessFor(newest, { ...entry.workspace, history: saved }, todayISO)
    return {
      tenantId: entry.tenantId,
      tenantName,
      benchmark: summary.benchmark,
      benchmarkName: summary.benchmarkName,
      version: summary.version,
      assessedAt: newest.assessment.assessedAt,
      levels: summary.levels.map(level => ({ level: level.level, passRate: level.passRate, adjustedPassRate: level.adjustedPassRate, excepted: level.excepted, assessedSettings: level.assessedSettings, headline: levelHeadline(level),
        ...(level.recommendations.length
          ? { basis: "recommendations" as const, recommendationPassRate: level.recommendationPassRate, adjustedRecommendationPassRate: level.adjustedRecommendationPassRate }
          : { basis: "settings" as const }) })),
    }
  })
  return [...rows].sort((a, b) => {
    const aAssessed = a.assessedAt !== null
    const bAssessed = b.assessedAt !== null
    if (aAssessed !== bAssessed) return aAssessed ? -1 : 1
    if (aAssessed && bAssessed) {
      const byBenchmark = (a.benchmark ?? "").localeCompare(b.benchmark ?? "")
      if (byBenchmark !== 0) return byBenchmark
      const byVersion = (a.version ?? "").localeCompare(b.version ?? "")
      if (byVersion !== 0) return byVersion
      const level1 = compareLevel(rateFor(a, 1), rateFor(b, 1))
      if (level1 !== 0) return level1
      const level2 = compareLevel(rateFor(a, 2), rateFor(b, 2))
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

/**
 * Which signed-in tenants the CIS portfolio loads: customer tenants on MSP, as before, and the
 * selected tenant itself whenever its own plan includes CIS, so its result can be compared with
 * them. The returned plan gates the Load button: the portfolio stays an MSP view and opens when
 * an included tenant is on MSP; otherwise the selected tenant's plan decides, as before.
 */
export function portfolioMembers(tenantIds: string[], planOf: (tenantId: string) => Plan | null, selectedTenantId: string | undefined): { included: string[]; notIncluded: string[]; plan: Plan | null } {
  const selected = selectedTenantId?.toLowerCase()
  const isIncluded = (tenantId: string) => {
    const plan = planOf(tenantId)
    return plan === "msp" || (tenantId.toLowerCase() === selected && plan !== null && allows(plan, "baselineAllPlatforms"))
  }
  const included = tenantIds.filter(isIncluded)
  const selectedPlan = selected ? planOf(tenantIds.find(tenantId => tenantId.toLowerCase() === selected) ?? selected) : null
  return { included, notIncluded: tenantIds.filter(tenantId => !isIncluded(tenantId)), plan: included.some(tenantId => planOf(tenantId) === "msp") ? "msp" : selectedPlan }
}
