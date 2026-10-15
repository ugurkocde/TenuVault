import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { frameworks } from "../src/shared/frameworks/catalog"
import { effectiveFrameworks, internalKitImportEnabled } from "../src/shared/frameworks/cis-internal"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"
import { parseDenominatorList } from "../src/shared/frameworks/cis-coverage"
import { cisReadiness, MANUAL_NOT_ASSESSED_NOTE } from "../src/shared/frameworks/cis-readiness"
import { cisReadinessCsv, cisReadinessJson, governanceExportName } from "../src/renderer/features/shared/governance-export"
import { handleFramework, setInternalCisBenchmarksEnabled, setInternalCisBenchmarksProvider, assessPolicySet } from "../src/main/frameworks/service"
import { loadWorkspace, saveWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { parsePolicies } from "../src/shared/frameworks/policies"

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

beforeEach(() => { setInternalCisBenchmarksEnabled(null); setInternalCisBenchmarksProvider(null) })
afterEach(() => { setInternalCisBenchmarksEnabled(null); setInternalCisBenchmarksProvider(null); vi.unstubAllGlobals() })

describe("internal CIS Benchmarks flag", () => {
  it("is off by default, ignores the legacy environment variable, and follows the server-issued provider", async () => {
    expect(internalKitImportEnabled(false)).toBe(false)
    expect(internalKitImportEnabled(true)).toBe(true)
    process.env.TENUVAULT_INTERNAL_CIS_BENCHMARKS = "1"
    try {
      await expect(handleFramework({ action: "workspace-load", frameworkId: "cis-benchmarks", tenantId }))
        .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
      setInternalCisBenchmarksProvider(() => true)
      const data = new Map<string, string>()
      setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
      await expect(handleFramework({ action: "workspace-load", frameworkId: "cis-benchmarks", tenantId }))
        .resolves.toMatchObject({ frameworkId: "cis-benchmarks" })
      setInternalCisBenchmarksProvider(() => { throw new Error("license unavailable") })
      await expect(handleFramework({ action: "workspace-load", frameworkId: "cis-benchmarks", tenantId }))
        .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    } finally {
      delete process.env.TENUVAULT_INTERNAL_CIS_BENCHMARKS
      setInternalCisBenchmarksProvider(null)
    }
  })

  it("keeps the catalog disabled with the existing reason when off, and enables only CIS Benchmarks when on", () => {
    const off = effectiveFrameworks(false).find(f => f.id === "cis-benchmarks")!
    expect(off.disabledReason).toBe("CIS comparisons are coming soon.")
    expect(off.disabledReason).toBe(frameworks.find(f => f.id === "cis-benchmarks")!.disabledReason)
    const on = effectiveFrameworks(true)
    expect(on.find(f => f.id === "cis-benchmarks")!.disabledReason).toBeUndefined()
    expect(on.find(f => f.id === "cis-controls")!.disabledReason).toBe("CIS comparisons are coming soon.")
  })

  it("refuses CIS Benchmarks actions when off, before any network call", async () => {
    setInternalCisBenchmarksEnabled(false)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    for (const action of ["workspace-load", "workspace-save", "assess"]) {
      await expect(handleFramework({ action, frameworkId: "cis-benchmarks", tenantId, appId, reference: "r1", policies: [] }))
        .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    }
    await expect(handleFramework({ action: "workspace-load", frameworkId: "cis-controls", tenantId }))
      .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("assesses a synthetic pack when on and refuses policy creation from it", async () => {
    setInternalCisBenchmarksEnabled(true)
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("oauth2") ? Response.json({ access_token: "test" }) : Response.json({ value: [] })))
    const converted = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })
    const pack = converted.packs.find(item => item.level === 1)!
    const result = await handleFramework({ action: "assess", frameworkId: "cis-benchmarks", tenantId, appId, reference: pack.reference, policies: JSON.parse(JSON.stringify(pack.policies)) }) as { runId: string; findings: unknown[] }
    expect(result.findings).toHaveLength(2)
    await expect(handleFramework({ action: "create", tenantId, appId, runId: result.runId, keys: ["0:0"], confirmUnassigned: true }))
      .rejects.toMatchObject({ status: 403 })
  })

  it("allows a CIS Benchmarks workspace load when on, and still refuses CIS Controls", async () => {
    setInternalCisBenchmarksEnabled(true)
    const data = new Map<string, string>()
    setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
    await expect(handleFramework({ action: "workspace-load", tenantId, frameworkId: "cis-benchmarks" })).resolves.toMatchObject({ frameworkId: "cis-benchmarks" })
    await expect(handleFramework({ action: "workspace-load", tenantId, frameworkId: "cis-controls" }))
      .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
  })
})

describe("kit conversion to pack storage", () => {
  it("preserves provenance through the existing workspace storage and assessPolicySet works on the stored pack", () => {
    const converted = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })
    const pack = converted.packs.find(item => item.level === 1)!
    expect(pack.policies[0]?.provenance).toMatchObject({ benchmark: "fakebook-os", version: "9.9.9", level: "Level 1" })
    const data = new Map<string, string>()
    setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    workspace.policies = pack.policies
    workspace.reference = pack.reference
    saveWorkspace(workspace)
    const stored = loadWorkspace(tenantId, "cis-benchmarks")
    expect(stored.policies).toEqual(parsePolicies(pack.policies))
    expect(stored.policies[0]?.provenance).toMatchObject({ benchmark: "fakebook-os", version: "9.9.9", level: "Level 1", sourceFile: "Fakebook Alpha 9.9.9.json" })
    expect(stored.reference).toBe("fakebook-os 9.9.9 Level 1")
    const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: stored.reference, policies: stored.policies, current: [], runId: "run-1", assessedAt: "2026-10-13T00:00:00.000Z" })
    expect(assessment.findings).toHaveLength(2)
    expect(assessment.findings.every(finding => finding.status === "Missing")).toBe(true)
  })
})

describe("CIS readiness", () => {
  const denominator = () => parseDenominatorList(JSON.stringify([
    { identifier: "7.1.1", level: 1, automated: true },
    { identifier: "7.1.2", level: 1, automated: true },
    { identifier: "7.1.3", level: 1, automated: true },
    { identifier: "7.1.4", level: 1, automated: false },
    { identifier: "7.2.1", level: 2, automated: true },
    { identifier: "7.2.2", level: 2, automated: true },
  ]))

  function assessed() {
    const converted = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })
    const policies = converted.packs.flatMap(pack => pack.policies)
    const current = parsePolicies(JSON.parse(policy("Tenant Alpha", "tenant", "fakebook_setting_alpha"))).map((item, index) => ({ ...item, id: `33333333-3333-3333-3333-33333333333${index}` }))
    const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9", policies, current, runId: "run-1", assessedAt: "2026-10-13T00:00:00.000Z" })
    return { policies, assessment }
  }

  it("computes pass rate, assessed automated count, coverage and the not assessed list with a denominator", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies, denominator())
    expect(summary.benchmark).toBe("fakebook-os")
    expect(summary.version).toBe("9.9.9")
    expect(summary.manualNote).toBe(MANUAL_NOT_ASSESSED_NOTE)
    const level1 = summary.levels.find(level => level.level === 1)!
    expect(level1.assessedSettings).toBe(2)
    expect(level1.present).toBe(1)
    expect(level1.passRate).toBe(0.5)
    expect(level1.enumerated).toBe(2)
    expect(level1.assessedAutomated).toBe(2)
    expect(level1.denominator).toBe(3)
    expect(level1.coverage).toBeCloseTo(2 / 3)
    expect(level1.notAssessed).toEqual(["7.1.3"])
    const level2 = summary.levels.find(level => level.level === 2)!
    expect(level2.assessedAutomated).toBe(1)
    expect(level2.coverage).toBe(0.5)
    expect(level2.notAssessed).toEqual(["7.2.2"])
  })

  it("reports no coverage and no not assessed list without a denominator", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies)
    const level1 = summary.levels.find(level => level.level === 1)!
    expect(level1.coverage).toBeNull()
    expect(level1.denominator).toBeNull()
    expect(level1.notAssessed).toEqual([])
    expect(level1.assessedAutomated).toBe(2)
    expect(level1.passRate).toBe(0.5)
  })

  it("exports benchmark, version, Level and counts as CSV and JSON through the governance export", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies, denominator())
    expect(governanceExportName("cis-readiness", "Contoso", "2026-10-13T10:00:00Z")).toBe("cis-readiness-contoso-2026-10-13")
    const csv = cisReadinessCsv(summary)
    expect(csv.split("\r\n")[0]).toContain("Benchmark,Version,Level")
    expect(csv.split("\r\n")[0]).toContain("Excepted")
    expect(csv.split("\r\n")[0]).toContain("Adjusted pass rate")
    expect(csv.split("\r\n")[0]).toContain("Exceptions")
    expect(csv).toContain("fakebook-os,9.9.9,1,2,1,0,1,0,0.5,2,2,3,0.6666666666666666,7.1.3")
    expect(csv).toContain(MANUAL_NOT_ASSESSED_NOTE)
    const json = JSON.parse(cisReadinessJson(summary, "Contoso", "2026-10-13T10:00:00Z")) as { benchmark: string; version: string; levels: Array<{ level: number; notAssessed: string[]; excepted: number; adjustedPassRate: number | null; exceptions: unknown[] }> }
    expect(json.benchmark).toBe("fakebook-os")
    expect(json.version).toBe("9.9.9")
    expect(json.levels[0]).toMatchObject({ level: 1, notAssessed: ["7.1.3"], excepted: 0, adjustedPassRate: 0.5, exceptions: [] })
  })
})
