import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { generateCisReadinessPDF, generateNativeFrameworkPDF, generateWorkspaceAssessmentPDF } from "../src/shared/compliance/report-pdf"
import { generateOibReportPDF } from "../src/shared/oib/report-pdf"
import { CIS_CONTEXT, EXPORTED_AT, cisSummary, nativeRun, oibComparisonReport, oibValidationReport, pngLogo, workspaceAssessment } from "../test/pdf-report-fixtures"

/**
 * Renders the framework and OpenIntuneBaseline PDF reports from fictional Contoso fixtures for visual review.
 * Usage:
 *   npx jiti scripts/render-sample-reports.ts [output folder]
 *   pdftoppm -r 70 -png /tmp/tv-pdf/native.pdf /tmp/tv-pdf/native
 * With --extreme the inputs that stress the layout are rendered as well.
 */

const out = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "/tmp/tv-pdf"
const extreme = process.argv.includes("--extreme")
mkdirSync(out, { recursive: true })
const context = { exportedAt: EXPORTED_AT, tenantName: "Contoso Ltd" }
const branding = { companyName: "Fabrikam Security Services", colors: { primary: "#0B3D5C", accent: "#2BB3A3" }, preparedBy: "Fabrikam Security Services", classification: "Confidential", footerText: "Fabrikam | Intune configuration review" }
const reports: [string, Uint8Array][] = [
  ["native", generateNativeFrameworkPDF(nativeRun(), context)],
  ["native-e8", generateNativeFrameworkPDF(nativeRun({ frameworkId: "essential-eight", nativeId: "essential-eight", scope: { platforms: ["windows"], essentialEightMaturityLevel: 2 } }), context)],
  ["workspace", generateWorkspaceAssessmentPDF(workspaceAssessment(), context)],
  ["cis", generateCisReadinessPDF(cisSummary(), CIS_CONTEXT)],
  ["native-branded", generateNativeFrameworkPDF(nativeRun(), context, branding)],
  ["native-branded-logo", generateNativeFrameworkPDF(nativeRun(), context, { ...branding, logo: { dataUrl: pngLogo() } })],
  ["oib-comparison", generateOibReportPDF(oibComparisonReport(), { exportedAt: EXPORTED_AT })],
  ["oib-validation", generateOibReportPDF(oibValidationReport(), { exportedAt: EXPORTED_AT })],
  ["oib-comparison-branded", generateOibReportPDF(oibComparisonReport(), { exportedAt: EXPORTED_AT, branding: { ...branding, logo: { dataUrl: pngLogo() } } })],
  ["oib-validation-branded", generateOibReportPDF(oibValidationReport(), { exportedAt: EXPORTED_AT, branding: { ...branding, colors: { primary: "#F2F4F7", accent: "#7C3AED" }, logo: { dataUrl: pngLogo() } } })],
  ...(extreme ? [
    ["native-extreme", generateNativeFrameworkPDF(nativeRun({ extreme: true }), context)],
    ["workspace-extreme", generateWorkspaceAssessmentPDF(workspaceAssessment({ extreme: true }), context)],
    ["cis-extreme", generateCisReadinessPDF(cisSummary({ extreme: true }), CIS_CONTEXT)],
    ["oib-comparison-extreme", generateOibReportPDF(oibComparisonReport({ extreme: true }), { exportedAt: EXPORTED_AT })],
    ["oib-validation-extreme", generateOibReportPDF(oibValidationReport({ extreme: true }), { exportedAt: EXPORTED_AT })],
  ] as [string, Uint8Array][] : []),
]
for (const [name, bytes] of reports) {
  writeFileSync(join(out, `${name}.pdf`), bytes)
  console.log(`${join(out, `${name}.pdf`)} ${bytes.length} bytes`)
}
