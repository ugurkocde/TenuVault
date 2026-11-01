import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseBreakoutWorkbook, recommendationListFromWorkbook } from "../src/shared/frameworks/cis-coverage"
import { MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL, MAX_LIST_ITEMS, MAX_LIST_TEXT_LENGTH, MAX_LIST_TITLE_LENGTH, manualItemsForLevel, parseRecommendationList, recommendationListFromBreakout, serializeRecommendationList, validateRecommendationList } from "../src/shared/frameworks/cis-manual"
import { cisReadiness, levelCheckCounts, levelCheckSummary } from "../src/shared/frameworks/cis-readiness"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"
import { cisReadinessCsv, cisReadinessJson } from "../src/renderer/features/shared/governance-export"
import { handleFramework, setInternalCisBenchmarksEnabled, assessPolicySet } from "../src/main/frameworks/service"
import { loadWorkspace, saveWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { parsePolicies } from "../src/shared/frameworks/policies"

const execFileAsync = promisify(execFile)
const tenantId = "11111111-1111-1111-1111-111111111111"
const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (name: string, description: string, settingId = "fakebook_setting_alpha") => JSON.stringify({
  name, platforms: "windows10", technologies: "mdm", description,
  settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: settingId, choiceSettingValue: { value: "fake-on" } } }],
})
const kitFiles: KitFile[] = [
  { path: "Level 1/Fakebook Alpha 9.9.9.json", content: policy("Fakebook Alpha", "Covers 7.1.1 and 7.1.2") },
  { path: "Level 2/Fakebook Gamma 9.9.9.json", content: policy("Fakebook Gamma", "Covers 7.2.1", "fakebook_setting_gamma") },
]

afterEach(() => { setInternalCisBenchmarksEnabled(null); vi.unstubAllGlobals() })

const validList = () => ({
  benchmark: "fakebook-os", version: "9.9.9",
  items: [
    { identifier: "7.1.1", level: 1, automated: true, title: "Invented automated title" },
    { identifier: "7.1.4", level: 1, automated: false, title: "Invented manual title", description: "Invented description text.", impact: "Invented impact text.", audit: "Invented audit text.", remediation: "Invented remediation text." },
    { identifier: "7.1.5", level: 1, automated: false },
    { identifier: "7.2.4", level: 2, automated: false, title: "Invented level two manual title" },
  ],
})

describe("recommendation list validation", () => {
  it("accepts the documented shape with optional text fields", () => {
    const list = parseRecommendationList(JSON.stringify(validList()))
    expect(list.benchmark).toBe("fakebook-os")
    expect(list.version).toBe("9.9.9")
    expect(list.items).toHaveLength(4)
    expect(list.items[1]).toMatchObject({ identifier: "7.1.4", level: 1, automated: false, title: "Invented manual title", description: "Invented description text." })
    expect(serializeRecommendationList(list)).toContain("fakebook-os")
    expect(validateRecommendationList(validList()).items[0]?.automated).toBe(true)
  })

  it("rejects malformed files naming the problem", () => {
    expect(() => parseRecommendationList("not json")).toThrowError(/not valid JSON/)
    expect(() => parseRecommendationList("[]")).toThrowError(/JSON object with benchmark, version and items/)
    expect(() => parseRecommendationList(JSON.stringify({ version: "9.9.9", items: [] }))).toThrowError(/benchmark/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmark: "Fakebook OS", version: "9.9.9", items: [] }))).toThrowError(/benchmark/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmark: "fakebook-os", version: "", items: [] }))).toThrowError(/version/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmark: "fakebook-os", version: "9.9.9", items: {} }))).toThrowError(/items must be an array/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmark: "fakebook-os", version: "9.9.9", items: [] }))).toThrowError(/at least one item/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmarkId: "fakebook-os", version: "9.9.9", items: validList().items }))).toThrowError(/unknown field: benchmarkId/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.1", level: 3, automated: true }] }))).toThrowError(/item 1: level must be 1 or 2/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.1", level: 1, automated: "yes" }] }))).toThrowError(/item 1: automated/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.1", level: 1, automated: true, description: 4 }] }))).toThrowError(/item 1: description must be a string/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.1", level: 1, automated: true }, { identifier: "7.1.1", level: 1, automated: false }] }))).toThrowError(/duplicate identifier 7\.1\.1/)
    expect(() => parseRecommendationList(JSON.stringify({ benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.1", level: 1, automated: true, bogus: "x" }] }))).toThrowError(/unknown field: bogus/)
  })
})

async function syntheticWorkbook(): Promise<Uint8Array> {
  const strings = ["Section #", "Recommendation #", "Profile", "Title", "Build Kit Name",
    "7", "7.1.1", "Level 1 (L1)", "Invented title one", "Fakebook Alpha",
    "7.1.2", "Invented title two", "7.1.3", "Invented manual title", "Manual",
    "7.2.1", "Level 2 (L2)", "Invented level two title", "Fakebook Beta"]
  const index = (value: string) => strings.indexOf(value)
  const cell = (ref: string, value: string) => `<c r="${ref}" t="s"><v>${index(value)}</v></c>`
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
    + `<row r="1">${cell("A1", "Section #")}${cell("B1", "Recommendation #")}${cell("C1", "Profile")}${cell("D1", "Title")}${cell("E1", "Build Kit Name")}</row>`
    + `<row r="2">${cell("A2", "7")}${cell("B2", "7.1.1")}${cell("C2", "Level 1 (L1)")}${cell("D2", "Invented title one")}${cell("E2", "Fakebook Alpha")}</row>`
    + `<row r="3">${cell("A3", "7")}${cell("B3", "7.1.3")}${cell("C3", "Level 1 (L1)")}${cell("D3", "Invented manual title")}${cell("E3", "Manual")}</row>`
    + `<row r="4">${cell("A4", "7")}${cell("B4", "7.2.1")}${cell("C4", "Level 2 (L2)")}${cell("D4", "Invented level two title")}${cell("E4", "Fakebook Beta")}</row>`
    + `</sheetData></worksheet>`
  const shared = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">`
    + strings.map(value => `<si><t>${value}</t></si>`).join("") + `</sst>`
  const zip = new JSZip()
  zip.file("xl/sharedStrings.xml", shared)
  zip.file("xl/worksheets/sheet1.xml", sheet)
  return zip.generateAsync({ type: "uint8array" })
}

describe("delivered recommendation list limits and states", () => {
  const item = (identifier: string, extra: Record<string, unknown> = {}) => ({ identifier, level: 1, automated: true, ...extra })

  it("bounds the item count, titles and text fields", () => {
    expect(() => validateRecommendationList({ benchmark: "synthetic-os", version: "1.0.0", items: Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, index) => item(`1.${index}`)) })).toThrow(`at most ${MAX_LIST_ITEMS} items`)
    expect(() => validateRecommendationList({ benchmark: "synthetic-os", version: "1.0.0", items: [item("1.1", { title: "t".repeat(MAX_LIST_TITLE_LENGTH + 1) })] })).toThrow("title must be at most")
    expect(() => validateRecommendationList({ benchmark: "synthetic-os", version: "1.0.0", items: [item("1.1", { audit: "a".repeat(MAX_LIST_TEXT_LENGTH + 1) })] })).toThrow("audit must be at most")
    expect(validateRecommendationList({ benchmark: "synthetic-os", version: "1.0.0", items: [item("1.1", { audit: "a".repeat(MAX_LIST_TEXT_LENGTH) })] }).items[0]!.audit).toHaveLength(MAX_LIST_TEXT_LENGTH)
  })

  it("marks manual items Manual and unassessed automated items Not assessed, each with its list text", () => {
    const list = validateRecommendationList({ benchmark: "synthetic-os", version: "1.0.0", items: [
      item("1.1", { title: "Synthetic covered" }),
      item("1.2", { title: "Synthetic uncovered", description: "Synthetic description.", audit: "Synthetic audit." }),
      item("1.3", { automated: false, title: "Synthetic manual", remediation: "Synthetic remediation." }),
      item("2.1", { level: 2, automated: false, title: "Other Level" }),
    ] })
    const items = manualItemsForLevel(list, 1, ["1.2", "1.9"], ["1.4"])
    expect(items.map(entry => [entry.identifier, entry.state, entry.hasText])).toEqual([["1.2", "Not assessed", true], ["1.3", "Manual", true], ["1.4", "Manual", false], ["1.9", "Not assessed", false]])
    expect(items[0]).toMatchObject({ title: "Synthetic uncovered", description: "Synthetic description.", audit: "Synthetic audit.", level: 1 })
    // A manual list item stays Manual even when an unassessed list names it too.
    expect(manualItemsForLevel(list, 1, ["1.3"]).find(entry => entry.identifier === "1.3")?.state).toBe("Manual")
  })
})

describe("workbook to recommendation list conversion", () => {
  it("marks the manual bucket automated false, carries titles, and keeps the default parser title free", async () => {
    const bytes = await syntheticWorkbook()
    expect(JSON.stringify(await parseBreakoutWorkbook(bytes))).not.toContain("Invented title")
    const list = await recommendationListFromWorkbook(bytes, { id: "fakebook-os", version: "9.9.9" })
    expect(list).toEqual({
      benchmark: "fakebook-os", version: "9.9.9",
      items: [
        { identifier: "7.1.1", level: 1, automated: true, title: "Invented title one" },
        { identifier: "7.1.3", level: 1, automated: false, title: "Invented manual title" },
        { identifier: "7.2.1", level: 2, automated: true, title: "Invented level two title" },
      ],
    })
    expect(recommendationListFromBreakout([{ identifier: "7.9.1", level: 1, buildKitName: "Fakebook Manual Checks", title: "Invented manual bucket title" }], { id: "fakebook-os", version: "9.9.9" }).items[0]?.automated).toBe(false)
  })

  it("writes the list outside the repository and refuses a repo relative path through the coverage script", async () => {
    const root = mkdtempSync(join(tmpdir(), "tenuvault-manual-list-"))
    try {
      const kitDir = join(root, "Fakebook Kit 9.9.9")
      mkdirSync(join(kitDir, "Level 1"), { recursive: true })
      writeFileSync(join(kitDir, "Level 1", "Fakebook Alpha 9.9.9.json"), policy("Fakebook Alpha", "Covers 7.1.1"))
      const workbookPath = join(root, "breakout.xlsx")
      writeFileSync(workbookPath, await syntheticWorkbook())
      const outside = join(root, "recommendations.json")
      const script = join(process.cwd(), "scripts", "cis-kit-coverage.ts")
      await execFileAsync("npx", ["jiti", script, kitDir, "--breakout", workbookPath, "--export-recommendation-list", outside], { cwd: process.cwd(), timeout: 60_000 })
      const written = parseRecommendationList(readFileSync(outside, "utf8"))
      expect(written.items.find(item => item.identifier === "7.1.3")?.automated).toBe(false)
      expect(written.items.find(item => item.identifier === "7.1.1")?.title).toBe("Invented title one")
      const inside = join(process.cwd(), "cis-manual-refused.json")
      await expect(execFileAsync("npx", ["jiti", script, kitDir, "--breakout", workbookPath, "--export-recommendation-list", inside], { cwd: process.cwd(), timeout: 60_000 })).rejects.toMatchObject({ stderr: expect.stringContaining("inside the repository") })
      expect(existsSync(inside)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 120_000)
})

describe("manual readiness data", () => {
  function assessed() {
    const converted = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })
    const policies = converted.packs.flatMap(pack => pack.policies)
    const current = parsePolicies(JSON.parse(policy("Tenant Alpha", "tenant"))).map((item, index) => ({ ...item, id: `33333333-3333-3333-3333-33333333333${index}` }))
    const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9", policies, current, runId: "run-1", assessedAt: "2026-10-13T00:00:00.000Z" })
    return { policies, assessment }
  }

  it("composes the Manual section per Level with text when present and the exact fallback when absent", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies, undefined, parseRecommendationList(JSON.stringify(validList())))
    expect(summary.manualFallback).toBe(MANUAL_RECOMMENDATIONS_FALLBACK)
    expect(summary.manualFallback).toBe("Not all recommendations from the CIS Benchmarks are included in this tool. Please refer to the CIS website to access the free CIS Benchmarks PDFs for manual assessment instructions.")
    expect(summary.manualFallbackUrl).toBe("https://www.cisecurity.org/cis-benchmarks")
    expect(MANUAL_RECOMMENDATIONS_URL).toBe("https://www.cisecurity.org/cis-benchmarks")
    const level1 = summary.levels.find(level => level.level === 1)!
    expect(level1.manual.map(item => item.identifier)).toEqual(expect.arrayContaining(["7.1.4", "7.1.5"]))
    const withText = level1.manual.find(item => item.identifier === "7.1.4")!
    expect(withText).toMatchObject({ title: "Invented manual title", hasText: true, state: "Manual", description: "Invented description text.", impact: "Invented impact text.", audit: "Invented audit text.", remediation: "Invented remediation text." })
    const withoutText = level1.manual.find(item => item.identifier === "7.1.5")!
    expect(withoutText.hasText).toBe(false)
    expect(withoutText.fallback).toBe(MANUAL_RECOMMENDATIONS_FALLBACK)
    expect(withoutText.fallbackUrl).toBe(MANUAL_RECOMMENDATIONS_URL)
    const level2 = summary.levels.find(level => level.level === 2)!
    expect(level2.manual.map(item => item.identifier)).toContain("7.2.4")
  })

  it("does not apply a list for another benchmark or version to this pack", () => {
    const { policies, assessment } = assessed()
    const other = parseRecommendationList(JSON.stringify({ benchmark: "other-os", version: "1.0.0", items: [{ identifier: "9.9.9", level: 1, automated: false, title: "Invented other title" }] }))
    const summary = cisReadiness(assessment, policies, undefined, other)
    expect(summary.benchmark).toBe("fakebook-os")
    expect(summary.levels.every(level => level.manual.every(item => item.identifier !== "9.9.9"))).toBe(true)
    expect(summary.recommendationList).toBeUndefined()
  })

  it("lists automated denominator identifiers the pack did not assess as Not assessed", () => {
    const { policies, assessment } = assessed()
    const denominator = [
      { identifier: "7.1.1", level: 1 as const, automated: true },
      { identifier: "7.1.9", level: 1 as const, automated: true },
    ]
    const summary = cisReadiness(assessment, policies, denominator)
    const level1 = summary.levels.find(level => level.level === 1)!
    expect(level1.notAssessed).toContain("7.1.9")
    expect(level1.manual.find(item => item.identifier === "7.1.9")).toMatchObject({ hasText: false, state: "Not assessed", fallback: MANUAL_RECOMMENDATIONS_FALLBACK })
    // The total is exactly the denominator identifiers of the Level: 7.1.1 is covered, 7.1.9 is not.
    expect(levelCheckCounts(level1)).toEqual({ checked: 1, manual: 1, total: 2 })
  })

  it("keeps the total for a listed Level that the pack has no policies for", () => {
    const { policies, assessment } = assessed()
    const level1Policies = policies.filter(policy => !String(policy.provenance?.level ?? "").includes("2"))
    const list = { benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.1", level: 1 as const, automated: true }, { identifier: "9.2.1", level: 2 as const, automated: false }, { identifier: "9.2.2", level: 2 as const, automated: false }] }
    const level2 = cisReadiness(assessment, level1Policies, undefined, list).levels.find(level => level.level === 2)!
    expect(level2.denominatorIdentifiers).toEqual(["9.2.1", "9.2.2"])
    expect(levelCheckSummary(level2)).toBe("Level 2: TenuVault checks 0 of 2 recommendations automatically. The other 2 need a manual check.")
  })

  it("keeps the total to the denominator when a recommendation list adds manual items outside it", () => {
    const { policies, assessment } = assessed()
    const denominator = [
      { identifier: "7.1.1", level: 1 as const, automated: true },
      { identifier: "7.1.2", level: 1 as const, automated: false },
    ]
    const list = { benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.9", level: 1 as const, automated: false }] }
    const level1 = cisReadiness(assessment, policies, denominator, list).levels.find(level => level.level === 1)!
    expect(level1.manual.map(item => item.identifier)).toEqual(expect.arrayContaining(["7.1.2", "7.1.9"]))
    expect(levelCheckCounts(level1)).toEqual({ checked: 1, manual: 1, total: 2 })
    expect(levelCheckSummary(level1)).toBe("Level 1: TenuVault checks 1 of 2 recommendations automatically. The other one needs a manual check.")
  })

  it("includes manual items with state Manual in the governance export", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies, undefined, parseRecommendationList(JSON.stringify(validList())))
    const csv = cisReadinessCsv(summary)
    expect(csv).toContain("Manual")
    expect(csv).toContain("7.1.4")
    expect(csv).toContain("Invented manual title")
    const json = JSON.parse(cisReadinessJson(summary, "Contoso", "2026-10-13T10:00:00Z")) as { manualItems: Array<{ identifier: string; state: string }>; levels: Array<{ manual: Array<{ identifier: string; state: string }> }> }
    expect(json.manualItems.find(item => item.identifier === "7.1.4")?.state).toBe("Manual")
    expect(json.levels[0]?.manual.find(item => item.identifier === "7.1.5")?.state).toBe("Manual")
  })
})

describe("recommendation list storage and flag gate", () => {
  it("stores the list with the imported kit data through the workspace path", async () => {
    setInternalCisBenchmarksEnabled(true)
    const data = new Map<string, string>()
    setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
    const converted = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })
    const pack = converted.packs.find(item => item.level === 1)!
    const list = parseRecommendationList(JSON.stringify(validList()))
    await handleFramework({ action: "workspace-save", tenantId, frameworkId: "cis-benchmarks", reference: pack.reference, policies: JSON.parse(JSON.stringify(pack.policies)), recommendationList: JSON.parse(JSON.stringify(list)) })
    const stored = loadWorkspace(tenantId, "cis-benchmarks")
    expect(stored.policies[0]?.provenance).toMatchObject({ benchmark: "fakebook-os" })
    expect(stored.recommendationList).toEqual(list)
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    workspace.recommendationList = list
    saveWorkspace(workspace)
    expect(loadWorkspace(tenantId, "cis-benchmarks").recommendationList).toEqual(list)
  })

  it("refuses the recommendation list import when the flag is off, identical to the kit import refusal", async () => {
    setInternalCisBenchmarksEnabled(false)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const list = parseRecommendationList(JSON.stringify(validList()))
    await expect(handleFramework({ action: "workspace-save", tenantId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9 Level 1", policies: [], recommendationList: JSON.parse(JSON.stringify(list)) }))
      .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    await expect(handleFramework({ action: "workspace-load", tenantId, frameworkId: "cis-benchmarks" }))
      .rejects.toMatchObject({ status: 403, message: "CIS comparisons are coming soon." })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects a malformed list through the workspace save path when the flag is on", async () => {
    setInternalCisBenchmarksEnabled(true)
    const data = new Map<string, string>()
    setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
    await expect(handleFramework({ action: "workspace-save", tenantId, frameworkId: "cis-benchmarks", reference: "r1", policies: [], recommendationList: JSON.parse(JSON.stringify({ benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.1", level: 3, automated: true }] })) }))
      .rejects.toThrowError(/level must be 1 or 2/)
  })
})
