import { inflateSync } from "node:zlib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cisSignals } from "../src/main/frameworks/cis-signals"
import { assessPolicySet, handleFramework, setInternalCisBenchmarksEnabled, type ExportFile } from "../src/main/frameworks/service"
import { setNativeFrameworkAuthorization } from "../src/main/frameworks/native"
import { loadWorkspace, recordAssessment, saveWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { cisReadinessCsv, cisReadinessJson } from "../src/renderer/features/shared/governance-export"
import { cisScoreCards } from "../src/renderer/features/scores/cis"
import { deviatingFindingKeys, isSelectableFinding, selectedDeviatingFindings } from "../src/shared/frameworks/cis-display"
import { appliesOn, localDate, type CisException } from "../src/shared/frameworks/cis-exceptions"
import { generateCisReadinessPDF } from "../src/shared/compliance/report-pdf"
import { cisPortfolioRows, portfolioMembers } from "../src/shared/frameworks/cis-portfolio"
import { compareAssessments, distinctExclusions, excludedFindingKeys, exceptionsByHeadline, exclusionsAsOf, exclusionsText, formatRate, levelHeadline, listedExceptions, readinessFor, unassignedText, type CisReadinessEntry } from "../src/shared/frameworks/cis-readiness"
import { cisDriftSignals, cisReadinessTrend, exclusionUse, trendChangeText, trendExclusionsText, trendGroups, trendRate } from "../src/shared/frameworks/cis-trend"
import { attachRecommendations } from "../src/shared/frameworks/cis-recommendations"
import type { AssignmentEvidence } from "../src/shared/frameworks/evidence"
import type { Assessment, BaselinePolicy, Finding, LandscapePolicy } from "../src/shared/frameworks/policies"

const tenantId = "11111111-1111-1111-1111-111111111111"
const choice = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const unassigned: AssignmentEvidence = { state: "unassigned", targets: [], limitations: [] }
const assigned: AssignmentEvidence = { state: "configured", targets: [{ kind: "allDevices" }], limitations: [] }

function instance(settingId: string) {
  return { "@odata.type": choice, settingDefinitionId: settingId, choiceSettingValue: { value: `${settingId}_on`, children: [] } }
}

/** A delivered style pack: one policy per setting, all of one benchmark, version and Level. */
function pack(benchmark: string, version: string, level: 1 | 2, settings: string[]): BaselinePolicy[] {
  return settings.map(settingId => ({
    name: `${benchmark} ${settingId}`, platforms: "windows10", technologies: "mdm", description: "Synthetic",
    provenance: { schemaVersion: 1, benchmark, version, level: `Level ${level}`, sourceFile: `${settingId}.json` },
    settings: [{ settingInstance: instance(settingId) }],
  }))
}

function tenantPolicy(id: string, settingId: string, targeting: AssignmentEvidence): LandscapePolicy {
  return { id, name: `Tenant ${id}`, platforms: "windows10", technologies: "mdm", description: "", settings: [{ settingInstance: instance(settingId) }], targeting }
}

/** One entry with the given statuses by setting position, without reading a tenant. */
function run(runId: string, assessedAt: string, policies: BaselinePolicy[], statuses: Finding["status"][], reference = "synthetic-os 9.9.9 Level 1"): CisReadinessEntry {
  const findings: Finding[] = policies.map((policy, index) => ({
    key: `${index}:0`, policyIndex: index, settingIndex: 0, policyName: policy.name, settingId: String((policy.settings[0]!.settingInstance as { settingDefinitionId: string }).settingDefinitionId),
    status: statuses[index] ?? "Present", recommended: null, observed: [],
  }))
  return { assessment: { runId, tenantId, frameworkId: "cis-benchmarks", reference, assessedAt, policyCount: policies.length, findings }, policies }
}

function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1")
  const parts: string[] = []
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { parts.push(inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1")) } catch { parts.push(match[1]!) }
  }
  const shown = parts.join("\n").match(/\((?:\\.|[^\\()])*\)\s*Tj/g) ?? []
  return shown.map(chunk => chunk.replace(/\)\s*Tj$/, "").slice(1).replace(/\\([()\\])/g, "$1")).join(" ").replace(/\s+/g, " ")
}

let data: Map<string, string>
beforeEach(() => {
  data = new Map<string, string>()
  setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
  setInternalCisBenchmarksEnabled(true)
  setNativeFrameworkAuthorization(async () => "pro")
})
afterEach(() => { setInternalCisBenchmarksEnabled(null); vi.unstubAllGlobals() })

describe("one CIS pass rate in every view", () => {
  // Level 1: alpha present in an unassigned policy, delta present in an assigned policy, beta missing.
  const policies = pack("synthetic-os", "9.9.9", 1, ["synthetic_alpha", "synthetic_beta", "synthetic_delta"])
  const current = [tenantPolicy("a", "synthetic_alpha", unassigned), tenantPolicy("d", "synthetic_delta", assigned)]
  const older = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", policies, current, runId: "run-old", assessedAt: "2026-10-01T12:00:00.000Z" })
  const newest = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", policies, current, runId: "run-new", assessedAt: "2026-10-10T12:00:00.000Z" })
  // Created after both runs, so only a rule that differs between views would split the numbers.
  const exception: CisException = { id: "exc-beta", benchmark: "synthetic-os", version: "9.9.9", level: 1, policyName: policies[1]!.name, settingId: "synthetic_beta", owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", createdAt: "2026-10-12T12:00:00.000Z" }

  it("shows the same rate, label and unit on the page, panel, trend, portfolio, Governance card, CSV, JSON and PDF", async () => {
    const today = localDate()
    recordAssessment(older, policies)
    recordAssessment(newest, policies)
    const saved = loadWorkspace(tenantId, "cis-benchmarks")
    saved.exceptions = [exception]
    saveWorkspace(saved)
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    const entry = workspace.history.find(item => item.assessment.runId === "run-new")!

    // CIS page headline and Level summary.
    const page = readinessFor(entry, workspace, today)
    const head = levelHeadline(page.levels[0]!)
    expect(head).toMatchObject({ basis: "settings", label: "Settings pass rate", exclusions: 1, exclusionsAsOf: today })
    const rate = formatRate(head.rate)
    const withExclusions = exclusionsText(head)
    expect(rate).toBe("66.7%")
    expect(withExclusions).toBe("100% with 1 exclusion")

    // Exclusions panel: the same count of exclusions in use.
    const listed = listedExceptions(page, entry.assessment, entry.policies, workspace.exceptions, today)
    expect(listed.flatMap(group => group.levels.flatMap(level => level.items)).filter(item => item.state === "in-use")).toHaveLength(head.exclusions)

    // Trend row of the same run.
    const point = cisReadinessTrend(workspace.history, undefined, workspace.exceptions, today).find(item => item.runId === "run-new")!
    const trendLevel = point.levels[0]!
    expect(formatRate(trendRate(trendLevel))).toBe(rate)
    expect(trendExclusionsText(trendLevel)).toBe(withExclusions)

    // Portfolio row of this tenant.
    const row = cisPortfolioRows([{ tenantId, tenantName: "Contoso", workspace }], undefined, today)[0]!
    expect(formatRate(row.levels[0]!.headline.rate)).toBe(rate)
    expect(exclusionsText(row.levels[0]!.headline)).toBe(withExclusions)
    expect(row.levels[0]!.headline.label).toBe(head.label)

    // Governance CIS card.
    const card = cisScoreCards(true, workspace, tenantId, today)[0]!.levels[0]!
    expect(`${card.rate}%`).toBe(rate)
    expect(`${card.adjusted}%`).toBe(formatRate(head.adjusted))
    expect(card.withExclusions).toBe(withExclusions)
    expect(card.label).toBe(head.label)

    // Readiness CSV and JSON exported from the page summary.
    expect(cisReadinessCsv(page).split("\r\n")[1]).toContain(`Settings pass rate,66.7,100,1,${today},`)
    expect(JSON.parse(cisReadinessJson(page, "Contoso", "2026-10-16T10:00:00Z")).levels[0]).toMatchObject({ headline: "Settings pass rate", passRatePercent: 66.7, passRateWithExclusionsPercent: 100, exclusions: 1, exclusionsAsOf: today })

    // PDF built in main from the saved workspace.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No network during export") }))
    const exported = await handleFramework({ action: "workspace-cis-pdf", frameworkId: "cis-benchmarks", tenantId, tenantName: "Contoso", runId: "run-new" }) as { file: ExportFile }
    const text = pdfText(Buffer.from(exported.file.data, "base64"))
    // The PDF prints figures as label and value pairs.
    expect(text).toContain(`Settings pass rate ${rate}`)
    expect(text).toContain(`With exclusions ${withExclusions}`)
    expect(text).toContain(`Exclusions as of ${today}`)
    expect(text).toContain("Excluded from score 1")
    expect(text).toContain(`${withExclusions}, exclusions as of ${today}.`)
    expect(text).not.toMatch(/Adjusted|Excepted/)
  })

  it("gives an older run its own as-of date in every view, so its trend point keeps its score", async () => {
    const today = "2026-10-16"
    const workspace = { history: [{ assessment: newest, policies }, { assessment: older, policies }], exceptions: [exception] }
    const olderEntry = workspace.history[1]!
    expect(exclusionsAsOf(olderEntry, workspace, 1, today)).toBe(localDate(older.assessedAt))
    expect(exclusionsAsOf(workspace.history[0]!, workspace, 1, today)).toBe(today)
    const viewed = levelHeadline(readinessFor(olderEntry, workspace, today).levels[0]!)
    const point = cisReadinessTrend(workspace.history, undefined, workspace.exceptions, today).find(item => item.runId === "run-old")!.levels[0]!
    expect(viewed).toMatchObject({ exclusions: 0, adjusted: null })
    expect(point.exclusions).toBe(0)
    expect(formatRate(viewed.rate)).toBe(formatRate(trendRate(point)))
    // An exception that expires changes the newest headline only once its expiry date has passed.
    const expiring = { ...workspace, exceptions: [{ ...exception, expiresOn: "2026-10-20" }] }
    expect(levelHeadline(readinessFor(workspace.history[0]!, expiring, "2026-10-20").levels[0]!).exclusions).toBe(1)
    expect(levelHeadline(readinessFor(workspace.history[0]!, expiring, "2026-10-21").levels[0]!).exclusions).toBe(0)
  })

  it("states how many present settings sit in unassigned policies, and nothing without targeting evidence", () => {
    const level = readinessFor({ assessment: newest, policies }, { history: [] }).levels[0]!
    expect(level.present).toBe(2)
    expect(level.presentInUnassigned).toBe(1)
    expect(unassignedText(level)).toBe("1 of 2 present settings are in unassigned policies. CIS checks configuration; Governance scores count assigned policies only.")
    // A setting present in both an assigned and an unassigned policy is not counted as unassigned only.
    const both = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", policies, current: [...current, tenantPolicy("d2", "synthetic_delta", unassigned)], runId: "run-both" })
    expect(readinessFor({ assessment: both, policies }, { history: [] }).levels[0]!.presentInUnassigned).toBe(1)
    const allUnassigned = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", policies, current: current.map(item => ({ ...item, targeting: unassigned })), runId: "run-all" })
    expect(unassignedText(readinessFor({ assessment: allUnassigned, policies }, { history: [] }).levels[0]!)).toMatch(/^2 of 2 present settings/)
    // Saved results without targeting evidence say nothing.
    const bare = run("run-bare", "2026-10-10T12:00:00.000Z", policies, ["Present", "Missing", "Present"])
    expect(readinessFor(bare, { history: [] }).levels[0]!.presentInUnassigned).toBeNull()
    expect(unassignedText(readinessFor(bare, { history: [] }).levels[0]!)).toBeNull()
  })
})

describe("comparable CIS trends", () => {
  const windows = pack("windows-os", "5.0.0", 1, ["win_a", "win_b"])
  const edge = pack("edge-browser", "2.0.0", 1, ["edge_a"])
  const mac = pack("mac-os", "3.0.0", 1, Array.from({ length: 29 }, (_, index) => `mac_${index}`))
  const macReduced = mac.slice(0, 1)
  const macL2 = pack("mac-os", "3.0.0", 2, ["mac_l2"])

  it("compares a run only with the previous run of the same benchmark, version, Level and pack, grouped by benchmark", () => {
    const history = [
      run("win-1", "2026-10-01T09:00:00.000Z", windows, ["Present", "Missing"], "windows-os 5.0.0 Level 1"),
      run("edge-1", "2026-10-02T09:00:00.000Z", edge, ["Present"], "edge-browser 2.0.0 Level 1"),
      run("mac-1", "2026-10-03T09:00:00.000Z", mac, [...Array(28).fill("Present"), "Missing"], "mac-os 3.0.0 Level 1"),
      run("win-2", "2026-10-04T09:00:00.000Z", windows, ["Present", "Present"], "windows-os 5.0.0 Level 1"),
      // A run of the same benchmark with policies removed from the pack.
      run("mac-2", "2026-10-05T09:00:00.000Z", macReduced, ["Missing"], "mac-os 3.0.0 Level 1"),
      run("mac-3", "2026-10-06T09:00:00.000Z", mac, [...Array(28).fill("Present"), "Missing"], "mac-os 3.0.0 Level 1"),
    ]
    const points = cisReadinessTrend(history, undefined, undefined, "2026-10-16")
    const change = (runId: string) => trendChangeText(points.find(point => point.runId === runId)!.levels[0]!)
    // An Edge run between two Windows runs no longer hides the Windows change.
    expect(change("win-2")).toBe("+50.0 pp")
    expect(change("edge-1")).toBe("First assessment")
    expect(change("mac-1")).toBe("First assessment")
    // The -96.6 and +96.6 swings came from comparing different packs.
    expect(formatRate(trendRate(points.find(point => point.runId === "mac-1")!.levels[0]!))).toBe("96.6%")
    expect(change("mac-2")).toBe("Pack changed, not compared")
    expect(change("mac-3")).toBe("Pack changed, not compared")
    expect(points.find(point => point.runId === "mac-3")!.levels[0]!.changeFromPrevious).toBeNull()
    // The table groups by benchmark, the most recently assessed first, each newest first.
    const groups = trendGroups(points)
    expect(groups.map(group => group.benchmark)).toEqual(["mac-os", "windows-os", "edge-browser"])
    expect(groups.map(group => group.points.map(point => point.runId))).toEqual([["mac-3", "mac-2", "mac-1"], ["win-2", "win-1"], ["edge-1"]])
  })

  it("compares the same pack whether or not its catalog display name was stamped", () => {
    const named = windows.map(policy => ({ ...policy, provenance: { ...policy.provenance, benchmarkName: "Windows display name" } }))
    const points = cisReadinessTrend([
      run("win-1", "2026-10-01T09:00:00.000Z", windows, ["Present", "Present"], "windows-os 5.0.0 Level 1"),
      run("win-2", "2026-10-02T09:00:00.000Z", named, ["Present", "Missing"], "windows-os 5.0.0 Level 1"),
    ], undefined, undefined, "2026-10-16")
    expect(trendChangeText(points[1]!.levels[0]!)).toBe("-50.0 pp")
  })

  it("does not raise drift on a Level switch or a pack change, only on a decline of the same pack", () => {
    const levelSwitch = cisReadinessTrend([
      run("mac-1", "2026-10-01T09:00:00.000Z", mac, Array(29).fill("Present"), "mac-os 3.0.0 Level 1"),
      run("mac-l2", "2026-10-02T09:00:00.000Z", macL2, ["Missing"], "mac-os 3.0.0 Level 2"),
    ], undefined, undefined, "2026-10-16")
    expect(levelSwitch.find(point => point.runId === "mac-l2")!.levels[0]!.comparison).toBe("first")
    expect(cisDriftSignals(levelSwitch)).toEqual([])
    const packChange = cisReadinessTrend([
      run("mac-1", "2026-10-01T09:00:00.000Z", mac, Array(29).fill("Present"), "mac-os 3.0.0 Level 1"),
      run("mac-2", "2026-10-02T09:00:00.000Z", macReduced, ["Missing"], "mac-os 3.0.0 Level 1"),
    ], undefined, undefined, "2026-10-16")
    expect(cisDriftSignals(packChange)).toEqual([])
    // The same pack declining does raise drift, even with another benchmark assessed after it.
    const decline = cisReadinessTrend([
      run("win-1", "2026-10-01T09:00:00.000Z", windows, ["Present", "Present"], "windows-os 5.0.0 Level 1"),
      run("win-2", "2026-10-02T09:00:00.000Z", windows, ["Present", "Missing"], "windows-os 5.0.0 Level 1"),
      run("edge-1", "2026-10-03T09:00:00.000Z", edge, ["Present"], "edge-browser 2.0.0 Level 1"),
    ], undefined, undefined, "2026-10-16")
    expect(cisDriftSignals(decline)).toMatchObject([{ benchmark: "windows-os", level: 1, previousRate: 1, currentRate: 0.5, kind: "below-bar" }])
  })

  it("compares a Level with the previous run that measured it when a recommendation list names other Levels", () => {
    const windowsL2 = pack("windows-os", "5.0.0", 2, ["win_l2"])
    const list = { benchmark: "windows-os", version: "5.0.0", items: [{ identifier: "1.1", level: 1 as const, automated: true }, { identifier: "2.1", level: 2 as const, automated: true }] }
    const excluded: CisException = { id: "exc-l2", benchmark: "windows-os", version: "5.0.0", level: 2, policyName: windowsL2[0]!.name, settingId: "win_l2", owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", createdAt: "2026-10-01T12:00:00.000Z" }
    const points = cisReadinessTrend([
      run("win-1", "2026-10-01T09:00:00.000Z", windows, ["Present", "Present"], "windows-os 5.0.0 Level 1"),
      run("win-l2", "2026-10-02T09:00:00.000Z", windowsL2, ["Missing"], "windows-os 5.0.0 Level 2"),
      run("win-2", "2026-10-03T09:00:00.000Z", windows, ["Missing", "Missing"], "windows-os 5.0.0 Level 1"),
    ], list, [excluded], "2026-10-16")
    const level1 = points.find(point => point.runId === "win-2")!.levels.find(level => level.level === 1)!
    expect(level1).toMatchObject({ comparison: "compared", previousRunId: "win-1" })
    expect(cisDriftSignals(points)).toMatchObject([{ benchmark: "windows-os", level: 1, previousRate: 1, currentRate: 0, kind: "below-bar" }])
    // The Level 2 exclusion is used by the Level 2 run, not dropped for the Level 1 run listing Level 2.
    expect(exclusionUse(points).get("exc-l2")).toEqual([{ benchmark: "windows-os", benchmarkName: null, version: "5.0.0", level: 2 }])
  })

  it("keeps drift in the Health review on raw rates, so exclusions neither raise nor hide it", () => {
    const seed = (exceptions: CisException[]) => {
      const workspace = loadWorkspace(tenantId, "cis-benchmarks")
      workspace.history = [
        run("mac-l2", "2026-10-03T09:00:00.000Z", macL2, ["Missing"], "mac-os 3.0.0 Level 2"),
        run("win-2", "2026-10-02T09:00:00.000Z", windows, ["Present", "Missing"], "windows-os 5.0.0 Level 1"),
        run("win-1", "2026-10-01T09:00:00.000Z", windows, ["Present", "Present"], "windows-os 5.0.0 Level 1"),
      ]
      workspace.exceptions = exceptions
      saveWorkspace(workspace)
      return cisSignals(tenantId).map(signal => signal.key)
    }
    expect(seed([])).toEqual(["cis-readiness:1:windows-os:5-0-0"])
    const excluded: CisException = { id: "exc-win", benchmark: "windows-os", version: "5.0.0", level: 1, policyName: windows[1]!.name, settingId: "win_b", owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", createdAt: "2026-10-02T12:00:00.000Z" }
    expect(seed([excluded])).toEqual(["cis-readiness:1:windows-os:5-0-0"])
  })
})

describe("stored exceptions and selections", () => {
  const policies = pack("synthetic-os", "9.9.9", 1, ["synthetic_alpha", "synthetic_beta", "synthetic_gamma", "synthetic_delta"])
  const base = { benchmark: "synthetic-os", version: "9.9.9", level: 1 as const, owner: "Owner", reason: "Accepted", createdAt: "2026-10-01T12:00:00.000Z" }
  const entry = run("run-1", "2026-10-10T12:00:00.000Z", policies, ["Missing", "Present", "Different", "Review"])
  const exceptions: CisException[] = [
    { ...base, id: "in-use", policyName: policies[0]!.name, settingId: "synthetic_alpha", expiresOn: "2099-01-01" },
    { ...base, id: "fixed", policyName: policies[1]!.name, settingId: "synthetic_beta", expiresOn: "2099-01-01" },
    { ...base, id: "expired", policyName: policies[2]!.name, settingId: "synthetic_gamma", expiresOn: "2026-10-05" },
    { ...base, id: "removed", policyName: "Old policy", settingId: "synthetic_old", expiresOn: "2099-01-01" },
    { ...base, id: "other-version", version: "8.0.0", policyName: policies[0]!.name, settingId: "synthetic_alpha", expiresOn: "2099-01-01" },
    { ...base, id: "other-benchmark", benchmark: "other-os", policyName: policies[0]!.name, settingId: "synthetic_alpha", expiresOn: "2099-01-01" },
  ]

  it("lists every stored exception of the workspace by benchmark, tags the ones not in use and counts like the stat", () => {
    const summary = readinessFor(entry, { history: [entry], exceptions }, "2026-10-16")
    const listed = listedExceptions(summary, entry.assessment, entry.policies, exceptions, "2026-10-16")
    // The assessed benchmark first; a benchmark with no saved assessment left still lists its exceptions, removable.
    expect(listed.map(group => [group.benchmark, group.current, group.levels.map(level => level.level)])).toEqual([["synthetic-os", true, [1]], ["other-os", false, [1]]])
    expect(listed[1]!.levels[0]!.items.map(item => [item.exception.id, item.note])).toEqual([["other-benchmark", "Not used by this assessment"]])
    expect(listed[0]!.levels[0]!.items.map(item => [item.exception.id, item.note])).toEqual([
      ["in-use", null],
      ["fixed", "Not in use: setting currently present"],
      ["expired", "Expired"],
      ["removed", "Not in use: setting not in this assessment"],
      ["other-version", "Not in use: version 8.0.0"],
    ])
    // "Excluded from score" counts exclusions in use, the same number as the stat and the "with N exclusions" text.
    const head = levelHeadline(summary.levels[0]!)
    expect(head.exclusions).toBe(listed[0]!.levels[0]!.items.filter(item => item.state === "in-use").length)
    expect(exclusionsText(head)).toBe("50% with 1 exclusion")
    // The Excluded badge marks exactly the covered finding.
    expect([...excludedFindingKeys(summary, entry.assessment, entry.policies)]).toEqual(["0:0"])
    // Viewing an older run names exceptions added after it.
    const later = run("run-2", "2026-10-15T12:00:00.000Z", policies, ["Missing", "Present", "Different", "Review"])
    const olderView = readinessFor(entry, { history: [later, entry], exceptions: [{ ...exceptions[0]!, createdAt: "2026-10-12T12:00:00.000Z" }] }, "2026-10-16")
    expect(listedExceptions(olderView, entry.assessment, entry.policies, [{ ...exceptions[0]!, createdAt: "2026-10-12T12:00:00.000Z" }], "2026-10-16")[0]!.levels[0]!.items[0]!.note).toBe("Not in use: added after this assessment")
  })

  it("does not show a moved rate on the recommendation basis when no recommendation is fully excluded", () => {
    // Recommendation 1.1 names two missing settings; 1.2 names one present setting.
    const both = attachRecommendations(pack("rec-os", "1.0.0", 1, ["rec_a", "rec_b", "rec_c"]), [{ id: "1.1", title: "Two settings", level: 1, settings: ["rec_a", "rec_b"] }, { id: "1.2", title: "Other", level: 1, settings: ["rec_c"] }])
    const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "rec-os 1.0.0 Level 1", policies: both, current: [tenantPolicy("c", "rec_c", assigned)], runId: "rec-1", assessedAt: "2026-10-10T12:00:00.000Z" })
    const entry = { assessment, policies: both }
    const one: CisException = { ...base, benchmark: "rec-os", version: "1.0.0", id: "rec-one", policyName: both[0]!.name, settingId: "rec_a", expiresOn: "2099-01-01" }
    const partial = levelHeadline(readinessFor(entry, { history: [entry], exceptions: [one] }, "2026-10-16").levels[0]!)
    expect(partial).toMatchObject({ basis: "recommendations", rate: 0.5, adjusted: 0.5, exclusions: 1 })
    expect(exclusionsText(partial)).toBe("1 exclusion, no recommendation fully excluded")
    const full = levelHeadline(readinessFor(entry, { history: [entry], exceptions: [one, { ...one, id: "rec-two", policyName: both[1]!.name, settingId: "rec_b" }] }, "2026-10-16").levels[0]!)
    expect(exclusionsText(full)).toBe("100% with 2 exclusions")
  })

  it("applies an exception through its expiry date and from its local creation date", () => {
    expect(appliesOn(exceptions[2]!, "2026-10-05")).toBe(true)
    expect(appliesOn(exceptions[2]!, "2026-10-06")).toBe(false)
    expect(appliesOn({ ...exceptions[0]!, createdAt: "2026-10-12T12:00:00.000Z" }, "2026-10-11")).toBe(false)
    expect(localDate("2026-10-12")).toBe("2026-10-12")
    const noon = new Date(2026, 9, 12, 12, 0, 0)
    expect(localDate(noon)).toBe("2026-10-12")
    expect(localDate(noon.toISOString())).toBe("2026-10-12")
  })

  it("uses one definition of selectable findings for the checkbox, Select all deviating and Plan remediation", () => {
    const findings = entry.assessment.findings
    const selectable = findings.filter(isSelectableFinding).map(finding => finding.key)
    expect(selectable).toEqual(["0:0", "2:0"])
    expect(deviatingFindingKeys(findings)).toEqual(selectable)
    // Select all deviating, then the count Plan remediation acts on is the selected count.
    const selected = new Set(deviatingFindingKeys(findings))
    expect(selectedDeviatingFindings(findings, selected).map(finding => finding.key)).toEqual([...selected])
    // A Review finding can never be selected, so it never inflates "N selected".
    expect(isSelectableFinding({ status: "Review" })).toBe(false)
    expect(isSelectableFinding({ status: "Present" })).toBe(false)
    expect(selectedDeviatingFindings(findings, new Set(["3:0", "1:0"]))).toEqual([])
  })
})

describe("CIS portfolio on one benchmark", () => {
  it("includes the selected tenant when its plan includes CIS, and keeps the MSP rule for the others", () => {
    const plans: Record<string, "community" | "pro" | "msp" | null> = { own: "pro", customer: "msp", other: "pro", free: "community" }
    const members = portfolioMembers(["own", "customer", "other", "free"], id => plans[id] ?? null, "OWN")
    expect(members).toEqual({ included: ["own", "customer"], notIncluded: ["other", "free"], plan: "msp" })
    // A selected Community tenant is not added, and without an MSP tenant the portfolio stays gated by the selected plan.
    expect(portfolioMembers(["free", "other"], id => plans[id] ?? null, "free")).toEqual({ included: [], notIncluded: ["free", "other"], plan: "community" })
    expect(portfolioMembers(["own"], id => plans[id] ?? null, "own")).toEqual({ included: ["own"], notIncluded: [], plan: "pro" })
  })

  it("includes the selected tenant's own result next to customer tenants", () => {
    const windows = pack("windows-os", "5.0.0", 1, ["win_a", "win_b"])
    const edge = pack("edge-browser", "2.0.0", 1, ["edge_a"])
    const own = "33333333-3333-3333-3333-333333333333"
    const asTenant = (item: CisReadinessEntry, id: string): CisReadinessEntry => ({ ...item, assessment: { ...item.assessment, tenantId: id } as Assessment })
    const rows = cisPortfolioRows([
      { tenantId: own, tenantName: "Own Pro tenant", workspace: { history: [asTenant(run("own-edge", "2026-10-12T09:00:00.000Z", edge, ["Present"]), own), asTenant(run("own-win", "2026-10-11T09:00:00.000Z", windows, ["Present", "Missing"]), own)] } },
      { tenantId, tenantName: "Customer", workspace: { history: [run("cust-win", "2026-10-10T09:00:00.000Z", windows, ["Present", "Present"])] } },
    ], undefined, "2026-10-16")
    // Windows is the benchmark both tenants assessed; the Pro tenant's newer Edge run does not replace its Windows row.
    expect(rows.map(row => [row.tenantName, row.benchmark, formatRate(row.levels[0]?.headline.rate ?? null)])).toEqual([["Customer", "windows-os", "100%"], ["Own Pro tenant", "windows-os", "50%"]])
  })
})

describe("review round 1 regressions", () => {
  it("counts exclusions of a Level 1 recommendation whose setting a Level 2 policy carries", () => {
    const level1 = pack("split-os", "1.0.0", 1, ["split_a"])
    const level2 = pack("split-os", "1.0.0", 2, ["split_x"])
    const policies = attachRecommendations([...level1, ...level2], [{ id: "1.1", title: "Carried by Level 2", level: 1, settings: ["split_x"] }, { id: "1.2", title: "Own", level: 1, settings: ["split_a"] }])
    const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "split-os 1.0.0", policies, current: [tenantPolicy("a", "split_a", assigned)], runId: "split-1", assessedAt: "2026-10-10T12:00:00.000Z" })
    const exception: CisException = { id: "split-x", benchmark: "split-os", version: "1.0.0", level: 2, policyName: level2[0]!.name, settingId: "split_x", owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", createdAt: "2026-10-01T12:00:00.000Z" }
    const entry = { assessment, policies }
    const summary = readinessFor(entry, { history: [entry], exceptions: [exception] }, "2026-10-16")
    const head = levelHeadline(summary.levels.find(level => level.level === 1)!)
    expect(head).toMatchObject({ basis: "recommendations", rate: 0.5, adjusted: 1, exclusions: 1 })
    expect(exclusionsText(head)).toBe("100% with 1 exclusion")
    const listed = listedExceptions(summary, assessment, policies, [exception], "2026-10-16")
    expect(listed[0]!.levels.find(level => level.level === 2)!.items[0]!.state).toBe("in-use")
    expect([...excludedFindingKeys(summary, assessment, policies)]).toEqual([assessment.findings.find(finding => finding.settingId === "split_x")!.key])
  })

  it("compares a pack whose settings only differ in object key order", () => {
    const windows = pack("windows-os", "5.0.0", 1, ["win_a", "win_b"])
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reorder(inner)])) : value
    const reordered = windows.map(policy => ({ ...policy, settings: reorder(policy.settings) as BaselinePolicy["settings"] }))
    expect(JSON.stringify(reordered[0]!.settings)).not.toBe(JSON.stringify(windows[0]!.settings))
    const points = cisReadinessTrend([
      run("win-1", "2026-10-01T09:00:00.000Z", windows, ["Present", "Present"], "windows-os 5.0.0 Level 1"),
      run("win-2", "2026-10-02T09:00:00.000Z", reordered, ["Present", "Missing"], "windows-os 5.0.0 Level 1"),
    ], undefined, undefined, "2026-10-16")
    expect(trendChangeText(points[1]!.levels[0]!)).toBe("-50.0 pp")
    expect(cisDriftSignals(points)).toHaveLength(1)
  })

  it("picks the same newest run on tied timestamps in every view, whatever the storage order", () => {
    const windows = pack("windows-os", "5.0.0", 1, ["win_a", "win_b"])
    const a = run("run-a", "2026-10-10T09:00:00.000Z", windows, ["Present", "Present"], "windows-os 5.0.0 Level 1")
    const b = run("run-b", "2026-10-10T09:00:00.000Z", windows, ["Present", "Missing"], "windows-os 5.0.0 Level 1")
    for (const history of [[a, b], [b, a]]) {
      const workspace = { history }
      expect(compareAssessments(a, b)).toBeLessThan(0)
      expect(exclusionsAsOf(b, workspace, 1, "2026-10-16")).toBe("2026-10-16")
      expect(exclusionsAsOf(a, workspace, 1, "2026-10-16")).toBe(localDate(a.assessment.assessedAt))
      const points = cisReadinessTrend(history, undefined, undefined, "2026-10-16")
      const newest = points[points.length - 1]!
      expect(newest.runId).toBe("run-b")
      expect(cisScoreCards(true, workspace, tenantId, "2026-10-16")[0]!.runId).toBe("run-b")
      expect(cisPortfolioRows([{ tenantId, tenantName: "Contoso", workspace }], undefined, "2026-10-16")[0]!.levels[0]!.headline.rate).toBe(trendRate(newest.levels[0]!))
    }
  })

  it("accepts an exception expiring today and refuses one that expired yesterday", async () => {
    const policies = pack("synthetic-os", "9.9.9", 1, ["synthetic_alpha"])
    recordAssessment(assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", policies, current: [], runId: "run-expiry", assessedAt: "2026-10-10T12:00:00.000Z" }), policies)
    const today = new Date()
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12)
    const input = { action: "workspace-cis-exception-add", tenantId, frameworkId: "cis-benchmarks", benchmark: "synthetic-os", version: "9.9.9", level: 1, policyName: policies[0]!.name, settingId: "synthetic_alpha", owner: "Owner", reason: "Accepted" }
    await expect(handleFramework({ ...input, expiresOn: localDate(yesterday) })).rejects.toMatchObject({ status: 400, message: "Provide an expiry date of today or later." })
    const saved = await handleFramework({ ...input, expiresOn: localDate(today) }) as { exceptions?: CisException[] }
    expect(saved.exceptions?.map(exception => exception.expiresOn)).toEqual([localDate(today)])
  })
})

describe("review round 2: one source for the exclusions that count", () => {
  // Level 1 is scored by recommendations: 1.1 names split_x, which a Level 2 policy carries; 1.2 names split_a.
  // Level 2 is scored by settings. split_b is a Level 1 setting outside every recommendation.
  const level1 = pack("split-os", "1.0.0", 1, ["split_a", "split_b"])
  const level2 = pack("split-os", "1.0.0", 2, ["split_x", "split_y"])
  const policies = attachRecommendations([...level1, ...level2], [{ id: "1.1", title: "Carried by Level 2", level: 1, settings: ["split_x"] }, { id: "1.2", title: "Own", level: 1, settings: ["split_a"] }])
  const current = [tenantPolicy("a", "split_a", assigned), tenantPolicy("y", "split_y", assigned)]
  const exception = (id: string, policy: BaselinePolicy, settingId: string, createdAt = "2026-10-01T12:00:00.000Z"): CisException => ({ id, benchmark: "split-os", version: "1.0.0", level: policy.provenance?.level === "Level 2" ? 2 : 1, policyName: policy.name, settingId, owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", createdAt })

  it("shows the same exclusions in every view for a recommendation whose setting a Level 2 policy carries", () => {
    const today = "2026-10-16"
    const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "split-os 1.0.0", policies, current, runId: "split-1", assessedAt: "2026-10-10T12:00:00.000Z" })
    const workspace = { history: [{ assessment, policies }], exceptions: [exception("ex-x", level2[0]!, "split_x"), exception("ex-b", level1[1]!, "split_b")] }
    const summary = readinessFor(workspace.history[0]!, workspace, today)
    const [one, two] = summary.levels.map(levelHeadline)
    // The one result: per Level, on its basis, with ids and their own policy Level.
    expect(summary.levels.map(level => [level.level, level.exceptions.map(item => [item.id, item.level])])).toEqual([[1, [["ex-x", 2]]], [2, [["ex-x", 2]]]])
    expect([one!.basis, exclusionsText(one!)]).toEqual(["recommendations", "100% with 1 exclusion"])
    expect([two!.basis, exclusionsText(two!)]).toEqual(["settings", "100% with 1 exclusion"])
    // Aggregates count the shared exclusion once.
    expect(distinctExclusions([one!, two!])).toBe(1)
    // Badge: only the counted finding; the setting outside every recommendation is tagged, not badged.
    const keyOf = (settingId: string) => assessment.findings.find(finding => finding.settingId === settingId)!.key
    expect([...excludedFindingKeys(summary, assessment, policies)]).toEqual([keyOf("split_x")])
    const items = listedExceptions(summary, assessment, policies, workspace.exceptions, today)[0]!.levels.flatMap(level => level.items)
    expect(items.map(item => [item.exception.id, item.state, item.usedHere])).toEqual([["ex-b", "unscored", []], ["ex-x", "in-use", [1, 2]]])
    // Trend, portfolio and Governance card read the same result.
    const point = cisReadinessTrend(workspace.history, undefined, workspace.exceptions, today)[0]!
    expect(point.levels.map(level => [trendExclusionsText(level), level.exclusionIds])).toEqual([["100% with 1 exclusion", ["ex-x"]], ["100% with 1 exclusion", ["ex-x"]]])
    const row = cisPortfolioRows([{ tenantId, tenantName: "Contoso", workspace }], undefined, today)[0]!
    expect(row.levels.map(level => exclusionsText(level.headline))).toEqual(["100% with 1 exclusion", "100% with 1 exclusion"])
    expect(distinctExclusions(row.levels.map(level => level.headline))).toBe(1)
    expect(cisScoreCards(true, workspace, tenantId, today)[0]!.levels.map(level => level.withExclusions)).toEqual(["100% with 1 exclusion", "100% with 1 exclusion"])
    // Exports list the counted exception under the Level it counts for.
    const json = JSON.parse(cisReadinessJson(summary, "Contoso", "2026-10-16T10:00:00Z")).levels as Array<{ exclusions: number; exceptions: Array<{ settingId: string }> }>
    expect(json.map(level => [level.exclusions, level.exceptions.map(item => item.settingId)])).toEqual([[1, ["split_x"]], [1, ["split_x"]]])
    expect(cisReadinessCsv(summary).split("\r\n")[1]).toContain("Recommendation pass rate,50,100,1,")
    // The PDF lists the counted exception under both Levels it counts for.
    const text = pdfText(generateCisReadinessPDF(summary, { exportedAt: "2026-10-16T10:00:00.000Z", tenantName: "Contoso", tenantId, assessedAt: assessment.assessedAt, runId: "split-1" }))
    expect(text).toContain("Accepted exceptions, Level 1")
    expect(text).toContain("Accepted exceptions, Level 2")
    expect(text.match(/With exclusions 100% with 1 exclusion/g)).toHaveLength(2)
  })

  it("judges an exclusion on the date of the headline it affects", () => {
    const combined = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "split-os 1.0.0", policies, current, runId: "split-old", assessedAt: "2026-10-01T12:00:00.000Z" })
    const onlyLevel1 = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "split-os 1.0.0 Level 1", policies: policies.slice(0, 2), current, runId: "split-l1", assessedAt: "2026-10-10T12:00:00.000Z" })
    const workspace = { history: [{ assessment: onlyLevel1, policies: policies.slice(0, 2) }, { assessment: combined, policies }], exceptions: [exception("ex-x", level2[0]!, "split_x", "2026-10-02T12:00:00.000Z")] }
    const older = readinessFor(workspace.history[1]!, workspace, "2026-10-16")
    // Level 1 of the older run is dated Oct 1, before the exclusion; Level 2 is still its newest run and counts it today.
    expect(older.levels.map(level => [level.level, level.exclusionsAsOf, levelHeadline(level).exclusions])).toEqual([[1, localDate(combined.assessedAt), 0], [2, "2026-10-16", 1]])
  })

  it("names the current headline of another benchmark that counts an exclusion", () => {
    const other = pack("other-os", "2.0.0", 1, ["other_a"])
    const otherRun = run("other-1", "2026-10-11T12:00:00.000Z", other, ["Missing"], "other-os 2.0.0 Level 1")
    const shown = run("shown-1", "2026-10-12T12:00:00.000Z", level1, ["Missing", "Missing"], "split-os 1.0.0 Level 1")
    const otherException: CisException = { id: "ex-other", benchmark: "other-os", version: "2.0.0", level: 1, policyName: other[0]!.name, settingId: "other_a", owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", createdAt: "2026-10-01T12:00:00.000Z" }
    const workspace = { history: [shown, otherRun], exceptions: [otherException] }
    const uses = exclusionUse(cisReadinessTrend(workspace.history, undefined, workspace.exceptions, "2026-10-16"))
    expect(uses.get("ex-other")).toEqual([{ benchmark: "other-os", benchmarkName: null, version: "2.0.0", level: 1 }])
    const summary = readinessFor(shown, workspace, "2026-10-16")
    const item = listedExceptions(summary, shown.assessment, shown.policies, workspace.exceptions, "2026-10-16", new Map([["ex-other", ["Other OS 2.0.0 Level 1"]]]))[1]!.levels[0]!.items[0]!
    expect(item).toMatchObject({ state: "benchmark", note: "Not used by this assessment. Used by Other OS 2.0.0 Level 1", usedElsewhere: ["Other OS 2.0.0 Level 1"] })
  })
})

describe("review round 3: exclusions follow the headline they affect", () => {
  const today = "2026-10-16"
  const choiceChild = (id: string, value: string) => ({ "@odata.type": choice, settingDefinitionId: id, choiceSettingValue: { value: `${id}_${value}`, children: [] } })
  const groupRoot = (a: string, b: string) => ({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance", settingDefinitionId: "grp_root", groupSettingCollectionValue: [{ children: [choiceChild("grp_root_a", a), choiceChild("grp_root_b", b)] }] })

  it("does not count an exclusion toward a Level whose recommendation names only the passing leaf of a shared root", () => {
    // One root holds a Level 1 leaf that passes and a Level 2 sibling that fails.
    const shared: BaselinePolicy = { name: "shared-os grp", platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark: "shared-os", version: "1.0.0", level: "Level 1", sourceFile: "grp.json" }, settings: [{ settingInstance: groupRoot("on", "on") }] }
    const policies = attachRecommendations([shared], [{ id: "1.1", title: "Leaf A", level: 1, settings: ["grp_root_a"] }, { id: "2.1", title: "Leaf B", level: 2, settings: ["grp_root_b"] }])
    const current: LandscapePolicy[] = [{ id: "t", name: "Tenant t", platforms: "windows10", technologies: "mdm", description: "", settings: [{ settingInstance: groupRoot("on", "off") }], targeting: assigned }]
    const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "shared-os 1.0.0", policies, current, runId: "grp-1", assessedAt: "2026-10-10T12:00:00.000Z" })
    expect(assessment.findings[0]!.status).toBe("Different")
    const exception: CisException = { id: "ex-grp", benchmark: "shared-os", version: "1.0.0", level: 1, policyName: shared.name, settingId: "grp_root", owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", createdAt: "2026-10-01T12:00:00.000Z" }
    const workspace = { history: [{ assessment, policies }], exceptions: [exception] }
    const summary = readinessFor(workspace.history[0]!, workspace, today)
    const [one, two] = summary.levels.map(levelHeadline)
    expect(summary.levels[0]!.recommendations.map(result => result.result)).toEqual(["Pass"])
    expect([one!.rate, one!.exclusions, exclusionsText(one!)]).toEqual([1, 0, null])
    expect([two!.rate, two!.exclusions, exclusionsText(two!)]).toEqual([0, 1, "100% with 1 exclusion"])
    // Every view reads the same: listed, trend and Governance card.
    expect(listedExceptions(summary, assessment, policies, workspace.exceptions, today)[0]!.levels.flatMap(level => level.items).map(item => [item.state, item.usedHere])).toEqual([["in-use", [2]]])
    expect(cisReadinessTrend(workspace.history, undefined, workspace.exceptions, today)[0]!.levels.map(level => level.exclusionIds)).toEqual([[], ["ex-grp"]])
    expect(cisScoreCards(true, workspace, tenantId, today)[0]!.levels.map(level => level.withExclusions)).toEqual([null, "100% with 1 exclusion"])
  })

  // Level 1 and Level 2 are both scored by recommendations: 1.1 names split_x, carried by a Level 2 policy; 2.1 names split_y.
  const level1 = pack("split-os", "1.0.0", 1, ["split_a"])
  const level2 = pack("split-os", "1.0.0", 2, ["split_x", "split_y"])
  const policies = attachRecommendations([...level1, ...level2], [{ id: "1.1", title: "Carried by Level 2", level: 1, settings: ["split_x"] }, { id: "1.2", title: "Own", level: 1, settings: ["split_a"] }, { id: "2.1", title: "Level 2 own", level: 2, settings: ["split_y"] }])
  const current = [tenantPolicy("a", "split_a", assigned), tenantPolicy("y", "split_y", assigned)]
  const exX = (createdAt: string): CisException => ({ id: "ex-x", benchmark: "split-os", version: "1.0.0", level: 2, policyName: level2[0]!.name, settingId: "split_x", owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", createdAt })

  it("lists a Level 2 exclusion that only a Level 1 recommendation counts under Level 1, noting its policy Level", () => {
    const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "split-os 1.0.0", policies, current, runId: "split-3", assessedAt: "2026-10-10T12:00:00.000Z" })
    const workspace = { history: [{ assessment, policies }], exceptions: [exX("2026-10-01T12:00:00.000Z")] }
    const summary = readinessFor(workspace.history[0]!, workspace, today)
    expect(summary.levels.map(level => levelHeadline(level).exclusions)).toEqual([1, 0])
    const group = listedExceptions(summary, assessment, policies, workspace.exceptions, today)[0]!
    // Grouped by policy Level the Level 1 headline would count 1 and list nothing.
    expect(group.levels.map(level => [level.level, level.items.length])).toEqual([[1, 0], [2, 1]])
    const byHeadline = exceptionsByHeadline(group)
    expect(byHeadline.map(level => [level.level, level.items.map(item => [item.exception.id, item.exception.level, item.state])])).toEqual([[1, [["ex-x", 2, "in-use"]]], [2, []]])
    // Each headline lists exactly the exclusions it counts.
    for (const level of summary.levels) expect(byHeadline.find(entry => entry.level === level.level)!.items.filter(item => item.state === "in-use").length).toBe(levelHeadline(level).exclusions)
  })

  it("explains an unused exclusion by the date of the headline that would count it", () => {
    const combined = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "split-os 1.0.0", policies, current, runId: "split-old", assessedAt: "2026-10-01T12:00:00.000Z" })
    const onlyLevel1 = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "split-os 1.0.0 Level 1", policies: policies.slice(0, 1), current, runId: "split-l1", assessedAt: "2026-10-10T12:00:00.000Z" })
    // Created after the older run: its Level 1 headline is dated the run day, its Level 2 headline today.
    const workspace = { history: [{ assessment: onlyLevel1, policies: policies.slice(0, 1) }, { assessment: combined, policies }], exceptions: [exX("2026-10-05T12:00:00.000Z")] }
    const older = readinessFor(workspace.history[1]!, workspace, today)
    expect(older.levels.map(level => [level.level, level.exclusionsAsOf, levelHeadline(level).exclusions])).toEqual([[1, localDate(combined.assessedAt), 0], [2, today, 0]])
    const item = listedExceptions(older, combined, policies, workspace.exceptions, today)[0]!.levels.flatMap(level => level.items)[0]!
    expect([item.state, item.note]).toEqual(["later", "Not in use: added after this assessment"])
  })
})
