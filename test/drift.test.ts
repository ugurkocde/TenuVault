import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from '../src/main/api/next-server-shim'
import { compareObjects, POST as drift } from '../src/portal/app/api/detect-drifts/route'
import { driftActionBlockers } from '../src/shared/intune/drift'
import { POST as listBackups } from '../src/portal/app/api/list-backups/route'

const args = { tenantId: 'tenant', appId: 'app', clientSecret: 'test', storageAccountName: 'store', subscriptionId: 'local', resourceGroupName: 'local' }
const request = () => new NextRequest('http://tenuvault.internal/api/test', { method: 'POST', body: JSON.stringify(args) })
const prefixes = (names: string[]) => names.map(name => `<BlobPrefix><Name>${name}/</Name></BlobPrefix>`).join('')
afterEach(() => vi.unstubAllGlobals())

const setting = (id: string, value: string) => ({ id: '0', settingInstance: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance', settingDefinitionId: id, choiceSettingValue: { value, children: [] } } })

describe('Drift restore actions', () => {
  const installer = 'Intune does not let apps download installer files. Upload the installer again to restore this app.'

  it('blocks Recreate and Restore as copy for a deleted item that cannot be created again', () => {
    expect(driftActionBlockers({ changeType: 'deleted', createBlocker: installer })).toEqual({ revert: installer, copy: installer })
    expect(driftActionBlockers({ changeType: 'deleted' })).toEqual({ revert: undefined, copy: undefined })
  })

  it('blocks only the copy for a changed item that can still be written back in place', () => {
    expect(driftActionBlockers({ changeType: 'modified', createBlocker: installer })).toEqual({ revert: undefined, copy: installer })
    expect(driftActionBlockers({ changeType: 'modified', replaceBlocker: 'cannot be updated in place' })).toEqual({ revert: 'cannot be updated in place', copy: undefined })
  })

  it('offers no restore action for an added item', () => {
    expect(driftActionBlockers({ changeType: 'added', createBlocker: installer, replaceBlocker: installer })).toEqual({})
  })
})

describe('Drift comparison', () => {
  it('reports settings added to or removed from a Settings Catalog policy', () => {
    const before = { name: 'Policy', settings: [setting('a', 'a_1'), setting('b', 'b_1')] }
    const after = { name: 'Policy', settings: [setting('a', 'a_1'), setting('c', 'c_1')] }
    const changes = compareObjects(before, after)
    expect(changes.map(change => change.field).sort()).toEqual(['settings[b]', 'settings[c]'])
    expect(changes.find(change => change.field === 'settings[b]')).toMatchObject({ oldValue: before.settings[1], newValue: undefined })
    expect(changes.find(change => change.field === 'settings[c]')).toMatchObject({ oldValue: undefined, newValue: after.settings[1] })
  })

  it('ignores reordered settings and reports a changed value against its own setting', () => {
    const before = { settings: [setting('a', 'a_1'), setting('b', 'b_1')] }
    const after = { settings: [setting('b', 'b_2'), setting('a', 'a_1')] }
    expect(compareObjects(before, after)).toEqual([{ field: 'settings[b].settingInstance.choiceSettingValue.value', oldValue: 'b_1', newValue: 'b_2' }])
  })

  it('reports appended items and changed values in unkeyed arrays', () => {
    expect(compareObjects({ roleScopeTagIds: ['0'] }, { roleScopeTagIds: ['0', '12'] })).toEqual([{ field: 'roleScopeTagIds["12"]', oldValue: undefined, newValue: '12' }])
    expect(compareObjects({ rules: [{ grace: 0 }] }, { rules: [{ grace: 0 }, { grace: 24 }] })).toEqual([{ field: 'rules[1]', oldValue: undefined, newValue: { grace: 24 } }])
  })

  it('compares the two newest complete backups and skips incomplete or running ones', async () => {
    const status: Record<string, string | null> = {
      'backup-2026-09-25-120000': 'CompletedWithWarnings',
      'backup-2026-09-24-120000': null,
      'backup-2026-09-23-120000': 'Success',
      'backup-2026-09-22-120000': 'Success',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
      if (url.pathname === '/api/revert-metadata') return Response.json({ reverts: {} })
      if (url.searchParams.get('delimiter')) return new Response(prefixes(Object.keys(status)))
      const prefix = url.searchParams.get('prefix')
      if (prefix) {
        const folder = prefix.split('/')[0]!
        return new Response(`${folder}/DeviceConfigurations/A.json`.startsWith(prefix) ? `<Blob><Name>${folder}/DeviceConfigurations/A.json</Name></Blob>` : '')
      }
      const folder = decodeURIComponent(url.pathname.split('/')[2]!)
      if (url.pathname.endsWith('/metadata.json')) return status[folder] ? Response.json({ Status: status[folder] }) : new Response('', { status: 404 })
      return Response.json({ id: 'a', displayName: 'A', omaSettings: [{ displayName: 'Setting', value: folder.endsWith('23-120000') ? 2 : 1 }] })
    }))
    const response = await drift(request())
    expect(response.status).toBe(200)
    const { drifts } = await response.json()
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toMatchObject({ fromBackup: 'backup-2026-09-22-120000', toBackup: 'backup-2026-09-23-120000', fromBackupTimestamp: '2026-09-22T12:00:00.000Z', toBackupTimestamp: '2026-09-23T12:00:00.000Z' })
  })

  it('reports an added policy with a restored prefix, flagged as a likely restored copy', async () => {
    const older = 'backup-2026-09-22-120000'
    const newer = 'backup-2026-09-23-120000'
    const files: Record<string, string[]> = {
      [older]: [`${older}/DeviceConfigurations/A.json`],
      [newer]: [`${newer}/DeviceConfigurations/A.json`, `${newer}/DeviceConfigurations/B.json`, `${newer}/DeviceConfigurations/C.json`],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
      if (url.pathname === '/api/revert-metadata') return Response.json({ reverts: {} })
      if (url.searchParams.get('delimiter')) return new Response(prefixes([newer, older]))
      const prefix = url.searchParams.get('prefix')
      if (prefix) {
        const folder = prefix.split('/')[0]!
        return new Response((files[folder] ?? []).map(name => `<Blob><Name>${name}</Name></Blob>`).join(''))
      }
      if (url.pathname.endsWith('/metadata.json')) return Response.json({ Status: 'Success' })
      if (url.pathname.endsWith('/B.json')) return Response.json({ id: 'b', displayName: '[Restored] Legit' })
      if (url.pathname.endsWith('/C.json')) return Response.json({ id: 'c', displayName: 'Brand new' })
      return Response.json({ id: 'a', displayName: 'A' })
    }))
    const response = await drift(request())
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.drifts).toHaveLength(2)
    expect(result.drifts.find((entry: { configId: string }) => entry.configId === 'b')).toMatchObject({ changeType: 'added', configName: '[Restored] Legit', likelyRestoredCopy: true })
    expect(result.drifts.find((entry: { configId: string }) => entry.configId === 'c')).toMatchObject({ changeType: 'added', configName: 'Brand new' })
    expect(result.drifts.find((entry: { configId: string }) => entry.configId === 'c').likelyRestoredCopy).toBeUndefined()
    expect(result.summary).toMatchObject({ total: 2, added: 2 })
    expect(result.stats.compared).toBe(3)
  })

  it('marks a deleted app that needs its installer as not recreatable, and leaves a web app recreatable', async () => {
    const older = 'backup-2026-09-22-120000'
    const newer = 'backup-2026-09-23-120000'
    const files: Record<string, string[]> = {
      [older]: [`${older}/Apps/SevenZip.json`, `${older}/Apps/Portal.json`],
      [newer]: [],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
      if (url.pathname === '/api/revert-metadata') return Response.json({ reverts: {} })
      if (url.searchParams.get('delimiter')) return new Response(prefixes([newer, older]))
      const prefix = url.searchParams.get('prefix')
      if (prefix) {
        const folder = prefix.split('/')[0]!
        return new Response((files[folder] ?? []).map(name => `<Blob><Name>${name}</Name></Blob>`).join(''))
      }
      if (url.pathname.endsWith('/metadata.json')) return Response.json({ Status: 'Success' })
      if (url.pathname.endsWith('/SevenZip.json')) return Response.json({ id: 'w32', displayName: '7-Zip', '@odata.type': '#microsoft.graph.win32LobApp' })
      return Response.json({ id: 'web', displayName: 'Portal', '@odata.type': '#microsoft.graph.webApp', appUrl: 'https://example.invalid' })
    }))
    const response = await drift(request())
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.drifts).toHaveLength(2)
    const sevenZip = result.drifts.find((entry: { configId: string }) => entry.configId === 'w32')
    expect(sevenZip).toMatchObject({ changeType: 'deleted', configName: '7-Zip' })
    expect(sevenZip.createBlocker).toContain('installer')
    const portal = result.drifts.find((entry: { configId: string }) => entry.configId === 'web')
    expect(portal).toMatchObject({ changeType: 'deleted', configName: 'Portal' })
    expect(portal.createBlocker).toBeUndefined()
  })

  it('keeps a changed installer app revertible in place while blocking a copy of it', async () => {
    const older = 'backup-2026-09-22-120000'
    const newer = 'backup-2026-09-23-120000'
    const files: Record<string, string[]> = {
      [older]: [`${older}/Apps/SevenZip.json`],
      [newer]: [`${newer}/Apps/SevenZip.json`],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
      if (url.pathname === '/api/revert-metadata') return Response.json({ reverts: {} })
      if (url.searchParams.get('delimiter')) return new Response(prefixes([newer, older]))
      const prefix = url.searchParams.get('prefix')
      if (prefix) {
        const folder = prefix.split('/')[0]!
        return new Response((files[folder] ?? []).map(name => `<Blob><Name>${name}</Name></Blob>`).join(''))
      }
      if (url.pathname.endsWith('/metadata.json')) return Response.json({ Status: 'Success' })
      const folder = decodeURIComponent(url.pathname.split('/')[2]!)
      return Response.json({ id: 'w32', displayName: '7-Zip', '@odata.type': '#microsoft.graph.win32LobApp', informationUrl: folder === older ? 'https://example.invalid/old' : 'https://example.invalid/new' })
    }))
    const response = await drift(request())
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.drifts).toHaveLength(1)
    expect(result.drifts[0]).toMatchObject({ changeType: 'modified', configName: '7-Zip' })
    expect(result.drifts[0].createBlocker).toContain('installer')
    expect(result.drifts[0].replaceBlocker).toBeUndefined()
  })
})

describe('Backup list', () => {
  it('lists backups from every storage page', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test' })
      if (url.pathname.endsWith('/metadata.json')) return Response.json({ Status: 'Success' })
      const prefix = url.searchParams.get('prefix')
      if (prefix) return new Response(`<Blob><Name>${prefix}DeviceConfigurations/A.json</Name><Properties><Content-Length>10</Content-Length></Properties></Blob>`)
      const second = url.searchParams.get('marker') === 'page-2'
      return new Response(`${prefixes([second ? 'backup-2026-09-25-120000' : 'backup-2026-09-24-120000'])}<NextMarker>${second ? '' : 'page-2'}</NextMarker>`)
    }))
    const response = await listBackups(request())
    expect(response.status).toBe(200)
    const { backups } = await response.json()
    expect(backups.map((backup: { id: string }) => backup.id)).toEqual(['backup-2026-09-25-120000', 'backup-2026-09-24-120000'])
    expect(backups[0].policies.deviceConfigurations).toBe(1)
  })
})
