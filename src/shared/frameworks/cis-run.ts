import type { Assessment, BaselinePolicy, Finding } from "./policies"

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

/**
 * The phase a run screen shows. Main reports reading as soon as the job starts, but until the
 * tenant policy list arrives there is nothing to count, so the run still shows as connecting
 * instead of "0 of 0 policies read".
 */
export function cisRunDisplayPhase(run: { phase: CisRunPhase; total: number }): CisRunPhase {
  return run.phase === "reading" && run.total === 0 ? "connecting" : run.phase
}

const PHASE_HEADINGS: Record<CisRunPhase, string> = {
  connecting: "Connecting to the tenant",
  reading: "Reading tenant policies",
  comparing: "Comparing with the benchmark",
  saving: "Saving the assessment",
  done: "Assessment complete",
  failed: "Assessment failed",
}

/** The run screen heading for a phase. A re-run over shown results says so. */
export function cisRunHeading(phase: CisRunPhase, rerun = false): string {
  const heading = PHASE_HEADINGS[phase]
  return rerun ? `Re-running assessment: ${heading.charAt(0).toLowerCase()}${heading.slice(1)}` : heading
}

/** Waits before each re-poll after a failed assess-status request: the job keeps running in the main process. */
export const CIS_STATUS_RETRY_DELAYS_MS = [1000, 2000, 4000] as const

/**
 * Reads one assess-status snapshot. A failed request is retried with backoff a few times
 * before the failure is reported, so one dropped poll does not end a run that is still
 * going. Errors that `retryable` rejects, such as a job that no longer exists, fail at
 * once, and `current` stops retrying once the caller no longer follows this run.
 */
export async function pollCisStatus<T>(read: () => Promise<T>, options: { retryable?: (error: unknown) => boolean; current?: () => boolean; wait?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      const delay = CIS_STATUS_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || options.retryable?.(error) === false || options.current?.() === false) throw error
      await wait(delay)
    }
  }
}

/**
 * The saved assessment a CIS page shows as its current results when it opens: the newest
 * saved assessment, when it was run with the pack the workspace still holds. When a different
 * pack was loaded after it, the page opens on setup with that pack, and the saved assessment
 * stays available under Saved assessments.
 */
export function currentSavedAssessment(workspace: { policies: BaselinePolicy[]; reference: string; history: { assessment: Assessment; policies: BaselinePolicy[] }[] }): { assessment: Assessment; policies: BaselinePolicy[] } | null {
  const latest = workspace.history[0]
  if (!latest || latest.assessment.reference !== workspace.reference) return null
  return JSON.stringify(latest.policies) === JSON.stringify(workspace.policies) ? latest : null
}

export function cisRunSteps(phase: CisRunPhase): CisRunStep[] {
  const current = CURRENT_STEP[phase]
  return STEP_LABELS.map((label, index) => ({
    label,
    state: index < current ? "done" : index === current ? "current" : "waiting",
  }))
}
