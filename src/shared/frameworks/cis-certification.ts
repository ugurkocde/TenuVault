import type { CisLevel } from "./cis-content"
import { MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL, type ManualItemView } from "./cis-manual"
import type { RecommendationResult } from "./cis-recommendations"
import type { Finding } from "./policies"

/**
 * The CIS certification of TenuVault and its exact scope, in one place so the CIS Benchmarks
 * page, the benchmark picker, the readiness PDF and every CIS export say the same thing.
 * CIS awarded "CIS Benchmark Assessment Certified" and "CIS Benchmark Remediation Certified"
 * status on 2 November 2026 for the segments below only. Any other benchmark, version or
 * Level is not certified and must never be presented as certified.
 */
export interface CisCertifiedSegment {
  /** Benchmark id as the delivery service names it. */
  benchmark: string
  version: string
  levels: readonly CisLevel[]
  /** The official benchmark name, with its version. */
  name: string
}

export const CIS_CERTIFIED_SEGMENTS: readonly CisCertifiedSegment[] = [
  { benchmark: "intune-windows11", version: "5.0.0", levels: [1], name: "CIS Microsoft Intune for Windows 11 Benchmark v5.0.0" },
  { benchmark: "intune-for-defender", version: "1.0.0", levels: [1, 2], name: "CIS Microsoft Intune for Microsoft Defender Antivirus Benchmark v1.0.0" },
  { benchmark: "mac-os-26", version: "1.0.0", levels: [1, 2], name: "CIS Apple macOS 26 Tahoe Intune Benchmark v1.0.0" },
]

/**
 * How many recommendations of each certified benchmark Level TenuVault checks automatically, out of
 * all recommendations of that Level. The rest are listed for a manual check. Numbers only, never
 * recommendation content, so plans without CIS Benchmarks can be shown them.
 */
export interface CisLevelCheckCount {
  benchmark: string
  version: string
  level: CisLevel
  automated: number
  total: number
}

export const CIS_CERTIFIED_CHECK_COUNTS: readonly CisLevelCheckCount[] = [
  { benchmark: "intune-windows11", version: "5.0.0", level: 1, automated: 274, total: 308 },
  { benchmark: "intune-for-defender", version: "1.0.0", level: 1, automated: 52, total: 52 },
  { benchmark: "intune-for-defender", version: "1.0.0", level: 2, automated: 3, total: 3 },
  { benchmark: "mac-os-26", version: "1.0.0", level: 1, automated: 88, total: 90 },
  { benchmark: "mac-os-26", version: "1.0.0", level: 2, automated: 10, total: 10 },
]

/** The check count of one certified benchmark Level, or undefined outside the certified scope. */
export function cisCheckCount(benchmark: string, version: string, level: number): CisLevelCheckCount | undefined {
  return CIS_CERTIFIED_CHECK_COUNTS.find(count => count.benchmark === benchmark && count.version === version && count.level === level)
}

/** "TenuVault checks 274 of 308 recommendations automatically; the rest are listed for a manual check." */
export function cisCheckCountText(count: Pick<CisLevelCheckCount, "automated" | "total">, product = "TenuVault"): string {
  return count.automated === count.total
    ? `${product} checks all ${count.total} recommendations automatically.`
    : `${product} checks ${count.automated} of ${count.total} recommendations automatically; the rest are listed for a manual check.`
}

/** The short marker shown next to a certified benchmark Level. */
export const CIS_CERTIFIED_LABEL = "CIS Certified"
/** The marker shown next to a benchmark Level outside the certification. */
export const CIS_NOT_CERTIFIED_LABEL = "Not certified"

/** Whether one benchmark, version and Level is inside the certified scope. */
export function isCisCertified(benchmark: string, version: string, level: number): boolean {
  return CIS_CERTIFIED_SEGMENTS.some(segment => segment.benchmark === benchmark && segment.version === version && (segment.levels as readonly number[]).includes(level))
}

/** The benchmark id, version and Level of a pack reference such as "intune-windows11 5.0.0 Level 1", or null for any other form. */
export function parsePackReference(reference: string): { benchmark: string; version: string; level: CisLevel } | null {
  const match = /^([a-z0-9-]+) (\S+) Level ([12])$/.exec(reference.trim())
  return match ? { benchmark: match[1]!, version: match[2]!, level: Number(match[3]) as CisLevel } : null
}

/**
 * Whether an assessment of the pack a reference names is inside the certified scope. A Build Kit
 * import is never certified, even of a certified benchmark; neither is a reference of another form.
 */
export function isCisCertifiedReference(reference: string, { kitImport = false }: { kitImport?: boolean } = {}): boolean {
  const parsed = kitImport ? null : parsePackReference(reference)
  return !!parsed && isCisCertified(parsed.benchmark, parsed.version, parsed.level)
}

function levelsText(levels: readonly CisLevel[]): string {
  return levels.length === 1 ? `Level ${levels[0]}` : `Level ${levels.slice(0, -1).join(", Level ")} and Level ${levels[levels.length - 1]}`
}

/** Each certified segment as one line, such as "CIS ... Benchmark v5.0.0, Level 1". */
export function certifiedScopeLines(): string[] {
  return CIS_CERTIFIED_SEGMENTS.map(segment => `${segment.name}, ${levelsText(segment.levels)}`)
}

/**
 * The certification headline. `product` is the name a white label PDF prints instead of
 * TenuVault; the certification is TenuVault's, so a white label report names the software
 * without naming another company as certified.
 */
export function cisCertificationHeadline(product = "TenuVault"): string {
  return product === "TenuVault"
    ? "TenuVault is CIS Benchmarks Certified for Assessment and Remediation."
    : "The software that produced this report is CIS Benchmarks Certified for Assessment and Remediation."
}
export const CIS_CERTIFICATION_HEADLINE = cisCertificationHeadline()
export const CIS_CERTIFICATION_SCOPE_INTRO = "The certification covers only these benchmarks and Levels:"
export const CIS_NOT_CERTIFIED_NOTE = "Other CIS Benchmarks, versions and Levels are not certified."

/** The full certification statement in one paragraph, for exports and reports. */
export function cisCertificationStatement(product = "TenuVault"): string {
  return `${cisCertificationHeadline(product)} ${CIS_CERTIFICATION_SCOPE_INTRO} ${certifiedScopeLines().join("; ")}. ${CIS_NOT_CERTIFIED_NOTE}`
}
export const CIS_CERTIFICATION_STATEMENT = cisCertificationStatement()

/** What a result is not: the certification is the product's, never the tenant's. */
export const CIS_TENANT_NOT_CERTIFIED_NOTE = "Results compare the recorded Intune configuration with the benchmark pack. They do not certify the tenant's compliance with a CIS Benchmark."

/**
 * The limits of remediation, as the remediation engine applies them (cis-remediation/engine.ts):
 * plans hold only Different and Missing findings of pack settings, Missing settings go into new
 * policies created without assignments, Different settings update the tenant policies that hold
 * them in place and keep their assignments, and Review findings are refused until the profile
 * is chosen.
 */
export const cisRemediationLimits = (product = "TenuVault"): string[] => [
  `${product} remediates only recommendations it assesses automatically: the settings in the delivered benchmark pack, written to Intune Settings Catalog policies.`,
  `Manual recommendations and recommendations marked Not covered by the benchmark pack cannot be remediated by ${product}. They are listed for manual action, with their CIS text when the delivered list includes it.`,
  "Findings to Review hold alternative values in the pack. They cannot be selected for remediation until the profile is chosen.",
  "Missing settings are created in new policies with no assignments. Nothing in them takes effect until an administrator assigns them in Intune.",
  "Different settings are updated in place in the tenant policies that hold them. Those policies keep their assignments, so the change reaches their assigned devices.",
  "Remediation changes Intune configuration only. It does not confirm that devices apply the settings. Run the assessment again after an apply to check the result.",
]
export const CIS_REMEDIATION_LIMITS: readonly string[] = cisRemediationLimits()

/** The CIS notice for recommendations this tool does not include, with its link, unchanged on every CIS export. */
export const CIS_NOTICE = { text: MANUAL_RECOMMENDATIONS_FALLBACK, url: MANUAL_RECOMMENDATIONS_URL } as const

/**
 * Every disclosure a CIS export carries: the certified scope, the limits of remediation and the
 * CIS notice with its link. Exports that are a table add them as preamble rows, the others as fields.
 */
export function cisDisclosures(product = "TenuVault") {
  return {
    certification: {
      statement: cisCertificationStatement(product),
      certifiedScope: CIS_CERTIFIED_SEGMENTS.map(segment => ({ benchmark: segment.benchmark, version: segment.version, levels: [...segment.levels], name: segment.name })),
      note: CIS_TENANT_NOT_CERTIFIED_NOTE,
    },
    remediationLimits: cisRemediationLimits(product),
    cisNotice: { text: CIS_NOTICE.text, url: CIS_NOTICE.url },
  }
}

/**
 * Whether the remediation engine (cis-remediation/engine.ts) can change a finding, by its status.
 * The engine plans exactly the findings this calls "remediable"; Review findings hold alternative
 * values in the pack and are refused until the profile is chosen; Present findings need no change.
 */
export type FindingRemediation = "remediable" | "profile-choice" | "no-change"
export function findingRemediation(status: Finding["status"]): FindingRemediation {
  return status === "Different" || status === "Missing" ? "remediable" : status === "Review" ? "profile-choice" : "no-change"
}

/** How a recommendation can be remediated: by the product, by it after a profile choice, partly, or only by hand. */
export type RemediationKind = "product" | "profile-choice" | "partial" | "manual"
export interface RemediationIndication {
  kind: RemediationKind
  /** For example "by TenuVault" or "manual action". */
  short: string
  /** For example "Remediation: by TenuVault". */
  label: string
  reason: string
}

/** profileChoice marks a partial indication whose product part needs a profile choice first. */
function indication(kind: RemediationKind, product: string, reason: string, profileChoice = false): RemediationIndication {
  const short = kind === "product" ? `by ${product}`
    : kind === "profile-choice" ? `by ${product} after a profile choice`
      : kind === "partial" ? `partly by ${product}${profileChoice ? " after a profile choice" : ""}, partly manual action`
        : "manual action"
  return { kind, short, label: `Remediation: ${short}`, reason }
}

/**
 * The remediation indication of an assessed pack recommendation, from the same data the
 * remediation engine plans from: each declared setting is in the delivered pack (a finding holds
 * it) or not (Unmapped), and a setting whose finding is Review needs a profile choice first
 * (findingRemediation). Settings the pack does not hold cannot be written by the product.
 */
export function recommendationRemediation(recommendation: Pick<RecommendationResult, "settings">, product = "TenuVault"): RemediationIndication {
  const statuses = recommendation.settings.map(setting => setting.status)
  const unmapped = statuses.filter(status => status === "Unmapped").length
  if (!statuses.length || unmapped === statuses.length) return indication("manual", product, `None of its settings are in the delivered benchmark pack, so ${product} cannot write them.`)
  const profileChoice = statuses.some(status => status !== "Unmapped" && findingRemediation(status) === "profile-choice")
  if (unmapped) {
    const choice = profileChoice ? " The pack holds alternative values for one of those settings: choose the profile before it can be remediated." : ""
    return indication("partial", product, `${product} remediates its settings that are in the delivered benchmark pack; the others are not in the pack and need manual action.${choice}`, profileChoice)
  }
  if (profileChoice) return indication("profile-choice", product, "The pack holds alternative values for one of its settings. Choose the profile before it can be remediated.")
  return indication("product", product, `Its settings are in the delivered benchmark pack. ${product} remediates Different and Missing settings with a reviewed deployment.`)
}

/** Manual and Not covered recommendations are never remediated by the product. */
export function manualRemediation(item: Pick<ManualItemView, "state">, product = "TenuVault"): RemediationIndication {
  return indication("manual", product, item.state === "Manual"
    ? `CIS lists it as a manual recommendation. ${product} does not assess or remediate it.`
    : `The delivered benchmark pack does not cover it. ${product} does not assess or remediate it.`)
}

/** The remediation indication of one finding, for findings exports. */
export function findingRemediationIndication(status: Finding["status"], product = "TenuVault"): RemediationIndication {
  const kind = findingRemediation(status)
  if (kind === "profile-choice") return indication("profile-choice", product, "The pack holds alternative values for this setting. Choose the profile before it can be remediated.")
  return indication("product", product, kind === "remediable" ? `${product} can remediate this setting with a reviewed deployment.` : "The setting already matches; no change is needed.")
}
