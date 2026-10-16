import { CHECK_RESULT_COLORS, CONTROL_STATUS_COLORS, formatReportDate } from '../compliance/presentation'
import { redactText } from '../compliance/export'
import { PALETTE, TONES, ascii, pillMetrics, textWidth, type MarkerKind, type RgbColor, type Tone } from '../pdf/kit'
import { PAGE, createLayout, type Layout } from '../pdf/layout'
import { callout, distribution, drawCover, facts, kpiRow, tableSection, type Cell, type Fact, type GlanceRow, type LegendItem } from '../pdf/blocks'
import { resolveBrandTheme, type PdfBranding } from '../pdf/theme'
import { statusTone, type ReportPayload, type ReportSection, type StatusTone } from './report'

const { contentWidth } = PAGE
const SLATE: RgbColor = [100, 116, 139]
// Meta values longer than this move from the document control grid into the About panel.
const SHORT_META = 60
// Rows sampled to size the columns of a long table.
const SAMPLE_ROWS = 400

const STATUS_STYLE: Record<StatusTone, { tone: Tone; marker: MarkerKind; color: RgbColor }> = {
  good: { tone: 'good', marker: 'filled', color: CHECK_RESULT_COLORS.matches },
  different: { tone: 'warn', marker: 'half', color: CHECK_RESULT_COLORS.different },
  missing: { tone: 'bad', marker: 'triangle', color: CHECK_RESULT_COLORS.missing },
  conflict: { tone: 'conflict', marker: 'triangle', color: CONTROL_STATUS_COLORS.conflictingEvidence },
  neutral: { tone: 'neutral', marker: 'outline', color: SLATE },
}

const styleOf = (label: string) => STATUS_STYLE[statusTone(label) ?? 'neutral']
const share = (part: number, whole: number) => whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%'
const count = (value: string) => /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : null
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
// Identifiers, paths and URLs without spaces also break after punctuation.
const technical = (value: string) => /\S{24,}/.test(value)

/** Column widths in mm from the measured text: room for the longest word and the pills, the rest to long text. */
function columnWidths(layout: Layout, section: ReportSection): number[] {
  const { doc } = layout
  const sample = section.rows.slice(0, SAMPLE_ROWS)
  const columns = section.columns.map((header, index) => {
    const values = sample.map(row => row[index] ?? '')
    const lines = values.flatMap(value => value.split('\n'))
    const words = lines.flatMap(line => line.split(/\s+/)).map(word => Math.min(textWidth(doc, word, 7.4), 34))
    const pills = values.filter(value => statusTone(value)).map(value => pillMetrics(doc, value.trim(), { tone: 'good', marker: 'filled', small: true }).width)
    // The cell pads 1.5 mm on each side; one more mm keeps a word that only just fits from breaking.
    const min = Math.max(8, textWidth(doc, header.toUpperCase(), 5.6, 'bold', 0.2), ...pills, ...words) + 4
    const widths = lines.map(line => textWidth(doc, line, 7.4)).sort((a, b) => a - b)
    return { min, want: Math.max(min, Math.min((widths[Math.floor((widths.length - 1) * 0.9)] ?? 0) + 3, 110)) }
  })
  const minSum = columns.reduce((sum, column) => sum + column.min, 0)
  if (minSum >= contentWidth) return columns.map(column => (column.min / minSum) * contentWidth)
  const growth = columns.reduce((sum, column) => sum + column.want - column.min, 0)
  const spare = contentWidth - minSum
  const widths = columns.map(column => column.min + (growth > 0 ? (column.want - column.min) * Math.min(spare / growth, 1) : 0))
  const total = widths.reduce((sum, width) => sum + width, 0)
  return widths.map(width => (width / total) * contentWidth)
}

function cellOf(value: string): Cell {
  const tone = statusTone(value)
  if (tone) return { pill: value.trim(), options: { tone: STATUS_STYLE[tone].tone, marker: STATUS_STYLE[tone].marker, markerColor: STATUS_STYLE[tone].color } }
  return { text: [{ text: value, size: 7.4, color: PALETTE.ink, technical: technical(value) }] }
}

/**
 * An OpenIntuneBaseline report (Existing Deployment comparison or Policy Validation) in the design of
 * the framework reports: cover, contents and bookmarks, summary, one table per section with status
 * pills, provenance and the content attribution. Every string is redacted and normalised to WinAnsi.
 */
export function generateOibReportPDF(report: ReportPayload, options: { exportedAt: string; branding?: PdfBranding }): Uint8Array<ArrayBuffer> {
  const theme = resolveBrandTheme(options.branding)
  const tenantEntry = report.meta.find(([label]) => label.trim().toLowerCase() === 'tenant')
  const tenant = tenantEntry?.[1].trim() || report.tenantId
  const others = report.meta.filter(entry => entry !== tenantEntry)
  const short = others.filter(([, value]) => value.length <= SHORT_META)
  const long = others.filter(([, value]) => value.length > SHORT_META)
  const exported = formatReportDate(options.exportedAt)
  const eyebrow = report.eyebrow ?? 'OpenIntuneBaseline report'
  const layout = createLayout({
    shortName: report.title, tenant, footer: eyebrow,
    sanitize: value => ascii(redactText(value)),
    properties: { title: report.title, subject: eyebrow, keywords: 'Intune, OpenIntuneBaseline, configuration, comparison' },
    exportedAt: options.exportedAt,
    // Only non secret identifiers: the id is written into the file unencrypted.
    identity: ['oib', report.title, report.subtitle ?? null, report.tenantId, options.exportedAt, theme.companyName ?? null],
    theme,
  })

  const summary = (report.summary ?? []).map(([label, value]) => ({ label, value, count: count(value), style: styleOf(label), good: statusTone(label) === 'good' }))
  const counted = summary.filter(entry => entry.count !== null)
  const total = counted.reduce((sum, entry) => sum + entry.count!, 0)
  const good = counted.filter(entry => entry.good).reduce((sum, entry) => sum + entry.count!, 0)
  const goodLabel = counted.find(entry => entry.good)?.label

  drawCover(layout, {
    eyebrow, title: report.title, subtitle: report.subtitle, tenant,
    facts: [...short.filter(([, value]) => value.length <= 32).slice(0, 1), ['Exported', exported]],
    ring: total ? good / total : 0,
    donuts: [{ segments: counted.map(entry => ({ value: entry.count!, color: entry.style.color })), total, value: share(good, total) }],
    donutCount: `${good} of ${plural(total, 'policy', 'policies')}`,
    donutCaption: goodLabel ?? 'Summary', donutSub: 'Configuration comparison only, not a compliance score',
    glance: summary.map((entry): GlanceRow => ({ label: entry.label, value: entry.value, marker: entry.style.marker, color: entry.style.color })),
    control: [
      ...short.map(([label, value]) => ({ label, value, span: value.length > 26 ? 2 as const : 1 as const })),
      { label: 'Tenant ID', value: report.tenantId, span: 2 },
      { label: 'Exported', value: exported },
    ],
    footerRight: 'Configuration comparison, not a certification',
  })
  layout.contentsPage(long.length ? top => callout(layout, { title: 'About this report', tone: 'accent', body: long.map(([label, value]) => ({ text: `${label}: ${value}` })) }, top) : undefined)

  layout.pageTitle('Summary', 'Summary', { lead: report.subtitle })
  if (counted.length) {
    for (let start = 0; start < counted.length; start += counted.length > 5 ? 4 : 5) {
      kpiRow(layout, counted.slice(start, start + (counted.length > 5 ? 4 : 5)).map(entry => ({
        label: entry.label, value: entry.value, caption: `${share(entry.count!, total)} of ${plural(total, 'policy', 'policies')}`,
        marker: entry.style.marker, markerColor: entry.style.color, valueColor: entry.count ? TONES[entry.style.tone].text : PALETTE.faint,
      })))
    }
    distribution(layout, { title: 'Status distribution', note: plural(total, 'policy', 'policies'), total, items: counted.map((entry): LegendItem => ({ label: entry.label, count: entry.count!, marker: entry.style.marker, color: entry.style.color })) })
  }
  layout.heading('Report details', { keep: 14 })
  facts(layout, [
    { label: 'Tenant', value: tenant, wide: tenant.length > 40 },
    ...others.map(([label, value]): Fact => ({ label, value, wide: value.length > 40, technical: technical(value) })),
  ], 'Report details')

  layout.pageTitle('Results', 'Results')
  for (const section of report.sections) {
    const widths = columnWidths(layout, section)
    tableSection(layout, {
      title: section.heading, note: plural(section.rows.length, 'row', 'rows'), lead: section.note, toc: true,
      ...(statusTone(section.heading) && { marker: { kind: styleOf(section.heading).marker, color: styleOf(section.heading).color } }),
      columns: section.columns.map((header, index) => ({ header, width: widths[index] })),
      rows: section.rows.map(row => row.map(cellOf)),
    })
  }

  layout.pageTitle('Provenance', 'Provenance and attribution', { newPage: false })
  facts(layout, [
    { label: 'Report', value: report.title, wide: true },
    { label: 'Tenant ID', value: report.tenantId, technical: true },
    { label: 'Exported', value: exported },
    // Like the framework reports, a white label report does not name the tool that produced it.
    ...(theme.companyName ? [] : [{ label: 'Generated by', value: 'TenuVault' }]),
    { label: 'Source', value: 'Results shown in the app at the time of export; the tenant was not read again.', wide: true },
  ], 'Provenance')
  // The content licence is printed verbatim, also on white label reports.
  if (report.attribution) layout.paragraph([{ text: report.attribution, size: 8.4, color: PALETTE.body, lineHeight: 3.9 }], { after: 3 })
  return layout.finish()
}
