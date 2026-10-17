import { describe, expect, it } from "vitest"
import { cisPortfolioRows, portfolioBenchmarks, portfolioRate, type CisPortfolioEntry, type CisPortfolioHistoryEntry } from "../src/shared/frameworks/cis-portfolio"
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

function historyEntry(runId: string, tenantId: string, assessedAt: string, statuses: Finding["status"][]): CisPortfolioHistoryEntry {
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
    tenantId,
    frameworkId: "cis-benchmarks",
    reference: "fakebook-os 9.9.9",
    assessedAt,
    policyCount: pack.length,
    findings,
  }
  return { assessment, policies: pack }
}

function historyEntryFor(runId: string, tenantId: string, assessedAt: string, statuses: Finding["status"][], benchmark: string, version: string): CisPortfolioHistoryEntry {
  const converted = convertKit(kitFiles.map(file => ({ ...file, path: file.path.replaceAll("9.9.9", version) })), { id: benchmark, version })
  const pack = converted.packs.flatMap(item => item.policies)
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
  return { assessment: { runId, tenantId, frameworkId: "cis-benchmarks", reference: `${benchmark} ${version}`, assessedAt, policyCount: pack.length, findings }, policies: pack }
}

function entry(tenantId: string, tenantName: string, history: CisPortfolioHistoryEntry[], extra: Partial<CisPortfolioEntry> = {}): CisPortfolioEntry {
  return { tenantId, tenantName, workspace: { history }, ...extra }
}

const tenantA = "11111111-1111-1111-1111-111111111111"
const tenantB = "22222222-2222-2222-2222-222222222222"
const tenantC = "33333333-3333-3333-3333-333333333333"
const tenantD = "44444444-4444-4444-4444-444444444444"

describe("cisPortfolioRows", () => {
  it("returns an empty list for no tenants", () => {
    expect(cisPortfolioRows([])).toEqual([])
  })

  it("returns a single tenant row with its newest assessment rates", () => {
    const rows = cisPortfolioRows([
      entry(tenantA, "Alpha Tenant", [historyEntry("run-1", tenantA, "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Present"])]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tenantId).toBe(tenantA)
    expect(rows[0]?.tenantName).toBe("Alpha Tenant")
    expect(rows[0]?.benchmark).toBe("fakebook-os")
    expect(rows[0]?.version).toBe("9.9.9")
    expect(rows[0]?.assessedAt).toBe("2026-01-01T00:00:00.000Z")
    const level1 = rows[0]?.levels.find(level => level.level === 1)
    const level2 = rows[0]?.levels.find(level => level.level === 2)
    expect(level1?.passRate).toBe(0.5)
    expect(level1?.adjustedPassRate).toBe(0.5)
    expect(level1?.assessedSettings).toBe(2)
    expect(level2?.passRate).toBe(1)
    expect(rows[0]?.error).toBeUndefined()
  })

  it("ranks by Level 1 rate first, then Level 2 rate", () => {
    const rows = cisPortfolioRows([
      entry(tenantB, "Bravo Tenant", [historyEntry("run-b", tenantB, "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Present"])]),
      entry(tenantA, "Alpha Tenant", [historyEntry("run-a", tenantA, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Missing"])]),
      entry(tenantC, "Charlie Tenant", [historyEntry("run-c", tenantC, "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Missing"])]),
    ])
    expect(rows.map(row => row.tenantId)).toEqual([tenantA, tenantB, tenantC])
  })

  it("puts null rates below any numeric rate at the same key", () => {
    const empty = historyEntry("run-empty", tenantC, "2026-02-01T00:00:00.000Z", [])
    const rows = cisPortfolioRows([
      entry(tenantC, "Charlie Tenant", [empty]),
      entry(tenantB, "Bravo Tenant", [historyEntry("run-b", tenantB, "2026-01-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])]),
      entry(tenantA, "Alpha Tenant", [historyEntry("run-a", tenantA, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])]),
    ])
    expect(rows.map(row => row.tenantId)).toEqual([tenantA, tenantB, tenantC])
    const nullRow = rows.find(row => row.tenantId === tenantC)
    expect(nullRow?.levels.find(level => level.level === 1)?.passRate).toBeNull()
    expect(nullRow?.assessedAt).toBe("2026-02-01T00:00:00.000Z")
  })

  it("places tenants with no saved assessment at the bottom with assessedAt null", () => {
    const rows = cisPortfolioRows([
      { tenantId: tenantC, tenantName: "Charlie Tenant", workspace: { history: [] } },
      entry(tenantA, "Alpha Tenant", [historyEntry("run-a", tenantA, "2026-01-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])]),
      { tenantId: tenantB, tenantName: "Bravo Tenant", workspace: null },
      { tenantId: tenantD, tenantName: "Delta Tenant" },
    ])
    expect(rows.map(row => row.tenantId)).toEqual([tenantA, tenantB, tenantC, tenantD])
    for (const row of rows.slice(1)) {
      expect(row.assessedAt).toBeNull()
      expect(row.benchmark).toBeNull()
      expect(row.version).toBeNull()
      expect(row.levels).toEqual([])
    }
  })

  it("selects the newest history entry by assessedAt, not array position", () => {
    const older = historyEntry("run-old", tenantA, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])
    const newer = historyEntry("run-new", tenantA, "2026-03-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])
    const rows = cisPortfolioRows([entry(tenantA, "Alpha Tenant", [older, newer])])
    expect(rows[0]?.assessedAt).toBe("2026-03-01T00:00:00.000Z")
    expect(rows[0]?.levels.find(level => level.level === 1)?.passRate).toBe(0)
    const reversed = cisPortfolioRows([entry(tenantA, "Alpha Tenant", [newer, older])])
    expect(reversed[0]?.assessedAt).toBe("2026-03-01T00:00:00.000Z")
  })

  it("breaks an assessedAt tie by run id, the order every CIS view uses, whatever the storage order", () => {
    const first = historyEntry("run-first", tenantA, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])
    const second = historyEntry("run-second", tenantA, "2026-01-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])
    for (const history of [[first, second], [second, first]]) {
      const rows = cisPortfolioRows([entry(tenantA, "Alpha Tenant", history)])
      expect(rows[0]?.levels.find(level => level.level === 1)?.passRate).toBe(0)
    }
  })

  it("preserves a per tenant error row and ranks it with the not assessed rows", () => {
    const rows = cisPortfolioRows([
      { tenantId: tenantB, tenantName: "Bravo Tenant", error: "The saved workspace cannot be read" },
      entry(tenantA, "Alpha Tenant", [historyEntry("run-a", tenantA, "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Present"])]),
    ])
    expect(rows.map(row => row.tenantId)).toEqual([tenantA, tenantB])
    expect(rows[1]?.error).toBe("The saved workspace cannot be read")
    expect(rows[1]?.assessedAt).toBeNull()
    expect(rows[1]?.levels).toEqual([])
  })

  it("ranks by the raw headline rate and shows the rate with exclusions next to it", () => {
    const exception: CisException = {
      id: "exc-1", benchmark: "fakebook-os", version: "9.9.9", level: 1,
      policyName: "Fakebook Beta", settingId: "fakebook_setting_beta",
      owner: "Ada Lovelace", reason: "Accepted risk for lab devices", expiresOn: "2027-01-01", createdAt: "2026-01-01T00:00:00.000Z",
    }
    const withException = entry(tenantB, "Bravo Tenant", [historyEntry("run-b", tenantB, "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Missing"])], { workspace: { history: [historyEntry("run-b", tenantB, "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Missing"])], exceptions: [exception] } })
    const rows = cisPortfolioRows([
      entry(tenantA, "Alpha Tenant", [historyEntry("run-a", tenantA, "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Present"])]),
      withException,
    ], undefined, "2026-10-16")
    // Both have a raw Level 1 rate of 50%; Level 2 decides. Exclusions never change the ranking.
    expect(rows.map(row => row.tenantId)).toEqual([tenantA, tenantB])
    const level1 = rows[1]?.levels.find(level => level.level === 1)
    expect(portfolioRate(level1)).toBe(0.5)
    expect(level1?.excepted).toBe(1)
    expect(level1?.headline).toMatchObject({ label: "Settings pass rate", rate: 0.5, adjusted: 1, exclusions: 1 })
  })

  it("breaks rate ties by assessedAt descending, then tenant name", () => {
    const rows = cisPortfolioRows([
      entry(tenantC, "Charlie Tenant", [historyEntry("run-c", tenantC, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])]),
      entry(tenantB, "Bravo Tenant", [historyEntry("run-b", tenantB, "2026-02-01T00:00:00.000Z", ["Present", "Present", "Present"])]),
      entry(tenantA, "Alpha Tenant", [historyEntry("run-a", tenantA, "2026-02-01T00:00:00.000Z", ["Present", "Present", "Present"])]),
    ])
    expect(rows.map(row => row.tenantId)).toEqual([tenantA, tenantB, tenantC])
  })

  it("applies exclusions active today to the newest assessment, as the CIS page does", () => {
    const late: CisException = {
      id: "exc-late", benchmark: "fakebook-os", version: "9.9.9", level: 1,
      policyName: "Fakebook Beta", settingId: "fakebook_setting_beta",
      owner: "Ada Lovelace", reason: "Accepted later", expiresOn: "2027-01-01", createdAt: "2026-02-01T00:00:00.000Z",
    }
    const hist = historyEntry("run-b", tenantB, "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Missing"])
    const rows = cisPortfolioRows([{ tenantId: tenantB, tenantName: "Bravo Tenant", workspace: { history: [hist], exceptions: [late] } }], undefined, "2026-10-16")
    const level1 = rows[0]?.levels.find(level => level.level === 1)
    expect(level1?.excepted).toBe(1)
    expect(level1?.passRate).toBe(0.5)
    expect(level1?.headline).toMatchObject({ rate: 0.5, adjusted: 1, exclusions: 1, exclusionsAsOf: "2026-10-16" })
    // On a day the exclusion has expired it no longer counts.
    expect(cisPortfolioRows([{ tenantId: tenantB, tenantName: "Bravo Tenant", workspace: { history: [hist], exceptions: [late] } }], undefined, "2027-01-02")[0]?.levels[0]?.headline.exclusions).toBe(0)
  })

  it("compares tenants on one benchmark and version, the one most tenants assessed by default", () => {
    const entries = [
      entry(tenantB, "Bravo Tenant", [historyEntryFor("run-b", tenantB, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"], "otherbook-os", "1.0.0")]),
      entry(tenantA, "Alpha Tenant", [historyEntryFor("run-a", tenantA, "2026-01-01T00:00:00.000Z", ["Missing", "Missing", "Missing"], "fakebook-os", "9.9.9")]),
      // Charlie's newest run is another benchmark; its newest run of the compared benchmark is used.
      entry(tenantC, "Charlie Tenant", [
        historyEntryFor("run-c-other", tenantC, "2026-03-01T00:00:00.000Z", ["Missing", "Missing", "Missing"], "otherbook-os", "1.0.0"),
        historyEntryFor("run-c", tenantC, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"], "fakebook-os", "9.9.9"),
      ]),
      entry(tenantD, "Delta Tenant", [
        historyEntryFor("run-d-new", tenantD, "2026-02-01T00:00:00.000Z", ["Present", "Present", "Present"], "fakebook-os", "8.0.0"),
        historyEntryFor("run-d", tenantD, "2026-01-01T00:00:00.000Z", ["Present", "Missing", "Present"], "fakebook-os", "9.9.9"),
      ]),
    ]
    expect(portfolioBenchmarks(entries).map(item => [item.benchmark, item.version, item.tenants])).toEqual([["fakebook-os", "9.9.9", 3], ["otherbook-os", "1.0.0", 2], ["fakebook-os", "8.0.0", 1]])
    const rows = cisPortfolioRows(entries)
    expect(rows.map(row => row.tenantId)).toEqual([tenantC, tenantD, tenantA, tenantB])
    expect(rows.map(row => row.assessedAt === null ? null : `${row.benchmark}@${row.version}`)).toEqual(["fakebook-os@9.9.9", "fakebook-os@9.9.9", "fakebook-os@9.9.9", null])
    expect(rows[3]?.otherBenchmark).toBe(true)
    const other = cisPortfolioRows(entries, { benchmark: "otherbook-os", version: "1.0.0" })
    expect(other.map(row => [row.tenantId, row.assessedAt === null ? null : `${row.benchmark}@${row.version}`])).toEqual([[tenantB, "otherbook-os@1.0.0"], [tenantC, "otherbook-os@1.0.0"], [tenantA, null], [tenantD, null]])
  })

  it("deduplicates tenants by lowercased tenant id, keeping the first occurrence", () => {
    const rows = cisPortfolioRows([
      entry(tenantA, "Alpha Tenant", [historyEntry("run-a", tenantA, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])]),
      entry(tenantA.toUpperCase(), "Duplicate Tenant", [historyEntry("run-dup", tenantA, "2026-01-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tenantName).toBe("Alpha Tenant")
    expect(rows[0]?.levels.find(level => level.level === 1)?.passRate).toBe(1)
  })

  it("returns an error row when the newest assessment belongs to a different tenant", () => {
    const rows = cisPortfolioRows([
      entry(tenantA, "Alpha Tenant", [historyEntry("run-a", tenantB, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.error).toBe("The saved assessment belongs to a different tenant.")
    expect(rows[0]?.assessedAt).toBeNull()
    expect(rows[0]?.levels).toEqual([])
  })

  it("does not mutate the input entries", () => {
    const input: CisPortfolioEntry[] = [
      entry(tenantB, "Bravo Tenant", [historyEntry("run-b", tenantB, "2026-01-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])]),
      entry(tenantA, "Alpha Tenant", [historyEntry("run-a", tenantA, "2026-01-01T00:00:00.000Z", ["Present", "Present", "Present"])]),
    ]
    const snapshot = JSON.stringify(input)
    const rows = cisPortfolioRows(input)
    expect(rows.map(row => row.tenantId)).toEqual([tenantA, tenantB])
    expect(input.map(item => item.tenantId)).toEqual([tenantB, tenantA])
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe("CIS portfolio per Level", () => {
  /** One run of a single Level pack, as loading Level 1 or Level 2 of a delivered benchmark saves it. */
  function levelRun(runId: string, level: 1 | 2, assessedAt: string, status: Finding["status"]): CisPortfolioHistoryEntry {
    const pack = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" }).packs.find(item => item.level === level)!
    const findings: Finding[] = pack.policies.map((item, index) => ({ key: `${index}:0`, policyIndex: index, settingIndex: 0, policyName: item.name, settingId: String((item.settings[0]!.settingInstance as { settingDefinitionId: string }).settingDefinitionId), status, recommended: null, observed: [] }))
    return { assessment: { runId, tenantId: tenantA, frameworkId: "cis-benchmarks", reference: pack.reference, assessedAt, policyCount: 1, findings }, policies: pack.policies }
  }

  it("takes each Level from the newest assessment of that Level, so a newer Level 1 run does not hide Level 2", () => {
    // The Defender case: Level 2 assessed at 100% first, then Level 1 assessed later.
    const level2 = levelRun("run-l2", 2, "2026-10-15T16:34:00Z", "Present")
    const level1 = levelRun("run-l1", 1, "2026-10-16T09:00:00Z", "Missing")
    const olderLevel1 = levelRun("run-l1-old", 1, "2026-10-14T09:00:00Z", "Present")
    const [row] = cisPortfolioRows([entry(tenantA, "Ugur Koc Lab", [level1, olderLevel1, level2])], { benchmark: "fakebook-os", version: "9.9.9" }, "2026-10-17")
    expect(row!.assessedAt).toBe("2026-10-16T09:00:00Z")
    const l1 = row!.levels.find(level => level.level === 1)!
    const l2 = row!.levels.find(level => level.level === 2)!
    expect(portfolioRate(l1)).toBe(0)
    expect(l1.assessedAt).toBe("2026-10-16T09:00:00Z")
    expect(portfolioRate(l2)).toBe(1)
    expect(l2.assessedAt).toBe("2026-10-15T16:34:00Z")
  })

  it("uses the shared order for ties, as the trend does", () => {
    const a = levelRun("run-a", 2, "2026-10-15T16:34:00Z", "Missing")
    const b = levelRun("run-b", 2, "2026-10-15T16:34:00Z", "Present")
    const [row] = cisPortfolioRows([entry(tenantA, "Lab", [b, a])], { benchmark: "fakebook-os", version: "9.9.9" }, "2026-10-17")
    // Same time: the run id decides, as compareAssessments orders them everywhere.
    expect(portfolioRate(row!.levels.find(level => level.level === 2))).toBe(1)
  })
})
