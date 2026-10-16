import { describe, expect, it } from "vitest"
import { compareAdminTemplate, compareFlat, compareSettings, validatePolicy } from "../src/shared/oib/compare"
import { policyGate, typeGate, type TenantProfile } from "../src/shared/oib/licensing"
import { catalogPolicies, extractOibId, parseManifest } from "../src/shared/oib/manifest"
import { baseName, compareToTenant, compareVersions, policyVersion } from "../src/shared/oib/match"
import { escapeHtml, REPORT_PRINT_OPTIONS, reportHtml, toCsv } from "../src/shared/oib/report"
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
  it("escapes every value and loads nothing external", () => {
    const html = reportHtml({ title: "<script>alert(1)</script>", meta: [["Tenant", "A & B"]], sections: [{ heading: "H", columns: ["C"], rows: [["<img src=x onerror=1>"]] }] })
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).toContain("default-src 'none'")
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;")
  })

  it("prints a header band with the mark, escaped title, subtitle and facts", () => {
    const html = reportHtml({ title: "Comparison <b>", subtitle: "v3.8 & up", eyebrow: "<i>OIB</i>", meta: [["Tenant", "<Contoso>"], ["Compared", "today"]], summary: [["Up to date", "3"], ["<k>", "<v>"]], sections: [] })
    const band = html.slice(html.indexOf(`<header class="band">`), html.indexOf("</header>"))
    expect(band).toContain(`class="brand-mark"`)
    expect(band).toContain("TenuVault")
    expect(band).toContain("&lt;i&gt;OIB&lt;/i&gt;")
    expect(band).toContain("<h1>Comparison &lt;b&gt;</h1>")
    expect(band).toContain("v3.8 &amp; up")
    expect(band).toContain("<dd>&lt;Contoso&gt;</dd>")
    expect(html).toContain("&lt;k&gt;")
    expect(html).not.toMatch(/<[kvb]>/)
    expect(html).toContain("@page :first { margin-top: 0; }")
  })

  it("renders known status words as pills with a marker and leaves other values as text", () => {
    const html = reportHtml({ title: "T", meta: [], sections: [{ heading: "Ambiguous match", columns: ["Status", "Name"], rows: [["Matches the baseline", "Drift detected"], ["Missing in tenant", "Error <x>"], ["Not validated", "Validation error"]] }] })
    expect(html).toContain(`<span class="pill good"><svg class="mark"`)
    expect(html).toMatch(/<span class="pill good"><svg[^>]*>.*?<\/svg>Matches the baseline<\/span>/)
    expect(html).toContain(`<span class="pill partial">`)
    expect(html).toContain(`<span class="pill missing">`)
    expect(html).toContain(`<span class="pill neutral">`)
    expect(html).toContain(`<span class="pill alert">`)
    expect(html).toContain("<td>Error &lt;x&gt;</td>")
    expect(html).toMatch(/<h2><span class="alert"><svg/)
    expect(html).toContain("<thead>")
    expect(html).toContain("thead { display: table-header-group; }")
  })

  it("prints a running footer with the document title and page numbers", () => {
    expect(REPORT_PRINT_OPTIONS.displayHeaderFooter).toBe(true)
    expect(REPORT_PRINT_OPTIONS.footerTemplate).toContain(`<span class="title"></span>`)
    expect(REPORT_PRINT_OPTIONS.footerTemplate).toContain(`<span class="pageNumber"></span> of <span class="totalPages"></span>`)
    expect(REPORT_PRINT_OPTIONS.footerTemplate).toMatch(/font-size:\d+px/)
    expect(REPORT_PRINT_OPTIONS.margins.bottom).toBeGreaterThan(0.4)
  })

  it("quotes CSV cells and neutralises spreadsheet formulas", () => {
    expect(toCsv([["a", 'say "hi"', "=cmd()", "-1", "@x"]])).toBe(`"a","say ""hi""","'=cmd()","'-1","'@x"`)
  })
})
