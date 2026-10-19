import { describe, expect, it, vi } from 'vitest'
import { typeForFolder } from '../src/shared/intune/registry'
import { buildUpdatePlan } from '../src/shared/intune/restore-plan'
import { Restorer, type GraphCall } from '../src/portal/lib/policies/graph-restore'

const folders = ['AutopilotProfiles', 'AppleEnrollmentProfiles', 'TermsAndConditions', 'RoleDefinitions']
describe.each(folders)('%s assignment replacement guard', folder => {
  const type = typeForFolder(folder)!
  it.each(['addition', 'removal', 'empty', 'repeat'])('blocks unsupported %s before any write', async scenario => {
    const desired = scenario === 'empty' ? [] : [{ id: 'desired', target: { groupId: 'group-new' } }]
    const snapshot = { id: 'object', displayName: 'Wanted', assignments: desired, roleAssignments: desired }
    const current = { ...snapshot, displayName: 'Current', assignments: [{ id: 'old' }], roleAssignments: [] }
    expect(() => buildUpdatePlan(type, snapshot, 'object', { includeAssignments: true, current })).toThrow('Assignment replacement is not supported')
    const graph = vi.fn<GraphCall>(async (method, path) => ({ status: 200, body: path.endsWith('/object') ? current : { value: [] } }))
    const restorer = new Restorer(graph, { mode: 'replace', assignments: true })
    for (let count = 0; count < 2; count++) {
      const result = await restorer.restore(`backup/${folder}/object.json`, snapshot)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Assignment replacement is not supported')
    }
    expect(graph.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect(buildUpdatePlan(type, snapshot, 'object', { includeAssignments: false, current }).every(step => step.kind === 'content')).toBe(true)
  })
})

describe('RoleDefinitions restore with assignments', () => {
  const snapshot = { id: 'role', displayName: 'Helpdesk', rolePermissions: [], roleAssignments: [{ id: 'ra', displayName: 'Helpdesk team', members: ['group-a'], resourceScopes: ['group-b'] }] }
  const run = async (assignments: boolean) => {
    const graph = vi.fn<GraphCall>(async (method) => ({ status: method === 'POST' ? 201 : 200, body: { id: 'new-role' } }))
    const result = await new Restorer(graph, { mode: 'copy', assignments }).restore('backup/RoleDefinitions/Helpdesk.json', snapshot)
    return { result, posts: graph.mock.calls.filter(([method]) => method === 'POST').map(([, path]) => path) }
  }

  it('warns that restored role assignments recreate revoked memberships', async () => {
    const { result, posts } = await run(true)
    expect(result.success).toBe(true)
    expect(posts).toContain('deviceManagement/roleAssignments')
    expect(result.warnings).toEqual([typeForFolder('RoleDefinitions')!.assignmentWarning])
    expect(result.warnings![0]).toContain('revoked')
  })

  it('does not warn when assignments are left out', async () => {
    const { result, posts } = await run(false)
    expect(result.success).toBe(true)
    expect(posts).not.toContain('deviceManagement/roleAssignments')
    expect(result.warnings).toBeUndefined()
  })
})

describe('replace restore of a deleted object', () => {
  const snapshot = { id: 'gone', displayName: 'Deleted', omaSettings: [] }
  const graph = () => vi.fn<GraphCall>(async (method) => (method === 'GET'
    ? { status: 404, body: { error: { code: 'ResourceNotFound', message: 'Not found' } } }
    : { status: 201, body: { id: 'new-object' } }) as Awaited<ReturnType<GraphCall>>)

  it('recreates it by default, reporting the new ID', async () => {
    const result = await new Restorer(graph(), { mode: 'replace', assignments: false }).restore('backup/DeviceConfigurations/Deleted.json', snapshot)
    expect(result).toMatchObject({ success: true, action: 'created', policyId: 'new-object' })
  })

  it('leaves it deleted and reports it as missing when recreateMissing is false', async () => {
    const calls = graph()
    const result = await new Restorer(calls, { mode: 'replace', assignments: false, recreateMissing: false }).restore('backup/DeviceConfigurations/Deleted.json', snapshot)
    expect(result).toMatchObject({ success: false, missing: true, action: 'skipped', policyId: 'gone' })
    expect(calls.mock.calls.every(([method]) => method === 'GET')).toBe(true)
  })
})
