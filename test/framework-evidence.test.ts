import { expect, it } from 'vitest'
import { assignmentEvidence } from '../src/shared/frameworks/evidence'
it('distinguishes an unassigned policy from an all-device configuration', () => {
  expect(assignmentEvidence([]).state).toBe('unassigned')
  expect(assignmentEvidence([{ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }])).toMatchObject({ state: 'configured', targets: [{ kind: 'allDevices' }] })
})
it('recognizes the all users target as configured, like the licensed users one', () => {
  for (const type of ['#microsoft.graph.allUsersAssignmentTarget', '#microsoft.graph.allLicensedUsersAssignmentTarget']) {
    expect(assignmentEvidence([{ target: { '@odata.type': type } }])).toMatchObject({ state: 'configured', targets: [{ kind: 'allUsers' }] })
  }
})
it('preserves inclusions, exclusions and filters without claiming effective applicability', () => {
  const evidence = assignmentEvidence([
    { target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'include', deviceAndAppManagementAssignmentFilterId: 'filter', deviceAndAppManagementAssignmentFilterType: 'include' } },
    { target: { '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget', groupId: 'exclude' } },
  ])
  expect(evidence.state).toBe('review')
  expect(evidence.targets).toEqual([{ kind: 'group', groupId: 'include', filterId: 'filter', filterMode: 'include' }, { kind: 'exclusion', groupId: 'exclude' }])
  expect(evidence.limitations).toHaveLength(2)
})
it('reports incomplete and unsupported targets for review', () => {
  expect(assignmentEvidence([{ target: { '@odata.type': 'unknown' } }]).state).toBe('review')
  expect(assignmentEvidence([{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget' } }]).limitations[0]).toContain('incomplete')
  expect(assignmentEvidence([{ target: { '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget', groupId: 'only-exclusion' } }]).limitations).toContain('Only exclusions were found; no included target was observed.')
})
