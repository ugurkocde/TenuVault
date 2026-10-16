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
import { cisPortfolioRows, portfolioMembers } from "../src/shared/frameworks/cis-portfolio"
import { excludedFindingKeys, exclusionsAsOf, exclusionsText, formatRate, levelHeadline, listedExceptions, readinessFor, unassignedText, type CisReadinessEntry } from "../src/shared/frameworks/cis-readiness"
import { cisDriftSignals, cisReadinessTrend, trendChangeText, trendExclusionsText, trendGroups, trendRate } from "../src/shared/frameworks/cis-trend"
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
    expect(listed.flatMap(group => group.items).filter(item => item.state === "in-use")).toHaveLength(head.exclusions)

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

  it("lists every stored exception of the benchmark, tags the ones not in use and counts like the stat", () => {
    const summary = readinessFor(entry, { history: [entry], exceptions }, "2026-10-16")
    const listed = listedExceptions(summary, entry.assessment, entry.policies, exceptions, "2026-10-16")
    expect(listed.map(group => group.level)).toEqual([1])
    expect(listed[0]!.items.map(item => [item.exception.id, item.note])).toEqual([
      ["in-use", null],
      ["fixed", "Not in use: setting currently present"],
      ["expired", "Expired"],
      ["removed", "Not in use: setting not in this assessment"],
      ["other-version", "Not in use: version 8.0.0"],
    ])
    // "Excluded from score" counts exclusions in use, the same number as the stat and the "with N exclusions" text.
    const head = levelHeadline(summary.levels[0]!)
    expect(head.exclusions).toBe(listed[0]!.items.filter(item => item.state === "in-use").length)
    expect(exclusionsText(head)).toBe("50% with 1 exclusion")
    // The Excluded badge marks exactly the covered finding.
    expect([...excludedFindingKeys(summary, entry.assessment, entry.policies)]).toEqual(["0:0"])
    // Viewing an older run names exceptions added after it.
    const later = run("run-2", "2026-10-15T12:00:00.000Z", policies, ["Missing", "Present", "Different", "Review"])
    const olderView = readinessFor(entry, { history: [later, entry], exceptions: [{ ...exceptions[0]!, createdAt: "2026-10-12T12:00:00.000Z" }] }, "2026-10-16")
    expect(listedExceptions(olderView, entry.assessment, entry.policies, [{ ...exceptions[0]!, createdAt: "2026-10-12T12:00:00.000Z" }], "2026-10-16")[0]!.items[0]!.note).toBe("Not in use: added after this assessment")
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
