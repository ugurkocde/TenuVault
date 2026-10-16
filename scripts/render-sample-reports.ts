import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { generateCisReadinessPDF, generateNativeFrameworkPDF, generateWorkspaceAssessmentPDF } from "../src/shared/compliance/report-pdf"
import { parseReportPayload } from "../src/shared/oib/report"
import { buildOibReport } from "../src/shared/oib/report-html"
import type { PdfBranding } from "../src/shared/pdf/theme"
import { CIS_CONTEXT, EXPORTED_AT, cisSummary, nativeRun, oibComparisonReport, oibValidationReport, pngLogo, workspaceAssessment } from "../test/pdf-report-fixtures"

/**
 * Renders the framework PDF reports and the OpenIntuneBaseline HTML reports from fictional Contoso
 * fixtures for visual review. The app prints the OIB HTML with Chromium; each one is written with
 * its print options (<name>.print.json: header and footer templates, margins in inches) so it can be
 * printed the same way, for example with Playwright's page.pdf.
 * Usage:
 *   npx jiti scripts/render-sample-reports.ts [output folder]
 *   pdftoppm -r 70 -png /tmp/tv-pdf/native.pdf /tmp/tv-pdf/native
 * With --extreme the inputs that stress the layout are rendered as well.
 */

const out = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "/tmp/tv-pdf"
const extreme = process.argv.includes("--extreme")
mkdirSync(out, { recursive: true })
const context = { exportedAt: EXPORTED_AT, tenantName: "Contoso Ltd" }
const branding: PdfBranding = { companyName: "Fabrikam Security Services", colors: { primary: "#0B3D5C", accent: "#2BB3A3" }, preparedBy: "Fabrikam Security Services", classification: "Confidential", footerText: "Fabrikam | Intune configuration review" }
const reports: [string, Uint8Array][] = [
  ["native", generateNativeFrameworkPDF(nativeRun(), context)],
  ["native-e8", generateNativeFrameworkPDF(nativeRun({ frameworkId: "essential-eight", nativeId: "essential-eight", scope: { platforms: ["windows"], essentialEightMaturityLevel: 2 } }), context)],
  ["workspace", generateWorkspaceAssessmentPDF(workspaceAssessment(), context)],
  ["cis", generateCisReadinessPDF(cisSummary(), CIS_CONTEXT)],
  ["native-branded", generateNativeFrameworkPDF(nativeRun(), context, branding)],
  ["native-branded-logo", generateNativeFrameworkPDF(nativeRun(), context, { ...branding, logo: { dataUrl: pngLogo() } })],
  ...(extreme ? [
    ["native-extreme", generateNativeFrameworkPDF(nativeRun({ extreme: true }), context)],
    ["workspace-extreme", generateWorkspaceAssessmentPDF(workspaceAssessment({ extreme: true }), context)],
    ["cis-extreme", generateCisReadinessPDF(cisSummary({ extreme: true }), CIS_CONTEXT)],
  ] as [string, Uint8Array][] : []),
]
for (const [name, bytes] of reports) {
  writeFileSync(join(out, `${name}.pdf`), bytes)
  console.log(`${join(out, `${name}.pdf`)} ${bytes.length} bytes`)
}

/** Japanese tenant and policy names, to check that non-Latin tenant text prints as recorded. */
function japanese() {
  const report = oibComparisonReport()
  report.meta[0] = ["Tenant", "コントソ株式会社 東京本社"]
  report.sections[0]!.rows = report.sections[0]!.rows.map(row => [row[0]!, row[1]!, row[2]!, `${row[3] || row[2]!} (日本語ポリシー名 Ελληνικά Кириллица 中文策略)`, row[4]!, row[5]!])
  return report
}

const html: [string, unknown, PdfBranding?][] = [
  ["oib-comparison", oibComparisonReport()],
  ["oib-validation", oibValidationReport()],
  ["oib-comparison-branded", oibComparisonReport(), { ...branding, logo: { dataUrl: pngLogo() } }],
  ["oib-validation-branded-light", oibValidationReport(), { ...branding, colors: { primary: "#F2F4F7", accent: "#7C3AED" }, logo: { dataUrl: pngLogo() } }],
  ["oib-comparison-japanese", japanese()],
  ...(extreme ? [
    ["oib-comparison-extreme", oibComparisonReport({ extreme: true })],
    ["oib-validation-extreme", oibValidationReport({ extreme: true })],
  ] as [string, unknown][] : []),
]
for (const [name, payload, brand] of html) {
  const document = buildOibReport(parseReportPayload(payload), { exportedAt: EXPORTED_AT, branding: brand })
  writeFileSync(join(out, `${name}.html`), document.html)
  writeFileSync(join(out, `${name}.print.json`), JSON.stringify(document.print, null, 2))
  console.log(`${join(out, `${name}.html`)} ${document.html.length} characters`)
}
