import { beforeEach, expect, it, vi } from 'vitest'
import { setFrameworkStore, loadWorkspace, saveWorkspace, recordAssessment, recordCreation, deleteWorkspace } from '../src/main/frameworks/workspaces'
import { handleFramework } from '../src/main/frameworks/service'
import type { Assessment } from '../src/shared/frameworks/policies'
const tenant = '11111111-1111-1111-1111-111111111111'
const other = '22222222-2222-2222-2222-222222222222'
let data: Map<string, string>
const store = () => ({ get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => { data.set(k, v) }, delete: (k: string) => { data.delete(k) } })
beforeEach(() => { data = new Map(); setFrameworkStore(store()) })
it('restores tenant-bound source versions, assessments and outcomes after reopening the store', () => {
  const assessment: Assessment = { runId: 'run', tenantId: tenant, frameworkId: 'custom', reference: 'Approved profile v2', assessedAt: '2026-09-26T00:00:00Z', policyCount: 0, findings: [] }
  recordAssessment(assessment, [])
  recordCreation(assessment, { success: true, results: [{ name: 'Policy', id: 'created' }] })
  setFrameworkStore(store())
  expect(loadWorkspace(tenant, 'custom').history[0]).toEqual({ assessment, policies: [], creation: { success: true, results: [{ name: 'Policy', id: 'created' }] } })
  expect(loadWorkspace(other, 'custom').history).toEqual([])
  expect(loadWorkspace(tenant, 'oib').history).toEqual([])
  expect([...data.values()].join('')).not.toContain('access_token')
})
it('reloads stored policies past the import size limit, within the workspace limit', () => {
  const workspace = loadWorkspace(tenant, 'custom')
  const setting = { settingInstance: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance', settingDefinitionId: 'password', simpleSettingValue: { value: 8 } } }
  // One policy whose long description puts the stored policies over the 8 MB
  // import cap while the workspace stays far under its own 32 MB limit.
  workspace.policies = [{ name: 'Baseline', platforms: 'windows10', technologies: 'mdm', description: 'x'.repeat(9_000_000), settings: [setting] }] as never
  saveWorkspace(workspace)
  const loaded = loadWorkspace(tenant, 'custom')
  expect(loaded.policies).toHaveLength(1)
  expect(loaded.policies[0]!.description).toHaveLength(9_000_000)
})
it('exports a complete record and deletes individual history or the workspace without Graph access', async () => {
  const workspace = loadWorkspace(tenant, 'custom')
  workspace.reference = 'Draft v3'
  saveWorkspace(workspace)
  expect(await handleFramework({ action: 'workspace-load', tenantId: tenant, frameworkId: 'custom' })).toMatchObject({ reference: 'Draft v3' })
  deleteWorkspace(tenant, 'custom')
  expect(loadWorkspace(tenant, 'custom').reference).toBe('')
})
it('rejects corrupt and cross-tenant records rather than showing another tenant history', () => {
  data.set(`framework.workspace.${tenant}.custom`, JSON.stringify({ version: 1, tenantId: other, frameworkId: 'custom', history: [] }))
  expect(() => loadWorkspace(tenant, 'custom')).toThrow('cannot be read')
})

it('does not turn persisted history into a live remediation authorization', async () => {
  recordAssessment({ runId: 'historical', tenantId: tenant, frameworkId: 'custom', reference: 'v1', assessedAt: '2026-09-25', policyCount: 0, findings: [] }, [])
  const fetchMock = vi.fn(async () => Response.json({ access_token: 'test' }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    await expect(handleFramework({ action: 'create', tenantId: tenant, appId: other, runId: 'historical', keys: ['0:0'], confirmUnassigned: true })).rejects.toThrow('expired')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllGlobals() }
})

it.each(['{', 'null', JSON.stringify({ version: 1, tenantId: tenant, frameworkId: 'custom', reference: '', updatedAt: '', policies: null, history: [] }), JSON.stringify({ version: 1, tenantId: tenant, frameworkId: 'custom', reference: '', updatedAt: '', policies: [], history: [null] })])('reports malformed workspace data as a controlled error (%s)', raw => {
  data.set(`framework.workspace.${tenant}.custom`, raw)
  expect(() => loadWorkspace(tenant, 'custom')).toThrow('The saved workspace cannot be read')
})
it.each(['workspace-delete', 'workspace-delete-assessment'])('revokes live remediation authorization when %s is requested', async action => {
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && !url.includes('oauth2')) writes.push(url)
    return Response.json(url.includes('oauth2') ? { access_token: 'test' } : { value: [] })
  }))
  try {
    const policies = [{ name: 'Baseline', platforms: 'windows10', technologies: 'mdm', settings: [{ settingInstance: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance', settingDefinitionId: 'password', simpleSettingValue: { value: 8 } } }] }]
    const assessment = await handleFramework({ action: 'assess', tenantId: tenant, appId: other, frameworkId: 'custom', reference: 'v1', policies }) as Assessment
    await handleFramework({ action, tenantId: tenant, frameworkId: 'custom', runId: assessment.runId })
    await expect(handleFramework({ action: 'create', tenantId: tenant, appId: other, runId: assessment.runId, keys: ['0:0'], confirmUnassigned: true })).rejects.toThrow('expired')
    expect(writes).toEqual([])
  } finally { vi.unstubAllGlobals() }
})
