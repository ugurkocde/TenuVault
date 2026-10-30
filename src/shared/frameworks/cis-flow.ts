import type { KitLevel, KitPack } from "./cis-kit"
import type { BaselinePolicy } from "./policies"

export type CisStepState = "complete" | "current" | "upcoming"

export interface CisFlowStep {
  step: 1 | 2 | 3
  label: string
  state: CisStepState
}

export const CIS_FLOW_LABELS = ["Load benchmark", "Compare with tenant", "Review results"] as const

/** Stepper state for the CIS page, derived from whether a benchmark pack is loaded, whether an assessment exists, and whether a run is active. While a run is active step 2 is current, even when an older assessment is still loaded for a re-run. */
export function cisFlowSteps(hasPack: boolean, hasAssessment: boolean, isRunning = false): CisFlowStep[] {
  if (isRunning) {
    return [
      { step: 1, label: CIS_FLOW_LABELS[0], state: hasPack ? "complete" : "upcoming" },
      { step: 2, label: CIS_FLOW_LABELS[1], state: "current" },
      { step: 3, label: CIS_FLOW_LABELS[2], state: "upcoming" },
    ]
  }
  if (hasAssessment) {
    return [
      { step: 1, label: CIS_FLOW_LABELS[0], state: hasPack ? "complete" : "upcoming" },
      { step: 2, label: CIS_FLOW_LABELS[1], state: "complete" },
      { step: 3, label: CIS_FLOW_LABELS[2], state: "current" },
    ]
  }
  if (hasPack) {
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
 * The staged view the CIS Benchmarks page shows. A first run owns the screen,
 * a finished assessment shows its results, and setup is shown until an
 * assessment exists or the user explicitly asks for it with New assessment.
 * A re-run over shown results keeps them on screen with its progress above
 * them, so the previous results stay visible until the new ones arrive and
 * after a failed re-run. The setup request is cleared only when a run
 * completes successfully or a saved assessment is viewed, so a failed run
 * returns to the stage it started from and Back to results can clear it
 * without touching the assessment.
 */
export function cisStage(input: { hasRun: boolean; hasAssessment: boolean; setupRequested: boolean }): CisStage {
  if (input.hasRun && (!input.hasAssessment || input.setupRequested)) return "running"
  if (input.hasAssessment && !input.setupRequested) return "results"
  return "setup"
}

/** Total root settings across every policy in one converted pack. */
export function packSettingCount(pack: Pick<KitPack, "policies">): number {
  return pack.policies.reduce((total, policy) => total + policy.settings.length, 0)
}

/**
 * The CIS Level a policy belongs to, from its kit provenance ("Level 2" or 2). Defaults to Level 1.
 * Markers are parsed the way classifyKitFile parses them, so a stray digit in a
 * versioned Level 1 label ("Level 1 (v2)") is not read as Level 2.
 */
export function kitLevelForPolicy(policy: BaselinePolicy | undefined): KitLevel {
  const level = policy?.provenance?.level
  if (level === 2) return 2
  if (typeof level !== "string") return 1
  const exact = /^\s*([12])\s*$/.exec(level)
  if (exact) return Number(exact[1]) as KitLevel
  const levels = new Set<KitLevel>()
  for (const match of level.matchAll(/(?<![a-z0-9])level\s*[-_ ]?([12])(?![a-z0-9])|(?<![a-z0-9])l([12])(?![a-z0-9])/gi)) {
    levels.add(Number(match[1] ?? match[2]) as KitLevel)
  }
  return levels.size === 1 && levels.has(2) ? 2 : 1
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
