import { jsPDF } from 'jspdf'
import { CAPABILITY_STATUS_LABELS, CHECK_RESULT_COLORS, CHECK_RESULT_LABELS, COLLECTION_FAMILY_LABELS, COLLECTION_STATUS_LABELS, CONTROL_STATUS_LABELS, PLATFORM_LABELS, formatReportDate, frameworkCoverageLabel } from './presentation'
import { comparisonCounts, type NativeAssessment } from './native'
import { nativeReportHeader, redactSecrets, redactText, workspaceReportHeader, type ExportContext, type ReportHeader, type SavedAssessment } from './export'
import { displayCheckValue } from './check-results'
import rights from './rights.json'

type Report = ReturnType<typeof createReport>

/** A jsPDF A4 document with the text helpers every TenuVault report uses. */
function createReport() {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const width = 178
  const state = { y: 24 }
  const ascii = (value: string) => value.replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2026/g, '...')
  function text(value: string, size = 9, bold = false) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(size)
    const lines = doc.splitTextToSize(ascii(redactText(value)), width) as string[]
    const height = size * 0.45 + 1
    for (const line of lines) {
      if (state.y + height > 273) { doc.addPage(); state.y = 24 }
      doc.text(line, 16, state.y)
      state.y += height
    }
    state.y += 2
  }
  function heading(value: string) { if (state.y + 22 > 273) { doc.addPage(); state.y = 24 }; state.y += 4; text(value, 13, true) }
  function section(value: string) { doc.addPage(); state.y = 24; heading(value) }
  /** Tenant, framework, profile, scope, dates, coverage, unknowns and limitations of the report. */
  function facts(header: ReportHeader) {
    text(`Tenant: ${header.tenant.name ? `${header.tenant.name} (${header.tenant.id})` : header.tenant.id}`)
    text(`Profile: ${header.framework.profile || 'Not recorded'}\nCollected: ${formatReportDate(header.collectedAt)}\nExported: ${formatReportDate(header.exportedAt)}\nReport: ${header.runId}`)
    text(`Assessed scope: ${header.assessedScope}`)
    heading('Supported coverage')
    for (const line of header.supportedCoverage) text(line)
    heading('Unknowns')
    for (const line of header.unknowns) text(line)
    heading('Limitations')
    for (const line of header.limitations) text(line)
    text(header.notice)
  }
  function finish(footer: string) {
    const pages = doc.getNumberOfPages()
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(100)
      doc.text(`TenuVault | ${footer}`, 16, 286)
      doc.text(`${i} / ${pages}`, 194, 286, { align: 'right' })
    }
    return new Uint8Array(doc.output('arraybuffer'))
  }
  return { doc, width, state, text, heading, section, facts, finish }
}

/** Local report of the stored comparison. Export never re-reads or re-evaluates the tenant. */
export function generateNativeFrameworkPDF(run: NativeAssessment, context: ExportContext = { exportedAt: new Date().toISOString() }): Uint8Array<ArrayBuffer> {
  const framework = run.assessment.frameworks[0]
  if (!framework) throw new Error('No framework comparison is available.')
  const report: Report = createReport()
  const { doc, width, state, text, heading, section } = report
  const counts = comparisonCounts(run)
  /** One tile per outcome: the count in the outcome's color above its label. */
  function summaryTiles() {
    const keys = Object.keys(CHECK_RESULT_LABELS) as (keyof typeof CHECK_RESULT_LABELS)[]
    const gap = 3, tile = (width - gap * (keys.length - 1)) / keys.length
    if (state.y + 22 > 273) { doc.addPage(); state.y = 24 }
    const y = state.y
    keys.forEach((key, i) => {
      const x = 16 + i * (tile + gap)
      doc.setFillColor(244, 243, 241); doc.roundedRect(x, y, tile, 18, 2, 2, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...(counts[key] ? CHECK_RESULT_COLORS[key] : [163, 158, 152] as [number, number, number]))
      doc.text(String(counts[key]), x + 4, y + 8)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60)
      doc.text(CHECK_RESULT_LABELS[key], x + 4, y + 14)
    })
    doc.setTextColor(0)
    state.y += 24
  }
  doc.setProperties({ title: `${framework.framework.name} configuration comparison`, author: 'TenuVault', subject: 'Independent Intune technical evidence mapping', keywords: 'Intune, configuration, evidence, comparison' })
  text('TenuVault', 20, true)
  text('Independent configuration comparison', 15, true)
  text(`${framework.framework.name} | ${framework.framework.version}`, 13)
  report.facts(nativeReportHeader(run, context))
  text(`Compared: ${formatReportDate(run.assessment.generatedAt)}\nMapping version: ${run.assessment.provenance.rulesetVersion}`)
  heading('Scope and comparison summary')
  text(`Platforms: ${run.assessment.scope.platforms?.map(p => PLATFORM_LABELS[p] ?? p).join(', ') ?? 'All supported platforms'}`)
  if (run.frameworkId === 'essential-eight') text(`Essential Eight target maturity: ${run.assessment.scope.essentialEightMaturityLevel ?? 1}`)
  if (run.frameworkId === 'def-stan') text(`Def Stan target risk level: ${run.assessment.scope.defStanRiskLevel ?? 1}`)
  summaryTiles()
  if (framework.framework.note) text(framework.framework.note)
  text(frameworkCoverageLabel(framework) ?? `${framework.controls.length} selected technical references. This subset is not the complete framework.`)
  text('Counts cover capabilities once, using the best assigned policy evidence. Unassigned policies cannot count as matches. Individual setting observations follow. Assignment scope, group membership, exclusions, filters, actual device state and effective access must be reviewed separately.')
  section('Collection completeness')
  for (const family of run.assessment.collectionCoverage) {
    text(`${COLLECTION_FAMILY_LABELS[family.family] ?? family.family}: ${COLLECTION_STATUS_LABELS[family.status] ?? family.status}, ${family.collectedPolicies} policies, ${family.recognizedPolicies} recognized`, 10, true)
    for (const error of family.errors) text(error)
  }
  section('Framework references and evidence')
  const capabilities = new Map(run.assessment.capabilities.map(c => [c.capability.id, c]))
  for (const row of framework.controls) {
    heading(`${row.control.id} | ${row.control.title}`)
    text(CONTROL_STATUS_LABELS[row.status], 10, true)
    text(row.control.summary)
    for (const limitation of row.unassessedAspects) text(`Outside this comparison: ${limitation}`)
    if (row.unavailableCheck) text(`Unable to check: ${row.unavailableCheck.reason ?? 'No supported detector.'}`)
    for (const id of row.capabilityIds) {
      const cap = capabilities.get(id)
      if (cap) text(`${cap.capability.name}: ${CAPABILITY_STATUS_LABELS[cap.status]}`)
    }
  }
  section('Setting-by-setting comparison')
  for (const cap of run.assessment.capabilities) {
    heading(`${cap.capability.name} (${PLATFORM_LABELS[cap.capability.platform] ?? cap.capability.platform})`)
    text(`${CAPABILITY_STATUS_LABELS[cap.status]}\n${cap.capability.description}`)
    for (const check of cap.checks) {
      const status = check.assessmentStatus === 'checked' ? check.result ?? 'unableToCheck' : check.assessmentStatus
      text(`${CHECK_RESULT_LABELS[status]} | ${check.settingId}`, 9, true)
      text(`Expected: ${displayCheckValue(check.expectedValue)}\nObserved: ${check.actualValue === null ? 'Not available' : displayCheckValue(check.actualValue)}`)
      if (check.policyId) text(`Policy: ${check.policyName ?? check.policyId}\nPolicy ID: ${check.policyId}`)
      if (check.assignment) text(`Assignment: ${check.assignment.state}\nTargets: ${check.assignment.targets.join('; ') || 'None'}\nExclusions: ${check.assignment.exclusions.join('; ') || 'None'}\nFilters: ${JSON.stringify(check.assignment.filters)}`)
      if (check.reason) text(check.reason)
    }
    for (const limitation of cap.limitations) text(limitation)
    for (const evidence of cap.evidence) if (evidence.policyModifiedAt || evidence.policyVersion) text(`Source metadata: ${evidence.policyName}, version ${evidence.policyVersion ?? 'not supplied'}, modified ${evidence.policyModifiedAt ?? 'not supplied'}`)
  }
  section('Provenance and attribution')
  text(`Framework source: ${framework.framework.source?.url ?? 'Not supplied'}\nSource mapping verified: ${framework.framework.source?.verifiedAt ?? 'Unknown'}\nDetector port: IntuneDocumentation ${run.sourceCommit}\nSnapshot SHA-256: ${run.snapshotSha256}\nRuleset SHA-256: ${run.rulesetSha256}`)
  text('Hashes identify the collected snapshot and mapped ruleset. They do not certify tenant security, prove authenticity or show that configurations were enforced.')
  text('Framework detector code adapted from IntuneDocumentation, Ugur Koc and contributors, under Elastic License 2.0. Adapted on 30 September 2026 for TenuVault desktop collection, original restricted-framework descriptions and stored-comparison reports. The accompanying framework-NOTICES.txt contains the license and publisher attribution.')
  const provider = rights.providers.find(p => p.id === framework.framework.id)
  text(`Publisher content basis: ${provider?.sourceContentLicense ?? 'Original independent mapping'}`)
  if (run.frameworkId === 'essential-eight') text('Australian Signals Directorate, © Commonwealth of Australia 2026. Selected November 2023 model entries adapted for Intune comparisons. Creative Commons Attribution 4.0: https://creativecommons.org/licenses/by/4.0/ . Changes: technical evidence mapping, scope selection and desktop reporting. No endorsement.')
  if (run.frameworkId === 'cyber-essentials') text('Contains public sector information from NCSC licensed under the Open Government Licence v3.0: https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/ . Crown copyright. Adapted technical mapping; no certification or endorsement.')
  if (run.frameworkId.startsWith('nist-')) text('Derived from NIST-authored technical series publications with selected Intune mappings and summaries added or modified. Third-party material excluded. Provided AS IS, without NIST warranty or endorsement. Worldwide royalty-free reuse terms and attribution: https://www.nist.gov/open/license .')
  return report.finish('Independent configuration comparison')
}

/**
 * Local report of a saved policy pack assessment. Export never re-reads the tenant; observed
 * values are redacted before they are printed.
 */
export function generateWorkspaceAssessmentPDF(saved: SavedAssessment, context: ExportContext): Uint8Array<ArrayBuffer> {
  const header = workspaceReportHeader(saved, context)
  const report = createReport()
  const { doc, text, heading, section } = report
  doc.setProperties({ title: `${header.framework.name} policy pack assessment`, author: 'TenuVault', subject: 'Intune policy pack comparison', keywords: 'Intune, configuration, baseline, comparison' })
  text('TenuVault', 20, true)
  text('Policy pack assessment', 15, true)
  text(header.framework.name, 13)
  report.facts(header)
  section('Findings')
  const findings = redactSecrets(saved.assessment.findings)
  for (const status of ['Missing', 'Different', 'Review', 'Present'] as const) {
    const rows = findings.filter(f => f.status === status)
    if (!rows.length) continue
    heading(`${status} (${rows.length})`)
    for (const finding of rows) {
      text(`${finding.policyName} | ${finding.settingId}`, 9, true)
      text(`Observed in: ${finding.observed.map(o => `${o.policyName} (assignment evidence: ${o.targeting?.state ?? 'unknown'})`).join('; ') || 'No matching root setting in the assessed policy family.'}`)
    }
  }
  if (saved.creation) {
    section('Recorded creation outcome')
    text(saved.creation.success ? 'All selected unassigned policies were created. Assignment and device verification are still required.' : 'Some policies could not be created.')
    for (const result of saved.creation.results) text(`${result.name}: ${result.error ?? 'Created, unassigned'}`)
  }
  return report.finish('Policy pack assessment')
}
