import { csvCell } from '../security'
import { frameworks } from '../frameworks/catalog'
import { UNSUPPORTED } from '../frameworks/coverage'
import type { Assessment, BaselinePolicy } from '../frameworks/policies'
import { comparisonCounts, FRAMEWORK_USAGE_NOTICE, type NativeAssessment } from './native'
import { COLLECTION_FAMILY_LABELS, COLLECTION_STATUS_LABELS, PLATFORM_LABELS, frameworkCoverageLabel } from './presentation'

/**
 * Framework report exports (PDF, CSV, JSON) built from a saved comparison or assessment.
 * Everything here is pure: exports never read the tenant again, so a saved result exports
 * exactly what was recorded. Values that could carry secrets are redacted on the way out.
 */

export const REDACTED = '[redacted]'

/** Stated in every framework export, so a file read on its own cannot be mistaken for more. */
export const EXPORT_LIMITATIONS = [
  'Independent TenuVault configuration comparison of the recorded Intune data. It is not an audit opinion, certification or complete framework assessment.',
  'A configuration match does not prove that a setting is assigned to the right devices or enforced on them. Device state and effective access were not collected.',
  'Results reflect the tenant at the collection date shown and were not collected again for this export.',
  'Secret values, tokens and credentials are redacted from this export.',
]

// Property names whose values are secrets. Matched on the whole name so settings such as
// passwordMinimumLength keep their values.
const SECRET_KEY = /^(?:.*secret.*|password|passphrase|pre-?shared-?key|shared-?key|psk|private-?key|api-?key|recovery-?key|.*credential.*|access_?token|refresh_?token|id_?token|token|.*valuetoken|client_?secret|certificate-?password)$/i
// Strings that look like bearer tokens or JWTs wherever they appear.
const SECRET_TEXT = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,})|(?:\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/g

/** Replaces token-like substrings in free text. */
export function redactText(value: string): string {
  return value.replace(SECRET_TEXT, REDACTED)
}

/**
 * A deep copy with secrets replaced: values under secret-named properties, the value of
 * Intune secret setting values (deviceManagementConfigurationSecretSettingValue) and
 * token-like strings. Structure and every other value stay as recorded.
 */
export function redactSecrets<T>(value: T): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return redactText(item)
    if (Array.isArray(item)) return item.map(visit)
    if (!item || typeof item !== 'object') return item
    const source = item as Record<string, unknown>
    const secretValue = typeof source['@odata.type'] === 'string' && /SecretSettingValue$/i.test(source['@odata.type'])
    return Object.fromEntries(Object.entries(source).map(([key, child]) => [key, (secretValue && key === 'value') || (SECRET_KEY.test(key) && child !== null && typeof child !== 'boolean') ? REDACTED : visit(child)]))
  }
  return visit(value) as T
}

/** Where a report is exported and for whom; the tenant name is a label only. */
export interface ExportContext {
  exportedAt: string
  tenantName?: string
}

/** A validated tenant label from untrusted input: a short single line, or undefined. */
export function tenantLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Control characters are intentionally removed from single-line tenant labels.
  // oxlint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text ? text.slice(0, 120) : undefined
}

export interface ReportHeader {
  kind: 'native-comparison' | 'policy-pack-assessment'
  tenant: { id: string; name?: string }
  framework: { id: string; name: string; version: string; profile: string }
  assessedScope: string
  collectedAt: string
  exportedAt: string
  runId: string
  supportedCoverage: string[]
  unknowns: string[]
  limitations: string[]
  notice: string
}

// Frameworks that left the catalog but whose saved assessments can still be exported.
const LEGACY_NAMES: Record<string, string> = { oib: 'OpenIntuneBaseline' }

function frameworkName(id: string): string {
  return frameworks.find(f => f.id === id)?.name ?? LEGACY_NAMES[id] ?? id
}

/** The identifying facts, coverage, unknowns and limits of a saved native comparison. */
export function nativeReportHeader(run: NativeAssessment, context: ExportContext): ReportHeader {
  const framework = run.assessment.frameworks[0]
  if (!framework) throw new Error('No framework comparison is available.')
  const scope = run.assessment.scope
  const counts = comparisonCounts(run)
  const profile = [
    `Mapping ${run.assessment.provenance.rulesetVersion}`,
    run.frameworkId === 'essential-eight' ? `maturity level ${scope.essentialEightMaturityLevel ?? 1}` : '',
    run.frameworkId === 'def-stan' ? `risk level ${scope.defStanRiskLevel ?? 1}` : '',
  ].filter(Boolean).join(', ')
  const gaps = run.assessment.collectionCoverage.filter(f => f.status !== 'complete' || f.errors.length)
  return {
    kind: 'native-comparison',
    tenant: { id: run.tenantId, ...(context.tenantName ? { name: context.tenantName } : {}) },
    framework: { id: run.frameworkId, name: framework.framework.name, version: framework.framework.version, profile },
    assessedScope: `Platforms: ${(scope.platforms ?? []).map(p => PLATFORM_LABELS[p] ?? p).join(', ') || 'all supported platforms'}. Selected Intune configuration and optional Conditional Access policies only.`,
    collectedAt: run.assessment.provenance.collectedAt ?? run.assessment.generatedAt,
    exportedAt: context.exportedAt,
    runId: run.runId,
    supportedCoverage: [
      frameworkCoverageLabel(framework) ?? `${framework.controls.length} selected technical references. This subset is not the complete framework.`,
      `${counts.matches} matches, ${counts.different} different, ${counts.missing} missing setting observations.`,
    ],
    unknowns: [
      `${counts.unableToCheck} observations or references could not be checked; ${counts.outsideScope} are outside the selected scope.`,
      ...gaps.map(f => `${COLLECTION_FAMILY_LABELS[f.family] ?? f.family}: ${COLLECTION_STATUS_LABELS[f.status] ?? f.status}${f.errors.length ? ` (${f.errors.map(redactText).join(' ')})` : ''}`),
      'Group membership, filter evaluation and device enforcement are unverified.',
    ],
    limitations: [...EXPORT_LIMITATIONS, ...(framework.framework.note ? [framework.framework.note] : [])],
    notice: [FRAMEWORK_USAGE_NOTICE, run.licenseNotice].filter(Boolean).join(' '),
  }
}

/** JSON export of a saved native comparison: the report header and the redacted recorded result. */
export function nativeExportJSON(run: NativeAssessment, context: ExportContext): string {
  return JSON.stringify({ report: nativeReportHeader(run, context), result: redactSecrets(run) }, null, 2)
}

function headerRows(header: ReportHeader): unknown[][] {
  return [
    ['Report', header.kind === 'native-comparison' ? 'TenuVault independent configuration comparison' : 'TenuVault policy pack assessment'],
    ['Tenant', header.tenant.name ? `${header.tenant.name} (${header.tenant.id})` : header.tenant.id],
    ['Framework', `${header.framework.name} ${header.framework.version}`.trim()],
    ['Profile', header.framework.profile],
    ['Assessed scope', header.assessedScope],
    ['Collected', header.collectedAt],
    ['Exported', header.exportedAt],
    ['Run', header.runId],
    ...header.supportedCoverage.map(line => ['Supported coverage', line]),
    ...header.unknowns.map(line => ['Unknown', line]),
    ...header.limitations.map(line => ['Limitation', line]),
    ['Notice', header.notice],
    [],
  ]
}

const toCSV = (rows: unknown[][]) => rows.map(row => row.map(cell => csvCell(typeof cell === 'string' ? redactText(cell) : cell)).join(',')).join('\r\n')

/** CSV export of a saved native comparison: header rows, then one row per setting observation. */
export function nativeExportCSV(run: NativeAssessment, context: ExportContext): string {
  const rows: unknown[][] = [...headerRows(nativeReportHeader(run, context)),
    ['Capability', 'Platform', 'Setting', 'Status', 'Expected', 'Observed', 'Policy ID', 'Policy name', 'Assignment', 'Reason']]
  for (const cap of run.assessment.capabilities) for (const check of cap.checks) {
    rows.push([cap.capability.name, cap.capability.platform, check.settingId, check.assessmentStatus === 'checked' ? check.result ?? 'unableToCheck' : check.assessmentStatus,
      check.expectedValue, check.actualValue ?? 'Not available', check.policyId, check.policyName, check.assignment?.state ?? 'unknown', check.reason])
  }
  for (const control of run.assessment.frameworks[0]?.controls ?? []) if (control.unavailableCheck) {
    rows.push([control.control.title, '', control.control.id, control.unavailableCheck.assessmentStatus, '', 'Not available', '', '', '', control.unavailableCheck.reason ?? 'No supported detector.'])
  }
  return toCSV(rows)
}

/** A saved policy pack assessment as stored in the framework workspace. */
export interface SavedAssessment {
  assessment: Assessment
  policies: BaselinePolicy[]
  creation?: { success: boolean; results: { name: string; id?: string; error?: string }[] }
}

/** The identifying facts, coverage, unknowns and limits of a saved policy pack assessment. */
export function workspaceReportHeader(saved: SavedAssessment, context: ExportContext): ReportHeader {
  const { assessment } = saved
  const count = (status: string) => assessment.findings.filter(f => f.status === status).length
  const unavailable = assessment.findings.filter(f => f.observed.some(o => o.targeting?.state === 'unavailable')).length
  return {
    kind: 'policy-pack-assessment',
    tenant: { id: assessment.tenantId, ...(context.tenantName ? { name: context.tenantName } : {}) },
    framework: { id: assessment.frameworkId, name: frameworkName(assessment.frameworkId), version: '', profile: assessment.reference },
    assessedScope: `Settings Catalog policies of the tenant (${assessment.policyCount} read) compared with ${saved.policies.length} pack policies and their root settings.`,
    collectedAt: assessment.assessedAt,
    exportedAt: context.exportedAt,
    runId: assessment.runId,
    supportedCoverage: [
      'Settings Catalog root settings and their nested values; assignment targets, exclusions and filter references reported separately.',
      `${count('Present')} present, ${count('Missing')} missing, ${count('Different')} different, ${count('Review')} to review.`,
    ],
    unknowns: [
      `${count('Review')} findings need review because the pack holds alternative values.`,
      `${unavailable} findings have assignment evidence that could not be read.`,
      `Not assessed: ${UNSUPPORTED.join('; ')}.`,
      assessment.organizationalEvidence?.note ?? 'Organizational evidence requires a separate assessment.',
    ],
    limitations: [...EXPORT_LIMITATIONS, '"Present" means a matching configuration exists; it does not mean the setting is assigned or enforced.'],
    notice: ['Framework names are factual references. No publisher affiliation, endorsement or certification is implied. The source version and profile are as entered by the administrator.',
      frameworks.find(f => f.id === assessment.frameworkId)?.licenseNotice].filter(Boolean).join(' '),
  }
}

/** JSON export of a saved policy pack assessment, redacted. */
export function workspaceExportJSON(saved: SavedAssessment, context: ExportContext): string {
  return JSON.stringify({ report: workspaceReportHeader(saved, context), result: redactSecrets(saved) }, null, 2)
}

/** JSON export of every saved assessment of a workspace, each with its own report header. */
export function workspaceHistoryJSON(history: SavedAssessment[], context: ExportContext): string {
  return JSON.stringify({ exportedAt: context.exportedAt, limitations: EXPORT_LIMITATIONS,
    assessments: history.map(saved => ({ report: workspaceReportHeader(saved, context), result: redactSecrets(saved) })) }, null, 2)
}

/** CSV export of a saved policy pack assessment: header rows, then one row per finding. */
export function workspaceExportCSV(saved: SavedAssessment, context: ExportContext): string {
  const rows: unknown[][] = [...headerRows(workspaceReportHeader(saved, context)),
    ['Pack policy', 'Setting', 'Status', 'Recommended', 'Observed policies', 'Observed values', 'Assignment evidence']]
  for (const finding of redactSecrets(saved.assessment.findings)) {
    rows.push([finding.policyName, finding.settingId, finding.status, JSON.stringify(finding.recommended),
      finding.observed.map(o => `${o.policyName} (${o.policyId})`).join('; ') || 'None',
      finding.observed.map(o => JSON.stringify(o.value)).join('; '),
      finding.observed.map(o => o.targeting?.state ?? 'unknown').join('; ') || 'unknown'])
  }
  return toCSV(rows)
}
