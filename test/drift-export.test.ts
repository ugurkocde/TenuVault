import { beforeEach, describe, expect, it } from 'vitest'
import type { Drift, DriftResult, SettingNames } from '../src/shared/intune/drift'
import { definitionIdsIn, formatValue, settingLabel } from '../src/shared/intune/drift-format'
import { driftCsv, driftExportName, driftJson } from '../src/shared/intune/drift-export'
import { clearSettingNames, readSettingNames } from '../src/portal/lib/drift/setting-names'
import type { GraphCall } from '../src/portal/lib/policies/graph-restore'

const DEFENDER = 'device_vendor_msft_policy_config_defender_allowcloudprotection'
const REVEAL = 'device_vendor_msft_policy_config_credentialsui_disablepasswordreveal'
const NAMES: SettingNames = {
  settings: { [DEFENDER]: 'Allow Cloud Protection', [REVEAL]: 'Do not display the password reveal button' },
  options: { [`${DEFENDER}_1`]: 'Allowed. Turns on Cloud Protection.', [`${REVEAL}_1`]: 'Enabled', [`${REVEAL}_0`]: 'Disabled' },
}

const drift = (overrides: Partial<Drift>): Drift => ({
  id: 'd1', tenant: 'Contoso', tenantId: 't', severity: 'info', type: 'Configuration Policy', configName: 'Baseline', configId: 'id-1',
  changeType: 'modified', detectedAt: '2026-10-07T00:00:00Z', fromBackup: 'backup-2026-10-06-020000', toBackup: 'backup-2026-10-07-020000',
  description: '', impact: '', affectedPolicies: 1, affectedDevices: 0, ...overrides,
})

const result = (drifts: Drift[], settingNames?: SettingNames): DriftResult => ({
  drifts, summary: { total: 0, critical: 0, warning: 0, info: 0, added: 0, modified: 0, deleted: 0, affectedTenants: 1 }, lastScan: '2026-10-07T03:00:00Z', backupsAnalyzed: 2,
  baseline: { id: 'backup-2026-10-06-020000', timestamp: '2026-10-06T02:00:00Z', trigger: 'scheduled', status: 'Success' },
  comparison: { id: 'backup-2026-10-07-020000', timestamp: '2026-10-07T02:00:00Z', trigger: 'scheduled', status: 'Success' },
  warnings: [], stats: { compared: 1, unchanged: 0 }, ...(settingNames ? { settingNames } : {}),
})

describe('Setting names from Graph definitions', () => {
  it('replaces derived labels and choice values when names are known', () => {
    const field = `settings[${REVEAL}].settingInstance.choiceSettingValue.value`
    expect(settingLabel({ field }).label).toBe('Credentials UI: Disablepasswordreveal')
    expect(settingLabel({ field }, NAMES).label).toBe('Do not display the password reveal button')
    expect(formatValue(`${REVEAL}_1`, REVEAL, NAMES)).toEqual({ kind: 'text', text: 'Enabled', raw: `${REVEAL}_1` })
    expect(formatValue({ settingInstance: { settingDefinitionId: DEFENDER, choiceSettingValue: { value: `${DEFENDER}_1` } } }, undefined, NAMES))
      .toMatchObject({ kind: 'json', summary: 'Allow Cloud Protection = Allowed. Turns on Cloud Protection.' })
  })

  it('collects the definition IDs of Settings Catalog changes only', () => {
    const ids = definitionIdsIn([
      { field: `settings[${REVEAL}].settingInstance.choiceSettingValue.value`, oldValue: `${REVEAL}_0`, newValue: `${REVEAL}_1` },
      { field: `settings[${DEFENDER}]`, oldValue: null, newValue: { settingInstance: { settingDefinitionId: DEFENDER, choiceSettingValue: { children: [{ settingDefinitionId: 'child_setting' }] } } } },
      { field: 'passwordMinimumLength', oldValue: 8, newValue: 12 },
    ])
    expect(ids.sort()).toEqual(['child_setting', DEFENDER, REVEAL].sort())
  })
})

describe('readSettingNames', () => {
  beforeEach(() => clearSettingNames())

  it('reads each definition once, skips unknown ones and keeps option labels', async () => {
    const calls: string[] = []
    const graph: GraphCall = async (_method, path) => {
      calls.push(path)
      if (path.endsWith(encodeURIComponent('missing_setting'))) return { status: 404, body: {} as Record<string, never> }
      return { status: 200, body: { displayName: 'Allow Cloud Protection', options: [{ itemId: `${DEFENDER}_1`, displayName: 'Allowed. Turns on Cloud Protection.' }] } }
    }
    const names = await readSettingNames([DEFENDER, 'missing_setting'], graph)
    expect(names).toEqual({ settings: { [DEFENDER]: 'Allow Cloud Protection' }, options: { [`${DEFENDER}_1`]: 'Allowed. Turns on Cloud Protection.' } })
    await readSettingNames([DEFENDER, 'missing_setting'], graph)
    expect(calls).toEqual([`deviceManagement/configurationSettings/${DEFENDER}`, 'deviceManagement/configurationSettings/missing_setting'])
  })

  it('returns no names when Graph refuses, without throwing', async () => {
    const names = await readSettingNames([DEFENDER], async () => ({ status: 403, body: {} }))
    expect(names).toEqual({ settings: {}, options: {} })
  })
})

describe('Drift export', () => {
  const drifts = [
    drift({ changes: [
      { field: `settings[${REVEAL}].settingInstance.choiceSettingValue.value`, oldValue: `${REVEAL}_0`, newValue: `${REVEAL}_1` },
      { field: 'description', oldValue: '=cmd', newValue: '-1' },
    ] }),
    drift({ id: 'd2', configName: 'Old, removed', changeType: 'deleted', configId: 'id-2' }),
  ]

  it('names the file after the tenant and the compared pair', () => {
    expect(driftExportName(result([]), 'Contoso Ltd.')).toBe('drift-contoso-ltd-backup-2026-10-06-020000-to-backup-2026-10-07-020000')
    expect(driftExportName(result([]))).toBe('drift-backup-2026-10-06-020000-to-backup-2026-10-07-020000')
  })

  it('writes one CSV row per changed setting and one per added or deleted item', () => {
    const lines = driftCsv(result(drifts, NAMES)).split('\r\n')
    expect(lines[0]).toBe('Item,Item type,Change,Severity,Previous name,Setting,Setting path,Before,After,Item ID')
    expect(lines[1]).toBe(`Baseline,Configuration Policy,modified,info,,Do not display the password reveal button,settings[${REVEAL}].settingInstance.choiceSettingValue.value,Disabled,Enabled,id-1`)
    // Formula-like text is kept as text; negative numbers stay numbers.
    expect(lines[2]).toBe("Baseline,Configuration Policy,modified,info,,Description,description,'=cmd,-1,id-1")
    expect(lines[3]).toBe('"Old, removed",Configuration Policy,deleted,info,,,,,,id-2')
    expect(lines).toHaveLength(4)
  })

  it('nests the same settings under their items in JSON', () => {
    const json = JSON.parse(driftJson(result(drifts, NAMES), 'Contoso', '2026-10-08T00:00:00Z'))
    expect(json.counts).toEqual({ added: 0, modified: 1, deleted: 1 })
    expect(json.items[0].settings[0]).toMatchObject({ setting: 'Do not display the password reveal button', before: 'Disabled', after: 'Enabled', beforeRaw: `${REVEAL}_0` })
    expect(json.items[1]).toMatchObject({ name: 'Old, removed', change: 'deleted', settings: [] })
  })
})
