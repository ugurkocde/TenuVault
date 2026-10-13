import { createAuditRecorder } from "../src/main/api/audit"
import { parseBackupFolders } from "../src/portal/app/api/detect-drifts/route"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validPolicyPath } from '../src/portal/lib/policies/restore'
import { typeForFolder } from '../src/shared/intune/registry'
import { buildRestorePlan } from '../src/shared/intune/restore-plan'

const copyOf = (folder: string, policy: object) => buildRestorePlan(typeForFolder(folder)!, policy as never, { prefix: '[Restored]' }).create.body as any
import { POST } from '../src/portal/app/api/restore-backup/route'
import { POST as restorePrevious } from '../src/portal/app/api/revert-policy/route'
import { NextRequest } from '../src/main/api/next-server-shim'

const backupId = 'backup-2026-09-25-120000'
const path = `${backupId}/DeviceConfigurations/Example.json`
const body = { tenantId: 'tenant', appId: 'app', clientSecret: 'placeholder', storageAccountName: 'storage', backupId, restoreType: 'full' }
const request = (data: object) => new NextRequest('http://tenuvault.internal/api/restore-backup', { method: 'POST', body: JSON.stringify(data) })
afterEach(() => vi.unstubAllGlobals())

describe('Policy copies', () => {
  it('accepts literal URL punctuation in filenames because fetch encodes each segment', () => {
    expect(validPolicyPath(`${backupId}/DeviceConfigurations/100% #policy.json`, backupId)).toBe(true)
  })
  it('preserves nested polymorphic types without mutating snapshots', () => {
    const policy = { id: 'original', name: 'Catalog', settings: [{ id: '0', settingInstance: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance', choiceSettingValue: { value: 'choice', children: [{ '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance', simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationIntegerSettingValue', value: 8 } }] } } }], assignments: [{ target: 'allDevices' }] }
    const original = structuredClone(policy)
    const copy = copyOf('ConfigurationPolicies', policy)
    expect(copy.settings[0].settingInstance).toEqual(policy.settings[0]!.settingInstance)
    expect(copy.name).toBe('[Restored] Catalog')
    expect(copy).not.toHaveProperty('assignments')
    expect(copy.settings[0]).not.toHaveProperty('id')
    expect(policy).toEqual(original)
  })
  it('refuses old compliance snapshots instead of inventing required rules', () => {
    expect(() => copyOf('CompliancePolicies', { displayName: 'Compliance' })).toThrow('required block action')
  })
  it.each(['../other/file.json', `${backupId}/DeviceConfigurations/../../file.json`, `${backupId}/metadata.json`, `other/DeviceConfigurations/Example.json`])('rejects out-of-scope paths: %s', candidate => expect(validPolicyPath(candidate, backupId)).toBe(false))
})

describe('Restore results', () => {
  const mock = (fail: boolean) => {
    let page = 0
    const payloads: object[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
      if (url.pathname === '/api/audit/log') { payloads.push(JSON.parse(String(init?.body))); return Response.json({ success: true }) }
      if (url.searchParams.get('comp') === 'list') {
        page++
        return new Response(`<EnumerationResults><Blobs><Blob><Name>${backupId}/DeviceConfigurations/${page}.json</Name></Blob></Blobs><NextMarker>${page === 1 ? 'next' : ''}</NextMarker></EnumerationResults>`)
      }
      if (url.hostname.endsWith('.blob.core.windows.net')) {
        if (url.pathname.endsWith('/metadata.json')) return Response.json({ Status: 'Success', Failures: 0 })
        return Response.json({ id: 'original', displayName: url.pathname.endsWith('1.json') ? 'One' : 'Two', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [] })
      }
      if (url.hostname === 'graph.microsoft.com') {
        expect(url.pathname).toBe('/beta/deviceManagement/deviceConfigurations')
        const policy = JSON.parse(String(init?.body))
        if (fail && policy.displayName.includes('Two')) return Response.json({ error: { message: 'Permission denied' } }, { status: 403 })
        return Response.json({ id: policy.displayName, displayName: policy.displayName }, { status: 201 })
      }
      throw new Error(`Unexpected request ${url}`)
    }))
    return payloads
  }
  it('follows all storage pages and reports complete success', async () => {
    mock(false)
    const result = await (await POST(request(body))).json()
    expect(result).toMatchObject({ success: true, status: 'Completed', details: { restoredCount: 2, failedCount: 0 } })
  })
  it('reports partial failure with per-policy errors and a partial audit result', async () => {
    const audits = mock(true)
    const response = await POST(request(body))
    const result = await response.clone().json()
    const record = createAuditRecorder(async req => { audits.push(await req.json()); return Response.json({ success: true }) }, () => ({ tenantId: 'tenant', clientId: 'app', username: 'admin@example.test', name: 'Signed-in admin', homeAccountId: 'account' }))
    record(request({ ...body, userName: 'Spoofed user' }), JSON.stringify({ ...body, userName: 'Spoofed user' }), response)
    await vi.waitFor(() => expect(audits).toHaveLength(1))
    expect(audits[0]).toMatchObject({ user: { name: 'Signed-in admin', email: 'admin@example.test' }, logEntry: { eventType: 'RESTORE_COMPLETED', result: 'PARTIAL', severity: 'WARNING', details: { restoredCount: 1, failedCount: 1 } } })
    expect(result).toMatchObject({ success: false, status: 'PartiallyCompleted', details: { restoredCount: 1, failedCount: 1 } })
    expect(result.details.results[1].error).toBe('Permission denied')
  })
  it('rejects invalid selective restores before requesting tokens', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect((await POST(request({ ...body, restoreType: 'selective', selectedPolicies: [{ path: 'other/DeviceConfigurations/Example.json' }] }))).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('reverts the existing policy in place and never creates a copy', async () => {
    const graph: Array<{ method: string; path: string; body?: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
      if (url.hostname.endsWith('.blob.core.windows.net')) {
        if (init?.method === 'PUT' || url.pathname.includes('/metadata/')) return new Response('', { status: 404 })
        return Response.json({ id: 'original', displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [], assignments: [{ id: 'a', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }] }, { headers: { 'x-tenuvault-authenticated': 'true' } })
      }
      if (url.hostname === 'graph.microsoft.com') {
        graph.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return Response.json({ id: 'original' })
      }
      throw new Error(`Unexpected request ${url}`)
    }))
    const response = await restorePrevious(request({ ...body, action: 'revert', policyId: 'original', policyType: 'Device Configuration', backupPath: path }))
    expect(response.status).toBe(200)
    expect(graph.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /beta/deviceManagement/deviceConfigurations/original',
      'PATCH /beta/deviceManagement/deviceConfigurations/original',
    ])
    expect(graph[1]!.body).toMatchObject({ displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration' })
    expect(graph[1]!.body).not.toHaveProperty('assignments')
  })
})

 it('reads both backup folder formats as UTC regardless of local timezone', () => {
   const before = process.env.TZ
   process.env.TZ = 'Europe/Berlin'
   try {
     const result = parseBackupFolders('<BlobPrefix><Name>backup-2026-09-25-120000/</Name></BlobPrefix><BlobPrefix><Name>2026-09-25_12-00-00/</Name></BlobPrefix>')
     expect(result.map(folder => folder.timestamp)).toEqual(['2026-09-25T12:00:00.000Z', '2026-09-25T12:00:00.000Z'])
   } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before }
 })

it('records a policy copy once against the created policy and the real actor', async () => {
  const logs: any[] = []
  const record = createAuditRecorder(async req => { logs.push(await req.json()); return Response.json({ success: true }) }, () => ({ tenantId: 'tenant', clientId: 'app', username: 'admin@example.test', name: 'Admin', homeAccountId: 'account' }))
  const req = new Request('http://tenuvault.internal/api/revert-policy', { method: 'POST' })
  record(req, JSON.stringify({ ...body, policyId: 'original', originalName: 'Example', action: 'restore', userName: 'Fake user' }), Response.json({ success: true, policyId: 'created-copy' }))
  await vi.waitFor(() => expect(logs).toHaveLength(1))
  expect(logs[0]).toMatchObject({ user: { name: 'Admin' }, logEntry: { eventType: 'POLICY_RESTORED', result: 'SUCCESS', resource: { type: 'policy', id: 'created-copy' } } })
})

describe('Copy to other tenants', () => {
  it('writes each target with its own sign-in, under the original name, without assignments or scope tags', async () => {
    const targets = ['33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444']
    const created: Array<{ token: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: `token-${url.pathname.split('/')[1]}` })
      if (url.hostname.endsWith('.blob.core.windows.net')) {
        return Response.json({ id: 'p1', displayName: 'Firewall', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [], roleScopeTagIds: ['7'], assignments: [{ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }] })
      }
      if (url.hostname === 'graph.microsoft.com') {
        // Graph requests in this test always provide authentication headers.
        // oxlint-disable-next-line no-unsafe-optional-chaining
        created.push({ token: String((init?.headers as Record<string, string>).Authorization), body: JSON.parse(String(init?.body)) })
        return Response.json({ id: `new-${created.length}` }, { status: 201 })
      }
      throw new Error(`Unexpected request ${url}`)
    }))
    const response = await POST(request({ ...body, restoreType: 'selective', selectedPolicies: [{ path }], mode: 'copy', targetTenants: targets.map(tenantId => ({ tenantId, appId: tenantId })) }))
    const data = await response.json()
    expect(data.message).toMatch(/^Copied 2 items to 2 tenants/)
    expect(data.details.results.map((r: any) => r.targetTenantId)).toEqual(targets)
    expect(created.map(c => c.token)).toEqual(targets.map(t => `Bearer token-${t}`))
    for (const { body: copy } of created) {
      expect(copy).toMatchObject({ displayName: 'Firewall', roleScopeTagIds: ['0'] })
      expect(copy).not.toHaveProperty('assignments')
    }
  })

  it('refuses to copy to the source tenant or with assignments', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const copy = (extra: object) => POST(request({ ...body, restoreType: 'selective', selectedPolicies: [{ path }], mode: 'copy', ...extra }))
    expect((await copy({ targetTenants: [{ tenantId: body.tenantId, appId: body.tenantId }] })).status).toBe(400)
    expect((await copy({ assignments: true, targetTenants: [{ tenantId: '33333333-3333-3333-3333-333333333333', appId: '33333333-3333-3333-3333-333333333333' }] })).status).toBe(400)
  })
})

describe('Replace in place with progress', () => {
  const snapshot = { id: 'original', displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [], version: 3, lastModifiedDateTime: '2026-09-01T00:00:00Z' }
  const stub = (live: object) => {
    const graph: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
      if (url.hostname.endsWith('.blob.core.windows.net')) return Response.json(snapshot, { headers: { 'x-tenuvault-authenticated': 'true' } })
      if (url.hostname === 'graph.microsoft.com') {
        graph.push(`${init?.method ?? 'GET'} ${url.pathname}`)
        return Response.json(live)
      }
      throw new Error(`Unexpected request ${url}`)
    }))
    return graph
  }
  const replace = (progressId?: string) => POST(request({ ...body, restoreType: 'selective', selectedPolicies: [{ path }], mode: 'replace', ...(progressId ? { progressId } : {}) }))

  it('leaves an item that already matches the backup alone', async () => {
    // Only the version and modification time differ, which Intune changes on every write.
    const graph = stub({ ...snapshot, version: 9, lastModifiedDateTime: '2026-09-20T00:00:00Z', assignments: [] })
    const result = await (await replace()).json()
    expect(graph).toEqual(['GET /beta/deviceManagement/deviceConfigurations/original'])
    expect(result).toMatchObject({ success: true, status: 'Completed', details: { restoredCount: 0, unchangedCount: 1 } })
    expect(result.details.results[0]).toMatchObject({ success: true, action: 'unchanged' })
    expect(result.message).toContain('1 already matched the backup')
  })

  it('updates an item that changed and reports progress while it runs', async () => {
    const graph = stub({ ...snapshot, displayName: 'Renamed' })
    const { readProgress } = await import('../src/portal/lib/policies/restore-progress')
    const result = await (await replace('progress-test-1')).json()
    expect(graph).toContain('PATCH /beta/deviceManagement/deviceConfigurations/original')
    expect(result.details.results[0]).toMatchObject({ success: true, action: 'updated' })
    expect(readProgress('progress-test-1')).toMatchObject({ total: 1, done: 1, finished: true, current: null, results: [{ path, action: 'updated' }] })
  })

  it('rejects malformed progress IDs', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect((await replace('../bad')).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })
})

it('blocks replacement of unauthenticated snapshots before reading or writing Graph', async () => {
  const graph = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.hostname.endsWith('.blob.core.windows.net')) return Response.json({ id: 'original', displayName: 'Legacy' })
    graph(); return Response.json({})
  }))
  const response = await POST(request({ ...body, restoreType: 'selective', selectedPolicies: [{ path }], mode: 'replace' }))
  const result = await response.json()
  expect(result.details.results[0]).toMatchObject({ success: false, error: expect.stringContaining('Unverified') })
  expect(graph).not.toHaveBeenCalled()
})

it('allows legacy snapshot copies through the drift restore action', async () => {
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.hostname.endsWith('.blob.core.windows.net')) {
      if (init?.method === 'PUT') return new Response(null, { status: 201 })
      return Response.json({ id: 'original', displayName: 'Legacy', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [] })
    }
    writes.push(init?.method ?? 'GET'); return Response.json({ id: 'copy' }, { status: 201 })
  }))
  const response = await restorePrevious(request({ ...body, action: 'restore', policyId: 'original', policyType: 'deviceConfigurations', backupPath: path }))
  expect(response.status).toBe(200)
  expect(writes).toContain('POST')
  expect(writes).not.toContain('PATCH')
})
