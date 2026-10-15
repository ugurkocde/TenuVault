import { comparable, rootMatches, type Finding, type Json, type Observation } from "./policies"

export function benchmarkDisplayName(id: string): string {
  const parts = id.split("-").filter(part => part.length > 0)
  const rest = parts.length > 1 && parts[0]!.toLowerCase() === "intune" ? parts.slice(1) : parts
  return rest.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
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

/** Keys of the findings that can be remediated: Different and Missing. Present and Review findings are never selected. */
export function deviatingFindingKeys(findings: readonly Finding[]): string[] {
  return findings.filter(finding => finding.status === "Different" || finding.status === "Missing").map(finding => finding.key)
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
  const rates = latest.levels.map(entry => `Level ${entry.level} ${entry.passRate === null ? "Not available" : `${(entry.passRate * 100).toFixed(1)}%`}`).join(", ")
  const suffix = assessmentCount === 1 ? ", first assessment" : `, ${assessmentCount} assessments`
  return `Trend: ${rates} on ${formatDate(latest.assessedAt)}${suffix}`
}
