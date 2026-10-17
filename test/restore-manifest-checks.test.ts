import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../src/portal/app/api/restore-backup/route'
import { NextRequest } from '../src/main/api/next-server-shim'
import { Restorer, type GraphCall } from '../src/portal/lib/policies/graph-restore'
import { comparableSnapshot } from '../src/shared/intune/compare'
import type { Item } from '../src/shared/intune/registry'

const backupId = 'backup-2026-09-25-120000'
const policyPath = `${backupId}/DeviceConfigurations/Example.json`
const baseBody = { tenantId: 'tenant', appId: 'app', clientSecret: 'placeholder', storageAccountName: 'storage', backupId }
const request = (data: object) => new NextRequest('http://tenuvault.internal/api/restore-backup', { method: 'POST', body: JSON.stringify(data) })
afterEach(() => vi.unstubAllGlobals())

const snapshotHash = (snapshot: Item) => createHash('sha256').update(JSON.stringify(comparableSnapshot(snapshot))).digest('base64').slice(0, 22)

/** Stubs token, blob and Graph fetches. `blobs` maps blob names to JSON bodies. */
function stubFetch(blobs: Record<string, Item>, options: { authenticated?: boolean; list?: string[] } = {}) {
  const graphWrites: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.hostname.endsWith('.blob.core.windows.net')) {
      if (url.searchParams.get('comp') === 'list') {
        const names = (options.list ?? []).map((name) => `<Blob><Name>${name}</Name></Blob>`).join('')
        return new Response(`<EnumerationResults><Blobs>${names}</Blobs><NextMarker></NextMarker></EnumerationResults>`)
      }
      const name = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/')
      const blob = blobs[name]
      if (!blob) return new Response('', { status: 404 })
      return Response.json(blob, options.authenticated === false ? {} : { headers: { 'x-tenuvault-authenticated': 'true' } })
    }
    if (url.hostname === 'graph.microsoft.com') {
      graphWrites.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return Response.json({ id: 'created' }, { status: 201 })
    }
    throw new Error(`Unexpected request ${url}`)
  }))
  return graphWrites
}

describe('Restore manifest checks', () => {
  it('refuses an unauthenticated legacy snapshot when a copy restores assignments, before any Graph call', async () => {
    const snapshot: Item = { id: 'original', displayName: 'Legacy', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [], assignments: [{ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }] }
    const graphWrites = stubFetch({ [policyPath]: snapshot }, { authenticated: false })
    const response = await POST(request({ ...baseBody, restoreType: 'selective', selectedPolicies: [{ path: policyPath }], mode: 'copy', assignments: true }))
    const result = await response.json()
    expect(result.details.results[0]).toMatchObject({ success: false, error: expect.stringContaining('Unverified') })
    expect(result.details.restoredCount).toBe(0)
    expect(graphWrites).toEqual([])
  })

  it('refuses a full restore of an incomplete backup before any Graph call', async () => {
    const snapshot: Item = { id: 'original', displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [] }
    const metadata: Item = {
      Status: 'CompletedWithWarnings',
      Failures: 1,
      FailedTypes: [],
      Items: { 'DeviceConfigurations/original': { file: 'Example.json', hash: snapshotHash(snapshot) } },
    }
    const graphWrites = stubFetch({ [`${backupId}/metadata.json`]: metadata, [policyPath]: snapshot }, { list: [policyPath] })
    const response = await POST(request({ ...baseBody, restoreType: 'full', mode: 'copy', assignments: false }))
    const result = await response.json()
    expect(response.status).toBe(400)
    expect(result.error).toContain('incomplete')
    expect(graphWrites).toEqual([])
  })

  it('refuses a full restore of a backup with no completion record, before any Graph call', async () => {
    const snapshot: Item = { id: 'original', displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [] }
    const graphWrites = stubFetch({ [policyPath]: snapshot }, { list: [policyPath] })
    const response = await POST(request({ ...baseBody, restoreType: 'full', mode: 'copy', assignments: false }))
    const result = await response.json()
    expect(response.status).toBe(400)
    expect(result.error).toContain('incomplete')
    expect(graphWrites).toEqual([])
  })

  describe('a backup recorded as failed after it stopped early', () => {
    const snapshot: Item = { id: 'original', displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [] }
    const failed = (items: Item | undefined): Item => ({ Status: 'Failed', Failures: 0, FailedTypes: [], Error: 'Backup cancelled by you. This run is never offered as a complete backup.', ...(items ? { Items: items } : {}) })
    const listed = { 'DeviceConfigurations/original': { file: 'Example.json', hash: snapshotHash(snapshot) } }

    it('restores a saved policy it lists on its own', async () => {
      const graphWrites = stubFetch({ [`${backupId}/metadata.json`]: failed(listed), [policyPath]: snapshot }, { list: [policyPath] })
      const response = await POST(request({ ...baseBody, restoreType: 'selective', selectedPolicies: [{ path: policyPath }], mode: 'copy', assignments: false }))
      const result = await response.json()
      expect(response.status).toBe(200)
      expect(result.details.restoredCount).toBe(1)
      expect(graphWrites.some((call) => call.startsWith('POST '))).toBe(true)
    })

    it('refuses a full restore, before any Graph call', async () => {
      const graphWrites = stubFetch({ [`${backupId}/metadata.json`]: failed(listed), [policyPath]: snapshot }, { list: [policyPath] })
      const response = await POST(request({ ...baseBody, restoreType: 'full', mode: 'copy', assignments: false }))
      const result = await response.json()
      expect(response.status).toBe(400)
      expect(result.error).toBe('This backup is recorded as failed and is incomplete. Restore selected items from it, or restore from a complete backup instead.')
      expect(graphWrites).toEqual([])
    })

    it('refuses a file the failed manifest does not list, before any Graph call', async () => {
      const unlisted = `${backupId}/DeviceConfigurations/Landed later.json`
      const graphWrites = stubFetch({ [`${backupId}/metadata.json`]: failed(listed), [unlisted]: snapshot }, { list: [policyPath, unlisted] })
      const response = await POST(request({ ...baseBody, restoreType: 'selective', selectedPolicies: [{ path: unlisted }], mode: 'copy', assignments: false }))
      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain('not listed in the backup manifest')
      expect(graphWrites).toEqual([])
    })

    it('refuses a selective restore when the failed manifest records no items', async () => {
      const graphWrites = stubFetch({ [`${backupId}/metadata.json`]: failed(undefined), [policyPath]: snapshot }, { list: [policyPath] })
      const response = await POST(request({ ...baseBody, restoreType: 'selective', selectedPolicies: [{ path: policyPath }], mode: 'copy', assignments: false }))
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('This backup is recorded as failed and is incomplete. Restore from a complete backup instead.')
      expect(graphWrites).toEqual([])
    })
  })

  describe('a backup the user cancelled after it claimed its folder', () => {
    const snapshot: Item = { id: 'original', displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [] }
    const cancelled: Item = { Status: 'Cancelled', Failures: 0, FailedTypes: [], Error: 'Backup cancelled by you. This run is never offered as a complete backup.', Items: { 'DeviceConfigurations/original': { file: 'Example.json', hash: snapshotHash(snapshot) } } }

    it('refuses a full restore like a failed backup, before any Graph call', async () => {
      const graphWrites = stubFetch({ [`${backupId}/metadata.json`]: cancelled, [policyPath]: snapshot }, { list: [policyPath] })
      const response = await POST(request({ ...baseBody, restoreType: 'full', mode: 'copy', assignments: false }))
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('This backup is recorded as cancelled and is incomplete. Restore selected items from it, or restore from a complete backup instead.')
      expect(graphWrites).toEqual([])
    })

    it('restores a saved policy it lists on its own', async () => {
      const graphWrites = stubFetch({ [`${backupId}/metadata.json`]: cancelled, [policyPath]: snapshot }, { list: [policyPath] })
      const response = await POST(request({ ...baseBody, restoreType: 'selective', selectedPolicies: [{ path: policyPath }], mode: 'copy', assignments: false }))
      expect(response.status).toBe(200)
      expect((await response.json()).details.restoredCount).toBe(1)
      expect(graphWrites.some((call) => call.startsWith('POST '))).toBe(true)
    })
  })

  it('refuses a snapshot whose content no longer matches its recorded fingerprint, before any Graph call', async () => {
    const recorded: Item = { id: 'original', displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [] }
    const tampered: Item = { ...recorded, displayName: 'Changed after backup' }
    const metadata: Item = {
      Status: 'Success',
      Failures: 0,
      FailedTypes: [],
      Items: { 'DeviceConfigurations/original': { file: 'Example.json', hash: snapshotHash(recorded) } },
    }
    const graphWrites = stubFetch({ [`${backupId}/metadata.json`]: metadata, [policyPath]: tampered })
    const response = await POST(request({ ...baseBody, restoreType: 'selective', selectedPolicies: [{ path: policyPath }], mode: 'copy', assignments: false }))
    const result = await response.json()
    expect(result.details.results[0]).toMatchObject({ success: false, error: expect.stringContaining('fingerprint') })
    expect(result.details.restoredCount).toBe(0)
    expect(graphWrites).toEqual([])
  })
})

describe('Same tenant dependency checks', () => {
  const app: Item = { id: 'source-app', displayName: 'Web', '@odata.type': '#microsoft.graph.webApp', appUrl: 'https://example.com', categories: [{ id: 'category-1' }] }

  it('fails a same tenant create whose dependency is missing, before any write', async () => {
    const writes: string[] = []
    const graph = vi.fn<GraphCall>(async (method, path) => {
      if (method !== 'GET') writes.push(`${method} ${path}`)
      if (path === 'deviceAppManagement/mobileAppCategories/category-1') return { status: 404, body: {} as Item }
      return { status: 201, body: { id: 'created' } }
    })
    const result = await new Restorer(graph, { mode: 'copy', assignments: false }).restore('backup/Apps/app.json', app)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unresolved')
    expect(writes).toEqual([])
  })

  it('creates a same tenant item whose dependency still exists live', async () => {
    const graph = vi.fn<GraphCall>(async (method, path) => {
      if (path === 'deviceAppManagement/mobileAppCategories/category-1') return { status: 200, body: { id: 'category-1' } }
      return { status: 201, body: { id: 'created-app' } }
    })
    const result = await new Restorer(graph, { mode: 'copy', assignments: false }).restore('backup/Apps/app.json', app)
    expect(result.success).toBe(true)
    expect(graph.mock.calls.some(([method]) => method === 'POST')).toBe(true)
  })

  it('does not treat a failed dependency check as a missing dependency', async () => {
    const graph = vi.fn<GraphCall>(async (_method, path) => {
      if (path === 'deviceAppManagement/mobileAppCategories/category-1') return { status: 403, body: { error: { message: 'Forbidden' } } as Item }
      return { status: 201, body: { id: 'created-app' } }
    })
    const result = await new Restorer(graph, { mode: 'copy', assignments: false }).restore('backup/Apps/app.json', app)
    expect(result.success).toBe(true)
  })

  it('creates a same tenant policy set whose payloads were not recreated in this run', async () => {
    const graph = vi.fn<GraphCall>(async () => ({ status: 201, body: { id: 'created-set' } }))
    const snapshot: Item = { displayName: 'Set', items: [{ payloadId: 'live-payload' }] }
    const result = await new Restorer(graph, { mode: 'copy', assignments: false }).restore('backup/PolicySets/set.json', snapshot)
    expect(result.success).toBe(true)
    expect(graph.mock.calls.some(([method]) => method === 'POST')).toBe(true)
  })
})
