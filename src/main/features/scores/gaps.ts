import { capabilityVerdict, collectionReadGaps } from "../../../shared/compliance/counted"
import type { NativeAssessment } from "../../../shared/compliance/native"
import type { TechnicalCheck } from "../../../shared/compliance/types"
import type { Gap, GapPolicy, GapSetting } from "./formula"

/** One observation behind a counted gap; "matches" appears only on a policy that is not assigned. */
export interface CountedGapSetting extends Omit<GapSetting, "result"> {
  result: "matches" | "different" | "missing"
}

/**
 * An actionable gap: one capability counted different or missing, so the gaps of a card
 * always equal its different plus missing count and a capability counted matching is never
 * a gap. `countedAs` says why it was counted that way, for example configured but unassigned.
 * `mixed` means an assigned policy matches part of the capability, which needs a targeting
 * review before anyone treats it as fixed or broken.
 */
export interface CountedGap extends Omit<Gap, "settings"> {
  countedAs: string
  settings: CountedGapSetting[]
}

const MAX_GAP_SETTINGS = 25

/** A checked observation that explains a counted gap: a failing value, or a match on a policy that is not assigned. */
function explainsGap(check: TechnicalCheck): check is TechnicalCheck & { result: CountedGapSetting["result"] } {
  if (check.assessmentStatus !== "checked") return false
  return check.result === "different" || check.result === "missing" || (check.result === "matches" && check.assignment?.state !== "assigned")
}

/** Every capability counted different or missing, in the order the capabilities appear. */
export function countedGaps(run: NativeAssessment): CountedGap[] {
  const controls = run.assessment.frameworks[0]?.controls ?? []
  const gaps: CountedGap[] = []
  for (const result of run.assessment.capabilities) {
    const checks = Array.isArray(result.checks) ? result.checks : []
    const verdict = capabilityVerdict({ ...result, checks, evidence: Array.isArray(result.evidence) ? result.evidence : [] })
    if (verdict.result !== "different" && verdict.result !== "missing") continue
    const explaining = checks.filter(explainsGap)
    const policies = new Map<string, GapPolicy>()
    for (const check of explaining) {
      if (check.policyId) policies.set(check.policyId, { policyId: check.policyId, policyName: check.policyName ?? "Unnamed policy", assignment: check.assignment?.state ?? "unknown" })
    }
    gaps.push({
      key: result.capability.id,
      capabilityId: result.capability.id,
      capabilityName: result.capability.name,
      platform: result.capability.platform,
      capabilityStatus: result.status,
      result: verdict.result,
      countedAs: verdict.reason,
      mixed: checks.some((check) => check.assessmentStatus === "checked" && check.result === "matches" && check.assignment?.state === "assigned"),
      settings: explaining.slice(0, MAX_GAP_SETTINGS).map((check) => ({ settingId: check.settingId, result: check.result, expected: check.expectedValue, observed: check.actualValue, policyId: check.policyId ?? null, reason: check.reason ?? null })),
      settingIds: [...new Set(explaining.map((check) => check.settingId))],
      policies: [...policies.values()],
      controls: controls.filter((control) => control.capabilityIds.includes(result.capability.id)).map((control) => ({ id: control.control.id, title: control.control.title, evidenceStrength: control.control.evidenceStrength ?? null })),
      unknownChecks: checks.filter((check) => check.assessmentStatus === "unableToCheck").length,
      limitations: Array.isArray(result.limitations) ? result.limitations.slice(0, 10) : [],
    })
  }
  return gaps
}

/**
 * Collection families whose read failed; any entry means the evidence is partial. The
 * Frameworks page reads the same rule (collectionReadGaps), so both agree for one comparison.
 */
export function partialCollection(run: NativeAssessment): string[] {
  return collectionReadGaps(run.assessment.collectionCoverage).map((row) => `${row.family}: ${row.status}`)
}
