import { record, type RecordJson } from './policies'
export interface AssignmentEvidence {
  state: 'unassigned' | 'configured' | 'review' | 'unavailable'
  targets: Array<{ kind: 'allDevices' | 'allUsers' | 'group' | 'exclusion' | 'unknown'; groupId?: string; filterId?: string; filterMode?: string }>
  limitations: string[]
}
export function assignmentEvidence(assignments: RecordJson[]): AssignmentEvidence {
  const targets: AssignmentEvidence['targets'] = assignments.map(assignment => {
    const target = record(assignment.target) ? assignment.target : {}
    const kinds = { '#microsoft.graph.allDevicesAssignmentTarget': 'allDevices', '#microsoft.graph.allLicensedUsersAssignmentTarget': 'allUsers', '#microsoft.graph.allUsersAssignmentTarget': 'allUsers', '#microsoft.graph.groupAssignmentTarget': 'group', '#microsoft.graph.exclusionGroupAssignmentTarget': 'exclusion' } as const
    const kind = kinds[String(target['@odata.type']) as keyof typeof kinds] ?? 'unknown'
    return { kind, ...(typeof target.groupId === 'string' ? { groupId: target.groupId } : {}),
      ...(typeof target.deviceAndAppManagementAssignmentFilterId === 'string' && target.deviceAndAppManagementAssignmentFilterId ? { filterId: target.deviceAndAppManagementAssignmentFilterId } : {}),
      ...(typeof target.deviceAndAppManagementAssignmentFilterType === 'string' ? { filterMode: target.deviceAndAppManagementAssignmentFilterType } : {}) }
  })
  const limitations: string[] = []
  if (targets.some(target => target.kind === 'unknown' || ((target.kind === 'group' || target.kind === 'exclusion') && !target.groupId))) limitations.push('An assignment target is unsupported or incomplete.')
  if (targets.some(target => target.kind === 'group' || target.kind === 'exclusion')) limitations.push('Group membership and exclusion overlap require separate validation.')
  if (targets.some(target => target.filterId || (target.filterMode && target.filterMode !== 'none'))) limitations.push('Assignment filter evaluation and device applicability are not observed.')
  if (targets.length && targets.every(target => target.kind === 'exclusion')) limitations.push('Only exclusions were found; no included target was observed.')
  return { state: !targets.length ? 'unassigned' : limitations.length ? 'review' : 'configured', targets, limitations }
}
