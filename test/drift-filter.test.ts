import { describe, expect, it } from 'vitest'
import type { Drift, DriftResult, SettingNames } from '../src/shared/intune/drift'
import { driftCsv, driftJson } from '../src/shared/intune/drift-export'
import { driftFilterActive, driftFilterText, driftSearchText, driftTypes, filterDrifts, NO_DRIFT_FILTER } from '../src/shared/intune/drift-filter'
import { matchesTerms, searchTerms } from '../src/shared/search'

const REVEAL = 'device_vendor_msft_policy_config_credentialsui_disablepasswordreveal'
const NAMES: SettingNames = { settings: { [REVEAL]: 'Do not display the password reveal button' }, options: {} }

const drift = (overrides: Partial<Drift>): Drift => ({
  id: 'd1', tenant: 'Contoso', tenantId: 't', severity: 'info', type: 'Configuration Policy', configName: 'Baseline', configId: 'id-1',
  changeType: 'modified', detectedAt: '2026-10-07T00:00:00Z', fromBackup: 'backup-a', toBackup: 'backup-b',
  description: '', impact: '', affectedPolicies: 1, affectedDevices: 0, ...overrides,
})

const drifts = [
  drift({ id: 'a', configName: 'Windows Firewall', type: 'Device Configuration', changeType: 'modified', changes: [{ field: 'passwordMinimumLength', oldValue: 8, newValue: 12 }] }),
  drift({ id: 'b', configName: 'Credential UI', type: 'Configuration Policy', changeType: 'modified', changes: [{ field: `settings[${REVEAL}].settingInstance.choiceSettingValue.value`, oldValue: `${REVEAL}_0`, newValue: `${REVEAL}_1` }] }),
  drift({ id: 'c', configName: 'Old compliance', previousName: 'Legacy compliance', type: 'Compliance Policy', changeType: 'deleted' }),
  drift({ id: 'd', configName: '[Restored] Windows Firewall', type: 'Device Configuration', changeType: 'added' }),
]
const text = (item: Drift) => driftSearchText(item, NAMES)
const ids = (list: Drift[]) => list.map(item => item.id)

describe('Search terms', () => {
  it('splits on whitespace, lowercases and requires every term', () => {
    expect(searchTerms('  Windows   FIREWALL ')).toEqual(['windows', 'firewall'])
    expect(searchTerms('   ')).toEqual([])
    expect(matchesTerms('windows firewall', ['fire', 'win'])).toBe(true)
    expect(matchesTerms('windows firewall', ['fire', 'mac'])).toBe(false)
    expect(matchesTerms('anything', [])).toBe(true)
  })
})

describe('Drift filter', () => {
  it('shows everything without a filter', () => {
    expect(driftFilterActive(NO_DRIFT_FILTER)).toBe(false)
    expect(driftFilterActive({ ...NO_DRIFT_FILTER, query: '   ' })).toBe(false)
    expect(ids(filterDrifts(drifts, NO_DRIFT_FILTER, text))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('searches item names, previous names and types, case-insensitively and with every term', () => {
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, query: 'FIREWALL' }, text))).toEqual(['a', 'd'])
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, query: 'firewall restored' }, text))).toEqual(['d'])
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, query: 'legacy' }, text))).toEqual(['c'])
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, query: 'compliance policy' }, text))).toEqual(['c'])
  })

  it('searches changed settings by readable name and by raw path', () => {
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, query: 'password reveal' }, text))).toEqual(['b'])
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, query: 'disablepasswordreveal' }, text))).toEqual(['b'])
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, query: 'minimum length' }, text))).toEqual(['a'])
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, query: 'passwordMinimumLength' }, text))).toEqual(['a'])
  })

  it('combines change type, policy type and search', () => {
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, change: 'modified' }, text))).toEqual(['a', 'b'])
    expect(ids(filterDrifts(drifts, { ...NO_DRIFT_FILTER, type: 'Device Configuration' }, text))).toEqual(['a', 'd'])
    expect(ids(filterDrifts(drifts, { query: 'firewall', change: 'added', type: 'Device Configuration' }, text))).toEqual(['d'])
    expect(ids(filterDrifts(drifts, { query: 'firewall', change: 'deleted', type: '' }, text))).toEqual([])
  })

  it('lists the policy types present in alphabetical order', () => {
    expect(driftTypes(drifts)).toEqual(['Compliance Policy', 'Configuration Policy', 'Device Configuration'])
  })

  it('describes an active filter for exported reports', () => {
    expect(driftFilterText(NO_DRIFT_FILTER)).toBe('')
    expect(driftFilterText({ query: ' firewall ', change: 'modified', type: 'Device Configuration' })).toBe('search: firewall; change: modified; type: Device Configuration')
  })
})

describe('Filtered drift export', () => {
  const result = (shown: Drift[]): DriftResult => ({
    drifts: shown, summary: { total: 0, critical: 0, warning: 0, info: 0, added: 0, modified: 0, deleted: 0, affectedTenants: 1 }, lastScan: '2026-10-07T03:00:00Z', backupsAnalyzed: 2,
    baseline: { id: 'backup-a', timestamp: '2026-10-06T02:00:00Z', trigger: 'scheduled', status: 'Success' },
    comparison: { id: 'backup-b', timestamp: '2026-10-07T02:00:00Z', trigger: 'scheduled', status: 'Success' },
    warnings: [], stats: { compared: 4, unchanged: 0 }, settingNames: NAMES,
  })

  it('writes only the shown changes, with matching counts and the filter', () => {
    const filter = { ...NO_DRIFT_FILTER, query: 'firewall' }
    const shown = filterDrifts(drifts, filter, text)
    const json = JSON.parse(driftJson(result(shown), 'Contoso', '2026-10-08T00:00:00Z', driftFilterText(filter)))
    expect(json.filter).toBe('search: firewall')
    expect(json.counts).toEqual({ added: 1, modified: 1, deleted: 0 })
    expect(json.items.map((item: { name: string }) => item.name)).toEqual(['Windows Firewall', '[Restored] Windows Firewall'])
    const csv = driftCsv(result(shown))
    expect(csv).toContain('Windows Firewall')
    expect(csv).not.toContain('Credential UI')
  })

  it('leaves the filter out of an unfiltered report', () => {
    expect(JSON.parse(driftJson(result(drifts), 'Contoso', '2026-10-08T00:00:00Z'))).not.toHaveProperty('filter')
  })
})
