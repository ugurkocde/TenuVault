import type { KitLevel, KitPack } from "./cis-kit"
import type { BaselinePolicy } from "./policies"

export type CisStepState = "complete" | "current" | "upcoming"

export interface CisFlowStep {
  step: 1 | 2 | 3
  label: string
  state: CisStepState
}

export const CIS_FLOW_LABELS = ["Import kit", "Choose level and compare", "Review results"] as const

/** Stepper state for the CIS page, derived from whether a kit was converted, whether an assessment exists, and whether a run is active. While a run is active step 2 is current, even when an older assessment is still loaded for a re-run. */
export function cisFlowSteps(hasKitConversion: boolean, hasAssessment: boolean, isRunning = false): CisFlowStep[] {
  if (isRunning) {
    return [
      { step: 1, label: CIS_FLOW_LABELS[0], state: hasKitConversion ? "complete" : "upcoming" },
      { step: 2, label: CIS_FLOW_LABELS[1], state: "current" },
      { step: 3, label: CIS_FLOW_LABELS[2], state: "upcoming" },
    ]
  }
  if (hasAssessment) {
    return [
      { step: 1, label: CIS_FLOW_LABELS[0], state: hasKitConversion ? "complete" : "upcoming" },
      { step: 2, label: CIS_FLOW_LABELS[1], state: "complete" },
      { step: 3, label: CIS_FLOW_LABELS[2], state: "current" },
    ]
  }
  if (hasKitConversion) {
    return [
      { step: 1, label: CIS_FLOW_LABELS[0], state: "complete" },
      { step: 2, label: CIS_FLOW_LABELS[1], state: "current" },
      { step: 3, label: CIS_FLOW_LABELS[2], state: "upcoming" },
    ]
  }
  return [
    { step: 1, label: CIS_FLOW_LABELS[0], state: "current" },
    { step: 2, label: CIS_FLOW_LABELS[1], state: "upcoming" },
    { step: 3, label: CIS_FLOW_LABELS[2], state: "upcoming" },
  ]
}

export type CisStage = "setup" | "running" | "results"

/**
 * The staged view the CIS Benchmarks page shows. A live run owns the screen,
 * a finished assessment shows its results, and setup is shown until an
 * assessment exists or the user explicitly asks for it with New assessment.
 * The setup request is cleared only when a run completes successfully or a
 * saved assessment is viewed, so a failed run returns to the stage it started
 * from and Back to results can clear it without touching the assessment.
 */
export function cisStage(input: { hasRun: boolean; hasAssessment: boolean; setupRequested: boolean }): CisStage {
  if (input.hasRun) return "running"
  if (input.hasAssessment && !input.setupRequested) return "results"
  return "setup"
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
