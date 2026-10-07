import type { DriftChange } from "./drift"

/**
 * Readable names and values for drift changes. compareObjects reports raw property paths such as
 * settings[device_vendor_msft_policy_config_defender_allowcloudprotection].settingInstance.choiceSettingValue.value;
 * the drift page shows them as "Defender: Allow cloud protection" with the path as secondary text.
 */

export interface SettingLabel {
  /** What the admin reads, such as "Password minimum length". */
  label: string
  /** The raw path compareObjects reported. */
  path: string
  /** The Settings Catalog setting the change belongs to, used to shorten its choice values. */
  definitionId?: string
}

const ACRONYMS: Record<string, string> = {
  os: "OS", id: "ID", ids: "IDs", url: "URL", urls: "URLs", uri: "URI", vpn: "VPN", pin: "PIN", ip: "IP", dns: "DNS", mdm: "MDM", oma: "OMA",
  tpm: "TPM", usb: "USB", smb: "SMB", tls: "TLS", ssl: "SSL", sso: "SSO", uac: "UAC", wifi: "Wi-Fi", ios: "iOS", macos: "macOS", pua: "PUA",
  asr: "ASR", lsa: "LSA", ui: "UI", api: "API", ssid: "SSID", eap: "EAP", ntlm: "NTLM", rdp: "RDP", bitlocker: "BitLocker", onedrive: "OneDrive",
}

/**
 * Words Settings Catalog definition IDs run together, such as allowcloudprotection. Used only to
 * split those IDs, and only when every part is a known word; anything else is kept as it is.
 */
const WORDS = new Set(`
access account accounts action actions active add additional address admin administrator advanced age alert alerts all allow allowed always
and android antivirus app apple application applications apps archive attack audit authentication auto automatic available background
backup banner battery behavior biometric block blocked bluetooth boot browser browsing cache camera certificate change check child
classic clear client cloud code collection command compliance computer config configuration configure connect connection consent
control controlled copy credential credentials critical custom data date day days default defender delete delivery deny detection
device devices diagnostic disable disabled disk display domain download drive drives edge email emails enable enabled encrypt encryption
endpoint enforce enhanced enrollment exclusion exclusions execution experience explorer extension extensions failed feature features
file files filter firewall folder folders for from full game guard guest hello history home host hours identity idle inactive
inbound install installation interval key keyboard kiosk language length level limit list local location lock logon low maximum
microsoft minimum minutes mode monitor monitoring network new notification notifications number of office on outbound password
passwords path personal phone policy power prevent preview print printer privacy private profile prompt protection proxy public
quick real recovery reduction remote removable remove report reporting require required requirement restart restrict restricted
retention rule rules run safe sample samples save scan scans schedule scheduled screen script scripts search secure security sending
sensitive service services session setting settings share sharing shell sign signature size smart software source standard start
startup state storage store submit surface sync system tamper telemetry time timeout to type update updates upload usage user users
value version web window windows wipe with work workplace
`.trim().split(/\s+/))

const known = (word: string) => WORDS.has(word) || ACRONYMS[word] !== undefined

/** "allowcloudprotection" as "allow cloud protection", in the fewest known words; unchanged when no such split exists. */
function splitWords(text: string): string {
  if (text.length > 80) return text
  // best[i]: the fewest known words that make up the first i letters.
  const best: Array<string[] | undefined> = [[]]
  for (let i = 1; i <= text.length; i++) {
    for (let j = Math.max(0, i - 20); j < i; j++) {
      const previous = best[j]
      const piece = text.slice(j, i)
      if (previous && known(piece) && (!best[i] || previous.length + 1 < best[i]!.length)) best[i] = [...previous, piece]
    }
  }
  return best[text.length]?.join(" ") ?? text
}

/** "passwordMinimumLength" as "Password minimum length"; known acronyms keep their case. */
export function humanize(name: string): string {
  const words = name
    .replace(/^@odata\./, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    // camelCase splits names such as bitLocker; known names are joined again.
    .reduce<string[]>((words, word) => {
      const joined = `${words[words.length - 1] ?? ""}${word}`.toLowerCase()
      if (words.length && ACRONYMS[joined]) words[words.length - 1] = ACRONYMS[joined]!
      else words.push(word)
      return words
    }, [])
    .flatMap((word) => (word === word.toLowerCase() && word.length > 8 && !ACRONYMS[word] ? splitWords(word).split(" ") : [word]))
  const text = words
    .map((word, index) => {
      const acronym = ACRONYMS[word.toLowerCase()]
      if (acronym) return acronym
      if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word
      const lower = word.toLowerCase()
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(" ")
  return text || name
}

const VENDOR_PREFIX = /^(?:device|user)_vendor_msft_(?:policy_(?:config|result)_)?|^vendor_msft_|^com\.apple\./i

/**
 * A Settings Catalog definition ID as "Area: Setting", from its last two parts:
 * device_vendor_msft_policy_config_defender_allowcloudprotection -> "Defender: Allow cloud protection".
 */
export function definitionLabel(definitionId: string): string {
  const parts = definitionId.replace(VENDOR_PREFIX, "").split(/[_.]/).filter(Boolean)
  if (parts.length === 0) return definitionId
  const setting = humanize(parts[parts.length - 1]!)
  return parts.length === 1 ? setting : `${humanize(parts[parts.length - 2]!)}: ${setting}`
}

/** Properties of a Settings Catalog setting that only carry its value. */
const VALUE_PATH = /^(?:\.settingInstance)?(?:\.(?:choiceSettingValue|simpleSettingValue|groupSettingCollectionValue|simpleSettingCollectionValue|choiceSettingCollectionValue))?(?:\.value)?$/

/** A plain path's last segment, such as rules[1] -> "Rules (item 2)". */
function segmentLabel(segment: string): string {
  const match = /^([^[]*)(?:\[(.+)\])?$/.exec(segment)
  const name = match?.[1] ?? segment
  const key = match?.[2]
  const base = name ? humanize(name) : "Item"
  if (key === undefined) return base
  if (/^\d+$/.test(key)) return `${base} (item ${Number(key) + 1})`
  return `${base}: ${key.replace(/^"(.*)"$/, "$1")}`
}

export function settingLabel(change: Pick<DriftChange, "field" | "displayName">): SettingLabel {
  const path = change.field
  if (!path) return { label: "Whole item", path }

  // OMA-URI settings are keyed by their display name (or OMA-URI) in the path.
  const oma = /omaSettings\[([^\]]+)\](?:\.(.+))?$/.exec(path)
  if (oma) {
    const name = change.displayName ?? oma[1]!
    const property = oma[2]
    return { label: property && property !== "value" ? `${name}: ${humanize(property.split(".").pop()!)}` : name, path }
  }
  if (change.displayName) return { label: change.displayName, path }

  // Settings Catalog: the deepest bracketed definition ID names the setting (a child setting inside a group).
  const definitions = [...path.matchAll(/\[([^\]"]*[_.][^\]"]*)\]/g)]
  const last = definitions[definitions.length - 1]
  if (/^settings\[/.test(path) && last) {
    const definitionId = last[1]!
    const rest = path.slice(last.index! + last[0].length)
    const label = definitionLabel(definitionId)
    if (VALUE_PATH.test(rest)) return { label, path, definitionId }
    const property = rest.split(".").filter(Boolean).pop()
    return { label: property ? `${label} (${segmentLabel(property).toLowerCase()})` : label, path, definitionId }
  }

  const segments = path.split(/\.(?![^[]*\])/)
  const lastSegment = segments[segments.length - 1]!
  const parent = segments[segments.length - 2]
  // "value" alone says nothing; name it after what holds it.
  if (parent && /^(?:value|values)$/i.test(lastSegment)) return { label: `${segmentLabel(parent)}: ${lastSegment.toLowerCase()}`, path }
  return { label: segmentLabel(lastSegment), path }
}

export type FormattedValue =
  | { kind: "empty"; text: string }
  | { kind: "text"; text: string; /** The value as stored, when `text` shortens it. */ raw?: string }
  | { kind: "json"; text: string; /** One line describing the object, when it is a Settings Catalog setting. */ summary?: string }

/** Values longer than this are cut with "Show more". */
export const LONG_VALUE = 160

/** A Settings Catalog setting's value: the choice or simple value of its instance. */
function settingSummary(value: any): string | undefined {
  const instance = value?.settingInstance ?? (value?.settingDefinitionId ? value : undefined)
  if (!instance || typeof instance.settingDefinitionId !== "string") return undefined
  const label = definitionLabel(instance.settingDefinitionId)
  const choice = instance.choiceSettingValue?.value
  const simple = instance.simpleSettingValue?.value
  if (typeof choice === "string") return `${label} = ${choiceText(choice, instance.settingDefinitionId)}`
  if (simple !== undefined && (typeof simple !== "object" || simple === null)) return `${label} = ${String(simple)}`
  return label
}

/** device_vendor_..._allowcloudprotection_1 -> "1"; the option part after the setting's definition ID. */
function choiceText(value: string, definitionId?: string): string {
  if (definitionId && value.toLowerCase().startsWith(`${definitionId.toLowerCase()}_`)) return humanize(value.slice(definitionId.length + 1))
  return value
}

/** A choice value of some Settings Catalog setting, recognized without knowing which. */
const CHOICE_VALUE = /^(?:device|user)_vendor_msft_[a-z0-9_.]+_([a-z0-9]+)$|^com\.apple\.[a-z0-9_.]+_([a-z0-9]+)$/i

export function formatValue(value: unknown, definitionId?: string): FormattedValue {
  if (value === null || value === undefined || value === "") return { kind: "empty", text: "Not set" }
  if (typeof value === "boolean" || typeof value === "number") return { kind: "text", text: String(value) }
  if (typeof value === "string") {
    const shortened = choiceText(value, definitionId)
    if (shortened !== value) return { kind: "text", text: shortened, raw: value }
    const choice = CHOICE_VALUE.exec(value)
    if (choice) return { kind: "text", text: humanize(choice[1] ?? choice[2]!), raw: value }
    return { kind: "text", text: value }
  }
  const summary = settingSummary(value)
  return { kind: "json", text: JSON.stringify(value, null, 2), ...(summary ? { summary } : {}) }
}
