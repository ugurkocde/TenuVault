import { comparisonCounts, type NativeAssessment } from "../../../shared/compliance/native"
import type { CapabilityStatus, CompliancePlatform, TechnicalCheck } from "../../../shared/compliance/types"

/**
 * Deterministic baseline score of one saved native comparison (#137). Pure: no Electron,
 * storage or network, so every rule here is unit tested directly.
 *
 * Counting follows comparisonCounts, the same numbers the Frameworks page shows:
 * Matching, different, missing: capabilities the comparison could evaluate using assigned policies.
 * Unknown: capabilities marked "unable to check" (collection failed, unreadable
 *   values, no detector). They are not evidence either way.
 * Outside scope: capabilities for platforms the admin left out of the comparison.
 *
 * score    = matching / (matching + different + missing), over evaluated capabilities only
 * coverage = evaluated / (evaluated + unknown)
 *
 * With no evaluated capability there is no score at all ("not scored"), never 0 % or 100 %.
 */
export const SCORE_FORMULA =
  "Score = matching / (matching + different + missing) over evaluated capabilities. Each capability counts once using its best assigned policy evidence. Unassigned policies cannot count as matches. Unknown results are left out of the score and shown as coverage = evaluated / (evaluated + unknown). Outside scope results are not counted. No evaluated capability means no score."

/** Days after which a saved comparison is shown as stale. */
export const STALE_AFTER_DAYS = 30

export interface ScoreCounts {
  matching: number
  different: number
  missing: number
  unknown: number
  outsideScope: number
}

export interface BaselineScore {
  counts: ScoreCounts
  evaluated: number
  /** evaluated + unknown; outside scope results are not part of the assessed total. */
  assessed: number
  /** 0 to 100 with one decimal, or null when nothing could be evaluated. */
  score: number | null
  /** 0 to 100 with one decimal, or null when nothing was assessed. */
  coverage: number | null
  state: "scored" | "not-scored"
  /** Why there is no score, in plain words. */
  reason: string | null
}

function percent(part: number, whole: number): number {
  return Math.round((part / whole) * 1000) / 10
}

/** Applies the formula to counts. Negative or non-finite counts are treated as zero. */
export function scoreFromCounts(raw: ScoreCounts): BaselineScore {
  const clean = (value: number) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
  const counts: ScoreCounts = { matching: clean(raw.matching), different: clean(raw.different), missing: clean(raw.missing), unknown: clean(raw.unknown), outsideScope: clean(raw.outsideScope) }
  const evaluated = counts.matching + counts.different + counts.missing
  const assessed = evaluated + counts.unknown
  if (evaluated === 0) {
    return {
      counts,
      evaluated,
      assessed,
      score: null,
      coverage: assessed ? 0 : null,
      state: "not-scored",
      reason: assessed ? "No capability could be evaluated; every result is unknown." : "The comparison contains no capabilities in scope.",
    }
  }
  return { counts, evaluated, assessed, score: percent(counts.matching, evaluated), coverage: percent(evaluated, assessed), state: "scored", reason: null }
}

/** The score of one saved comparison, counted like the Frameworks page counts it. */
export function scoreRun(run: NativeAssessment): BaselineScore {
  const counts = comparisonCounts(run)
  return scoreFromCounts({ matching: counts.matches, different: counts.different, missing: counts.missing, unknown: counts.unableToCheck, outsideScope: counts.outsideScope })
}

/** What identifies an assessment for trends and for linking findings to it. */
export interface AssessmentIdentity {
  runId: string
  frameworkId: string
  frameworkName: string
  frameworkVersion: string
  rulesetVersion: string
  rulesetSha256: string
  snapshotSha256: string
  /** OIB validation selection; a changed set of policies must start a separate trend. */
  selectionSha256?: string
  /** Framework profile such as "Maturity level 2"; "Default" when the framework has none. */
  profile: string
  platforms: CompliancePlatform[]
  assessedAt: string
}

/** The framework profile that changes which requirements apply, for frameworks that have one. */
export function profileOf(frameworkId: string, scope: NativeAssessment["assessment"]["scope"]): string {
  if (frameworkId === "essential-eight") return `Maturity level ${scope.essentialEightMaturityLevel ?? 1}`
  if (frameworkId === "def-stan") return `Risk level ${scope.defStanRiskLevel ?? 1}`
  return "Default"
}

/** When the evidence of a comparison was collected, falling back to when it was generated. */
export function assessedAt(run: NativeAssessment): string {
  return run.assessment.provenance?.collectedAt ?? run.assessment.generatedAt
}

export function identityOf(run: NativeAssessment): AssessmentIdentity {
  const framework = run.assessment.frameworks[0]?.framework
  return {
    runId: run.runId,
    frameworkId: run.frameworkId,
    frameworkName: framework?.name ?? run.frameworkId,
    frameworkVersion: framework?.version ?? "unknown",
    rulesetVersion: run.assessment.provenance?.rulesetVersion ?? "unknown",
    rulesetSha256: run.rulesetSha256,
    snapshotSha256: run.snapshotSha256,
    profile: profileOf(run.frameworkId, run.assessment.scope ?? {}),
    platforms: [...(run.assessment.scope?.platforms ?? ["windows", "macos", "ios", "android", "tenant"])].sort(),
    assessedAt: assessedAt(run),
  }
}

/**
 * Whether two assessments may be connected as a trend or used to verify each other.
 * They must share framework, framework version, mapping ruleset (version and content hash),
 * profile and assessed platforms; otherwise a score change could come from the mapping or
 * scope instead of the tenant. Each difference is returned as a plain reason.
 */
export function compatibility(a: AssessmentIdentity, b: AssessmentIdentity): { compatible: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (a.frameworkId !== b.frameworkId) reasons.push("Different frameworks.")
  if (a.frameworkVersion !== b.frameworkVersion) reasons.push(`Framework version changed (${a.frameworkVersion} and ${b.frameworkVersion}).`)
  if (a.rulesetVersion !== b.rulesetVersion) reasons.push(`Mapping ruleset version changed (${a.rulesetVersion} and ${b.rulesetVersion}).`)
  else if (a.rulesetSha256 !== b.rulesetSha256) reasons.push("Mapping ruleset content changed with an app update.")
  if (a.profile !== b.profile) reasons.push(`Profile changed (${a.profile} and ${b.profile}).`)
  if (a.platforms.join(",") !== b.platforms.join(",")) reasons.push(`Assessed platforms changed (${a.platforms.join(", ")} and ${b.platforms.join(", ")}).`)
  if (a.selectionSha256 !== b.selectionSha256) reasons.push("Selected policies changed.")
  return { compatible: reasons.length === 0, reasons }
}

export interface TrendPoint {
  runId: string
  assessedAt: string
  score: number | null
  coverage: number | null
}

export interface IncompatibleRun extends TrendPoint {
  reasons: string[]
}

/**
 * Splits saved comparisons into the trend of the latest one and the runs that cannot be
 * connected to it. The trend is ordered oldest to newest; not-scored runs stay in it with a
 * null score so a gap in evidence is visible instead of being bridged.
 */
export function buildTrend(runs: NativeAssessment[]): { trend: TrendPoint[]; incompatible: IncompatibleRun[] } {
  return buildScoreTrend(runs.map((run) => ({ identity: identityOf(run), score: scoreRun(run) })))
}

/** Shared trend calculation for native comparisons and saved OIB validations. */
export function buildScoreTrend(samples: Array<{ identity: AssessmentIdentity; score: BaselineScore }>): { trend: TrendPoint[]; incompatible: IncompatibleRun[] } {
  const sorted = [...samples].sort((a, b) => Date.parse(b.identity.assessedAt) - Date.parse(a.identity.assessedAt))
  const latest = sorted[0]
  if (!latest) return { trend: [], incompatible: [] }
  const anchor = latest.identity
  const trend: TrendPoint[] = []
  const incompatible: IncompatibleRun[] = []
  for (const run of sorted) {
    const point = { runId: run.identity.runId, assessedAt: run.identity.assessedAt, score: run.score.score, coverage: run.score.coverage }
    const check = compatibility(anchor, run.identity)
    if (check.compatible) trend.push(point)
    else incompatible.push({ ...point, reasons: check.reasons })
  }
  return { trend: trend.reverse(), incompatible }
}

export interface Freshness {
  assessedAt: string
  ageDays: number | null
  stale: boolean
}

/** Age of a comparison; an unreadable date is stale, never fresh. */
export function freshness(run: NativeAssessment, now: Date): Freshness {
  return freshnessAt(assessedAt(run), now)
}

export function freshnessAt(at: string, now: Date): Freshness {
  const time = Date.parse(at)
  if (!Number.isFinite(time)) return { assessedAt: at, ageDays: null, stale: true }
  const ageDays = Math.max(0, Math.floor((now.getTime() - time) / 86_400_000))
  return { assessedAt: at, ageDays, stale: ageDays > STALE_AFTER_DAYS }
}

/** Collection families that were not fully read; any entry means the evidence is partial. */
export function incompleteCollection(run: NativeAssessment): string[] {
  return (run.assessment.collectionCoverage ?? []).filter((row) => row.status !== "complete").map((row) => `${row.family}: ${row.status}`)
}

export interface GapSetting {
  settingId: string
  result: "different" | "missing"
  expected: string
  observed: string | null
  policyId: string | null
  reason: string | null
}

export interface GapPolicy {
  policyId: string
  policyName: string
  assignment: "assigned" | "notAssigned" | "unknown"
}

export interface GapControl {
  id: string
  title: string
  evidenceStrength: "direct" | "supporting" | null
}

/**
 * An actionable gap: one framework capability with at least one evaluated setting that is
 * different or missing. `mixed` means another policy matches the same capability, which
 * needs a targeting review before anyone treats it as fixed or broken.
 */
export interface Gap {
  key: string
  capabilityId: string
  capabilityName: string
  platform: CompliancePlatform
  capabilityStatus: CapabilityStatus
  result: "different" | "missing"
  mixed: boolean
  settings: GapSetting[]
  settingIds: string[]
  policies: GapPolicy[]
  controls: GapControl[]
  unknownChecks: number
  limitations: string[]
}

const MAX_GAP_SETTINGS = 25

function isGapCheck(check: TechnicalCheck): check is TechnicalCheck & { result: "different" | "missing" } {
  return check.assessmentStatus === "checked" && (check.result === "different" || check.result === "missing")
}

/** Every actionable gap of a comparison, in the order the capabilities appear. */
export function collectGaps(run: NativeAssessment): Gap[] {
  const controls = run.assessment.frameworks[0]?.controls ?? []
  const gaps: Gap[] = []
  for (const result of run.assessment.capabilities) {
    const checks = Array.isArray(result.checks) ? result.checks : []
    const failing = checks.filter(isGapCheck)
    if (!failing.length) continue
    const policies = new Map<string, GapPolicy>()
    for (const check of failing) {
      if (check.policyId) policies.set(check.policyId, { policyId: check.policyId, policyName: check.policyName ?? "Unnamed policy", assignment: check.assignment?.state ?? "unknown" })
    }
    gaps.push({
      key: result.capability.id,
      capabilityId: result.capability.id,
      capabilityName: result.capability.name,
      platform: result.capability.platform,
      capabilityStatus: result.status,
      result: failing.some((check) => check.result === "different") ? "different" : "missing",
      mixed: checks.some((check) => check.assessmentStatus === "checked" && check.result === "matches"),
      settings: failing.slice(0, MAX_GAP_SETTINGS).map((check) => ({ settingId: check.settingId, result: check.result, expected: check.expectedValue, observed: check.actualValue, policyId: check.policyId ?? null, reason: check.reason ?? null })),
      settingIds: [...new Set(failing.map((check) => check.settingId))],
      policies: [...policies.values()],
      controls: controls.filter((control) => control.capabilityIds.includes(result.capability.id)).map((control) => ({ id: control.control.id, title: control.control.title, evidenceStrength: control.control.evidenceStrength ?? null })),
      unknownChecks: checks.filter((check) => check.assessmentStatus === "unableToCheck").length,
      limitations: Array.isArray(result.limitations) ? result.limitations.slice(0, 10) : [],
    })
  }
  return gaps
}

/**
 * How one capability looks in a comparison, for verifying a finding:
 * - gap: an evaluated setting is different or missing and none matches.
 * - mixed: some evaluated settings match and others do not.
 * - resolved: every check was evaluated and matches.
 * Unknown: some checks could not be evaluated and none fails, so nothing is proven.
 * - absent: the capability is not in the comparison or is outside its scope.
 */
export type GapObservation = "gap" | "mixed" | "resolved" | "unknown" | "absent"

export function observeCapability(run: NativeAssessment, capabilityId: string): GapObservation {
  const result = run.assessment.capabilities.find((item) => item.capability.id === capabilityId)
  const checks = result && Array.isArray(result.checks) ? result.checks.filter((check) => check.assessmentStatus !== "outsideScope") : []
  if (!checks.length) return "absent"
  const failing = checks.some(isGapCheck)
  const matching = checks.some((check) => check.assessmentStatus === "checked" && check.result === "matches")
  if (failing) return matching ? "mixed" : "gap"
  if (checks.some((check) => check.assessmentStatus !== "checked" || check.result === null)) return "unknown"
  return "resolved"
}
