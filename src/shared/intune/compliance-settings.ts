import type { Item, Json, ReviewChange, Step } from "./registry"

/**
 * Intune's tenant-wide compliance policy settings (Endpoint security > Device compliance > Compliance policy
 * settings). They are part of the deviceManagementSettings singleton (GET deviceManagement/settings), which also
 * holds unrelated tenant features such as log collection, Autopilot diagnostics and Android device administrator
 * enrollment. Only the properties below are backed up, compared and restored.
 *
 * Restore writes them with PATCH deviceManagement and a `settings` object holding only the properties that differ
 * from the live tenant, as Microsoft's Update deviceManagement API documents. OData PATCH leaves properties the
 * body does not name unchanged, inside complex properties too, so the other tenant settings are left alone.
 */

export const COMPLIANCE_SETTINGS_ID = "CompliancePolicySettings"

/** Intune's documented default when the validity period was never set (Graph returns 0 then). */
const DEFAULT_VALIDITY_DAYS = 30

interface ComplianceSetting {
  key: string
  /** The setting's name in the Intune admin center. */
  label: string
  format: (value: Json | undefined) => string
  /** Whether Intune accepts the value; an invalid backed-up value is never written. */
  valid: (value: Json | undefined) => boolean
  /** What changing the live value to the backed-up one does to users and devices. */
  warning?: (from: Json | undefined, to: Json) => string | undefined
}

const enabled = (value: Json | undefined) => (value === true ? "Enabled" : value === false ? "Disabled" : "Not set")
const boolean = (value: Json | undefined) => typeof value === "boolean"

export const COMPLIANCE_SETTINGS: ComplianceSetting[] = [
  {
    key: "secureByDefault",
    label: "Mark devices with no compliance policy assigned as",
    format: (value) => (value === true ? "Not compliant" : value === false ? "Compliant" : "Not set"),
    valid: boolean,
    warning: (_from, to) =>
      to === true
        ? "Devices without an assigned compliance policy become noncompliant. Conditional Access policies that require a compliant device then block their users."
        : "Devices without an assigned compliance policy count as compliant without any check, so Conditional Access policies that require a compliant device let them in.",
  },
  {
    key: "deviceComplianceCheckinThresholdDays",
    label: "Compliance status validity period (days)",
    format: (value) => (typeof value === "number" && value > 0 ? String(value) : `Not set (Intune uses ${DEFAULT_VALIDITY_DAYS})`),
    // Intune accepts 1 to 120 days.
    valid: (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 120,
    warning: (from, to) => {
      const before = typeof from === "number" && from > 0 ? from : DEFAULT_VALIDITY_DAYS
      return typeof to === "number" && to < before ? `Devices that have not reported their compliance status in the last ${to} days become noncompliant.` : undefined
    },
  },
  {
    key: "isScheduledActionEnabled",
    label: "Scheduled actions for noncompliance",
    format: enabled,
    valid: boolean,
  },
  {
    key: "enhancedJailBreak",
    label: "Enhanced jailbreak detection",
    format: enabled,
    valid: boolean,
  },
]

export const COMPLIANCE_SETTING_KEYS = COMPLIANCE_SETTINGS.map((setting) => setting.key)

/** The admin center name of a compliance policy setting, by its Graph property name. */
export function complianceSettingLabel(key: string): string | undefined {
  return COMPLIANCE_SETTINGS.find((setting) => setting.key === key)?.label
}

/** A compliance policy setting's value as the admin center shows it, such as "Not compliant" for secureByDefault true. */
export function complianceSettingValue(key: string, value: Json | undefined): string | undefined {
  return COMPLIANCE_SETTINGS.find((setting) => setting.key === key)?.format(value)
}

export interface ComplianceSettingChange extends ReviewChange {
  key: string
}

/** Every compliance policy setting whose backed-up value differs from the live one, and what restoring it does. */
export function complianceSettingChanges(snapshot: Item, current: Item): ComplianceSettingChange[] {
  const changes: ComplianceSettingChange[] = []
  for (const setting of COMPLIANCE_SETTINGS) {
    const wanted = snapshot[setting.key]
    const live = current[setting.key]
    if (JSON.stringify(wanted ?? null) === JSON.stringify(live ?? null)) continue
    const restored = setting.valid(wanted)
    changes.push({
      key: setting.key,
      label: setting.label,
      from: setting.format(live),
      to: setting.format(wanted),
      restored,
      ...(restored && setting.warning?.(live, wanted!) ? { warning: setting.warning(live, wanted!) } : {}),
    })
  }
  return changes
}

/** The PATCH that puts the backed-up compliance policy settings back, or nothing when no restorable value differs. */
export function complianceSettingsUpdate(snapshot: Item, current: Item): Step[] {
  const settings: Item = {}
  for (const change of complianceSettingChanges(snapshot, current)) if (change.restored) settings[change.key] = snapshot[change.key] ?? null
  return Object.keys(settings).length ? [{ method: "PATCH", path: "deviceManagement", body: { settings }, kind: "content" }] : []
}
