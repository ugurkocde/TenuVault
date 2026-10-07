import { describe, expect, it } from 'vitest'
import { definitionLabel, formatValue, humanize, LONG_VALUE, settingLabel } from '../src/shared/intune/drift-format'

const DEFENDER = 'device_vendor_msft_policy_config_defender_allowcloudprotection'

describe('Drift setting labels', () => {
  it('names Settings Catalog settings after their definition ID', () => {
    expect(settingLabel({ field: `settings[${DEFENDER}].settingInstance.choiceSettingValue.value` })).toEqual({ label: 'Defender: Allow cloud protection', path: `settings[${DEFENDER}].settingInstance.choiceSettingValue.value`, definitionId: DEFENDER })
    expect(settingLabel({ field: `settings[${DEFENDER}]` }).label).toBe('Defender: Allow cloud protection')
    expect(settingLabel({ field: 'settings[com.apple.applicationaccess_allowcamera].settingInstance.choiceSettingValue.value' }).label).toBe('Application access: Allow camera')
    // A child setting inside a group is named after the child.
    const child = `settings[parent_setting].settingInstance.groupSettingCollectionValue[0].children[device_vendor_msft_policy_config_defender_submitsamplesconsent].choiceSettingValue.value`
    expect(settingLabel({ field: child }).label).toBe('Defender: Submit samples consent')
  })

  it('names OMA-URI settings by their display name', () => {
    expect(settingLabel({ field: 'omaSettings[Block USB].value', displayName: 'Block USB' }).label).toBe('Block USB')
    expect(settingLabel({ field: 'omaSettings[Block USB].omaUri' }).label).toBe('Block USB: OMA URI')
  })

  it('humanizes plain property paths', () => {
    expect(settingLabel({ field: 'passwordMinimumLength' }).label).toBe('Password minimum length')
    expect(settingLabel({ field: 'osMinimumVersion' }).label).toBe('OS minimum version')
    expect(settingLabel({ field: 'bitLockerEnabled' }).label).toBe('BitLocker enabled')
    expect(settingLabel({ field: 'rules[1]' }).label).toBe('Rules (item 2)')
    expect(settingLabel({ field: 'roleScopeTagIds["12"]' }).label).toBe('Role scope tag IDs: 12')
    expect(settingLabel({ field: 'assignments[0].target.groupId' })).toEqual({ label: 'Group ID', path: 'assignments[0].target.groupId' })
  })

  it('splits run-together words only when every part is known', () => {
    expect(humanize('allowrealtimemonitoring')).toBe('Allow real time monitoring')
    expect(humanize('xyzzyplughwidget')).toBe('Xyzzyplughwidget')
    expect(definitionLabel('vendor_msft_firewall')).toBe('Firewall')
  })
})

describe('Drift values', () => {
  it('shows scalars as they are and missing values as Not set', () => {
    expect(formatValue(true)).toEqual({ kind: 'text', text: 'true' })
    expect(formatValue(12)).toEqual({ kind: 'text', text: '12' })
    expect(formatValue('Contoso')).toEqual({ kind: 'text', text: 'Contoso' })
    expect(formatValue(null)).toEqual({ kind: 'empty', text: 'Not set' })
    expect(formatValue(undefined)).toEqual({ kind: 'empty', text: 'Not set' })
  })

  it('shortens choice values and keeps the raw value', () => {
    expect(formatValue(`${DEFENDER}_1`, DEFENDER)).toEqual({ kind: 'text', text: '1', raw: `${DEFENDER}_1` })
    expect(formatValue('device_vendor_msft_policy_config_defender_puaprotection_enabled')).toEqual({ kind: 'text', text: 'Enabled', raw: 'device_vendor_msft_policy_config_defender_puaprotection_enabled' })
  })

  it('pretty-prints objects and summarizes whole Settings Catalog settings', () => {
    const setting = { id: '0', settingInstance: { settingDefinitionId: DEFENDER, choiceSettingValue: { value: `${DEFENDER}_0`, children: [] } } }
    const formatted = formatValue(setting)
    expect(formatted).toMatchObject({ kind: 'json', summary: 'Defender: Allow cloud protection = 0' })
    expect(formatted.text).toBe(JSON.stringify(setting, null, 2))
    expect(formatValue([1, 2])).toEqual({ kind: 'json', text: JSON.stringify([1, 2], null, 2) })
  })

  it('leaves long text whole for the page to cut with Show more', () => {
    const long = 'x'.repeat(LONG_VALUE + 10)
    expect(formatValue(long)).toEqual({ kind: 'text', text: long })
  })
})
