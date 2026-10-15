import { definitionStatus, type Assessment, type BaselinePolicy, type Finding, type Json } from "./policies"

/**
 * Recommendation identity for benchmark packs. A delivered pack may list its
 * recommendations, each as { id, title, level, settings }. `settings` is a list
 * of settingDefinitionId strings: the root ID for a simple setting, and the leaf
 * child ID for a grouped root such as a group setting collection, so many
 * recommendations can share one root. A leaf ID locates its root by itself,
 * because the pack root that contains it is found by its nested definitions.
 * The list travels on the pack policies that hold one of its settings, so saved
 * assessments keep it; recommendations that name no setting of the pack travel
 * on the first policy and count as not assessed. Packs without the list keep
 * working exactly as before.
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

/** Each pack policy with the recommendations that name one of its settings, root or leaf. Unmatched ones go on the first policy. */
export function attachRecommendations(policies: BaselinePolicy[], recommendations: PackRecommendation[]): BaselinePolicy[] {
  const held = policies.map(policy => new Set(policy.settings.flatMap(setting => definitionIds(setting.settingInstance))))
  const unmatched = recommendations.filter(recommendation => !held.some(ids => recommendation.settings.some(id => ids.has(id))))
  return policies.map((policy, index) => {
    const matched = recommendations.filter(recommendation => recommendation.settings.some(id => held[index]!.has(id)))
    const carried = index === 0 ? [...matched, ...unmatched] : matched
    return carried.length ? { ...policy, recommendations: carried } : policy
  })
}

/** Every recommendation carried by the pack policies, once each. */
export function packRecommendations(policies: BaselinePolicy[]): PackRecommendation[] {
  const byId = new Map<string, PackRecommendation>()
  for (const policy of policies) for (const recommendation of policy.recommendations ?? []) if (!byId.has(recommendation.id)) byId.set(recommendation.id, recommendation)
  return [...byId.values()]
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

export type RecommendationResultState = "Pass" | "Fail" | "Review" | "Not assessed"
export type RecommendationSettingStatus = "Present" | "Missing" | "Different" | "Review" | "Unmapped"
export interface RecommendationResult {
  id: string
  title: string
  level: 1 | 2
  result: RecommendationResultState
  /** One entry per mapped setting definition, judged leaf by leaf across the tenant. */
  settings: Array<{ id: string; status: RecommendationSettingStatus }>
  findingKeys: string[]
}

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
 * One result per pack recommendation. Each mapped setting is judged on its own leaf with the
 * same leaf rule the comparison uses for grouped roots, across every tenant policy holding the
 * root: Present when every tenant occurrence equals the recommended value, Missing when no
 * tenant policy holds it, Different when any occurrence differs. A recommendation passes only
 * when every mapped setting is Present and fails when any is Missing or Different. A setting
 * whose pack root needs a profile choice (Review) leaves the recommendation to review, and a
 * recommendation with no setting in the pack is not assessed.
 */
export function recommendationResults(assessment: Pick<Assessment, "findings">, policies: BaselinePolicy[]): RecommendationResult[] {
  const findingIds = assessment.findings.map(finding => ({ finding, ids: new Set(definitionIds(finding.recommended)) }))
  return packRecommendations(policies).sort((a, b) => compareIds(a.id, b.id)).map(recommendation => {
    const keys = new Set<string>()
    const settings = recommendation.settings.map(id => {
      const mapped = findingIds.filter(entry => entry.ids.has(id)).map(entry => entry.finding)
      for (const finding of mapped) keys.add(finding.key)
      if (!mapped.length) return { id, status: "Unmapped" as const }
      if (mapped.some(finding => finding.status === "Review")) return { id, status: "Review" as const }
      const statuses = mapped.map(finding => definitionStatus(finding.recommended, finding.observed.map(observation => observation.value), id))
      return { id, status: statuses.includes("Different") ? "Different" as const : statuses.includes("Missing") ? "Missing" as const : "Present" as const }
    })
    const statuses = settings.map(setting => setting.status)
    const result: RecommendationResultState = statuses.every(status => status === "Unmapped") ? "Not assessed"
      : statuses.some(status => status === "Missing" || status === "Different") ? "Fail"
        : statuses.includes("Review") ? "Review" : "Pass"
    return { id: recommendation.id, title: recommendation.title, level: recommendation.level, result, settings, findingKeys: [...keys] }
  })
}

/** Recommendations per result: passed, failed, to review and not assessed. */
export function recommendationTotals(results: readonly RecommendationResult[]): { passed: number; failed: number; review: number; notAssessed: number } {
  const count = (result: RecommendationResult["result"]) => results.filter(item => item.result === result).length
  return { passed: count("Pass"), failed: count("Fail"), review: count("Review"), notAssessed: count("Not assessed") }
}
