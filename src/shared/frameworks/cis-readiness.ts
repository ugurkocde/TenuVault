import { computeCoverage, type DenominatorEntry, type DenominatorSource } from "./cis-coverage"
import { manualItemsForLevel, MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL, type ManualItemView, type RecommendationList } from "./cis-manual"
import type { KitLevel, KitPack } from "./cis-kit"
import type { Assessment, BaselinePolicy } from "./policies"
import { exceptionKey, isActive, type CisException } from "./cis-exceptions"

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
  exceptions: CisException[]
  adjustedPassRate: number | null
  /** Enumerated identifiers that the denominator list marks automated; null without a denominator list. */
  assessedAutomated: number | null
  /** Distinct recommendation identifiers named in the pack policy descriptions of this Level. */
  enumerated: number
  denominator: number | null
  coverage: number | null
  coverageSource: DenominatorSource
  notAssessed: string[]
  manual: ManualItemView[]
}

/** The label printed wherever a coverage ratio appears, naming where its denominator came from. */
export function coverageSourceLabel(source: DenominatorSource): string {
  if (source === "authoritative") return "Authoritative denominator"
  if (source === "breakout-proxy") return "Breakout proxy, illustrative"
  return "Not computable"
}

export interface CisReadinessSummary {
  benchmark: string
  version: string
  levels: CisLevelReadiness[]
  manualNote: string
  manualFallback: string
  manualFallbackUrl: string
  recommendationList?: RecommendationList
}

function levelOf(policy: BaselinePolicy): KitLevel {
  const level = policy.provenance?.level
  return typeof level === "string" && level.includes("2") ? 2 : 1
}

function textOf(policy: BaselinePolicy, key: string): string {
  const value = policy.provenance?.[key]
  return typeof value === "string" ? value : ""
}

/**
 * Readiness per benchmark and Level from one assessment of an imported pack.
 * Pass rate is over assessed settings only. Coverage and the assessed automated
 * count are present only when an authoritative denominator list was supplied;
 * identifiers in that list that the pack does not enumerate are listed as not
 * assessed.
 */
export function cisReadiness(assessment: Assessment, policies: BaselinePolicy[], denominator?: DenominatorEntry[], recommendationList?: RecommendationList, exceptions?: CisException[], todayISO?: string): CisReadinessSummary {
  const policyBenchmark = policies.map(policy => textOf(policy, "benchmark")).find(Boolean)
  const policyVersion = policies.map(policy => textOf(policy, "version")).find(Boolean)
  const listMatches = !recommendationList || ((!policyBenchmark || recommendationList.benchmark === policyBenchmark) && (!policyVersion || recommendationList.version === policyVersion))
  const effectiveList = listMatches ? recommendationList : undefined
  const benchmark = policyBenchmark ?? effectiveList?.benchmark ?? "unknown"
  const version = policyVersion ?? effectiveList?.version ?? ""
  const effectiveDenominator = denominator ?? (effectiveList ? effectiveList.items.map(item => ({ identifier: item.identifier, level: item.level, automated: item.automated })) : undefined)
  const packsByLevel = new Map<KitLevel, KitPack>()
  for (const policy of policies) {
    const level = levelOf(policy)
    const pack = packsByLevel.get(level) ?? { benchmark, version, level, reference: `${benchmark} ${version} Level ${level}`.trim(), policies: [] as BaselinePolicy[] }
    pack.policies.push(policy)
    packsByLevel.set(level, pack)
  }
  const allLevels = new Set<KitLevel>([...packsByLevel.keys(), ...((effectiveList?.items ?? []).map(item => item.level))].sort((a, b) => a - b))
  if (!packsByLevel.size && effectiveList) for (const level of allLevels) packsByLevel.set(level, { benchmark, version, level, reference: `${benchmark} ${version} Level ${level}`.trim(), policies: [] })
  const coverage = computeCoverage({ benchmark, version, packs: [...packsByLevel.values()], ...(effectiveDenominator ? { denominator: effectiveDenominator } : {}) })
  const coverageByLevel = new Map(coverage.levels.map(level => [level.level, level]))
  const today = todayISO ?? new Date().toISOString().slice(0, 10)
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
    const levelExceptions = (exceptions ?? []).filter(exception => isActive(exception, today) && exception.level === level && exception.benchmark === benchmark && exception.version === version && findingKeys.has(exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId)))
    const exceptedKeys = new Set(levelExceptions.map(exception => exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId)))
    const excepted = findings.filter(finding => finding.status !== "Present" && exceptedKeys.has(exceptionKey(benchmark, version, level, finding.policyName, finding.settingId))).length
    return {
      benchmark, version, level,
      assessedSettings: findings.length,
      present: count("Present"), different: count("Different"), missing: count("Missing"), review: count("Review"),
      passRate: findings.length ? count("Present") / findings.length : null,
      excepted,
      exceptions: levelExceptions,
      adjustedPassRate: findings.length ? (count("Present") + excepted) / findings.length : null,
      // Without a denominator list an enumerated identifier cannot be told apart from a manual
      // recommendation or one of another profile, so no automated count is claimed.
      assessedAutomated: cov && cov.denominatorSource !== "none" ? cov.numerator : null,
      enumerated: cov?.enumeratedIds.length ?? 0,
      denominator: cov?.denominator ?? null,
      coverage: cov?.coverage ?? null,
      coverageSource: cov?.denominatorSource ?? "none",
      notAssessed,
      manual,
    }
  })
  return { benchmark, version, levels, manualNote: MANUAL_NOT_ASSESSED_NOTE, manualFallback: MANUAL_RECOMMENDATIONS_FALLBACK, manualFallbackUrl: MANUAL_RECOMMENDATIONS_URL, ...(effectiveList ? { recommendationList: effectiveList } : {}) }
}
