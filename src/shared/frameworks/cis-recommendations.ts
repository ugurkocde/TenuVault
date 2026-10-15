import type { Assessment, BaselinePolicy, Finding, Json } from "./policies"

/**
 * Recommendation identity for benchmark packs. A delivered pack may list its
 * recommendations, each with the setting definitions that implement it; for a
 * grouped payload those are the leaf child definitions. The list travels on the
 * pack policies that hold one of its settings, so saved assessments keep it.
 * Packs without the list keep working exactly as before.
 */

export interface PackRecommendation { id: string; title: string; level: 1 | 2; settings: string[] }

export const MAX_PACK_RECOMMENDATIONS = 2000
export const MAX_RECOMMENDATION_TITLE_LENGTH = 300
export const MAX_RECOMMENDATION_SETTINGS = 200
const ID_PATTERN = /^\d{1,4}(?:\.\d{1,4}){1,9}$/
const FIELDS = new Set(["id", "title", "level", "settings"])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Validates a recommendation list strictly: known fields only, dotted numeric ids, bounded titles and settings, no repeated id. */
export function validatePackRecommendations(input: unknown, label = "Recommendations"): PackRecommendation[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array.`)
  if (input.length > MAX_PACK_RECOMMENDATIONS) throw new Error(`${label} must contain at most ${MAX_PACK_RECOMMENDATIONS} entries.`)
  const seen = new Set<string>()
  return input.map((entry, index) => {
    const at = `${label} entry ${index + 1}`
    if (!isRecord(entry)) throw new Error(`${at}: expected an object with id, title, level and settings.`)
    for (const key of Object.keys(entry)) if (!FIELDS.has(key)) throw new Error(`${at}: unknown field: ${key}. Expected id, title, level and settings.`)
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) throw new Error(`${at}: id must be a dotted numeric identifier such as 1.2.3.`)
    if (seen.has(entry.id)) throw new Error(`${at}: duplicate recommendation ${entry.id}.`)
    seen.add(entry.id)
    if (typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > MAX_RECOMMENDATION_TITLE_LENGTH) throw new Error(`${at}: title must be a non-empty string of at most ${MAX_RECOMMENDATION_TITLE_LENGTH} characters.`)
    if (entry.level !== 1 && entry.level !== 2) throw new Error(`${at}: level must be 1 or 2.`)
    if (!Array.isArray(entry.settings) || !entry.settings.length || entry.settings.length > MAX_RECOMMENDATION_SETTINGS ||
        entry.settings.some(setting => typeof setting !== "string" || !setting || setting.length > 500)) {
      throw new Error(`${at}: settings must list between 1 and ${MAX_RECOMMENDATION_SETTINGS} setting definition IDs.`)
    }
    return { id: entry.id, title: entry.title.trim(), level: entry.level, settings: [...new Set(entry.settings as string[])] }
  })
}

/** The definition ID of a setting instance and of every child instance nested in it. */
export function definitionIds(instance: Json | undefined): string[] {
  const ids = new Set<string>()
  const walk = (value: Json | undefined): void => {
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return }
    if (!isRecord(value)) return
    if (typeof value.settingDefinitionId === "string") ids.add(value.settingDefinitionId)
    for (const child of Object.values(value)) walk(child as Json)
  }
  walk(instance)
  return [...ids]
}

/** Each pack policy with the recommendations that name one of its settings, root or leaf. */
export function attachRecommendations(policies: BaselinePolicy[], recommendations: PackRecommendation[]): BaselinePolicy[] {
  return policies.map(policy => {
    const held = new Set(policy.settings.flatMap(setting => definitionIds(setting.settingInstance)))
    const matched = recommendations.filter(recommendation => recommendation.settings.some(id => held.has(id)))
    return matched.length ? { ...policy, recommendations: matched } : policy
  })
}

/** The recommendations a finding implements: its root definition or one of its leaf children is mapped. */
export function recommendationsForFinding(policies: BaselinePolicy[], finding: Pick<Finding, "policyIndex" | "settingIndex">): PackRecommendation[] {
  const policy = policies[finding.policyIndex]
  if (!policy?.recommendations?.length) return []
  const ids = new Set(definitionIds(policy.settings[finding.settingIndex]?.settingInstance))
  return policy.recommendations.filter(recommendation => recommendation.settings.some(id => ids.has(id)))
}

/** "1.2.3 Title" for each recommendation, joined for a single line. */
export function recommendationLabel(recommendations: PackRecommendation[]): string {
  return recommendations.map(recommendation => `${recommendation.id} ${recommendation.title}`).join("; ")
}

export type RecommendationResultState = "Pass" | "Fail" | "Review"
export interface RecommendationResult { id: string; title: string; level: 1 | 2; result: RecommendationResultState; findingKeys: string[] }

function compareIds(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1)
    if (difference) return difference
  }
  return 0
}

/**
 * One result per recommendation that maps to at least one finding. A recommendation
 * passes only when every mapped finding is Present and fails when any is Different
 * or Missing; otherwise a mapped Review finding leaves it to review.
 */
export function recommendationResults(assessment: Pick<Assessment, "findings">, policies: BaselinePolicy[]): RecommendationResult[] {
  const results = new Map<string, { recommendation: PackRecommendation; findings: Finding[] }>()
  for (const finding of assessment.findings) {
    for (const recommendation of recommendationsForFinding(policies, finding)) {
      const entry = results.get(recommendation.id) ?? { recommendation, findings: [] }
      entry.findings.push(finding)
      results.set(recommendation.id, entry)
    }
  }
  return [...results.values()].sort((a, b) => compareIds(a.recommendation.id, b.recommendation.id)).map(({ recommendation, findings }) => ({
    id: recommendation.id, title: recommendation.title, level: recommendation.level,
    result: findings.some(finding => finding.status === "Different" || finding.status === "Missing") ? "Fail" : findings.every(finding => finding.status === "Present") ? "Pass" : "Review",
    findingKeys: findings.map(finding => finding.key),
  }))
}
