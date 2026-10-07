import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupListKey, backupListOf, refreshBackupList, resetBackupLists } from '../src/renderer/lib/backup-list'
import type { Tenant } from '../src/portal/contexts/TenantContext'

afterEach(() => {
  vi.unstubAllGlobals()
  resetBackupLists()
})

const TENANT = '11111111-1111-1111-1111-111111111111'
const tenant = (storageAccountName = 'store', appId = 'app') => ({
  credentials: { tenantId: TENANT.toUpperCase(), appId, clientSecret: '' },
  resources: { subscriptionId: '', subscriptionName: '', resourceGroupName: '', storageAccountName, automationAccountName: '' },
}) as unknown as Tenant
const backup = (id: string) => ({ id, timestamp: '2026-10-01T00:00:00.000Z', status: 'Success' })

/** Answers each /api/list-backups request when its `answer` is called, in any order. */
function pendingFetch() {
  const answers: Array<(response: Response) => void> = []
  const stub = vi.fn(() => new Promise<Response>(resolve => void answers.push(resolve)))
  vi.stubGlobal('fetch', stub)
  return { stub, answer: (index: number, response: Response) => answers[index]!(response) }
}

describe('Backup list cache', () => {
  it('keeps each tenant\'s list per storage account and needs both to list', () => {
    expect(backupListKey(tenant())).toBe(`${TENANT}/store`)
    expect(backupListKey(tenant('Other'))).toBe(`${TENANT}/other`)
    expect(backupListKey(tenant(''))).toBeNull()
    expect(backupListKey(null)).toBeNull()
    expect(backupListOf(null)).toEqual({ backups: null, error: '', loading: false })
  })

  it('keeps the list for the next visit and joins a refresh already running', async () => {
    const fetches = pendingFetch()
    const key = backupListKey(tenant())
    const first = refreshBackupList(tenant())
    const second = refreshBackupList(tenant())
    expect(second).toBe(first)
    expect(fetches.stub).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((fetches.stub.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ subscriptionId: 'local', resourceGroupName: 'local', storageAccountName: 'store' })
    expect(backupListOf(key)).toEqual({ backups: null, error: '', loading: true })
    fetches.answer(0, Response.json({ backups: [backup('b1')] }))
    await first
    expect(backupListOf(key)).toEqual({ backups: [backup('b1')], error: '', loading: false })

    // The next visit shows the kept list while it refreshes; a failed refresh keeps it too.
    const again = refreshBackupList(tenant())
    expect(backupListOf(key)).toMatchObject({ backups: [backup('b1')], loading: true })
    fetches.answer(1, Response.json({ error: 'Storage unavailable' }, { status: 503 }))
    await again
    expect(backupListOf(key)).toEqual({ backups: [backup('b1')], error: 'Storage unavailable', loading: false })
    expect(backupListOf(backupListKey(tenant('other')))).toMatchObject({ backups: null })
  })

  it('starts over when forced and drops the answer of the refresh it replaced', async () => {
    const fetches = pendingFetch()
    const key = backupListKey(tenant())
    const before = refreshBackupList(tenant())
    const forced = refreshBackupList(tenant(), { force: true })
    expect(forced).not.toBe(before)
    expect(fetches.stub).toHaveBeenCalledTimes(2)
    fetches.answer(1, Response.json({ backups: [backup('b2'), backup('b1')] }))
    await forced
    // Read before the newest backup finished, so it must not replace the newer list.
    fetches.answer(0, Response.json({ backups: [backup('b1')] }))
    await before
    expect(backupListOf(key)).toEqual({ backups: [backup('b2'), backup('b1')], error: '', loading: false })
  })

  it('does not join a refresh sent with credentials that changed since, and keeps the list meanwhile', async () => {
    const fetches = pendingFetch()
    const key = backupListKey(tenant())
    const first = refreshBackupList(tenant())
    fetches.answer(0, Response.json({ backups: [backup('b1')] }))
    await first
    const stale = refreshBackupList(tenant())
    const changed = refreshBackupList(tenant('store', 'new-app'))
    expect(changed).not.toBe(stale)
    expect(refreshBackupList(tenant('store', 'new-app'))).toBe(changed)
    expect(JSON.parse(String((fetches.stub.mock.calls[2] as unknown as [string, RequestInit])[1].body))).toMatchObject({ appId: 'new-app' })
    expect(backupListOf(key)).toMatchObject({ backups: [backup('b1')], loading: true })
    fetches.answer(2, Response.json({ backups: [backup('b2'), backup('b1')] }))
    await changed
    // The answer to the old credentials arrives last and is dropped.
    fetches.answer(1, Response.json({ backups: [] }))
    await stale
    expect(backupListOf(key)).toEqual({ backups: [backup('b2'), backup('b1')], error: '', loading: false })
  })
})
