import { describe, expect, it } from "vitest"
import { generateCisReadinessPDF, generateNativeFrameworkPDF, generateWorkspaceAssessmentPDF } from "../src/shared/compliance/report-pdf"
import { EXPORT_LIMITATIONS, exportLimitations, frameworkUsageNotice, nativeExportCSV, workspaceExportCSV } from "../src/shared/compliance/export"
import { FRAMEWORK_USAGE_NOTICE } from "../src/shared/compliance/native"
import { COMPLIANCE_RULESET_VERSION } from "../src/shared/compliance/engine"
import { frameworkCoverageLabel } from "../src/shared/compliance/presentation"
import { MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL } from "../src/shared/frameworks/cis-manual"
import { TENUVAULT_THEME, luminance, parseHexColor, resolveBrandTheme } from "../src/shared/pdf/theme"
import { createLayout, type FlowBlock } from "../src/shared/pdf/layout"
import { distribution, drawCover } from "../src/shared/pdf/blocks"
import { ascii } from "../src/shared/pdf/kit"
import { CIS_CONTEXT, EXPORTED_AT, LONG_ID, LONG_MANUAL_TITLE, cisSummary, nativeRun, workspaceAssessment } from "./pdf-report-fixtures"
import { bodyText, expectInsideGrid, fileId, textRuns, linkCount, outlineTitles, pageStreams, pdfText, shown } from "./pdf-text"

const context = { exportedAt: EXPORTED_AT, tenantName: "Contoso Ltd" }
const ELV2 = "Framework detector code adapted from IntuneDocumentation, Ugur Koc and contributors, under Elastic License 2.0. Adapted on 30 September 2026 for TenuVault desktop collection, original restricted-framework descriptions and stored-comparison reports. The accompanying framework-NOTICES.txt contains the license and publisher attribution."
// A valid 1 by 1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const BRANDING = { companyName: "Fabrikam Security Services", colors: { primary: "#0B3D5C", accent: "#2BB3A3" }, preparedBy: "Avery Fabrikam", classification: "Confidential", logo: { dataUrl: PNG } }

const COVER_FOOTER = "Configuration comparison, not a certification"
/** The running header and footer each fixture report prints. */
const GRID = {
  native: (name = "NIST SP 800-53") => ({ header: [name, "Contoso Ltd"], footer: "TenuVault | Independent configuration comparison", coverFooter: ["TenuVault | Independent configuration comparison", COVER_FOOTER] as [string, string] }),
  workspace: (name = "Custom Baselines") => ({ header: [name, "Contoso Ltd"], footer: "TenuVault | Policy pack assessment", coverFooter: ["TenuVault | Policy pack assessment", COVER_FOOTER] as [string, string] }),
  cis: (footer = "TenuVault | CIS readiness report") => ({ header: ["CIS Microsoft Windows 11 Enterprise Benchmark", "Contoso Ltd"], footer, coverFooter: [footer, "Readiness comparison, not a certification"] as [string, string] }),
}

const reports = () => ({
  native: generateNativeFrameworkPDF(nativeRun(), context),
  workspace: generateWorkspaceAssessmentPDF(workspaceAssessment(), context),
  cis: generateCisReadinessPDF(cisSummary(), CIS_CONTEXT),
})

describe("report PDF layout", () => {
  it("produces byte identical output for the same input and export time", () => {
    const first = reports()
    const second = reports()
    for (const key of ["native", "workspace", "cis"] as const) expect(Buffer.from(first[key]).equals(Buffer.from(second[key]))).toBe(true)
    expect(Buffer.from(first.native).toString("latin1")).toContain("/CreationDate (D:20261014093000+00'00')")
  })

  it("derives the file id from non secret report facts only", () => {
    const run = nativeRun()
    const changed = structuredClone(run)
    changed.assessment.capabilities[0]!.checks[0]!.actualValue = "Bearer eyJhbGciOiJIUzI1NiJ9.c2VjcmV0.c2lnbmF0dXJl"
    const id = fileId(generateNativeFrameworkPDF(run, context))
    expect(id).toMatch(/^[0-9A-F]{32}$/)
    expect(fileId(generateNativeFrameworkPDF(changed, context))).toBe(id)
    expect(fileId(generateNativeFrameworkPDF({ ...run, snapshotSha256: "0".repeat(64) }, context))).not.toBe(id)
    expect(fileId(generateNativeFrameworkPDF(run, { ...context, exportedAt: "2026-10-15T09:30:00.000Z" }))).not.toBe(id)
    const saved = workspaceAssessment()
    const savedChanged = structuredClone(saved)
    savedChanged.assessment.findings[0]!.observed = [{ ...savedChanged.assessment.findings[0]!.observed[0]!, value: "hunter2" }]
    expect(fileId(generateWorkspaceAssessmentPDF(savedChanged, context))).toBe(fileId(generateWorkspaceAssessmentPDF(saved, context)))
    const summary = cisSummary()
    expect(fileId(generateCisReadinessPDF({ ...summary, manualNote: "A different note" }, CIS_CONTEXT))).toBe(fileId(generateCisReadinessPDF(summary, CIS_CONTEXT)))
  })

  it("prints the continued caption only when a block actually splits across pages", () => {
    const render = (fill: number, blocks: number[]) => {
      const layout = createLayout({ shortName: "Test", footer: "Test", sanitize: value => value, properties: { title: "T", subject: "S", keywords: "K" }, exportedAt: EXPORTED_AT, identity: ["test"], theme: TENUVAULT_THEME })
      layout.addPage()
      layout.y += fill
      const flow: FlowBlock[] = blocks.map((height, index) => ({ height, draw: top => { layout.doc.text(`Block ${index + 1}`, 15, top + 3) } }))
      layout.flow(flow, { caption: "Results table" })
      return pageStreams(layout.finish()).map(stream => shown(stream).join(" "))
    }
    // One block that does not fit moves whole to the next page: no caption.
    const moved = render(200, [80])
    expect(moved.join(" ")).not.toContain("(continued)")
    // A second block that does not fit splits the table: the caption names it on the next page.
    const split = render(150, [60, 80])
    expect(split.join(" ")).toContain("Results table (continued)")
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
    expectInsideGrid(native, GRID.native())
    expectInsideGrid(workspace, GRID.workspace())
    expectInsideGrid(cis, GRID.cis())
    // The 300 character identifier is wrapped, never cut: all of it is printed.
    const text = pdfText(native).replace(/\s/g, "")
    expect(text).toContain(LONG_ID)
    expect(pdfText(native)).toContain("Synthetic organizational aspect 30")
    expect(pageStreams(native).length).toBeGreaterThan(40)
    // A tall About panel continues after the contents instead of pushing them off the page.
    const pages = pageStreams(native).map(stream => shown(stream).join(" "))
    expect(pages[1]).toContain("About this report")
    expect(pages[1]).toContain("Contents")
    expect(pages.slice(2).join(" ")).toContain("About this report (continued)")
    expect(text).toContain("Syntheticlicenceparagraph60:".replace(/\s/g, ""))
    // A 9000 character manual title and an identifier too long for a chip are printed whole, wrapped in their columns.
    const column = (from: number, to: number) => pageStreams(cis).slice(1).flatMap(textRuns)
      .filter(run => run.x >= from && run.x < to && run.y > 14.6 && run.y < 282.5 && !run.text.endsWith("(continued)")).map(run => run.text).join("")
    // The title column starts after the 60 mm identifier column.
    expect(column(81, 196).replace(/\s/g, "")).toContain(`${LONG_MANUAL_TITLE} 1`.replace(/\s/g, ""))
    expect(column(18, 20)).toContain(`1.${LONG_ID}`)
    expect(bodyText(cis)).toContain("Review this synthetic manual recommendation.")
    // Every cell of the document control grid is printed, also with a long reference and branding.
    const branded = generateWorkspaceAssessmentPDF(workspaceAssessment({ extreme: true }), context, BRANDING)
    const cover = shown(pageStreams(branded)[0]!).join(" ")
    for (const label of ["Policy pack", "Tenant ID", "Report ID", "Profile", "Policies read", "Pack policies", "Assessed", "Exported", "Prepared by", "Avery Fabrikam", "Classification", "Confidential"]) expect(cover).toContain(label)
    expectInsideGrid(branded, { header: ["Custom Baselines", "Contoso Ltd"], footer: "Fabrikam Security Services", coverFooter: ["Fabrikam Security Services", COVER_FOOTER] })
  })

  it("keeps the heading, bar and every legend row of a distribution on one page", () => {
    const layout = createLayout({ shortName: "Test", footer: "Test", sanitize: value => value, properties: { title: "T", subject: "S", keywords: "K" }, exportedAt: EXPORTED_AT, identity: ["test"], theme: TENUVAULT_THEME })
    layout.addPage()
    // Room for the heading and the bar, not for three legend rows.
    layout.y = 276 - 22
    const items = Array.from({ length: 12 }, (_, index) => ({ label: `Status label number ${index + 1}`, count: index + 1, marker: "filled" as const, color: [31, 133, 83] as [number, number, number] }))
    distribution(layout, { title: "Status distribution", note: "78 policies", items, total: 78 })
    const pages = pageStreams(layout.finish())
    expect(pages).toHaveLength(3)
    const last = shown(pages[2]!).join(" ")
    expect(last).toContain("Status distribution")
    for (const item of items) expect(last).toContain(item.label)
    expectInsideGrid(layout.finish(), { header: ["Test"], footer: "TenuVault | Test", coverFooter: ["", ""] })
  })

  it("prints every document control cell on the cover, shrinking the grid when it is full", () => {
    const theme = resolveBrandTheme({ companyName: "Fabrikam", preparedBy: `Avery Fabrikam ${"for the security office ".repeat(4)}`, classification: "Confidential" })
    const layout = createLayout({ shortName: "Test", footer: "Test", sanitize: value => value, properties: { title: "T", subject: "S", keywords: "K" }, exportedAt: EXPORTED_AT, identity: ["test"], theme })
    const control = Array.from({ length: 22 }, (_, index) => ({ label: `Field ${index + 1}`, value: `Value ${index + 1} ${"long words ".repeat(index % 3 ? 2 : 9)}`, span: index % 5 === 0 ? 2 as const : 1 as const }))
    drawCover(layout, { eyebrow: "E", title: "Title", tenant: "Contoso", facts: [], ring: 0, donuts: [{ segments: [], total: 0, value: "0%" }], donutCaption: "C", donutSub: "S", glance: [], control, footerRight: "Right" })
    const bytes = layout.finish()
    const cover = textRuns(pageStreams(bytes)[0]!)
    for (const label of [...control.map(cell => cell.label), "Prepared by", "Classification", "Confidential"]) expect(cover.map(run => run.text)).toContain(label)
    expectInsideGrid(bytes, { header: [], footer: "", coverFooter: ["Fabrikam", "Right"] })
  })

  it("normalises typographic dashes, quotes and ellipses for Helvetica", () => {
    expect(ascii("a\u2010b\u2013c\u2014d\u2015e \u2018s\u2019 \u201cq\u201d \u2026")).toBe("a-b-c-d-e 's' \"q\" ...")
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
      "Grace Hopper", "Ensure the account lockout threshold is reviewed", "Set the threshold to 5 or fewer invalid attempts.", "With exclusions 70% with 2 exclusions", "Recommendation pass rate 60%", "Not assessed"]) expect(text).toContain(expected)
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

  it("prints tenant data that names TenuVault exactly as recorded and brands only product text", () => {
    const TENANT_TEXT = "TenuVault Baseline"
    const COMPANY = BRANDING.companyName
    const ISO_BASIS = "Publisher content basis: reference-only, original TenuVault descriptions"
    // The mapping version id is an identifier; a narrow cell may wrap it after any character.
    const MAPPING_ID = new RegExp([...COMPLIANCE_RULESET_VERSION].map(char => char.replace(".", "\\.")).join("\\s?"), "g")
    // What may still name TenuVault in a white label report: the verbatim licence text, tenant data and the mapping version id.
    const rest = (text: string) => [ELV2, ISO_BASIS, TENANT_TEXT].reduce((value, part) => value.replaceAll(part, ""), text).replace(MAPPING_ID, "")
    const expectTenantTextKept = (text: string) => {
      expect(text).toContain(TENANT_TEXT)
      expect(text).not.toContain(`${COMPANY} Baseline`)
      expect(rest(text)).not.toMatch(/tenuvault/i)
    }

    const run = nativeRun({ frameworkId: "iso-27001", nativeId: "iso-27001-2022" })
    const cap = run.assessment.capabilities.find(item => item.evidence.length && item.checks.some(check => check.policyId))!
    const check = cap.checks.find(item => item.policyId)!
    check.policyName = TENANT_TEXT
    check.actualValue = TENANT_TEXT
    cap.evidence[0]!.policyName = TENANT_TEXT
    const native = pdfText(generateNativeFrameworkPDF(run, context, BRANDING))
    expectTenantTextKept(native)
    expect(native).toContain(`POLICY ${TENANT_TEXT}`)
    expect(native).toContain(`Source metadata: ${TENANT_TEXT}, version 4`)
    for (const branded of [frameworkUsageNotice(COMPANY), exportLimitations(COMPANY)[0]!, `${COMPANY} compares selected capabilities:`]) expect(native).toContain(branded)
    const plain = pdfText(generateNativeFrameworkPDF(run, context))
    for (const original of [FRAMEWORK_USAGE_NOTICE, EXPORT_LIMITATIONS[0]!, "TenuVault compares selected capabilities:", `POLICY ${TENANT_TEXT}`]) expect(plain).toContain(original)
    expect(plain).not.toContain(COMPANY)

    const saved = workspaceAssessment()
    saved.assessment.findings[0]!.policyName = TENANT_TEXT
    saved.assessment.findings[0]!.observed[0]!.policyName = TENANT_TEXT
    saved.creation!.results[0]!.name = TENANT_TEXT
    const workspace = pdfText(generateWorkspaceAssessmentPDF(saved, context, BRANDING))
    expectTenantTextKept(workspace)
    expect(workspace).toContain(`${TENANT_TEXT} (assignment evidence: unavailable)`)
    expect(workspace).toContain(exportLimitations(COMPANY)[0]!)
    expect(pdfText(generateWorkspaceAssessmentPDF(saved, context))).toContain(EXPORT_LIMITATIONS[0]!)

    const summary = cisSummary()
    summary.levels[0]!.exceptions[0]!.policyName = TENANT_TEXT
    const cis = pdfText(generateCisReadinessPDF(summary, CIS_CONTEXT, BRANDING))
    expectTenantTextKept(cis)
    expect(cis).toContain(`Level 1: ${COMPANY} checks`)
    expect(cis).toContain(exportLimitations(COMPANY)[0]!)
    const cisPlain = pdfText(generateCisReadinessPDF(summary, CIS_CONTEXT))
    expect(cisPlain).toContain("Level 1: TenuVault checks")
    expect(cisPlain).toContain(EXPORT_LIMITATIONS[0]!)

    // CSV exports keep naming TenuVault.
    expect(nativeExportCSV(run, context)).toContain("TenuVault independent configuration comparison")
    expect(nativeExportCSV(run, context)).toContain(EXPORT_LIMITATIONS[0]!)
    expect(workspaceExportCSV(saved, context)).toContain("TenuVault policy pack assessment")
  })

  it("cleans branding text in the document properties and keeps it out of the file id", () => {
    const secret = (name: string) => ({ ...BRANDING, companyName: name })
    const first = generateNativeFrameworkPDF(nativeRun(), context, secret("Fabrikam Bearer abcdef123456789"))
    const second = generateNativeFrameworkPDF(nativeRun(), context, secret("Fabrikam Bearer zyxwvu987654321"))
    for (const bytes of [first, second]) {
      const raw = Buffer.from(bytes).toString("latin1")
      const author = /\/Author \(([^)]*)\)/.exec(raw)?.[1]
      const creator = /\/Creator \(([^)]*)\)/.exec(raw)?.[1]
      expect(author).toMatch(/^Fabrikam /)
      expect(creator).toBe(author)
      expect(raw).not.toContain("abcdef123456789")
      expect(raw).not.toContain("zyxwvu987654321")
    }
    // The file id knows only whether the report is branded, never the company name.
    expect(fileId(first)).toBe(fileId(second))
    expect(fileId(first)).not.toBe(fileId(generateNativeFrameworkPDF(nativeRun(), context)))
    const workspace = (name: string) => fileId(generateWorkspaceAssessmentPDF(workspaceAssessment(), context, secret(name)))
    expect(workspace("Fabrikam")).toBe(workspace("Northwind Traders"))
    const cis = (name: string) => fileId(generateCisReadinessPDF(cisSummary(), CIS_CONTEXT, secret(name)))
    expect(cis("Fabrikam")).toBe(cis("Northwind Traders"))
  })

  it("falls back to the default design for invalid colours and skips an unreadable logo", () => {
    const bytes = generateCisReadinessPDF(cisSummary(), CIS_CONTEXT, { companyName: "Fabrikam", colors: { primary: "navy" }, logo: { dataUrl: "data:image/png;base64,AAAA" } })
    const streams = pageStreams(bytes).join("\n")
    expect(streams).toContain("0.09 0.08 0.08 rg")
    expect(Buffer.from(bytes).toString("latin1")).not.toMatch(/\/Subtype \/Image/)
    expect(pdfText(bytes)).toContain("Fabrikam")
    expectInsideGrid(bytes, GRID.cis("Fabrikam"))
  })
})
