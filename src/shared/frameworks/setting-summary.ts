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
