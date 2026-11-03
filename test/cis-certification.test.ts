import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { cisDisclosures, findingRemediation, manualRemediation, recommendationRemediation, CIS_NOTICE, certifiedScopeLines, cisCertificationHeadline, cisCertificationStatement, cisRemediationLimits, CIS_CERTIFICATION_STATEMENT, CIS_CERTIFIED_SEGMENTS, CIS_REMEDIATION_LIMITS, CIS_TENANT_NOT_CERTIFIED_NOTE, isCisCertified, isCisCertifiedReference, parsePackReference } from "../src/shared/frameworks/cis-certification"
import { cisReadinessCsv, cisReadinessJson } from "../src/renderer/features/shared/governance-export"
import { cisExportLimitations, workspaceExportCSV, workspaceExportJSON, workspaceHistoryJSON, workspaceReportHeader } from "../src/shared/compliance/export"
import { generateCisReadinessPDF, generateWorkspaceAssessmentPDF } from "../src/shared/compliance/report-pdf"
import { MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL } from "../src/shared/frameworks/cis-manual"
import { isSelectableFinding } from "../src/shared/frameworks/cis-display"
import { cisSummary, workspaceAssessment } from "./pdf-report-fixtures"

const context = { exportedAt: "2026-11-02T09:00:00.000Z", tenantName: "Contoso" }

/** The text a PDF shows, joined with single spaces. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1")
  const parts: string[] = []
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { parts.push(inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1")) } catch { parts.push(match[1]!) }
  }
  const shown = parts.join("\n").match(/\((?:\\.|[^\\()])*\)\s*Tj/g) ?? []
  return shown.map(chunk => chunk.replace(/\)\s*Tj$/, "").slice(1).replace(/\\([()\\])/g, "$1")).join(" ").replace(/\s+/g, " ")
}
const cisSaved = () => { const saved = workspaceAssessment(); return { ...saved, assessment: { ...saved.assessment, frameworkId: "cis-benchmarks" } } }

describe("CIS certification scope", () => {
  it("names exactly the certified benchmarks, versions and Levels", () => {
    expect(CIS_CERTIFIED_SEGMENTS.map(segment => [segment.benchmark, segment.version, [...segment.levels]])).toEqual([
      ["intune-windows11", "5.0.0", [1]],
      ["intune-for-defender", "1.0.0", [1, 2]],
      ["mac-os-26", "1.0.0", [1, 2]],
    ])
    expect(certifiedScopeLines()).toEqual([
      "CIS Microsoft Intune for Windows 11 Benchmark v5.0.0, Level 1",
      "CIS Microsoft Intune for Microsoft Defender Antivirus Benchmark v1.0.0, Level 1 and Level 2",
      "CIS Apple macOS 26 Tahoe Intune Benchmark v1.0.0, Level 1 and Level 2",
    ])
  })

  it("never treats Windows 11 Level 2, another version or an uncertified benchmark as certified", () => {
    expect(isCisCertified("intune-windows11", "5.0.0", 1)).toBe(true)
    expect(isCisCertified("intune-windows11", "5.0.0", 2)).toBe(false)
    expect(isCisCertified("intune-windows11", "4.0.0", 1)).toBe(false)
    expect(isCisCertified("intune-for-defender", "1.0.0", 2)).toBe(true)
    expect(isCisCertified("mac-os-26", "1.0.0", 2)).toBe(true)
    for (const benchmark of ["office-intune-bk", "microsoft-intune-edge", "fakebook-os"]) {
      expect(isCisCertified(benchmark, "1.0.0", 1)).toBe(false)
      expect(isCisCertified(benchmark, "5.0.0", 1)).toBe(false)
    }
  })

  it("reads the certification of an assessment from its pack reference", () => {
    expect(parsePackReference("intune-windows11 5.0.0 Level 1")).toEqual({ benchmark: "intune-windows11", version: "5.0.0", level: 1 })
    expect(isCisCertifiedReference("intune-windows11 5.0.0 Level 1")).toBe(true)
    expect(isCisCertifiedReference("intune-windows11 5.0.0 Level 2")).toBe(false)
    expect(isCisCertifiedReference("microsoft-intune-edge 1.0.0 Level 1")).toBe(false)
    // A Build Kit import is never certified, even of a certified benchmark, version and Level.
    expect(isCisCertifiedReference("intune-windows11 5.0.0 Level 1", { kitImport: true })).toBe(false)
    for (const garbage of ["", "intune-windows11", "intune-windows11 5.0.0", "intune-windows11 5.0.0 Level 3", "approved workstation baseline, revision 3", "Intune-Windows11 5.0.0 Level 1"]) {
      expect(parsePackReference(garbage), garbage).toBeNull()
      expect(isCisCertifiedReference(garbage), garbage).toBe(false)
    }
  })

  it("states the certification, its scope and that everything else is not certified, in one paragraph", () => {
    expect(CIS_CERTIFICATION_STATEMENT).toBe("TenuVault is CIS Benchmarks Certified for Assessment and Remediation. The certification covers only these benchmarks and Levels: CIS Microsoft Intune for Windows 11 Benchmark v5.0.0, Level 1; CIS Microsoft Intune for Microsoft Defender Antivirus Benchmark v1.0.0, Level 1 and Level 2; CIS Apple macOS 26 Tahoe Intune Benchmark v1.0.0, Level 1 and Level 2. Other CIS Benchmarks, versions and Levels are not certified.")
    // A white label report names the certified software, never the customer company, as certified.
    expect(cisCertificationHeadline("Fabrikam")).not.toContain("Fabrikam")
    expect(cisCertificationStatement("Fabrikam")).not.toMatch(/tenuvault|fabrikam/i)
    expect(cisRemediationLimits("Fabrikam").join(" ")).not.toMatch(/tenuvault/i)
    for (const text of [CIS_CERTIFICATION_STATEMENT, CIS_TENANT_NOT_CERTIFIED_NOTE, ...CIS_REMEDIATION_LIMITS]) {
      expect(text).not.toMatch(/[\u2013\u2014]/)
      expect(text).not.toContain(" - ")
    }
  })

  it("puts the statement and the remediation limits in the readiness CSV and JSON", () => {
    const summary = cisSummary()
    const csv = cisReadinessCsv(summary)
    expect(csv).toContain(CIS_CERTIFICATION_STATEMENT)
    expect(csv).toContain("Certification")
    expect(csv).toContain("Remediation limits")
    expect(csv).toContain(CIS_REMEDIATION_LIMITS[0]!)
    // The CIS notice stays exactly as it was.
    expect(csv).toContain("Not all recommendations from the CIS Benchmarks are included in this tool.")
    const json = JSON.parse(cisReadinessJson(summary, "Contoso", context.exportedAt)) as { certification: { statement: string; certifiedScope: unknown[]; levels: { level: number; certified: boolean }[]; note: string }; remediationLimits: string[]; manualFallback: string }
    expect(json.certification.statement).toBe(CIS_CERTIFICATION_STATEMENT)
    expect(json.certification.certifiedScope).toHaveLength(3)
    expect(json.certification.levels).toEqual([{ level: 1, certified: false }, { level: 2, certified: false }])
    expect(json.certification.note).toBe(CIS_TENANT_NOT_CERTIFIED_NOTE)
    expect(json.remediationLimits).toEqual([...CIS_REMEDIATION_LIMITS])
    expect(json.manualFallback).toContain("Not all recommendations from the CIS Benchmarks are included in this tool.")
    const certified = JSON.parse(cisReadinessJson({ ...summary, benchmark: "intune-windows11", version: "5.0.0" }, null, context.exportedAt)) as { certification: { levels: { level: number; certified: boolean }[] } }
    expect(certified.certification.levels).toEqual([{ level: 1, certified: true }, { level: 2, certified: false }])
  })

  it("names the certified scope in the CIS findings JSON instead of the generic no-certification notice", () => {
    const saved = workspaceAssessment()
    const cis = { ...saved, assessment: { ...saved.assessment, frameworkId: "cis-benchmarks" } }
    const header = workspaceReportHeader(cis, context)
    expect(header.notice).toContain(CIS_CERTIFICATION_STATEMENT)
    expect(header.notice).not.toContain("No publisher affiliation, endorsement or certification is implied")
    expect(header.limitations[0]).toBe(cisExportLimitations("TenuVault")[0])
    expect(header.remediationLimits).toEqual([...CIS_REMEDIATION_LIMITS])
    expect(JSON.parse(workspaceExportJSON(cis, context)).report.notice).toContain(CIS_CERTIFICATION_STATEMENT)
    expect(JSON.parse(workspaceHistoryJSON([cis], context)).limitations[0]).toBe(cisExportLimitations("TenuVault")[0])
    // Other frameworks keep their notice and limitations.
    const other = workspaceReportHeader({ ...saved, assessment: { ...saved.assessment, frameworkId: "custom" } }, context)
    expect(other.notice).toContain("No publisher affiliation, endorsement or certification is implied")
    expect(other.remediationLimits).toBeUndefined()
  })

  it("carries the CIS notice with its link next to the certification in the findings JSON, and each finding's remediation capability", () => {
    const json = JSON.parse(workspaceExportJSON(cisSaved(), context)) as { report: { notice: string; cisNotice: { text: string; url: string }; remediationLimits: string[] }; result: { assessment: { findings: Array<{ status: string; remediationCapability: { label: string; reason: string } }> } } }
    expect(json.report.cisNotice).toEqual({ text: MANUAL_RECOMMENDATIONS_FALLBACK, url: MANUAL_RECOMMENDATIONS_URL })
    expect(json.report.notice).toContain(CIS_CERTIFICATION_STATEMENT)
    expect(json.report.remediationLimits).toEqual([...CIS_REMEDIATION_LIMITS])
    for (const finding of json.result.assessment.findings) {
      expect(finding.remediationCapability.label).toBe(finding.status === "Review" ? "Remediation: by TenuVault after a profile choice" : "Remediation: by TenuVault")
    }
    const history = JSON.parse(workspaceHistoryJSON([cisSaved()], context)) as { assessments: Array<{ report: { cisNotice: unknown } }> }
    expect(history.assessments[0]!.report.cisNotice).toEqual({ text: CIS_NOTICE.text, url: CIS_NOTICE.url })
    // Other frameworks get none of it.
    const other = JSON.parse(workspaceExportJSON(workspaceAssessment(), context)) as { report: object; result: { assessment: { findings: object[] } } }
    expect(other.report).not.toHaveProperty("cisNotice")
    expect(other.result.assessment.findings[0]).not.toHaveProperty("remediationCapability")
  })

  it("lists the CIS notice and remediation limits in the report layout CSV of a CIS assessment", () => {
    const csv = workspaceExportCSV(cisSaved(), context)
    expect(csv).toContain(`CIS notice,${MANUAL_RECOMMENDATIONS_FALLBACK} ${MANUAL_RECOMMENDATIONS_URL}`)
    for (const line of CIS_REMEDIATION_LIMITS) expect(csv).toContain(line)
    expect(workspaceExportCSV(workspaceAssessment(), context)).not.toContain("Remediation limit")
  })

  it("prints the certified scope, the remediation limits and the CIS notice with its link in the generic CIS PDF", () => {
    const text = pdfText(generateWorkspaceAssessmentPDF(cisSaved(), context))
    expect(text).toContain("TenuVault is CIS Benchmarks Certified for Assessment and Remediation.")
    expect(text).toContain("Limits of remediation")
    expect(text).toContain("Different settings are updated in place in the tenant policies that hold them.")
    expect(text).toContain("Not all recommendations from the CIS Benchmarks are included in this tool.")
    expect(text).toContain(MANUAL_RECOMMENDATIONS_URL)
    expect(text).toContain("Remediation: by TenuVault")
    // Each finding prints its reason beside the label, as the CSV and JSON do: a Present one reads as needing no change.
    expect(text).toContain("Remediation: by TenuVault. The setting already matches; no change is needed.")
    expect(text).toContain("Remediation: by TenuVault. TenuVault can remediate this setting with a reviewed deployment.")
    expect(text).toContain("Remediation: by TenuVault after a profile choice. The pack holds alternative values for this setting.")
    const other = pdfText(generateWorkspaceAssessmentPDF(workspaceAssessment(), context))
    expect(other).not.toContain("Limits of remediation")
    expect(other).not.toContain(MANUAL_RECOMMENDATIONS_URL)
  })

  it("states per recommendation and manual item whether TenuVault can remediate it, in the readiness CSV, JSON and PDF", () => {
    const summary = cisSummary()
    const json = JSON.parse(cisReadinessJson(summary, "Contoso", context.exportedAt)) as { cisNotice: unknown; levels: Array<{ recommendations?: Array<{ remediationCapability: { label: string } }>; manual: Array<{ remediationCapability: { label: string; reason: string } }> }>; manualItems: Array<{ state: string; remediationCapability: { label: string } }> }
    expect(json.cisNotice).toEqual({ text: MANUAL_RECOMMENDATIONS_FALLBACK, url: MANUAL_RECOMMENDATIONS_URL })
    expect(json.levels[0]!.recommendations?.every(item => item.remediationCapability.label.startsWith("Remediation: "))).toBe(true)
    expect(json.levels[0]!.manual[0]!.remediationCapability).toEqual({ label: "Remediation: manual action", reason: "CIS lists it as a manual recommendation. TenuVault does not assess or remediate it." })
    expect(json.manualItems.every(item => item.remediationCapability.label === "Remediation: manual action")).toBe(true)
    const csv = cisReadinessCsv(summary)
    expect(csv.split("\r\n")[0]).toContain("Remediation capability")
    expect(csv).toContain("Remediation: manual action. CIS lists it as a manual recommendation. TenuVault does not assess or remediate it.")
    const pdf = pdfText(generateCisReadinessPDF(summary, { ...context, tenantId: "11111111-1111-1111-1111-111111111111", assessedAt: "2026-11-01T09:00:00.000Z" }))
    expect(pdf).toContain("REMEDIATION CAPABILITY")
    expect(pdf).toContain("Manual action. CIS lists it as a manual recommendation.")
  })

  it("names recommendations outside the pack Not covered in the readiness CSV, JSON and PDF, apart from Not assessed recommendation results", () => {
    const summary = cisSummary()
    const level = summary.levels[0]!
    const notCovered = { identifier: "1.9.9", level: level.level, title: "Synthetic uncovered check", hasText: false, fallback: MANUAL_RECOMMENDATIONS_FALLBACK, fallbackUrl: MANUAL_RECOMMENDATIONS_URL, state: "Not covered" as const }
    const withItem = { ...summary, levels: [{ ...level, manual: [...level.manual, notCovered], notAssessed: ["1.9.9"] }, ...summary.levels.slice(1)] }
    const csv = cisReadinessCsv(withItem)
    expect(csv.split("\r\n")[0]).toContain("Coverage (%),Not covered,Note")
    expect(csv).toContain("Not covered,1.9.9,Synthetic uncovered check")
    const json = JSON.parse(cisReadinessJson(withItem, "Contoso", context.exportedAt)) as { manualItems: Array<{ identifier: string; state: string }> }
    expect(json.manualItems.find(item => item.identifier === "1.9.9")?.state).toBe("Not covered")
    const pdf = pdfText(generateCisReadinessPDF(withItem, { ...context, tenantId: "11111111-1111-1111-1111-111111111111", assessedAt: "2026-11-01T09:00:00.000Z" }))
    expect(pdf).toContain(`Not covered by the benchmark pack, Level ${level.level}`)
    expect(pdf).not.toContain("Not assessed by this tool")
    // Recommendation results keep Not assessed for a pack recommendation whose settings the pack does not all hold.
    expect(pdf).toContain("Not assessed")
  })

  it("derives the remediation indication from the rule the remediation engine plans by", () => {
    // The engine plans exactly the findings the display marks remediable.
    for (const status of ["Present", "Missing", "Different", "Review"] as const) expect(isSelectableFinding({ status })).toBe(findingRemediation(status) === "remediable")
    const setting = (status: "Present" | "Missing" | "Different" | "Review" | "Unmapped") => ({ id: `s-${status}`, status, findingKeys: [] })
    expect(recommendationRemediation({ settings: [setting("Missing"), setting("Present")] }).label).toBe("Remediation: by TenuVault")
    expect(recommendationRemediation({ settings: [setting("Review")] }).label).toBe("Remediation: by TenuVault after a profile choice")
    expect(recommendationRemediation({ settings: [setting("Different"), setting("Unmapped")] }).label).toBe("Remediation: partly by TenuVault, partly manual action")
    // A partial recommendation whose mapped setting is Review says the product part needs a profile choice, as the engine refuses Review findings.
    const mixed = recommendationRemediation({ settings: [setting("Unmapped"), setting("Review")] })
    expect(mixed).toMatchObject({ kind: "partial", label: "Remediation: partly by TenuVault after a profile choice, partly manual action" })
    expect(mixed.reason).toContain("choose the profile before it can be remediated")
    expect(recommendationRemediation({ settings: [setting("Review"), setting("Unmapped"), setting("Missing")] }).label).toBe("Remediation: partly by TenuVault after a profile choice, partly manual action")
    expect(recommendationRemediation({ settings: [setting("Different"), setting("Unmapped")] }).reason).not.toContain("profile")
    expect(recommendationRemediation({ settings: [setting("Unmapped")] }).label).toBe("Remediation: manual action")
    expect(recommendationRemediation({ settings: [] }).label).toBe("Remediation: manual action")
    expect(manualRemediation({ state: "Not covered" }).reason).toBe("The delivered benchmark pack does not cover it. TenuVault does not assess or remediate it.")
    // A white label names its own product and never TenuVault.
    expect(recommendationRemediation({ settings: [setting("Missing")] }, "Fabrikam Reports").label).toBe("Remediation: by Fabrikam Reports")
    const disclosures = cisDisclosures()
    expect(disclosures.cisNotice).toEqual({ text: MANUAL_RECOMMENDATIONS_FALLBACK, url: MANUAL_RECOMMENDATIONS_URL })
    expect(disclosures.remediationLimits).toEqual([...CIS_REMEDIATION_LIMITS])
    expect(disclosures.certification.statement).toBe(CIS_CERTIFICATION_STATEMENT)
    for (const text of [recommendationRemediation({ settings: [setting("Unmapped"), setting("Missing")] }).reason, mixed.reason, mixed.label, manualRemediation({ state: "Manual" }).reason]) {
      expect(text).not.toMatch(/[\u2013\u2014]/)
      expect(text).not.toContain(" - ")
    }
  })
})
