import { comparable, type Finding, type Json, type Observation } from "./policies"

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
  policyName: string
  findings: Finding[]
  counts: { Present: number; Different: number; Missing: number; Review: number }
  total: number
}

export function groupFindingsByPolicy(findings: readonly Finding[]): FindingPolicyGroup[] {
  const groups: FindingPolicyGroup[] = []
  const byName = new Map<string, FindingPolicyGroup>()
  for (const finding of findings) {
    let group = byName.get(finding.policyName)
    if (!group) {
      group = { policyName: finding.policyName, findings: [], counts: { Present: 0, Different: 0, Missing: 0, Review: 0 }, total: 0 }
      byName.set(finding.policyName, group)
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

export function groupObservationsByValue(observations: readonly Observation[], recommended: Json): ObservationValueGroup[] {
  const recommendedKey = JSON.stringify(comparable(recommended))
  const groups: ObservationValueGroup[] = []
  const byKey = new Map<string, ObservationValueGroup>()
  for (const observation of observations) {
    const key = JSON.stringify(comparable(observation.value))
    let group = byKey.get(key)
    if (!group) {
      group = { key, value: observation.value, observations: [], policyNames: [], matchesRecommended: key === recommendedKey }
      byKey.set(key, group)
      groups.push(group)
    }
    group.observations.push(observation)
    if (!group.policyNames.includes(observation.policyName)) group.policyNames.push(observation.policyName)
  }
  return groups
}
