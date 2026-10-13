import { describe, expect, it, vi } from 'vitest'
import { sameRendererDocument, csvCell, assertArmPage, isMicrosoftLoginUrl } from '../src/shared/security'
import { ApiHost } from '../src/main/api/host'
import { buildRestorePlan } from '../src/shared/intune/restore-plan'
import { typeForFolder } from '../src/shared/intune/registry'

describe('credential and execution boundaries', () => {
  it('only trusts the exact renderer document, including for file URLs', () => {
    const trusted = 'file:///app/renderer/index.html'
    expect(sameRendererDocument(`${trusted}#/portal`, trusted)).toBe(true)
    expect(sameRendererDocument('file:///tmp/other.html', trusted)).toBe(false)
    expect(sameRendererDocument(`${trusted}?script=other`, trusted)).toBe(false)
    expect(sameRendererDocument('https://example.com', trusted)).toBe(false)
    expect(sameRendererDocument('not a URL', trusted)).toBe(false)
  })
  it.each(['../roleScopeTags#', 'id/../../', '', 'id?x=1'])('rejects template path injection %s', templateId => {
    expect(() => buildRestorePlan(typeForFolder('EndpointSecurityIntents')!, { templateId, displayName: 'Test' })).toThrow('GUID')
  })
  it.each(['=SUM(1,2)', '+cmd', '-cmd', '@cmd', '\t=cmd', '\r+cmd', '\tplain', '\rplain'])('escapes spreadsheet formulas %s', value => {
    expect(csvCell(value).replace(/^"/, '')).toMatch(/^'/)
  })
  it('only opens Microsoft login URLs for sign-in', () => {
    expect(isMicrosoftLoginUrl('https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/authorize?client_id=abc')).toBe(true)
    for (const url of [
      'http://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
      'https://login.microsoftonline.com.evil.test/tenant/oauth2/v2.0/authorize',
      'https://evil.test/?next=login.microsoftonline.com',
      'https://user:pass@login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
      'javascript:alert(1)',
      'not a URL',
    ]) expect(isMicrosoftLoginUrl(url)).toBe(false)
  })
  it('pins ARM paging and rejects cycles and overlong page chains', () => {
    const seen = new Set<string>()
    assertArmPage('https://management.azure.com/subscriptions', seen)
    expect(() => assertArmPage('https://management.azure.com/subscriptions', seen)).toThrow()
    for (const url of ['https://management.azure.com.evil.test/', 'https://evil.test/', 'http://management.azure.com/', 'https://u:p@management.azure.com/']) expect(() => assertArmPage(url, seen)).toThrow()
    expect(() => assertArmPage('https://management.azure.com/page', new Set(Array.from({ length: 1000 }, (_, i) => String(i))))).toThrow()
  })
  it.each(['valid@evil.test/', 'x/?', '', 123])('rejects invalid accounts before invoking a portal route', async storageAccountName => {
    const handler = vi.fn(() => Response.json({ success: true }))
    const host = new ApiHost({ routes: { '/api/audit/log': { POST: handler } } })
    const response = await host.dispatch(new Request('https://tenuvault.internal/api/audit/log', { method: 'POST', body: JSON.stringify({ storageAccountName }) }))
    expect(response.status).toBe(400)
    expect(handler).not.toHaveBeenCalled()
  })
})
