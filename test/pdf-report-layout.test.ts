import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { generateCisReadinessPDF, generateNativeFrameworkPDF, generateWorkspaceAssessmentPDF } from "../src/shared/compliance/report-pdf"
import { EXPORT_LIMITATIONS } from "../src/shared/compliance/export"
import { FRAMEWORK_USAGE_NOTICE } from "../src/shared/compliance/native"
import { frameworkCoverageLabel } from "../src/shared/compliance/presentation"
import { MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL } from "../src/shared/frameworks/cis-manual"
import { TENUVAULT_THEME, luminance, parseHexColor, resolveBrandTheme } from "../src/shared/pdf/theme"
import { CIS_CONTEXT, EXPORTED_AT, LONG_ID, cisSummary, nativeRun, workspaceAssessment } from "./pdf-report-fixtures"

const context = { exportedAt: EXPORTED_AT, tenantName: "Contoso Ltd" }
const MM = 72 / 25.4
const PAGE_HEIGHT = 297 * MM
// Body text sits between the header rule (14.6 mm from the top) and the footer rule (14.5 mm from the bottom).
const HEADER_RULE = PAGE_HEIGHT - 14.6 * MM
const FOOTER_RULE = 14.5 * MM
const LEFT = 15 * MM
const RIGHT = 195 * MM
const ELV2 = "Framework detector code adapted from IntuneDocumentation, Ugur Koc and contributors, under Elastic License 2.0. Adapted on 30 September 2026 for TenuVault desktop collection, original restricted-framework descriptions and stored-comparison reports. The accompanying framework-NOTICES.txt contains the license and publisher attribution."
// A valid 1 by 1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const BRANDING = { companyName: "Fabrikam Security Services", colors: { primary: "#0B3D5C", accent: "#2BB3A3" }, preparedBy: "Avery Fabrikam", classification: "Confidential", logo: { dataUrl: PNG } }

/** Decompressed content stream of every page, in page order. */
function pageStreams(bytes: Uint8Array): string[] {
  const pdf = Buffer.from(bytes)
  const source = pdf.toString("latin1")
  const stream = (id: number) => {
    const start = source.search(new RegExp(`(^|\\s)${id} 0 obj`))
    const dataStart = source.indexOf("stream\n", start) + "stream\n".length
    const length = Number(/\/Length\s+(\d+)/.exec(source.slice(start, dataStart))?.[1] ?? 0)
    return inflateSync(pdf.subarray(dataStart, dataStart + length)).toString("latin1")
  }
  return [...source.matchAll(/\d+ 0 obj\s*<<\s*\/Type \/Page\b(?!s)/g)].map(match => {
    const contents = /\/Contents (\d+) 0 R/.exec(source.slice(match.index, source.indexOf("endobj", match.index)))?.[1]
    return contents ? stream(Number(contents)) : ""
  })
}

const shown = (stream: string) => (stream.match(/\((?:\\.|[^\\()])*\)\s*Tj/g) ?? []).map(chunk => chunk.replace(/\)\s*Tj$/, "").slice(1).replace(/\\([()\\])/g, "$1"))
const pdfText = (bytes: Uint8Array) => pageStreams(bytes).flatMap(shown).join(" ").replace(/\s+/g, " ")
const positions = (stream: string) => [...stream.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) Td/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
const outlineTitles = (bytes: Uint8Array) => [...Buffer.from(bytes).toString("latin1").matchAll(/\/Title \(((?:\\.|[^\\)])*)\)\s*\/Parent/g)].map(match => match[1]!.replace(/\\([()\\])/g, "$1"))
const linkCount = (bytes: Uint8Array) => (Buffer.from(bytes).toString("latin1").match(/\/Subtype \/Link[^>]*\/Dest \[/g) ?? []).length

const reports = () => ({
  native: generateNativeFrameworkPDF(nativeRun(), context),
  workspace: generateWorkspaceAssessmentPDF(workspaceAssessment(), context),
  cis: generateCisReadinessPDF(cisSummary(), CIS_CONTEXT),
})

/** Every text position lies inside the page grid: header and footer lines in their bands, body text between the rules. */
function expectInsideGrid(bytes: Uint8Array) {
  pageStreams(bytes).forEach((stream, index) => {
    for (const { x, y } of positions(stream)) {
      expect(x, `page ${index + 1}`).toBeGreaterThanOrEqual(LEFT - 0.5)
      expect(x, `page ${index + 1}`).toBeLessThanOrEqual(RIGHT + 0.5)
      expect(y, `page ${index + 1}`).toBeGreaterThanOrEqual(0)
      const footer = y < FOOTER_RULE - 6
      const header = y > HEADER_RULE + 4
      if (index > 0 && !footer && !header) {
        expect(y, `page ${index + 1}`).toBeGreaterThan(FOOTER_RULE)
        expect(y, `page ${index + 1}`).toBeLessThan(HEADER_RULE)
      }
    }
  })
}

describe("report PDF layout", () => {
  it("produces byte identical output for the same input and export time", () => {
    const first = reports()
    const second = reports()
    for (const key of ["native", "workspace", "cis"] as const) expect(Buffer.from(first[key]).equals(Buffer.from(second[key]))).toBe(true)
    expect(Buffer.from(first.native).toString("latin1")).toContain("/CreationDate (D:20261014093000+00'00')")
  })

  it("numbers every page after the cover and keeps the TenuVault footer", () => {
    const { native, workspace, cis } = reports()
    for (const [bytes, footer, minimum] of [[native, "Independent configuration comparison", 10], [workspace, "Policy pack assessment", 5], [cis, "CIS readiness report", 6]] as const) {
      const pages = pageStreams(bytes)
      expect(pages.length).toBeGreaterThanOrEqual(minimum)
      pages.forEach((stream, index) => {
        if (index === 0) return
        expect(shown(stream)).toContain(`Page ${index + 1} of ${pages.length}`)
        expect(shown(stream)).toContain(`TenuVault | ${footer}`)
      })
    }
  })

  it("writes bookmarks for each section and clickable contents rows", () => {
    const { native, workspace, cis } = reports()
    expect(outlineTitles(native)).toEqual(expect.arrayContaining(["Contents", "Summary", "Scope and limitations", "Results overview", "Collection completeness", "Framework references and evidence", "Provenance and attribution", "AC-2 Account Management"]))
    expect(outlineTitles(workspace)).toEqual(expect.arrayContaining(["Summary", "Findings by status", "Missing (6)", "Recorded creation outcome"]))
    expect(outlineTitles(cis)).toEqual(expect.arrayContaining(["Summary", "Level 1 readiness", "Level 2 readiness", "Accepted exceptions, Level 1", "Recommendation results, Level 2", "Manual recommendations, Level 1"]))
    for (const bytes of [native, workspace, cis]) expect(linkCount(bytes)).toBeGreaterThanOrEqual(outlineTitles(bytes).length - 1)
    expect(pdfText(native)).toContain("Contents")
  })

  it("keeps every line inside the page grid on extreme input", () => {
    const run = nativeRun({ extreme: true })
    expect(run.assessment.frameworks[0]!.controls.length).toBeGreaterThanOrEqual(40)
    expect(run.assessment.capabilities[0]!.checks.length).toBeGreaterThan(200)
    const native = generateNativeFrameworkPDF(run, context)
    const workspace = generateWorkspaceAssessmentPDF(workspaceAssessment({ extreme: true }), context)
    const cis = generateCisReadinessPDF(cisSummary({ extreme: true }), CIS_CONTEXT)
    for (const bytes of [native, workspace, cis]) expectInsideGrid(bytes)
    // The 300 character identifier is wrapped, never cut: all of it is printed.
    const text = pdfText(native).replace(/\s/g, "")
    expect(text).toContain(LONG_ID)
    expect(pdfText(native)).toContain("Synthetic organizational aspect 30")
    expect(pageStreams(native).length).toBeGreaterThan(40)
  })

  it("prints the facts, limitations, provenance and licence text of the native report", () => {
    const run = nativeRun()
    const text = pdfText(generateNativeFrameworkPDF(run, context))
    for (const expected of [
      ...EXPORT_LIMITATIONS, FRAMEWORK_USAGE_NOTICE, ELV2, frameworkCoverageLabel(run.assessment.frameworks[0]!) ?? "10 selected technical references. This subset is not the complete framework.",
      "Counts cover capabilities once, using the best assigned policy evidence.",
      run.snapshotSha256, run.rulesetSha256, `IntuneDocumentation ${run.sourceCommit}`,
      "Publisher content basis: NIST technical publications worldwide royalty-free reuse",
      "Worldwide royalty-free reuse terms and attribution: https://www.nist.gov/open/license .",
      "Hashes identify the collected snapshot and mapped ruleset.",
      "Graph returned 403 for one security baseline.",
      "Policy ID: 00000000-0000-4000-8000-000000000101", "Targets: Group: All Corporate Devices", "Exclusions: Group: Kiosk Devices",
      "Source metadata: WIN Baseline BitLocker, version 4, modified 2026-09-28T14:10:00Z",
      "Group membership, filter evaluation and device enforcement are unverified.",
      "Setting configured and assigned", "Matches", "Different", "Missing", "Unable to check", "Outside scope",
    ]) expect(text).toContain(expected)
    const e8 = pdfText(generateNativeFrameworkPDF(nativeRun({ frameworkId: "essential-eight", nativeId: "essential-eight", scope: { platforms: ["windows"], essentialEightMaturityLevel: 2 } }), context))
    expect(e8).toContain("Creative Commons Attribution 4.0: https://creativecommons.org/licenses/by/4.0/")
    expect(e8).toContain("Essential Eight target maturity 2")
    const cyber = pdfText(generateNativeFrameworkPDF({ ...nativeRun({ frameworkId: "cyber-essentials", nativeId: "cyber-essentials-v3" }) }, context))
    expect(cyber).toContain("Open Government Licence v3.0")
  })

  it("prints the findings, observed policies and creation outcome of a policy pack assessment", () => {
    const text = pdfText(generateWorkspaceAssessmentPDF(workspaceAssessment(), context))
    for (const expected of ["Policy pack assessment", "Contoso workstation baseline v3", "Missing (6)", "Different (3)", "Present (14)", "WIN Tenant policy 3 (assignment evidence: configured)",
      "No matching root setting in the assessed policy family.", "Some policies could not be created.", "Created, unassigned", "Graph returned 400: the setting value is not valid for this template.",
      '"Present" means a matching configuration exists; it does not mean the setting is assigned or enforced.']) expect(text).toContain(expected)
  })

  it("prints the CIS notice, coverage, exceptions and manual recommendations", () => {
    const text = pdfText(generateCisReadinessPDF(cisSummary(), CIS_CONTEXT))
    for (const expected of [MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL, "Coverage: 75% (72 of 96), source: Authoritative denominator", "18.4.1, 18.4.2, 18.9.7, 18.10.3",
      "Grace Hopper", "Ensure the account lockout threshold is reviewed", "Set the threshold to 5 or fewer invalid attempts.", "Adjusted recommendation pass rate 70%", "Not assessed"]) expect(text).toContain(expected)
  })
})

describe("report PDF branding", () => {
  it("resolves customer colours strictly and falls back to TenuVault", () => {
    expect(parseHexColor("#0B3D5C")).toEqual([11, 61, 92])
    for (const invalid of ["red", "#FFF", "#GGGGGG", "0B3D5C", undefined, 12]) expect(parseHexColor(invalid)).toBeUndefined()
    expect(resolveBrandTheme()).toBe(TENUVAULT_THEME)
    // Without a company name the branding is ignored entirely.
    expect(resolveBrandTheme({ companyName: "   ", colors: { primary: "#FF0000" } })).toBe(TENUVAULT_THEME)
    const fallback = resolveBrandTheme({ companyName: "Fabrikam", colors: { primary: "red", accent: "#12345" }, logo: { dataUrl: "javascript:alert(1)" } })
    expect(fallback.primary).toEqual(TENUVAULT_THEME.primary)
    expect(fallback.accent).toEqual(TENUVAULT_THEME.accent)
    expect(fallback.logoDataUrl).toBeUndefined()
    const light = resolveBrandTheme({ companyName: "Fabrikam", colors: { primary: "#F5F0E6", accent: "#FFD400" } })
    expect(light.onBand).toEqual([22, 21, 20])
    expect(luminance(light.strong)).toBeLessThanOrEqual(0.18)
    expect(luminance(light.accentText)).toBeLessThanOrEqual(0.18)
    expect(resolveBrandTheme({ companyName: "Fabrikam", colors: { primary: "#0B3D5C" } }).onBand).toEqual([255, 255, 255])
  })

  it("renders a white label report with the customer colours, labels and logo", () => {
    const run = nativeRun()
    const bytes = generateNativeFrameworkPDF(run, context, BRANDING)
    const raw = Buffer.from(bytes).toString("latin1")
    const streams = pageStreams(bytes).join("\n")
    expect(streams).toContain("0.04 0.24 0.36 rg")
    expect(streams).toContain("0.17 0.7 0.64 rg")
    expect(raw).toMatch(/\/Subtype \/Image/)
    expect(raw).toContain("/Author (Fabrikam Security Services)")
    expect(raw).toContain("/Creator (Fabrikam Security Services)")
    const text = pdfText(bytes)
    for (const expected of ["Avery Fabrikam", "Confidential", "Fabrikam Security Services", ELV2]) expect(text).toContain(expected)
    // TenuVault appears only in the verbatim licence attribution.
    expect(text.replace(ELV2, "")).not.toContain("TenuVault")
    expect(outlineTitles(bytes).join(" ")).not.toContain("TenuVault")
    expect(Buffer.from(generateNativeFrameworkPDF(run, context, BRANDING)).equals(Buffer.from(bytes))).toBe(true)
    // Licence text stays verbatim: the ELv2 attribution and the publisher content basis of rights.json.
    const iso = pdfText(generateNativeFrameworkPDF(nativeRun({ frameworkId: "iso-27001", nativeId: "iso-27001-2022" }), context, BRANDING))
    expect(iso).toContain("Publisher content basis: reference-only, original TenuVault descriptions")
    expect(iso.replace(ELV2, "").replace("Publisher content basis: reference-only, original TenuVault descriptions", "")).not.toContain("TenuVault")
    expect(iso).toContain("Independent Fabrikam Security Services configuration mapping.")
    for (const other of [generateWorkspaceAssessmentPDF(workspaceAssessment(), context, BRANDING), generateCisReadinessPDF(cisSummary(), CIS_CONTEXT, { ...BRANDING, footerText: "Fabrikam | Review", logo: undefined })]) {
      expect(pdfText(other)).not.toContain("TenuVault")
    }
    expect(pdfText(generateCisReadinessPDF(cisSummary(), CIS_CONTEXT, { ...BRANDING, footerText: "Fabrikam | Review", logo: undefined }))).toContain("Fabrikam | Review")
  })

  it("falls back to the default design for invalid colours and skips an unreadable logo", () => {
    const bytes = generateCisReadinessPDF(cisSummary(), CIS_CONTEXT, { companyName: "Fabrikam", colors: { primary: "navy" }, logo: { dataUrl: "data:image/png;base64,AAAA" } })
    const streams = pageStreams(bytes).join("\n")
    expect(streams).toContain("0.09 0.08 0.08 rg")
    expect(Buffer.from(bytes).toString("latin1")).not.toMatch(/\/Subtype \/Image/)
    expect(pdfText(bytes)).toContain("Fabrikam")
    expectInsideGrid(bytes)
  })
})
