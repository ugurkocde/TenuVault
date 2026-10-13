import { describe, expect, it } from "vitest"
import { cisReadinessTrend, type CisTrendHistoryEntry } from "../src/shared/frameworks/cis-trend"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"
import type { Assessment, BaselinePolicy, Finding } from "../src/shared/frameworks/policies"
import type { CisException } from "../src/shared/frameworks/cis-exceptions"

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

function policies(): BaselinePolicy[] {
  const converted = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })
  return converted.packs.flatMap(pack => pack.policies)
}

function entry(runId: string, assessedAt: string, statuses: Finding["status"][]): CisTrendHistoryEntry {
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
  const assessment: Assessment = {
    runId,
    tenantId: "11111111-1111-1111-1111-111111111111",
    frameworkId: "cis-benchmarks",
    reference: "fakebook-os 9.9.9",
    assessedAt,
    policyCount: pack.length,
    findings,
  }
  return { assessment, policies: pack }
}

function emptyEntry(runId: string, assessedAt: string): CisTrendHistoryEntry {
  const pack = policies()
  const assessment: Assessment = {
    runId,
    tenantId: "11111111-1111-1111-1111-111111111111",
    frameworkId: "cis-benchmarks",
    reference: "fakebook-os 9.9.9",
    assessedAt,
    policyCount: pack.length,
    findings: [],
  }
  return { assessment, policies: pack }
}

describe("cisReadinessTrend", () => {
  it("returns an empty list for empty history and one point for a single entry", () => {
    expect(cisReadinessTrend([])).toEqual([])
    const points = cisReadinessTrend([entry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Present"])])
    expect(points).toHaveLength(1)
    expect(points[0]?.runId).toBe("run-1")
    expect(points[0]?.benchmark).toBe("fakebook-os")
    expect(points[0]?.version).toBe("9.9.9")
    const level1 = points[0]?.levels.find(level => level.level === 1)
    expect(level1?.passRate).toBe(0.5)
    expect(level1?.changeFromPrevious).toBeNull()
  })

  it("sorts points ascending by assessedAt regardless of input order", () => {
    const later = entry("run-2", "2026-02-01T00:00:00.000Z", ["Present", "Present", "Present"])
    const earlier = entry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Missing"])
    const points = cisReadinessTrend([later, earlier])
    expect(points.map(point => point.runId)).toEqual(["run-1", "run-2"])
    expect(points.map(point => point.assessedAt)).toEqual(["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"])
  })

  it("does not mutate the input history", () => {
    const later = entry("run-2", "2026-02-01T00:00:00.000Z", ["Present", "Present", "Present"])
    const earlier = entry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Missing"])
    const history = [later, earlier]
    const snapshot = JSON.stringify(history)
    cisReadinessTrend(history)
    expect(history.map(item => item.assessment.runId)).toEqual(["run-2", "run-1"])
    expect(JSON.stringify(history)).toBe(snapshot)
  })

  it("computes changeFromPrevious per level in pass rate points", () => {
    const points = cisReadinessTrend([
      entry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Missing"]),
      entry("run-2", "2026-02-01T00:00:00.000Z", ["Present", "Present", "Present"]),
      entry("run-3", "2026-03-01T00:00:00.000Z", ["Missing", "Missing", "Missing"]),
    ])
    const level1 = points.map(point => point.levels.find(level => level.level === 1)!)
    expect(level1.map(level => level.passRate)).toEqual([0.5, 1, 0])
    expect(level1[0]?.changeFromPrevious).toBeNull()
    expect(level1[1]?.changeFromPrevious).toBeCloseTo(0.5)
    expect(level1[2]?.changeFromPrevious).toBeCloseTo(-1)
    const level2 = points.map(point => point.levels.find(level => level.level === 2)!)
    expect(level2.map(level => level.passRate)).toEqual([0, 1, 0])
    expect(level2[1]?.changeFromPrevious).toBeCloseTo(1)
    expect(level1[1]?.assessedSettings).toBe(2)
    expect(level1[1]?.present).toBe(2)
  })

  it("keeps null passRate for entries with no findings and nulls the next delta", () => {
    const points = cisReadinessTrend([
      entry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"]),
      emptyEntry("run-2", "2026-02-01T00:00:00.000Z"),
      entry("run-3", "2026-03-01T00:00:00.000Z", ["Present", "Missing", "Present"]),
    ])
    const level1 = points.map(point => point.levels.find(level => level.level === 1)!)
    expect(level1[1]?.passRate).toBeNull()
    expect(level1[1]?.adjustedPassRate).toBeNull()
    expect(level1[1]?.assessedSettings).toBe(0)
    expect(level1[1]?.changeFromPrevious).toBeNull()
    expect(level1[2]?.passRate).toBe(0.5)
    expect(level1[2]?.changeFromPrevious).toBeNull()
  })

  it("deduplicates the same runId keeping the first entry", () => {
    const first = entry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])
    const duplicate = entry("run-1", "2026-01-02T00:00:00.000Z", ["Missing", "Missing", "Missing"])
    const other = entry("run-2", "2026-02-01T00:00:00.000Z", ["Present", "Missing", "Present"])
    const points = cisReadinessTrend([first, duplicate, other])
    expect(points).toHaveLength(2)
    expect(points[0]?.assessedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(points[0]?.levels.find(level => level.level === 1)?.passRate).toBe(1)
  })

  it("includes the exceptions adjusted rate and its change", () => {
    const exception: CisException = {
      id: "exc-1", benchmark: "fakebook-os", version: "9.9.9", level: 1,
      policyName: "Fakebook Beta", settingId: "fakebook_setting_beta",
      owner: "Ada Lovelace", reason: "Accepted risk for lab devices", expiresOn: "2027-01-01", createdAt: "2026-01-01T00:00:00.000Z",
    }
    const points = cisReadinessTrend([
      entry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Present"]),
      entry("run-2", "2026-02-01T00:00:00.000Z", ["Present", "Missing", "Present"]),
    ], undefined, [exception])
    const level1 = points.map(point => point.levels.find(level => level.level === 1)!)
    expect(level1[0]?.passRate).toBe(0.5)
    expect(level1[0]?.excepted).toBe(1)
    expect(level1[0]?.adjustedPassRate).toBe(1)
    expect(level1[1]?.adjustedPassRate).toBe(1)
    expect(level1[1]?.adjustedChangeFromPrevious).toBeCloseTo(0)
    expect(level1[1]?.changeFromPrevious).toBeCloseTo(0)
  })

  it("passes the recommendation list through to readiness", () => {
    const list = { benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.1", level: 1 as const, automated: true }, { identifier: "7.2.1", level: 2 as const, automated: true }] }
    const points = cisReadinessTrend([entry("run-1", "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Present"])], list)
    expect(points[0]?.benchmark).toBe("fakebook-os")
    expect(points[0]?.levels.map(level => level.level)).toEqual([1, 2])
  })
})
