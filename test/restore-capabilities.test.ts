import { describe, expect, it } from 'vitest'
import { typeForFolder } from '../src/shared/intune/registry'
import { buildRestorePlan, buildUpdatePlan, passwordResetWarning, restoreCapabilities } from '../src/shared/intune/restore-plan'

describe('default object restore capabilities', () => {
  it.each([
    ['EnrollmentConfigurations', { id: 'default', displayName: 'Default', priority: 0, '@odata.type': '#microsoft.graph.deviceEnrollmentLimitConfiguration', limit: 5 }],
    ['Branding', { id: 'default', displayName: 'Default', isDefaultProfile: true }],
  ] as const)('allows replacing %s but rejects creation', (folder, snapshot) => {
    const type = typeForFolder(folder)!
    expect(restoreCapabilities(type, snapshot)).toEqual({ blocker: expect.stringContaining('default'), replaceBlocker: undefined })
    expect(() => buildRestorePlan(type, snapshot)).toThrow()
    expect(buildUpdatePlan(type, snapshot, snapshot.id)[0]).toMatchObject({ method: 'PATCH', path: `${type.path}/default` })
    expect(restoreCapabilities(type, { ...snapshot, id: '' }).replaceBlocker).toContain('original object ID')
  })
})

it('checks administrative-template replacement with snapshot data and then the actual current object', () => {
  const type = typeForFolder('GroupPolicyConfigurations')!
  const snapshot = { id: 'template', displayName: 'Template', definitionValues: [] }
  expect(restoreCapabilities(type, snapshot).replaceBlocker).toBeUndefined()
  expect(restoreCapabilities(type, snapshot, { definitionValues: [] }).replaceBlocker).toBeUndefined()
  expect(restoreCapabilities(type, snapshot, {}).replaceBlocker).toContain('could not be read')
})

describe('password reset warning', () => {
  const choice = (value: string) => ({ settingInstance: { choiceSettingValue: { value, children: [] } } })

  it.each([
    ['#microsoft.graph.macOSCompliancePolicy', 'Macs'],
    ['#microsoft.graph.macOSGeneralDeviceConfiguration', 'Macs'],
    ['#microsoft.graph.windows10CompliancePolicy', 'Windows'],
    ['#microsoft.graph.windows10GeneralConfiguration', 'Windows'],
  ])('warns for %s only when a password is required', (type, platform) => {
    expect(passwordResetWarning({ '@odata.type': type, passwordRequired: true })).toContain(platform)
    expect(passwordResetWarning({ '@odata.type': type, passwordRequired: false, passwordMinimumLength: 8 })).toBeUndefined()
  })

  it('warns for settings catalog choices that force a password change', () => {
    const nested = { settingInstance: { groupSettingCollectionValue: [{ children: [{ choiceSettingValue: { value: 'com.apple.mobiledevice.passwordpolicy_changeatnextauth_true' } }] }] } }
    expect(passwordResetWarning({ name: 'Passcode', settings: [nested] })).toContain('Macs')
    expect(passwordResetWarning({ name: 'Device lock', settings: [choice('device_vendor_msft_policy_config_devicelock_devicepasswordenabled_0')] })).toContain('Windows')
  })

  it('ignores safe settings catalog choices and unrelated items', () => {
    expect(passwordResetWarning({ settings: [choice('com.apple.mobiledevice.passwordpolicy_changeatnextauth_false')] })).toBeUndefined()
    expect(passwordResetWarning({ settings: [choice('device_vendor_msft_policy_config_devicelock_devicepasswordenabled_1')] })).toBeUndefined()
    expect(passwordResetWarning({ '@odata.type': '#microsoft.graph.iosCompliancePolicy', passcodeRequired: true })).toBeUndefined()
    expect(passwordResetWarning({ displayName: 'com.apple.mobiledevice.passwordpolicy_changeatnextauth_true' })).toBeUndefined()
    expect(passwordResetWarning(undefined)).toBeUndefined()
  })
})
