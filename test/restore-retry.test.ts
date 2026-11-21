import { expect, it } from 'vitest'
import { mergeOutcomes, retryBatches } from '../src/portal/lib/policies/restore-retry'
import { Restorer } from '../src/portal/lib/policies/graph-restore'
it('retries a failed copy only in tenant B and retains tenant A success', () => {
  const before = [{ path: 'policy', targetTenantId: 'A', success: true }, { path: 'policy', targetTenantId: 'B', success: false }]
  expect(retryBatches(before)).toEqual([{ targetTenantId: 'b', paths: ['policy'] }])
  const after = mergeOutcomes(before, [{ path: 'policy', targetTenantId: 'b', success: true }])
  expect(after).toHaveLength(2)
  expect(after.every((outcome) => outcome.success)).toBe(true)
  expect(retryBatches(after)).toEqual([])
})
it('does not retry uncertain or skipped writes', () => {
  expect(retryBatches([{ path: 'uncertain', success: false, retryable: false }, { path: 'reference', success: false, action: 'skipped' }])).toEqual([])
})
it.each([408, 500, 503])('does not offer blind retry after an ambiguous %s creation failure', async (status) => {
  const restorer = new Restorer(async () => ({ status, body: {} }), { mode: 'copy', assignments: false })
  expect(await restorer.restore('b/DeviceCategories/a.json', { displayName: 'A' })).toMatchObject({ success: false, retryable: false })
})
it('does not retry creation when the response is lost or has no ID', async () => {
  const options = { mode: 'copy' as const, assignments: false }
  const lost = new Restorer(async () => { throw new Error('Connection lost') }, options)
  const noId = new Restorer(async () => ({ status: 201, body: {} }), options)
  for (const restorer of [lost, noId]) expect(await restorer.restore('b/DeviceCategories/a.json', { displayName: 'A' })).toMatchObject({ success: false, retryable: false })
})

it("preserves the issuing job for each retry batch after results are serialized", () => {
  const results = JSON.parse(JSON.stringify([
    { path: "first", success: false, targetTenantId: "B", retryJobId: "original" },
    { path: "second", success: false, targetTenantId: "B", retryJobId: "another" },
  ]))
  expect(retryBatches(results)).toEqual([
    { targetTenantId: "b", paths: ["first"], retryOf: "original" },
    { targetTenantId: "b", paths: ["second"], retryOf: "another" },
  ])
})
