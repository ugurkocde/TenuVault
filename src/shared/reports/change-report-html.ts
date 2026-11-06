import { redactText } from "../compliance/export"
import { escapeHtml, type OibPrintOptions } from "../oib/report-html"
import { luminance, resolveBrandTheme, themeCssVariables, type PdfBranding } from "../pdf/theme"
import { activityLine, changeLabel, reportTime, reportTitle, summaryLine, type ChangeReport, type ReportChange, type ReportItem } from "./change-report"

/**
 * A change report as a standalone HTML document that the main process prints to PDF with
 * Chromium, in the design of the other TenuVault reports. Every interpolated value is redacted
 * and escaped; the document has no scripts and loads nothing: images are data URLs only.
 */

const MM_PER_INCH = 25.4
const FONT_STACK = `"Segoe UI Variable", "Segoe UI", -apple-system, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans CJK JP", "Hiragino Sans", "Microsoft YaHei", sans-serif`

/** Redacted, then escaped: the only way report text enters the document. */
const text = (value: string) => escapeHtml(redactText(value))
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const CHANGE_TONE: Record<ReportChange, string> = { added: "good", modified: "warn", deleted: "bad" }
const SEVERITY_TONE: Record<ReportItem["severity"], string> = { critical: "bad", warning: "warn", info: "neutral" }

/** Text for a CSS string in a page margin box: one line, shortened, every unusual character escaped. */
function cssString(value: string, max: number): string {
  // Control characters become spaces; they have no place in a one line label.
  // oxlint-disable-next-line no-control-regex
  const line = redactText(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  const clipped = line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line
  return `"${[...clipped].map((char) => (/[A-Za-z0-9 .,:;|()_-]/.test(char) ? char : `\\${char.codePointAt(0)!.toString(16)} `)).join("")}"`
}

const STYLE = `
@page { size: A4; margin: 21mm 15mm 21mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; }
body { font-family: ${FONT_STACK}; color: var(--ink); font-size: 7.6pt; line-height: 1.4; }
h1, h2, h3, p { margin: 0; }
.band { padding: 7mm 7mm 6mm; border-radius: 2.5mm; background: var(--primary); color: var(--on-band); margin-bottom: 6mm; }
.brand { display: flex; align-items: center; gap: 2.4mm; height: 7mm; }
.brand-name { font-size: 10pt; font-weight: 700; }
.logo { display: block; max-width: 40mm; max-height: 10mm; }
.logo.plate { background: var(--white); border-radius: 1.5mm; padding: 1.5mm 2mm; }
.eyebrow { margin-top: 6mm; font-size: 7pt; font-weight: 700; letter-spacing: 0.25mm; text-transform: uppercase; color: var(--band-accent); }
h1 { margin-top: 1.4mm; font-size: 19pt; line-height: 1.15; overflow-wrap: anywhere; }
.period { margin-top: 2mm; font-size: 9pt; color: var(--band-muted); }
.facts { display: flex; flex-wrap: wrap; gap: 1.2mm 8mm; margin-top: 4mm; padding-top: 3mm; border-top: 0.25mm solid var(--band-rule); font-size: 7.6pt; }
.facts span { color: var(--band-muted); margin-right: 1.4mm; }
.tiles { display: flex; gap: 3mm; margin-bottom: 4mm; }
.tile { flex: 1 1 0; min-width: 0; padding: 3.4mm 3.6mm; border: 0.25mm solid var(--border); border-radius: 2mm; }
.tile .key { font-size: 5.8pt; font-weight: 700; letter-spacing: 0.1mm; text-transform: uppercase; color: var(--muted); }
.tile .value { margin-top: 1.2mm; font-size: 18pt; font-weight: 700; line-height: 1; color: var(--strong); }
.lead { margin-bottom: 5mm; font-size: 8.8pt; color: var(--body); }
.callout { padding: 3.4mm 4.4mm; margin-bottom: 5mm; border: 0.25mm solid var(--accent-border); border-radius: 2mm; background: var(--accent-wash); font-size: 8pt; }
.callout b { color: var(--accent-text); }
h2 { margin: 7mm 0 3mm; padding-bottom: 1.4mm; border-bottom: 0.4mm solid var(--strong); font-size: 12pt; color: var(--strong); break-after: avoid; }
.item { margin-bottom: 5mm; break-inside: auto; }
.keep { break-inside: avoid; break-after: avoid; }
.item-head { break-inside: avoid; break-after: avoid; }
h3 { font-size: 10pt; color: var(--strong); overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 1.2mm; margin: 1.2mm 0 1.6mm; }
.pill { display: inline-block; padding: 0.5mm 2.2mm; border-radius: 2mm; font-size: 6.4pt; font-weight: 700; }
.tone-good { color: var(--good-text); background: var(--good-fill); }
.tone-warn { color: var(--warn-text); background: var(--warn-fill); }
.tone-bad { color: var(--bad-text); background: var(--bad-fill); }
.tone-neutral { color: var(--neutral-text); background: var(--neutral-fill); }
.meta { font-size: 7.2pt; color: var(--muted); overflow-wrap: anywhere; }
.activity { margin: 1mm 0 2mm; padding: 0; list-style: none; font-size: 7.4pt; color: var(--body); }
.activity li { padding: 0.4mm 0; overflow-wrap: anywhere; }
.activity li::before { content: ""; display: inline-block; width: 1.4mm; height: 1.4mm; margin-right: 1.6mm; border-radius: 50%; background: var(--accent); vertical-align: 0.2mm; }
.unknown { font-style: italic; color: var(--muted); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 1mm; }
thead { display: table-header-group; }
th { padding: 0 1.5mm 1.2mm; text-align: left; font-size: 5.8pt; font-weight: 700; letter-spacing: 0.2mm; text-transform: uppercase; color: var(--muted); border-bottom: 0.3mm solid var(--strong); }
td { padding: 1.6mm 1.5mm; vertical-align: top; border-bottom: 0.2mm solid var(--rule); overflow-wrap: anywhere; font-size: 7.3pt; }
tbody tr:nth-child(even) td { background: var(--zebra); }
tr { break-inside: avoid; }
td.before { color: var(--bad-text); }
td.after { color: var(--good-text); }
td.empty { color: var(--faint); font-style: italic; }
.more { margin-top: 1.2mm; font-size: 7pt; color: var(--muted); }
.none { font-size: 8pt; font-style: italic; color: var(--muted); }
.provenance { margin-top: 8mm; padding-top: 3mm; border-top: 0.2mm solid var(--rule); font-size: 7pt; color: var(--muted); break-inside: avoid; }
@media screen { body { max-width: 210mm; margin: 0 auto; padding: 10mm 12mm; background: var(--white); } }
`

export interface ChangeReportDocument {
  html: string
  print: OibPrintOptions
}

/**
 * The HTML document and print options of a change report. `branding` is the branding the tenant's
 * plan allows (main resolves it); without it, or without a company name, the TenuVault design is used.
 */
export function buildChangeReportDocument(report: ChangeReport, options: { branding?: PdfBranding } = {}): ChangeReportDocument {
  const theme = resolveBrandTheme(options.branding)
  const title = reportTitle(report)
  // A white label report names the customer in the footer and nowhere names TenuVault.
  const footer = theme.companyName ? theme.footerText ?? theme.companyName : "TenuVault | Change report"
  const brand = theme.companyName
    ? theme.logoDataUrl
      ? `<img class="logo${!theme.logoDataUrl.startsWith("data:image/jp") && luminance(theme.primary) <= 0.5 ? " plate" : ""}" src="${escapeHtml(theme.logoDataUrl)}" alt="${text(theme.companyName)}">`
      : `<span class="brand-name">${text(theme.companyName)}</span>`
    : `<span class="brand-name">TenuVault</span>`
  const facts: Array<[string, string]> = [
    ["Tenant", report.tenantName],
    ["Tenant ID", report.tenantId],
    ["Generated", reportTime(report.generatedAt)],
    ...(theme.preparedBy ? [["Prepared by", theme.preparedBy] as [string, string]] : []),
    ...(theme.classification ? [["Classification", theme.classification] as [string, string]] : []),
  ]
  const header = `<header class="band"><div class="brand">${brand}</div>
<p class="eyebrow">Change report</p><h1>${text(title)}</h1>
<p class="period">From backup ${text(report.from.id)} (${text(reportTime(report.from.timestamp))}) to ${text(report.to.id)} (${text(reportTime(report.to.timestamp))})</p>
<div class="facts">${facts.map(([label, value]) => `<div><span>${text(label)}</span><b>${text(value)}</b></div>`).join("")}</div></header>`

  const { summary } = report
  const tile = (label: string, value: number | string) => `<div class="tile"><div class="key">${text(label)}</div><div class="value">${text(String(value))}</div></div>`
  const tiles = `<div class="tiles">${tile("Changed", summary.modified)}${tile("Added", summary.added)}${tile("Deleted", summary.deleted)}${tile("Critical", summary.critical)}${tile("With audit events", report.audit.status === "included" ? summary.attributed : "Unknown")}</div>`
  const callouts = [
    report.audit.status !== "included" ? `<div class="callout"><b>Who made the changes is unknown.</b> ${text(report.audit.note ?? "The audit log could not be read.")}</div>` : report.audit.note ? `<div class="callout"><b>Part of the audit log was not read.</b> ${text(report.audit.note)}</div>` : "",
    !report.values ? `<div class="callout"><b>Setting values are left out.</b> This report lists which settings changed, not their values.</div>` : "",
  ].join("")

  const sections = (["deleted", "modified", "added"] as const).map((change) => {
    const items = report.items.filter((item) => item.change === change)
    if (!items.length) return ""
    return `<section><h2>${text(changeLabel(change))} (${items.length})</h2>${items.map((item) => itemHtml(item, report)).join("")}</section>`
  }).join("")
  const empty = report.items.length ? "" : `<p class="none">No items were added, changed or deleted between the two backups.</p>`

  const other = report.otherActivity.length
    ? `<section><div class="keep"><h2>Other activity (${report.otherActivity.length + report.moreActivity})</h2><p class="lead">Audit events in this window that match no item above, for example a change that was undone before the second backup, or an object TenuVault does not back up.</p></div>
<table><colgroup><col style="width:20%"><col style="width:34%"><col style="width:26%"><col style="width:20%"></colgroup><thead><tr><th>When</th><th>What</th><th>Object</th><th>Who</th></tr></thead><tbody>${report.otherActivity.map((event) => `<tr><td>${text(reportTime(event.at))}</td><td>${text(`${event.source}: ${event.activity}`)}</td><td>${text(event.target ?? "")}</td><td>${text(event.who ?? "")}</td></tr>`).join("")}</tbody></table>${report.moreActivity ? `<p class="more">${plural(report.moreActivity, "older event is", "older events are")} not listed.</p>` : ""}</section>`
    : ""
  const warnings = report.warnings.length ? `<section><h2>Not compared</h2><ul class="activity">${report.warnings.map((warning) => `<li>${text(warning)}</li>`).join("")}</ul></section>` : ""

  const provenance = `<p class="provenance">${text(`${theme.companyName ? "Generated" : "Generated by TenuVault"} from the backups ${report.from.id} and ${report.to.id} of tenant ${report.tenantId}. Values are shown as the backups recorded them; secret values are never shown. Who made a change comes from the Intune and Entra audit logs and is shown only when an audit event names the item.`)}</p>`

  const margin = (box: string, content: string, extra: string) => `@${box} { content: ${content}; font-family: ${FONT_STACK}; font-size: 6.5pt; color: var(--muted); ${extra} }`
  const pageBoxes = `@page {
  ${margin("top-left", cssString(title, 90), "vertical-align: bottom; padding-bottom: 1.6mm; border-bottom: 0.2mm solid var(--rule); width: 130mm; font-weight: 700; color: var(--strong);")}
  ${margin("top-right", cssString(report.tenantName, 40), "vertical-align: bottom; padding-bottom: 1.6mm; border-bottom: 0.2mm solid var(--rule); width: 50mm; text-align: right;")}
  ${margin("bottom-left", cssString(footer, 76), "vertical-align: top; padding-top: 2.4mm; border-top: 0.2mm solid var(--rule); width: 130mm;")}
  ${margin("bottom-right", `"Page " counter(page) " of " counter(pages)`, "vertical-align: top; padding-top: 2.4mm; border-top: 0.2mm solid var(--rule); width: 50mm; text-align: right;")}
}`
  const rootVariables = `:root { ${Object.entries(themeCssVariables(theme)).map(([name, value]) => `${name}: ${value};`).join(" ")} }`

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${text(title)}</title><style>${rootVariables}${STYLE}${pageBoxes}</style></head><body>
${header}
${tiles}
<p class="lead">${text(summaryLine(report))}</p>
${callouts}${empty}${sections}${other}${warnings}${provenance}
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

function itemHtml(item: ReportItem, report: ChangeReport): string {
  const chips = [
    `<span class="pill tone-${CHANGE_TONE[item.change]}">${text(changeLabel(item.change))}</span>`,
    `<span class="pill tone-neutral">${text(item.type)}</span>`,
    item.severity !== "info" ? `<span class="pill tone-${SEVERITY_TONE[item.severity]}">${text(item.severity === "critical" ? "Critical" : "Warning")}</span>` : "",
    item.likelyRestoredCopy ? `<span class="pill tone-neutral">Likely a restored copy</span>` : "",
  ].join("")
  const meta = [
    item.previousName ? `Previously named ${item.previousName}` : null,
    item.id ? `ID ${item.id}` : null,
    item.restoreFrom ? `Previous version in backup ${item.restoreFrom}` : null,
  ].filter((entry): entry is string => entry !== null).join(" · ")
  const activity = item.activity.length
    ? `<ul class="activity">${item.activity.map((event) => `<li>${text(activityLine(event))}</li>`).join("")}</ul>`
    : report.audit.status === "included" ? `<p class="activity unknown">No matching audit event in this window.</p>` : ""
  const cell = (value: string | null, kind: string) => (value === null || value === "Not set" ? `<td class="empty">Not set</td>` : `<td class="${kind}">${text(value)}</td>`)
  let table = ""
  if (item.settings.length) {
    if (!report.values) {
      table = `<table><thead><tr><th>Setting</th></tr></thead><tbody>${item.settings.map((setting) => `<tr><td>${text(setting.name)}</td></tr>`).join("")}</tbody></table>`
    } else if (item.change === "modified") {
      table = `<table><colgroup><col style="width:36%"><col style="width:32%"><col style="width:32%"></colgroup><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead><tbody>${item.settings.map((setting) => `<tr><td>${text(setting.name)}</td>${cell(setting.before, "before")}${cell(setting.after, "after")}</tr>`).join("")}</tbody></table>`
    } else {
      table = `<table><colgroup><col style="width:40%"><col style="width:60%"></colgroup><thead><tr><th>Setting</th><th>Value</th></tr></thead><tbody>${item.settings.map((setting) => `<tr><td>${text(setting.name)}</td>${cell(item.change === "added" ? setting.after : setting.before, "")}</tr>`).join("")}</tbody></table>`
    }
  }
  const more = item.moreSettings ? `<p class="more">${plural(item.moreSettings, "more setting is", "more settings are")} not listed.</p>` : ""
  return `<div class="item"><div class="item-head"><h3>${text(item.name)}</h3><div class="chips">${chips}</div>${meta ? `<p class="meta">${text(meta)}</p>` : ""}${activity}</div>${table}${more}</div>`
}
