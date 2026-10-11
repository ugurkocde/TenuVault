import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST as exportLogs } from '../src/portal/app/api/audit/export/route'
import { POST as queryLogs } from '../src/portal/app/api/audit/logs/route'
import { NextRequest } from '../src/main/api/next-server-shim'
import { actorLabel, auditExportCSV, auditExportJSON, entriesForTenant, OWN_OPERATION_NOTICE, outcomeLabel, redactAuditEntry } from '../src/portal/lib/audit/export'
import { queueEvent, setAuditOutboxStore } from '../src/portal/lib/audit/outbox'
import { AuditEventType, AuditResult, AuditSeverity, type AuditLogEntry } from '../src/portal/lib/audit/types'

const TENANT = '11111111-1111-1111-1111-111111111111'
const OTHER = '33333333-3333-3333-3333-333333333333'
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJ0aWQiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlMTIz'
const filter = { startDate: new Date('2026-09-24T00:00:00'), endDate: new Date('2026-09-24T23:59:59') }

function entry(id: string, overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id, timestamp: '2026-09-24T12:00:00Z', eventType: AuditEventType.RESTORE_COMPLETED, severity: AuditSeverity.INFO,
    user: { id: 'admin@contoso.com', email: 'admin@contoso.com', name: 'Admin', tenantId: TENANT }, action: `Restore ${id}`,
    resource: { type: 'backup', id: 'backup-1', name: 'Backup' }, result: AuditResult.SUCCESS, context: { ipAddress: 'unknown', userAgent: 'desktop', correlationId: 'c1' },
    ...overrides,
  }
}

/** One storage account holding entries of this tenant, another tenant and an older unstamped entry. */
function storage(entries: AuditLogEntry[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'storage-token' })
    if (url.searchParams.get('comp') === 'list') return new Response(url.searchParams.get('prefix')!.includes('20260924')
      ? '<Blobs><Blob><Name>day.json</Name></Blob></Blobs><NextMarker></NextMarker>' : '<Blobs />')
    return Response.json({ entries })
  }))
}

const history = () => [
  entry('mine', {
    details: { source: 'desktop', statusCode: 200, authorization: `Bearer ${JWT}`, clientSecret: 'shh', payload: { settings: [{ secret: 'x' }] }, error: { code: 'E', message: 'failed', stack: 'at secret.ts:1' } },
  }),
  entry('theirs', { user: { id: 'other@fabrikam.com', email: 'other@fabrikam.com', name: 'Other', tenantId: OTHER } }),
  entry('legacy', { timestamp: '2026-09-24T08:00:00Z', user: { id: 'unknown', email: 'unknown', name: 'Unknown user' }, result: 'INTERRUPTED' as AuditResult }),
]

const body = (extra: object) => JSON.stringify({ tenantId: TENANT, appId: 'app', clientSecret: 'test', storageAccountName: 'store', ...extra })

afterEach(() => { vi.unstubAllGlobals(); setAuditOutboxStore(undefined) })

describe('own-operation history exports', () => {
  it('redacts tokens, credentials, payloads and stack traces but keeps identity, scope and outcome', () => {
    const safe = redactAuditEntry(history()[0]!)
    const text = JSON.stringify(safe)
    for (const secret of [JWT, 'shh', 'at secret.ts:1', '"secret":"x"']) expect(text).not.toContain(secret)
    expect(safe.details?.payload).toBe('[omitted: payload]')
    expect(safe.details?.statusCode).toBe(200)
    expect(safe).toMatchObject({ id: 'mine', action: 'Restore mine', result: 'SUCCESS', user: { email: 'admin@contoso.com' }, resource: { id: 'backup-1' } })
  })

  it('labels unknown actors and outcomes instead of guessing', () => {
    const [, , legacy] = history()
    expect(actorLabel(legacy!)).toBe('Not recorded')
    expect(outcomeLabel(legacy!.result)).toBe('Unknown')
    expect(outcomeLabel(AuditResult.PARTIAL)).toBe('Partial')
    expect(actorLabel(history()[0]!)).toBe('Admin <admin@contoso.com>')
  })

  it('keeps only the requested tenant and older unstamped entries of its own storage', () => {
    expect(entriesForTenant(history(), TENANT).map(e => e.id)).toEqual(['mine', 'legacy'])
    expect(entriesForTenant(history(), OTHER.toUpperCase()).map(e => e.id)).toEqual(['theirs', 'legacy'])
  })

  it('states the history scope, completeness and redaction in both formats', () => {
    const meta = { tenantId: TENANT, exportedAt: '2026-09-30T00:00:00Z', filter, pendingCount: 2 }
    const json = JSON.parse(auditExportJSON(history(), meta))
    expect(json).toMatchObject({ notice: OWN_OPERATION_NOTICE, tenantId: TENANT, count: 3 })
    expect(json.completeness).toContain('2 recorded events are still waiting')
    const csv = auditExportCSV(history(), { ...meta, pendingCount: null })
    expect(csv).toContain('not a complete Microsoft tenant audit')
    expect(csv).toContain('could not be counted')
    expect(csv).not.toContain(JWT)
  })
})

describe('own-operation history routes', () => {
  it('lets a direct export return only this tenant, redacted, with the notice', async () => {
    storage(history())
    const response = await exportLogs(new NextRequest('http://tenuvault.internal/api/audit/export', { method: 'POST', body: body({ exportOptions: { format: 'json', filter, includeDetails: true } }) }))
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.notice).toBe(OWN_OPERATION_NOTICE)
    expect(json.logs.map((e: AuditLogEntry) => e.id)).toEqual(['mine', 'legacy'])
    expect(JSON.stringify(json)).not.toContain(JWT)
    expect(JSON.stringify(json)).not.toContain('storage-token')
  })

  it('reports events still waiting to be saved, so an interrupted write is not silently missing', async () => {
    storage(history())
    queueEvent('store', entry('pending'))
    const csv = await (await exportLogs(new NextRequest('http://tenuvault.internal/api/audit/export', { method: 'POST', body: body({ exportOptions: { format: 'csv', filter } }) }))).text()
    expect(csv).toContain('1 recorded events are still waiting')
  })

  it('pages this tenant only in the history view', async () => {
    storage(history())
    const response = await queryLogs(new NextRequest('http://tenuvault.internal/api/audit/logs', { method: 'POST', body: body({ filter: { ...filter, limit: 1, offset: 1 } }) }))
    const json = await response.json()
    expect(json.data.map((e: AuditLogEntry) => e.id)).toEqual(['legacy'])
    expect(JSON.stringify(json.data)).not.toContain('clientSecret":"shh')
  })
})
