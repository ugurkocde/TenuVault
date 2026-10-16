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
  /** The exclusions in use for this Level: active on the as-of date and matching a non-Present finding. */
  exceptions: CisException[]
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
  /** Exclusions in use for this Level. */
  exclusions: number
  exclusionsAsOf: string
}

/**
 * The one headline of a Level that every view and export shows: the raw rate on the headline
 * basis, and next to it the rate with exclusions when any exclusion is in use. The count of
 * exclusions is the number of exclusions in use, the same count as "Excluded from score".
 */
export function levelHeadline(level: Pick<CisLevelReadiness, "passRate" | "adjustedPassRate" | "recommendations" | "recommendationPassRate" | "adjustedRecommendationPassRate" | "exceptions" | "exclusionsAsOf">): CisHeadline {
  const head = headlineRate(level)
  const exclusions = level.exceptions?.length ?? 0
  return { basis: head.basis, label: headlineLabel(head.basis), rate: head.rate, adjusted: exclusions && head.adjusted !== null ? head.adjusted : null, exclusions, exclusionsAsOf: level.exclusionsAsOf }
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

/** The label printed wherever a coverage ratio appears, naming where its denominator came from. */
export function coverageSourceLabel(source: DenominatorSource): string {
  if (source === "authoritative") return "Authoritative denominator"
  if (source === "breakout-proxy") return "Breakout proxy, illustrative"
  return "Not computable"
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
  return measure(assessment, policies, denominator, recommendationList, (exceptions ?? []).filter(exception => isActive(exception, today)), () => today)
}

/** Readiness with the exceptions that apply already chosen, and the date each Level judged them on. */
function measure(assessment: Assessment, policies: BaselinePolicy[], denominator: DenominatorEntry[] | undefined, recommendationList: RecommendationList | undefined, applicable: CisException[], asOf: (level: KitLevel) => string): CisReadinessSummary {
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
  // Applicable exceptions by identity, to judge recommendations whose findings sit at any Level.
  const activeExceptionKeys = new Set(applicable.filter(exception => exception.benchmark === benchmark && exception.version === version)
    .map(exception => exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId)))
  const findingByKey = new Map(assessment.findings.map(finding => [finding.key, finding]))
  const findingExcepted = (finding: Assessment["findings"][number]) => activeExceptionKeys.has(exceptionKey(benchmark, version, policies[finding.policyIndex] ? levelOf(policies[finding.policyIndex]!) : 1, finding.policyName, finding.settingId))
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
    const findingKeys = new Set(findings.filter(finding => finding.status !== "Present").map(finding => exceptionKey(benchmark, version, level, finding.policyName, finding.settingId)))
    const levelExceptions = applicable.filter(exception => exception.level === level && exception.benchmark === benchmark && exception.version === version && findingKeys.has(exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId)))
    const exceptedKeys = new Set(levelExceptions.map(exception => exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId)))
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
      exceptions: levelExceptions,
      adjustedPassRate: findings.length ? (count("Present") + excepted) / findings.length : null,
      exclusionsAsOf: asOf(level),
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
      ...recommendationRates(recommendations.filter(result => result.level === level), result => {
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

/** The Levels a saved assessment measures, read from its pack policies. */
function packLevels(policies: BaselinePolicy[]): Set<KitLevel> {
  return new Set(policies.map(levelOf))
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
  const time = timeOf(entry)
  const newer = workspace.history.some(other => other.assessment.runId !== entry.assessment.runId && timeOf(other) > time && packLevels(other.policies).has(level) && (() => {
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
  const applicable = (workspace.exceptions ?? []).filter(exception => appliesOn(exception, asOf(exception.level)))
  return measure(entry.assessment, entry.policies, denominator, workspace.recommendationList, applicable, asOf)
}

export type ListedExceptionState = "in-use" | "expired" | "later" | "present" | "absent" | "version"

export interface ListedException {
  exception: CisException
  state: ListedExceptionState
  /** Why a stored exception does not count for this assessment; null when it is in use. */
  note: string | null
}

/**
 * Every stored exception of the assessed benchmark, by Level, with whether it counts for this
 * assessment. Exceptions that do not count stay listed and removable: they still take a place
 * under the exception limit and would apply again if the setting regressed.
 */
export function listedExceptions(summary: CisReadinessSummary, assessment: Assessment, policies: BaselinePolicy[], exceptions: CisException[] | undefined, todayISO: string = localDate()): { level: KitLevel; items: ListedException[] }[] {
  const inUse = new Set(summary.levels.flatMap(level => level.exceptions.map(exception => exception.id)))
  const statusByKey = new Map<string, Assessment["findings"][number]["status"][]>()
  for (const finding of assessment.findings) {
    const policy = policies[finding.policyIndex]
    if (!policy) continue
    const key = exceptionKey(summary.benchmark, summary.version, levelOf(policy), finding.policyName, finding.settingId)
    statusByKey.set(key, [...(statusByKey.get(key) ?? []), finding.status])
  }
  const groups = new Map<KitLevel, ListedException[]>()
  for (const level of summary.levels) groups.set(level.level, [])
  for (const exception of exceptions ?? []) {
    if (exception.benchmark !== summary.benchmark) continue
    const asOf = summary.levels.find(level => level.level === exception.level)?.exclusionsAsOf ?? todayISO
    const statuses = statusByKey.get(exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId)) ?? []
    const [state, note]: [ListedExceptionState, string | null] = inUse.has(exception.id) ? ["in-use", null]
      : exception.version !== summary.version ? ["version", `Not in use: version ${exception.version}`]
      : !isActive(exception, asOf) ? ["expired", "Expired"]
      : localDate(exception.createdAt) > asOf ? ["later", "Not in use: added after this assessment"]
      : statuses.length ? ["present", asOf === todayISO ? "Not in use: setting currently present" : "Not in use: setting present in this assessment"]
      : ["absent", "Not in use: setting not in this assessment"]
    groups.set(exception.level, [...(groups.get(exception.level) ?? []), { exception, state, note }])
  }
  return [...groups].sort(([a], [b]) => a - b).map(([level, items]) => ({ level, items }))
}

/** Keys of the findings an exclusion in use covers: they show an Excluded badge in the findings list. */
export function excludedFindingKeys(summary: CisReadinessSummary, assessment: Assessment, policies: BaselinePolicy[]): Set<string> {
  const inUse = new Set(summary.levels.flatMap(level => level.exceptions.map(exception => exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId))))
  return new Set(assessment.findings.filter(finding => finding.status !== "Present" && policies[finding.policyIndex]
    && inUse.has(exceptionKey(summary.benchmark, summary.version, levelOf(policies[finding.policyIndex]!), finding.policyName, finding.settingId))).map(finding => finding.key))
}
