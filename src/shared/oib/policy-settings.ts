import { settingValueLines } from "../frameworks/setting-summary"
import type { SettingNames } from "../intune/drift"
import { definitionLabel, MAX_DEFINITIONS } from "../intune/drift-format"
import type { Item, Json } from "../intune/registry"
import { adminTemplateIndex, canonical, flatIndex, VALIDATED_FOLDERS, type SettingIndex } from "./compare"

/**
 * The settings of one OIB policy in plain words, to read before deploying it, and what updating a
 * tenant policy in place to a newer OIB version would change. Both work on the policy JSON alone;
 * setting names read from Graph (SettingNames) make Settings Catalog settings read as in Intune.
 */

/** Rows returned per policy and per change list; OIB policies hold far fewer in practice. */
export const MAX_SETTING_ROWS = 500
const MAX_TEXT = 500

export interface OibSettingRow {
  /** Setting definition ID, property name or ADMX definition ID. */
  id: string
  label: string
  /** The value first; child settings follow, indented with two spaces per level. */
  lines: string[]
}

export interface OibPolicySettings {
  source: string
  name: string
  folder: string
  settings: OibSettingRow[]
  /** All settings of the policy; more than `settings.length` when the list was cut. */
  total: number
  /** Setting names could not be read from Graph, so names are derived from the setting IDs. */
  namesMissing?: boolean
}

export interface OibSettingChange {
  id: string
  label: string
  /** The tenant policy's value now. */
  before: string[]
  /** The value in the selected OIB version. */
  after: string[]
}

export interface OibPolicyChanges {
  source: string
  name: string
  folder: string
  tenantPolicyId: string
  tenantPolicyName: string
  /** False for policy types that are not compared setting by setting; the lists are empty then. */
  supported: boolean
  changed: OibSettingChange[]
  /** Settings the OIB version has and the tenant policy does not. */
  added: OibSettingRow[]
  /** Settings the tenant policy has and the OIB version does not. */
  removed: OibSettingRow[]
  /** Settings with the same value on both sides. */
  unchanged: number
  /** Full counts; the lists above hold at most MAX_SETTING_ROWS each. */
  counts: { changed: number; added: number; removed: number }
  namesMissing?: boolean
}

interface Entry extends OibSettingRow {
  /** Canonical JSON of the value, so equal configuration compares equal. */
  key: string
}

const isObject = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value)
const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text)

/** A top-level property value as one line: scalars as they are, lists of scalars joined, anything else as compact JSON. */
function valueText(value: Json | undefined): string {
  if (value === undefined || value === null) return "Not set"
  if (typeof value === "string") return cut(value) || "Not set"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value) && value.every((entry) => entry === null || typeof entry !== "object")) return cut(value.map(String).join(", "))
  return cut(JSON.stringify(value))
}

/** "Selected option: Enabled" as "Enabled" and "  Child: Value: 5" as "  Child: 5": the view already says what each line is. */
const plain = (line: string) => line.replace(/^(\s*)(?:Selected option|Value): /, "$1").replace(/: (?:Selected option|Value): /, ": ")

function catalogEntries(policy: Item, names?: SettingNames): Entry[] {
  const entries: Entry[] = []
  for (const setting of Array.isArray(policy.settings) ? policy.settings : []) {
    const instance = isObject(setting) ? setting.settingInstance : undefined
    const id = isObject(instance) && typeof instance.settingDefinitionId === "string" ? instance.settingDefinitionId : undefined
    if (!id) continue
    entries.push({ id, label: definitionLabel(id, names), lines: settingValueLines(instance, names).map(plain), key: JSON.stringify(canonical(instance as Json) ?? null) })
  }
  return entries
}

function adminEntries(index: SettingIndex): Entry[] {
  return [...index].map(([id, { label, value }]) => {
    const state = isObject(value) && value.enabled === true ? "Enabled" : "Disabled"
    const presentations = isObject(value) && Array.isArray(value.presentations) ? value.presentations.filter(isObject) : []
    const values = presentations.flatMap((entry) => (entry.value ?? entry.values) == null ? [] : [`  Value: ${valueText((entry.value ?? entry.values) as Json)}`])
    return { id, label, lines: [state, ...values], key: JSON.stringify(value ?? null) }
  })
}

function flatEntries(index: SettingIndex): Entry[] {
  return [...index].map(([id, { label, value }]) => ({ id, label, lines: [valueText(value)], key: JSON.stringify(value ?? null) }))
}

/** Every setting of a policy of the given registry folder, in the order the policy lists them. */
function entriesOf(folder: string, policy: Item, names?: SettingNames): Entry[] {
  if (folder === "ConfigurationPolicies") return catalogEntries(policy, names)
  if (folder === "GroupPolicyConfigurations") return adminEntries(adminTemplateIndex(policy))
  // Compliance, device configuration, update rings, driver updates and app protection keep their settings as properties.
  return flatEntries(flatIndex(policy))
}

const row = ({ id, label, lines }: Entry): OibSettingRow => ({ id, label, lines })

/** The settings of an OIB policy, at most MAX_SETTING_ROWS of them. */
export function describePolicy(item: { source: string; name: string; folder: string; snapshot: Item }, names?: SettingNames): OibPolicySettings {
  const entries = entriesOf(item.folder, item.snapshot, names)
  return { source: item.source, name: item.name, folder: item.folder, settings: entries.slice(0, MAX_SETTING_ROWS).map(row), total: entries.length }
}

/**
 * What replacing the tenant policy's settings with the OIB version changes, setting by setting.
 * Only the policy types Policy Validation compares are supported.
 */
export function policyChanges(item: { source: string; name: string; folder: string; snapshot: Item }, tenant: { id: string; name: string; policy: Item }, names?: SettingNames): OibPolicyChanges {
  const base = { source: item.source, name: item.name, folder: item.folder, tenantPolicyId: tenant.id, tenantPolicyName: tenant.name }
  if (!VALIDATED_FOLDERS.includes(item.folder)) {
    return { ...base, supported: false, changed: [], added: [], removed: [], unchanged: 0, counts: { changed: 0, added: 0, removed: 0 } }
  }
  const next = entriesOf(item.folder, item.snapshot, names)
  const current = new Map(entriesOf(item.folder, tenant.policy, names).map((entry) => [entry.id, entry]))
  const changed: OibSettingChange[] = []
  const added: Entry[] = []
  let unchanged = 0
  for (const entry of next) {
    const now = current.get(entry.id)
    if (!now) added.push(entry)
    else if (now.key === entry.key) unchanged++
    else changed.push({ id: entry.id, label: entry.label, before: now.lines, after: entry.lines })
  }
  const wanted = new Set(next.map((entry) => entry.id))
  const removed = [...current.values()].filter((entry) => !wanted.has(entry.id))
  return {
    ...base, supported: true, unchanged,
    changed: changed.slice(0, MAX_SETTING_ROWS), added: added.slice(0, MAX_SETTING_ROWS).map(row), removed: removed.slice(0, MAX_SETTING_ROWS).map(row),
    counts: { changed: changed.length, added: added.length, removed: removed.length },
  }
}

/** The Settings Catalog setting definition IDs in policies, children included, to read their names. */
export function definitionIdsOf(...policies: Item[]): string[] {
  const ids = new Set<string>()
  const walk = (value: unknown, depth: number): void => {
    if (ids.size >= MAX_DEFINITIONS || depth > 30 || !value || typeof value !== "object") return
    if (Array.isArray(value)) return value.forEach((entry) => walk(entry, depth + 1))
    const id = (value as { settingDefinitionId?: unknown }).settingDefinitionId
    if (typeof id === "string" && id) ids.add(id)
    for (const entry of Object.values(value)) walk(entry, depth + 1)
  }
  for (const policy of policies) walk(policy.settings, 0)
  return [...ids].slice(0, MAX_DEFINITIONS)
}
