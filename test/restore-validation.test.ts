import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../src/portal/app/api/restore-validate/route'
import { NextRequest } from '../src/main/api/next-server-shim'
import { validateBackup, type SnapshotRead } from '../src/portal/lib/policies/restore-validation'
import { comparableSnapshot } from '../src/shared/intune/compare'
import type { Item } from '../src/shared/intune/registry'

const backupId = 'backup-2026-09-25-120000'
const policyPath = `${backupId}/DeviceConfigurations/Example.json`
const appPath = `${backupId}/Apps/Web.json`
const groupId = '11111111-2222-3333-4444-555555555555'

const snapshotHash = (snapshot: Item) => createHash('sha256').update(JSON.stringify(comparableSnapshot(snapshot))).digest('base64').slice(0, 22)

const policy: Item = { id: 'policy-1', displayName: 'Example', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [], assignments: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId } }] }
const app: Item = { id: 'app-1', displayName: 'Web', '@odata.type': '#microsoft.graph.webApp', appUrl: 'https://example.com' }

const metadataFor = (entries: Array<[string, Item, string]>): Item => ({
  Status: 'Success',
  Failures: 0,
  FailedTypes: [],
  Items: Object.fromEntries(entries.map(([key, snapshot, file]) => [key, { file, hash: snapshotHash(snapshot) }])),
})

const reader = (snapshots: Record<string, Item | string>) => async (path: string): Promise<SnapshotRead> => {
  const snapshot = snapshots[path]
  if (snapshot === undefined) return { ok: false, error: 'The backup file could not be read or decrypted.' }
  if (typeof snapshot === 'string') return { ok: false, error: snapshot }
  return { ok: true, snapshot }
}

describe('Restore validation dry run', () => {
  it('reports every check passing for a valid backup, with counts per policy type', async () => {
    const metadata = metadataFor([['DeviceConfigurations/policy-1', policy, 'Example.json'], ['Apps/app-1', app, 'Web.json']])
    const report = await validateBackup({ backupId, metadata, listedPaths: [policyPath, appPath], readSnapshot: reader({ [policyPath]: policy, [appPath]: app }) })
    expect(report.ok).toBe(true)
    expect(report.manifest).toMatchObject({ ok: true })
    expect(report).toMatchObject({ total: 2, passed: 2, failed: 0 })
    expect(report.byType).toEqual([
      expect.objectContaining({ folder: 'DeviceConfigurations', total: 1, passed: 1, failed: 0 }),
      expect.objectContaining({ folder: 'Apps', total: 1, passed: 1, failed: 0 }),
    ])
    expect(report.items.every((item) => item.checks.every((entry) => entry.ok))).toBe(true)
  })

  it('names the exact item whose file is missing from storage', async () => {
    const metadata = metadataFor([['DeviceConfigurations/policy-1', policy, 'Example.json'], ['Apps/app-1', app, 'Web.json']])
    const report = await validateBackup({ backupId, metadata, listedPaths: [policyPath], readSnapshot: reader({ [policyPath]: policy }) })
    expect(report.ok).toBe(false)
    expect(report.manifest.ok).toBe(false)
    const failing = report.items.filter((item) => !item.ok)
    expect(failing.map((item) => item.path)).toEqual([appPath])
    expect(failing[0]?.checks.find((entry) => entry.id === 'read')?.detail).toContain('missing')
    expect(report.byType.find((entry) => entry.folder === 'Apps')).toMatchObject({ total: 1, passed: 0, failed: 1 })
  })

  it('names the exact item whose content no longer matches its recorded fingerprint', async () => {
    const tampered: Item = { ...policy, displayName: 'Changed after backup' }
    const metadata = metadataFor([['DeviceConfigurations/policy-1', policy, 'Example.json']])
    const report = await validateBackup({ backupId, metadata, listedPaths: [policyPath], readSnapshot: reader({ [policyPath]: tampered }) })
    expect(report.ok).toBe(false)
    const failing = report.items.filter((item) => !item.ok)
    expect(failing.map((item) => item.path)).toEqual([policyPath])
    expect(failing[0]?.name).toBe('Changed after backup')
    expect(failing[0]?.checks.find((entry) => entry.id === 'fingerprint')?.detail).toContain('fingerprint')
  })

  it('names the exact item that cannot be read or decrypted', async () => {
    const metadata = metadataFor([['DeviceConfigurations/policy-1', policy, 'Example.json']])
    const report = await validateBackup({ backupId, metadata, listedPaths: [policyPath], readSnapshot: reader({ [policyPath]: 'The backup file could not be parsed. It may be corrupt.' }) })
    expect(report.ok).toBe(false)
    const failing = report.items.filter((item) => !item.ok)
    expect(failing.map((item) => item.path)).toEqual([policyPath])
    expect(failing[0]?.checks.find((entry) => entry.id === 'read')?.ok).toBe(false)
  })

  it('names the exact item whose policy payload cannot be restored', async () => {
    const installerApp: Item = { id: 'app-2', displayName: 'Installer app', '@odata.type': '#microsoft.graph.windowsUniversalAppX' }
    const installerPath = `${backupId}/Apps/Installer.json`
    const metadata = metadataFor([['Apps/app-2', installerApp, 'Installer.json']])
    const report = await validateBackup({ backupId, metadata, listedPaths: [installerPath], readSnapshot: reader({ [installerPath]: installerApp }) })
    expect(report.ok).toBe(false)
    const failing = report.items.filter((item) => !item.ok)
    expect(failing.map((item) => item.path)).toEqual([installerPath])
    expect(failing[0]?.checks.find((entry) => entry.id === 'payload')?.detail).toContain('installer')
  })

  it('names the exact item whose assignment references a group that is not valid', async () => {
    const broken: Item = { ...policy, assignments: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'not-a-group' } }] }
    const metadata = metadataFor([['DeviceConfigurations/policy-1', broken, 'Example.json']])
    const report = await validateBackup({ backupId, metadata, listedPaths: [policyPath], readSnapshot: reader({ [policyPath]: broken }) })
    expect(report.ok).toBe(false)
    const failing = report.items.filter((item) => !item.ok)
    expect(failing.map((item) => item.path)).toEqual([policyPath])
    const assignments = failing[0]?.checks.find((entry) => entry.id === 'assignments')
    expect(assignments?.ok).toBe(false)
    expect(assignments?.detail).toContain('not-a-group')
  })

  it('fails the manifest check for a backup recorded with failures', async () => {
    const metadata: Item = { ...metadataFor([['DeviceConfigurations/policy-1', policy, 'Example.json']]), Status: 'CompletedWithWarnings', Failures: 1 }
    const report = await validateBackup({ backupId, metadata, listedPaths: [policyPath], readSnapshot: reader({ [policyPath]: policy }) })
    expect(report.ok).toBe(false)
    expect(report.manifest.ok).toBe(false)
    expect(report.manifest.detail).toContain('incomplete')
  })
})

/** Stubs token and blob fetches and records every request, so a test can prove no write happened. */
function stubFetch(blobs: Record<string, Item>, options: { list?: string[] } = {}) {
  const requests: Array<{ method: string; host: string; path: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ method: init?.method ?? 'GET', host: url.hostname, path: url.pathname })
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
    if (url.hostname.endsWith('.blob.core.windows.net')) {
      if (url.searchParams.get('comp') === 'list') {
        const names = (options.list ?? []).map((name) => `<Blob><Name>${name}</Name></Blob>`).join('')
        return new Response(`<EnumerationResults><Blobs>${names}</Blobs><NextMarker></NextMarker></EnumerationResults>`)
      }
      const name = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/')
      const blob = blobs[name]
      if (!blob) return new Response('', { status: 404 })
      return Response.json(blob, { headers: { 'x-tenuvault-authenticated': 'true' } })
    }
    throw new Error(`Unexpected request ${url}`)
  }))
  return requests
}

const baseBody = { tenantId: 'tenant', appId: 'app', clientSecret: 'placeholder', storageAccountName: 'storage', backupId }
const request = (data: object) => new NextRequest('http://tenuvault.internal/api/restore-validate', { method: 'POST', body: JSON.stringify(data) })
afterEach(() => vi.unstubAllGlobals())

describe('Restore validation route', () => {
  it('validates a backup end to end without any Graph call or storage write', async () => {
    const metadata = metadataFor([['DeviceConfigurations/policy-1', policy, 'Example.json'], ['Apps/app-1', app, 'Web.json']])
    const requests = stubFetch({ [`${backupId}/metadata.json`]: metadata, [policyPath]: policy, [appPath]: app }, { list: [policyPath, appPath, `${backupId}/metadata.json`] })
    const response = await POST(request(baseBody))
    const report = await response.json()
    expect(response.status).toBe(200)
    expect(report).toMatchObject({ ok: true, total: 2, passed: 2, failed: 0 })
    expect(report.byType).toHaveLength(2)
    // No tenant write path is invoked: nothing reaches Microsoft Graph and storage is only read.
    expect(requests.filter((entry) => entry.host === 'graph.microsoft.com')).toEqual([])
    expect(requests.filter((entry) => entry.host.endsWith('.blob.core.windows.net') && entry.method !== 'GET')).toEqual([])
  })

  it('names the failing item when a file in the manifest is missing', async () => {
    const metadata = metadataFor([['DeviceConfigurations/policy-1', policy, 'Example.json'], ['Apps/app-1', app, 'Web.json']])
    stubFetch({ [`${backupId}/metadata.json`]: metadata, [policyPath]: policy }, { list: [policyPath] })
    const response = await POST(request(baseBody))
    const report = await response.json()
    expect(report.ok).toBe(false)
    expect(report.items.filter((item: ItemValidationLike) => !item.ok).map((item: ItemValidationLike) => item.path)).toEqual([appPath])
  })
})

interface ItemValidationLike { path: string; ok: boolean }

describe('Restore validation write isolation', () => {
  it('does not import a tenant write path', () => {
    for (const file of ['src/portal/lib/policies/restore-validation.ts', 'src/portal/app/api/restore-validate/route.ts']) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toContain('graph-restore')
      expect(source).not.toContain('Restorer')
      expect(source).not.toContain('graph.microsoft.com')
      expect(source).not.toContain('change-set')
    }
  })
})
