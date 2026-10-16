import { CAPABILITY_STATUS_COLORS, CAPABILITY_STATUS_LABELS, CHECK_RESULT_COLORS, CHECK_RESULT_LABELS, COLLECTION_FAMILY_LABELS, COLLECTION_STATUS_LABELS, CONTROL_STATUS_COLORS, CONTROL_STATUS_LABELS, PLATFORM_LABELS, formatReportDate, frameworkCoverageLabel } from './presentation'
import { capabilityComparison, comparisonCounts, type NativeAssessment } from './native'
import { exportLimitations, nativeReportHeader, redactSecrets, redactText, workspaceReportHeader, type ExportContext, type ReportHeader, type SavedAssessment } from './export'
import { coverageSourceLabel, exclusionsText, formatRate, levelCheckSummary, levelHeadline, unassignedText, type CisLevelReadiness, type CisReadinessSummary } from '../frameworks/cis-readiness'
import { recommendationTotals, type RecommendationResult } from '../frameworks/cis-recommendations'
import { displayCheckValue } from './check-results'
import type { CapabilityResult, CapabilityStatus, ControlAssessment, ControlStatus, TechnicalCheck } from './types'
import { PALETTE, TONES, ascii, capHeight, chipWidth, drawCard, drawChip, drawPill, drawStackedBar, mixColor, pillMetrics, setFont, textWidth, type MarkerKind, type PillOptions, type RgbColor, type Tone } from '../pdf/kit'
import { PAGE, createLayout, type FlowBlock, type Layout, type TextItem } from '../pdf/layout'
import { bullets, callout, distribution, introCallout, drawCover, facts, hero, kpiRow, noteCard, panel, table, tableBlocks, type Fact, type Group, type LegendItem, type Row } from '../pdf/blocks'
import { brandName, resolveBrandTheme, type BrandTheme, type PdfBranding } from '../pdf/theme'
import rights from './rights.json'

export type { PdfBranding } from '../pdf/theme'

const { margin, right, contentWidth } = PAGE
type Outcome = keyof typeof CHECK_RESULT_LABELS
const OUTCOMES = Object.keys(CHECK_RESULT_LABELS) as Outcome[]
const SLATE: RgbColor = [100, 116, 139]
// Cell values longer than this move below the row, across the full card width.
const LONG_VALUE = 220

const OUTCOME_STYLE: Record<Outcome, { tone: Tone; marker: MarkerKind }> = {
  matches: { tone: 'good', marker: 'filled' },
  different: { tone: 'warn', marker: 'half' },
  missing: { tone: 'bad', marker: 'triangle' },
  unableToCheck: { tone: 'neutral', marker: 'outline' },
  outsideScope: { tone: 'neutral', marker: 'dash' },
}

const CONTROL_STYLE: Record<ControlStatus, { tone: Tone; marker: MarkerKind }> = {
  evidenceFound: { tone: 'good', marker: 'filled' },
  partialEvidence: { tone: 'warn', marker: 'half' },
  noEvidence: { tone: 'neutral', marker: 'outline' },
  notApplicable: { tone: 'neutral', marker: 'dash' },
  notAssessed: { tone: 'warn', marker: 'outline' },
  conflictingEvidence: { tone: 'conflict', marker: 'triangle' },
}

const CAPABILITY_STYLE: Record<CapabilityStatus, { tone: Tone; marker: MarkerKind; color?: RgbColor }> = {
  enforced: { tone: 'good', marker: 'filled' },
  requirementAssigned: { tone: 'info', marker: 'filled', color: [22, 21, 20] },
  configuredNotAssigned: { tone: 'warn', marker: 'half' },
  disabledByPolicy: { tone: 'conflict', marker: 'triangle' },
  noEvidence: { tone: 'neutral', marker: 'outline' },
  assignmentUnknown: { tone: 'warn', marker: 'half' },
  conflictingEvidence: { tone: 'conflict', marker: 'triangle' },
  partialConfiguration: { tone: 'warn', marker: 'half' },
  collectionIncomplete: { tone: 'warn', marker: 'outline' },
  notApplicable: { tone: 'neutral', marker: 'dash' },
}

// Unable to check and outside scope share slate; charts draw outside scope lighter so the segments stay apart.
const chartColor = (outcome: Outcome): RgbColor => outcome === 'outsideScope' ? mixColor(SLATE, PALETTE.white, 0.5) : CHECK_RESULT_COLORS[outcome]
const outcomePill = (outcome: Outcome): PillOptions => ({ ...OUTCOME_STYLE[outcome], markerColor: CHECK_RESULT_COLORS[outcome] })
const controlPill = (status: ControlStatus): PillOptions => ({ ...CONTROL_STYLE[status], markerColor: CONTROL_STATUS_COLORS[status] })
const capabilityPill = (status: CapabilityStatus): PillOptions => ({ tone: CAPABILITY_STYLE[status].tone, marker: CAPABILITY_STYLE[status].marker, markerColor: CAPABILITY_STYLE[status].color ?? CAPABILITY_STATUS_COLORS[status] })
const checkOutcome = (check: TechnicalCheck): Outcome => check.assessmentStatus === 'checked' ? check.result ?? 'unableToCheck' : check.assessmentStatus
const share = (part: number, whole: number) => whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%'
const item = (text: string, size = 7.2, style: TextItem['style'] = 'normal', color: RgbColor = PALETTE.ink, technical = false): TextItem => ({ text, size, style, color, technical })

function percent(value: number | null): string {
  return value === null ? 'Not available' : `${Math.round(value * 1000) / 10}%`
}

/** A report layout whose every drawn string is redacted and normalised to WinAnsi. */
function createReport(options: { shortName: string; tenant?: string; footer: string; title: string; subject: string; keywords: string; exportedAt: string; identity: readonly unknown[]; theme: BrandTheme }): Layout {
  const { theme } = options
  return createLayout({
    shortName: options.shortName, tenant: options.tenant, footer: options.footer,
    sanitize: value => ascii(redactText(value)),
    properties: { title: options.title, subject: options.subject, keywords: options.keywords },
    exportedAt: options.exportedAt,
    theme,
    identity: options.identity,
  })
}

// The prefix withCapabilitySummaries (framework-summary.ts) gives a control summary; product text, so a white label report names the company.
const SUMMARY_PREFIX = 'TenuVault compares selected capabilities: '
const capabilitySummary = (summary: string, product: string) => summary.startsWith(SUMMARY_PREFIX) ? `${product} compares selected capabilities: ${summary.slice(SUMMARY_PREFIX.length)}` : summary

const tenantLabel = (header: { tenant: { id: string; name?: string } }) => header.tenant.name ? `${header.tenant.name} (${header.tenant.id})` : header.tenant.id

/** Facts, supported coverage, unknowns and limitations of a report header. */
function scopeSection(layout: Layout, header: ReportHeader, extra: Fact[]) {
  layout.pageTitle('Scope', 'Scope and limitations', { lead: 'What this report compared, what it could not establish and how its results may be read.' })
  facts(layout, [
    { label: 'Tenant', value: tenantLabel(header), technical: true, wide: true },
    { label: 'Framework', value: [header.framework.name, header.framework.version].filter(Boolean).join(' | ') },
    { label: 'Profile', value: header.framework.profile || 'Not recorded' },
    ...extra,
    { label: 'Collected', value: formatReportDate(header.collectedAt) },
    { label: 'Exported', value: formatReportDate(header.exportedAt) },
    { label: 'Report', value: header.runId, technical: true },
    { label: 'Assessed scope', value: header.assessedScope, wide: true },
  ], 'Scope and limitations')
  layout.heading('Supported coverage')
  bullets(layout, header.supportedCoverage, 'Supported coverage')
  layout.heading('Unknowns')
  bullets(layout, header.unknowns, 'Unknowns')
  layout.heading('Limitations')
  bullets(layout, header.limitations, 'Limitations')
}

/** The About panel above the contents. */
const aboutPanel = (layout: Layout, text: string[]) => introCallout(layout, { title: 'About this report', tone: 'warn', body: text.map(value => ({ text: value })) })

function outcomeLegend(counts: Record<Outcome, number>): LegendItem[] {
  return OUTCOMES.map(outcome => ({ label: CHECK_RESULT_LABELS[outcome], count: counts[outcome], marker: OUTCOME_STYLE[outcome].marker, color: chartColor(outcome) }))
}

/** Local report of the stored comparison. Export never re-reads or re-evaluates the tenant. */
export function generateNativeFrameworkPDF(run: NativeAssessment, context: ExportContext = { exportedAt: new Date().toISOString() }, branding?: PdfBranding): Uint8Array<ArrayBuffer> {
  const framework = run.assessment.frameworks[0]
  if (!framework) throw new Error('No framework comparison is available.')
  const theme = resolveBrandTheme(branding)
  const header = nativeReportHeader(run, context, brandName(theme))
  const counts = comparisonCounts(run)
  const name = framework.framework.name
  const layout = createReport({
    shortName: name, tenant: header.tenant.name ?? header.tenant.id, footer: 'Independent configuration comparison',
    title: `${name} configuration comparison`, subject: 'Independent Intune technical evidence mapping', keywords: 'Intune, configuration, evidence, comparison',
    exportedAt: context.exportedAt, identity: ['native', run.runId, run.tenantId, run.frameworkId, run.snapshotSha256, run.rulesetSha256, context.exportedAt], theme,
  })
  const scope = run.assessment.scope
  const platforms = scope.platforms?.map(p => PLATFORM_LABELS[p] ?? p).join(', ') ?? 'All supported platforms'
  const target: Fact[] = [
    ...(run.frameworkId === 'essential-eight' ? [{ label: 'Essential Eight target maturity', value: String(scope.essentialEightMaturityLevel ?? 1) }] : []),
    ...(run.frameworkId === 'def-stan' ? [{ label: 'Def Stan target risk level', value: String(scope.defStanRiskLevel ?? 1) }] : []),
  ]
  const total = OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0)
  const assessable = total - counts.outsideScope
  const capabilities = new Map(run.assessment.capabilities.map(c => [c.capability.id, c]))
  const outcomeOf = new Map(run.assessment.capabilities.map(c => [c.capability.id, capabilityComparison(c)]))
  const coverage = frameworkCoverageLabel(framework) ?? `${framework.controls.length} selected technical references. This subset is not the complete framework.`
  const countsSentence = 'Counts cover capabilities once, using the best assigned policy evidence. Unassigned policies cannot count as matches. Individual setting observations follow. Assignment scope, group membership, exclusions, filters, actual device state and effective access must be reviewed separately.'

  drawCover(layout, {
    eyebrow: 'Independent configuration comparison', title: name, subtitle: framework.framework.version,
    lead: 'Selected framework references compared with the recorded Intune configuration of the tenant.',
    tenant: header.tenant.name ?? header.tenant.id,
    facts: [['Compared', formatReportDate(run.assessment.generatedAt)], ['Exported', formatReportDate(context.exportedAt)]],
    ring: assessable ? counts.matches / assessable : 0,
    donuts: [{ segments: OUTCOMES.filter(o => o !== 'outsideScope').map(o => ({ value: counts[o], color: CHECK_RESULT_COLORS[o] })), total: assessable, value: share(counts.matches, assessable) }],
    donutCount: `${counts.matches} of ${assessable} capabilities`,
    donutCaption: 'Capabilities that match', donutSub: 'Configuration comparison only, not a compliance score',
    glance: OUTCOMES.map(o => ({ label: CHECK_RESULT_LABELS[o], value: String(counts[o]), marker: OUTCOME_STYLE[o].marker, color: CHECK_RESULT_COLORS[o] })),
    glanceNote: `Read from the Intune configuration collected on ${formatReportDate(header.collectedAt)} and compared with mapping ${run.assessment.provenance.rulesetVersion}.`,
    control: [
      { label: 'Framework', value: `${name} ${framework.framework.version}`.trim(), span: 2 },
      { label: 'Tenant ID', value: header.tenant.id },
      { label: 'Report ID', value: header.runId },
      { label: 'Profile', value: header.framework.profile },
      { label: 'Platforms', value: platforms },
      { label: 'Collected', value: formatReportDate(header.collectedAt) },
      { label: 'Exported', value: formatReportDate(header.exportedAt) },
      ...target.map(fact => ({ label: fact.label.replace(/^(Essential Eight|Def Stan) /, '').replace(/^t/, 'T'), value: fact.value })),
    ],
    footerRight: 'Configuration comparison, not a certification',
  })
  layout.contentsPage(aboutPanel(layout, [header.notice]))

  // Summary
  layout.pageTitle('Executive summary', 'Summary')
  hero(layout, {
    value: share(counts.matches, assessable), label: 'Capabilities that match',
    lead: `${counts.matches} of ${assessable} compared capabilities match the expected configuration on an assigned policy.`,
    lines: [header.supportedCoverage[1] ?? '', header.unknowns[0] ?? ''],
    bar: { segments: [{ value: counts.matches, color: CHECK_RESULT_COLORS.matches }], total: assessable },
  })
  const tileColor = (outcome: Outcome) => counts[outcome] ? TONES[OUTCOME_STYLE[outcome].tone].text : PALETTE.faint
  kpiRow(layout, [
    { label: 'Matches', value: String(counts.matches), caption: 'match on an assigned policy', marker: 'filled', markerColor: CHECK_RESULT_COLORS.matches, valueColor: tileColor('matches') },
    { label: 'Different', value: String(counts.different), caption: 'an assigned policy sets another value', marker: 'half', markerColor: CHECK_RESULT_COLORS.different, valueColor: tileColor('different') },
    { label: 'Missing', value: String(counts.missing), caption: 'no assigned policy sets the value', marker: 'triangle', markerColor: CHECK_RESULT_COLORS.missing, valueColor: tileColor('missing') },
    { label: 'Unable to check', value: String(counts.unableToCheck), caption: `plus ${counts.outsideScope} outside the selected scope`, marker: 'outline', markerColor: CHECK_RESULT_COLORS.unableToCheck, valueColor: tileColor('unableToCheck') },
  ])
  distribution(layout, { title: 'Outcome distribution', note: `${total} capabilities`, items: outcomeLegend(counts), total })
  const attention = run.assessment.capabilities
    .filter(c => outcomeOf.get(c.capability.id) === 'different' || outcomeOf.get(c.capability.id) === 'missing')
    .sort((a, b) => (outcomeOf.get(a.capability.id) === 'different' ? 0 : 1) - (outcomeOf.get(b.capability.id) === 'different' ? 0 : 1))
  const referencesOf = (id: string) => framework.controls.filter(row => row.capabilityIds.includes(id)).map(row => row.control.id)
  if (attention.length) {
    const shown = attention.slice(0, 6)
    layout.heading('Needs attention', { note: 'different values first, then missing settings', keep: 24 })
    table(layout, {
      columns: [{ header: 'Outcome', width: 30 }, { header: 'Capability', width: 86 }, { header: 'References', width: 48 }, { header: 'Page', width: 16, align: 'right' }],
      valign: 'middle',
      groups: [{ label: '', rows: shown.map(c => ({
        link: `cap:${c.capability.id}`,
        cells: [
          { pill: CHECK_RESULT_LABELS[outcomeOf.get(c.capability.id)!], options: outcomePill(outcomeOf.get(c.capability.id)!) },
          { text: [item(c.capability.name, 7.6, 'bold'), item(PLATFORM_LABELS[c.capability.platform] ?? c.capability.platform, 6.6, 'normal', PALETTE.muted)] },
          { text: [item(referencesOf(c.capability.id).join(', ') || 'Other compared capability', 7, 'normal', PALETTE.body, true)] },
          { page: `cap:${c.capability.id}` },
        ],
      })) }],
    }, 'Needs attention')
    if (attention.length > shown.length) paragraphNote(layout, `${attention.length - shown.length} more capabilities with a different or missing value are listed in the evidence detail.`)
  }
  noteCard(layout, 'Coverage', [coverage, countsSentence])

  scopeSection(layout, header, [{ label: 'Platforms', value: platforms }, ...target, { label: 'Compared', value: formatReportDate(run.assessment.generatedAt) }, { label: 'Mapping version', value: run.assessment.provenance.rulesetVersion }])

  // Results overview
  layout.pageTitle('Results', 'Results overview', { lead: 'Each selected framework reference with its evidence status, how many of its capabilities match and the page of its detail.' })
  table(layout, {
    columns: [{ header: 'Reference', width: 80 }, { header: 'Status', width: 46 }, { header: 'Capabilities', width: 40 }, { header: 'Page', width: 14, align: 'right' }],
    valign: 'middle',
    groups: [{ label: '', rows: framework.controls.map((row): Row => {
      const ids = row.capabilityIds
      const outcomes = OUTCOMES.map(o => ({ value: ids.filter(id => outcomeOf.get(id) === o).length, color: chartColor(o) }))
      const matched = ids.filter(id => outcomeOf.get(id) === 'matches').length
      return {
        link: `ref:${row.control.id}`,
        cells: [
          { chip: row.control.id, text: [item(row.control.title, 7.4)] },
          { pill: CONTROL_STATUS_LABELS[row.status], options: controlPill(row.status) },
          ids.length ? { bar: outcomes, total: ids.length, label: `${matched} of ${ids.length}` } : { text: [item(row.unavailableCheck ? CHECK_RESULT_LABELS[row.unavailableCheck.assessmentStatus === 'outsideScope' ? 'outsideScope' : 'unableToCheck'] : 'No capabilities', 7, 'normal', PALETTE.muted)] },
          { page: `ref:${row.control.id}` },
        ],
      }
    }) }],
  }, 'Results overview')

  // Collection completeness
  layout.pageTitle('Collection', 'Collection completeness', { newPage: false, lead: 'Policy families read from the tenant for this comparison, with any error under the family it affected.' })
  const collectionStyle: Record<string, { tone: Tone; marker: MarkerKind; color: RgbColor }> = {
    complete: { tone: 'good', marker: 'filled', color: CHECK_RESULT_COLORS.matches },
    incomplete: { tone: 'warn', marker: 'half', color: CHECK_RESULT_COLORS.different },
    unknown: { tone: 'neutral', marker: 'outline', color: SLATE },
    notCollected: { tone: 'neutral', marker: 'dash', color: SLATE },
  }
  table(layout, {
    columns: [{ header: 'Policy family', width: 74 }, { header: 'Status', width: 40 }, { header: 'Policies', width: 33, align: 'right' }, { header: 'Recognized', width: 33, align: 'right' }],
    valign: 'middle',
    groups: [{ label: '', rows: run.assessment.collectionCoverage.map(family => {
      const style = collectionStyle[family.status] ?? collectionStyle.unknown!
      return {
        cells: [
          { text: [item(COLLECTION_FAMILY_LABELS[family.family] ?? family.family, 7.6, 'bold')] },
          { pill: COLLECTION_STATUS_LABELS[family.status] ?? family.status, options: { tone: style.tone, marker: style.marker, markerColor: style.color } },
          { text: [item(`${family.collectedPolicies} policies`, 7.4)] },
          { text: [item(`${family.recognizedPolicies} recognized`, 7.4)] },
        ],
        details: family.errors.map(error => ({ label: 'Error', items: [item(error, 7, 'normal', PALETTE.body, true)] })),
      }
    }) }],
  }, 'Collection completeness')

  // Framework references and evidence
  layout.pageTitle('Evidence detail', 'Framework references and evidence', { lead: 'Each reference with its capabilities and every setting observation: expected and observed values, the policy that holds them and its assignment.' })
  const detailed = new Map<string, string>()
  for (const row of framework.controls) {
    const mapped = row.capabilityIds.map(id => capabilities.get(id)).filter((c): c is CapabilityResult => Boolean(c))
    const repeated = mapped.filter(cap => detailed.has(cap.capability.id))
    const cards = mapped.filter(cap => !detailed.has(cap.capability.id)).map(cap => ({ cap, ...capabilityCard(layout, cap) }))
    referenceHeader(layout, row, mapped, outcomeOf, cards[0] ? cards[0].lead + 7 : 30)
    if (row.unavailableCheck) panel(layout, { title: 'Unable to check', items: [row.unavailableCheck.reason ?? 'No supported detector.'], marker: 'outline', color: SLATE, caption: row.control.id })
    for (const { cap, blocks, repeat, lead } of cards) {
      layout.ensure(lead + 3)
      layout.anchor(`cap:${cap.capability.id}`)
      detailed.set(cap.capability.id, row.control.id)
      layout.flow(blocks, { caption: `${row.control.id} ${cap.capability.name}`, repeat, card: {} })
      layout.y += 4
    }
    if (repeated.length) {
      layout.heading('Capabilities detailed under an earlier reference', { size: 8.6, keep: 16 })
      table(layout, {
        columns: [{ header: 'Capability', width: 92 }, { header: 'Status', width: 52 }, { header: 'Detailed in', width: 22 }, { header: 'Page', width: 14, align: 'right' }],
        valign: 'middle',
        groups: [{ label: '', rows: repeated.map(cap => ({
          link: `cap:${cap.capability.id}`,
          cells: [
            { text: [item(cap.capability.name, 7.4, 'bold'), item(PLATFORM_LABELS[cap.capability.platform] ?? cap.capability.platform, 6.4, 'normal', PALETTE.muted)] },
            { pill: CAPABILITY_STATUS_LABELS[cap.status], options: capabilityPill(cap.status) },
            { text: [item(detailed.get(cap.capability.id)!, 7.2, 'normal', PALETTE.body, true)] },
            { page: `cap:${cap.capability.id}` },
          ],
        })) }],
      }, row.control.id)
    }
    if (row.unassessedAspects.length) panel(layout, { title: 'Outside this comparison', items: row.unassessedAspects, marker: 'triangle', color: CHECK_RESULT_COLORS.different, dashed: true, caption: row.control.id })
    layout.y += 4
  }
  const others = run.assessment.capabilities.filter(cap => !detailed.has(cap.capability.id))
  if (others.length) {
    layout.heading('Other compared capabilities', { toc: true, keep: 40 })
    paragraphNote(layout, 'Capabilities compared but excluded from every reference above, for example because their platform is outside the selected scope.')
    for (const cap of others) {
      const card = capabilityCard(layout, cap)
      layout.ensure(card.lead + 3)
      layout.anchor(`cap:${cap.capability.id}`)
      layout.flow(card.blocks, { caption: cap.capability.name, repeat: card.repeat, card: {} })
      layout.y += 4
    }
  }

  // Provenance and attribution
  layout.pageTitle('Provenance', 'Provenance and attribution')
  facts(layout, [
    { label: 'Framework source', value: framework.framework.source?.url ?? 'Not supplied', technical: true, wide: true },
    { label: 'Source mapping verified', value: framework.framework.source?.verifiedAt ?? 'Unknown' },
    { label: 'Mapping version', value: run.assessment.provenance.rulesetVersion },
    { label: 'Detector port', value: `IntuneDocumentation ${run.sourceCommit}`, technical: true, wide: true },
    { label: 'Snapshot SHA-256', value: run.snapshotSha256, technical: true, wide: true },
    { label: 'Ruleset SHA-256', value: run.rulesetSha256, technical: true, wide: true },
  ], 'Provenance')
  layout.paragraph('Hashes identify the collected snapshot and mapped ruleset. They do not certify tenant security, prove authenticity or show that configurations were enforced.', { after: 6 })
  layout.heading('Attribution', { keep: 30 })
  const provider = rights.providers.find(p => p.id === framework.framework.id)
  const attribution = [
    'Framework detector code adapted from IntuneDocumentation, Ugur Koc and contributors, under Elastic License 2.0. Adapted on 30 September 2026 for TenuVault desktop collection, original restricted-framework descriptions and stored-comparison reports. The accompanying framework-NOTICES.txt contains the license and publisher attribution.',
    `Publisher content basis: ${provider?.sourceContentLicense ?? 'Original independent mapping'}`,
    ...(run.frameworkId === 'essential-eight' ? ['Australian Signals Directorate, © Commonwealth of Australia 2026. Selected November 2023 model entries adapted for Intune comparisons. Creative Commons Attribution 4.0: https://creativecommons.org/licenses/by/4.0/ . Changes: technical evidence mapping, scope selection and desktop reporting. No endorsement.'] : []),
    ...(run.frameworkId === 'cyber-essentials' ? ['Contains public sector information from NCSC licensed under the Open Government Licence v3.0: https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/ . Crown copyright. Adapted technical mapping; no certification or endorsement.'] : []),
    ...(run.frameworkId.startsWith('nist-') ? ['Derived from NIST-authored technical series publications with selected Intune mappings and summaries added or modified. Third-party material excluded. Provided AS IS, without NIST warranty or endorsement. Worldwide royalty-free reuse terms and attribution: https://www.nist.gov/open/license .'] : []),
  ]
  // Licence and attribution text, including the publisher content basis from rights.json, is printed verbatim, also on white label reports.
  for (const text of attribution) layout.paragraph([{ text, size: 8.4, color: PALETTE.body, lineHeight: 3.9 }], { after: 3 })
  return layout.finish()
}

/** A muted single paragraph below a table. */
function paragraphNote(layout: Layout, text: string) {
  layout.paragraph([{ text, size: 7, style: 'italic', color: PALETTE.muted, lineHeight: 3.2 }], { after: 4 })
}

/** Header card of a framework reference: ID tile, status, title, summary and the capability meter. */
function referenceHeader(layout: Layout, row: ControlAssessment, mapped: CapabilityResult[], outcomeOf: Map<string, Outcome>, follow: number) {
  const { doc, theme } = layout
  const idText = row.control.id
  let idSize = 15
  while (idSize > 7 && textWidth(doc, idText, idSize, 'bold') > 30) idSize -= 0.5
  const tileWidth = Math.min(Math.max(textWidth(doc, idText, idSize, 'bold') + 7, 20), 36)
  const idLines = textWidth(doc, idText, idSize, 'bold') > tileWidth - 4 ? layout.wrap(idText, tileWidth - 4, (idSize = 7), 'bold', { technical: true }) : [idText]
  const sideWidth = 40
  const sideX = right - 5 - sideWidth
  const midX = margin + 5 + tileWidth + 5
  const midWidth = sideX - 5 - midX
  const title = layout.measure([{ text: row.control.title, size: 14, style: 'bold', color: theme.strong, lineHeight: 5.8 }], midWidth)
  const summary = layout.measure([{ text: capabilitySummary(row.control.summary, brandName(theme)), size: 8, color: PALETTE.muted, lineHeight: 3.6 }], midWidth)
  const midHeight = 7.6 + layout.heightOf(title) + 0.6 + layout.heightOf(summary)
  const height = Math.max(midHeight, idLines.length * 3.6 + 6, 24) + 10
  layout.ensure(height + follow)
  layout.record(`${row.control.id} ${row.control.title}`)
  layout.anchor(`ref:${row.control.id}`)
  const top = layout.y
  drawCard(doc, margin, top, contentWidth, height, { stroke: PALETTE.border })
  const tileHeight = Math.max(16, idLines.length * 3.6 + 6)
  const tileTop = top + (height - tileHeight) / 2
  doc.setFillColor(...theme.strong)
  doc.roundedRect(margin + 5, tileTop, tileWidth, tileHeight, 2, 2, 'F')
  setFont(doc, idSize, 'bold', PALETTE.white)
  idLines.forEach((line, index) => doc.text(line, margin + 5 + tileWidth / 2, tileTop + tileHeight / 2 - ((idLines.length - 1) * 3.6) / 2 + capHeight(idSize) / 2 + index * 3.6, { align: 'center' }))
  let midY = top + (height - midHeight) / 2
  let pillX = midX + drawPill(doc, midX, midY, CONTROL_STATUS_LABELS[row.status], { ...controlPill(row.status), maxWidth: midWidth }) + 1.6
  for (const chip of [row.control.tier, row.control.evidenceStrength ? `${row.control.evidenceStrength === 'direct' ? 'Direct' : 'Supporting'} evidence` : undefined]) {
    if (!chip || pillX + chipWidth(doc, chip, 6.4) > midX + midWidth) continue
    pillX += drawChip(doc, pillX, midY + 0.2, chip, { size: 6.4, fill: TONES.neutral.fill, color: TONES.neutral.text }) + 1.6
  }
  midY += 7.6
  layout.drawLines(title, midX, midY)
  midY += layout.heightOf(title) + 0.6
  layout.drawLines(summary, midX, midY)
  doc.setDrawColor(...PALETTE.rule)
  doc.setLineWidth(0.2)
  doc.line(sideX - 5, top + 5, sideX - 5, top + height - 5)
  const sideTop = top + height / 2 - 9
  const matched = mapped.filter(cap => outcomeOf.get(cap.capability.id) === 'matches').length
  setFont(doc, 11, 'bold', theme.strong)
  doc.text(`${matched} of ${mapped.length}`, sideX, sideTop + 4)
  setFont(doc, 7, 'normal', PALETTE.muted)
  doc.text('capabilities match', sideX, sideTop + 8.2)
  drawStackedBar(doc, sideX, sideTop + 10.4, sideWidth, 1.6, OUTCOMES.map(o => ({ value: mapped.filter(cap => outcomeOf.get(cap.capability.id) === o).length, color: chartColor(o) })), Math.max(mapped.length, 1), { gap: 0.3 })
  const observations = mapped.reduce((sum, cap) => sum + cap.checks.length, 0)
  setFont(doc, 7, 'normal', PALETTE.muted)
  doc.text(`${observations} setting ${observations === 1 ? 'observation' : 'observations'}`, sideX, sideTop + 16.6)
  layout.y = top + height + 4
}

/** The panel strip at the top of a capability card: name, platform and status pill. */
function capabilityHead(layout: Layout, cap: CapabilityResult): FlowBlock {
  const { doc } = layout
  const label = CAPABILITY_STATUS_LABELS[cap.status]
  const pill = { ...capabilityPill(cap.status), maxWidth: 70 }
  const pillWidth = pillMetrics(doc, label, pill).width
  const platform = PLATFORM_LABELS[cap.capability.platform] ?? cap.capability.platform
  const nameWidth = contentWidth - 8 - pillWidth - 4
  const name = layout.measure([{ text: cap.capability.name, size: 9, style: 'bold', color: PALETTE.ink, lineHeight: 4 }], nameWidth)
  const platformFits = name.length === 1 && textWidth(doc, name[0]!.text, 9, 'bold') + textWidth(doc, platform, 7) + 2 < nameWidth
  const lines = platformFits ? name : [...name, ...layout.measure([{ text: platform, size: 7, color: PALETTE.muted, lineHeight: 3.2 }], nameWidth)]
  const height = Math.max(8.4, layout.heightOf(lines) + 4.4)
  return {
    height: height + 1.5,
    draw: top => {
      doc.setFillColor(...PALETTE.panel)
      doc.roundedRect(margin, top, contentWidth, height, 2, 2, 'F')
      doc.rect(margin, top + height - 2, contentWidth, 2, 'F')
      const textTop = top + (height - layout.heightOf(lines)) / 2 - 0.2
      layout.drawLines(lines, margin + 4, textTop)
      if (platformFits) {
        const platformX = margin + 4 + textWidth(doc, name[0]!.text, 9, 'bold') + 2
        setFont(doc, 7, 'normal', PALETTE.muted)
        doc.text(platform, platformX, textTop + capHeight(9))
      }
      drawPill(doc, right - 4 - pillWidth, top + (height - 4.8) / 2, label, pill)
    },
  }
}

/** Full width lines inside a card with a small label on the left, split into page sized blocks. */
function labelledBlocks(layout: Layout, label: string, items: TextItem[]): FlowBlock[] {
  const { doc } = layout
  const innerX = margin + 4
  return layout.chunk(layout.measure(items, contentWidth - 8 - 26)).map((part, index) => ({
    height: layout.heightOf(part) + 2.2,
    draw: top => {
      if (index === 0) {
        setFont(doc, 5.6, 'bold', PALETTE.muted)
        doc.text(label.toUpperCase(), innerX, top + 1 + capHeight(7), { charSpace: 0.2 })
      }
      layout.drawLines(part, innerX + 26, top + 1)
    },
  }))
}

const ASSIGNMENT_LABELS = { assigned: 'Assigned', notAssigned: 'Not assigned', unknown: 'Unknown' } as const

/** The rows of a check table: setting, expected, observed and result, then policy, assignment and reason. */
function checkRow(check: TechnicalCheck): Row {
  const outcome = checkOutcome(check)
  const label = displayCheckValue(check.settingId).trim()
  const readable = label || check.settingId
  const expected = displayCheckValue(check.expectedValue)
  const observed = check.actualValue === null ? null : displayCheckValue(check.actualValue)
  const longSetting = check.settingId.length > LONG_VALUE
  const longExpected = expected.length > LONG_VALUE
  const longObserved = (observed?.length ?? 0) > LONG_VALUE
  const details: NonNullable<Row['details']> = []
  if (longSetting) details.push({ label: 'Setting ID', items: [item(check.settingId, 6.6, 'normal', PALETTE.body, true)] })
  if (longExpected) details.push({ label: 'Expected', items: [item(expected, 6.8, 'normal', PALETTE.body, true)] })
  if (longObserved && observed) details.push({ label: 'Observed', items: [item(observed, 6.8, 'bold', PALETTE.ink, true)] })
  if (check.policyId) details.push({ label: 'Policy', items: [item(check.policyName ?? check.policyId, 7.2, 'bold'), item(`Policy ID: ${check.policyId}`, 6.4, 'normal', PALETTE.faint, true)] })
  if (check.assignment) {
    const filters = check.assignment.filters.map(filter => `${filter.target}: ${filter.id} (${filter.mode})`).join('; ')
    details.push({ label: 'Assignment', items: [
      item(ASSIGNMENT_LABELS[check.assignment.state] ?? check.assignment.state, 7, 'bold'),
      item(`Targets: ${check.assignment.targets.join('; ') || 'None'}`, 6.8, 'normal', PALETTE.body, true),
      item(`Exclusions: ${check.assignment.exclusions.join('; ') || 'None'}`, 6.8, 'normal', PALETTE.body, true),
      item(`Filters: ${filters || 'None'}`, 6.8, 'normal', PALETTE.body, true),
    ] })
  }
  if (check.reason) details.push({ label: 'Reason', items: [item(check.reason, 6.8, 'italic', PALETTE.body)] })
  const settingItems = longSetting
    ? [item(readable !== check.settingId ? readable.slice(0, LONG_VALUE) : 'Setting ID below', 7.2, 'normal', PALETTE.ink, true)]
    : readable !== check.settingId ? [item(readable, 7.2, 'normal', PALETTE.ink, true), item(check.settingId, 6, 'normal', PALETTE.faint, true)] : [item(check.settingId, 7.2, 'normal', PALETTE.ink, true)]
  const wash: Partial<Record<Outcome, RgbColor>> = { different: mixColor(TONES.warn.fill, PALETTE.white, 0.55), missing: mixColor(TONES.bad.fill, PALETTE.white, 0.55) }
  return {
    wash: wash[outcome],
    cells: [
      { text: settingItems },
      { text: [longExpected ? item('See below', 7.2, 'italic', PALETTE.muted) : item(expected, 7.2, 'normal', PALETTE.body, true)] },
      { text: [observed === null ? item('Not available', 7.2, 'italic', PALETTE.muted) : longObserved ? item('See below', 7.2, 'italic', PALETTE.muted) : item(observed, 7.2, 'bold', PALETTE.ink, true)] },
      { pill: CHECK_RESULT_LABELS[outcome], options: outcomePill(outcome) },
    ],
    details,
  }
}

/** A capability card: head, description, check table, limitations and source metadata. `lead` keeps the head with its first row. */
function capabilityCard(layout: Layout, cap: CapabilityResult): { blocks: FlowBlock[]; repeat?: (index: number) => FlowBlock | undefined; lead: number } {
  const innerX = margin + 4
  const innerWidth = contentWidth - 8
  const blocks: FlowBlock[] = [capabilityHead(layout, cap)]
  for (const part of layout.chunk(layout.measure([{ text: cap.capability.description, size: 7.4, color: PALETTE.muted, lineHeight: 3.3 }], innerWidth))) {
    blocks.push({ height: layout.heightOf(part) + 1.6, draw: top => layout.drawLines(part, innerX, top + 0.4) })
  }
  let repeat: ((index: number) => FlowBlock | undefined) | undefined
  if (cap.checks.length) {
    const { header, blocks: rows } = tableBlocks(layout, {
      columns: [{ header: 'Setting', width: 52 }, { header: 'Expected', width: 42 }, { header: 'Observed', width: 42 }, { header: 'Result', width: innerWidth - 136, align: 'right' }],
      groups: [{ label: '', rows: cap.checks.map(checkRow) }],
      x: innerX, width: innerWidth, zebra: false, valign: 'top',
    })
    const first = blocks.length + 1
    const last = first + rows.length
    blocks.push(header, ...rows)
    repeat = index => index >= first && index < last ? header : undefined
  } else {
    blocks.push(...labelledBlocks(layout, 'Settings', [item('No setting observations were recorded for this capability.', 7.2, 'italic', PALETTE.muted)]))
  }
  for (const limitation of cap.limitations) blocks.push(...labelledBlocks(layout, 'Limitation', [item(limitation, 7, 'normal', PALETTE.body)]))
  for (const evidence of cap.evidence) {
    if (evidence.policyModifiedAt || evidence.policyVersion) blocks.push(...labelledBlocks(layout, 'Source', [item(`Source metadata: ${evidence.policyName}, version ${evidence.policyVersion ?? 'not supplied'}, modified ${evidence.policyModifiedAt ?? 'not supplied'}`, 7, 'normal', PALETTE.body, true)]))
  }
  // The head, description, table header and first row with its details stay together.
  const firstRow = blocks.findIndex((_, index) => repeat?.(index) !== undefined)
  const leadCount = firstRow >= 0 ? firstRow + 1 : Math.min(blocks.length, 3)
  const lead = blocks.slice(0, leadCount).reduce((sum, block) => sum + block.height, 0) + (firstRow >= 0 ? blocks[firstRow]!.keep ?? 0 : 0)
  return { blocks, repeat, lead: Math.min(lead, 150) }
}

const WORKSPACE_STATUSES = ['Missing', 'Different', 'Review', 'Present'] as const
type WorkspaceStatus = typeof WORKSPACE_STATUSES[number]
const WORKSPACE_STYLE: Record<WorkspaceStatus, { tone: Tone; marker: MarkerKind; color: RgbColor }> = {
  Missing: { tone: 'bad', marker: 'triangle', color: CHECK_RESULT_COLORS.missing },
  Different: { tone: 'warn', marker: 'half', color: CHECK_RESULT_COLORS.different },
  Review: { tone: 'neutral', marker: 'outline', color: SLATE },
  Present: { tone: 'good', marker: 'filled', color: CHECK_RESULT_COLORS.matches },
}

/**
 * Local report of a saved policy pack assessment. Export never re-reads the tenant; observed
 * values are redacted before they are printed.
 */
export function generateWorkspaceAssessmentPDF(saved: SavedAssessment, context: ExportContext, branding?: PdfBranding): Uint8Array<ArrayBuffer> {
  const theme = resolveBrandTheme(branding)
  const header = workspaceReportHeader(saved, context, brandName(theme))
  const findings = redactSecrets(saved.assessment.findings)
  const layout = createReport({
    shortName: header.framework.name, tenant: header.tenant.name ?? header.tenant.id, footer: 'Policy pack assessment',
    title: `${header.framework.name} policy pack assessment`, subject: 'Intune policy pack comparison', keywords: 'Intune, configuration, baseline, comparison',
    exportedAt: context.exportedAt, identity: ['workspace', saved.assessment.runId, saved.assessment.tenantId, saved.assessment.frameworkId, saved.assessment.assessedAt, context.exportedAt], theme,
  })
  const count = (status: WorkspaceStatus) => findings.filter(f => f.status === status).length
  const total = findings.length
  const style = (status: WorkspaceStatus) => ({ tone: WORKSPACE_STYLE[status].tone, marker: WORKSPACE_STYLE[status].marker, markerColor: WORKSPACE_STYLE[status].color })
  drawCover(layout, {
    eyebrow: 'Policy pack assessment', title: header.framework.name, subtitle: header.framework.profile,
    lead: 'Pack policies compared with the Settings Catalog policies of the tenant.',
    tenant: header.tenant.name ?? header.tenant.id,
    facts: [['Assessed', formatReportDate(header.collectedAt)], ['Exported', formatReportDate(header.exportedAt)]],
    ring: total ? count('Present') / total : 0,
    donuts: [{ segments: WORKSPACE_STATUSES.map(status => ({ value: count(status), color: WORKSPACE_STYLE[status].color })), total, value: share(count('Present'), total) }],
    donutCount: `${count('Present')} of ${total} settings`,
    donutCaption: 'Settings present in the tenant', donutSub: 'Present is not proof of assignment or enforcement',
    glance: WORKSPACE_STATUSES.map(status => ({ label: status === 'Review' ? 'To review' : status, value: String(count(status)), marker: WORKSPACE_STYLE[status].marker, color: WORKSPACE_STYLE[status].color })),
    glanceNote: header.assessedScope,
    control: [
      { label: 'Policy pack', value: header.framework.name, span: 2 },
      { label: 'Tenant ID', value: header.tenant.id },
      { label: 'Report ID', value: header.runId },
      { label: 'Profile', value: header.framework.profile },
      { label: 'Policies read', value: String(saved.assessment.policyCount) },
      { label: 'Pack policies', value: String(saved.policies.length) },
      { label: 'Assessed', value: formatReportDate(header.collectedAt) },
      { label: 'Exported', value: formatReportDate(header.exportedAt) },
    ],
    footerRight: 'Configuration comparison, not a certification',
  })
  layout.contentsPage(aboutPanel(layout, [header.notice]))

  layout.pageTitle('Executive summary', 'Summary')
  hero(layout, {
    value: share(count('Present'), total), label: 'Settings present',
    lead: `${count('Present')} of ${total} pack settings are present in the tenant with the recommended value.`,
    lines: [header.supportedCoverage[1] ?? '', header.unknowns[0] ?? ''],
    bar: { segments: [{ value: count('Present'), color: CHECK_RESULT_COLORS.matches }], total },
  })
  const captions: Record<WorkspaceStatus, string> = { Missing: 'no tenant policy holds the setting', Different: 'a tenant policy sets another value', Review: 'the pack holds alternative values', Present: 'a matching configuration exists' }
  kpiRow(layout, WORKSPACE_STATUSES.map(status => ({ label: status === 'Review' ? 'To review' : status, value: String(count(status)), caption: captions[status], marker: WORKSPACE_STYLE[status].marker, markerColor: WORKSPACE_STYLE[status].color, valueColor: count(status) ? TONES[WORKSPACE_STYLE[status].tone].text : PALETTE.faint })))
  distribution(layout, { title: 'Status distribution', note: `${total} settings`, items: WORKSPACE_STATUSES.map(status => ({ label: status === 'Review' ? 'To review' : status, count: count(status), marker: WORKSPACE_STYLE[status].marker, color: WORKSPACE_STYLE[status].color })), total })
  noteCard(layout, 'Coverage', header.supportedCoverage)

  scopeSection(layout, header, [{ label: 'Policies read', value: String(saved.assessment.policyCount) }, { label: 'Pack policies', value: String(saved.policies.length) }])

  layout.pageTitle('Findings', 'Findings by status', { lead: 'Every pack setting with its status and the tenant policies in which a matching root setting was observed, with their assignment evidence.' })
  const groups: Group[] = []
  for (const status of WORKSPACE_STATUSES) {
    const rows = findings.filter(f => f.status === status)
    if (!rows.length) continue
    groups.push({
      label: `${status} (${rows.length})`, marker: { kind: WORKSPACE_STYLE[status].marker, color: WORKSPACE_STYLE[status].color },
      rows: rows.map(finding => ({
        cells: [
          { text: [item(finding.policyName, 7.4, 'bold'), item(finding.settingId, 6.2, 'normal', PALETTE.faint, true)] },
          { text: finding.observed.length ? finding.observed.map(o => item(`${o.policyName} (assignment evidence: ${o.targeting?.state ?? 'unknown'})`, 7, 'normal', PALETTE.body, true)) : [item('No matching root setting in the assessed policy family.', 7, 'italic', PALETTE.muted)] },
          { pill: status === 'Review' ? 'To review' : status, options: style(status) },
        ],
      })),
    })
  }
  for (const group of groups) {
    layout.heading(group.label, { toc: true, keep: 24 })
    table(layout, { columns: [{ header: 'Pack policy and setting', width: 76 }, { header: 'Observed in', width: 74 }, { header: 'Status', width: 30, align: 'right' }], groups: [{ ...group, label: '' }], valign: 'top' }, group.label)
  }
  if (!groups.length) paragraphNote(layout, 'The assessment recorded no findings.')

  if (saved.creation) {
    layout.pageTitle('Creation', 'Recorded creation outcome', { newPage: false })
    noteCard(layout, 'Outcome', [saved.creation.success ? 'All selected unassigned policies were created. Assignment and device verification are still required.' : 'Some policies could not be created.'])
    table(layout, {
      columns: [{ header: 'Policy', width: 80 }, { header: 'Detail', width: 70 }, { header: 'Outcome', width: 30, align: 'right' }],
      valign: 'middle',
      groups: [{ label: '', rows: saved.creation.results.map(result => ({
        cells: [
          { text: [item(result.name, 7.4, 'bold')] },
          { text: [item(result.error ?? 'Created, unassigned', 7, 'normal', PALETTE.body, true)] },
          { pill: result.error ? 'Failed' : 'Created', options: result.error ? outcomePill('missing') : outcomePill('matches') },
        ],
      })) }],
    }, 'Recorded creation outcome')
  }
  return layout.finish()
}

/** Where a CIS readiness report came from; the tenant name is a label only. */
export interface CisReportContext extends ExportContext {
  tenantId: string
  assessedAt: string
  runId?: string
}

const RESULT_STYLE: Record<RecommendationResult['result'], { tone: Tone; marker: MarkerKind; color: RgbColor }> = {
  Pass: { tone: 'good', marker: 'filled', color: CHECK_RESULT_COLORS.matches },
  Fail: { tone: 'bad', marker: 'triangle', color: CHECK_RESULT_COLORS.missing },
  Review: { tone: 'warn', marker: 'half', color: CHECK_RESULT_COLORS.different },
  'Not assessed': { tone: 'neutral', marker: 'outline', color: SLATE },
}

/**
 * The headline figure of a Level and the segments of its bar. The rate, its basis label and the
 * exclusions come from levelHeadline, the function every CIS view uses, so the PDF shows the
 * numbers of the CIS page.
 */
function levelFigure(level: CisLevelReadiness) {
  const headline = levelHeadline(level)
  const named = { ...headline, label: `Level ${level.level} ${headline.label.toLowerCase()}`, withExclusions: exclusionsText(headline) }
  if (headline.basis === 'recommendations') {
    const totals = recommendationTotals(level.recommendations)
    const assessed = totals.passed + totals.failed + totals.review
    return { ...named, total: assessed, segments: [
      { value: totals.passed, color: CHECK_RESULT_COLORS.matches }, { value: totals.failed, color: CHECK_RESULT_COLORS.missing }, { value: totals.review, color: CHECK_RESULT_COLORS.different },
    ] }
  }
  return { ...named, total: level.assessedSettings, segments: [
    { value: level.present, color: CHECK_RESULT_COLORS.matches }, { value: level.different, color: CHECK_RESULT_COLORS.different }, { value: level.missing, color: CHECK_RESULT_COLORS.missing }, { value: level.review, color: SLATE },
  ] }
}

/**
 * Local CIS readiness report from a saved assessment, in the same layout as the native
 * framework reports. Export never re-reads or re-evaluates the tenant. Manual items without
 * imported text carry the same fallback line the readiness view shows.
 */
export function generateCisReadinessPDF(summary: CisReadinessSummary, context: CisReportContext, branding?: PdfBranding): Uint8Array<ArrayBuffer> {
  const title = summary.benchmarkName ?? summary.benchmark
  const theme = resolveBrandTheme(branding)
  const product = brandName(theme)
  const layout = createReport({
    shortName: title, tenant: context.tenantName ?? context.tenantId, footer: 'CIS readiness report',
    title: `${summary.benchmark} readiness report`, subject: 'CIS readiness summary from a saved assessment', keywords: 'Intune, configuration, readiness, comparison',
    exportedAt: context.exportedAt, identity: ['cis', context.runId ?? null, context.tenantId, summary.benchmark, summary.version, context.assessedAt, context.exportedAt], theme,
  })
  const tenant = context.tenantName ? `${context.tenantName} (${context.tenantId})` : context.tenantId
  const benchmark = summary.benchmarkName ? `${summary.benchmarkName} (${summary.benchmark})` : summary.benchmark
  const headlines = summary.levels.map(levelFigure)
  const first = headlines[0]
  drawCover(layout, {
    eyebrow: 'CIS readiness report', title, subtitle: [summary.benchmarkName ? summary.benchmark : '', summary.version ? `Version ${summary.version}` : ''].filter(Boolean).join(' | '),
    lead: 'Readiness of the recorded Intune configuration against the imported benchmark pack, per Level.',
    tenant: context.tenantName ?? context.tenantId,
    facts: [['Assessed', formatReportDate(context.assessedAt)], ['Exported', formatReportDate(context.exportedAt)]],
    ring: first?.rate ?? 0,
    donuts: (summary.levels.length ? summary.levels.slice(0, 2) : []).map((level, index) => ({ segments: headlines[index]!.segments, total: headlines[index]!.total, value: headlines[index]!.rate === null ? 'n/a' : formatRate(headlines[index]!.rate), label: summary.levels.length > 1 ? `Level ${level.level}` : undefined })),
    donutCount: summary.levels.length === 1 ? `Level ${summary.levels[0]!.level}` : undefined,
    donutCaption: 'Headline pass rate per Level', donutSub: 'Over assessed items only; manual recommendations are not assessed',
    glance: summary.levels.slice(0, 3).flatMap((level, index) => [
      { label: headlines[index]!.label, value: percent(headlines[index]!.rate), marker: 'filled' as MarkerKind, color: CHECK_RESULT_COLORS.matches },
      { label: `Level ${level.level} deviating settings`, value: String(level.different + level.missing + level.review), marker: 'half' as MarkerKind, color: CHECK_RESULT_COLORS.different },
    ]),
    glanceNote: summary.manualNote,
    control: [
      { label: 'Benchmark', value: benchmark, span: 2 },
      { label: 'Version', value: summary.version },
      { label: 'Levels', value: summary.levels.map(level => level.level).join(', ') },
      { label: 'Tenant ID', value: context.tenantId },
      { label: 'Report ID', value: context.runId ?? '' },
      { label: 'Assessed', value: formatReportDate(context.assessedAt) },
      { label: 'Exported', value: formatReportDate(context.exportedAt) },
    ],
    footerRight: 'Readiness comparison, not a certification',
  })
  layout.contentsPage(aboutPanel(layout, ['Readiness figures come from a saved assessment of the recorded Intune configuration and were not collected again for this export. They are not an audit opinion or a CIS certification.']))

  layout.pageTitle('Executive summary', 'Summary')
  facts(layout, [
    { label: 'Tenant', value: tenant, technical: true, wide: true },
    { label: 'Benchmark', value: benchmark },
    { label: 'Version', value: summary.version },
    { label: 'Assessed', value: formatReportDate(context.assessedAt) },
    { label: 'Exported', value: formatReportDate(context.exportedAt) },
    ...(context.runId ? [{ label: 'Report', value: context.runId, technical: true }] : []),
  ], 'Summary')
  summary.levels.forEach((level, index) => {
    const headline = headlines[index]!
    const deviating = level.different + level.missing + level.review
    const unassigned = unassignedText(level)
    hero(layout, {
      value: headline.rate === null ? 'n/a' : formatRate(headline.rate), label: headline.label,
      lead: levelCheckSummary(level, product),
      // The settings figures stay counts; the rate with exclusions sits next to the raw headline.
      lines: [`Settings: ${level.present} of ${level.assessedSettings} present; ${deviating} deviate.`, ...(headline.withExclusions ? [`${headline.withExclusions}, exclusions as of ${headline.exclusionsAsOf}.`] : []), ...(unassigned ? [unassigned] : [])],
      bar: { segments: headline.segments.slice(0, 1), total: headline.total },
    })
  })
  // The CIS notice for recommendations this tool does not include, printed on every report.
  callout(layout, { title: 'Manual recommendations', tone: 'accent', body: [{ text: summary.manualNote, style: 'bold' }, { text: summary.manualFallback }, { text: summary.manualFallbackUrl, color: layout.theme.accentText, technical: true }], link: { url: summary.manualFallbackUrl, text: summary.manualFallbackUrl } })
  layout.heading('Limitations', { keep: 20 })
  bullets(layout, exportLimitations(product), 'Limitations')

  for (const level of summary.levels) levelSection(layout, summary, level)
  return layout.finish()
}

/** One Level: tiles, figures, coverage, exceptions, recommendation results and manual recommendations. */
function levelSection(layout: Layout, summary: CisReadinessSummary, level: CisLevelReadiness) {
  const { doc, theme } = layout
  const caption = `Level ${level.level} readiness`
  const deviating = level.different + level.missing + level.review
  layout.pageTitle(`Level ${level.level}`, caption)
  const head = levelHeadline(level)
  const withExclusions = exclusionsText(head)
  kpiRow(layout, [
    { label: 'Assessed settings', value: String(level.assessedSettings), caption: 'pack settings compared', marker: 'outline', markerColor: SLATE, valueColor: theme.strong },
    { label: 'Conforming', value: String(level.present), caption: 'present with the recommended value', marker: 'filled', markerColor: CHECK_RESULT_COLORS.matches, valueColor: level.present ? TONES.good.text : PALETTE.faint },
    { label: 'Deviating', value: String(deviating), caption: `different ${level.different}, missing ${level.missing}, review ${level.review}`, marker: 'half', markerColor: CHECK_RESULT_COLORS.different, valueColor: deviating ? TONES.warn.text : PALETTE.faint },
    { label: head.label, value: formatRate(head.rate), caption: withExclusions ?? 'no exclusions in use', marker: 'filled', markerColor: theme.accent, valueColor: theme.strong },
  ])
  layout.heading('Figures', { keep: 30 })
  facts(layout, [
    { label: 'Assessed settings', value: String(level.assessedSettings) },
    { label: 'Conforming', value: String(level.present) },
    { label: 'Deviating', value: `${deviating} (different ${level.different}, missing ${level.missing}, review ${level.review})` },
    { label: head.label, value: formatRate(head.rate) },
    { label: 'With exclusions', value: withExclusions ?? 'No exclusions in use' },
    { label: 'Excluded from score', value: String(head.exclusions) },
    { label: 'Exclusions as of', value: head.exclusionsAsOf },
    { label: 'Present in unassigned policies', value: level.presentInUnassigned === null ? 'Not recorded' : `${level.presentInUnassigned} of ${level.present}` },
    ...(level.assessedAutomated === null ? [] : [{ label: 'Assessed automated', value: String(level.assessedAutomated) }]),
    { label: 'Enumerated', value: String(level.enumerated) },
    { label: 'Not assessed identifiers', value: String(level.notAssessed.length) },
  ], caption)
  layout.heading('Coverage', { keep: 14 })
  if (level.coverage !== null) {
    drawStackedBar(doc, margin, layout.y, contentWidth, 3, [{ value: level.coverage, color: theme.accent }], 1)
    layout.y += 6
  }
  layout.paragraph([{ text: level.coverage === null
    ? level.coverageSource === 'none' ? 'Coverage is not shown for this benchmark because CIS did not publish its full recommendation list.' : `Coverage: ${coverageSourceLabel(level.coverageSource)}`
    : `Coverage: ${percent(level.coverage)} (${level.assessedAutomated} of ${level.denominator}), source: ${coverageSourceLabel(level.coverageSource)}`, size: 8.4, style: 'bold', color: PALETTE.ink, lineHeight: 4 }], { after: 3 })
  if (level.notAssessed.length) {
    layout.paragraph([{ text: 'Not assessed identifiers', size: 7, style: 'bold', color: PALETTE.muted, lineHeight: 3.4 }, { text: level.notAssessed.join(', '), size: 7.6, color: PALETTE.body, lineHeight: 3.5, technical: true }], { after: 4 })
  }
  if (level.exceptions?.length) {
    layout.heading(`Accepted exceptions, Level ${level.level}`, { toc: true, keep: 22 })
    table(layout, {
      columns: [{ header: 'Policy and setting', width: 66 }, { header: 'Owner', width: 34 }, { header: 'Expires', width: 22 }, { header: 'Reason', width: 58 }],
      groups: [{ label: '', rows: level.exceptions.map(exception => ({ cells: [
        { text: [item(exception.policyName, 7.4, 'bold'), item(exception.settingId, 6.2, 'normal', PALETTE.faint, true)] },
        { text: [item(exception.owner, 7.2)] },
        { text: [item(exception.expiresOn, 7.2)] },
        { text: [item(exception.reason.length > 300 ? `${exception.reason.slice(0, 300)}...` : exception.reason, 7, 'normal', PALETTE.body)] },
      ] })) }],
    }, `Accepted exceptions, Level ${level.level}`)
  }
  if (level.recommendations?.length) {
    const totals = recommendationTotals(level.recommendations)
    layout.heading(`Recommendation results, Level ${level.level}`, { toc: true, keep: 30 })
    facts(layout, [
      { label: 'Passed', value: String(totals.passed) },
      { label: 'Failed', value: String(totals.failed) },
      { label: 'To review', value: String(totals.review) },
      { label: 'Not assessed', value: String(totals.notAssessed) },
    ], `Recommendation results, Level ${level.level}`)
    table(layout, {
      columns: [{ header: 'Recommendation', width: 86 }, { header: 'Settings', width: 62 }, { header: 'Result', width: 32, align: 'right' }],
      groups: [{ label: '', rows: level.recommendations.map(result => ({
        wash: result.result === 'Fail' ? mixColor(TONES.bad.fill, PALETTE.white, 0.55) : undefined,
        cells: [
          { chip: result.id, text: [item(result.title, 7.4)] },
          { text: result.settings.length ? result.settings.map(setting => item(`${setting.id} ${setting.status}`, 6.6, 'normal', PALETTE.body, true)) : [item('No settings declared', 6.6, 'italic', PALETTE.muted)] },
          { pill: result.result, options: { tone: RESULT_STYLE[result.result].tone, marker: RESULT_STYLE[result.result].marker, markerColor: RESULT_STYLE[result.result].color } },
        ],
      })) }],
    }, `Recommendation results, Level ${level.level}`)
  }
  if (level.manual.length) {
    layout.heading(`Manual recommendations, Level ${level.level}`, { toc: true, keep: 26 })
    for (const manual of level.manual) {
      const blocks: FlowBlock[] = manualHeading(layout, manual.identifier, manual.title)
      if (manual.hasText) {
        for (const [label, value] of [['Description', manual.description], ['Impact', manual.impact], ['Audit', manual.audit], ['Remediation', manual.remediation]] as const) {
          if (value) blocks.push(...labelledBlocks(layout, label, [item(value, 7.4, 'normal', PALETTE.body)]))
        }
      } else {
        blocks.push(...labelledBlocks(layout, 'Manual check', [item(summary.manualFallback, 7.4, 'normal', PALETTE.body), item(summary.manualFallbackUrl, 7.4, 'normal', theme.accentText, true)]))
      }
      layout.ensure(Math.min(blocks.slice(0, 2).reduce((sum, block) => sum + block.height, 0), 100) + 3)
      layout.flow(blocks, { caption: `${caption}, ${manual.identifier}`, card: {} })
      layout.y += 3
    }
  }
}

// Width reserved for the identifier of a manual recommendation; a longer one wraps inside it.
const MANUAL_ID_WIDTH = 60

/**
 * The tinted heading of a manual recommendation: the identifier as a chip, or wrapped inside its
 * column when too long for one, and the title beside it. Long titles and identifiers continue in
 * further blocks, each no taller than a page allows.
 */
function manualHeading(layout: Layout, identifier: string, title: string | undefined): FlowBlock[] {
  const { doc, theme } = layout
  const chip = chipWidth(doc, identifier, 6.8)
  const asChip = chip <= MANUAL_ID_WIDTH
  const idColumn = asChip ? chip : MANUAL_ID_WIDTH
  const titleX = margin + 4 + idColumn + 3
  const idParts = asChip ? [] : layout.chunk(layout.measure([{ text: identifier, size: 6.8, style: 'bold', color: theme.strong, technical: true, lineHeight: 3.1 }], MANUAL_ID_WIDTH))
  const titleParts = title ? layout.chunk(layout.measure([{ text: title, size: 8.6, style: 'bold', color: PALETTE.ink, lineHeight: 3.9 }], contentWidth - 8 - idColumn - 3)) : []
  const count = Math.max(1, idParts.length, titleParts.length)
  return Array.from({ length: count }, (_, index): FlowBlock => {
    const titleLines = titleParts[index] ?? []
    const idLines = idParts[index] ?? []
    const single = count === 1
    const last = index === count - 1
    const pad = index === 0 ? 2.2 : 0
    const content = Math.max(layout.heightOf(titleLines), layout.heightOf(idLines), index === 0 && asChip ? 4.4 : 0)
    const height = single ? Math.max(8.4, content + 4.4) : content + pad + (last ? 2.2 : 0)
    return {
      height: height + (last ? 1.5 : 0),
      draw: top => {
        doc.setFillColor(...PALETTE.panel)
        if (index === 0) {
          doc.roundedRect(margin, top, contentWidth, height, 2, 2, 'F')
          doc.rect(margin, top + height - 2, contentWidth, 2, 'F')
        } else {
          doc.rect(margin, top, contentWidth, height, 'F')
        }
        const align = (own: number) => single ? top + (height - own) / 2 : top + pad
        if (index === 0 && asChip) drawChip(doc, margin + 4, single ? top + (height - 4.4) / 2 : top + pad, identifier, { size: 6.8, fill: theme.primaryTint, color: theme.strong })
        if (idLines.length) layout.drawLines(idLines, margin + 4, align(layout.heightOf(idLines)))
        if (titleLines.length) layout.drawLines(titleLines, titleX, align(layout.heightOf(titleLines)))
      },
    }
  })
}
