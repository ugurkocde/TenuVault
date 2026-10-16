import { inflateSync } from "node:zlib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"
import { parseDenominatorList } from "../src/shared/frameworks/cis-coverage"
import { cisReadiness, coverageSourceLabel, MANUAL_NOT_ASSESSED_NOTE } from "../src/shared/frameworks/cis-readiness"
import { MANUAL_RECOMMENDATIONS_FALLBACK } from "../src/shared/frameworks/cis-manual"
import { generateCisReadinessPDF } from "../src/shared/compliance/report-pdf"
import { handleFramework, setInternalCisBenchmarksEnabled, assessPolicySet, type ExportFile } from "../src/main/frameworks/service"
import { handleNativeFramework, setNativeFrameworkAuthorization, setNativeFrameworkStore } from "../src/main/frameworks/native"
import { recordAssessment, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { requiredFeatures } from "../src/main/api/plan-gates"
import { parsePolicies } from "../src/shared/frameworks/policies"
import { attachRecommendations } from "../src/shared/frameworks/cis-recommendations"

const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (name: string, description: string, settingId = "fakebook_setting_alpha") => JSON.stringify({
  name, platforms: "windows10", technologies: "mdm", description,
  settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: settingId, choiceSettingValue: { value: "fake-on" } } }],
})
const tenantId = "11111111-1111-1111-1111-111111111111"
const appId = "22222222-2222-2222-2222-222222222222"

const kitFiles: KitFile[] = [
  { path: "Level 1/Fakebook Alpha 9.9.9.json", content: policy("Fakebook Alpha", "Covers 7.1.1 and 7.1.2") },
  { path: "Level 1/Fakebook Beta 9.9.9.json", content: policy("Fakebook Beta", "Covers 7.1.2", "fakebook_setting_beta") },
  { path: "Level 2/Fakebook Gamma 9.9.9.json", content: policy("Fakebook Gamma", "Covers 7.2.1", "fakebook_setting_gamma") },
]

function memory() {
  const values = new Map<string, string>()
  return { values, store: { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v) }, delete: (k: string) => { values.delete(k) } } }
}

function pdfRaw(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1")
  const parts: string[] = []
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { parts.push(inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1")) } catch { parts.push(match[1]!) }
  }
  return parts.join("\n")
}

function pdfText(bytes: Uint8Array): string {
  const shown = pdfRaw(bytes).match(/\((?:\\.|[^\\()])*\)\s*Tj/g) ?? []
  return shown.map(chunk => chunk.replace(/\)\s*Tj$/, "").slice(1).replace(/\\([()\\])/g, "$1")).join(" ").replace(/\s+/g, " ")
}

function pageCount(bytes: Uint8Array): number {
  return (Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length
}

function assessed() {
  const converted = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })
  const policies = converted.packs.flatMap(pack => pack.policies)
  const current = parsePolicies(JSON.parse(policy("Tenant Alpha", "tenant", "fakebook_setting_alpha"))).map((item, index) => ({ ...item, id: `33333333-3333-3333-3333-33333333333${index}` }))
  const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9", policies, current, runId: "run-1", assessedAt: "2026-10-13T00:00:00.000Z" })
  return { policies, assessment }
}

const denominator = () => parseDenominatorList(JSON.stringify([
  { identifier: "7.1.1", level: 1, automated: true },
  { identifier: "7.1.2", level: 1, automated: true },
  { identifier: "7.1.3", level: 1, automated: true },
  { identifier: "7.1.4", level: 1, automated: false },
  { identifier: "7.2.1", level: 2, automated: true },
  { identifier: "7.2.2", level: 2, automated: true },
]))

const context = { exportedAt: "2026-10-13T10:00:00.000Z", tenantName: "Contoso", tenantId, assessedAt: "2026-10-13T00:00:00.000Z", runId: "run-1" }

beforeEach(() => { setInternalCisBenchmarksEnabled(null) })
afterEach(() => { setInternalCisBenchmarksEnabled(null); vi.unstubAllGlobals() })

describe("CIS readiness PDF report", () => {
  it("produces a PDF with per Level sections, counts and the authoritative coverage label", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies, denominator())
    const pdf = generateCisReadinessPDF(summary, context)
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-")
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(3)
    const text = pdfText(pdf)
    for (const expected of [
      "TenuVault", "CIS readiness report", "fakebook-os", "Contoso",
      "Level 1 readiness", "Level 2 readiness",
      "Assessed settings 2", "Conforming 1", "Pass rate 50%",
      "source: Authoritative denominator",
      "Not assessed identifiers 1", "7.1.3",
      "Manual recommendations, Level 1", "7.1.4",
      MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_NOT_ASSESSED_NOTE,
      "TenuVault | CIS readiness report",
    ]) expect(text).toContain(expected)
  })

  it("lists recommendation results per Level when the pack names its recommendations", () => {
    const { policies, assessment } = assessed()
    const identified = attachRecommendations(policies, [{ id: "7.1.2", title: "Synthetic beta recommendation", level: 1, settings: ["fakebook_setting_beta"] }])
      .map(policy => ({ ...policy, provenance: { ...policy.provenance, benchmarkName: "Fakebook Display Name" } }))
    const text = pdfText(generateCisReadinessPDF(cisReadiness(assessment, identified), context))
    expect(text).toContain("Fakebook Display Name")
    expect(text).toContain("fakebook-os | Version 9.9.9")
    expect(text).toContain("Recommendation pass rate 0%")
    expect(text).toContain("Recommendation results, Level 1")
    // Recommendation, its settings and the result pill are table cells of one row.
    expect(text).toContain("7.1.2 Synthetic beta recommendation fakebook_setting_beta Missing Fail")
    expect(text).toContain("Passed 0")
    expect(pdfText(generateCisReadinessPDF(cisReadiness(assessment, policies), context))).not.toContain("Recommendation results")
  })

  it("shows the recommendation pass rate as Not available when no recommendation of a Level could be assessed", () => {
    const { policies, assessment } = assessed()
    const unassessed = attachRecommendations(policies, [{ id: "7.9.1", title: "Synthetic partly in pack", level: 1, settings: ["fakebook_setting_alpha", "fakebook_setting_unmapped"] }])
    const text = pdfText(generateCisReadinessPDF(cisReadiness(assessment, unassessed), context))
    expect(text).toContain("RECOMMENDATION PASS RATE Not available")
    expect(text).toContain("Recommendation pass rate Not available")
  })

  it("labels coverage as not computable without a denominator and names the breakout proxy as illustrative", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies)
    expect(summary.levels[0]!.coverageSource).toBe("none")
    expect(coverageSourceLabel("authoritative")).toBe("Authoritative denominator")
    expect(coverageSourceLabel("breakout-proxy")).toBe("Breakout proxy, illustrative")
    expect(coverageSourceLabel("none")).toBe("Not computable")
    const without = pdfText(generateCisReadinessPDF(summary, context))
    expect(without).toContain("Coverage: Not computable")
    // Without a manual recommendation list the CIS notice and its link still appear.
    expect(summary.levels.every(level => !level.manual.length)).toBe(true)
    expect(without).toContain(MANUAL_RECOMMENDATIONS_FALLBACK)
    expect(without).toContain("https://www.cisecurity.org/cis-benchmarks")
    expect(without).not.toContain("Authoritative denominator")
    const proxy = { ...summary, levels: summary.levels.map(level => ({ ...level, coverage: 0.5, denominator: 4, coverageSource: "breakout-proxy" as const })) }
    expect(pdfText(generateCisReadinessPDF(proxy, context))).toContain("Breakout proxy, illustrative")
  })

  it("shares the native framework report design: panel fill, tiles and footer", async () => {
    const m = memory()
    setNativeFrameworkStore(m.store)
    setNativeFrameworkAuthorization(async () => {})
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => String(input).includes("login.microsoftonline.com") ? Response.json({ access_token: "mock-token" }) : Response.json({ value: [] })))
    const body = { tenantId, appId, frameworkId: "iso-27001", tenantName: "Contoso" }
    const run = (await (await handleNativeFramework({ ...body, action: "native-assess" })).json()).run as { runId: string }
    const nativePdf = new Uint8Array(await (await handleNativeFramework({ ...body, action: "native-pdf", runId: run.runId })).arrayBuffer())
    const { policies, assessment } = assessed()
    const cisPdf = generateCisReadinessPDF(cisReadiness(assessment, policies, denominator()), context)
    const nativeText = pdfText(nativePdf)
    const cisText = pdfText(cisPdf)
    for (const shared of ["TenuVault", "TenuVault |"]) {
      expect(nativeText).toContain(shared)
      expect(cisText).toContain(shared)
    }
    expect(nativeText).toContain("Independent configuration comparison")
    expect(cisText).toContain("CIS readiness report")
    const tileFill = (bytes: Uint8Array) => /0\.96 0\.95 0\.95 rg/.test(pdfRaw(bytes))
    expect(tileFill(nativePdf)).toBe(true)
    expect(tileFill(cisPdf)).toBe(true)
    for (const label of ["Assessed settings", "Conforming", "Deviating", "Pass rate"]) expect(cisText).toContain(label)
  })
})

describe("CIS readiness PDF export through the main process", () => {
  it("is plan gated like the other CIS exports", () => {
    expect(requiredFeatures("/api/frameworks", { action: "workspace-cis-pdf", frameworkId: "cis-benchmarks" })).toEqual(["baselineAllPlatforms"])
    expect(requiredFeatures("/api/frameworks", { action: "workspace-cis-pdf", frameworkId: "custom" })).toEqual([])
  })

  it("refuses the export when the internal flag is off, before any network call", async () => {
    setInternalCisBenchmarksEnabled(false)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(handleFramework({ action: "workspace-cis-pdf", frameworkId: "cis-benchmarks", tenantId, runId: "run-1" }))
      .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("exports the saved CIS assessment as a PDF when the flag is on, without reading the tenant", async () => {
    setInternalCisBenchmarksEnabled(true)
    setFrameworkStore(memory().store)
    setNativeFrameworkAuthorization(async () => "pro")
    const { policies, assessment } = assessed()
    recordAssessment(assessment, policies)
    const fetch = vi.fn(async () => { throw new Error("No network during export") })
    vi.stubGlobal("fetch", fetch)
    const result = await handleFramework({ action: "workspace-cis-pdf", frameworkId: "cis-benchmarks", tenantId, tenantName: "Contoso", runId: "run-1", denominator: JSON.parse(JSON.stringify(denominator())) }) as { file: ExportFile }
    expect(result.file).toMatchObject({ name: "framework-cis-benchmarks-run-1.pdf", type: "application/pdf", encoding: "base64" })
    const bytes = Buffer.from(result.file.data, "base64")
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-")
    const text = pdfText(bytes)
    expect(text).toContain("Level 1 readiness")
    expect(text).toContain("Authoritative denominator")
    expect(fetch).not.toHaveBeenCalled()
    await expect(handleFramework({ action: "workspace-cis-pdf", frameworkId: "cis-benchmarks", tenantId, runId: "missing" }))
      .rejects.toMatchObject({ status: 404 })
  })
})
