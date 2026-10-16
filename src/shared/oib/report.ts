/** Printable reports (PDF through the main process) and CSV exports, built from plain text only. */

export interface ReportSection {
  heading: string
  note?: string
  columns: string[]
  rows: string[][]
}

export interface Report {
  title: string
  subtitle?: string
  /** Small uppercase line above the title in the header band. */
  eyebrow?: string
  meta: Array<[string, string]>
  summary?: Array<[string, string]>
  sections: ReportSection[]
  footer?: string
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

type Tone = "good" | "partial" | "missing" | "alert" | "neutral"

/** Status words the OIB reports print, shown as pills with a marker shape so status never relies on colour alone. */
const STATUS_TONES: Record<string, Tone> = {
  "Matches the baseline": "good",
  "Match the baseline": "good",
  "Up to date": "good",
  "Drift detected": "partial",
  "Value mismatch": "partial",
  "Update available": "partial",
  "Missing in tenant": "missing",
  "New policy": "missing",
  "Validation error": "alert",
  "Error": "alert",
  "Errors": "alert",
  "Ambiguous match": "alert",
  "Not validated": "neutral",
  "Only in tenant": "neutral",
  "Newer than OIB": "neutral",
}

const toneOf = (value: string): Tone | undefined => Object.hasOwn(STATUS_TONES, value.trim()) ? STATUS_TONES[value.trim()] : undefined

const MARKERS: Record<Tone, string> = {
  good: `<circle cx="5" cy="5" r="4"/>`,
  partial: `<circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5 1.6a3.4 3.4 0 0 1 0 6.8Z"/>`,
  missing: `<circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.4"/>`,
  alert: `<path d="M5 0.8L9.4 9H0.6Z"/>`,
  neutral: `<rect x="1.6" y="1.6" width="6.8" height="6.8" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>`,
}

const marker = (tone: Tone) => `<svg class="mark" viewBox="0 0 10 10" aria-hidden="true">${MARKERS[tone]}</svg>`

const BRAND_MARK = `<svg class="brand-mark" viewBox="178 178 668 668" aria-hidden="true"><g fill="#F4F3F1" fill-rule="evenodd"><path d="M212 512a300 300 0 1 0 600 0a300 300 0 1 0 -600 0ZM274 512a238 238 0 1 0 476 0a238 238 0 1 0 -476 0Z"/><rect x="178" y="392" width="70" height="70" rx="18"/><rect x="178" y="562" width="70" height="70" rx="18"/><path opacity="0.14" d="M300 512a212 212 0 1 0 424 0a212 212 0 1 0 -424 0ZM316 512a196 196 0 1 0 392 0a196 196 0 1 0 -392 0Z"/></g><g fill="#E4674B">${[0, 120, 240].map((a) => `<g transform="rotate(${a} 512 512)"><rect x="490" y="362" width="44" height="90"/><circle cx="512" cy="362" r="36"/></g>`).join("")}<path fill-rule="evenodd" d="M434 512a78 78 0 1 0 156 0a78 78 0 1 0 -156 0ZM486 512a26 26 0 1 0 52 0a26 26 0 1 0 -52 0Z"/></g></svg>`

/** Page margins in inches: page 1 starts at the top edge for the header band (see @page :first), the bottom holds the running footer. */
const MARGINS = { top: 0.55, bottom: 0.6, left: 0, right: 0 }

/** printToPDF options for reportHtml documents; the footer reads the document title and the page numbers from Chromium. */
export const REPORT_PRINT_OPTIONS = {
  printBackground: true,
  pageSize: "A4",
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate: `<div style="box-sizing:border-box;width:100%;padding:0 14mm 1mm;display:flex;justify-content:space-between;gap:8mm;font-family:'Segoe UI Variable','Segoe UI',-apple-system,'Helvetica Neue',Arial,sans-serif;font-size:7px;color:#76716B;"><span style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;"><span style="color:#161514;font-weight:600;">TenuVault</span> | <span class="title"></span></span><span style="white-space:nowrap;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
  margins: MARGINS,
} as const

const STYLE = `
  @page { size: A4; margin: ${MARGINS.top}in 0 ${MARGINS.bottom}in; }
  @page :first { margin-top: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Segoe UI Variable", "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif; color: #161514; font-size: 9.5px; line-height: 1.45; }
  .band { background: #161514; color: #F4F3F1; padding: 11mm 14mm 8mm; }
  .brand { display: flex; align-items: center; gap: 2.4mm; margin-bottom: 13mm; }
  .brand-mark { width: 7mm; height: 7mm; }
  .wordmark { font-size: 13px; font-weight: 600; letter-spacing: 0.01em; color: #FFFFFF; }
  .accent { width: 11mm; height: 0.9mm; background: #E4674B; border-radius: 0.45mm; margin-bottom: 3.2mm; }
  .eyebrow { font-size: 7.5px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #A39E98; margin: 0 0 1.6mm; }
  h1 { font-size: 26px; line-height: 1.15; font-weight: 600; margin: 0; color: #FFFFFF; letter-spacing: -0.01em; }
  .subtitle { font-size: 12px; color: #D2CEC9; margin: 2mm 0 0; }
  .facts { margin-top: 9mm; padding-top: 4mm; border-top: 0.25mm solid #45423E; }
  .hero dt, .facts dt { font-size: 6.5px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #A39E98; margin: 0 0 0.8mm; }
  .hero { margin: 0 0 4mm; } .hero dd { margin: 0; font-size: 17px; font-weight: 500; color: #FFFFFF; overflow-wrap: anywhere; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3.2mm 6mm; margin: 0; }
  .grid div.wide { grid-column: 1 / -1; }
  .grid dd { margin: 0; font-size: 9.5px; color: #EEECE9; overflow-wrap: anywhere; }
  main { padding: 0 14mm; }
  .label { font-size: 7px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #C94B30; margin: 7mm 0 2.4mm; }
  .tiles { display: flex; gap: 3mm; }
  .tile { flex: 1 1 0; min-width: 0; background: #FFFFFF; border: 0.25mm solid #E4E1DD; border-radius: 2mm; padding: 3mm 3.4mm 3.2mm; break-inside: avoid; }
  .tile .k { display: flex; align-items: center; gap: 1.4mm; font-size: 6.5px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #76716B; min-height: 2.4em; }
  .tile .v { display: block; font-size: 21px; font-weight: 600; line-height: 1.1; margin-top: 1.4mm; color: #161514; font-variant-numeric: tabular-nums; }
  section { margin-top: 7mm; }
  h2 { display: flex; align-items: center; gap: 1.8mm; font-size: 12.5px; font-weight: 600; margin: 0 0 1mm; break-after: avoid; page-break-after: avoid; overflow-wrap: anywhere; }
  .note { color: #5C5853; margin: 0 0 1.6mm; break-after: avoid; page-break-after: avoid; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 2mm; }
  thead { display: table-header-group; }
  th { text-align: left; vertical-align: bottom; font-size: 6.5px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #5C5853; padding: 0 2mm 1.4mm; border-bottom: 0.4mm solid #161514; overflow-wrap: anywhere; }
  td { text-align: left; vertical-align: top; padding: 1.6mm 2mm; border-bottom: 0.2mm solid #E4E1DD; overflow-wrap: anywhere; word-break: normal; white-space: pre-line; }
  th:first-child, td:first-child { padding-left: 1.6mm; }
  tbody tr:nth-child(even) td { background: #F7F6F4; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .pill { display: inline-flex; align-items: center; gap: 1.2mm; padding: 0.3mm 2mm 0.3mm 1.5mm; border-radius: 999px; border: 0.2mm solid; font-size: 8px; font-weight: 600; line-height: 1.35; white-space: normal; }
  .mark { width: 2.2mm; height: 2.2mm; flex: none; fill: currentColor; }
  h2 .mark { width: 2.8mm; height: 2.8mm; }
  .good { color: #176841; } .pill.good { background: rgba(31, 133, 83, 0.1); border-color: rgba(31, 133, 83, 0.4); }
  .partial { color: #8F4F12; } .pill.partial { background: rgba(196, 113, 31, 0.11); border-color: rgba(196, 113, 31, 0.45); }
  .missing, .alert { color: #A63A22; } .pill.missing, .pill.alert { background: rgba(201, 75, 48, 0.09); border-color: rgba(201, 75, 48, 0.42); }
  .neutral { color: #475569; } .pill.neutral { background: rgba(100, 116, 139, 0.1); border-color: rgba(100, 116, 139, 0.4); }
  .tile .mark, h2 .mark { color: inherit; }
  .empty { color: #76716B; font-style: italic; margin: 2mm 0 0; padding: 2.4mm 3mm; background: #F4F3F1; border-radius: 1.5mm; }
  footer { margin: 9mm 0 0; padding-top: 2.4mm; border-top: 0.2mm solid #E4E1DD; color: #76716B; font-size: 8px; }
`

/** Characters of body text that fit across the printable width. */
const LINE_CHARS = 120

/**
 * Column widths in percent, estimated from text length: every column gets room for its longest word
 * (so short values never break mid word), and the space left goes to the columns with long text.
 */
function columnWidths(section: ReportSection): number[] {
  const columns = section.columns.map((column, i) => {
    const values = section.rows.map((row) => row[i] ?? "")
    const lines = values.flatMap((value) => value.split("\n"))
    const words = [...column.split(/\s+/).map((w) => w.length * 1.15), ...lines.flatMap((line) => line.split(/\s+/)).map((w) => Math.min(w.length, 18))]
    const lengths = lines.map((line) => line.length).sort((a, b) => a - b)
    const pill = values.some((value) => toneOf(value)) ? 4 : 0
    const min = Math.max(4, ...words) + 3 + pill
    return { min, want: Math.max(min, Math.min(lengths[Math.floor((lengths.length - 1) * 0.9)] ?? 0, 60) + 3 + pill) }
  })
  const minSum = columns.reduce((sum, c) => sum + c.min, 0)
  const growth = columns.reduce((sum, c) => sum + c.want - c.min, 0)
  const spare = Math.max(0, LINE_CHARS - minSum)
  const widths = columns.map((c) => c.min + (growth > spare ? (c.want - c.min) * (spare / growth) : c.want - c.min))
  const total = widths.reduce((sum, w) => sum + w, 0)
  return widths.map((w) => Math.round((w / total) * 1000) / 10)
}

/** A standalone HTML document with no scripts or external resources. */
export function reportHtml(report: Report): string {
  const e = escapeHtml
  const cell = (value: string) => {
    const tone = toneOf(value)
    return tone ? `<span class="pill ${tone}">${marker(tone)}${e(value)}</span>` : e(value)
  }
  const label = (value: string) => {
    const tone = toneOf(value)
    return tone ? `<span class="${tone}">${marker(tone)}</span>${e(value)}` : e(value)
  }
  const table = (section: ReportSection) => section.rows.length
    ? `<table><colgroup>${columnWidths(section).map((w) => `<col style="width:${w}%">`).join("")}</colgroup><thead><tr>${section.columns.map((c) => `<th>${e(c)}</th>`).join("")}</tr></thead><tbody>${section.rows.map((row) => `<tr>${row.map((value) => `<td>${cell(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<p class="empty">Nothing to report.</p>`
  const [hero, ...facts] = report.meta
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${e(report.title)}</title><style>${STYLE}</style></head><body>
<header class="band"><div class="brand">${BRAND_MARK}<span class="wordmark">TenuVault</span></div>
<div class="accent"></div><p class="eyebrow">${e(report.eyebrow ?? "Intune configuration report")}</p>
<h1>${e(report.title)}</h1>${report.subtitle ? `<p class="subtitle">${e(report.subtitle)}</p>` : ""}
${hero ? `<div class="facts"><dl class="hero"><dt>${e(hero[0])}</dt><dd>${e(hero[1])}</dd></dl>${facts.length ? `<dl class="grid">${facts.map(([k, v]) => `<div${v.length > 48 ? ` class="wide"` : ""}><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join("")}</dl>` : ""}</div>` : ""}
</header><main>
${report.summary?.length ? `<p class="label">At a glance</p><div class="tiles">${report.summary.map(([k, v]) => `<div class="tile"><span class="k">${label(k)}</span><strong class="v">${e(v)}</strong></div>`).join("")}</div>` : ""}
${report.sections.map((s) => `<section><h2>${label(s.heading)}</h2>${s.note ? `<p class="note">${e(s.note)}</p>` : ""}${table(s)}</section>`).join("\n")}
<footer>${e(report.footer ?? `Generated by TenuVault on ${new Date().toLocaleString()}.`)}</footer></main></body></html>`
}

/** CSV with every cell quoted; cells that a spreadsheet would run as a formula are prefixed with '. */
export function toCsv(rows: string[][]): string {
  const cell = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
    return `"${safe.replace(/"/g, '""')}"`
  }
  return rows.map((row) => row.map(cell).join(",")).join("\r\n")
}
