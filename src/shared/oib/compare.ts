import { COMMON_READ_ONLY, type Item, type Json } from "../intune/registry"
import type { SettingDiff, ValidationResult } from "./types"

const MAX_DIFFS = 500
const MAX_VALUE = 500

/** Metadata that never describes configuration. */
const METADATA = new Set([
  ...COMMON_READ_ONLY,
  "settingInstanceTemplateReference", "settingValueTemplateReference", "roleScopeTagIds", "templateReference",
])
/** Properties of flat policies (compliance, device configuration, update profiles) that are not settings. */
const FLAT_IGNORED = new Set([
  ...METADATA, "displayName", "description", "name", "scheduledActionsForRule", "deviceStatusOverview", "userStatusOverview",
  "deviceSettingStateSummaries", "deviceStatuses", "userStatuses", "deviceCompliancePolicyScript", "newUpdates",
  "deviceReporting", "inventorySyncStatus", "driverInventories", "platforms", "technologies",
])

const annotation = (key: string) => key.includes("@odata.") || key.startsWith("#")
const isObject = (value: Json | undefined): value is { [key: string]: Json } => !!value && typeof value === "object" && !Array.isArray(value)
const definitionOf = (value: Json | undefined) => (isObject(value) && typeof value.settingDefinitionId === "string" ? value.settingDefinitionId : undefined)
const sortKey = (value: Json) => definitionOf(value) ?? JSON.stringify(value)

/** Configuration without metadata, empty values or ordering, so equal configuration is equal JSON. */
export function canonical(value: Json | undefined, ignored: Set<string> = METADATA): Json | undefined {
  if (Array.isArray(value)) {
    const list = value.map((entry) => canonical(entry, ignored)).filter((entry): entry is Json => entry !== undefined)
    return list.length ? list.sort((a, b) => sortKey(a).localeCompare(sortKey(b))) : undefined
  }
  if (isObject(value)) {
    const result: { [key: string]: Json } = {}
    for (const key of Object.keys(value).sort()) {
      if (ignored.has(key) || annotation(key)) continue
      const child = canonical(value[key], ignored)
      if (child !== undefined) result[key] = child
    }
    return Object.keys(result).length ? result : undefined
  }
  return value === null ? undefined : value
}

const show = (value: Json | undefined) => {
  if (value === undefined) return "(not set)"
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text
}

/** A readable name for a Settings Catalog definition ID, from its last segments. */
export function settingLabel(id: string): string {
  const parts = id.split("_").filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(" › ") : id
}

/** Leaf differences between two canonical values; child settings are paired by definition ID. */
function differences(oib: Json | undefined, tenant: Json | undefined, path: string, out: Array<{ path: string; oibValue: string; tenantValue: string }>): void {
  if (JSON.stringify(oib) === JSON.stringify(tenant) || out.length >= 50) return
  if (isObject(oib) && isObject(tenant)) {
    for (const key of new Set([...Object.keys(oib), ...Object.keys(tenant)])) differences(oib[key], tenant[key], path ? `${path}.${key}` : key, out)
    return
  }
  if (Array.isArray(oib) && Array.isArray(tenant)) {
    if ([...oib, ...tenant].every((entry) => definitionOf(entry))) {
      const left = new Map(oib.map((entry) => [definitionOf(entry)!, entry]))
      const right = new Map(tenant.map((entry) => [definitionOf(entry)!, entry]))
      for (const id of new Set([...left.keys(), ...right.keys()])) differences(left.get(id), right.get(id), `${path} › ${settingLabel(id)}`, out)
      return
    }
    if (oib.length === tenant.length) {
      oib.forEach((entry, index) => differences(entry, tenant[index], `${path}[${index}]`, out))
      return
    }
  }
  out.push({ path, oibValue: show(oib), tenantValue: show(tenant) })
}

/** A policy's settings keyed by setting (definition ID, property or ADMX definition), with canonical values. */
export type SettingIndex = Map<string, { label: string; value: Json | undefined }>

/** Compares two keyed sets of canonical settings. */
function compareMaps(oib: SettingIndex, tenant: SettingIndex): ValidationResult {
  const mismatches: SettingDiff[] = []
  const oibOnly: SettingDiff[] = []
  const tenantOnly: SettingDiff[] = []
  let matched = 0
  let different = 0
  let missing = 0
  let extra = 0
  for (const [id, wanted] of oib) {
    const live = tenant.get(id)
    if (!live) {
      missing++
      if (oibOnly.length < MAX_DIFFS) oibOnly.push({ settingDefinitionId: id, label: wanted.label, oibValue: show(wanted.value) })
      continue
    }
    const found: Array<{ path: string; oibValue: string; tenantValue: string }> = []
    differences(wanted.value, live.value, "", found)
    if (!found.length) matched++
    else {
      different++
      for (const difference of found) if (mismatches.length < MAX_DIFFS) mismatches.push({ settingDefinitionId: id, label: wanted.label, ...difference, path: difference.path || undefined })
    }
  }
  for (const [id, live] of tenant) if (!oib.has(id)) {
    extra++
    if (tenantOnly.length < MAX_DIFFS) tenantOnly.push({ settingDefinitionId: id, label: live.label, tenantValue: show(live.value) })
  }
  return {
    totalOib: oib.size, totalTenant: tenant.size, matched, different, missing, extra, mismatches, oibOnly, tenantOnly,
    compliant: !mismatches.length && !oibOnly.length && !tenantOnly.length,
  }
}

const list = (value: Json | undefined): Item[] => (Array.isArray(value) ? value.filter(isObject) : [])

/** Settings Catalog (and Endpoint security) settings, keyed by root setting definition. */
export function catalogIndex(settings: Json | undefined): SettingIndex {
  const map: SettingIndex = new Map()
  for (const setting of list(settings)) {
    const instance = setting.settingInstance
    const id = definitionOf(instance)
    if (id) map.set(id, { label: settingLabel(id), value: canonical(instance) })
  }
  return map
}

export function compareSettings(oib: Json | undefined, tenant: Json | undefined): ValidationResult {
  return compareMaps(catalogIndex(oib), catalogIndex(tenant))
}

/** Settings of policies whose settings are top-level properties: compliance, device configuration, update profiles, app protection. */
export function flatIndex(policy: Item): SettingIndex {
  const map: SettingIndex = new Map()
  for (const key of Object.keys(policy)) {
    if (FLAT_IGNORED.has(key) || annotation(key)) continue
    const value = canonical(policy[key], FLAT_IGNORED)
    if (value !== undefined) map.set(key, { label: key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()), value })
  }
  return map
}

export function compareFlat(oib: Item, tenant: Item): ValidationResult {
  return compareMaps(flatIndex(oib), flatIndex(tenant))
}

const lastGuid = (value: unknown) => (typeof value === "string" ? /([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})'?\)?$/i.exec(value)?.[1]?.toLowerCase() : undefined)

/** Administrative templates, keyed by ADMX definition: enabled state and presentation values. */
export function adminTemplateIndex(policy: Item): SettingIndex {
  const map: SettingIndex = new Map()
  for (const value of list(policy.definitionValues)) {
    const definition = isObject(value.definition) ? value.definition : undefined
    const id = (typeof definition?.id === "string" ? definition.id.toLowerCase() : undefined) ?? lastGuid(value["definition@odata.bind"])
    if (!id) continue
    const presentations = list(value.presentationValues).map((presentation) => ({
      presentation: (isObject(presentation.presentation) && typeof presentation.presentation.id === "string" ? presentation.presentation.id.toLowerCase() : lastGuid(presentation["presentation@odata.bind"])) ?? null,
      value: presentation.value ?? null,
      values: presentation.values ?? null,
    }))
    map.set(id, { label: typeof definition?.displayName === "string" ? definition.displayName : id, value: canonical({ enabled: value.enabled ?? false, presentations } as Json) })
  }
  return map
}

export function compareAdminTemplate(oib: Item, tenant: Item): ValidationResult {
  return compareMaps(adminTemplateIndex(oib), adminTemplateIndex(tenant))
}

/** Folders whose policies can be validated setting by setting. */
export const VALIDATED_FOLDERS = ["ConfigurationPolicies", "CompliancePolicies", "DeviceConfigurations", "DriverUpdateProfiles", "GroupPolicyConfigurations"]

/** Compares an OIB policy with the live tenant policy, or undefined for a type that is not validated. */
export function validatePolicy(folder: string, oib: Item, tenant: Item): ValidationResult | undefined {
  switch (folder) {
    case "ConfigurationPolicies":
      return compareSettings(oib.settings, tenant.settings)
    case "CompliancePolicies":
    case "DeviceConfigurations":
    case "DriverUpdateProfiles":
      return compareFlat(oib, tenant)
    case "GroupPolicyConfigurations":
      return compareAdminTemplate(oib, tenant)
    default:
      return undefined
  }
}
