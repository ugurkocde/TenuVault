import { createHash } from "node:crypto"
import { isFullValidation, OIB_PLATFORMS, type OibPlatform, type PolicyValidation, type ValidationRun } from "../../../shared/oib/types"
import type { CompliancePlatform } from "../../../shared/compliance/types"
import type { FeatureDeps } from "../deps"
import { buildScoreTrend, freshnessAt, scoreFromCounts, type AssessmentIdentity, type BaselineScore, type ScoreCounts } from "./formula"
import { rankGap } from "./gap-ranking"
import type { CountedGap } from "./gaps"
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

/** Whether a saved validation recorded the OIB commit it compared against. */
const hasCommit = (run: Pick<ValidationRun, "commit">) => typeof run.commit === "string" && run.commit !== ""

function validRun(run: ValidationRun): boolean {
  // A validation without a recorded commit stays readable; it is never connected to a trend.
  return typeof run.runId === "string" && (!hasCommit(run) || /^[a-f0-9]{40}$/i.test(run.commit)) && typeof run.reference === "string" && typeof run.validatedAt === "string" && (run.validationVersion === undefined || run.validationVersion === 1) && (run.selection === undefined || run.selection === "all" || run.selection === "single") && Array.isArray(run.results) && run.results.every(validPolicy)
}

export interface OibHistory {
  platform: OibPlatform
  runs: ValidationRun[]
  /** Saved validations of this platform that were unreadable and left out. */
  skipped: number
  error: string | null
}

const UNREADABLE = "Saved OIB validations are incomplete or unreadable. Validate again to produce a score."

/**
 * Saved history only: no collection, Graph request or tenant write. Foreign records are
 * discarded. An unreadable validation is skipped on its own and counted, so it never hides
 * the readable validations of its platform.
 */
export async function readOibHistory(deps: FeatureDeps, tenantId: string): Promise<OibHistory[]> {
  const tenant = tenantId.toLowerCase()
  try {
    const response = await deps.api("/api/oib", tenant, { action: "oib-validations" })
    const body = await response.json() as { runs?: unknown; error?: string }
    if (!response.ok || !Array.isArray(body.runs)) throw new Error(body.error ?? `Saved OIB validations could not be read (${response.status}).`)
    const own = body.runs.filter((entry): entry is ValidationRun => !!entry && typeof entry === "object" && (entry as ValidationRun).tenantId === tenant)
    return platforms.map((platform) => {
      const selected = own.filter((run) => run.platform === platform)
      const valid = selected.filter(validRun)
      const skipped = selected.length - valid.length
      return { platform, runs: valid, skipped, error: skipped && !valid.length ? UNREADABLE : null }
    })
  } catch (error) {
    return platforms.map((platform) => ({ platform, runs: [], skipped: 0, error: error instanceof Error ? error.message : "Saved OIB validations could not be read." }))
  }
}

/**
 * The OIB version a validation used, for display and trend compatibility: the OIB reference
 * (release tag or branch, as saved) and the commit, "windows-v4.0 @ 1cc71a9". Validations
 * connect only when both are the same, so a published tag, which points at one commit, stays
 * on one trend, and any reference that moves to a new commit starts a new one. Nothing is
 * inferred from the reference name.
 */
export function oibVersion(run: Pick<ValidationRun, "reference" | "commit">): string {
  const reference = /· (\S+) @ [0-9a-f]{7}$/i.exec(run.reference)?.[1] ?? run.reference
  return `${reference} @ ${hasCommit(run) ? run.commit.slice(0, 7) : "commit not recorded"}`
}

const NO_COMMIT = "This validation has no recorded OIB commit, so it cannot be connected to another validation."

function project(run: ValidationRun, now: Date): { latest: LatestScore; gaps: RankedGap[] } {
  const counts: ScoreCounts = { matching: 0, different: 0, missing: 0, unknown: 0, outsideScope: 0 }
  const incomplete: string[] = []
  const gaps: CountedGap[] = []
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
    gaps.push({ key: `${policy.source}:${policy.tenantPolicyId}`, capabilityId: policy.source, capabilityName: policy.name, platform: policy.folder === "AppProtectionAndroid" ? "android" : scope(run.platform)[0]!, capabilityStatus: "assignmentUnknown", result: different ? "different" : "missing", countedAs: different ? "The deployed policy sets a different value." : "The deployed policy does not set the expected value.", mixed: false, settings: settings.slice(0, 25), settingIds: [...new Set(settings.map((setting) => setting.settingId))], policies: [{ policyId: policy.tenantPolicyId, policyName: policy.tenantPolicyName, assignment: "unknown" }], controls: [], unknownChecks: unknown, limitations: ["Saved configuration comparison; assignment and device enforcement are unverified."] })
  }
  const score: BaselineScore = scoreFromCounts(counts)
  if (unknownSize) score.coverage = null
  const identity: AssessmentIdentity = {
    runId: run.runId, frameworkId: oibScoreId(run.platform), frameworkName: name(run.platform), frameworkVersion: oibVersion(run),
    rulesetVersion: run.validationVersion === 1 ? "OIB root settings v1" : "OIB legacy validation",
    rulesetSha256: hash(run.validationVersion ?? "legacy"), snapshotSha256: hash(run.results),
    selectionSha256: hash(run.results.map((policy) => [policy.source, policy.tenantPolicyId]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))),
    profile: OIB_PLATFORMS[run.platform].label, platforms: scope(run.platform), assessedAt: run.validatedAt,
  }
  const ranked = gaps.map((gap) => ({ ...gap, ranking: rankGap(gap, incomplete) })).sort((a, b) => b.ranking.score - a.ranking.score || a.key.localeCompare(b.key))
  const versionDetail = hasCommit(run) ? `Commit ${run.commit}` : "No OIB commit was recorded with this validation."
  return { latest: { identity, versionDetail, unit: "setting", uncheckedReferences: 0, freshness: freshnessAt(run.validatedAt, now), score, incompleteCollection: incomplete, gapCount: ranked.length, topGaps: ranked.slice(0, 5) }, gaps: ranked }
}

export const SINGLE_POLICY_ONLY = "Only single-policy validations are saved for this platform. They stay in history and do not set a score. Run Validate all in Policy Validation to score it."
const SINGLE_POLICY_REASON = "Single-policy validation, kept in history only. Run Validate all to set the score."

export function oibFrameworkScore(history: OibHistory, now: Date): FrameworkScore {
  const base = { frameworkId: oibScoreId(history.platform), frameworkName: name(history.platform) }
  if (history.error) return { ...base, state: "unavailable", message: history.error, latest: null, trend: [], incompatible: [], historyOnly: [] }
  const sorted = [...history.runs].sort((a, b) => Date.parse(b.validatedAt) - Date.parse(a.validatedAt))
  const runs = sorted.filter(isFullValidation)
  const historyOnly = sorted.filter((run) => !isFullValidation(run)).map((run) => ({ runId: run.runId, assessedAt: run.validatedAt, reason: SINGLE_POLICY_REASON }))
  const skipped = history.skipped ? ` ${history.skipped} unreadable saved validation${history.skipped === 1 ? " was" : "s were"} left out.` : ""
  if (!runs[0] && historyOnly.length) return { ...base, state: "history-only", message: `${SINGLE_POLICY_ONLY}${skipped}`, latest: null, trend: [], incompatible: [], historyOnly }
  if (!runs[0]) return { ...base, state: "not-assessed", message: "No saved OIB validation for this platform. Run Policy Validation in OpenIntuneBaseline first.", latest: null, trend: [], incompatible: [], historyOnly }
  const projections = runs.map((run) => project(run, now).latest)
  const latest = projections[0]!
  const built = buildScoreTrend(projections.map((item) => ({ identity: item.identity, score: item.score })))
  // A validation without a recorded commit is never connected: its expected settings are unknown.
  const withoutCommit = new Set(runs.filter((run) => !hasCommit(run)).map((run) => run.runId))
  const anchor = latest.identity.runId
  const unconnected = built.trend.filter((point) => point.runId !== anchor && (withoutCommit.has(point.runId) || withoutCommit.has(anchor)))
  const trend = built.trend.filter((point) => !unconnected.includes(point))
  const incompatible = [
    ...built.incompatible.map((point) => (withoutCommit.has(point.runId) ? { ...point, reasons: [NO_COMMIT, ...point.reasons] } : point)),
    ...unconnected.map((point) => ({ ...point, reasons: [NO_COMMIT] })),
  ]
  const partial = new Set(projections.filter((item) => item.incompleteCollection.length > 0).map((item) => item.identity.runId))
  return { ...base, state: latest.score.state, message: `${NOTE}${skipped}`, latest, trend: trend.map((point) => ({ ...point, partial: partial.has(point.runId) })), incompatible, historyOnly }
}

export function oibFrameworkDetail(run: ValidationRun, now: Date): FrameworkDetail {
  const { latest, gaps } = project(run, now)
  return { identity: latest.identity, versionDetail: latest.versionDetail, unit: latest.unit, freshness: latest.freshness, score: latest.score, incompleteCollection: latest.incompleteCollection, items: [], gaps, controls: [], unassessedNote: NOTE }
}
