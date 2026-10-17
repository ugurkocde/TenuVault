import { computeCoverage, type DenominatorEntry, type DenominatorSource } from "./cis-coverage"
import { manualItemsForLevel, MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL, type ManualItemView, type RecommendationList } from "./cis-manual"
import type { KitLevel, KitPack } from "./cis-kit"
import type { Assessment, BaselinePolicy } from "./policies"
import { appliesOn, exceptionKey, isActive, localDate, type CisException } from "./cis-exceptions"
import { recommendationResults, type RecommendationResult } from "./cis-recommendations"

export const MANUAL_NOT_ASSESSED_NOTE = "Manual recommendations are not assessed by this view."
export { MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL }
export type { ManualItemView, RecommendationList }

export interface CisLevelReadiness {
  benchmark: string
  version: string
  level: KitLevel
  assessedSettings: number
  present: number
  different: number
  missing: number
  review: number
  passRate: number | null
  excepted: number
  /**
   * The exclusions that count toward this Level's headline, the single source for every count,
   * badge, export and tag: applying on this Level's as-of date and, on the settings basis,
   * covering a non-Present finding of this Level's policies, or, on the recommendation basis,
   * covering an open finding of this Level's recommendations, whatever the policy Level of that
   * finding (each exception keeps its own policy Level).
   */
  exceptions: CisException[]
  /**
   * The exception identities (exceptionKey) this Level's headline judges, before dates apply: on the
   * settings basis its non-Present findings, on the recommendation basis the non-Present findings of
   * the failing settings of its recommendations. An applicable exclusion counts exactly when it is
   * in this scope, and an unused one is explained by the headline whose scope holds it.
   */
  exclusionScope: string[]
  adjustedPassRate: number | null
  /** The date exclusions were judged on, as YYYY-MM-DD; see readinessFor. */
  exclusionsAsOf: string
  /** Present settings whose every observed policy is unassigned; null when the assessment holds no targeting evidence for them. */
  presentInUnassigned: number | null
  /** Enumerated identifiers that the denominator list marks automated; null without a denominator list. */
  assessedAutomated: number | null
  /** Distinct recommendation identifiers named in the pack policy descriptions of this Level. */
  enumerated: number
  /** The distinct recommendation identifiers named in the pack policy descriptions of this Level. */
  enumeratedIds: string[]
  /** Every identifier of this Level in the denominator list, automated and manual; empty without one. */
  denominatorIdentifiers: string[]
  /** The identifiers of this Level the denominator list marks automated; empty without one. */
  automatedIdentifiers: string[]
  denominator: number | null
  coverage: number | null
  coverageSource: DenominatorSource
  notAssessed: string[]
  manual: ManualItemView[]
  /** Per recommendation results when the pack lists its recommendations; empty otherwise. */
  recommendations: RecommendationResult[]
  /** Passed over assessed recommendations (review counts as not passed, not assessed is excluded); null without recommendations. */
  recommendationPassRate: number | null
  /** Recommendations that are not passed but whose every non-Present finding has an active exception. */
  recommendationsExcepted: number
  adjustedRecommendationPassRate: number | null
}

/**
 * The headline rate of a Level. A Level with any recommendation of the pack is measured by
 * recommendations, even when none could be assessed: its rate is then null (Not available)
 * and never falls back to the settings rate. Other Levels use the settings pass rate.
 */
export function headlineRate(level: Pick<CisLevelReadiness, "passRate" | "adjustedPassRate" | "recommendations" | "recommendationPassRate" | "adjustedRecommendationPassRate">): { basis: "recommendations" | "settings"; rate: number | null; adjusted: number | null } {
  return level.recommendations?.length
    ? { basis: "recommendations", rate: level.recommendationPassRate ?? null, adjusted: level.adjustedRecommendationPassRate ?? null }
    : { basis: "settings", rate: level.passRate, adjusted: level.adjustedPassRate }
}

/** The name of the headline rate, the same in every view and export. */
export function headlineLabel(basis: "recommendations" | "settings"): "Recommendation pass rate" | "Settings pass rate" {
  return basis === "recommendations" ? "Recommendation pass rate" : "Settings pass rate"
}

/** A rate in percent with one decimal, as every CIS view and export shows it; null stays null. */
export function ratePercent(rate: number | null): number | null {
  return rate === null ? null : Math.round(rate * 1000) / 10
}

/** A rate as text with its unit, or Not available. */
export function formatRate(rate: number | null): string {
  const value = ratePercent(rate)
  return value === null ? "Not available" : `${value}%`
}

export interface CisHeadline {
  basis: "recommendations" | "settings"
  label: "Recommendation pass rate" | "Settings pass rate"
  /** The raw measured rate: the headline everywhere. */
  rate: number | null
  /** The rate with the exclusions in use counted as passed; null when no exclusion is in use. */
  adjusted: number | null
  /** Exclusions that count toward this headline. */
  exclusions: number
  /** Their ids, to count an exclusion once where several headlines use it. */
  exceptionIds: string[]
  exclusionsAsOf: string
}

/**
 * The one headline of a Level that every view and export shows: the raw rate on the headline
 * basis, and next to it the rate with exclusions when any exclusion is in use. The count of
 * exclusions is the number of exclusions in use, the same count as "Excluded from score".
 */
export function levelHeadline(level: Pick<CisLevelReadiness, "passRate" | "adjustedPassRate" | "recommendations" | "recommendationPassRate" | "adjustedRecommendationPassRate" | "exceptions" | "exclusionsAsOf">): CisHeadline {
  const head = headlineRate(level)
  const counted = headlineExceptions(level)
  const exclusions = counted.length
  return { basis: head.basis, label: headlineLabel(head.basis), rate: head.rate, adjusted: exclusions && head.adjusted !== null ? head.adjusted : null, exclusions, exceptionIds: counted.map(exception => exception.id), exclusionsAsOf: level.exclusionsAsOf }
}

/** How many distinct exclusions several headlines use together: one exclusion can count toward two Levels. */
export function distinctExclusions(heads: readonly Pick<CisHeadline, "exceptionIds">[]): number {
  return new Set(heads.flatMap(head => head.exceptionIds)).size
}

/** The exclusions that count toward a Level's headline, as measure decided them once; see CisLevelReadiness.exceptions. */
export function headlineExceptions(level: Pick<CisLevelReadiness, "exceptions">): CisException[] {
  return level.exceptions ?? []
}

/**
 * "X% with N exclusions" next to the headline, or null when no exclusion is in use. On the
 * recommendation basis a recommendation is only credited when every failing setting it names is
 * excluded; when the exclusions in use credit none, the rate would not move, so the text says
 * that instead of repeating the raw rate.
 */
export function exclusionsText(head: Pick<CisHeadline, "basis" | "rate" | "adjusted" | "exclusions">): string | null {
  if (head.adjusted === null || !head.exclusions) return null
  const count = `${head.exclusions} ${head.exclusions === 1 ? "exclusion" : "exclusions"}`
  if (head.basis === "recommendations" && head.adjusted === head.rate) return `${count}, no recommendation fully excluded`
  return `${formatRate(head.adjusted)} with ${count}`
}

/** The line that says how many Present settings sit only in unassigned policies; null without targeting evidence. */
export function unassignedText(level: Pick<CisLevelReadiness, "present" | "presentInUnassigned">): string | null {
  if (level.presentInUnassigned === null) return null
  return `${level.presentInUnassigned} of ${level.present} present ${level.present === 1 ? "setting is" : "settings are"} in unassigned policies. CIS checks configuration; Governance scores count assigned policies only.`
}

/**
 * How many recommendations of a Level TenuVault checks automatically and how many are left for a
 * manual check. With a denominator list the total is exactly its identifiers for the Level, and a
 * recommendation is checked when the denominator marks it automated (as in coverage) and an assessed
 * pack recommendation or the pack descriptions name it, unless its pack recommendation could not be
 * assessed. Partial metadata cannot shrink the total and manual items outside the list cannot inflate
 * it; those still appear in the Manual section. Without a denominator a described identifier cannot be
 * told apart from a manual recommendation or one of another profile, so only assessed pack
 * recommendations count as checked, no total is known, and the manual count is the listed manual and
 * unassessed items.
 */
export function levelCheckCounts(level: Pick<CisLevelReadiness, "recommendations" | "manual" | "enumeratedIds" | "denominatorIdentifiers" | "automatedIdentifiers">): { checked: number; manual: number; total: number | null } {
  const recommendations = level.recommendations ?? []
  const unassessed = new Set(recommendations.filter(result => result.result === "Not assessed").map(result => result.id))
  const assessed = recommendations.filter(result => result.result !== "Not assessed").map(result => result.id)
  // A Level the denominator list names has a known total, even when the pack has no policies for it.
  const known = new Set(level.denominatorIdentifiers ?? [])
  if (known.size) {
    const automated = new Set(level.automatedIdentifiers ?? [])
    const described = new Set([...assessed, ...(level.enumeratedIds ?? [])].filter(id => !unassessed.has(id)))
    const inList = [...described].filter(id => known.has(id) && automated.has(id)).length
    return { checked: inList, manual: known.size - inList, total: known.size }
  }
  const checked = new Set(assessed)
  const manual = new Set([...level.manual.map(item => item.identifier), ...unassessed].filter(id => !checked.has(id)))
  return { checked: checked.size, manual: manual.size, total: null }
}

/**
 * The sentence shown above the CIS notice for one Level. It never states a total without a denominator.
 * `product` names the tool: TenuVault, or the customer's company on a white label PDF.
 */
export function levelCheckSummary(level: Pick<CisLevelReadiness, "level" | "recommendations" | "manual" | "enumeratedIds" | "denominatorIdentifiers" | "automatedIdentifiers">, product = "TenuVault"): string {
  const { checked, manual, total } = levelCheckCounts(level)
  const noun = (count: number) => count === 1 ? "recommendation" : "recommendations"
  if (total === null) {
    // Without recommendation metadata no count is claimed: the pack settings are compared as a whole.
    if (!checked) {
      const prefix = `Level ${level.level}: ${product} compares the settings of this pack automatically.`
      return manual
        ? `${prefix} The ${manual === 1 ? "one manual recommendation" : `${manual} manual recommendations`} listed here and any recommendations outside the pack need a manual check.`
        : `${prefix} Recommendations outside the pack, including manual ones, need a manual check.`
    }
    const prefix = `Level ${level.level}: ${product} checks ${checked} ${noun(checked)} of this pack automatically.`
    return manual
      ? `${prefix} The other ${manual === 1 ? "one listed here" : `${manual} listed here`} and any recommendations outside the pack need a manual check.`
      : `${prefix} Recommendations outside the pack, including manual ones, need a manual check.`
  }
  if (!manual) return `Level ${level.level}: ${product} checks all ${checked} ${noun(checked)} automatically.`
  const rest = manual === 1 ? "The other one needs a manual check." : `The other ${manual} need a manual check.`
  return `Level ${level.level}: ${product} checks ${checked} of ${total} ${noun(total)} automatically. ${rest}`
}

/** The label printed wherever a coverage ratio appears, naming where the full list of automated recommendations came from. */
export function coverageSourceLabel(source: DenominatorSource): string {
  if (source === "authoritative") return "CIS list of automated recommendations"
  if (source === "breakout-proxy") return "estimate from the CIS breakout workbook"
  return "Not available"
}

/**
 * Coverage of the full benchmark in plain words, for the CIS page and the PDF. Coverage needs the
 * list of every automated recommendation CIS defines for a Level. That list is separate from the
 * recommendations a pack maps to its settings, and delivered packs do not include it, so a pack can
 * list hundreds of recommendation results while coverage of the full benchmark stays unknown.
 */
export function coverageStatement(level: Pick<CisLevelReadiness, "level" | "coverage" | "assessedAutomated" | "denominator" | "coverageSource" | "enumerated" | "denominatorIdentifiers">): string {
  // A Level the list names but no policy pack of which was assessed has no coverage to compute.
  if (level.denominator === null && (level.denominatorIdentifiers ?? []).length) return `No policy pack for Level ${level.level} was assessed, so coverage of the full benchmark is not shown for it.`
  if (level.denominator === null) return "Coverage of the full benchmark is not shown because the list of all its automated recommendations is not available."
  if (level.coverage === null) return `Coverage of the full benchmark is not shown because the list of its recommendations marks none of Level ${level.level} as automated.`
  const named = level.enumerated === 0 ? " The pack policies do not name the recommendation numbers they implement, so none of them count." : ""
  return `Coverage: ${formatRate(level.coverage)} (${level.assessedAutomated} of ${level.denominator} automated recommendations), source: ${coverageSourceLabel(level.coverageSource)}.${named}`
}

/** Why a headline is a settings rate: the pack maps no recommendation to its settings. Null on the recommendation basis. */
export function headlineBasisNote(head: Pick<CisHeadline, "basis">): string | null {
  return head.basis === "settings" ? "Scored by settings because this benchmark has no recommendation mapping." : null
}

export interface CisReadinessSummary {
  benchmark: string
  /** Catalog display name of a delivered pack; null when only the id is known. */
  benchmarkName: string | null
  version: string
  levels: CisLevelReadiness[]
  manualNote: string
  manualFallback: string
  manualFallbackUrl: string
  recommendationList?: RecommendationList
}

/** Recommendation results of one Level with their pass rate and the rate adjusted by exceptions. */
function recommendationRates(results: RecommendationResult[], excepted: (result: RecommendationResult) => boolean): Pick<CisLevelReadiness, "recommendations" | "recommendationPassRate" | "recommendationsExcepted" | "adjustedRecommendationPassRate"> {
  const assessed = results.filter(result => result.result !== "Not assessed")
  const passed = assessed.filter(result => result.result === "Pass").length
  const exceptedCount = assessed.filter(result => result.result !== "Pass" && excepted(result)).length
  return {
    recommendations: results,
    recommendationPassRate: assessed.length ? passed / assessed.length : null,
    recommendationsExcepted: exceptedCount,
    adjustedRecommendationPassRate: assessed.length ? (passed + exceptedCount) / assessed.length : null,
  }
}

function levelOf(policy: BaselinePolicy): KitLevel {
  const level = policy.provenance?.level
  return typeof level === "string" && level.includes("2") ? 2 : 1
}

function textOf(policy: BaselinePolicy, key: string): string {
  const value = policy.provenance?.[key]
  return typeof value === "string" ? value : ""
}

/** The benchmark and version a pack is read as, and the recommendation list that applies to it. */
function packIdentity(policies: BaselinePolicy[], recommendationList?: RecommendationList): { benchmark: string; version: string; effectiveList: RecommendationList | undefined } {
  const policyBenchmark = policies.map(policy => textOf(policy, "benchmark")).find(Boolean)
  const policyVersion = policies.map(policy => textOf(policy, "version")).find(Boolean)
  const listMatches = !recommendationList || ((!policyBenchmark || recommendationList.benchmark === policyBenchmark) && (!policyVersion || recommendationList.version === policyVersion))
  const effectiveList = listMatches ? recommendationList : undefined
  return { benchmark: policyBenchmark ?? effectiveList?.benchmark ?? "unknown", version: policyVersion ?? effectiveList?.version ?? "", effectiveList }
}

/** The benchmark, version and catalog name a pack is assessed as, as cisReadiness reads them. */
export function packBenchmark(policies: BaselinePolicy[], recommendationList?: RecommendationList): { benchmark: string; version: string; benchmarkName: string | null } {
  const { benchmark, version } = packIdentity(policies, recommendationList)
  return { benchmark, version, benchmarkName: policies.map(policy => textOf(policy, "benchmarkName")).find(Boolean) ?? null }
}

/**
 * Readiness per benchmark and Level from one assessment of an imported pack.
 * Pass rate is over assessed settings only. Coverage and the assessed automated
 * count are present only when an authoritative denominator list was supplied;
 * identifiers in that list that the pack does not enumerate are listed as not
 * assessed. Exceptions active on todayISO (default: today on this device) apply.
 * Views of saved assessments use readinessFor, which chooses the date per Level.
 */
export function cisReadiness(assessment: Assessment, policies: BaselinePolicy[], denominator?: DenominatorEntry[], recommendationList?: RecommendationList, exceptions?: CisException[], todayISO?: string): CisReadinessSummary {
  const today = localDate(todayISO ?? new Date())
  return measure(assessment, policies, denominator, recommendationList, exceptions ?? [], () => today)
}

/**
 * Readiness with every stored exception and the as-of date of each Level's headline. This is the
 * one place that decides which exclusions count toward a headline: each Level judges every
 * exception on its own as-of date, so a recommendation of one Level never credits an exclusion
 * dated after its headline, even when the setting sits in a policy of another Level.
 */
function measure(assessment: Assessment, policies: BaselinePolicy[], denominator: DenominatorEntry[] | undefined, recommendationList: RecommendationList | undefined, stored: CisException[], asOf: (level: KitLevel) => string): CisReadinessSummary {
  const { benchmark, version, effectiveList } = packIdentity(policies, recommendationList)
  const effectiveDenominator = denominator ?? (effectiveList ? effectiveList.items.map(item => ({ identifier: item.identifier, level: item.level, automated: item.automated })) : undefined)
  const packsByLevel = new Map<KitLevel, KitPack>()
  for (const policy of policies) {
    const level = levelOf(policy)
    const pack = packsByLevel.get(level) ?? { benchmark, version, level, reference: `${benchmark} ${version} Level ${level}`.trim(), policies: [] as BaselinePolicy[] }
    pack.policies.push(policy)
    packsByLevel.set(level, pack)
  }
  // A recommendation is reported under its own Level, even when only a policy of another Level carries its settings.
  const recommendations = recommendationResults(assessment, policies)
  const allLevels = new Set<KitLevel>([...packsByLevel.keys(), ...((effectiveList?.items ?? []).map(item => item.level)), ...recommendations.map(result => result.level)].sort((a, b) => a - b))
  if (!packsByLevel.size && effectiveList) for (const level of allLevels) packsByLevel.set(level, { benchmark, version, level, reference: `${benchmark} ${version} Level ${level}`.trim(), policies: [] })
  const coverage = computeCoverage({ benchmark, version, packs: [...packsByLevel.values()], ...(effectiveDenominator ? { denominator: effectiveDenominator } : {}) })
  const coverageByLevel = new Map(coverage.levels.map(level => [level.level, level]))
  const own = stored.filter(exception => exception.benchmark === benchmark && exception.version === version)
  const keyOf = (exception: CisException) => exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId)
  const findingByKey = new Map(assessment.findings.map(finding => [finding.key, finding]))
  // A finding's exception identity uses the Level of the policy that holds it.
  const findingKey = (finding: Assessment["findings"][number]) => exceptionKey(benchmark, version, policies[finding.policyIndex] ? levelOf(policies[finding.policyIndex]!) : 1, finding.policyName, finding.settingId)
  const recommendationLevel = new Map(recommendations.map(result => [result.id, result.level] as const))
  const levels: CisLevelReadiness[] = [...allLevels].sort((a, b) => a - b).map(level => {
    const indexes = new Set(policies.map((policy, index) => levelOf(policy) === level ? index : -1).filter(index => index >= 0))
    const findings = assessment.findings.filter(finding => indexes.has(finding.policyIndex))
    const count = (status: string) => findings.filter(finding => finding.status === status).length
    const cov = coverageByLevel.get(level)
    const notAssessed = effectiveDenominator && cov ? cov.denominatorIds.filter(id => !cov.numeratorIds.includes(id)) : []
    const manualNotAssessed = effectiveDenominator ? effectiveDenominator.filter(entry => entry.level === level && !entry.automated).map(entry => entry.identifier) : []
    const manual = manualItemsForLevel(effectiveList, level, [...new Set([...notAssessed, ...manualNotAssessed])])
    // Exceptions never change the raw status counts. The excepted count is the
    // number of non-Present findings covered by an active exception for this
    // level, and adjustedPassRate counts those findings as passed.
    // Every exception is judged on this Level's as-of date, the date of the headline it affects.
    const date = asOf(level)
    const applicableByKey = new Map(own.filter(exception => appliesOn(exception, date)).map(exception => [keyOf(exception), exception] as const))
    const findingExcepted = (finding: Assessment["findings"][number]) => applicableByKey.has(findingKey(finding))
    const findingKeys = new Set(findings.filter(finding => finding.status !== "Present").map(finding => exceptionKey(benchmark, version, level, finding.policyName, finding.settingId)))
    const levelExceptions = [...applicableByKey.values()].filter(exception => exception.level === level && findingKeys.has(keyOf(exception)))
    const exceptedKeys = new Set(levelExceptions.map(keyOf))
    const levelRecommendations = recommendations.filter(result => result.level === level)
    // On the recommendation basis the exclusions on the open findings of the failing settings of this
    // Level's recommendations count, wherever those findings sit. A setting a recommendation names
    // that passes contributes none, even when a sibling in its shared root fails for another Level.
    const recommendationScope = new Set(levelRecommendations.flatMap(result => result.settings.filter(setting => setting.status === "Missing" || setting.status === "Different" || setting.status === "Review").flatMap(setting => setting.findingKeys))
      .map(key => findingByKey.get(key)).filter(finding => finding && finding.status !== "Present").map(finding => findingKey(finding!)))
    const recommendationExceptions = [...new Map([...recommendationScope]
      .map(key => applicableByKey.get(key)).filter((exception): exception is CisException => !!exception)
      .map(exception => [exception.id, exception] as const)).values()]
    const excepted = findings.filter(finding => finding.status !== "Present" && exceptedKeys.has(exceptionKey(benchmark, version, level, finding.policyName, finding.settingId))).length
    // CIS counts settings in unassigned policies as Present; this says how many of them there are.
    const presentFindings = findings.filter(finding => finding.status === "Present")
    const withTargeting = presentFindings.some(finding => finding.observed.some(observation => observation.targeting))
    return {
      benchmark, version, level,
      assessedSettings: findings.length,
      present: count("Present"), different: count("Different"), missing: count("Missing"), review: count("Review"),
      passRate: findings.length ? count("Present") / findings.length : null,
      excepted,
      exceptions: levelRecommendations.length ? recommendationExceptions : levelExceptions,
      exclusionScope: [...(levelRecommendations.length ? recommendationScope : findingKeys)],
      adjustedPassRate: findings.length ? (count("Present") + excepted) / findings.length : null,
      exclusionsAsOf: date,
      presentInUnassigned: withTargeting ? presentFindings.filter(finding => finding.observed.length > 0 && finding.observed.every(observation => observation.targeting?.state === "unassigned")).length : null,
      // Without a denominator list an enumerated identifier cannot be told apart from a manual
      // recommendation or one of another profile, so no automated count is claimed.
      assessedAutomated: cov && cov.denominatorSource !== "none" ? cov.numerator : null,
      enumerated: cov?.enumeratedIds.length ?? 0,
      // A description identifier that the recommendation metadata assigns to another Level belongs there.
      enumeratedIds: (cov?.enumeratedIds ?? []).filter(id => (recommendationLevel.get(id) ?? level) === level),
      denominatorIdentifiers: [...new Set((effectiveDenominator ?? []).filter(entry => entry.level === level).map(entry => entry.identifier))],
      automatedIdentifiers: [...new Set((effectiveDenominator ?? []).filter(entry => entry.level === level && entry.automated).map(entry => entry.identifier))],
      denominator: cov?.denominator ?? null,
      coverage: cov?.coverage ?? null,
      coverageSource: cov?.denominatorSource ?? "none",
      notAssessed,
      manual,
      // Credit by exception is judged on the recommendation's own failing settings: each one is
      // covered when every non-Present finding whose root holds it has an active exception.
      // Failures of unrelated sibling settings in the same root neither block nor grant credit.
      ...recommendationRates(levelRecommendations, result => {
        // A setting outside the pack can never be shown to pass, so it rules out credit by exception.
        if (result.settings.some(setting => setting.status === "Unmapped")) return false
        const failing = result.settings.filter(setting => setting.status === "Missing" || setting.status === "Different" || setting.status === "Review")
        return failing.length > 0 && failing.every(setting => {
          const open = setting.findingKeys.map(key => findingByKey.get(key)).filter(finding => finding && finding.status !== "Present")
          return open.length > 0 && open.every(finding => findingExcepted(finding!))
        })
      }),
    }
  })
  const benchmarkName = policies.map(policy => textOf(policy, "benchmarkName")).find(Boolean) ?? null
  return { benchmark, benchmarkName, version, levels, manualNote: MANUAL_NOT_ASSESSED_NOTE, manualFallback: MANUAL_RECOMMENDATIONS_FALLBACK, manualFallbackUrl: MANUAL_RECOMMENDATIONS_URL, ...(effectiveList ? { recommendationList: effectiveList } : {}) }
}

export interface CisReadinessEntry {
  assessment: Assessment
  policies: BaselinePolicy[]
}

export interface CisReadinessWorkspace {
  history: CisReadinessEntry[]
  recommendationList?: RecommendationList
  exceptions?: CisException[]
}

function timeOf(entry: CisReadinessEntry): number {
  const time = Date.parse(entry.assessment.assessedAt)
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

/**
 * The one order of saved assessments every CIS view uses, oldest first: by assessment time,
 * then by run id when two runs share a timestamp. "Newest" anywhere means last in this order.
 */
export function compareAssessments(a: CisReadinessEntry, b: CisReadinessEntry): number {
  return timeOf(a) - timeOf(b) || a.assessment.runId.localeCompare(b.assessment.runId)
}

/** The Levels a saved assessment measures: those of its pack policies and of the recommendations they carry. */
function packLevels(policies: BaselinePolicy[]): Set<KitLevel> {
  return new Set([...policies.map(levelOf), ...policies.flatMap(policy => (policy.recommendations ?? []).map(item => item.level))])
}

/**
 * The newest saved assessment, in the compareAssessments order, of one benchmark and, when given,
 * one version and one Level: the run a view of that benchmark and Level shows. Null when there is none.
 */
export function newestAssessmentOf<T extends CisReadinessEntry>(history: readonly T[], target: { benchmark: string; version?: string; level?: KitLevel }, recommendationList?: RecommendationList): T | null {
  let newest: T | null = null
  for (const entry of history) {
    const identity = packIdentity(entry.policies, recommendationList)
    if (identity.benchmark !== target.benchmark || (target.version !== undefined && identity.version !== target.version)) continue
    if (target.level !== undefined && !packLevels(entry.policies).has(target.level)) continue
    if (!newest || compareAssessments(entry, newest) > 0) newest = entry
  }
  return newest
}

/**
 * The date the exclusions of one Level of a saved assessment are judged on. The newest saved
 * assessment of a benchmark, version and Level, and an assessment that is not saved yet, use
 * today: what the admin excludes now shows at once. An older assessment uses its own assessment
 * date, so its trend point keeps the score it had. The same assessment gets the same date in
 * every view at the same moment.
 */
export function exclusionsAsOf(entry: CisReadinessEntry, workspace: CisReadinessWorkspace, level: KitLevel, todayISO: string = localDate()): string {
  const { benchmark, version } = packIdentity(entry.policies, workspace.recommendationList)
  const newer = workspace.history.some(other => other.assessment.runId !== entry.assessment.runId && compareAssessments(other, entry) > 0 && packLevels(other.policies).has(level) && (() => {
    const identity = packIdentity(other.policies, workspace.recommendationList)
    return identity.benchmark === benchmark && identity.version === version
  })())
  return newer ? localDate(entry.assessment.assessedAt) : todayISO
}

/**
 * Readiness of one saved assessment with the one exclusion rule every CIS view uses: the CIS
 * page headline, the Level summary, the exclusions panel, the trend, the portfolio, the
 * Governance CIS card, the readiness CSV and JSON and the PDF. Per Level, an exception counts
 * when it applies on the as-of date of exclusionsAsOf: created on or before that date and not
 * expired by then. Raw rates never change; exclusions only add the rate with exclusions.
 */
export function readinessFor(entry: CisReadinessEntry, workspace: CisReadinessWorkspace, todayISO: string = localDate(), denominator?: DenominatorEntry[]): CisReadinessSummary {
  const dates = new Map<KitLevel, string>()
  const asOf = (level: KitLevel) => {
    let date = dates.get(level)
    if (date === undefined) dates.set(level, date = exclusionsAsOf(entry, workspace, level, todayISO))
    return date
  }
  return measure(entry.assessment, entry.policies, denominator, workspace.recommendationList, workspace.exceptions ?? [], asOf)
}

export type ListedExceptionState = "in-use" | "expired" | "later" | "present" | "unscored" | "absent" | "version" | "benchmark"

export interface ListedException {
  exception: CisException
  state: ListedExceptionState
  /** Why a stored exception does not count for this assessment; null when it is in use. */
  note: string | null
  /** The Levels of this assessment whose headline counts it. */
  usedHere: KitLevel[]
  /** Other current headlines that count it, as given by the caller. */
  usedElsewhere: string[]
}

export interface ListedExceptionGroup {
  benchmark: string
  /** True for the benchmark of the assessment on screen, listed first. */
  current: boolean
  levels: { level: KitLevel; items: ListedException[] }[]
}

/**
 * Every stored exception of the workspace, grouped by benchmark with the assessed benchmark
 * first, then by Level, with whether it counts for this assessment. All of them share the
 * exception limit, so exceptions that do not count stay listed and removable, including those of
 * benchmarks with no saved assessment left; they would apply again if the setting regressed.
 */
export function listedExceptions(summary: CisReadinessSummary, assessment: Assessment, policies: BaselinePolicy[], exceptions: CisException[] | undefined, todayISO: string = localDate(), usedElsewhere: ReadonlyMap<string, string[]> = new Map()): ListedExceptionGroup[] {
  const inUse = new Set(summary.levels.flatMap(level => headlineExceptions(level).map(exception => exception.id)))
  const usedHere = (id: string) => summary.levels.filter(level => headlineExceptions(level).some(exception => exception.id === id)).map(level => level.level)
  const statusByKey = new Map<string, Assessment["findings"][number]["status"][]>()
  for (const finding of assessment.findings) {
    const policy = policies[finding.policyIndex]
    if (!policy) continue
    const key = exceptionKey(summary.benchmark, summary.version, levelOf(policy), finding.policyName, finding.settingId)
    statusByKey.set(key, [...(statusByKey.get(key) ?? []), finding.status])
  }
  const groups = new Map<string, Map<KitLevel, ListedException[]>>([[summary.benchmark, new Map(summary.levels.map(level => [level.level, []]))]])
  for (const exception of exceptions ?? []) {
    const current = exception.benchmark === summary.benchmark
    const identity = exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId)
    // The reason comes from the headline that would count it, on that headline's date: a Level 2
    // exclusion a Level 1 recommendation names is judged on the Level 1 date.
    const relevant = summary.levels.find(level => (level.exclusionScope ?? []).includes(identity))
    const asOf = (relevant ?? summary.levels.find(level => level.level === exception.level))?.exclusionsAsOf ?? todayISO
    const statuses = statusByKey.get(identity) ?? []
    const [state, note]: [ListedExceptionState, string | null] = inUse.has(exception.id) ? ["in-use", null]
      : !current ? ["benchmark", "Not used by this assessment"]
      : exception.version !== summary.version ? ["version", `Not in use: version ${exception.version}`]
      : !isActive(exception, asOf) ? ["expired", "Expired"]
      : localDate(exception.createdAt) > asOf ? ["later", "Not in use: added after this assessment"]
      : statuses.length && statuses.every(status => status === "Present") ? ["present", asOf === todayISO ? "Not in use: setting currently present" : "Not in use: setting present in this assessment"]
      : statuses.length ? ["unscored", "Not in use: setting not in a recommendation"]
      : ["absent", "Not in use: setting not in this assessment"]
    const levels = groups.get(exception.benchmark) ?? new Map<KitLevel, ListedException[]>()
    const elsewhere = usedElsewhere.get(exception.id) ?? []
    // An exclusion another current headline counts says so instead of a reason it is unused.
    const shown = state !== "in-use" && elsewhere.length ? `Not used by this assessment. Used by ${elsewhere.join(", ")}` : note
    levels.set(exception.level, [...(levels.get(exception.level) ?? []), { exception, state, note: shown, usedHere: usedHere(exception.id), usedElsewhere: elsewhere }])
    groups.set(exception.benchmark, levels)
  }
  return [...groups].map(([benchmark, levels]) => ({ benchmark, current: benchmark === summary.benchmark, levels: [...levels].sort(([a], [b]) => a - b).map(([level, items]) => ({ level, items })) }))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.benchmark.localeCompare(b.benchmark))
}

/**
 * The stored exclusions of one benchmark listed under the headline they affect: one in use under
 * every Level whose headline counts it, whatever its own policy Level, and one not in use under
 * its own policy Level. A Level that counts N exclusions therefore lists those N.
 */
export function exceptionsByHeadline(group: ListedExceptionGroup): { level: KitLevel; items: ListedException[] }[] {
  const byLevel = new Map<KitLevel, ListedException[]>(group.levels.map(entry => [entry.level, []]))
  for (const item of group.levels.flatMap(entry => entry.items)) {
    for (const level of item.state === "in-use" && item.usedHere.length ? item.usedHere : [item.exception.level]) byLevel.set(level, [...(byLevel.get(level) ?? []), item])
  }
  return [...byLevel].sort(([a], [b]) => a - b).map(([level, items]) => ({ level, items }))
}

/** Keys of the findings an exclusion in use covers: they show an Excluded badge in the findings list. */
export function excludedFindingKeys(summary: CisReadinessSummary, assessment: Assessment, policies: BaselinePolicy[]): Set<string> {
  const inUse = new Set(summary.levels.flatMap(level => headlineExceptions(level).map(exception => exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId))))
  return new Set(assessment.findings.filter(finding => finding.status !== "Present" && policies[finding.policyIndex]
    && inUse.has(exceptionKey(summary.benchmark, summary.version, levelOf(policies[finding.policyIndex]!), finding.policyName, finding.settingId))).map(finding => finding.key))
}
