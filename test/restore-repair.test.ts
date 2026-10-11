import { afterEach, expect, it, vi } from 'vitest'
import { Restorer, type GraphCall } from '../src/portal/lib/policies/graph-restore'
import { POST } from '../src/portal/app/api/restore-backup/route'
import { NextRequest } from '../src/main/api/next-server-shim'
const path = 'backup-test/NotificationTemplates/a.json'
const snapshot = { displayName: 'Message', localizedNotificationMessages: [{ locale: 'en-us', subject: 'Hello', messageTemplate: 'Hi', isDefault: true }, { locale: 'de-de', subject: 'Hallo', messageTemplate: 'Hi', isDefault: false }] }
afterEach(() => vi.unstubAllGlobals())
it('repairs only rejected content and never repeats creation or completed additive steps', async () => {
  let reject = true
  const calls: string[] = []
  const graph: GraphCall = async (_method, url, body): ReturnType<GraphCall> => {
    calls.push(`${url}:${body?.locale ?? ''}`)
    if (url.endsWith('localizedNotificationMessages') && body?.locale === 'de-de' && reject) return { status: 400, body: { error: { message: 'Rejected content' } } }
    return { status: 201, body: { id: 'created', displayName: 'Message' } }
  }
  const options = { mode: 'copy' as const, assignments: false, repairScope: 'tenant-1' }
  const outcome = await new Restorer(graph, options).restore(path, snapshot)
  expect(outcome).toMatchObject({ success: false, partial: true, policyId: 'created', repairToken: expect.any(String) })
  const wrongTenant = await new Restorer(graph, { ...options, repairScope: 'tenant-2' }).repair(path, outcome.repairToken!)
  expect(wrongTenant).toMatchObject({ success: false, retryable: false })
  reject = false
  expect(await new Restorer(graph, options).repair(path, outcome.repairToken!)).toMatchObject({ success: true, policyId: 'created' })
  expect(calls.filter((call) => call === 'deviceManagement/notificationMessageTemplates:')).toHaveLength(1)
  expect(calls.filter((call) => call.endsWith(':en-us'))).toHaveLength(1)
  expect(calls.filter((call) => call.endsWith(':de-de'))).toHaveLength(2)
  expect(await new Restorer(graph, options).repair(path, outcome.repairToken!)).toMatchObject({ success: false, retryable: false })
})
it('retains the created ID and blocks replay when a follow-up response is lost', async () => {
  const restorer = new Restorer(async (_method, url) => {
    if (url.endsWith('localizedNotificationMessages')) throw new Error('Lost response')
    return { status: 201, body: { id: 'created' } }
  }, { mode: 'copy', assignments: false })
  expect(await restorer.restore(path, snapshot)).toMatchObject({ success: false, partial: true, policyId: 'created', retryable: false, repairToken: undefined })
})
it('reports a partial API operation and repairs across requests without another creation', async () => {
  let reject = true
  let creates = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.hostname.endsWith('.blob.core.windows.net')) return Response.json(snapshot)
    if (url.pathname.endsWith('localizedNotificationMessages')) return reject ? Response.json({ error: { message: 'No' } }, { status: 400 }) : new Response(null, { status: 204 })
    creates++
    return Response.json({ id: 'created' }, { status: 201 })
  }))
  const body = { tenantId: 'tenant', appId: 'app', clientSecret: 'test', storageAccountName: 'store', backupId: 'backup-test', restoreType: 'selective', selectedPolicies: [{ path }] }
  const request = (value: object) => new NextRequest('http://tenuvault.internal/api/restore-backup', { method: 'POST', body: JSON.stringify(value) })
  const first = await (await POST(request(body))).json()
  expect(first).toMatchObject({ success: false, status: 'PartiallyCompleted', details: { restoredCount: 0, failedCount: 1, partialCount: 1 } })
  reject = false
  const second = await (await POST(request({ ...body, selectedPolicies: [{ path, repairToken: first.details.results[0].repairToken }] }))).json()
  expect(second).toMatchObject({ success: true, status: 'Completed' })
  expect(creates).toBe(1)
})
it('rejects a replacement repair when live state changed after the failure', async () => {
  let liveName = 'Before'
  let writes = 0
  const graph: GraphCall = async (method): ReturnType<GraphCall> => {
    if (method === 'GET') return { status: 200, body: { id: 'category', displayName: liveName } }
    writes++
    return { status: 400, body: { error: { message: 'Rejected' } } }
  }
  const restore = new Restorer(graph, { mode: 'replace', assignments: false })
  const categoryPath = 'backup/DeviceCategories/a.json'
  const failed = await restore.restore(categoryPath, { id: 'category', displayName: 'Wanted' })
  expect(failed.repairToken).toBeTypeOf('string')
  liveName = 'Changed by another admin'
  const result = await restore.repair(categoryPath, failed.repairToken!)
  expect(result).toMatchObject({ success: false, retryable: false, policyId: 'category' })
  expect(result.error).toContain('changed after')
  expect(writes).toBe(1)
})
