import { capabilityComparison, type NativeAssessment } from './native'
import type { CapabilityResult, CollectionCoverage, CompliancePlatform } from './types'

/**
 * How each capability of a saved comparison was counted, with the plain reason, so a score
 * can be traced item by item. The result always comes from capabilityComparison, the rule
 * the Frameworks page and the scores count with; this module only explains it.
 */

export type ComparisonResult = ReturnType<typeof capabilityComparison>

/** The reason a capability was counted as `result`; the result itself is capabilityComparison. */
function verdictReason(result: CapabilityResult, counted: ComparisonResult): string {
  const checks = result.checks.filter(check => check.assessmentStatus !== 'outsideScope')
  const assigned = checks.filter(check => check.assignment?.state === 'assigned')
  const unassigned = checks.filter(check => check.assessmentStatus === 'checked' && check.assignment?.state === 'notAssigned')
  switch (counted) {
    case 'outsideScope': return 'Outside the comparison scope.'
    case 'matches': return 'An assigned policy sets the expected value.'
    case 'different': return 'An assigned policy sets a different value.'
    case 'unableToCheck':
      if (checks.some(check => check.assessmentStatus === 'unableToCheck' && check.assignment?.state !== 'notAssigned')) return 'A related setting could not be checked, counted unknown.'
      if (checks.some(check => check.assignment?.state === 'unknown')) return 'The assignment of the configuring policy is unknown, counted unknown.'
      if (checks.some(check => check.assessmentStatus === 'checked' && !check.assignment)) return 'The assignment of the configuring policy was not read, counted unknown.'
      return checks.length ? 'No setting could be checked, counted unknown.' : 'No configuration check exists for this capability, counted unknown.'
    case 'missing':
      if (checks.some(check => check.assessmentStatus === 'checked' && check.result === 'missing' && (!check.assignment || check.assignment.state === 'assigned'))) return 'No assigned policy configures the expected setting.'
      if (assigned.some(check => check.assessmentStatus === 'checked' && check.result === 'matches')) return 'An assigned policy covers only part of the requirement, counted missing.'
      if (unassigned.some(check => check.result === 'matches')) return 'Configured but unassigned, counted missing.'
      if (unassigned.some(check => check.result === 'different')) return 'Configured with a different value but unassigned, counted missing.'
      return 'No assigned policy configures the expected setting.'
  }
}

/** The counted result of one capability and why it was counted that way. */
export function capabilityVerdict(result: CapabilityResult): { result: ComparisonResult; reason: string } {
  const counted = capabilityComparison(result)
  return { result: counted, reason: verdictReason(result, counted) }
}

/**
 * Collection families whose read failed or is unknown, so evidence in them may be missing.
 * Families marked notCollected are not read by design (no detector uses them, or the
 * platform is outside the comparison scope) and are not a read gap. The Frameworks page
 * and the scores both use this rule, so they agree on partial collection for one run.
 */
export function collectionReadGaps(coverage: readonly CollectionCoverage[] | undefined): CollectionCoverage[] {
  return (coverage ?? []).filter(row => row.status === 'incomplete' || row.status === 'unknown' || row.errors.length > 0)
}

/** How a capability or framework reference was counted, in the words of the score card. */
export type CountedResult = 'matching' | 'different' | 'missing' | 'unknown' | 'outsideScope'

export const COUNTED_RESULT: Record<ComparisonResult, CountedResult> = { matches: 'matching', different: 'different', missing: 'missing', unableToCheck: 'unknown', outsideScope: 'outsideScope' }

/**
 * One counted item of a comparison: a capability, or a framework reference without a
 * configuration check (comparisonCounts counts those once each). The items of a run add up
 * to its comparisonCounts exactly.
 */
export interface CountedItem {
  id: string
  name: string
  kind: 'capability' | 'reference'
  platform: CompliancePlatform | null
  result: CountedResult
  reason: string
}

export function countedItems(run: NativeAssessment): CountedItem[] {
  const items: CountedItem[] = run.assessment.capabilities.map(result => {
    const verdict = capabilityVerdict(result)
    return { id: result.capability.id, name: result.capability.name, kind: 'capability', platform: result.capability.platform, result: COUNTED_RESULT[verdict.result], reason: verdict.reason }
  })
  for (const control of run.assessment.frameworks[0]?.controls ?? []) {
    if (!control.unavailableCheck) continue
    const outside = control.unavailableCheck.assessmentStatus === 'outsideScope'
    items.push({
      id: control.control.id,
      name: `${control.control.id} ${control.control.title}`,
      kind: 'reference',
      platform: null,
      result: outside ? 'outsideScope' : 'unknown',
      reason: control.unavailableCheck.reason ?? (outside ? 'Outside the comparison scope.' : 'No configuration check exists for this framework reference, counted unknown.'),
    })
  }
  return items
}
