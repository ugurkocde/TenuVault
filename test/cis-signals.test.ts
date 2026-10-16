import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cisSignals } from "../src/main/frameworks/cis-signals"
import { setInternalCisBenchmarksEnabled, setInternalCisBenchmarksProvider } from "../src/main/frameworks/service"
import { loadWorkspace, saveWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"
import type { Assessment, BaselinePolicy, Finding } from "../src/shared/frameworks/policies"

const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (name: string, description: string, settingId = "fakebook_setting_alpha") => JSON.stringify({
  name, platforms: "windows10", technologies: "mdm", description,
  settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: settingId, choiceSettingValue: { value: "fake-on" } } }],
})
const kitFiles: KitFile[] = [
  { path: "Level 1/Fakebook Alpha 9.9.9.json", content: policy("Fakebook Alpha", "Covers 7.1.1 and 7.1.2") },
  { path: "Level 1/Fakebook Beta 9.9.9.json", content: policy("Fakebook Beta", "Covers 7.1.2", "fakebook_setting_beta") },
  { path: "Level 2/Fakebook Gamma 9.9.9.json", content: policy("Fakebook Gamma", "Covers 7.2.1", "fakebook_setting_gamma") },
]
const tenantId = "11111111-1111-1111-1111-111111111111"

function policies(): BaselinePolicy[] {
  return convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" }).packs.flatMap(pack => pack.policies)
}

function historyEntry(runId: string, assessedAt: string, statuses: Finding["status"][]) {
  const pack = policies()
  const findings: Finding[] = statuses.map((status, index) => ({
    key: `${index}:0`,
    policyIndex: index,
    settingIndex: 0,
    policyName: pack[index]!.name,
    settingId: String((pack[index]!.settings[0]!.settingInstance as { settingDefinitionId: string }).settingDefinitionId),
    status,
    recommended: null,
    observed: [],
  }))
  const assessment: Assessment = { runId, tenantId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9", assessedAt, policyCount: pack.length, findings }
  return { assessment, policies: pack }
}

function seed(history: ReturnType<typeof historyEntry>[]) {
  const workspace = loadWorkspace(tenantId, "cis-benchmarks")
  workspace.policies = policies()
  workspace.reference = "fakebook-os 9.9.9"
  workspace.history = history
  saveWorkspace(workspace)
}

let data: Map<string, string>

beforeEach(() => {
  data = new Map<string, string>()
  setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
  setInternalCisBenchmarksEnabled(true)
})
afterEach(() => { setInternalCisBenchmarksEnabled(null); setInternalCisBenchmarksProvider(null) })

describe("cisSignals", () => {
  it("returns no signals when the internal flag is off", () => {
    seed([historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"]), historyEntry("run-2", "2026-02-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])])
    setInternalCisBenchmarksEnabled(false)
    expect(cisSignals(tenantId)).toEqual([])
  })

  it("returns no signals when there is no history or a single point", () => {
    seed([])
    expect(cisSignals(tenantId)).toEqual([])
    seed([historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])])
    expect(cisSignals(tenantId)).toEqual([])
  })

  it("throws when the workspace cannot be read", () => {
    setFrameworkStore({ get: () => "{not json", set: () => undefined, delete: () => undefined })
    expect(() => cisSignals(tenantId)).toThrow("The saved workspace cannot be read")
  })

  it("emits a high below-bar signal when readiness falls below 0.90", () => {
    seed([historyEntry("run-2", "2026-02-01T00:00:00.000Z", ["Missing", "Missing", "Missing"]), historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])])
    const signals = cisSignals(tenantId)
    expect(signals.length).toBeGreaterThan(0)
    const level1 = signals.find(signal => signal.key.startsWith("cis-readiness:1:"))
    expect(level1).toMatchObject({ tenantId, source: "cis", severity: "high", state: "open", link: "/portal/frameworks/cis-benchmarks", observedAt: "2026-02-01T00:00:00.000Z", evidence: [] })
    expect(level1?.key).toBe("cis-readiness:1:fakebook-os:9-9-9")
    expect(level1?.title).toContain("Level 1")
    expect(level1?.title).toContain("fakebook-os")
    expect(level1?.reason).toContain("settings pass rate fell from 100% on")
    expect(level1?.reason).toContain("to 0% on")
    expect(level1?.reason).toContain("Raw rates, exclusions not applied.")
    expect(level1?.reason).toContain("2026-01-01T00:00:00.000Z")
    expect(level1?.reason).toContain("2026-02-01T00:00:00.000Z")
  })

  it("emits a medium decline signal when the drop is large but not below-bar", () => {
    seed([historyEntry("run-2", "2026-02-01T00:00:00.000Z", ["Missing", "Missing", "Present"]), historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Present"])])
    const signals = cisSignals(tenantId)
    const level1 = signals.find(signal => signal.key.startsWith("cis-readiness:1:"))
    expect(level1).toMatchObject({ source: "cis", severity: "medium", state: "open" })
    expect(signals.some(signal => signal.key.startsWith("cis-readiness:2:"))).toBe(false)
  })

  it("emits nothing when readiness rises", () => {
    seed([historyEntry("run-2", "2026-02-01T00:00:00.000Z", ["Present", "Present", "Present"]), historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])])
    expect(cisSignals(tenantId)).toEqual([])
  })

  it("emits nothing when a newer assessment recovers after a drop", () => {
    seed([
      historyEntry("run-3", "2026-03-01T00:00:00.000Z", ["Present", "Present", "Present"]),
      historyEntry("run-2", "2026-02-01T00:00:00.000Z", ["Missing", "Missing", "Missing"]),
      historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"]),
    ])
    expect(cisSignals(tenantId)).toEqual([])
  })

  it("produces a signal when CIS is enabled through the established flag with the env var unset", () => {
    seed([historyEntry("run-2", "2026-02-01T00:00:00.000Z", ["Missing", "Missing", "Missing"]), historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])])
    setInternalCisBenchmarksEnabled(true)
    expect(cisSignals(tenantId).length).toBeGreaterThan(0)
  })

  it("ignores the legacy environment variable and follows the server-issued provider", () => {
    seed([historyEntry("run-2", "2026-02-01T00:00:00.000Z", ["Missing", "Missing", "Missing"]), historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])])
    setInternalCisBenchmarksEnabled(null)
    process.env.TENUVAULT_INTERNAL_CIS_BENCHMARKS = "1"
    try {
      expect(cisSignals(tenantId)).toEqual([])
      setInternalCisBenchmarksProvider(() => true)
      expect(cisSignals(tenantId).length).toBeGreaterThan(0)
    } finally {
      delete process.env.TENUVAULT_INTERNAL_CIS_BENCHMARKS
      setInternalCisBenchmarksProvider(null)
    }
  })

  it("names the benchmark by its catalog display name in titles and reasons, with the id as fallback", () => {
    const named = (entry: ReturnType<typeof historyEntry>) => ({ ...entry, policies: entry.policies.map(item => ({ ...item, provenance: { ...item.provenance, benchmarkName: "Fakebook Display Benchmark" } })) })
    seed([named(historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])), named(historyEntry("run-2", "2026-02-01T00:00:00.000Z", ["Missing", "Missing", "Missing"]))])
    const signals = cisSignals(tenantId)
    expect(signals.length).toBeGreaterThan(0)
    for (const signal of signals) {
      expect(signal.title).toContain("(Fakebook Display Benchmark 9.9.9)")
      expect(signal.reason).toContain("for Fakebook Display Benchmark 9.9.9.")
      expect(signal.key).toContain(":fakebook-os:")
    }
    seed([historyEntry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"]), historyEntry("run-2", "2026-02-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])])
    expect(cisSignals(tenantId)[0]!.title).toContain("(fakebook-os 9.9.9)")
  })
})
