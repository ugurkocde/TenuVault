import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authorizeFrameworkTenant, handleNativeFramework, setNativeFrameworkAuthorization, setNativeFrameworkStore } from '../src/main/frameworks/native'
import { handleFramework, type ExportFile } from '../src/main/frameworks/service'
import { recordAssessment, recordCreation, setFrameworkStore } from '../src/main/frameworks/workspaces'
import { EXPORT_LIMITATIONS, REDACTED, redactSecrets, tenantLabel } from '../src/shared/compliance/export'
import type { NativeAssessment } from '../src/shared/compliance/native'
import type { Assessment, BaselinePolicy } from '../src/shared/frameworks/policies'
import type { Plan } from '../src/shared/plans'

const TENANT = '11111111-1111-1111-1111-111111111111'
const OTHER = '33333333-3333-3333-3333-333333333333'
const APP = '22222222-2222-2222-2222-222222222222'
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJ0aWQiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlMTIz'

function memory() {
  const values = new Map<string, string>()
  return { values, store: { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v) }, delete: (k: string) => { values.delete(k) } } }
}

afterEach(() => vi.unstubAllGlobals())

describe('redaction', () => {
  it('replaces secrets and token-like text but keeps ordinary settings and finding keys', () => {
    const value = redactSecrets({
      key: '0:1',
      passwordMinimumLength: 14,
      password: 'P@ss',
      client_secret: 'abc',
      nested: { settingInstance: { simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSecretSettingValue', value: 'wifi-psk', valueState: 'notEncrypted' } } },
      note: `Authorization: Bearer abcdefghijklmnop and ${JWT}`,
      passwordRequired: true,
    })
    expect(value.key).toBe('0:1')
    expect(value.passwordMinimumLength).toBe(14)
    expect(value.passwordRequired).toBe(true)
    expect(value.password).toBe(REDACTED)
    expect(value.client_secret).toBe(REDACTED)
    expect(value.nested.settingInstance.simpleSettingValue.value).toBe(REDACTED)
    expect(value.nested.settingInstance.simpleSettingValue.valueState).toBe('notEncrypted')
    expect(value.note).not.toContain('abcdefghijklmnop')
    expect(value.note).not.toContain(JWT)
  })

  it('redacts secrets under compound and spelled-out names the enumeration did not list', () => {
    const value = redactSecrets({
      wifiPassword: 'corp-wifi-psk',
      passwordValue: 'hunter2',
      authToken: 'auth-value',
      sessionToken: 'session-value',
      connectionString: 'Server=db;Password=x',
      encryptionKey: 'key-material',
      wirelessPreSharedKey: 'psk-value',
      nested: { vpnPsk: 'vpn-psk', apiToken: 'api-token' },
    })
    expect(value.wifiPassword).toBe(REDACTED)
    expect(value.passwordValue).toBe(REDACTED)
    expect(value.authToken).toBe(REDACTED)
    expect(value.sessionToken).toBe(REDACTED)
    expect(value.connectionString).toBe(REDACTED)
    expect(value.encryptionKey).toBe(REDACTED)
    expect(value.wirelessPreSharedKey).toBe(REDACTED)
    expect(value.nested.vpnPsk).toBe(REDACTED)
    expect(value.nested.apiToken).toBe(REDACTED)
    // Ordinary configuration whose names only mention those words stays readable.
    const kept = redactSecrets({
      passwordMinimumLength: 14,
      passwordRequired: true,
      passwordBlockSimple: true,
      passwordHistoryCount: 5,
      tokenLifetimeMinutes: 60,
      keyRotationEnabled: false,
    })
    expect(kept.passwordMinimumLength).toBe(14)
    expect(kept.passwordRequired).toBe(true)
    expect(kept.passwordBlockSimple).toBe(true)
    expect(kept.passwordHistoryCount).toBe(5)
    expect(kept.tokenLifetimeMinutes).toBe(60)
    expect(kept.keyRotationEnabled).toBe(false)
  })

  it('accepts only a short single-line tenant label', () => {
    expect(tenantLabel('Contoso\nLtd')).toBe('Contoso Ltd')
    expect(tenantLabel(42)).toBeUndefined()
    expect(tenantLabel('x'.repeat(500))?.length).toBe(120)
  })
})

describe('native framework exports', () => {
  const body = { tenantId: TENANT, appId: APP, frameworkId: 'iso-27001', tenantName: 'Contoso' }
  let fetch: ReturnType<typeof vi.fn>
  let values: Map<string, string>
  let run: NativeAssessment

  beforeEach(async () => {
    const m = memory(); values = m.values
    setNativeFrameworkStore(m.store)
    setNativeFrameworkAuthorization(async () => {})
    fetch = vi.fn(async (input: unknown) => String(input).includes('login.microsoftonline.com') ? Response.json({ access_token: 'mock-token' }) : Response.json({ value: [] }))
    vi.stubGlobal('fetch', fetch)
    run = (await (await handleNativeFramework({ ...body, action: 'native-assess' })).json()).run
    // A recorded observation that carries a token, to prove exports redact it.
    const stored = JSON.parse(values.get(`framework.native.v1.${TENANT}.iso-27001`)!) as NativeAssessment[]
    stored[0]!.assessment.capabilities.push({
      capability: { id: 'test-cap', platform: 'windows', name: 'Test capability', description: 'Test', signals: [] }, status: 'noEvidence', evidence: [], limitations: [],
      checks: [{ assessmentStatus: 'checked', result: 'different', settingId: 'test_setting', expectedValue: 'On', actualValue: `Bearer ${JWT}`, policyId: 'p1', policyName: 'Policy one' }],
    })
    values.set(`framework.native.v1.${TENANT}.iso-27001`, JSON.stringify(stored))
  })

  it('exports CSV and JSON from the saved run with report facts, limitations and redaction, without reading the tenant', async () => {
    const calls = fetch.mock.calls.length
    const csv = await handleNativeFramework({ ...body, action: 'native-csv', runId: run.runId })
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect(csv.headers.get('content-disposition')).toContain(`iso-27001-${run.runId}.csv`)
    const text = await csv.text()
    for (const expected of ['Contoso (11111111-1111-1111-1111-111111111111)', 'ISO/IEC 27001', 'Assessed scope', 'Collected', 'Supported coverage', 'Unknown', 'not an audit opinion, certification', 'does not prove', 'Test capability']) expect(text).toContain(expected)
    expect(text).not.toContain(JWT)
    const json = JSON.parse(await (await handleNativeFramework({ ...body, action: 'native-json', runId: run.runId })).text())
    expect(json.report).toMatchObject({ kind: 'native-comparison', tenant: { id: TENANT, name: 'Contoso' }, runId: run.runId, limitations: expect.arrayContaining(EXPORT_LIMITATIONS) })
    expect(json.report.framework.version).toBeTruthy()
    expect(JSON.stringify(json)).not.toContain(JWT)
    expect(JSON.stringify(json)).not.toMatch(/certified|compliant with/i)
    const pdf = await handleNativeFramework({ ...body, action: 'native-pdf', runId: run.runId })
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    expect(fetch.mock.calls).toHaveLength(calls)
  })

  it('keeps each tenant to its own saved runs and refuses a tenant the license does not cover', async () => {
    await expect(handleNativeFramework({ ...body, tenantId: OTHER, action: 'native-csv', runId: run.runId })).rejects.toMatchObject({ status: 404 })
    setNativeFrameworkAuthorization(async () => { throw new Error('Community covers one tenant') })
    await expect(handleNativeFramework({ ...body, action: 'native-json', runId: run.runId })).rejects.toThrow('Community covers one tenant')
  })

  it('lets Community export non-CIS reports when called directly and needs Pro for CIS reports', async () => {
    for (const plan of ['community', 'pro', 'msp'] as Plan[]) {
      setNativeFrameworkAuthorization(async () => plan)
      expect((await handleNativeFramework({ ...body, action: 'native-csv', runId: run.runId })).status).toBe(200)
      if (plan === 'community') await expect(authorizeFrameworkTenant(TENANT, true)).rejects.toMatchObject({ status: 402 })
      else await expect(authorizeFrameworkTenant(TENANT, true)).resolves.toBeUndefined()
    }
  })
})

describe('policy pack assessment exports', () => {
  const policy: BaselinePolicy = {
    name: 'Wi-Fi baseline', platforms: 'windows10', technologies: 'mdm', description: '',
    settings: [{ settingInstance: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance', settingDefinitionId: 'wifi_psk' } }],
  }
  const assessment: Assessment = {
    runId: 'run-1', tenantId: TENANT, frameworkId: 'custom', reference: 'Approved profile v2', assessedAt: '2026-09-26T10:00:00Z', policyCount: 3,
    findings: [{ key: '0:0', policyIndex: 0, settingIndex: 0, policyName: 'Wi-Fi baseline', settingId: 'wifi_psk', status: 'Different', recommended: { value: 'x' },
      observed: [{ policyId: 'p1', policyName: 'Tenant Wi-Fi', value: { simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSecretSettingValue', value: 'hunter2', valueState: 'notEncrypted' } }, targeting: { state: 'unavailable', targets: [], limitations: [] }, applicability: 'unavailable', enforcement: 'unavailable' }] }],
    organizationalEvidence: { state: 'manual', note: 'Organizational controls require a separate assessment.' },
  }
  const request = (action: string, extra: object = {}) => handleFramework({ action, tenantId: TENANT, frameworkId: 'custom', tenantName: 'Contoso', ...extra }) as Promise<{ file: ExportFile }>

  beforeEach(() => {
    setFrameworkStore(memory().store)
    setNativeFrameworkAuthorization(async () => 'community')
    recordAssessment(assessment, [policy])
    recordCreation(assessment, { success: false, results: [{ name: 'Wi-Fi baseline', error: 'Graph returned 400' }] })
    // Any network use during export fails the test.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No network during export') }))
  })

  it('exports CSV, JSON and PDF of a saved assessment on Community with facts, unknowns and redaction', async () => {
    const csv = (await request('workspace-csv', { runId: 'run-1' })).file
    expect(csv).toMatchObject({ name: 'framework-custom-run-1.csv', encoding: 'utf8' })
    for (const expected of ['Contoso', 'Custom Baselines', 'Approved profile v2', '2026-09-26T10:00:00Z', 'Not assessed', 'assignment evidence that could not be read', 'Different']) expect(csv.data).toContain(expected)
    expect(csv.data).not.toContain('hunter2')
    const json = JSON.parse((await request('workspace-json', { runId: 'run-1' })).file.data)
    expect(json.report).toMatchObject({ kind: 'policy-pack-assessment', framework: { profile: 'Approved profile v2' }, collectedAt: '2026-09-26T10:00:00Z' })
    expect(json.result.assessment.findings[0].key).toBe('0:0')
    expect(JSON.stringify(json)).not.toContain('hunter2')
    const pdf = (await request('workspace-pdf', { runId: 'run-1' })).file
    expect(pdf.encoding).toBe('base64')
    expect(Buffer.from(pdf.data, 'base64').subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('exports every saved assessment as JSON and reports missing runs', async () => {
    const all = JSON.parse((await request('workspace-json')).file.data)
    expect(all.assessments).toHaveLength(1)
    await expect(request('workspace-csv', { runId: 'missing' })).rejects.toMatchObject({ status: 404 })
    await expect(request('workspace-csv', { runId: 'run-1', tenantId: OTHER })).rejects.toMatchObject({ status: 404 })
    await expect(handleFramework({ action: 'workspace-json', tenantId: OTHER, frameworkId: 'custom' })).rejects.toMatchObject({ status: 404 })
  })

  it('refuses exports for a tenant the license does not cover', async () => {
    setNativeFrameworkAuthorization(async () => { throw new Error('Community covers one tenant') })
    await expect(request('workspace-json', { runId: 'run-1' })).rejects.toThrow('Community covers one tenant')
  })
})
