import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST as revertPolicy } from '../src/portal/app/api/revert-policy/route'
import { NextRequest } from '../src/main/api/next-server-shim'
import { snapshotHash } from '../src/portal/lib/policies/backup-manifest'
import type { Item } from '../src/shared/intune/registry'

/** Revert and recreate change the live policy, so they run the same checks as a replace restore. */
const TENANT = '11111111-1111-1111-1111-111111111111'
const backupId = 'backup-2026-09-25-120000'
const backupPath = `${backupId}/DeviceConfigurations/Example.json`
const snapshot: Item = { id: 'original', displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [] }
const manifest = (hashOf: Item, extra: object = {}) => ({ TenantId: TENANT, Status: 'Success', Failures: 0, FailedTypes: [], Items: { 'DeviceConfigurations/original': { file: 'Example.json', hash: snapshotHash(hashOf) } }, ...extra })

afterEach(() => vi.unstubAllGlobals())

function stub(blobs: Record<string, unknown>) {
  const graph: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token' })
    if (url.hostname === 'graph.microsoft.com') {
      graph.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return Response.json({ ...snapshot, displayName: 'Changed in the tenant' })
    }
    if (init?.method === 'PUT' || url.pathname.includes('/metadata/')) return new Response('', { status: 404 })
    const name = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/')
    return name in blobs ? Response.json(blobs[name]) : new Response('', { status: 404 })
  }))
  return graph
}

const revert = () => revertPolicy(new NextRequest('http://tenuvault.internal/api/revert-policy', {
  method: 'POST',
  body: JSON.stringify({ tenantId: TENANT, appId: 'app', clientSecret: 'placeholder', storageAccountName: 'storage', action: 'revert', policyId: 'original', policyType: 'Device Configuration', backupPath }),
}))

describe('revert and recreate from a backup', () => {
  it('puts the policy back from a backup that names this tenant and matches its fingerprint', async () => {
    const graph = stub({ [`${backupId}/metadata.json`]: manifest(snapshot), [backupPath]: snapshot })
    expect((await revert()).status).toBe(200)
    expect(graph).toContain('PATCH /beta/deviceManagement/deviceConfigurations/original')
  })

  it('refuses a snapshot that does not match its recorded fingerprint, before any Graph write', async () => {
    const graph = stub({ [`${backupId}/metadata.json`]: manifest({ ...snapshot, displayName: 'What the backup recorded' }), [backupPath]: snapshot })
    const response = await revert()
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('does not match its recorded fingerprint')
    expect(graph).toEqual([])
  })

  it('refuses a file the backup manifest does not list', async () => {
    const graph = stub({ [`${backupId}/metadata.json`]: { ...manifest(snapshot), Items: {} }, [backupPath]: snapshot })
    const response = await revert()
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('not listed in the backup manifest')
    expect(graph).toEqual([])
  })

  it('refuses a backup that records no tenant, which can still be restored as a copy', async () => {
    const graph = stub({ [backupPath]: snapshot })
    const response = await revert()
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('This backup does not record its tenant. Restore it as a copy instead.')
    expect(graph).toEqual([])
  })

  it('refuses a backup whose ownership marker names another tenant', async () => {
    const graph = stub({ [`${backupId}/.tenuvault-owner.json`]: { TenantId: '22222222-2222-2222-2222-222222222222' }, [backupPath]: snapshot })
    expect((await revert()).status).toBe(403)
    expect(graph).toEqual([])
  })
})
