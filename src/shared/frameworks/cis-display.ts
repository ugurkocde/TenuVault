import { comparable, rootMatches, type BaselinePolicy, type Finding, type Json, type Observation } from "./policies"
import { formatRate } from "./cis-readiness"
import { definitionLabel } from "../intune/drift-format"
import type { SettingNames } from "../intune/drift"
import { summarizeSetting, type SettingLeaf } from "./setting-summary"

export function benchmarkDisplayName(id: string): string {
  const parts = id.split("-").filter(part => part.length > 0)
  const rest = parts.length > 1 && parts[0]!.toLowerCase() === "intune" ? parts.slice(1) : parts
  return rest.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
}

/** The catalog display name stamped on the policies of a delivered pack, or null when none is known. */
export function packBenchmarkName(policies: readonly BaselinePolicy[]): string | null {
  for (const policy of policies) if (typeof policy.provenance?.benchmarkName === "string" && policy.provenance.benchmarkName) return policy.provenance.benchmarkName
  return null
}

/**
 * Catalog display names of the benchmarks the delivery service lists, so packs and deployments
 * saved before a name was stamped read the same before and after the catalog loads.
 */
const KNOWN_BENCHMARK_NAMES: Readonly<Record<string, string>> = {
  "intune-windows11": "Microsoft Intune for Windows 11",
  "office-intune-bk": "Microsoft Intune for Office",
  "microsoft-intune-edge": "Microsoft Intune for Edge",
  "intune-for-defender": "Microsoft Defender Antivirus",
  "mac-os-26": "CIS Apple macOS 26",
}

/** The display name of a known delivered benchmark id, or null. */
export function knownBenchmarkName(id: string): string | null {
  return Object.hasOwn(KNOWN_BENCHMARK_NAMES, id) ? KNOWN_BENCHMARK_NAMES[id]! : null
}

/** A benchmark named by its catalog display name, a known name, or its prettified id when no name is known. */
export function benchmarkTitle(id: string, name?: string | null): string {
  return name || knownBenchmarkName(id) || benchmarkDisplayName(id)
}

/** A pack reference such as "id 1.0.0 Level 1" with the id replaced by the display name; unchanged when no name is known. */
export function referenceDisplayName(reference: string, name?: string | null): string {
  const id = reference.split(/\s+/)[0] ?? ""
  const display = name || knownBenchmarkName(id)
  return display && id ? `${display}${reference.slice(id.length)}` : reference
}

/**
 * A readable file name for a CIS export, such as "CIS Microsoft Intune for Windows 11 5.0.0 L1
 * findings (Contoso) 2026-10-16.csv": benchmark, version and Level from the pack reference, what
 * the file holds, the tenant and the date. Only characters every file system accepts are kept.
 */
export function cisExportFileName(input: { reference: string; benchmarkName?: string | null; part: string; tenantName?: string | null; date: string; extension: string }): string {
  const clean = (text: string) => text.replace(/[^\p{L}\p{N}_ .()-]/gu, " ").replace(/\s+-\s+/g, " ").replace(/\s+/g, " ").trim()
  const id = input.reference.trim().split(/\s+/)[0] ?? ""
  const rest = input.reference.trim().slice(id.length).replace(/\bLevel (\d)\b/g, "L$1").trim()
  const title = id ? `CIS ${benchmarkTitle(id, input.benchmarkName).replace(/^CIS\s+/i, "")}` : "CIS Benchmarks"
  const tenant = clean(input.tenantName ?? "").slice(0, 40)
  const base = clean([title, rest, input.part].filter(Boolean).join(" ")).slice(0, 80)
  return `${clean(`${base}${tenant ? ` (${tenant})` : ""} ${input.date.slice(0, 10)}`)}.${input.extension}`
}

/** The display name of a Settings Catalog setting: its catalog name when read, else a readable form of its id. */
export function settingDisplayName(settingId: string, names?: SettingNames): string {
  return names && Object.hasOwn(names.settings, settingId) ? names.settings[settingId]! : humanSettingLabel(settingId)
}

/** The name Graph gives every top-level setting group collection, such as most macOS payloads; it names no setting. */
const GENERIC_GROUP_NAME = "Top Level Setting Group Collection"

/**
 * The display name read for a setting, or null when none was read or Graph only has the generic
 * group collection name: views then show the raw id once instead of a guess next to it.
 */
export function knownSettingName(settingId: string, names?: SettingNames): string | null {
  const name = names && Object.hasOwn(names.settings, settingId) ? names.settings[settingId]! : null
  return name && name !== GENERIC_GROUP_NAME ? name : null
}

/** A choice value as its option label when known, else the option part after its setting id, else as stored. */
export function optionDisplayName(value: string, definitionId: string | undefined, names?: SettingNames): string {
  if (names && Object.hasOwn(names.options, value)) return names.options[value]!
  if (definitionId && value.toLowerCase().startsWith(`${definitionId.toLowerCase()}_`)) return value.slice(definitionId.length + 1)
  return value
}

/** A deployment difference entry as the change-set engine records it; the Settings Catalog fields are missing on older entries. */
export interface DiffEntryInput {
  path: string
  before?: string
  after?: string
  definitionId?: string
  beforeSettings?: readonly SettingLeaf[]
  afterSettings?: readonly SettingLeaf[]
  beforeSettingsTotal?: number
  afterSettingsTotal?: number
  beforeToken?: string
  afterToken?: string
}

/** The recorded setting values of one side of a difference by name, and how many values that side holds in total. */
export interface ReadableSettingValues { shown: string[]; total: number }

/** Values a difference lists inline before the rest is behind an expand. */
export const INLINE_SETTING_VALUES = 40

/** Setting values a difference holds but did not record, across its entries; a view must say so before approval. */
export function omittedSettingValues(entries: readonly DiffEntryInput[]): number {
  return entries.reduce((sum, entry) => sum
    + Math.max((entry.beforeSettingsTotal ?? entry.beforeSettings?.length ?? 0) - (entry.beforeSettings?.length ?? 0), 0)
    + Math.max((entry.afterSettingsTotal ?? entry.afterSettings?.length ?? 0) - (entry.afterSettings?.length ?? 0), 0), 0)
}

/**
 * One configuration difference of a benchmark deployment in plain words, such as "Require
 * encryption" with "Disabled" to "Enabled". The setting is the definition the engine recorded for
 * the changed value (a child inside a group names its own setting); for older entries it comes from
 * a path like settings.<definition id>.settingInstance... and a choice token. An added or removed
 * setting or policy lists its recorded setting values by name, so a whole new policy reads as its
 * settings. Paths outside the settings keep their path.
 */
export function readableDiffEntry(entry: DiffEntryInput, names?: SettingNames): { label: string; before?: string; after?: string; beforeValues?: ReadableSettingValues; afterValues?: ReadableSettingValues } {
  const nameOf = (id: string) => names && Object.hasOwn(names.settings, id) ? names.settings[id]! : definitionLabel(id)
  // The label is looked up with the whole option id; only the text shown is shortened.
  const short = (text: string) => text.length > 160 ? `${text.slice(0, 160)}...` : text
  const leafText = (leaf: SettingLeaf) => `${nameOf(leaf.definitionId)}: ${short(optionDisplayName(leaf.value, leaf.definitionId, names))}`
  const valuesOf = (leaves: readonly SettingLeaf[] | undefined, total: number | undefined): ReadableSettingValues | undefined => leaves && (leaves.length || total) ? { shown: leaves.map(leafText), total: Math.max(total ?? leaves.length, leaves.length) } : undefined
  const beforeValues = valuesOf(entry.beforeSettings, entry.beforeSettingsTotal)
  const afterValues = valuesOf(entry.afterSettings, entry.afterSettingsTotal)
  const match = /^settings\.(.+?)(?:\.settingInstance(?:[.[].*)?)?$/.exec(entry.path)
  let definitionId = entry.definitionId ?? match?.[1]
  if (!entry.definitionId && definitionId) {
    for (const value of [entry.beforeToken ?? entry.before, entry.afterToken ?? entry.after]) {
      const owner = value?.replace(/_[^_]+$/, "")
      if (owner && owner !== value && owner !== definitionId && ((names && Object.hasOwn(names.settings, owner)) || owner.startsWith(`${definitionId}_`))) { definitionId = owner; break }
    }
  }
  const whole = entry.path === "(object)"
  if (!definitionId && !whole && !beforeValues && !afterValues) return { label: entry.path, ...(entry.before !== undefined ? { before: entry.before } : {}), ...(entry.after !== undefined ? { after: entry.after } : {}) }
  const label = whole ? "Policy settings" : definitionId ? nameOf(definitionId) : entry.path
  // A shortened text value is read from its whole token, so a long option id still finds its label.
  const shown = (shortened: string | undefined, whole: string | undefined, values: ReadableSettingValues | undefined) => {
    if (shortened === undefined || values) return undefined
    const value = whole ?? shortened
    if (/^[[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value) as { settingInstance?: unknown } | null
        return summarizeSetting(parsed && typeof parsed === "object" && "settingInstance" in parsed ? parsed.settingInstance : parsed, names).join("; ")
      } catch { return value }
    }
    return short(optionDisplayName(value, definitionId, names))
  }
  const before = shown(entry.before, entry.beforeToken, beforeValues)
  const after = shown(entry.after, entry.afterToken, afterValues)
  return { label, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), ...(beforeValues ? { beforeValues } : {}), ...(afterValues ? { afterValues } : {}) }
}

/** The setting definition ids a deployment difference names, for reading their display names. */
export function diffDefinitionIds(entry: DiffEntryInput): string[] {
  const root = /^settings\.(.+?)(?:\.settingInstance(?:[.[].*)?)?$/.exec(entry.path)?.[1]
  const tokens = [entry.beforeToken ?? entry.before, entry.afterToken ?? entry.after].filter((value): value is string => !!value && !/^[[{]/.test(value)).map(value => value.replace(/_[^_]+$/, ""))
  return [...new Set([...(entry.definitionId ? [entry.definitionId] : []), ...(root ? [root, ...tokens.filter(id => id.startsWith(root))] : []), ...[...(entry.beforeSettings ?? []), ...(entry.afterSettings ?? [])].map(leaf => leaf.definitionId)])]
}

export function humanSettingLabel(settingId: string): string {
  let rest = settingId
  for (const prefix of ["device_vendor_msft_policy_config_", "device_vendor_msft_policy_"]) {
    if (rest.startsWith(prefix)) { rest = rest.slice(prefix.length); break }
  }
  const spaced = rest.replace(/_/g, " ").trim()
  const text = spaced || settingId.replace(/_/g, " ").trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : settingId
}

export function policyDisplayName(policyName: string, reference?: string | null): string {
  const ref = reference?.trim()
  if (!ref || !policyName.endsWith(ref)) return policyName
  const trimmed = policyName.slice(0, policyName.length - ref.length).replace(/[\s:,-]+$/, "").trim()
  return trimmed || policyName
}

export interface FindingPolicyGroup {
  policyIndex: number
  policyName: string
  findings: Finding[]
  counts: { Present: number; Different: number; Missing: number; Review: number }
  total: number
}

/**
 * The one definition of a deviating finding that can be selected: Different or Missing. The
 * finding checkbox, Select all deviating, Exclude from score and Plan remediation all use it.
 * Present findings need nothing, and Review findings need a profile choice first.
 */
export function isSelectableFinding(finding: Pick<Finding, "status">): boolean {
  return finding.status === "Different" || finding.status === "Missing"
}

/** Keys of the findings that can be remediated: Different and Missing. Present and Review findings are never selected. */
export function deviatingFindingKeys(findings: readonly Finding[]): string[] {
  return findings.filter(isSelectableFinding).map(finding => finding.key)
}

/** The selected findings that bulk actions act on, in assessment order. */
export function selectedDeviatingFindings(findings: readonly Finding[], selected: ReadonlySet<string>): Finding[] {
  return findings.filter(finding => selected.has(finding.key) && isSelectableFinding(finding))
}

export function groupFindingsByPolicy(findings: readonly Finding[]): FindingPolicyGroup[] {
  const groups: FindingPolicyGroup[] = []
  const byIndex = new Map<number, FindingPolicyGroup>()
  for (const finding of findings) {
    let group = byIndex.get(finding.policyIndex)
    if (!group) {
      group = { policyIndex: finding.policyIndex, policyName: finding.policyName, findings: [], counts: { Present: 0, Different: 0, Missing: 0, Review: 0 }, total: 0 }
      byIndex.set(finding.policyIndex, group)
      groups.push(group)
    }
    group.findings.push(finding)
    group.counts[finding.status] += 1
    group.total += 1
  }
  return groups
}

export function statusMixText(counts: { Present: number; Different: number; Missing: number; Review: number }): string {
  const parts: string[] = []
  if (counts.Present) parts.push(`${counts.Present} present`)
  if (counts.Different) parts.push(`${counts.Different} different`)
  if (counts.Missing) parts.push(`${counts.Missing} missing`)
  if (counts.Review) parts.push(`${counts.Review} review`)
  return parts.join(", ")
}

export interface ObservationValueGroup {
  key: string
  value: Json
  observations: Observation[]
  policyNames: string[]
  matchesRecommended: boolean
}

function targetingKey(observation: Observation): string {
  const targeting = observation.targeting
  if (!targeting) return "targeting:none"
  const targets = targeting.targets
    .map(target => JSON.stringify({ filterId: target.filterId ?? null, filterMode: target.filterMode ?? null, groupId: target.groupId ?? null, kind: target.kind }))
    .sort()
  const limitations = [...targeting.limitations].sort()
  return JSON.stringify({ limitations, state: targeting.state, targets })
}

export function groupObservationsByValue(observations: readonly Observation[], recommended: Json): ObservationValueGroup[] {
  const groups: ObservationValueGroup[] = []
  const byKey = new Map<string, ObservationValueGroup>()
  for (const observation of observations) {
    const valueKey = JSON.stringify(comparable(observation.value))
    const key = `${valueKey}|${targetingKey(observation)}`
    let group = byKey.get(key)
    if (!group) {
      group = { key, value: observation.value, observations: [], policyNames: [], matchesRecommended: rootMatches(recommended, observation.value) }
      byKey.set(key, group)
      groups.push(group)
    }
    group.observations.push(observation)
    if (!group.policyNames.includes(observation.policyName)) group.policyNames.push(observation.policyName)
  }
  return groups
}

export function trendSummaryText(
  latest: { assessedAt: string; levels: readonly { level: number; passRate: number | null }[] } | undefined,
  assessmentCount: number,
  formatDate: (value: string) => string,
): string {
  if (!latest || !latest.levels.length) return "Trend: Not available yet"
  const rates = latest.levels.map(entry => `Level ${entry.level} ${formatRate(entry.passRate)}`).join(", ")
  const suffix = assessmentCount === 1 ? ", first assessment" : `, ${assessmentCount} assessments`
  return `Trend: ${rates} on ${formatDate(latest.assessedAt)}${suffix}`
}
