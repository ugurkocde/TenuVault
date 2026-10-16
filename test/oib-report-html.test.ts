import { describe, expect, it } from "vitest"
import { parseReportPayload } from "../src/shared/oib/report"
import { buildOibReport, escapeHtml } from "../src/shared/oib/report-html"
import { TENUVAULT_THEME, luminance, resolveBrandTheme, themeCssVariables, type PdfBranding } from "../src/shared/pdf/theme"
import { EXPORTED_AT, TENANT_ID, oibComparisonReport, oibValidationReport, pngLogo } from "./pdf-report-fixtures"

const ATTRIBUTION = "OpenIntuneBaseline content: SkipToTheEndpoint and contributors, GPL-3.0."
const LOGO = pngLogo()
const BRANDING: PdfBranding = { companyName: "Fabrikam Security Services", colors: { primary: "#0B3D5C", accent: "#2BB3A3" }, preparedBy: "Avery Fabrikam", classification: "Confidential", footerText: "Fabrikam | Intune review", logo: { dataUrl: LOGO } }

const build = (report: unknown = oibComparisonReport(), branding?: PdfBranding) => buildOibReport(parseReportPayload(report), { exportedAt: EXPORTED_AT, branding })
const html = (report?: unknown, branding?: PdfBranding) => build(report, branding).html
/** The document without its style element, so text checks see only the content. */
const body = (document: string) => document.replace(/<style>[\s\S]*?<\/style>/, "")
/** The visible text of the content, tags removed and entities decoded. */
const visible = (document: string) => body(document).replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ")
/** The CSS of the running header and footer. */
const marginBoxes = (document: string) => document.slice(document.lastIndexOf("@page {"), document.indexOf("</style>"))

describe("OIB report HTML", () => {
  it("is a standalone document with a strict CSP, no scripts and no external resources", () => {
    const document = html(oibComparisonReport(), BRANDING)
    expect(document.startsWith("<!doctype html>")).toBe(true)
    expect(document).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`)
    expect(document).not.toMatch(/<script|<link|<iframe|<object|<embed|@import|url\(/i)
    expect(document).not.toMatch(/\s(?:src|href)="(?!data:image\/png;base64,|#)/)
    expect(document).not.toMatch(/\son[a-z]+=/i)
    // The only image is the customer logo, as a data URL.
    expect([...document.matchAll(/<img /g)]).toHaveLength(1)
    expect(document).toContain(`src="${LOGO}"`)
  })

  it("escapes every interpolated value", () => {
    const hostile = "<script>alert(1)</script><img src=x onerror=alert(2)>\"'&"
    const report = oibComparisonReport()
    report.title = hostile
    report.subtitle = hostile
    report.eyebrow = hostile
    report.meta = [["Tenant", hostile], [hostile, hostile], ["Long", `${hostile} ${"x".repeat(80)}`]]
    report.summary = [[hostile, "3"]]
    report.sections = [{ heading: hostile, note: hostile, columns: [hostile, "Status"], rows: [[hostile, "Up to date"]] }]
    report.attribution = hostile
    const document = html(report, { ...BRANDING, companyName: hostile, preparedBy: hostile, classification: hostile, footerText: hostile, logo: undefined })
    expect(document).not.toContain("<script")
    expect(document).not.toMatch(/<img/)
    expect(body(document)).not.toMatch(/<[a-z]+\s[^>]*\bon[a-z]+=/i)
    expect(body(document)).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp;")
    // In the running header CSS every character outside a small safe set is a CSS escape, so no string or rule can be closed.
    const css = marginBoxes(document)
    expect(css).not.toMatch(/content: "[^"]*[<>'&{};][^"]*";/)
    expect(css).toContain("\\3c script\\3e ")
    expect(document.match(/<\/style>/g)).toHaveLength(1)
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;")
  })

  it("prints the cover, contents, summary, every section and the attribution", () => {
    const document = html()
    const text = visible(document)
    for (const expected of ["TenuVault", "OpenIntuneBaseline comparison", "OpenIntuneBaseline deployment comparison", "OpenIntuneBaseline Windows v3.8, macOS v1.0, iOS/iPadOS v2.1, Android v1.4",
      "Tenant", "Contoso Ltd", "Compared 2026-10-14 08:45 UTC", "Exported 2026-10-14 09:30 UTC", "14%", "2 of 14 policies", "Up to date", "Configuration comparison only, not a compliance score",
      "At a glance", "Document control", "Tenant ID", TENANT_ID, "Tenant policies read", "Configuration comparison, not a certification",
      "About this report", "Matching: OIBID in the policy description, then policy name without version.", "Contents", "Summary", "Results", "Provenance and attribution",
      "Status distribution", "14 policies", "Report details", "Update available", "New policy", "Ambiguous match", "Newer than OIB", "Other copies still deployed",
      "Older versions or extra copies next to the matched policy.", "Deprecated policies in the tenant", "Nothing to report.", "Generated by TenuVault", ATTRIBUTION]) expect(text).toContain(expected)
    // The cover shows the TenuVault mark; the status donut and the decorative ring are inline SVG.
    expect(document).toContain('class="brand-mark"')
    expect(document).toContain('class="rings"')
    // Bookmarks come from the headings: page titles are h1, sections h2, the cover title is not a heading.
    expect([...document.matchAll(/<h1>([^<]*)<\/h1>/g)].map(match => match[1])).toEqual(["Contents", "Summary", "Results", "Provenance and attribution"])
    expect([...document.matchAll(/<h2 class="title">(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/h2>/g)].map(match => match[1])).toEqual(["Update available", "New policy", "Ambiguous match", "Newer than OIB", "Up to date", "Other copies still deployed", "Deprecated policies in the tenant"])
    expect(document).toContain('<p class="cover-title"')
    // The contents link to every section.
    for (const id of ["summary", "results", "section-1", "section-7", "provenance"]) {
      expect(document).toContain(`href="#${id}"`)
      expect(document).toContain(`id="${id}"`)
    }
  })

  it("draws known status words as pills with marker shapes and leaves other text alone", () => {
    const document = html(oibValidationReport())
    const pills = [...document.matchAll(/<span class="pill tone-([a-z]+)"><svg[^>]*>([\s\S]*?)<\/svg>([^<]*)<\/span>/g)].map(match => ({ tone: match[1], shape: match[2]!, label: match[3] }))
    const of = (label: string) => pills.find(item => item.label === label)!
    expect(of("Matches the baseline")).toMatchObject({ tone: "good" })
    expect(of("Matches the baseline").shape).toContain('<circle cx="5" cy="5" r="4" class="fg"/>')
    expect(of("Drift detected")).toMatchObject({ tone: "warn" })
    expect(of("Drift detected").shape).toContain("A3.6 3.6 0 0 0 5 8.6Z")
    expect(of("Value mismatch")).toMatchObject({ tone: "warn" })
    expect(of("Missing in tenant")).toMatchObject({ tone: "bad" })
    expect(of("Missing in tenant").shape).toContain("M0.4 8.9L9.6 8.9L5 0.2Z")
    expect(of("Validation error")).toMatchObject({ tone: "conflict" })
    expect(of("Not validated")).toMatchObject({ tone: "neutral" })
    expect(of("Only in tenant").shape).toContain('class="bg"')
    // A cell that only contains a status word somewhere else is plain text.
    expect(document).toContain("<td>42 of 42</td>")
    // The tables repeat their header row on every page and never split a row.
    expect(document).toContain("thead { display: table-header-group; }")
    expect(document).toContain("tr { break-inside: avoid; }")
    expect(document).toContain("overflow-wrap: anywhere")
    // Column widths add up to the table width.
    for (const match of document.matchAll(/<colgroup>([\s\S]*?)<\/colgroup>/g)) {
      const widths = [...match[1]!.matchAll(/width:([\d.]+)%/g)].map(width => Number(width[1]))
      expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 0)
    }
  })

  it("keeps tenant text in any script verbatim and redacts secrets", () => {
    const report = oibComparisonReport()
    report.meta[0] = ["Tenant", "コントソ株式会社 東京本社"]
    report.sections[0]!.rows[0]![3] = "日本語ポリシー名 Ελληνικά Кириллица 中文策略 \u2013 \u201cquoted\u201d \u2026"
    const document = html(report)
    expect(body(document)).toContain("コントソ株式会社 東京本社")
    expect(body(document)).toContain("日本語ポリシー名 Ελληνικά Кириллица 中文策略 \u2013 \u201cquoted\u201d \u2026")
    expect(document).toContain('<meta charset="utf-8">')
    // The system font stack covers Japanese and Chinese.
    expect(document).toContain('"Noto Sans CJK JP", "Hiragino Sans", "Microsoft YaHei"')
    // In the running header the tenant is CSS escaped, character by character.
    expect(marginBoxes(document)).toContain("\\30b3 \\30f3 \\30c8 \\30bd ")
    const validation = html(oibValidationReport())
    expect(validation).not.toContain("eyJhbGciOiJIUzI1NiJ9")
    expect(visible(validation)).toContain("Graph returned 403 Forbidden")
  })

  it("redacts secrets in the logo alternative text", () => {
    const document = html(oibComparisonReport(), { ...BRANDING, companyName: "Fabrikam Bearer abcdef123456789" })
    const alt = document.match(/<img [^>]*alt="([^"]*)"/)?.[1] ?? ""
    expect(alt).toContain("Fabrikam")
    expect(alt).not.toContain("abcdef123456789")
    expect(document).not.toContain("abcdef123456789")
  })

  it("sizes columns of a report at the payload limits without overflowing the stack", () => {
    const report = oibValidationReport()
    const section = report.sections[0]!
    const cell = "x ".repeat(10000)
    section.rows = Array.from({ length: 20 }, () => section.columns.map(() => cell))
    expect(() => html(report)).not.toThrow()
  })

  it("prints every date in the same UTC format", () => {
    for (const [report, date] of [[oibComparisonReport(), "2026-10-14 08:45 UTC"], [oibValidationReport(), "2026-10-14 09:02 UTC"]] as const) {
      const text = visible(html(report))
      expect(text).toContain(date)
      expect(text).toContain("2026-10-14 09:30 UTC")
      expect(text).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}:\d{2}:\d{2}/)
    }
  })

  it("uses the colours of the resolved theme, also for a light primary", () => {
    const plain = html()
    for (const [name, value] of Object.entries(themeCssVariables(TENUVAULT_THEME))) expect(plain).toContain(`${name}: ${value};`)
    expect(plain).toContain("--primary: rgb(22 21 20);")
    expect(plain).toContain("--accent: rgb(228 103 75);")
    const branded = html(oibComparisonReport(), BRANDING)
    expect(branded).toContain("--primary: rgb(11 61 92);")
    expect(branded).toContain("--accent: rgb(43 179 163);")
    for (const [name, value] of Object.entries(themeCssVariables(resolveBrandTheme(BRANDING)))) expect(branded).toContain(`${name}: ${value};`)
    const lightBranding = { ...BRANDING, colors: { primary: "#F2F4F7", accent: "#FFD400" } }
    const light = resolveBrandTheme(lightBranding)
    expect(light.onBand).toEqual([22, 21, 20])
    expect(luminance(light.strong)).toBeLessThanOrEqual(0.18)
    const lightHtml = html(oibComparisonReport(), lightBranding)
    expect(lightHtml).toContain("--on-band: rgb(22 21 20);")
    expect(lightHtml).toContain(`--strong: rgb(${light.strong.join(" ")});`)
    expect(lightHtml).toContain(`--accent-text: rgb(${light.accentText.join(" ")});`)
    // Pill tones and the neutral palette come from the PDF kit.
    expect(plain).toContain("--good-fill: rgb(231 242 236);")
    expect(plain).toContain("--zebra: rgb(249 248 247);")
    expect(plain).toContain(".tone-good { color: var(--good-text); background: var(--good-fill);")
    // A transparent PNG logo sits on a white plate on a dark band, not on a light one.
    expect(branded).toContain('class="logo plate"')
    expect(lightHtml).toContain('class="logo"')
  })

  it("renders a white label report with the customer branding and only the verbatim licence naming TenuVault", () => {
    const document = html(oibComparisonReport(), BRANDING)
    const text = visible(document)
    for (const expected of ["Prepared by Avery Fabrikam", "Classification Confidential", "Fabrikam | Intune review", ATTRIBUTION]) expect(text).toContain(expected)
    expect(document).not.toMatch(/tenuvault/i)
    expect(document).not.toContain('class="brand-mark"')
    expect(text).not.toContain("Generated by")
    expect(marginBoxes(document)).toContain('@bottom-left { content: "Fabrikam | Intune review";')
    // Without a logo the cover names the company; without footer text the footer does.
    const named = html(oibComparisonReport(), { ...BRANDING, logo: undefined, footerText: undefined })
    expect(named).toContain('<span class="company">Fabrikam Security Services</span>')
    expect(marginBoxes(named)).toContain('@bottom-left { content: "Fabrikam Security Services";')
    // Licence text and tenant data that name TenuVault print as recorded.
    const report = oibComparisonReport()
    report.sections[0]!.rows[0]![3] = "TenuVault Baseline"
    report.attribution = `${ATTRIBUTION} Packaged for TenuVault.`
    const recorded = visible(html(report, BRANDING))
    expect(recorded).toContain("TenuVault Baseline")
    expect(recorded).toContain(`${ATTRIBUTION} Packaged for TenuVault.`)
    expect(recorded.replace("TenuVault Baseline", "").replace("Packaged for TenuVault.", "")).not.toMatch(/tenuvault/i)
    // Without branding the TenuVault design is used.
    const plain = html()
    expect(plain).toContain('<span class="wordmark">TenuVault</span>')
    expect(marginBoxes(plain)).toContain('@bottom-left { content: "TenuVault | OpenIntuneBaseline comparison";')
    expect(plain).not.toContain("Fabrikam")
  })

  it("keeps the fixed document control cells and points to Report details when meta does not fit", () => {
    const report = oibComparisonReport()
    report.meta = [["Tenant", "Contoso Ltd"], ...Array.from({ length: 12 }, (_, index): [string, string] => [`Field ${index + 1}`, `Value ${index + 1}`])]
    const document = html(report, BRANDING)
    const cells = [...document.matchAll(/<div class="control-cell( span-2)?"><span>([^<]*)<\/span><b>([^<]*)<\/b><\/div>/g)].map(match => ({ span: match[1] ? 2 : 1, label: match[2], value: match[3] }))
    expect(cells.map(cell => cell.label)).toEqual(expect.arrayContaining(["Tenant ID", "Exported", "Prepared by", "Classification", "More details"]))
    expect(cells.reduce((sum, cell) => sum + cell.span, 0)).toBeLessThanOrEqual(12)
    const shown = cells.filter(cell => cell.label?.startsWith("Field")).length
    expect(cells.find(cell => cell.label === "More details")?.value).toBe(`${12 - shown} more entries in Report details`)
    // Report details lists every entry.
    for (let index = 1; index <= 12; index++) expect(visible(document)).toContain(`Field ${index} Value ${index}`)
    // A short list needs no pointer.
    expect(html()).not.toContain("More details")
  })

  it("prints the running header and footer on every page but the cover", () => {
    const { html: document, print } = build()
    const css = marginBoxes(document)
    expect(css).toContain('@top-left { content: "OpenIntuneBaseline deployment comparison";')
    expect(css).toContain('@top-right { content: "Contoso Ltd";')
    expect(css).toContain('@bottom-right { content: "Page " counter(page) " of " counter(pages);')
    expect(css).toContain("@page :first { @top-left { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }")
    expect(document).toContain("@page { size: A4; margin: 21mm 15mm 21mm; }")
    expect(document).toContain("@page :first { margin: 0; }")
    // Long header text is shortened with an ellipsis, wide characters counting twice.
    const report = oibComparisonReport()
    report.title = "A".repeat(200)
    report.meta[0] = ["Tenant", "東".repeat(60)]
    const long = marginBoxes(html(report))
    expect(long).toContain(`@top-left { content: "${"A".repeat(64)}...";`)
    expect(long).toContain(`@top-right { content: "${"\\6771 ".repeat(26)}...";`)
    expect(print).toEqual({
      pageSize: "A4", printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, generateDocumentOutline: true, generateTaggedPDF: true,
      margins: { top: 21 / 25.4, bottom: 21 / 25.4, left: 15 / 25.4, right: 15 / 25.4 },
    })
  })

  it("falls back to the tenant ID and default labels and moves long meta into the About panel", () => {
    const document = html({ tenantId: TENANT_ID, title: "Report", meta: [["Scope", "x".repeat(70)]], sections: [] })
    const text = visible(document)
    expect(text).toContain(`Tenant ${TENANT_ID}`)
    expect(text).toContain("OpenIntuneBaseline report")
    expect(text).toContain(`About this report Scope: ${"x".repeat(70)}`)
    expect(text).toContain("0%")
    expect(text).not.toContain("Status distribution")
    expect(document).toContain('style="font-size:36pt"')
    expect(html({ tenantId: TENANT_ID, title: "T".repeat(100), meta: [], sections: [] })).toContain('style="font-size:22pt"')
  })
})
