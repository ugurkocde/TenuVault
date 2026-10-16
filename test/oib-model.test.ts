import { describe, expect, it } from "vitest"
import { compareAdminTemplate, compareFlat, compareSettings, validatePolicy } from "../src/shared/oib/compare"
import { policyGate, typeGate, type TenantProfile } from "../src/shared/oib/licensing"
import { catalogPolicies, extractOibId, parseManifest } from "../src/shared/oib/manifest"
import { baseName, compareToTenant, compareVersions, policyVersion } from "../src/shared/oib/match"
import { parseReportPayload, REPORT_LIMITS, statusTone, toCsv } from "../src/shared/oib/report"
import { generateOibReportPDF } from "../src/shared/oib/report-pdf"
import { EXPORTED_AT, TENANT_ID, oibComparisonReport, oibValidationReport, pngLogo } from "./pdf-report-fixtures"
import { expectInsideGrid, fileId, outlineTitles, pageStreams, pdfText, shown } from "./pdf-text"
import type { OibPolicy, TenantPolicy } from "../src/shared/oib/types"
import { replaceTenantVariables } from "../src/shared/oib/variables"

const A = "92CE33B8-FF64-4604-A18D-35555F26C4BE"
const B = "86EB0653-DD3D-4CBA-BB51-1FFDC3E1F39C"
const C = "80C1B821-B768-43A5-B318-7E2A54290FD8"
const D = "288E75FB-FA36-4161-8A92-EE638D902C06"

const policy = (name: string, extra: Partial<OibPolicy> = {}): OibPolicy => ({
  source: `WINDOWS/IntuneManagement/SettingsCatalog/${name}.json`, name, folder: "ConfigurationPolicies", policyType: "SettingsCatalog",
  previousVersions: [], replacements: [], skuRequirements: "", licenseRequirements: "", status: "active", ...extra,
})
const tenant = (id: string, name: string, oibId?: string, folder = "ConfigurationPolicies"): TenantPolicy => ({ id, name, folder, oibId })

describe("PolicyManifest.json", () => {
  it("reads entries, normalises OIBID lists and skips invalid entries", () => {
    const manifest = parseManifest({ oibVersion: "3.8", policies: [
      { oibId: A.toLowerCase(), name: " Win - OIB - SC - A - v3.8 ", policyType: "SettingsCatalog", status: "active", supersededBy: "", previousVersions: [B, { oibId: C }], skuRequirements: "Enterprise", licenseRequirements: "" },
      { oibId: "not-a-guid", name: "Broken" },
      { oibId: D, name: "Win - OIB - SC - Old - v3.0", status: "deprecated", supersededBy: A },
    ] })
    expect(manifest.version).toBe("v3.8")
    expect(manifest.entries).toHaveLength(2)
    expect(manifest.entries[0]).toMatchObject({ oibId: A, name: "Win - OIB - SC - A - v3.8", previousVersions: [B, C], supersededBy: [], skuRequirements: "Enterprise" })
    expect(manifest.entries[1]).toMatchObject({ status: "deprecated", supersededBy: [A] })
    expect(() => parseManifest({})).toThrow()
  })

  it("extracts the OIBID from a description", () => {
    expect(extractOibId(`Baseline policy.\n\nOIBID:${A.toLowerCase()}`)).toBe(A)
    expect(extractOibId("No identifier")).toBeUndefined()
    expect(extractOibId(null)).toBeUndefined()
  })

  it("joins files with manifest entries by name, then file name, and lists deprecated entries", () => {
    const manifest = parseManifest({ policies: [
      { oibId: A, name: "Win - OIB - ES - Firewall - v3.1", policyType: "EndpointSecurity", licenseRequirements: "MDE", previousVersions: [B] },
      { oibId: C, name: "Win - OIB - Compliance - Password - v3.1", policyType: "CompliancePolicies" },
      { oibId: D, name: "Win - OIB - SC - Retired - v3.0", status: "deprecated", supersededBy: [A] },
    ] })
    const { policies, deprecated } = catalogPolicies([
      { source: "WINDOWS/IntuneManagement/SettingsCatalog/Win - OIB - ES - Firewall - v3.1.json", name: "Win - OIB - ES - Firewall - v3.1", folder: "ConfigurationPolicies" },
      { source: "WINDOWS/IntuneManagement/CompliancePolicies/Win - OIB - Compliance - Password - v3.1.json", name: "Renamed in file", folder: "CompliancePolicies" },
      { source: "WINDOWS/IntuneManagement/SettingsCatalog/Win - OIB - ES - Unlisted - v3.0.json", name: "Win - OIB - ES - Unlisted - v3.0", folder: "ConfigurationPolicies" },
    ], manifest)
    expect(policies[0]).toMatchObject({ oibId: A, policyType: "EndpointSecurity", licenseRequirements: "MDE", previousVersions: [B] })
    expect(policies[1]).toMatchObject({ oibId: C, policyType: "CompliancePolicies" })
    expect(policies[2]).toMatchObject({ oibId: undefined, policyType: "EndpointSecurity" })
    expect(deprecated).toEqual([{ oibId: D, name: "Win - OIB - SC - Retired - v3.0", replacements: [{ oibId: A, name: "Win - OIB - ES - Firewall - v3.1" }] }])
  })
})

describe("matching with the tenant", () => {
  it("reads versions and base names from OIB names", () => {
    expect(policyVersion("Win - OIB - SC - Edge - v3.1.1")).toBe("3.1.1")
    expect(policyVersion("Win - OIB - SC - Edge")).toBeUndefined()
    expect(baseName("Win - OIB - SC - Edge - v3.8")).toBe(baseName("win - oib - sc - edge - V3.1"))
    expect(compareVersions("3.10", "3.9")).toBe(1)
    expect(compareVersions("3.1", "3.1.0")).toBe(0)
  })

  it("matches by OIBID first: current, previous version (outdated), ambiguous and legacy copies", () => {
    const pack = [
      policy("Win - OIB - SC - Current - v3.8", { oibId: A, previousVersions: [B] }),
      policy("Win - OIB - SC - Upgrade - v3.8", { oibId: C, previousVersions: [D] }),
      policy("Win - OIB - SC - Twice - v3.8", { oibId: "11111111-1111-1111-1111-111111111111" }),
    ]
    const { matches } = compareToTenant(pack, [], [
      tenant("1", "My renamed policy", A), tenant("2", "Win - OIB - SC - Current - v3.1", B),
      tenant("3", "Win - OIB - SC - Upgrade - v3.1", D),
      tenant("4", "x", "11111111-1111-1111-1111-111111111111"), tenant("5", "y", "11111111-1111-1111-1111-111111111111"),
    ])
    expect(matches[0]).toMatchObject({ status: "current", method: "oibid", tenant: { id: "1" }, legacy: [{ id: "2" }] })
    expect(matches[1]).toMatchObject({ status: "outdated", method: "oibid", tenant: { id: "3" }, tenantVersion: "3.1", oibVersion: "3.8" })
    expect(matches[2]).toMatchObject({ status: "duplicate", matches: [{ id: "4" }, { id: "5" }] })
  })

  it("falls back to names without version in the same folder, never claiming a policy with a known OIBID", () => {
    const pack = [
      policy("Win - OIB - SC - Edge - v3.8"),
      policy("Win - OIB - SC - Store - v3.1"),
      policy("Win - OIB - SC - Office - v3.6"),
      policy("Win - OIB - SC - Missing - v3.6"),
      policy("Win - OIB - SC - Claimed - v3.6", { oibId: A }),
    ]
    const { matches } = compareToTenant(pack, [], [
      tenant("1", "Win - OIB - SC - Edge - v3.1"),
      tenant("2", "Win - OIB - SC - Store - v3.8"),
      tenant("3", "Win - OIB - SC - Office - v3.6"), tenant("3b", "Win - OIB - SC - Office - v3.6", undefined, "CompliancePolicies"),
      tenant("4", "Win - OIB - SC - Missing - v3.0", A),
    ])
    expect(matches.map(m => m.status)).toEqual(["outdated", "newer", "current", "missing", "current"])
    expect(matches[2]).toMatchObject({ method: "name", tenant: { id: "3" } })
    expect(matches[4]).toMatchObject({ method: "oibid", tenant: { id: "4" } })
  })

  it("lists an older copy matched by name next to the current OIBID copy for review", () => {
    const { matches } = compareToTenant([policy("Win - OIB - SC - Edge - v3.8", { oibId: A })], [], [tenant("1", "Win - OIB - SC - Edge - v3.8", A), tenant("2", "Win - OIB - SC - Edge - v3.6")])
    expect(matches[0]).toMatchObject({ status: "current", method: "oibid", tenant: { id: "1" }, legacy: [{ id: "2" }] })
  })

  it("matches the copy at the pack's version among name matches and lists the others; ambiguous copies stay a duplicate", () => {
    const pack = [policy("Win - OIB - SC - Edge - v3.8")]
    // The new version created alongside the old one is current, not an ambiguous match.
    expect(compareToTenant(pack, [], [tenant("1", "Win - OIB - SC - Edge - v3.6"), tenant("2", "Win - OIB - SC - Edge - v3.8")]).matches[0])
      .toMatchObject({ status: "current", method: "name", tenant: { id: "2" }, legacy: [{ id: "1" }], tenantVersion: "3.8" })
    expect(compareToTenant(pack, [], [tenant("1", "Win - OIB - SC - Edge - v3.8"), tenant("2", "Win - OIB - SC - Edge - v3.8")]).matches[0]).toMatchObject({ status: "duplicate", matches: [{ id: "1" }, { id: "2" }] })
    expect(compareToTenant(pack, [], [tenant("1", "Win - OIB - SC - Edge - v3.6"), tenant("2", "Win - OIB - SC - Edge - v3.7")]).matches[0]).toMatchObject({ status: "duplicate", matches: [{ id: "1" }, { id: "2" }] })
  })

  it("updates the newest previous OIBID copy and prefers a copy already at the pack's version", () => {
    const pack = [policy("Win - OIB - SC - Edge - v3.8", { oibId: A, previousVersions: [B, C] })]
    expect(compareToTenant(pack, [], [tenant("1", "Win - OIB - SC - Edge - v3.1", B), tenant("2", "Win - OIB - SC - Edge - v3.6", C)]).matches[0])
      .toMatchObject({ status: "outdated", method: "oibid", tenant: { id: "2" }, legacy: [{ id: "1" }] })
    expect(compareToTenant(pack, [], [tenant("1", "Win - OIB - SC - Edge - v3.6", B), tenant("2", "Edge copy", C)]).matches[0]).toMatchObject({ status: "duplicate", method: "oibid" })
    expect(compareToTenant(pack, [], [tenant("1", "Win - OIB - SC - Edge - v3.6", B), tenant("2", "Win - OIB - SC - Edge - v3.8")]).matches[0])
      .toMatchObject({ status: "current", method: "name", tenant: { id: "2" }, legacy: [{ id: "1" }] })
  })

  it("never hides a newer tenant copy when comparing against an older release", () => {
    // OIB v3.6 does not know the v3.8 OIBID, so the v3.8 copy is found by name.
    const old = [policy("Win - OIB - SC - Edge - v3.6", { oibId: B })]
    expect(compareToTenant(old, [], [tenant("1", "Win - OIB - SC - Edge - v3.6", B), tenant("2", "Win - OIB - SC - Edge - v3.8", A)]).matches[0])
      .toMatchObject({ status: "newer", method: "name", tenant: { id: "2" }, legacy: [{ id: "1" }], tenantVersion: "3.8", oibVersion: "3.6" })
    expect(compareToTenant([policy("Win - OIB - SC - Edge - v3.6")], [], [tenant("1", "Win - OIB - SC - Edge - v3.6"), tenant("2", "Win - OIB - SC - Edge - v3.7"), tenant("3", "Win - OIB - SC - Edge - v3.8")]).matches[0])
      .toMatchObject({ status: "newer", tenant: { id: "3" }, legacy: [{ id: "1" }, { id: "2" }] })
    expect(compareToTenant([policy("Win - OIB - SC - Edge - v3.6")], [], [tenant("1", "Win - OIB - SC - Edge - v3.8"), tenant("2", "Win - OIB - SC - Edge - v3.8")]).matches[0]).toMatchObject({ status: "duplicate" })
  })

  it("reports deprecated policies still in the tenant with their replacements", () => {
    const { deprecated } = compareToTenant([], [{ oibId: D, name: "Retired", replacements: [{ oibId: A, name: "New" }, { oibId: B, name: "Other" }] }], [tenant("1", "Retired", D), tenant("2", "New", A)])
    expect(deprecated).toEqual([{ oibId: D, name: "Retired", tenant: tenant("1", "Retired", D), replacements: [{ oibId: A, name: "New", deployed: true }, { oibId: B, name: "Other", deployed: false }] }])
  })
})

describe("licensing questions", () => {
  const bp: TenantProfile = { licensing: "business-premium", defenderAv: false, autopatch: false }
  const e5: TenantProfile = { licensing: "enterprise", defenderAv: true, autopatch: true }
  it("gates Enterprise, Defender for Endpoint and Autopatch-managed policies", () => {
    expect(typeGate("DriverUpdateProfiles", bp)).toBeUndefined()
    expect(typeGate("UpdatePolicies", e5)).toMatch(/Autopatch/)
    expect(typeGate("SettingsCatalog", bp)).toBeUndefined()
    expect(policyGate(policy("A", { skuRequirements: "Enterprise" }), bp)).toMatch(/Enterprise/)
    expect(policyGate(policy("A", { licenseRequirements: "MDE" }), bp)).toMatch(/Defender/)
    expect(policyGate(policy("A", { skuRequirements: "Enterprise", licenseRequirements: "MDE" }), e5)).toBeUndefined()
  })
})

describe("tenant variables", () => {
  it("replaces %OrganizationId% in every string, any case, without changing structure", () => {
    const value = { a: "x %OrganizationId% y", b: [{ c: "%organizationid%" }], d: 1, e: null }
    expect(replaceTenantVariables(value, "t-1")).toEqual({ a: "x t-1 y", b: [{ c: "t-1" }], d: 1, e: null })
    expect(value.a).toContain("%OrganizationId%")
  })
})

const simple = (id: string, value: unknown) => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, settingInstanceTemplateReference: null, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value } } })
const choice = (id: string, value: string, children: unknown[] = []) => ({ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: id, choiceSettingValue: { value, children } } })

describe("setting comparison", () => {
  it("compares Settings Catalog settings by definition, ignoring metadata and order", () => {
    const oib = [simple("device_vendor_msft_a", 1), choice("device_vendor_msft_b", "b_1", [simple("device_vendor_msft_b_child", 5)]), simple("device_vendor_msft_c", 3)]
    const live = [choice("device_vendor_msft_b", "b_1", [{ ...simple("device_vendor_msft_b_child", 6), id: "9" }]), { ...simple("device_vendor_msft_a", 1), id: "7" }, simple("device_vendor_msft_extra", 1)]
    const result = compareSettings(oib as never, live as never)
    expect(result).toMatchObject({ totalOib: 3, totalTenant: 3, matched: 1, compliant: false })
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toMatchObject({ settingDefinitionId: "device_vendor_msft_b", oibValue: "5", tenantValue: "6" })
    expect(result.mismatches[0]!.path).toContain("child")
    expect(result.oibOnly.map(d => d.settingDefinitionId)).toEqual(["device_vendor_msft_c"])
    expect(result.tenantOnly.map(d => d.settingDefinitionId)).toEqual(["device_vendor_msft_extra"])
    expect(compareSettings(oib as never, oib as never).compliant).toBe(true)
  })

  it("compares flat policies key by key and ignores names, metadata and nulls", () => {
    const oib = { "@odata.type": "#microsoft.graph.windows10CompliancePolicy", displayName: "OIB", id: "a", passwordRequired: true, passwordMinimumLength: 12, osMinimumVersion: null, scheduledActionsForRule: [{ ruleName: "x" }] }
    const live = { "@odata.type": "#microsoft.graph.windows10CompliancePolicy", displayName: "Renamed", id: "b", passwordRequired: true, passwordMinimumLength: 8, bitLockerEnabled: true, version: 4 }
    const result = compareFlat(oib, live)
    expect(result).toMatchObject({ matched: 1, compliant: false, mismatches: [{ settingDefinitionId: "passwordMinimumLength", oibValue: "12", tenantValue: "8" }], tenantOnly: [{ settingDefinitionId: "bitLockerEnabled" }], oibOnly: [] })
  })

  it("compares administrative templates by definition, from an export bind or a live definition", () => {
    const def = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    const pres = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    const oib = { definitionValues: [{ enabled: true, "definition@odata.bind": `https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions('${def}')`, presentationValues: [{ value: "1", "presentation@odata.bind": `https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions('${def}')/presentations('${pres}')` }] }] }
    const live = { definitionValues: [{ id: "v1", enabled: true, definition: { id: def, displayName: "Setting" }, presentationValues: [{ id: "p1", value: "1", presentation: { id: pres } }] }] }
    expect(compareAdminTemplate(oib, live).compliant).toBe(true)
    live.definitionValues[0]!.enabled = false
    expect(compareAdminTemplate(oib, live).mismatches).toHaveLength(1)
  })

  it("validates only supported folders", () => {
    expect(validatePolicy("AppProtectionIOS", {}, {})).toBeUndefined()
    expect(validatePolicy("DriverUpdateProfiles", { approvalType: "manual" }, { approvalType: "manual" })?.compliant).toBe(true)
  })
})

describe("reports", () => {
  const ATTRIBUTION = "OpenIntuneBaseline content: SkipToTheEndpoint and contributors, GPL-3.0."
  const BRANDING = { companyName: "Fabrikam Security Services", colors: { primary: "#0B3D5C", accent: "#2BB3A3" }, preparedBy: "Avery Fabrikam", classification: "Confidential", footerText: "Fabrikam | Intune review", logo: { dataUrl: pngLogo() } }
  const pdf = (report = oibComparisonReport(), branding?: typeof BRANDING) => generateOibReportPDF(parseReportPayload(report), { exportedAt: EXPORTED_AT, branding })

  it("accepts a well formed report and returns only the known fields", () => {
    const report = parseReportPayload({ ...oibValidationReport(), tenantId: TENANT_ID.toUpperCase() })
    expect(report.tenantId).toBe(TENANT_ID)
    expect(report.sections[0]!.columns).toEqual(["Platform", "OIB policy", "Tenant policy", "Status", "Settings matched"])
    expect(parseReportPayload({ tenantId: TENANT_ID, title: "T", meta: [], sections: [] })).toEqual({ tenantId: TENANT_ID, title: "T", meta: [], sections: [] })
    // Policy Validation lists the reference of every platform in the subtitle.
    const references = Array.from({ length: 6 }, (_, index) => `OpenIntuneBaseline Platform${index} v4.0 \u00b7 platform${index}-v4.0 @ 1cc71a9`).join("; ")
    expect(parseReportPayload({ ...oibValidationReport(), subtitle: references }).subtitle).toBe(references)
  })

  it("rejects reports of the wrong shape, type or size", () => {
    const base = oibComparisonReport()
    const section = base.sections[0]!
    const rows = (count: number) => Array.from({ length: count }, () => ["a"])
    for (const bad of [
      null, "<!doctype html><p>x</p>", [], { ...base, html: "<p>" }, { ...base, tenantId: "contoso" }, { ...base, tenantId: undefined },
      { ...base, title: 7 }, { ...base, title: "  " }, { ...base, title: "x".repeat(REPORT_LIMITS.label + 1) }, { ...base, meta: [["Tenant"]] }, { ...base, meta: [["Tenant", 1]] },
      { ...base, summary: [["Up to date", "x".repeat(41)]] }, { ...base, sections: {} }, { ...base, sections: [{ ...section, script: "x" }] },
      { ...base, sections: [{ ...section, columns: [] }] }, { ...base, sections: [{ ...section, rows: [["only one cell"]] }] }, { ...base, sections: [{ ...section, rows: [[1, 2, 3, 4, 5, 6]] }] },
      { ...base, sections: [{ heading: "H", columns: ["C"], rows: [["x".repeat(REPORT_LIMITS.cell + 1)]] }] },
      { ...base, sections: [{ heading: "H", columns: ["C"], rows: rows(REPORT_LIMITS.rows + 1) }] },
      { ...base, sections: Array.from({ length: 11 }, () => ({ heading: "H", columns: ["C"], rows: [["x".repeat(REPORT_LIMITS.cell)]] })).concat(Array.from({ length: 500 }, () => ({ heading: "H", columns: ["C"], rows: [["x".repeat(REPORT_LIMITS.cell)]] }))) },
    ]) expect(() => parseReportPayload(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow(/The report could not be prepared/)
  })

  it("maps the known status words to tones and leaves other text alone", () => {
    expect(["Matches the baseline", "Up to date", " Drift detected ", "Value mismatch", "Missing in tenant", "Validation error", "Ambiguous match", "Not validated", "Newer than OIB"].map(statusTone))
      .toEqual(["good", "good", "different", "different", "missing", "conflict", "conflict", "neutral", "neutral"])
    expect(statusTone("Error <x>")).toBeUndefined()
    expect(statusTone("constructor")).toBeUndefined()
  })

  it("prints the cover, contents, summary, every section and the attribution with page numbers and bookmarks", () => {
    const bytes = pdf()
    const text = pdfText(bytes)
    for (const expected of ["OpenIntuneBaseline deployment comparison", "Contoso Ltd", TENANT_ID, "AT A GLANCE", "DOCUMENT CONTROL", "Contents", "Summary", "Status distribution", "Report details",
      "Update available", "New policy", "Ambiguous match", "Newer than OIB", "Up to date", "Other copies still deployed", "Older versions or extra copies next to the matched policy.",
      "Deprecated policies in the tenant", "Nothing to report.", "Provenance and attribution", ATTRIBUTION, "2026-10-14 09:30 UTC", "TenuVault | OpenIntuneBaseline comparison"]) expect(text).toContain(expected)
    const pages = pageStreams(bytes)
    pages.slice(1).forEach((stream, index) => expect(shown(stream)).toContain(`Page ${index + 2} of ${pages.length}`))
    expect(outlineTitles(bytes)).toEqual(expect.arrayContaining(["Contents", "Summary", "Results", "Update available", "Deprecated policies in the tenant", "Provenance and attribution"]))
    expectInsideGrid(bytes)
    expect(Buffer.from(pdf()).equals(Buffer.from(bytes))).toBe(true)
  })

  it("draws status words as pills in table cells", () => {
    const text = pdfText(pdf(oibValidationReport()))
    for (const pill of ["Matches the baseline", "Drift detected", "Not validated", "Validation error", "Value mismatch", "Missing in tenant", "Only in tenant"]) expect(text).toContain(pill)
    // A pill is a filled rounded rectangle in the tone of its status.
    expect(pageStreams(pdf(oibValidationReport())).join("\n")).toContain("0.91 0.95 0.93 rg")
  })

  it("redacts secrets, normalises typographic characters and keeps long values inside the grid", () => {
    const validation = pdfText(pdf(oibValidationReport()))
    expect(validation).not.toContain("eyJhbGciOiJIUzI1NiJ9")
    expect(validation).toContain("Graph returned 403 Forbidden")
    const extreme = pdf(oibComparisonReport({ extreme: true }))
    expect(pdfText(extreme)).toContain("Ltd 's Region")
    expect(pdfText(extreme)).toContain("Update available (continued)")
    expectInsideGrid(extreme)
    expectInsideGrid(pdf(oibValidationReport({ extreme: true })))
  })

  it("renders a white label report with the customer branding and the verbatim attribution only", () => {
    const bytes = pdf(oibComparisonReport(), BRANDING)
    const text = pdfText(bytes)
    // The logo stands for the company on the cover; the footer carries the customer's footer text.
    for (const expected of ["Avery Fabrikam", "Confidential", "Fabrikam | Intune review", ATTRIBUTION]) expect(text).toContain(expected)
    expect(text).not.toContain("TenuVault")
    expect(Buffer.from(bytes).toString("latin1")).toMatch(/\/Subtype \/Image/)
    expect(Buffer.from(bytes).toString("latin1")).toContain("/Author (Fabrikam Security Services)")
  })

  it("prints tenant data that names TenuVault as recorded and drops the Generated by row on a white label report", () => {
    const comparison = oibComparisonReport()
    comparison.sections[0]!.rows[0]![3] = "TenuVault Baseline"
    const validation = oibValidationReport()
    validation.sections[1]!.rows[0]![3] = "TenuVault Baseline"
    for (const report of [comparison, validation]) {
      const branded = pdfText(pdf(report, BRANDING))
      expect(branded).toContain("TenuVault Baseline")
      expect(branded).not.toContain("Fabrikam Security Services Baseline")
      expect(branded.replaceAll("TenuVault Baseline", "")).not.toMatch(/tenuvault/i)
      expect(branded).not.toContain("Generated by")
      const plain = pdfText(pdf(report))
      expect(plain).toContain("TenuVault Baseline")
      expect(plain).toMatch(/Generated by TenuVault/i)
    }
  })

  it("prints every date of the report in the same UTC format", () => {
    for (const [report, date] of [[oibComparisonReport(), "2026-10-14 08:45 UTC"], [oibValidationReport(), "2026-10-14 09:02 UTC"]] as const) {
      const text = pdfText(pdf(report))
      expect(text).toContain(date)
      expect(text).toContain("2026-10-14 09:30 UTC")
      expect(text).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}:\d{2}:\d{2}/)
    }
  })

  it("derives the file id from the report identity, not from its rows", () => {
    const report = oibValidationReport()
    const changed = structuredClone(report)
    changed.sections[1]!.rows[0]![3] = "client_secret=abcdefghijklmnopqrstuvwx"
    expect(fileId(pdf(changed))).toBe(fileId(pdf(report)))
    expect(fileId(pdf({ ...report, title: "Another title" }))).not.toBe(fileId(pdf(report)))
  })

  it("quotes CSV cells and neutralises spreadsheet formulas", () => {
    expect(toCsv([["a", 'say "hi"', "=cmd()", "-1", "@x"]])).toBe(`"a","say ""hi""","'=cmd()","'-1","'@x"`)
  })
})
