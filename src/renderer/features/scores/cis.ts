import { benchmarkTitle } from "../../../shared/frameworks/cis-display"
import type { CisPortfolioWorkspace } from "../../../shared/frameworks/cis-portfolio"
import { compareAssessments, exclusionsText, levelHeadline, packBenchmark, ratePercent, readinessFor } from "../../../shared/frameworks/cis-readiness"
import type { KitLevel } from "../../../shared/frameworks/cis-kit"
import { loadCisWorkspace } from "./api"

export interface CisScoreLevel {
  level: KitLevel
  basis: "recommendations" | "settings"
  /** The name of the rate, as the CIS page shows it. */
  label: "Recommendation pass rate" | "Settings pass rate"
  /** The raw measured rate in percent with one decimal, as the CIS page shows it; null when not available. */
  rate: number | null
  /** The rate with active exclusions counted as passed; null when no exclusion applies. */
  adjusted: number | null
  /** Exclusions in use for this Level. */
  exclusions: number
  /** The text next to the rate, as the CIS page shows it; null without exclusions in use. */
  withExclusions: string | null
  /** The date the exclusions were judged on, as YYYY-MM-DD. */
  exclusionsAsOf: string
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
 * One card per saved CIS benchmark of a tenant: the newest saved assessment of each benchmark,
 * read with readinessFor and levelHeadline, the functions the CIS page uses for its headline,
 * so the card shows the same rate, label and exclusions as the page. The raw rate is the
 * headline; the rate with exclusions is shown only when exclusions are in use. Assessments of
 * another tenant are ignored. Without internal CIS access there are no cards at all.
 */
export function cisScoreCards(access: boolean, workspace: CisPortfolioWorkspace | null | undefined, tenantId: string, todayISO?: string): CisScoreCard[] {
  if (!access) return []
  const tenant = tenantId.toLowerCase()
  // Newest first in the order every CIS view uses, so ties pick the same run as the CIS page.
  const history = (workspace?.history ?? [])
    .filter((entry) => entry.assessment.tenantId.toLowerCase() === tenant)
    .sort((a, b) => compareAssessments(b, a))
  const cards = new Map<string, CisScoreCard>()
  for (const entry of history) {
    if (cards.has(packBenchmark(entry.policies, workspace?.recommendationList).benchmark)) continue
    const readiness = readinessFor(entry, { ...workspace, history: workspace?.history ?? [] }, todayISO)
    cards.set(readiness.benchmark, {
      key: readiness.benchmark,
      title: benchmarkTitle(readiness.benchmark, readiness.benchmarkName),
      version: readiness.version,
      runId: entry.assessment.runId,
      assessedAt: entry.assessment.assessedAt,
      levels: readiness.levels.map((level) => {
        const head = levelHeadline(level)
        return { level: level.level, basis: head.basis, label: head.label, rate: ratePercent(head.rate), adjusted: ratePercent(head.adjusted), exclusions: head.exclusions, withExclusions: exclusionsText(head), exclusionsAsOf: head.exclusionsAsOf }
      }),
    })
  }
  return [...cards.values()]
}

/**
 * The CIS page link of a card: it names the card's benchmark, version and Level, so the page
 * opens on the newest saved assessment of them, the run the card shows, read-only.
 */
export function cisCardPath(card: Pick<CisScoreCard, "key" | "version" | "levels">): string {
  const params = new URLSearchParams({ benchmark: card.key })
  if (card.version) params.set("version", card.version)
  const level = card.levels[0]?.level
  if (level) params.set("level", String(level))
  return `/portal/frameworks/cis-benchmarks?${params.toString()}`
}

/** The CIS cards of one portfolio tenant, or why its saved CIS assessments could not be read. */
export type PortfolioCis = { cards: CisScoreCard[]; error: null } | { cards: []; error: string }

/**
 * The CIS cards of each portfolio tenant, keyed by lower-case tenant id, with the same rates as
 * that tenant's Governance CIS cards. Each tenant is read on its own, so one failure does not
 * hide the others. Without internal CIS access nothing is read.
 */
export async function loadPortfolioCis(access: boolean, tenantIds: string[], read: (tenantId: string) => Promise<CisPortfolioWorkspace> = loadCisWorkspace, todayISO?: string): Promise<Map<string, PortfolioCis>> {
  if (!access) return new Map()
  const entries = await Promise.all(tenantIds.map(async (tenantId): Promise<[string, PortfolioCis]> => {
    try {
      return [tenantId.toLowerCase(), { cards: cisScoreCards(true, await read(tenantId), tenantId, todayISO), error: null }]
    } catch (error) {
      return [tenantId.toLowerCase(), { cards: [], error: error instanceof Error ? error.message : "The saved CIS assessments could not be read." }]
    }
  }))
  return new Map(entries)
}
