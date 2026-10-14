import type { KitLevel, KitPack } from "./cis-kit"
import type { BaselinePolicy } from "./policies"

export type CisStepState = "complete" | "current" | "upcoming"

export interface CisFlowStep {
  step: 1 | 2 | 3
  label: string
  state: CisStepState
}

export const CIS_FLOW_LABELS = ["Import kit", "Choose level and compare", "Review results"] as const

/** Stepper state for the CIS page, derived from whether a kit was converted and whether an assessment exists. */
export function cisFlowSteps(hasKitConversion: boolean, hasAssessment: boolean): CisFlowStep[] {
  const current: 1 | 2 | 3 = hasAssessment ? 3 : hasKitConversion ? 2 : 1
  return [
    { step: 1, label: CIS_FLOW_LABELS[0], state: hasKitConversion || hasAssessment ? "complete" : "current" },
    { step: 2, label: CIS_FLOW_LABELS[1], state: hasAssessment ? "complete" : current === 2 ? "current" : "upcoming" },
    { step: 3, label: CIS_FLOW_LABELS[2], state: current === 3 ? "current" : "upcoming" },
  ]
}

/** Total root settings across every policy in one converted pack. */
export function packSettingCount(pack: Pick<KitPack, "policies">): number {
  return pack.policies.reduce((total, policy) => total + policy.settings.length, 0)
}

/** The CIS Level a policy belongs to, from its kit provenance. Defaults to Level 1. */
export function kitLevelForPolicy(policy: BaselinePolicy | undefined): KitLevel {
  const level = policy?.provenance?.level
  return typeof level === "string" && level.includes("2") ? 2 : 1
}

function provenanceText(policy: BaselinePolicy, key: string): string {
  const value = policy.provenance?.[key]
  return typeof value === "string" ? value : ""
}

/** The pack reference a policy would carry, built from its provenance, or an empty string. */
export function packReferenceForPolicy(policy: BaselinePolicy): string {
  const benchmark = provenanceText(policy, "benchmark")
  const version = provenanceText(policy, "version")
  const level = provenanceText(policy, "level")
  if (!benchmark || !level) return ""
  return `${benchmark} ${version} ${level}`.trim()
}

/**
 * Whether the loaded policies came from a kit, shown by the reference matching
 * a converted pack or matching the provenance stamped on the policies.
 */
export function isKitPackReference(reference: string, packReferences: string[], policies: BaselinePolicy[]): boolean {
  if (!reference) return false
  if (packReferences.includes(reference)) return true
  return policies.some((policy) => packReferenceForPolicy(policy) === reference)
}
