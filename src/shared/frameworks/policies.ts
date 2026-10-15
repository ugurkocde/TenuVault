import type { AssignmentEvidence } from "./evidence"
import { validatePackRecommendations, type PackRecommendation } from "./cis-recommendations"
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type RecordJson = { [key: string]: Json }
export interface BaselinePolicy {
  name: string
  platforms: string
  technologies: string
  description: string
  settings: RecordJson[]
  provenance?: RecordJson
  templateReference?: { templateId: string }
  /** Benchmark recommendations that name a setting of this policy, from a delivered pack. */
  recommendations?: PackRecommendation[]
}
export interface Observation { policyId: string; policyName: string; value: Json; targeting?: AssignmentEvidence; applicability?: "unavailable"; enforcement?: "unavailable" }
export interface Finding {
  key: string
  policyIndex: number
  settingIndex: number
  policyName: string
  settingId: string
  status: "Present" | "Missing" | "Different" | "Review"
  recommended: Json
  observed: Observation[]
}
export interface Assessment {
  runId: string
  tenantId: string
  frameworkId: string
  reference: string
  assessedAt: string
  policyCount: number
  findings: Finding[]
  organizationalEvidence?: { state: "manual"; note: string }
}

export function record(value: unknown): value is RecordJson {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Remove export annotations, retaining derived type discriminators needed by Graph. */
export function clean(value: Json): Json {
  if (Array.isArray(value)) return value.map(clean)
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key, v]) => v !== null && key !== "id" && key !== "auditRuleInformation" && (!key.includes("@odata.") || key === "@odata.type"))
    .map(([key, v]) => [key, clean(v)]))
}

export function parsePolicies(input: unknown): BaselinePolicy[] {
  const values = Array.isArray(input) ? input : [input]
  if (!values.length || values.length > 200) throw new Error("Import between 1 and 200 Settings Catalog policies.")
  if (JSON.stringify(values).length > 8_000_000) throw new Error("The policy pack exceeds 8 MB.")
  return values.map((value, index) => {
    if (!record(value) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 ||
        typeof value.platforms !== "string" || !value.platforms || typeof value.technologies !== "string" || !value.technologies ||
        !Array.isArray(value.settings) || !value.settings.length || value.settings.length > 1000) {
      throw new Error(`Policy ${index + 1}: expected a Settings Catalog export with name, platforms, technologies and settings.`)
    }
    const seen = new Set<string>()
    const settings = value.settings.map(setting => {
      if (!record(setting) || !record(setting.settingInstance) || typeof setting.settingInstance.settingDefinitionId !== "string" ||
          typeof setting.settingInstance["@odata.type"] !== "string") throw new Error(`Policy ${index + 1}: settingInstance requires a definition ID and derived @odata.type.`)
      const id = setting.settingInstance.settingDefinitionId
      if (seen.has(id)) throw new Error(`Policy ${index + 1}: duplicate root setting ${id}.`)
      seen.add(id)
      return { settingInstance: clean(setting.settingInstance) }
    })
    const template = record(value.templateReference) && typeof value.templateReference.templateId === "string" && value.templateReference.templateId
      ? { templateId: value.templateReference.templateId } : undefined
    if (value.provenance !== undefined && (!record(value.provenance) || Object.values(value.provenance).some(item => typeof item !== 'string' && typeof item !== 'number'))) throw new Error('Invalid pack provenance')
    const recommendations = value.recommendations === undefined ? undefined : validatePackRecommendations(value.recommendations, `Policy ${index + 1} recommendations`)
    return { ...(record(value.provenance) ? { provenance: value.provenance } : {}), name: value.name.trim(), platforms: value.platforms, technologies: value.technologies,
      description: typeof value.description === "string" ? value.description.slice(0, 1500) : "", settings, ...(template ? { templateReference: template } : {}), ...(recommendations?.length ? { recommendations } : {}) }
  })
}

/** Compare configuration content, ignoring export/template metadata. Preserve array ordering conservatively. */
export function comparable(value: Json): Json {
  if (Array.isArray(value)) return value.map(comparable)
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([key, v]) => v !== null && key !== "id" && key !== "auditRuleInformation" && !key.includes("@odata.") && !key.endsWith("TemplateReference"))
    .map(([key, v]) => [key, comparable(v)]))
}

function isInstance(value: Json): value is RecordJson {
  return record(value) && typeof value.settingDefinitionId === "string"
}

/** True when a setting instance nests child setting instances, as group setting collections do. */
export function hasChildInstances(value: Json): boolean {
  if (Array.isArray(value)) return value.some(hasChildInstances)
  if (!record(value)) return false
  return Object.entries(value).some(([key, v]) => (key === "children" && Array.isArray(v) && v.some(isInstance)) || hasChildInstances(v))
}

/**
 * Leaf values of one comparable setting instance, keyed by the settingDefinitionId path from
 * the root. Child instances are taken out of their parent's own value and keyed below it, so
 * a root holding extra children still yields every other leaf unchanged. A repeated child
 * definition in one children list is keyed by its occurrence.
 */
function leafValues(instance: RecordJson, path: string, out: Map<string, string>): Map<string, string> {
  const own = `${path}/${String(instance.settingDefinitionId)}`
  const strip = (value: Json, at: string): Json => {
    if (Array.isArray(value)) return value.map((entry, index) => strip(entry, `${at}[${index}]`))
    if (!record(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      if (key !== "children" || !Array.isArray(v)) return [key, strip(v, `${at}.${key}`)]
      const seen = new Map<string, number>()
      for (const child of v.filter(isInstance)) {
        const id = String(child.settingDefinitionId)
        const occurrence = seen.get(id) ?? 0
        seen.set(id, occurrence + 1)
        leafValues(child, `${own}${at}${occurrence ? `#${occurrence}` : ""}`, out)
      }
      return [key, v.filter(child => !isInstance(child))]
    }))
  }
  out.set(own, JSON.stringify(strip(instance, "")))
  return out
}

/**
 * Whether an observed root satisfies a recommended root. A root without child setting
 * instances must match exactly. A grouped root, such as a group setting collection, matches
 * when every recommended leaf exists at the same definition path with an equal value; extra
 * tenant children are ignored, so a payload hardened beyond the recommendation still passes.
 */
export function rootMatches(recommended: Json, observed: Json): boolean {
  const want = comparable(recommended)
  const have = comparable(observed)
  if (!isInstance(want) || !hasChildInstances(want)) return JSON.stringify(want) === JSON.stringify(have)
  if (!isInstance(have) || have.settingDefinitionId !== want.settingDefinitionId) return false
  const haveLeaves = leafValues(have, "", new Map())
  return [...leafValues(want, "", new Map())].every(([path, value]) => haveLeaves.get(path) === value)
}

export interface LandscapePolicy extends BaselinePolicy { id: string; targeting?: AssignmentEvidence }
export function comparePolicies(baselines: BaselinePolicy[], landscape: LandscapePolicy[]): Finding[] {
  const observations = new Map<string, Observation[]>()
  const recommendations = new Map<string, Set<string>>()
  for (const policy of landscape) for (const setting of policy.settings) {
    if (!record(setting.settingInstance)) continue
    const key = `${policy.platforms}:${setting.settingInstance.settingDefinitionId}`
    const entries = observations.get(key) ?? []
    entries.push({ policyId: policy.id, policyName: policy.name, value: comparable(setting.settingInstance), ...(policy.targeting ? { targeting: policy.targeting, applicability: "unavailable" as const, enforcement: "unavailable" as const } : {}) })
    observations.set(key, entries)
  }
  for (const policy of baselines) for (const setting of policy.settings) {
    const root = setting.settingInstance as RecordJson
    const key = `${policy.platforms}:${root.settingDefinitionId}`
    const entries = recommendations.get(key) ?? new Set<string>()
    entries.add(JSON.stringify(comparable(root)))
    recommendations.set(key, entries)
  }
  return baselines.flatMap((policy, policyIndex) => policy.settings.map((setting, settingIndex) => {
    const root = setting.settingInstance as RecordJson
    const settingId = root.settingDefinitionId as string
    const recommended = comparable(root)
    const key = `${policy.platforms}:${settingId}`
    const observed = observations.get(key) ?? []
    const matched = observed.filter(o => rootMatches(recommended, o.value)).length
    // Multiple recommended values for the same definition require an admin to select a profile first.
    const ambiguous = (recommendations.get(key)?.size ?? 0) > 1
    return { key: `${policyIndex}:${settingIndex}`, policyIndex, settingIndex, policyName: policy.name, settingId,
      status: ambiguous ? "Review" : !observed.length ? "Missing" : matched === observed.length ? "Present" : "Different", recommended, observed }
  }))
}

export function remediationPayload(policy: BaselinePolicy, settings: RecordJson[], reference: string): BaselinePolicy {
  const { provenance: _provenance, recommendations: _recommendations, ...payload } = policy
  return { ...payload, name: `[Baseline] ${policy.name}`.slice(0, 200), description: `TenuVault baseline: ${reference}. Created unassigned.\n${policy.description}`.slice(0, 1500), settings }
}
