import { csvCell } from "../../../shared/security"
import { redactSecrets, redactText } from "../../../shared/compliance/export"
import type { FrameworkScore } from "../scores/api"
import { CLASSIFICATION_LABELS, STATUS_LABELS, type Finding as HygieneFinding } from "../hygiene/api"
import type { Finding as HealthFinding } from "../health-review/api"
import type { AdoptionState } from "../standards/api"
import type { CisReadinessSummary } from "../../../shared/frameworks/cis-readiness"

/**
 * CSV and JSON exports for the governance tabs (scores, hygiene, health review and
 * standards), built only from the view models the tabs already show. Fields are picked
 * explicitly, so stored evidence, hashes, parameters and overlay values never leave in
 * an export, and every string passes the same redaction as the framework exports.
 */

export type GovernanceExportKind = "scores" | "hygiene" | "health" | "standards" | "cis-readiness"

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

// --------------------------------------------------------------------------- cis readiness

function cisReadinessRow(summary: CisReadinessSummary, level: CisReadinessSummary["levels"][number]) {
  return {
    benchmark: summary.benchmark,
    version: summary.version,
    level: level.level,
    state: "Assessed",
    assessedSettings: level.assessedSettings,
    present: level.present,
    different: level.different,
    missing: level.missing,
    review: level.review,
    passRate: level.passRate,
    excepted: level.excepted,
    adjustedPassRate: level.adjustedPassRate,
    exceptions: (level.exceptions ?? []).map(item => ({
      policyName: item.policyName, settingId: item.settingId, owner: item.owner, expiresOn: item.expiresOn, reason: item.reason,
    })),
    assessedAutomated: level.assessedAutomated,
    enumerated: level.enumerated,
    denominator: level.denominator,
    coverage: level.coverage,
    notAssessed: level.notAssessed,
    manualNote: summary.manualNote,
    manual: (level.manual ?? []).map(item => ({
      identifier: item.identifier, level: item.level, title: item.title ?? null, state: "Manual" as const,
      description: item.description ?? null, impact: item.impact ?? null, audit: item.audit ?? null, remediation: item.remediation ?? null,
      fallback: item.hasText ? null : summary.manualFallback, fallbackUrl: item.hasText ? null : summary.manualFallbackUrl,
    })),
  }
}

function cisManualRow(summary: CisReadinessSummary, level: CisReadinessSummary["levels"][number], item: NonNullable<CisReadinessSummary["levels"][number]["manual"]>[number]) {
  return {
    benchmark: summary.benchmark, version: summary.version, level: level.level, state: "Manual" as const,
    identifier: item.identifier, title: item.title ?? "",
    description: item.description ?? "", impact: item.impact ?? "", audit: item.audit ?? "", remediation: item.remediation ?? "",
    fallback: item.hasText ? "" : summary.manualFallback,
  }
}

const CIS_READINESS_HEADERS = ["Benchmark", "Version", "Level", "Assessed settings", "Present", "Different", "Missing", "Review", "Pass rate", "Assessed automated", "Enumerated", "Denominator", "Coverage", "Not assessed", "Note", "State", "Identifier", "Title", "Excepted", "Adjusted pass rate", "Exceptions"]

export function cisReadinessCsv(summary: CisReadinessSummary): string {
  const rows: unknown[][] = summary.levels.map((level) => {
    const row = cisReadinessRow(summary, level)
    const exceptionsText = row.exceptions.map(item => `${item.policyName} | ${item.settingId} | ${item.owner} | ${item.expiresOn} | ${item.reason}`).join("; ")
    return [row.benchmark, row.version, row.level, row.assessedSettings, row.present, row.different, row.missing, row.review, row.passRate ?? "", row.assessedAutomated ?? "", row.enumerated, row.denominator ?? "", row.coverage ?? "", row.notAssessed.join("; "), row.manualNote, row.state, "", "", row.excepted, row.adjustedPassRate ?? "", exceptionsText]
  })
  for (const level of summary.levels) {
    for (const item of level.manual ?? []) {
      const row = cisManualRow(summary, level, item)
      rows.push([row.benchmark, row.version, row.level, "", "", "", "", "", "", "", "", "", "", "", row.fallback, row.state, row.identifier, row.title, "", "", ""])
    }
  }
  // The CIS notice for recommendations this tool does not include, on every export.
  rows.push([summary.benchmark, summary.version, "", "", "", "", "", "", "", "", "", "", "", "", `${summary.manualFallback} ${summary.manualFallbackUrl}`, "Notice", "", "", "", "", ""])
  return toCsv([CIS_READINESS_HEADERS, ...rows])
}

export function cisReadinessJson(summary: CisReadinessSummary, tenantName: string | null, exportedAt: string): string {
  const manualItems = summary.levels.flatMap(level => (level.manual ?? []).map(item => cisManualRow(summary, level, item)))
  return toJson({ exportedAt, tenant: tenantName, benchmark: summary.benchmark, version: summary.version, manualNote: summary.manualNote, manualFallback: summary.manualFallback, manualFallbackUrl: summary.manualFallbackUrl, levels: summary.levels.map((level) => cisReadinessRow(summary, level)), manualItems })
}
