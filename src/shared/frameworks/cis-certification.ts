import type { CisLevel } from "./cis-content"

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

/** The short marker shown next to a certified benchmark Level. */
export const CIS_CERTIFIED_LABEL = "CIS Certified"
/** The marker shown next to a benchmark Level outside the certification. */
export const CIS_NOT_CERTIFIED_LABEL = "Not certified"

/** Whether one benchmark, version and Level is inside the certified scope. */
export function isCisCertified(benchmark: string, version: string, level: number): boolean {
  return CIS_CERTIFIED_SEGMENTS.some(segment => segment.benchmark === benchmark && segment.version === version && (segment.levels as readonly number[]).includes(level))
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
  `Manual recommendations and recommendations marked Not assessed by this tool cannot be remediated by ${product}. They are listed for manual action, with their CIS text when the delivered list includes it.`,
  "Findings to Review hold alternative values in the pack. They cannot be selected for remediation until the profile is chosen.",
  "Missing settings are created in new policies with no assignments. Nothing in them takes effect until an administrator assigns them in Intune.",
  "Different settings are updated in place in the tenant policies that hold them. Those policies keep their assignments, so the change reaches their assigned devices.",
  "Remediation changes Intune configuration only. It does not confirm that devices apply the settings. Run the assessment again after an apply to check the result.",
]
export const CIS_REMEDIATION_LIMITS: readonly string[] = cisRemediationLimits()
