import { csvCell } from "../../../shared/security"
import { redactSecrets, redactText } from "../../../shared/compliance/export"
import type { FrameworkScore } from "../scores/api"
import { CLASSIFICATION_LABELS, STATUS_LABELS, type Finding as HygieneFinding } from "../hygiene/api"
import type { Finding as HealthFinding } from "../health-review/api"
import type { AdoptionState } from "../standards/api"

/**
 * CSV and JSON exports for the governance tabs (scores, hygiene, health review and
 * standards), built only from the view models the tabs already show. Fields are picked
 * explicitly, so stored evidence, hashes, parameters and overlay values never leave in
 * an export, and every string passes the same redaction as the framework exports.
 */

export type GovernanceExportKind = "scores" | "hygiene" | "health" | "standards"

/** "scores-contoso-2026-10-13", without an extension, following driftExportName. */
export function governanceExportName(kind: GovernanceExportKind, tenantName: string | null | undefined, exportedAt: string): string {
  const slug = (tenantName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  const day = exportedAt.slice(0, 10)
  return [kind, slug, day].filter(Boolean).join("-")
}

const toCsv = (rows: unknown[][]): string =>
  rows.map((row) => row.map((cell) => csvCell(typeof cell === "string" ? redactText(cell) : cell)).join(",")).join("\r\n")

const toJson = (value: unknown): string => JSON.stringify(redactSecrets(value), null, 2)

const PLATFORM_LABELS: Record<string, string> = { windows: "Windows", macos: "macOS", ios: "iOS", android: "Android", tenant: "Conditional Access" }

// --------------------------------------------------------------------------- scores

function scoreRow(framework: FrameworkScore) {
  const latest = framework.latest
  if (!latest) {
    return {
      framework: framework.frameworkName,
      frameworkId: framework.frameworkId,
      version: null,
      profile: null,
      mapping: null,
      state: framework.state,
      score: null,
      coverage: null,
      matching: null,
      different: null,
      missing: null,
      unknown: null,
      outsideScope: null,
      gaps: null,
      assessedAt: null,
      ageDays: null,
      stale: null,
      partialCollection: null,
      scope: null,
      topGaps: [] as string[],
      message: framework.message,
    }
  }
  const { identity, freshness, score } = latest
  return {
    framework: identity.frameworkName || framework.frameworkName,
    frameworkId: framework.frameworkId,
    version: identity.frameworkVersion,
    profile: identity.profile,
    mapping: identity.rulesetVersion,
    state: framework.state,
    score: score.score,
    coverage: score.coverage,
    matching: score.counts.matching,
    different: score.counts.different,
    missing: score.counts.missing,
    unknown: score.counts.unknown,
    outsideScope: score.counts.outsideScope,
    gaps: latest.gapCount,
    assessedAt: freshness.assessedAt,
    ageDays: freshness.ageDays,
    stale: freshness.stale,
    partialCollection: latest.incompleteCollection.join("; "),
    scope: identity.platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform).join(", "),
    topGaps: latest.topGaps.map((gap) => `${gap.capabilityName} (${gap.result === "different" ? "different value" : "missing"}, ${gap.ranking.level})`),
    message: framework.message,
  }
}

const SCORE_HEADERS = ["Framework", "Version", "Profile", "Mapping", "State", "Score (%)", "Coverage (%)", "Matching", "Different", "Missing", "Unknown", "Outside scope", "Gaps", "Assessed", "Age (days)", "Stale", "Partial collection", "Scope", "Top gaps", "Message"]

export function scoresCsv(frameworks: FrameworkScore[]): string {
  const rows = frameworks.map((framework) => {
    const row = scoreRow(framework)
    return [row.framework, row.version ?? "", row.profile ?? "", row.mapping ?? "", row.state, row.score ?? "", row.coverage ?? "", row.matching ?? "", row.different ?? "", row.missing ?? "", row.unknown ?? "", row.outsideScope ?? "", row.gaps ?? "", row.assessedAt ?? "", row.ageDays ?? "", row.stale === null ? "" : row.stale ? "yes" : "no", row.partialCollection ?? "", row.scope ?? "", row.topGaps.join("; "), row.message ?? ""]
  })
  return toCsv([SCORE_HEADERS, ...rows])
}

export function scoresJson(frameworks: FrameworkScore[], tenantName: string | null, exportedAt: string): string {
  return toJson({ exportedAt, tenant: tenantName, frameworks: frameworks.map(scoreRow) })
}

// --------------------------------------------------------------------------- hygiene

function hygieneRow(finding: HygieneFinding, ruleName: (id: string) => string) {
  return {
    finding: finding.title,
    id: finding.id,
    rule: ruleName(finding.ruleId),
    ruleId: finding.ruleId,
    classification: CLASSIFICATION_LABELS[finding.classification],
    severity: finding.severity,
    status: STATUS_LABELS[finding.status],
    policies: finding.policies.map((policy) => `${policy.name} (${policy.folder})`),
    collectedAt: finding.collectedAt,
    firstSeenAt: finding.firstSeenAt,
    lastSeenAt: finding.lastSeenAt,
  }
}

const HYGIENE_HEADERS = ["Finding", "Rule", "Classification", "Severity", "Status", "Policies", "Collected", "First seen", "Last seen", "Finding ID"]

export function hygieneCsv(findings: HygieneFinding[], ruleName: (id: string) => string): string {
  const rows = findings.map((finding) => {
    const row = hygieneRow(finding, ruleName)
    return [row.finding, row.rule, row.classification, row.severity, row.status, row.policies.join("; "), row.collectedAt, row.firstSeenAt, row.lastSeenAt, row.id]
  })
  return toCsv([HYGIENE_HEADERS, ...rows])
}

export function hygieneJson(findings: HygieneFinding[], ruleName: (id: string) => string, tenantName: string | null, exportedAt: string): string {
  return toJson({ exportedAt, tenant: tenantName, findings: findings.map((finding) => hygieneRow(finding, ruleName)) })
}

// --------------------------------------------------------------------------- health

function healthRow(finding: HealthFinding) {
  return {
    finding: finding.title,
    id: finding.id,
    check: finding.check,
    severity: finding.severity,
    state: finding.state,
    reason: finding.reason,
    owner: finding.owner,
    acknowledgedBy: finding.acknowledgedBy,
    acknowledgedAt: finding.acknowledgedAt,
    occurrences: finding.occurrence,
    firstSeenAt: finding.firstSeenAt,
    lastSeenAt: finding.lastSeenAt,
    observedAt: finding.observedAt,
    resolvedAt: finding.resolvedAt,
  }
}

const HEALTH_HEADERS = ["Finding", "Check", "Severity", "State", "Reason", "Owner", "Acknowledged by", "Acknowledged at", "Occurrences", "First seen", "Last checked", "Evidence read", "Resolved at", "Finding ID"]

export function healthCsv(findings: HealthFinding[]): string {
  const rows = findings.map((finding) => {
    const row = healthRow(finding)
    return [row.finding, row.check, row.severity, row.state, row.reason, row.owner ?? "", row.acknowledgedBy ?? "", row.acknowledgedAt ?? "", row.occurrences, row.firstSeenAt, row.lastSeenAt, row.observedAt ?? "", row.resolvedAt ?? "", row.id]
  })
  return toCsv([HEALTH_HEADERS, ...rows])
}

export function healthJson(findings: HealthFinding[], tenantName: string | null, exportedAt: string): string {
  return toJson({ exportedAt, tenant: tenantName, findings: findings.map(healthRow) })
}

// --------------------------------------------------------------------------- standards

function standardRow(state: AdoptionState) {
  return {
    standard: state.title,
    standardKey: state.standardKey,
    status: state.status,
    adoptedVersion: state.adoptedVersion,
    configuredVersion: state.configuredVersion,
    latestVersion: state.latestVersion,
    upgradePending: state.pendingUpgrade,
    deviations: state.deviations,
    unknownPolicies: state.unknownPolicies,
    assessedAt: state.assessedAt,
    freshness: state.freshness,
  }
}

const STANDARD_HEADERS = ["Standard", "Standard key", "Status", "Adopted version", "Configured version", "Latest version", "Upgrade pending", "Deviations", "Unknown policies", "Assessed", "Freshness"]

export function standardsCsv(states: AdoptionState[]): string {
  const rows = states.map((state) => {
    const row = standardRow(state)
    return [row.standard, row.standardKey, row.status, row.adoptedVersion ?? "", row.configuredVersion, row.latestVersion ?? "", row.upgradePending ? "yes" : "no", row.deviations ?? "", row.unknownPolicies ?? "", row.assessedAt ?? "", row.freshness]
  })
  return toCsv([STANDARD_HEADERS, ...rows])
}

export function standardsJson(states: AdoptionState[], tenantName: string | null, exportedAt: string): string {
  return toJson({ exportedAt, tenant: tenantName, adoptions: states.map(standardRow) })
}
