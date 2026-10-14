import type { BaselinePolicy, Finding } from "./policies"

export type CisRunPhase = "connecting" | "reading" | "comparing" | "saving" | "done" | "failed"

export interface CisRunAccumulation {
  findings: Finding[]
  since: number
}

export function emptyCisRunAccumulation(): CisRunAccumulation {
  return { findings: [], since: 0 }
}

/**
 * Appends one incremental slice from assess-status to the findings received so
 * far. Slices are disjoint when the caller passes nextSince back as since, but
 * a repeated poll must not duplicate a finding, so keys already seen are
 * dropped. The cursor always advances to nextSince.
 */
export function accumulateCisFindings(current: CisRunAccumulation, slice: Finding[], nextSince: number): CisRunAccumulation {
  const seen = new Set(current.findings.map(finding => finding.key))
  const added = slice.filter(finding => !seen.has(finding.key))
  return {
    findings: added.length ? [...current.findings, ...added] : current.findings,
    since: Math.max(current.since, nextSince),
  }
}

export interface CisRunTallies {
  Present: number
  Different: number
  Missing: number
  Review: number
}

export function cisRunTallies(findings: Finding[]): CisRunTallies {
  const tallies: CisRunTallies = { Present: 0, Different: 0, Missing: 0, Review: 0 }
  for (const finding of findings) tallies[finding.status] += 1
  return tallies
}

export type CisRunStepState = "done" | "current" | "waiting"

export interface CisRunStep {
  label: string
  state: CisRunStepState
}

const STEP_LABELS = ["Connect to tenant", "Read tenant policies", "Compare with the benchmark", "Save assessment"] as const

const CURRENT_STEP: Record<CisRunPhase, number> = {
  connecting: 0,
  reading: 1,
  comparing: 2,
  saving: 3,
  done: STEP_LABELS.length,
  failed: 0,
}

export interface CisRunPack {
  policies: BaselinePolicy[]
  reference: string
}

/**
 * Returns the captured pack when the completed job assessed that same pack,
 * and null when it did not. The completed assessment carries the reference
 * the job was started with, and the snapshot carries the number of pack
 * policies the job compared. Both must match the captured pack before its
 * assessment may be installed against the captured policies.
 */
export function resolveCisRunCompletion(captured: CisRunPack, completed: { reference: string; packPolicies: number }): CisRunPack | null {
  if (completed.reference !== captured.reference) return null
  if (completed.packPolicies !== captured.policies.length) return null
  return captured
}

export function cisRunReceivedLabel(count: number): string {
  return `${count} ${count === 1 ? "finding" : "findings"} received so far (partial results)`
}

export function cisRunSteps(phase: CisRunPhase): CisRunStep[] {
  const current = CURRENT_STEP[phase]
  return STEP_LABELS.map((label, index) => ({
    label,
    state: index < current ? "done" : index === current ? "current" : "waiting",
  }))
}
