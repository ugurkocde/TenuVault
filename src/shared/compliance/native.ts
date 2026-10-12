import type { CapabilityResult, ComplianceAssessment } from './types'

export const FRAMEWORK_SOURCE_COMMIT = '38998301541c06a6a4a2f6e099277a6c39eb84f6'
export const FRAMEWORK_USAGE_NOTICE = 'Independent TenuVault configuration mapping. Framework names and identifiers are factual references. No publisher affiliation, endorsement, audit opinion, certification or complete compliance assessment is implied. Expected values are our technical interpretation. A configuration match does not prove effective access or device enforcement.'

export interface NativeAssessment {
  schemaVersion: 1
  runId: string
  tenantId: string
  frameworkId: string
  sourceCommit: string
  snapshotSha256: string
  rulesetSha256: string
  licenseNotice: string
  assessment: ComplianceAssessment
}

/** One vote per capability, using the best evidence on an assigned policy. */
export function capabilityComparison(result: CapabilityResult): 'matches' | 'different' | 'missing' | 'unableToCheck' | 'outsideScope' {
  const checks = result.checks.filter(check => check.assessmentStatus !== 'outsideScope')
  if (result.status === 'notApplicable' || (!checks.length && result.checks.length)) return 'outsideScope'
  const assigned = checks.filter(check => check.assignment?.state === 'assigned')
  const matching = assigned.filter(check => check.assessmentStatus === 'checked' && check.result === 'matches')
  const groups = result.capability.requiredGroups ?? []
  const positive = result.evidence.filter(item => item.assignment.state === 'assigned' && item.verdict === 'enforced' && (item.kind !== 'complianceRequirement' || item.blockAction === true))
  const complete = !groups.length || positive.some(candidate => groups.every(group =>
    positive.some(item => item.policyId === candidate.policyId && item.policyType === candidate.policyType && item.requirementGroup === group),
  ))
  const requirement = result.evidence.some(item => item.assignment.state === 'assigned' && item.verdict === 'enforced' && item.kind === 'complianceRequirement' && item.blockAction === true && !item.requirementGroup)
  if (matching.length && (complete || requirement)) return 'matches'
  if (assigned.some(check => check.assessmentStatus === 'checked' && check.result === 'different')) return 'different'
  if (checks.some(check => check.assessmentStatus === 'checked' && check.result === 'missing' && (!check.assignment || check.assignment.state === 'assigned'))) return 'missing'
  if (checks.some(check => check.assessmentStatus === 'unableToCheck' && (!check.assignment || check.assignment.state !== 'notAssigned')) || checks.some(check => check.assignment?.state === 'unknown')) return 'unableToCheck'
  if (matching.length || checks.some(check => check.assessmentStatus === 'checked' && (check.result === 'missing' || check.assignment?.state === 'notAssigned'))) return 'missing'
  return 'unableToCheck'
}

export function comparisonCounts(run: NativeAssessment) {
  const counts = { matches: 0, different: 0, missing: 0, unableToCheck: 0, outsideScope: 0 }
  for (const result of run.assessment.capabilities) counts[capabilityComparison(result)]++
  for (const control of run.assessment.frameworks[0]?.controls ?? []) if (control.unavailableCheck) counts[control.unavailableCheck.assessmentStatus === 'outsideScope' ? 'outsideScope' : 'unableToCheck']++
  return counts
}

export function nativeChecksCSV(run: NativeAssessment): string {
  const quote = (value: unknown) => {
    let text = String(value ?? '')
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }
  const rows: unknown[][] = [['Framework', 'Mapping version', 'Capability', 'Setting', 'Status', 'Expected', 'Observed', 'Policy ID', 'Policy name', 'Assignment', 'Reason']]
  for (const cap of run.assessment.capabilities) for (const c of cap.checks) rows.push([run.frameworkId, run.assessment.provenance.rulesetVersion, cap.capability.name, c.settingId, c.assessmentStatus === 'checked' ? c.result : c.assessmentStatus, c.expectedValue, c.actualValue, c.policyId, c.policyName, c.assignment?.state, c.reason])
  return rows.map(row => row.map(quote).join(',')).join('\r\n')
}

export function compareNativeAssessments(previous: NativeAssessment, current: NativeAssessment) {
  const normalizeScope = (run: NativeAssessment) => JSON.stringify({ ...run.assessment.scope, platforms: [...(run.assessment.scope.platforms ?? [])].sort() })
  if (previous.tenantId !== current.tenantId || previous.frameworkId !== current.frameworkId) throw new Error('Choose comparisons for the same tenant and framework.')
  if (previous.rulesetSha256 !== current.rulesetSha256 || normalizeScope(previous) !== normalizeScope(current)) throw new Error('Scope or ruleset changed. These runs cannot be compared as tenant configuration drift.')
  const observations = (run: NativeAssessment) => {
    const entries = new Map<string, string[]>()
    for (const cap of run.assessment.capabilities) for (const check of cap.checks) {
      const key = `${cap.capability.id}:${check.settingId}:${check.policyId ?? ''}`
      const values = entries.get(key) ?? []
      values.push(JSON.stringify({ status: check.assessmentStatus, result: check.result, expected: check.expectedValue, observed: check.actualValue, assignment: check.assignment }))
      entries.set(key, values)
    }
    return new Map([...entries].map(([key, values]) => [key, JSON.stringify(values.sort())]))
  }
  const before = observations(previous), after = observations(current)
  return [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key)).map(key => ({ setting: key, previous: before.get(key) ?? 'Not observed', current: after.get(key) ?? 'Not observed' }))
}
