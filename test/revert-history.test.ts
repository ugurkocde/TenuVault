import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../src/portal/app/api/revert-policy/route'
import { NextRequest } from '../src/main/api/next-server-shim'

const TENANT = '11111111-1111-4111-8111-111111111111'
const backupPath = 'backup-2026-09-25-120000/DeviceConfigurations/Example.json'
const snapshot = { id: 'p1', displayName: 'Firewall', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [] }
const restore = (policyId: string) => POST(new NextRequest('http://tenuvault.internal/api/revert-policy', {
  method: 'POST',
  body: JSON.stringify({ tenantId: TENANT, appId: 'app', clientSecret: 'placeholder', storageAccountName: 'storage', action: 'restore', policyId, policyType: 'deviceConfiguration', backupPath }),
}))

type History = { reverts: Record<string, Array<{ action: string }>> }

/** One revert-history blob that honours If-Match and If-None-Match like Azure. */
function stubStorage(options: { history?: History; readStatus?: number; beforeWrite?: (blob: { body: History | null; etag: number }) => void } = {}) {
  const blob = { body: options.history ?? null as History | null, etag: 1 }
  const puts: Array<Record<string, string>> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token' })
    if (url.hostname === 'graph.microsoft.com') return Response.json({ id: 'copy' }, { status: 201 })
    if (url.pathname.endsWith('/metadata/revert-history.json')) return new Response('missing', { status: 404 })
    if (!url.pathname.endsWith(`/metadata/${TENANT}/revert-history.json`)) return Response.json(snapshot)
    if ((init?.method ?? 'GET') === 'GET') {
      if (options.readStatus) return new Response('busy', { status: options.readStatus })
      return blob.body ? Response.json(blob.body, { headers: { etag: `"${blob.etag}"` } }) : new Response('missing', { status: 404 })
    }
    const headers = init!.headers as Record<string, string>
    puts.push(headers)
    options.beforeWrite?.(blob)
    options.beforeWrite = undefined
    if (headers['If-Match'] && (!blob.body || headers['If-Match'] !== `"${blob.etag}"`)) return new Response('ConditionNotMet', { status: 412 })
    if (headers['If-None-Match'] === '*' && blob.body) return new Response('BlobAlreadyExists', { status: 409 })
    blob.body = JSON.parse(String(init!.body))
    blob.etag++
    return new Response(null, { status: 201 })
  }))
  return { blob, puts }
}

afterEach(() => vi.unstubAllGlobals())

describe('Revert history', () => {
  it.each([403, 429, 500])('leaves the history alone when reading it fails with %i', async (status) => {
    const { blob, puts } = stubStorage({ history: { reverts: { old: [{ action: 'revert' }] } }, readStatus: status })
    expect((await restore('p1')).status).toBe(200)
    expect(puts).toEqual([])
    expect(blob.body).toEqual({ reverts: { old: [{ action: 'revert' }] } })
  })

  it('starts a new history only when none exists, without replacing one created meanwhile', async () => {
    const { blob, puts } = stubStorage()
    expect((await restore('p1')).status).toBe(200)
    expect(puts[0]).toMatchObject({ 'If-None-Match': '*' })
    expect(Object.keys(blob.body!.reverts)).toEqual(['p1'])
  })

  it('reads again and keeps both entries when another revert wrote first', async () => {
    const { blob, puts } = stubStorage({
      history: { reverts: { old: [{ action: 'revert' }] } },
      // Another revert lands between this read and this write.
      beforeWrite: (current) => { current.body = { reverts: { ...current.body!.reverts, other: [{ action: 'revert' }] } }; current.etag++ },
    })
    expect((await restore('p1')).status).toBe(200)
    expect(puts.map((headers) => headers['If-Match'])).toEqual(['"1"', '"2"'])
    expect(Object.keys(blob.body!.reverts).sort()).toEqual(['old', 'other', 'p1'])
  })
})
