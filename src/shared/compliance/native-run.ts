/** The steps a native framework comparison reports, mirroring NativeJobStep in the main process. */
export type NativeRunPhase = 'connecting' | 'collecting' | 'evaluating' | 'saving'

export type NativeRunStepState = 'done' | 'current' | 'waiting'

export interface NativeRunStep {
  label: string
  state: NativeRunStepState
}

const STEP_LABELS = ['Connect to tenant', 'Read tenant policies', 'Compare with the framework', 'Save comparison'] as const

const CURRENT_STEP: Record<NativeRunPhase, number> = {
  connecting: 0,
  collecting: 1,
  evaluating: 2,
  saving: 3,
}

const PHASE_HEADINGS: Record<NativeRunPhase, string> = {
  connecting: 'Connecting to the tenant',
  collecting: 'Reading tenant policies',
  evaluating: 'Comparing with the framework',
  saving: 'Saving the comparison',
}

/** The run screen steps for a comparison phase. A finished comparison shows every step done. */
export function nativeRunSteps(phase: NativeRunPhase, done = false): NativeRunStep[] {
  const current = done ? STEP_LABELS.length : CURRENT_STEP[phase]
  return STEP_LABELS.map((label, index) => ({
    label,
    state: index < current ? 'done' : index === current ? 'current' : 'waiting',
  }))
}

/** The run screen heading for a comparison phase. A finished comparison is loading its saved result. */
export function nativeRunHeading(phase: NativeRunPhase, done = false): string {
  return done ? 'Finishing the comparison' : PHASE_HEADINGS[phase]
}
