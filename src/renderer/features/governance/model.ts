import type { FrameworkScore } from "../scores/api"
import type { Finding, Scan } from "../hygiene/api"
import type { Adoption, AdoptionState, Customization } from "../standards/api"

/**
 * Pure view models of the Governance hub: the overview summary and the accepted
 * deviations register. Both are built only from what the scores, hygiene and standards
 * screens already show; nothing is read live and no number is invented for missing
 * evidence (a tenant with no saved comparison has no score, never zero).
 */

export interface GovernanceSummary {
  latestScore: { frameworkName: string; score: number | null; coverage: number | null; gapCount: number; assessedAt: string; stale: boolean } | null
  staleScores: number
  totalGaps: number
  openDefinite: number
  openPossible: number
  /** Open deprecated-setting findings: distinct settings, affected policies, latest catalog check. */
  deprecatedSettings: { settings: number; policies: number; catalogCheckedAt: string | null }
  reviewedFindings: number
  latestScanAt: string | null
  latestScanBackup: string | null
  activeCustomizations: number
  expiredCustomizations: number
  pendingUpgrades: number
  standardDeviations: number
  /** Adoptions whose deviation was never assessed, so a zero above must not read as clean. */
  unassessedAdoptions: number
  standardsAssessedAt: string | null
}

/** Open deprecated-setting findings as settings and affected policies, dated by the newest checked catalog. */
function deprecatedOf(findings: Finding[], scans: Scan[]): GovernanceSummary["deprecatedSettings"] {
  const open = findings.filter((finding) => finding.status === "open" && finding.ruleId === "deprecated-setting")
  const policies = new Set(open.flatMap((finding) => (finding.policies ?? []).map((policy) => `${policy.folder}/${policy.id}`)))
  const checked = scans.find((scan) => scan.catalog?.state === "checked")
  return { settings: open.length, policies: policies.size, catalogCheckedAt: checked?.catalog?.checkedAt ?? null }
}

export function summarizeGovernance(input: {
  frameworks: FrameworkScore[]
  findings: Finding[]
  scans: Scan[]
  customizations: Customization[]
  adoptions: Array<Adoption & { state: AdoptionState }>
  now?: Date
}): GovernanceSummary {
  const assessed = input.frameworks.filter((framework) => framework.latest).sort((a, b) => Date.parse(b.latest!.freshness.assessedAt) - Date.parse(a.latest!.freshness.assessedAt))
  const newest = assessed[0]?.latest ?? null
  const now = input.now ?? new Date()
  const assessedDates = input.adoptions.map((adoption) => adoption.state.assessedAt).filter((value): value is string => !!value).sort()
  return {
    latestScore: newest ? { frameworkName: assessed[0]!.frameworkName, score: newest.score.score, coverage: newest.score.coverage, gapCount: newest.gapCount, assessedAt: newest.freshness.assessedAt, stale: newest.freshness.stale } : null,
    staleScores: assessed.filter((framework) => framework.latest!.freshness.stale).length,
    totalGaps: assessed.reduce((sum, framework) => sum + framework.latest!.gapCount, 0),
    openDefinite: input.findings.filter((finding) => finding.status === "open" && finding.classification === "definite").length,
    openPossible: input.findings.filter((finding) => finding.status === "open" && finding.classification === "possible").length,
    deprecatedSettings: deprecatedOf(input.findings, input.scans),
    reviewedFindings: input.findings.filter((finding) => finding.status === "acknowledged" || finding.status === "false-positive").length,
    latestScanAt: input.scans[0]?.collectedAt ?? null,
    latestScanBackup: input.scans[0]?.backupId ?? null,
    activeCustomizations: input.customizations.filter((record) => record.status === "active").length,
    expiredCustomizations: input.customizations.filter((record) => record.status === "active" && record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()).length,
    pendingUpgrades: input.adoptions.filter((adoption) => adoption.state.pendingUpgrade).length,
    standardDeviations: input.adoptions.reduce((sum, adoption) => sum + (adoption.state.deviations ?? 0), 0),
    unassessedAdoptions: input.adoptions.filter((adoption) => adoption.state.deviations === null).length,
    standardsAssessedAt: assessedDates.at(-1) ?? null,
  }
}

export type DeviationKind = "customization" | "hygiene-review" | "standard-exception"

export interface DeviationEntry {
  id: string
  kind: DeviationKind
  title: string
  settingKey: string | null
  policyName: string | null
  owner: string | null
  reason: string
  status: string
  decidedAt: string | null
  evidenceAt: string | null
  expiresAt: string | null
  expired: boolean
  link: string
}

const KIND_LABELS: Record<DeviationKind, string> = { customization: "Customization", "hygiene-review": "Hygiene review", "standard-exception": "Standard exception" }
export const deviationKindLabel = (kind: DeviationKind): string => KIND_LABELS[kind]

/**
 * Every accepted deviation of the tenant in one register: documented customizations,
 * acknowledged and false positive hygiene findings, and approved standard overlay
 * exceptions. Retired customizations and revoked exceptions are no longer accepted
 * and stay out. Expired entries sort first, then by expiry, so re-review is obvious.
 */
export function buildDeviations(input: {
  customizations: Customization[]
  findings: Finding[]
  adoptions: Array<Adoption & { state?: AdoptionState }>
  now?: Date
}): DeviationEntry[] {
  const now = (input.now ?? new Date()).getTime()
  const expired = (expiresAt: string | null) => expiresAt !== null && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= now
  const entries: DeviationEntry[] = []

  for (const record of input.customizations) {
    if (record.status !== "active") continue
    const expiresAt = record.expiresAt ?? null
    entries.push({ id: `customization:${record.id}`, kind: "customization", title: record.title, settingKey: record.settingKey, policyName: record.policyName, owner: record.owner, reason: record.reason, status: record.status, decidedAt: record.updatedAt, evidenceAt: null, expiresAt, expired: expired(expiresAt), link: "/portal/governance/customizations" })
  }
  for (const finding of input.findings) {
    if (finding.status !== "acknowledged" && finding.status !== "false-positive") continue
    entries.push({ id: `hygiene:${finding.id}`, kind: "hygiene-review", title: finding.title, settingKey: finding.settings[0]?.definitionId ?? null, policyName: finding.policies[0]?.name ?? null, owner: finding.review?.by ?? null, reason: finding.review?.note || (finding.status === "false-positive" ? "Marked as false positive" : "Acknowledged"), status: finding.status, decidedAt: finding.review?.at ?? null, evidenceAt: finding.collectedAt, expiresAt: null, expired: false, link: "/portal/governance/hygiene" })
  }
  for (const adoption of input.adoptions) {
    for (const exception of adoption.overlay?.exceptions ?? []) {
      if (exception.status !== "approved") continue
      entries.push({ id: `standard:${adoption.id}:${exception.policyKey}:${exception.settingDefinitionId}`, kind: "standard-exception", title: `${adoption.title}: ${exception.settingDefinitionId}`, settingKey: exception.settingDefinitionId, policyName: exception.policyKey, owner: exception.approver, reason: exception.reason, status: exception.status, decidedAt: null, evidenceAt: adoption.state?.assessedAt ?? null, expiresAt: exception.expiresAt, expired: expired(exception.expiresAt), link: "/portal/governance/standards" })
    }
  }
  return entries.sort((a, b) => Number(b.expired) - Number(a.expired) || (a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY) - (b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY) || a.title.localeCompare(b.title))
}
