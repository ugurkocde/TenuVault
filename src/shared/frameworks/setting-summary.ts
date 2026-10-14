const MAX_FALLBACK_LENGTH = 200
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
  if (typeof value === "string") return value
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

function choiceText(value: unknown, definitionId: string | undefined): string {
  if (typeof value !== "string") return scalarText(value)
  if (!definitionId) return value
  if (value.toLowerCase() === definitionId.toLowerCase()) return value
  const lowerValue = value.toLowerCase()
  const lowerId = definitionId.toLowerCase()
  if (lowerValue.startsWith(`${lowerId}_`) || lowerValue.startsWith(`${lowerId}.`)) return value.slice(definitionId.length + 1)
  if (lowerValue.startsWith(lowerId)) {
    const remainder = value.slice(definitionId.length)
    return remainder || value
  }
  return value
}

function childLines(children: unknown): string[] {
  if (!Array.isArray(children)) return []
  const lines: string[] = []
  for (const child of children) {
    for (const line of summarizeSetting(child)) lines.push(`  ${line}`)
  }
  return lines
}

function valueLines(record: RecordValue, definitionId: string | undefined): string[] {
  const lines: string[] = []
  if ("choiceSettingValue" in record) {
    const choice = record.choiceSettingValue
    if (isRecord(choice)) {
      lines.push(`Selected option: ${choiceText(choice.value, definitionId)}`)
      lines.push(...childLines(choice.children))
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
          lines.push(`Selected option: ${choiceText(entry.value, definitionId)}`)
          lines.push(...childLines(entry.children))
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
          for (const child of group.children) lines.push(...summarizeSetting(child))
        } else if (isRecord(group)) {
          lines.push(...valueLines(group, definitionId))
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
      for (const child of group.children) lines.push(...summarizeSetting(child))
    } else {
      lines.push(fallbackLine(group))
    }
  }
  return lines
}

function hasValueKey(record: RecordValue): boolean {
  return VALUE_KEYS.some((key) => key in record)
}

/**
 * Plain lines for a Settings Catalog setting instance. Choice values are shown
 * as their option token only, without claiming an enabled or disabled state.
 */
export function summarizeSetting(value: unknown): string[] {
  if (!isRecord(value)) return [fallbackLine(value)]
  const definitionId = typeof value.settingDefinitionId === "string" && value.settingDefinitionId ? value.settingDefinitionId : undefined
  if (definitionId && hasValueKey(value)) {
    const inner = valueLines(value, definitionId)
    if (!inner.length) return [fallbackLine(value)]
    const label = shortLabel(definitionId)
    return [`${label}: ${inner[0]}`, ...inner.slice(1).map((line) => (line.startsWith("  ") ? line : `  ${line}`))]
  }
  if (hasValueKey(value)) {
    const inner = valueLines(value, definitionId)
    return inner.length ? inner : [fallbackLine(value)]
  }
  return [fallbackLine(value)]
}
