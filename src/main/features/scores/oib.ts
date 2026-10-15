import { createHash } from "node:crypto"
import { OIB_PLATFORMS, type OibPlatform, type PolicyValidation, type ValidationRun } from "../../../shared/oib/types"
import type { CompliancePlatform } from "../../../shared/compliance/types"
import type { FeatureDeps } from "../deps"
import { buildScoreTrend, freshnessAt, scoreFromCounts, type AssessmentIdentity, type BaselineScore, type Gap, type ScoreCounts } from "./formula"
import { rankGap } from "./gap-ranking"
import type { FrameworkDetail, FrameworkScore, LatestScore, RankedGap } from "./view"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const platforms = Object.keys(OIB_PLATFORMS) as OibPlatform[]
export const oibScoreId = (platform: OibPlatform) => `oib-${platform}`
export const oibScorePlatform = (id: string): OibPlatform | null => platforms.find((platform) => oibScoreId(platform) === id) ?? null
const name = (platform: OibPlatform) => `OpenIntuneBaseline ${OIB_PLATFORMS[platform].label}`
const scope = (platform: OibPlatform): CompliancePlatform[] => {
  switch (platform) {
    case "byod": return ["android", "ios"]
    case "ios": return ["ios"]
    case "android": return ["android"]
    case "macos": return ["macos"]
    default: return ["windows"]
  }
}
const NOTE = "Selected deployed policies only, not the whole baseline. Undeployed and unselected policies, targeting and device enforcement are not assessed. Tenant-only settings are shown by Policy Validation but do not count against the expected OIB settings score. Coverage is unavailable when a failed or unsupported policy has no saved expected-setting count; its unknown entry represents a policy, not a setting."

function validPolicy(value: unknown): value is PolicyValidation {
  if (!value || typeof value !== "object") return false
  const policy = value as PolicyValidation
  if (![policy.source, policy.name, policy.folder, policy.tenantPolicyId, policy.tenantPolicyName].every((item) => typeof item === "string")) return false
  if (policy.status === "error" || policy.status === "unsupported") return policy.expectedSettings === undefined || count(policy.expectedSettings)
  const result = policy.result
  return (policy.status === "compliant" || policy.status === "drifted") && !!result && count(result.totalOib) && count(result.matched) && result.matched <= result.totalOib &&
    [result.different, result.missing, result.extra].every((value) => value === undefined || count(value)) &&
    [result.mismatches, result.oibOnly, result.tenantOnly].every((entries) => Array.isArray(entries) && entries.every((entry) => entry && typeof entry.settingDefinitionId === "string" && typeof entry.label === "string"))
}

export interface OibHistory {
  platform: OibPlatform
  runs: ValidationRun[]
  error: string | null
}

/** Saved history only: no collection, Graph request or tenant write. Foreign records are discarded. */
export async function readOibHistory(deps: FeatureDeps, tenantId: string): Promise<OibHistory[]> {
  const tenant = tenantId.toLowerCase()
  try {
    const response = await deps.api("/api/oib", tenant, { action: "oib-validations" })
    const body = await response.json() as { runs?: unknown; error?: string }
    if (!response.ok || !Array.isArray(body.runs)) throw new Error(body.error ?? `Saved OIB validations could not be read (${response.status}).`)
    const own = body.runs.filter((entry): entry is ValidationRun => !!entry && typeof entry === "object" && (entry as ValidationRun).tenantId === tenant)
    return platforms.map((platform) => {
      const selected = own.filter((run) => run.platform === platform)
      const valid = selected.every((run) => typeof run.runId === "string" && typeof run.commit === "string" && /^[a-f0-9]{40}$/i.test(run.commit) && typeof run.reference === "string" && typeof run.validatedAt === "string" && (run.validationVersion === undefined || run.validationVersion === 1) && Array.isArray(run.results) && run.results.every(validPolicy))
      return { platform, runs: valid ? selected : [], error: valid ? null : "Saved OIB validations are incomplete or unreadable. Validate again to produce a score." }
    })
  } catch (error) {
    return platforms.map((platform) => ({ platform, runs: [], error: error instanceof Error ? error.message : "Saved OIB validations could not be read." }))
  }
}

function project(run: ValidationRun, now: Date): { latest: LatestScore; gaps: RankedGap[] } {
  const counts: ScoreCounts = { matching: 0, different: 0, missing: 0, unknown: 0, outsideScope: 0 }
  const incomplete: string[] = []
  const gaps: Gap[] = []
  let unknownSize = false
  for (const policy of run.results) {
    const result = policy.status === "compliant" || policy.status === "drifted" ? policy.result : undefined
    if (!result) {
      // Historic failed/unsupported policies have no expected-setting count. One unknown
      // policy is visible, but coverage is withheld rather than treating it as one setting.
      counts.unknown += policy.expectedSettings ?? 1
      unknownSize ||= policy.expectedSettings === undefined
      incomplete.push(`${policy.name}: ${policy.status}`)
      continue
    }
    const missing = result.missing ?? new Set(result.oibOnly.map((entry) => entry.settingDefinitionId)).size
    const different = result.different ?? new Set(result.mismatches.map((entry) => entry.settingDefinitionId)).size
    if (result.matched + different + missing > result.totalOib) {
      counts.unknown += result.totalOib || 1
      incomplete.push(`${policy.name}: inconsistent saved setting counts`)
      continue
    }
    counts.matching += result.matched
    counts.different += different
    counts.missing += missing
    const unknown = result.totalOib - result.matched - different - missing
    counts.unknown += unknown
    if (unknown) incomplete.push(`${policy.name}: saved difference detail was truncated`)
    const settings = [
      ...result.mismatches.map((entry) => ({ settingId: entry.settingDefinitionId, result: "different" as const, expected: entry.oibValue ?? "Unknown", observed: entry.tenantValue ?? null, policyId: policy.tenantPolicyId, reason: entry.path ?? null })),
      ...result.oibOnly.map((entry) => ({ settingId: entry.settingDefinitionId, result: "missing" as const, expected: entry.oibValue ?? "Unknown", observed: null, policyId: policy.tenantPolicyId, reason: null })),
    ]
    if (different + missing === 0) continue
    gaps.push({ key: `${policy.source}:${policy.tenantPolicyId}`, capabilityId: policy.source, capabilityName: policy.name, platform: policy.folder === "AppProtectionAndroid" ? "android" : scope(run.platform)[0]!, capabilityStatus: "assignmentUnknown", result: different ? "different" : "missing", mixed: false, settings: settings.slice(0, 25), settingIds: [...new Set(settings.map((setting) => setting.settingId))], policies: [{ policyId: policy.tenantPolicyId, policyName: policy.tenantPolicyName, assignment: "unknown" }], controls: [], unknownChecks: unknown, limitations: ["Saved configuration comparison; assignment and device enforcement are unverified."] })
  }
  const score: BaselineScore = scoreFromCounts(counts)
  if (unknownSize) score.coverage = null
  const identity: AssessmentIdentity = {
    runId: run.runId, frameworkId: oibScoreId(run.platform), frameworkName: name(run.platform), frameworkVersion: run.commit,
    rulesetVersion: run.validationVersion === 1 ? "OIB root settings v1" : "OIB legacy validation",
    rulesetSha256: hash(run.validationVersion ?? "legacy"), snapshotSha256: hash(run.results),
    selectionSha256: hash(run.results.map((policy) => [policy.source, policy.tenantPolicyId]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))),
    profile: OIB_PLATFORMS[run.platform].label, platforms: scope(run.platform), assessedAt: run.validatedAt,
  }
  const ranked = gaps.map((gap) => ({ ...gap, ranking: rankGap(gap, incomplete) })).sort((a, b) => b.ranking.score - a.ranking.score || a.key.localeCompare(b.key))
  return { latest: { identity, freshness: freshnessAt(run.validatedAt, now), score, incompleteCollection: incomplete, gapCount: ranked.length, topGaps: ranked.slice(0, 5) }, gaps: ranked }
}

export function oibFrameworkScore(history: OibHistory, now: Date): FrameworkScore {
  const base = { frameworkId: oibScoreId(history.platform), frameworkName: name(history.platform) }
  if (history.error) return { ...base, state: "unavailable", message: history.error, latest: null, trend: [], incompatible: [] }
  const runs = [...history.runs].sort((a, b) => Date.parse(b.validatedAt) - Date.parse(a.validatedAt))
  if (!runs[0]) return { ...base, state: "not-assessed", message: "No saved OIB validation for this platform. Run Policy Validation in OpenIntuneBaseline first.", latest: null, trend: [], incompatible: [] }
  const projections = runs.map((run) => project(run, now).latest)
  const latest = projections[0]!
  const trend = buildScoreTrend(projections.map((item) => ({ identity: item.identity, score: item.score })))
  return { ...base, state: latest.score.state, message: NOTE, latest, ...trend }
}

export function oibFrameworkDetail(run: ValidationRun, now: Date): FrameworkDetail {
  const { latest, gaps } = project(run, now)
  return { identity: latest.identity, freshness: latest.freshness, score: latest.score, incompleteCollection: latest.incompleteCollection, gaps, controls: [], unassessedNote: NOTE }
}
