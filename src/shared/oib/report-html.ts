import { CHECK_RESULT_COLORS, CONTROL_STATUS_COLORS, formatReportDate } from "../compliance/presentation"
import { redactText } from "../compliance/export"
import { TONES, type MarkerKind, type RgbColor, type Tone } from "../pdf/kit"
import { luminance, resolveBrandTheme, themeCssVariables, type BrandTheme, type PdfBranding } from "../pdf/theme"
import { statusTone, type ReportPayload, type ReportSection, type StatusTone } from "./report"

/**
 * OpenIntuneBaseline reports as a standalone HTML document that the main process prints with
 * Chromium, in the design of the jsPDF framework reports: cover, contents, summary, one table per
 * section and provenance. Chromium prints any script the system has fonts for, so tenant text in
 * Japanese, Chinese, Cyrillic or Greek stays readable. Every interpolated value is redacted and
 * escaped; the document has no scripts and loads nothing: images are data URLs only.
 */

const SLATE: RgbColor = [100, 116, 139]
// Meta values longer than this move from the document control grid into the About panel.
const SHORT_META = 60
// Span units the cover grid holds: three rows of four cells, each value clamped to two lines.
const GRID_UNITS = 12
// Characters of 7.4 pt text that fit across the 180 mm content width, for the column widths.
const LINE_CHARS = 120
const MM_PER_INCH = 25.4

const FONT_STACK = `"Segoe UI Variable", "Segoe UI", -apple-system, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans CJK JP", "Hiragino Sans", "Microsoft YaHei", sans-serif`

const STATUS_STYLE: Record<StatusTone, { tone: Tone; marker: MarkerKind; color: RgbColor }> = {
  good: { tone: "good", marker: "filled", color: CHECK_RESULT_COLORS.matches },
  different: { tone: "warn", marker: "half", color: CHECK_RESULT_COLORS.different },
  missing: { tone: "bad", marker: "triangle", color: CHECK_RESULT_COLORS.missing },
  conflict: { tone: "conflict", marker: "triangle", color: CONTROL_STATUS_COLORS.conflictingEvidence },
  neutral: { tone: "neutral", marker: "outline", color: SLATE },
}

const styleOf = (label: string) => STATUS_STYLE[statusTone(label) ?? "neutral"]
const share = (part: number, whole: number) => whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%"
const count = (value: string) => /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : null
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const rgb = (color: RgbColor) => `rgb(${color[0]} ${color[1]} ${color[2]})`
const fixed = (value: number) => String(Math.round(value * 1000) / 1000)

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
}

/** Redacted, then escaped: the only way report text enters the document. */
const text = (value: string) => escapeHtml(redactText(value))

const MARKER_SHAPES: Record<MarkerKind, string> = {
  filled: `<circle cx="5" cy="5" r="4" class="fg"/>`,
  half: `<circle cx="5" cy="5" r="3.6" class="bg" stroke="currentColor" stroke-width="1"/><path d="M5 1.4A3.6 3.6 0 0 0 5 8.6Z" class="fg"/>`,
  outline: `<circle cx="5" cy="5" r="3.6" class="bg" stroke="currentColor" stroke-width="1"/>`,
  dash: `<rect x="1" y="3.72" width="8" height="2.56" rx="1.2" class="fg"/>`,
  triangle: `<path d="M0.4 8.9L9.6 8.9L5 0.2Z" class="fg"/>`,
}

/** A status marker: the shape carries the status together with its label, never the colour alone. */
const marker = (kind: MarkerKind, color: RgbColor) => `<svg class="mark" viewBox="0 0 10 10" style="color:${rgb(color)}" aria-hidden="true">${MARKER_SHAPES[kind]}</svg>`

/** A status pill with its marker, in the tone of the status. */
function pill(label: string): string {
  const style = styleOf(label)
  return `<span class="pill tone-${style.tone}">${marker(style.marker, style.color)}${text(label.trim())}</span>`
}

/** The TenuVault mark of BrandMark.tsx, in the door colour of the theme with the coral wheel. */
const brandMark = () => `<svg class="brand-mark" viewBox="178 178 668 668" aria-hidden="true"><g fill="var(--door)" fill-rule="evenodd"><path d="M212 512a300 300 0 1 0 600 0a300 300 0 1 0 -600 0ZM274 512a238 238 0 1 0 476 0a238 238 0 1 0 -476 0Z"/><rect x="178" y="392" width="70" height="70" rx="18"/><rect x="178" y="562" width="70" height="70" rx="18"/><path opacity="0.14" d="M300 512a212 212 0 1 0 424 0a212 212 0 1 0 -424 0ZM316 512a196 196 0 1 0 392 0a196 196 0 1 0 -392 0Z"/></g><g fill="#E4674B">${[0, 120, 240].map((angle) => `<g transform="rotate(${angle} 512 512)"><rect x="490" y="362" width="44" height="90"/><circle cx="512" cy="362" r="36"/></g>`).join("")}<path fill-rule="evenodd" d="M434 512a78 78 0 1 0 156 0a78 78 0 1 0 -156 0ZM486 512a26 26 0 1 0 52 0a26 26 0 1 0 -52 0Z"/></g></svg>`

/** Ring segments clockwise from 12 o'clock, as SVG circles with dashes. */
function ring(cx: number, cy: number, r: number, width: number, segments: Array<{ value: number; color: string }>, total: number, track: string): string {
  const circumference = 2 * Math.PI * r
  let start = 0
  const arcs = total > 0 ? segments.map((segment) => {
    const fraction = Math.min(Math.max(segment.value / total, 0), 1 - start)
    if (fraction <= 0) return ""
    const arc = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${segment.color}" stroke-width="${width}" stroke-dasharray="${fixed(fraction * circumference)} ${fixed(circumference)}" stroke-dashoffset="${fixed(-start * circumference)}" transform="rotate(-90 ${cx} ${cy})"/>`
    start += fraction
    return arc
  }).join("") : ""
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${track}" stroke-width="${width}"/>${arcs}`
}

/**
 * Column widths in percent from the text lengths: every column gets room for its longest word and
 * its pills, so short values never break mid word, and the space left goes to the long text.
 */
function columnWidths(section: ReportSection): number[] {
  const sample = section.rows.slice(0, 400)
  const columns = section.columns.map((header, index) => {
    const values = sample.map((row) => row[index] ?? "")
    const lines = values.flatMap((value) => value.split("\n"))
    const words = [...header.split(/\s+/).map((word) => word.length * 1.25), ...lines.flatMap((line) => line.split(/\s+/)).map((word) => Math.min(word.length, 20))]
    const pills = values.filter((value) => statusTone(value)).map((value) => value.trim().length + 5)
    const min = Math.max(5, ...words, ...pills) + 3
    const lengths = lines.map((line) => line.length).sort((a, b) => a - b)
    return { min, want: Math.max(min, Math.min(lengths[Math.floor((lengths.length - 1) * 0.9)] ?? 0, 70) + 3) }
  })
  const minSum = columns.reduce((sum, column) => sum + column.min, 0)
  const growth = columns.reduce((sum, column) => sum + column.want - column.min, 0)
  const spare = Math.max(0, LINE_CHARS - minSum)
  const widths = columns.map((column) => column.min + (growth > spare ? (column.want - column.min) * (spare / growth) : column.want - column.min))
  const total = widths.reduce((sum, width) => sum + width, 0)
  return widths.map((width) => Math.round((width / total) * 1000) / 10)
}

const STYLE = `
@page { size: A4; margin: 21mm 15mm 21mm; }
@page :first { margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; }
body { font-family: ${FONT_STACK}; color: var(--ink); font-size: 7.4pt; line-height: 1.4; }
h1, h2, p { margin: 0; }
.mark { width: 2.75mm; height: 2.75mm; flex: none; overflow: visible; }
.mark .fg { fill: currentColor; }
.mark .bg { fill: var(--mark-bg, var(--white)); }
.cover { position: relative; width: 210mm; height: 297mm; overflow: hidden; break-after: page; }
.band { position: absolute; inset: 0 0 auto 0; height: 134mm; background: var(--primary); color: var(--on-band); }
.band > svg.rings { position: absolute; inset: 0; width: 210mm; height: 134mm; }
.brand { position: absolute; left: 15mm; top: 12mm; display: flex; align-items: center; gap: 2.6mm; height: 9mm; }
.brand-mark { width: 7.4mm; height: 7.4mm; }
.wordmark { font-size: 10pt; font-weight: 700; color: var(--on-band); }
.company { font-size: 11pt; font-weight: 700; color: var(--on-band); max-width: 120mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.logo { display: block; max-width: 44mm; max-height: 14mm; }
.logo.plate { background: var(--white); border-radius: 1.5mm; padding: 2mm 2.5mm; max-width: 49mm; max-height: 18mm; margin: -2mm -2.5mm; }
.accent-bar { position: absolute; left: 15mm; top: 48.5mm; width: 14mm; height: 1.2mm; border-radius: 0.6mm; background: var(--accent); }
.cover-eyebrow { position: absolute; left: 15mm; top: 53.4mm; width: 180mm; font-size: 8.5pt; font-weight: 700; color: var(--band-accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
.cover-titles { position: absolute; left: 15mm; top: 58.5mm; width: 180mm; height: 44mm; display: flex; flex-direction: column; }
.cover-title { font-weight: 700; line-height: 1.12; letter-spacing: -0.01em; color: var(--on-band); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.cover-subtitle { margin-top: 3mm; font-size: 13pt; color: var(--band-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.band-rule { position: absolute; left: 15mm; right: 15mm; top: 104mm; border-top: 0.25mm solid var(--band-rule); }
.tenant { position: absolute; left: 15mm; top: 107.6mm; width: 112mm; }
.tenant .eyebrow { color: var(--band-accent); }
.tenant-name { margin-top: 1.6mm; font-size: 18pt; font-weight: 700; color: var(--on-band); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
.cover-facts { position: absolute; right: 15mm; top: 110.4mm; width: 62mm; text-align: right; font-size: 8pt; line-height: 5mm; }
.cover-facts div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cover-facts span { color: var(--band-muted); margin-right: 1.6mm; }
.cover-facts b { color: var(--on-band); }
.eyebrow { font-size: 6.5pt; font-weight: 700; letter-spacing: 0.25mm; text-transform: uppercase; color: var(--muted); line-height: 1.2; }
.donut-card { position: absolute; left: 15mm; top: 144mm; width: 72mm; height: 70mm; border-radius: 2mm; background: var(--panel); }
.donut-card svg { position: absolute; left: 18mm; top: 10mm; width: 36mm; height: 36mm; }
.donut-value { position: absolute; left: 0; right: 0; top: 21.6mm; text-align: center; font-size: 24pt; font-weight: 700; color: var(--strong); line-height: 1; }
.donut-count { position: absolute; left: 0; right: 0; top: 32.2mm; text-align: center; font-size: 6.6pt; color: var(--muted); }
.donut-caption { position: absolute; left: 4mm; right: 4mm; bottom: 4mm; text-align: center; }
.donut-caption b { display: block; font-size: 8.3pt; color: var(--ink); }
.donut-caption span { display: block; font-size: 7pt; color: var(--muted); margin-top: 0.6mm; }
.glance { position: absolute; left: 95mm; right: 15mm; top: 144mm; }
.glance .eyebrow, .control .eyebrow, .page-eyebrow { color: var(--accent-text); }
.glance-rows { margin-top: 1.4mm; border-top: 0.4mm solid var(--strong); }
.glance-row { display: flex; align-items: center; gap: 2mm; border-bottom: 0.2mm solid var(--rule); font-size: 8.5pt; }
.glance-row .label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.glance-row b { font-size: 11pt; color: var(--strong); }
.glance-row .mark { margin-left: 0.3mm; }
.control { position: absolute; left: 15mm; right: 15mm; top: 222mm; }
.control-grid { margin-top: 1.4mm; border-top: 0.4mm solid var(--strong); display: grid; grid-template-columns: repeat(4, 1fr); }
.control-cell { min-height: 12mm; padding: 3mm 3mm 2mm 0; border-bottom: 0.2mm solid var(--rule); }
.control-cell.span-2 { grid-column: span 2; }
.control-cell span { display: block; font-size: 6.3pt; font-weight: 700; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.control-cell b { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin-top: 0.8mm; font-size: 8.2pt; color: var(--ink); overflow-wrap: anywhere; line-height: 1.3; }
.cover-footer { position: absolute; left: 15mm; right: 15mm; top: 284.6mm; display: flex; justify-content: space-between; gap: 8mm; font-size: 6.5pt; color: var(--muted); white-space: nowrap; }
.cover-footer span:first-child { overflow: hidden; text-overflow: ellipsis; }
.page { break-before: page; }
.page-title { margin-bottom: 4mm; }
.page-eyebrow { font-size: 6.5pt; font-weight: 700; letter-spacing: 0.25mm; text-transform: uppercase; line-height: 1.2; }
h1 { margin-top: 1.6mm; font-size: 20pt; font-weight: 700; line-height: 1.15; color: var(--strong); overflow-wrap: anywhere; }
.lead { margin-top: 1.4mm; max-width: 160mm; font-size: 8.8pt; color: var(--muted); overflow-wrap: anywhere; }
.callout { display: flex; gap: 4mm; padding: 4mm 6mm 4.4mm 4.5mm; margin-bottom: 8mm; border: 0.25mm solid var(--accent-border); border-radius: 2mm; background: var(--accent-wash); }
.callout-icon { flex: none; width: 6mm; height: 6mm; border-radius: 50%; background: var(--accent-text); color: var(--white); font-size: 9pt; font-weight: 700; text-align: center; line-height: 6mm; }
.callout b { display: block; font-size: 8.8pt; color: var(--accent-text); }
.callout p { margin-top: 1.2mm; font-size: 8.4pt; color: var(--ink); overflow-wrap: anywhere; }
.contents h1 { margin: 0; padding-bottom: 1.6mm; border-bottom: 0.4mm solid var(--strong); }
.contents ol { list-style: none; margin: 4mm 0 0; padding: 0; }
.contents a { display: flex; justify-content: space-between; gap: 6mm; color: inherit; text-decoration: none; }
.toc-top > a { padding: 2.2mm 0 1.6mm; border-bottom: 0.2mm solid var(--rule); font-size: 8.6pt; font-weight: 700; color: var(--ink); }
.toc-top ol { margin: 0.6mm 0 0; }
.toc-sub a { padding: 0.5mm 0 0.5mm 6mm; font-size: 7.4pt; color: var(--body); }
.toc-sub a span:last-child { color: var(--muted); white-space: nowrap; }
.contents a span:first-child { overflow-wrap: anywhere; }
.tiles { display: flex; gap: 4mm; margin-bottom: 5mm; break-inside: avoid; }
.tile { flex: 1 1 0; min-width: 0; height: 28mm; padding: 4.4mm 4mm 0; border: 0.25mm solid var(--border); border-radius: 2mm; }
.tile .key { display: flex; align-items: center; gap: 1.2mm; font-size: 5.6pt; font-weight: 700; letter-spacing: 0.1mm; text-transform: uppercase; color: var(--muted); line-height: 1.2; min-height: 3.2mm; }
.tile .key span { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.tile .value { margin-top: 1.6mm; font-size: 22pt; font-weight: 700; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile .caption { margin-top: 1.6mm; font-size: 6.8pt; color: var(--muted); }
/* Painted as one unit: Chromium otherwise repeats the text of a heading it moves to the next page in the bookmark. */
.heading { margin: 0 0 2.2mm; font-size: 10.5pt; font-weight: 700; color: var(--strong); line-height: 1.2; break-after: avoid; overflow: hidden; contain: paint; }
.heading .mark { display: inline-block; width: 3.25mm; height: 3.25mm; margin-right: 1.8mm; vertical-align: -0.3mm; }
.heading .title { display: block; padding-right: 24mm; font-size: inherit; overflow-wrap: anywhere; }
.heading .note { display: block; margin-top: -3.35mm; padding-bottom: 0.5mm; text-align: right; font-size: 7pt; font-weight: 400; line-height: 1.2; color: var(--muted); }
.distribution { margin-bottom: 5mm; break-inside: avoid; }
.bar { display: flex; gap: 0.6mm; height: 4mm; border-radius: 2mm; overflow: hidden; background: var(--track); }
.bar span { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 1.2mm 6mm; margin-top: 2.6mm; font-size: 7pt; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 1.2mm; }
.legend b { color: var(--ink); }
.legend .mark { width: 2.5mm; height: 2.5mm; }
.facts { margin-bottom: 4mm; }
.fact-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8mm; padding: 2.4mm 0 2.2mm; border-bottom: 0.2mm solid var(--rule); break-inside: avoid; }
.fact-row.wide { grid-template-columns: 1fr; }
.fact span { display: block; font-size: 6.4pt; font-weight: 700; color: var(--muted); }
.fact b { display: block; margin-top: 0.8mm; font-size: 8.4pt; color: var(--ink); overflow-wrap: anywhere; white-space: pre-line; }
.section { margin-bottom: 4mm; }
.section-head { break-inside: avoid; break-after: avoid; }
.section-head .heading { break-after: auto; }
.section-lead { margin: -0.6mm 0 2mm; font-size: 7.6pt; color: var(--muted); overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead { display: table-header-group; }
th { padding: 0 1.5mm 1.4mm; text-align: left; vertical-align: bottom; font-size: 5.6pt; font-weight: 700; letter-spacing: 0.2mm; text-transform: uppercase; color: var(--muted); border-bottom: 0.4mm solid var(--strong); overflow-wrap: anywhere; line-height: 1.25; }
td { padding: 1.9mm 1.5mm; vertical-align: top; border-bottom: 0.2mm solid var(--rule); overflow-wrap: anywhere; white-space: pre-line; font-size: 7.4pt; color: var(--ink); }
tbody tr:nth-child(even) td { background: var(--zebra); }
tr { break-inside: avoid; }
.pill { display: inline-flex; align-items: center; gap: 1.3mm; max-width: 100%; padding: 0.55mm 2.2mm 0.55mm 1.6mm; border-radius: 2.1mm; font-size: 6.2pt; font-weight: 700; line-height: 1.25; white-space: normal; }
.pill .mark { width: 2.5mm; height: 2.5mm; }
${(Object.keys(TONES) as Tone[]).map((tone) => `.tone-${tone} { color: var(--${tone}-text); background: var(--${tone}-fill); --mark-bg: var(--${tone}-fill); }`).join("\n")}
.empty { font-size: 7.6pt; font-style: italic; color: var(--muted); margin: 0 0 6mm; }
.provenance { margin-top: 10mm; break-inside: avoid; }
.attribution { font-size: 8.4pt; color: var(--body); overflow-wrap: anywhere; }
`

/** The resolved theme as CSS custom properties on the root element. */
const rootVariables = (theme: BrandTheme) => `:root { ${Object.entries(themeCssVariables(theme)).map(([name, value]) => `${name}: ${value};`).join(" ")} }`

/** Text for a CSS string: shortened to `max` (wide characters count twice) and every character outside a safe set escaped. */
function cssString(value: string, max: number): string {
  let width = 0
  let clipped = ""
  // Control characters become spaces; they have no place in a one line label.
  // oxlint-disable-next-line no-control-regex
  for (const char of redactText(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim()) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(char) || char.length > 1 ? 2 : 1
    if (width > max) {
      clipped = `${clipped.trimEnd()}...`
      break
    }
    clipped += char
  }
  return `"${[...clipped].map((char) => /[A-Za-z0-9 .,:;|()_-]/.test(char) ? char : `\\${char.codePointAt(0)!.toString(16)} `).join("")}"`
}

/**
 * The running header (report name left, tenant right) and footer (footer text left, "Page X of Y"
 * right) as CSS page margin boxes on every page but the cover. printToPDF header and footer
 * templates also print on the cover whatever its @page margins are; margin boxes follow @page :first.
 */
function runningHeaderFooter(report: ReportPayload, tenant: string, footer: string): string {
  const box = `font-family: ${FONT_STACK}; font-size: 6.5pt; line-height: 1.2; color: var(--muted);`
  const top = `${box} vertical-align: bottom; margin-bottom: 6.4mm; padding-bottom: 1.6mm; border-bottom: 0.2mm solid var(--rule);`
  const bottom = `${box} vertical-align: top; margin-top: 6.5mm; padding-top: 2.4mm; border-top: 0.2mm solid var(--rule);`
  return `@page {
  @top-left { content: ${cssString(report.title, 64)}; ${top} width: 110mm; font-weight: 700; letter-spacing: 0.15mm; color: var(--strong); }
  @top-right { content: ${cssString(tenant, 52)}; ${top} width: 70mm; text-align: right; }
  @bottom-left { content: ${cssString(footer, 76)}; ${bottom} width: 130mm; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); ${bottom} width: 50mm; text-align: right; }
}
@page :first { @top-left { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
`
}

/** printToPDF options of an OIB report: A4, backgrounds and bookmarks from the headings; the page margins and running header and footer come from the CSS @page rules. */
export interface OibPrintOptions {
  pageSize: "A4"
  printBackground: true
  preferCSSPageSize: true
  displayHeaderFooter: false
  generateDocumentOutline: true
  /** Chromium builds the bookmarks from the tagged structure, so the PDF is tagged as well. */
  generateTaggedPDF: true
  /** In inches, as Electron expects them; the same margins as the CSS @page rule. */
  margins: { top: number; bottom: number; left: number; right: number }
}

export interface OibReportDocument {
  html: string
  print: OibPrintOptions
}

/**
 * The HTML document and print options of an OIB report. `branding` is the branding the tenant's
 * plan allows (main resolves it); without it, or without a company name, the TenuVault design is used.
 */
export function buildOibReport(report: ReportPayload, options: { exportedAt: string; branding?: PdfBranding }): OibReportDocument {
  const theme = resolveBrandTheme(options.branding)
  const tenantEntry = report.meta.find(([label]) => label.trim().toLowerCase() === "tenant")
  const tenant = tenantEntry?.[1].trim() || report.tenantId
  const others = report.meta.filter((entry) => entry !== tenantEntry)
  const short = others.filter(([, value]) => value.length <= SHORT_META)
  const long = others.filter(([, value]) => value.length > SHORT_META)
  const exported = formatReportDate(options.exportedAt)
  const eyebrow = report.eyebrow ?? "OpenIntuneBaseline report"
  // A white label report names the customer in the footer and nowhere names TenuVault.
  const footer = theme.companyName ? theme.footerText ?? theme.companyName : `TenuVault | ${eyebrow}`

  const summary = (report.summary ?? []).map(([label, value]) => ({ label, value, count: count(value), style: styleOf(label), good: statusTone(label) === "good" }))
  const counted = summary.filter((entry) => entry.count !== null)
  const total = counted.reduce((sum, entry) => sum + entry.count!, 0)
  const good = counted.filter((entry) => entry.good).reduce((sum, entry) => sum + entry.count!, 0)
  const goodLabel = counted.find((entry) => entry.good)?.label

  // Cover
  const brand = theme.companyName
    ? theme.logoDataUrl
      // A transparent PNG on a dark band sits on a white plate, as on the jsPDF cover.
      ? `<img class="logo${!theme.logoDataUrl.startsWith("data:image/jp") && luminance(theme.primary) <= 0.5 ? " plate" : ""}" src="${escapeHtml(theme.logoDataUrl)}" alt="${escapeHtml(theme.companyName)}">`
      : `<span class="company">${text(theme.companyName)}</span>`
    : `${brandMark()}<span class="wordmark">TenuVault</span>`
  const titleSize = report.title.length <= 22 ? 36 : report.title.length <= 30 ? 30 : report.title.length <= 60 ? 26 : 22
  const coverFacts: Array<[string, string]> = [...short.filter(([, value]) => value.length <= 32).slice(0, 1), ["Exported", exported]]
  const ringSvg = `<svg class="rings" viewBox="0 0 210 134" aria-hidden="true"><circle cx="173" cy="55" r="70" fill="none" stroke="var(--ring-soft)" stroke-width="0.6"/><circle cx="173" cy="55" r="38" fill="none" stroke="var(--ring-soft)" stroke-width="0.6"/>${ring(173, 55, 56, 10, [{ value: total ? good / total : 0, color: "var(--ring-strong)" }], 1, "var(--ring-soft)")}</svg>`
  const donut = `<svg viewBox="0 0 36 36" aria-hidden="true">${ring(18, 18, 15.8, 4.4, counted.map((entry) => ({ value: entry.count!, color: rgb(entry.style.color) })), Math.max(total, 1), "var(--track)")}</svg>`
  const rowHeight = summary.length > 5 ? 6.6 : summary.length > 4 ? 7.6 : 9.6
  const glance = summary.map((entry) => `<div class="glance-row" style="height:${rowHeight}mm">${marker(entry.style.marker, entry.style.color)}<span class="label">${text(entry.label)}</span><b>${text(entry.value)}</b></div>`).join("")

  // Document control: the fixed cells always print; meta fills the rest, and the full list is in Report details.
  const fixedCells = [
    { label: "Tenant ID", value: report.tenantId, span: 2 },
    { label: "Exported", value: exported, span: 1 },
    ...(theme.preparedBy ? [{ label: "Prepared by", value: theme.preparedBy, span: theme.preparedBy.length > 26 ? 2 : 1 }] : []),
    ...(theme.classification ? [{ label: "Classification", value: theme.classification, span: theme.classification.length > 26 ? 2 : 1 }] : []),
  ]
  const metaCells = short.map(([label, value]) => ({ label, value, span: value.length > 26 ? 2 : 1 }))
  const fixedUnits = fixedCells.reduce((sum, cell) => sum + cell.span, 0)
  const shown: typeof metaCells = []
  let units = fixedUnits
  for (const cell of metaCells) {
    // One unit stays free for the note that points to Report details when a cell does not fit.
    const room = GRID_UNITS - units - (metaCells.length > shown.length + 1 ? 1 : 0)
    if (cell.span > room) break
    shown.push(cell)
    units += cell.span
  }
  const omitted = metaCells.length - shown.length
  const controlCells = [...shown, ...fixedCells, ...(omitted ? [{ label: "More details", value: `${plural(omitted, "more entry", "more entries")} in Report details`, span: 1 }] : [])]
  const control = controlCells.map((cell) => `<div class="control-cell${cell.span === 2 ? " span-2" : ""}"><span>${text(cell.label)}</span><b>${text(cell.value)}</b></div>`).join("")

  const cover = `<section class="cover">
<div class="band">${ringSvg}<div class="brand">${brand}</div><div class="accent-bar"></div>
<p class="cover-eyebrow">${text(eyebrow)}</p>
<div class="cover-titles"><p class="cover-title" style="font-size:${titleSize}pt">${text(report.title)}</p>${report.subtitle ? `<p class="cover-subtitle">${text(report.subtitle)}</p>` : ""}</div>
<div class="band-rule"></div>
<div class="tenant"><p class="eyebrow">Tenant</p><p class="tenant-name">${text(tenant)}</p></div>
<div class="cover-facts">${coverFacts.map(([label, value]) => `<div><span>${text(label)}</span><b>${text(value)}</b></div>`).join("")}</div>
</div>
<div class="donut-card">${donut}<p class="donut-value">${share(good, total)}</p><p class="donut-count">${good} of ${plural(total, "policy", "policies")}</p><p class="donut-caption"><b>${text(goodLabel ?? "Summary")}</b><span>Configuration comparison only, not a compliance score</span></p></div>
<div class="glance"><p class="eyebrow">At a glance</p><div class="glance-rows">${glance}</div></div>
<div class="control"><p class="eyebrow">Document control</p><div class="control-grid">${control}</div></div>
<div class="cover-footer"><span>${text(footer)}</span><span>Configuration comparison, not a certification</span></div>
</section>`

  // Contents, with the About panel for the long meta values
  const sectionId = (index: number) => `section-${index + 1}`
  const about = long.length ? `<div class="callout"><div class="callout-icon">!</div><div><b>About this report</b>${long.map(([label, value]) => `<p>${text(`${label}: ${value}`)}</p>`).join("")}</div></div>` : ""
  const contents = `<section class="page contents">${about}<h1>Contents</h1><ol>
<li class="toc-top"><a href="#summary"><span>Summary</span><span></span></a></li>
<li class="toc-top"><a href="#results"><span>Results</span><span></span></a><ol>${report.sections.map((section, index) => `<li class="toc-sub"><a href="#${sectionId(index)}"><span>${text(section.heading)}</span><span>${plural(section.rows.length, "row", "rows")}</span></a></li>`).join("")}</ol></li>
<li class="toc-top"><a href="#provenance"><span>Provenance and attribution</span><span></span></a></li>
</ol></section>`

  // Summary
  const perRow = counted.length > 5 ? 4 : 5
  const tileRows: string[] = []
  for (let start = 0; start < counted.length; start += perRow) {
    tileRows.push(`<div class="tiles">${counted.slice(start, start + perRow).map((entry) => `<div class="tile"><div class="key">${marker(entry.style.marker, entry.style.color)}<span>${text(entry.label)}</span></div><div class="value" style="color:${entry.count ? `var(--${entry.style.tone}-text)` : "var(--faint)"}">${text(entry.value)}</div><div class="caption">${share(entry.count!, total)} of ${plural(total, "policy", "policies")}</div></div>`).join("")}</div>`)
  }
  const distribution = counted.length ? `<div class="distribution"><div class="heading"><p class="title">Status distribution</p><span class="note">${plural(total, "policy", "policies")}</span></div>
<div class="bar">${counted.filter((entry) => entry.count! > 0).map((entry) => `<span style="flex:${entry.count} 1 0;background:${rgb(entry.style.color)}"></span>`).join("")}</div>
<div class="legend">${counted.filter((entry) => entry.count! > 0).map((entry) => `<span>${marker(entry.style.marker, entry.style.color)}<b>${entry.count}</b>${text(entry.label)}, ${share(entry.count!, total)}</span>`).join("")}</div></div>` : ""
  const facts = (items: Array<{ label: string; value: string; wide?: boolean }>) => {
    const rows: Array<typeof items> = []
    for (const item of items) {
      const current = rows[rows.length - 1]
      if (item.wide || !current || current.length === 2 || current[0]!.wide) rows.push([item])
      else current.push(item)
    }
    return `<div class="facts">${rows.map((row) => `<div class="fact-row${row[0]!.wide ? " wide" : ""}">${row.map((item) => `<div class="fact"><span>${text(item.label)}</span><b>${text(item.value)}</b></div>`).join("")}</div>`).join("")}</div>`
  }
  const summaryPage = `<section class="page" id="summary"><div class="page-title"><p class="page-eyebrow">Summary</p><h1>Summary</h1>${report.subtitle ? `<p class="lead">${text(report.subtitle)}</p>` : ""}</div>
${tileRows.join("")}${distribution}
<div class="heading"><p class="title">Report details</p></div>
${facts([{ label: "Tenant", value: tenant, wide: tenant.length > 40 }, ...others.map(([label, value]) => ({ label, value, wide: value.length > 40 }))])}
</section>`

  // Results
  const results = report.sections.map((section, index) => {
    const status = statusTone(section.heading)
    // The note sits outside the h2, so the bookmark reads as the section name.
    const heading = `<div class="heading"><h2 class="title">${status ? marker(styleOf(section.heading).marker, styleOf(section.heading).color) : ""}${text(section.heading)}</h2><span class="note">${plural(section.rows.length, "row", "rows")}</span></div>`
    const lead = section.note ? `<p class="section-lead">${text(section.note)}</p>` : ""
    const body = section.rows.length
      ? `<table><colgroup>${columnWidths(section).map((width) => `<col style="width:${width}%">`).join("")}</colgroup><thead><tr>${section.columns.map((column) => `<th>${text(column)}</th>`).join("")}</tr></thead><tbody>${section.rows.map((row) => `<tr>${row.map((value) => `<td>${statusTone(value) ? pill(value) : text(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : `<p class="empty">Nothing to report.</p>`
    return `<section class="section" id="${sectionId(index)}"><div class="section-head">${heading}${lead}</div>${body}</section>`
  }).join("\n")
  const resultsPage = `<section class="page" id="results"><div class="page-title"><p class="page-eyebrow">Results</p><h1>Results</h1></div>
${results}</section>`

  // Provenance; the content licence prints verbatim, also on white label reports.
  const provenance = `<section class="provenance" id="provenance"><div class="page-title"><p class="page-eyebrow">Provenance</p><h1>Provenance and attribution</h1></div>
${facts([
    { label: "Report", value: report.title, wide: true },
    { label: "Tenant ID", value: report.tenantId },
    { label: "Exported", value: exported },
    ...(theme.companyName ? [] : [{ label: "Generated by", value: "TenuVault" }]),
    { label: "Source", value: "Results shown in the app at the time of export; the tenant was not read again.", wide: true },
  ])}${report.attribution ? `<p class="attribution">${text(report.attribution)}</p>` : ""}</section>`

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${text(report.title)}</title><style>${rootVariables(theme)}${STYLE}${runningHeaderFooter(report, tenant, footer)}</style></head><body>
${cover}
${contents}
${summaryPage}
${resultsPage}
${provenance}
</body></html>`

  return {
    html,
    print: {
      pageSize: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
      margins: { top: 21 / MM_PER_INCH, bottom: 21 / MM_PER_INCH, left: 15 / MM_PER_INCH, right: 15 / MM_PER_INCH },
    },
  }
}
