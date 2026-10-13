import { computeCoverage, type DenominatorEntry } from "./cis-coverage"
import type { KitLevel, KitPack } from "./cis-kit"
import type { Assessment, BaselinePolicy } from "./policies"

export const MANUAL_NOT_ASSESSED_NOTE = "Manual recommendations are not assessed by this view."

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
  assessedAutomated: number
  enumerated: number
  denominator: number | null
  coverage: number | null
  notAssessed: string[]
}

export interface CisReadinessSummary {
  benchmark: string
  version: string
  levels: CisLevelReadiness[]
  manualNote: string
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
 * Pass rate is over assessed settings only. Coverage is present only when an
 * authoritative denominator list was supplied; identifiers in that list that
 * the pack does not enumerate are listed as not assessed.
 */
export function cisReadiness(assessment: Assessment, policies: BaselinePolicy[], denominator?: DenominatorEntry[]): CisReadinessSummary {
  const benchmark = policies.map(policy => textOf(policy, "benchmark")).find(Boolean) ?? "unknown"
  const version = policies.map(policy => textOf(policy, "version")).find(Boolean) ?? ""
  const packsByLevel = new Map<KitLevel, KitPack>()
  for (const policy of policies) {
    const level = levelOf(policy)
    const pack = packsByLevel.get(level) ?? { benchmark, version, level, reference: `${benchmark} ${version} Level ${level}`.trim(), policies: [] as BaselinePolicy[] }
    pack.policies.push(policy)
    packsByLevel.set(level, pack)
  }
  const coverage = computeCoverage({ benchmark, version, packs: [...packsByLevel.values()], ...(denominator ? { denominator } : {}) })
  const coverageByLevel = new Map(coverage.levels.map(level => [level.level, level]))
  const levels: CisLevelReadiness[] = [...packsByLevel.keys()].sort((a, b) => a - b).map(level => {
    const indexes = new Set(policies.map((policy, index) => levelOf(policy) === level ? index : -1).filter(index => index >= 0))
    const findings = assessment.findings.filter(finding => indexes.has(finding.policyIndex))
    const count = (status: string) => findings.filter(finding => finding.status === status).length
    const cov = coverageByLevel.get(level)
    const notAssessed = denominator && cov ? cov.denominatorIds.filter(id => !cov.numeratorIds.includes(id)) : []
    return {
      benchmark, version, level,
      assessedSettings: findings.length,
      present: count("Present"), different: count("Different"), missing: count("Missing"), review: count("Review"),
      passRate: findings.length ? count("Present") / findings.length : null,
      assessedAutomated: cov?.numerator ?? 0,
      enumerated: cov?.enumeratedIds.length ?? 0,
      denominator: cov?.denominator ?? null,
      coverage: cov?.coverage ?? null,
      notAssessed,
    }
  })
  return { benchmark, version, levels, manualNote: MANUAL_NOT_ASSESSED_NOTE }
}
