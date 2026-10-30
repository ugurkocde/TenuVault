import { beforeEach, describe, expect, it, vi } from 'vitest'
import { graphCaller } from '../src/portal/lib/policies/graph-restore'
import { POST as journalRequest } from '../src/portal/app/api/restore-journal/route'
import { setRestoreJournalStore, writeRecords, saveWrite, writeKey, setRestoreJournalAuthorization } from '../src/main/storage/restore-journal'
const tenant = '11111111-1111-1111-1111-111111111111'
beforeEach(() => { setRestoreJournalAuthorization(async id => { if (id !== tenant) throw new Error('Not authorized') }); const data = new Map<string, string>(); setRestoreJournalStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } }) })
describe('bounded Graph retries', () => {
  it('honors Retry-After for explicitly rejected POSTs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValueOnce(Response.json({ id: 'created' }, { status: 201 }))
    const sleep = vi.fn(async () => {})
    expect(await graphCaller('token', fetcher, { tenant, sleep })('POST', 'deviceManagement/deviceCategories', { displayName: 'A' })).toMatchObject({ status: 201 })
    expect(sleep).toHaveBeenCalledWith(2000)
    expect(writeRecords()[0]).toMatchObject({ state: 'complete', objectId: 'created' })
  })
  it('stops after four throttled attempts and does not shorten a long server delay', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 429 }))
    const caller = graphCaller('token', fetcher, { sleep: async () => {} })
    expect((await caller('GET', 'deviceManagement/deviceCategories')).status).toBe(429)
    expect(fetcher).toHaveBeenCalledTimes(4)
    fetcher.mockReset().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '120' } }))
    await caller('GET', 'deviceManagement/deviceCategories')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('renews an expired token once and uses it on the next attempt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(Response.json({ value: [] }))
    const refreshToken = vi.fn(async () => 'renewed')
    await graphCaller('expired', fetcher, { refreshToken })('GET', 'deviceManagement/deviceCategories')
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[1]![1]!.headers).toMatchObject({ Authorization: 'Bearer renewed' })
  })
  it('persists a dropped creation response and requires reconciliation before repeating the POST', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('response dropped'))
    await expect(graphCaller('token', fetcher, { tenant })('POST', 'deviceManagement/deviceCategories', { displayName: 'A' })).rejects.toThrow('dropped')
    await expect(graphCaller('new-token', fetcher, { tenant })('POST', 'deviceManagement/deviceCategories', { displayName: 'A' })).rejects.toThrow('Reconcile')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const record = writeRecords()[0]!
    saveWrite({ ...record, state: 'reconciled', objectId: 'confirmed-existing' })
    fetcher.mockImplementation(async () => Response.json({ id: 'confirmed-existing', displayName: 'A' }))
    expect(await graphCaller('new-token', fetcher, { tenant })('POST', 'deviceManagement/deviceCategories', { displayName: 'A' })).toEqual({ status: 200, body: { id: 'confirmed-existing' } })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(JSON.stringify(writeRecords())).not.toContain('new-token')
  })
  it('records the source snapshot ID on completed creations', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 'created' }, { status: 201 }))
    await graphCaller('token', fetcher, { tenant })('POST', 'deviceManagement/deviceCategories', { displayName: 'A' }, { sourceId: 'snapshot-object' })
    expect(writeRecords()[0]).toMatchObject({ state: 'complete', objectId: 'created', sourceId: 'snapshot-object' })
  })
  it('checks authorization before retrying a throttled write', async () => {
    let allowed = true
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } })).mockResolvedValueOnce(Response.json({ id: 'created' }, { status: 201 }))
    const caller = graphCaller('token', fetcher, { tenant, sleep: async () => { allowed = false } })
    await expect(caller('POST', 'deviceManagement/deviceCategories', { displayName: 'A' }, { beforeAttempt: () => { if (!allowed) throw new Error('CIS access ended') } })).rejects.toThrow('CIS access ended')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('checks authorization before refreshing an expired token', async () => {
    let allowed = true
    const fetcher = vi.fn<typeof fetch>(async () => { allowed = false; return new Response('', { status: 401 }) })
    const refreshToken = vi.fn(async () => 'renewed')
    const caller = graphCaller('expired', fetcher, { refreshToken })
    await expect(caller('GET', 'deviceManagement/deviceCategories', undefined, { beforeAttempt: () => { if (!allowed) throw new Error('CIS access ended') } })).rejects.toThrow('CIS access ended')
    expect(refreshToken).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not retry an ambiguous 503 POST', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }))
    await graphCaller('token', fetcher, { tenant })('POST', 'deviceManagement/deviceCategories', {})
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(writeRecords()[0]?.state).toBe('uncertain')
  })
})

it('sets an unreadable write journal aside instead of throwing or losing it silently', () => {
  const data = new Map<string, string>([['restore.write-journal', '{corrupt']])
  setRestoreJournalStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
  expect(writeRecords()).toEqual([])
  const aside = [...data.entries()].filter(([key]) => key.startsWith('restore.write-journal.unreadable.'))
  expect(aside).toHaveLength(1)
  expect(aside[0]![1]).toBe('{corrupt')
  saveWrite({ key: 'k1', tenant, method: 'POST', path: 'deviceManagement/deviceCategories', at: new Date().toISOString(), state: 'complete', objectId: 'created' })
  expect(writeRecords()).toMatchObject([{ key: 'k1', state: 'complete' }])
})

it('keeps reconciled retries reusable until an explicit new operation is confirmed', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('dropped')).mockImplementation(async (_url, init) => init?.method === 'GET' ? Response.json({ id: 'existing', displayName: 'A' }) : Response.json({ id: 'new-object' }, { status: 201 }))
  const caller = graphCaller('token', fetcher, { tenant })
  await expect(caller('POST', 'deviceManagement/deviceCategories', { displayName: 'A' })).rejects.toThrow('dropped')
  const record = writeRecords()[0]!
  saveWrite({ ...record, state: 'reconciled', objectId: 'existing', at: '2000-01-01T00:00:00Z' })
  for (let i = 0; i < 2; i++) expect((await caller('POST', 'deviceManagement/deviceCategories', { displayName: 'A' })).body.id).toBe('existing')
  expect(Date.parse(writeRecords()[0]!.at)).toBeGreaterThan(Date.now() - 60_000)
  expect(writeRecords()[0]!.state).toBe('reconciled')
  const request = (confirmed: boolean) => new Request('https://tenuvault.internal/api/restore-journal', { method: 'POST', body: JSON.stringify({ tenantId: tenant, action: 'new-operation', key: record.key, confirmed }) })
  expect((await journalRequest(request(false))).status).toBe(400)
  expect((await journalRequest(request(true))).status).toBe(200)
  expect((await caller('POST', 'deviceManagement/deviceCategories', { displayName: 'A' })).body.id).toBe('new-object')
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
})
it('evicts old reconciliations while preserving uncertain and recently reconciled writes', () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ key: String(i), tenant, method: 'POST', path: 'deviceManagement/deviceCategories', at: new Date().toISOString(), state: 'uncertain' }))
  entries[0] = { ...entries[0]!, state: 'reconciled', at: '2000-01-01T00:00:00Z' }
  entries[1] = { ...entries[1]!, state: 'reconciled' }
  let raw = JSON.stringify(entries)
  setRestoreJournalStore({ get: () => raw, set: (_k, v) => { raw = v }, delete: () => {} })
  saveWrite({ key: 'new', tenant, method: 'POST', path: 'deviceManagement/deviceCategories', at: new Date().toISOString(), state: 'uncertain' })
  expect(writeRecords()).toHaveLength(1000)
  expect(writeRecords().some(r => r.key === '0')).toBe(false)
  expect(writeRecords().some(r => r.key === '1')).toBe(true)
  expect(() => saveWrite({ key: 'full', tenant, method: 'POST', path: 'x', at: new Date().toISOString(), state: 'uncertain' })).toThrow('full')
})

it.each([
  { id: 'other', displayName: 'Wanted' },
  { id: 'confirmed', displayName: 'Wrong policy' },
  { id: 'confirmed', displayName: 'Wanted' },
])('rejects reconciled creations whose ID or original fields cannot be verified: %j', async current => {
  const body = { displayName: 'Wanted', description: 'Expected description' }
  saveWrite({ key: writeKey(tenant, 'POST', 'deviceManagement/deviceCategories', body), tenant, method: 'POST', path: 'deviceManagement/deviceCategories', at: new Date().toISOString(), state: 'reconciled', objectId: 'confirmed' })
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(current))
  await expect(graphCaller('token', fetcher, { tenant })('POST', 'deviceManagement/deviceCategories', body)).rejects.toThrow('does not match')
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
})
it('keeps bounded policy labels for different uncertain requests without storing their payloads', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('dropped') })
  for (const displayName of ['Policy A', 'Policy B']) await expect(graphCaller('token', fetcher, { tenant })('POST', 'deviceManagement/deviceCategories', { displayName, description: 'private payload value' })).rejects.toThrow()
  expect(writeRecords().map(record => record.label)).toEqual(['Policy A', 'Policy B'])
  expect(JSON.stringify(writeRecords())).not.toContain('private payload value')
})

it('allows correcting a reconciled ID without permitting another creation', async () => {
  const body = { displayName: 'Wanted' }, key = writeKey(tenant, 'POST', 'deviceManagement/deviceCategories', body)
  saveWrite({ key, tenant, method: 'POST', path: 'deviceManagement/deviceCategories', at: new Date().toISOString(), state: 'reconciled', objectId: 'wrong' })
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 'correct', displayName: 'Wanted' }))
  const caller = graphCaller('token', fetcher, { tenant })
  await expect(caller('POST', 'deviceManagement/deviceCategories', body)).rejects.toThrow('does not match')
  const response = await journalRequest(new Request('https://tenuvault.internal/api/restore-journal', { method: 'POST', body: JSON.stringify({ tenantId: tenant, action: 'applied', key, confirmed: true, objectId: 'correct' }) }))
  expect(response.status).toBe(200)
  expect((await caller('POST', 'deviceManagement/deviceCategories', body)).body.id).toBe('correct')
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
})

it('requires authorization and scopes journal listing and mutations to the selected tenant', async () => {
  const other = '22222222-2222-2222-2222-222222222222'
  for (const [key, id] of [['own', tenant], ['other', other]]) saveWrite({ key: key!, tenant: id!, method: 'POST', path: 'deviceManagement/deviceCategories', at: new Date().toISOString(), state: 'uncertain' })
  const request = (body: object) => journalRequest(new Request('https://tenuvault.internal/api/restore-journal', { method: 'POST', body: JSON.stringify(body) }))
  expect((await request({ action: 'list' })).status).toBe(400)
  expect((await request({ tenantId: other, action: 'list' })).status).toBe(403)
  const listed = await (await request({ tenantId: tenant, action: 'list' })).json()
  expect(listed.records.map((record: { key: string }) => record.key)).toEqual(['own'])
  expect((await request({ tenantId: tenant, action: 'not-applied', key: 'other', confirmed: true })).status).toBe(409)
  expect(writeRecords().find(record => record.key === 'other')?.state).toBe('uncertain')
  setRestoreJournalAuthorization(async () => { throw new Error('Session ended') })
  expect((await request({ tenantId: tenant, action: 'not-applied', key: 'own', confirmed: true })).status).toBe(403)
  expect(writeRecords()).toHaveLength(2)
})

it.each([true, false])('verifies createInstance settings through their collection before replay (match=%s)', async matching => {
  const template = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', path = `deviceManagement/templates/${template}/createInstance`
  const setting = { '@odata.type': '#microsoft.graph.deviceManagementBooleanSettingInstance', definitionId: 'definition', value: true, valueJson: 'true' }
  const body = { displayName: 'Baseline', description: null, roleScopeTagIds: ['0'], settingsDelta: [setting] }
  saveWrite({ key: writeKey(tenant, 'POST', path, body), tenant, method: 'POST', path, at: new Date().toISOString(), state: 'reconciled', objectId: 'intent' })
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input)
    if (url.endsWith('/settings')) return Response.json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/beta/deviceManagement/intents/intent/settings?page=2' })
    if (url.endsWith('settings?page=2')) return Response.json({ value: [{ ...setting, id: 'setting-id', value: matching }] })
    if (url.endsWith('/assignments')) return Response.json({ value: [] })
    return Response.json({ id: 'intent', templateId: template, displayName: 'Baseline', description: null, roleScopeTagIds: ['0'] })
  })
  const result = graphCaller('token', fetcher, { tenant })('POST', path, body)
  if (matching) expect((await result).body.id).toBe('intent')
  else await expect(result).rejects.toThrow('does not match')
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
})
