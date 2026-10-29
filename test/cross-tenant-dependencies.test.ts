import type { Item } from '../src/shared/intune/registry'
import { describe, expect, it, vi } from 'vitest'
import { Restorer, type GraphCall, type RestoreOptions } from '../src/portal/lib/policies/graph-restore'

const app = { id: 'source-app', displayName: 'Web', '@odata.type': '#microsoft.graph.webApp', appUrl: 'https://example.com', categories: [{ id: 'source-category' }], roleScopeTagIds: ['source-tag'], assignments: [{ target: { groupId: 'source-group' } }] }
describe('cross-tenant dependency mapping', () => {
  it('uses the created category ID in the dependent app link', async () => {
    const graph = vi.fn<GraphCall>(async (_method, path) => ({ status: 201, body: { id: path.endsWith('mobileAppCategories') ? 'target-category' : 'target-app' } }))
    const restore = new Restorer(graph, { mode: 'copy', assignments: false, crossTenant: true })
    expect((await restore.restore('backup/AppCategories/category.json', { id: 'source-category', displayName: 'Category' })).success).toBe(true)
    expect((await restore.restore('backup/Apps/app.json', app)).success).toBe(true)
    // Only what is sent to Graph (method, path, body) must be free of source tenant IDs.
    // Call options stay local: they carry the source ID for the write journal.
    const calls = JSON.stringify(graph.mock.calls.map(([method, path, body]) => [method, path, body]))
    expect(calls).toContain('mobileAppCategories/target-category')
    expect(calls).not.toContain('source-category')
    expect(calls).not.toContain('source-group')
    expect(calls).not.toContain('source-tag')
  })
  it('rejects an unresolved category before creating the app', async () => {
    const graph = vi.fn<GraphCall>()
    const result = await new Restorer(graph, { mode: 'copy', assignments: false, crossTenant: true }).restore('backup/Apps/app.json', app)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unresolved target dependencies')
    expect(graph).not.toHaveBeenCalled()
  })
  it('rejects unresolved policy-set payloads and app links before creating either object', async () => {
    const graph = vi.fn<GraphCall>()
    const restore = new Restorer(graph, { mode: 'copy', assignments: false, crossTenant: true })
    for (const [folder, snapshot] of [
      ['PolicySets', { displayName: 'Set', items: [{ payloadId: 'unmapped' }] }],
      ['Apps', { ...app, categories: [], relationships: [{ targetId: 'unmapped', targetType: 'child' }] }],
    ] as Array<[string, Item]>) expect((await restore.restore(`backup/${folder}/item.json`, snapshot)).error).toContain('Unresolved target dependencies')
    expect(graph).not.toHaveBeenCalled()
  })
})

it('rejects cross-tenant replacement before any Graph read or write', () => {
  const graph = vi.fn()
  expect(() => new Restorer(graph, { mode: 'replace', assignments: false, crossTenant: true })).toThrow('copies only')
  expect(graph).not.toHaveBeenCalled()
})

it('retains cross-tenant restrictions when the caller mutates its options', async () => {
  const graph = vi.fn<GraphCall>()
  const options: RestoreOptions = { mode: 'copy', assignments: false, crossTenant: true }
  const restore = new Restorer(graph, options)
  options.crossTenant = false
  options.mode = 'replace'
  expect((await restore.restore('backup/Apps/app.json', app)).error).toContain('Unresolved target dependencies')
  expect(graph).not.toHaveBeenCalled()
})
