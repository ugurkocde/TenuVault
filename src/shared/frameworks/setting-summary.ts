import type { SettingNames } from "../intune/drift"

const MAX_FALLBACK_LENGTH = 200
const MAX_DEPTH = 12
const MAX_LINES = 50
const FURTHER_NESTED_LINE = "Further nested values are in the raw Graph values below."
const VALUE_KEYS = [
  "choiceSettingValue",
  "simpleSettingValue",
  "choiceSettingCollectionValue",
  "simpleSettingCollectionValue",
  "groupSettingCollectionValue",
  "groupSettingValue",
] as const

type RecordValue = { [key: string]: unknown }

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function truncate(text: string): string {
  return text.length > MAX_FALLBACK_LENGTH ? `${text.slice(0, MAX_FALLBACK_LENGTH - 3)}...` : text
}

function fallbackLine(value: unknown): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value))
  } catch {
    return truncate(String(value))
  }
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return truncate(value)
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") return String(value)
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  return fallbackLine(value)
}

function shortLabel(definitionId: string): string {
  for (const prefix of ["device_vendor_msft_policy_config_", "device_vendor_msft_policy_"]) {
    if (definitionId.startsWith(prefix)) {
      const shortened = definitionId.slice(prefix.length)
      return shortened || definitionId
    }
  }
  return definitionId
}

function choiceText(value: unknown, definitionId: string | undefined, names?: SettingNames): string {
  if (typeof value !== "string") return scalarText(value)
  if (names && Object.hasOwn(names.options, value)) return truncate(names.options[value]!)
  if (!definitionId) return truncate(value)
  if (value.toLowerCase() === definitionId.toLowerCase()) return truncate(value)
  const lowerValue = value.toLowerCase()
  const lowerId = definitionId.toLowerCase()
  if (lowerValue.startsWith(`${lowerId}_`) || lowerValue.startsWith(`${lowerId}.`)) return truncate(value.slice(definitionId.length + 1))
  return truncate(value)
}

function capLines(lines: string[]): string[] {
  if (lines.length <= MAX_LINES) return lines
  return [...lines.slice(0, MAX_LINES - 1), FURTHER_NESTED_LINE]
}

function childLines(children: unknown, depth: number, names?: SettingNames): string[] {
  if (!Array.isArray(children)) return []
  if (depth >= MAX_DEPTH) return [FURTHER_NESTED_LINE]
  const lines: string[] = []
  for (const child of children) {
    for (const line of summarizeInternal(child, depth + 1, names)) lines.push(`  ${line}`)
  }
  return capLines(lines)
}

function valueLines(record: RecordValue, definitionId: string | undefined, depth: number, names?: SettingNames): string[] {
  if (depth > MAX_DEPTH) return [FURTHER_NESTED_LINE]
  const lines: string[] = []
  if ("choiceSettingValue" in record) {
    const choice = record.choiceSettingValue
    if (isRecord(choice)) {
      lines.push(`Selected option: ${choiceText(choice.value, definitionId, names)}`)
      lines.push(...childLines(choice.children, depth, names))
    } else {
      lines.push(`Selected option: ${scalarText(choice)}`)
    }
  }
  if ("simpleSettingValue" in record) {
    const simple = record.simpleSettingValue
    if (isRecord(simple) && "value" in simple) lines.push(`Value: ${scalarText(simple.value)}`)
    else lines.push(`Value: ${scalarText(simple)}`)
  }
  if ("choiceSettingCollectionValue" in record) {
    const collection = record.choiceSettingCollectionValue
    if (Array.isArray(collection)) {
      for (const entry of collection) {
        if (isRecord(entry)) {
          lines.push(`Selected option: ${choiceText(entry.value, definitionId, names)}`)
          lines.push(...childLines(entry.children, depth, names))
        } else {
          lines.push(`Selected option: ${scalarText(entry)}`)
        }
      }
    } else {
      lines.push(fallbackLine(collection))
    }
  }
  if ("simpleSettingCollectionValue" in record) {
    const collection = record.simpleSettingCollectionValue
    if (Array.isArray(collection)) {
      for (const entry of collection) {
        if (isRecord(entry) && "value" in entry) lines.push(`Value: ${scalarText(entry.value)}`)
        else lines.push(`Value: ${scalarText(entry)}`)
      }
    } else {
      lines.push(fallbackLine(collection))
    }
  }
  if ("groupSettingCollectionValue" in record) {
    const collection = record.groupSettingCollectionValue
    if (Array.isArray(collection)) {
      for (const group of collection) {
        if (isRecord(group) && Array.isArray(group.children)) {
          for (const child of group.children) lines.push(...summarizeInternal(child, depth + 1, names))
        } else if (isRecord(group)) {
          lines.push(...(depth >= MAX_DEPTH ? [FURTHER_NESTED_LINE] : valueLines(group, definitionId, depth + 1, names)))
        } else {
          lines.push(fallbackLine(group))
        }
      }
    } else {
      lines.push(fallbackLine(collection))
    }
  }
  if ("groupSettingValue" in record) {
    const group = record.groupSettingValue
    if (isRecord(group) && Array.isArray(group.children)) {
      for (const child of group.children) lines.push(...summarizeInternal(child, depth + 1, names))
    } else {
      lines.push(fallbackLine(group))
    }
  }
  return capLines(lines)
}

function hasValueKey(record: RecordValue): boolean {
  return VALUE_KEYS.some((key) => key in record)
}

/**
 * Plain lines for a Settings Catalog setting instance. With `names` read from the setting
 * definitions, settings show their display name and choices their option label; without them
 * choice values are shown as their option token only, without claiming an enabled or disabled state.
 */
function summarizeInternal(value: unknown, depth: number, names?: SettingNames): string[] {
  if (depth > MAX_DEPTH) return [FURTHER_NESTED_LINE]
  if (!isRecord(value)) return [fallbackLine(value)]
  const definitionId = typeof value.settingDefinitionId === "string" && value.settingDefinitionId ? value.settingDefinitionId : undefined
  if (definitionId && hasValueKey(value)) {
    const inner = valueLines(value, definitionId, depth, names)
    if (!inner.length) return [fallbackLine(value)]
    const label = names && Object.hasOwn(names.settings, definitionId) ? names.settings[definitionId]! : shortLabel(definitionId)
    return capLines([`${label}: ${inner[0]}`, ...inner.slice(1).map((line) => (line.startsWith("  ") ? line : `  ${line}`))])
  }
  if (hasValueKey(value)) {
    const inner = valueLines(value, definitionId, depth, names)
    return inner.length ? capLines(inner) : [fallbackLine(value)]
  }
  return [fallbackLine(value)]
}

export function summarizeSetting(value: unknown, names?: SettingNames): string[] {
  try {
    return capLines(summarizeInternal(value, 0, names))
  } catch {
    return [FURTHER_NESTED_LINE]
  }
}

/** One configured value of a Settings Catalog setting: its definition and its choice or simple value as text. */
export interface SettingLeaf { definitionId: string; value: string }

/** Values kept per added or removed setting or policy; generous, so the full list shows in practice. */
export const MAX_SETTING_LEAVES = 500
/** A choice keeps its whole option id up to this length, so its label can still be looked up. */
const MAX_OPTION_ID = 1000

/**
 * The configured values inside any Settings Catalog content (a setting instance, a setting, a
 * keyed settings map or a whole policy body), in document order, each with the definition it
 * belongs to, and how many values there are in total. At most `limit` values are kept; `total`
 * counts all of them, so a view can say when a list is cut. Choice values keep their whole option
 * id (up to MAX_OPTION_ID characters) so a view can show its label; simple values are cut to
 * `maxLength` characters.
 */
export function settingValues(value: unknown, limit = MAX_SETTING_LEAVES, maxLength = 160): { leaves: SettingLeaf[]; total: number } {
  const leaves: SettingLeaf[] = []
  let total = 0
  const cut = (shown: string, length: number) => shown.length > length ? `${shown.slice(0, length)}...` : shown
  const text = (item: unknown) => cut(typeof item === "string" ? item : JSON.stringify(item) ?? String(item), maxLength)
  const option = (item: unknown) => typeof item === "string" ? cut(item, MAX_OPTION_ID) : text(item)
  const add = (definitionId: string, shown: string) => { total += 1; if (leaves.length < limit) leaves.push({ definitionId, value: shown }) }
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH * 2) return
    if (Array.isArray(node)) { for (const entry of node) walk(entry, depth + 1); return }
    if (!isRecord(node)) return
    const id = typeof node.settingDefinitionId === "string" ? node.settingDefinitionId : null
    if (id) {
      const choice = node.choiceSettingValue
      if (isRecord(choice) && choice.value !== undefined && choice.value !== null) add(id, option(choice.value))
      const simple = node.simpleSettingValue
      if (isRecord(simple) && simple.value !== undefined && simple.value !== null) add(id, text(simple.value))
      const choices = node.choiceSettingCollectionValue
      if (Array.isArray(choices)) for (const entry of choices) if (isRecord(entry) && entry.value !== undefined && entry.value !== null) add(id, option(entry.value))
      const simples = node.simpleSettingCollectionValue
      if (Array.isArray(simples)) for (const entry of simples) if (isRecord(entry) && entry.value !== undefined && entry.value !== null) add(id, text(entry.value))
    }
    for (const [key, child] of Object.entries(node)) if (key !== "value") walk(child, depth + 1)
  }
  walk(value, 0)
  return { leaves, total }
}
