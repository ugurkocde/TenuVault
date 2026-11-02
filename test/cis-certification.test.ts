import { describe, expect, it } from "vitest"
import { certifiedScopeLines, cisCertificationHeadline, cisCertificationStatement, cisRemediationLimits, CIS_CERTIFICATION_STATEMENT, CIS_CERTIFIED_SEGMENTS, CIS_REMEDIATION_LIMITS, CIS_TENANT_NOT_CERTIFIED_NOTE, isCisCertified } from "../src/shared/frameworks/cis-certification"
import { cisReadinessCsv, cisReadinessJson } from "../src/renderer/features/shared/governance-export"
import { cisExportLimitations, workspaceExportJSON, workspaceHistoryJSON, workspaceReportHeader } from "../src/shared/compliance/export"
import { cisSummary, workspaceAssessment } from "./pdf-report-fixtures"

const context = { exportedAt: "2026-11-02T09:00:00.000Z", tenantName: "Contoso" }

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

  it("states the certification, its scope and that everything else is not certified, in one paragraph", () => {
    expect(CIS_CERTIFICATION_STATEMENT).toBe("TenuVault is CIS Benchmarks Certified for Assessment and Remediation. The certification covers only these benchmarks and Levels: CIS Microsoft Intune for Windows 11 Benchmark v5.0.0, Level 1; CIS Microsoft Intune for Microsoft Defender Antivirus Benchmark v1.0.0, Level 1 and Level 2; CIS Apple macOS 26 Tahoe Intune Benchmark v1.0.0, Level 1 and Level 2. Other CIS Benchmarks, versions and Levels are not certified.")
    // A white label report names the certified software, never the customer company, as certified.
    expect(cisCertificationHeadline("Fabrikam")).not.toContain("Fabrikam")
    expect(cisCertificationStatement("Fabrikam")).not.toMatch(/tenuvault|fabrikam/i)
    expect(cisRemediationLimits("Fabrikam").join(" ")).not.toMatch(/tenuvault/i)
    for (const text of [CIS_CERTIFICATION_STATEMENT, CIS_TENANT_NOT_CERTIFIED_NOTE, ...CIS_REMEDIATION_LIMITS]) {
      expect(text).not.toMatch(/[–—]/)
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
})
