import type { DriftScanPhase } from "./drift"

export type DriftRunStepState = "done" | "current" | "waiting"

export interface DriftRunStep {
  label: string
  state: DriftRunStepState
}

const STEP_LABELS = ["Check the backups", "List backed-up policies", "Compare the backups", "Check revert history"] as const

const CURRENT_STEP: Record<DriftScanPhase, number> = {
  checking: 0,
  listing: 1,
  comparing: 2,
  history: 3,
}

const PHASE_HEADINGS: Record<DriftScanPhase, string> = {
  checking: "Checking the backups",
  listing: "Listing backed-up policies",
  comparing: "Comparing the backups",
  history: "Checking the revert history",
}

/** The run screen steps for a scan phase. A finished scan shows every step done. */
export function driftRunSteps(phase: DriftScanPhase, done = false): DriftRunStep[] {
  const current = done ? STEP_LABELS.length : CURRENT_STEP[phase]
  return STEP_LABELS.map((label, index) => ({
    label,
    state: index < current ? "done" : index === current ? "current" : "waiting",
  }))
}

/** The run screen heading for a scan phase. A finished scan is loading its saved result. */
export function driftRunHeading(phase: DriftScanPhase, done = false): string {
  return done ? "Finishing the comparison" : PHASE_HEADINGS[phase]
}
