import { describe, expect, it } from "vitest"
import { capabilityComparison, comparisonCounts, type NativeAssessment } from "../src/shared/compliance/native"
import { capabilityVerdict, collectionReadGaps, countedItems } from "../src/shared/compliance/counted"
import type { CollectionCoverage, TechnicalCheck } from "../src/shared/compliance/types"
import { routes } from "../src/main/features/scores"
import { countedGaps, partialCollection } from "../src/main/features/scores/gaps"
import { frameworkDetail, frameworkScore, latestScore } from "../src/main/features/scores/view"
import { groupCounted } from "../src/renderer/features/scores/ScoreDetail"
import { scoresCsv } from "../src/renderer/features/shared/governance-export"
import { call, fakeDeps, TENANT_A } from "./feature-helpers"
import { fakeFrameworksApi, makeRun } from "./feature-scores-fixtures"

const NOW = new Date("2026-09-30T12:00:00Z")

function assign(check: TechnicalCheck, state: "assigned" | "notAssigned" | "unknown"): TechnicalCheck {
  return { ...check, assignment: { state, targets: [], exclusions: [], filters: [], coverage: "unverified" } }
}

/**
 * An ISO-like comparison: capabilities matched on assigned policies, configured only in
 * unassigned policies (matching and different), mixed evidence, unknown assignment, a
 * framework reference without a detector and a capability outside the scope.
 */
function isoLike(): NativeAssessment {
  const run = makeRun({
    runId: "iso", tenantId: TENANT_A, frameworkId: "iso-27001",
    caps: {
      assignedMatch: ["matches"],
      assignedDifferent: ["different"],
      assignedMissing: ["missing"],
      unassignedMatch: ["matches"],
      unassignedDifferent: ["different"],
      mixed: ["matches", "different"],
      unknownAssignment: ["matches"],
      unreadable: ["unknown"],
      outside: ["outside"],
    },
  })
  const cap = (id: string) => run.assessment.capabilities.find((item) => item.capability.id === id)!
  cap("unassignedMatch").checks = cap("unassignedMatch").checks.map((check) => assign(check, "notAssigned"))
  cap("unassignedDifferent").checks = cap("unassignedDifferent").checks.map((check) => assign(check, "notAssigned"))
  cap("unknownAssignment").checks = cap("unknownAssignment").checks.map((check) => assign(check, "unknown"))
  run.assessment.frameworks[0]!.controls.push({
    control: { id: "A.5.1", title: "Policies for information security", summary: "", evidenceStrength: "direct" },
    capabilityIds: [], enforcedCapabilityIds: [], excludedCapabilityIds: [], status: "notAssessed", unassessedAspects: [],
    unavailableCheck: { assessmentStatus: "unableToCheck", result: null, settingId: "A.5.1", expectedValue: "", actualValue: null, reason: "No configuration check exists for this requirement." },
  })
  return run
}

describe("counted capabilities and gaps", () => {
  it("explains every capability with the result capabilityComparison counts", () => {
    const run = isoLike()
    for (const result of run.assessment.capabilities) expect(capabilityVerdict(result).result).toBe(capabilityComparison(result))
    const reasons = Object.fromEntries(run.assessment.capabilities.map((result) => [result.capability.id, capabilityVerdict(result)]))
    expect(reasons.unassignedMatch).toEqual({ result: "missing", reason: "Configured but unassigned, counted missing." })
    expect(reasons.unassignedDifferent).toEqual({ result: "missing", reason: "Configured with a different value but unassigned, counted missing." })
    expect(reasons.unknownAssignment).toEqual({ result: "unableToCheck", reason: "The assignment of the configuring policy is unknown, counted unknown." })
    expect(reasons.mixed!.result).toBe("matches")
  })

  it("lists as gaps exactly the capabilities counted different or missing, labelled by how they were counted", () => {
    const run = isoLike()
    const counts = comparisonCounts(run)
    const gaps = countedGaps(run)
    expect(gaps).toHaveLength(counts.different + counts.missing)
    expect(latestScore(run, NOW).gapCount).toBe(counts.different + counts.missing)
    expect(gaps.map((gap) => [gap.capabilityId, gap.result]).sort()).toEqual([
      ["assignedDifferent", "different"], ["assignedMissing", "missing"], ["unassignedDifferent", "missing"], ["unassignedMatch", "missing"],
    ])
    // A capability counted matching (mixed evidence included) is never a gap.
    expect(gaps.some((gap) => gap.capabilityId === "mixed" || gap.capabilityId === "assignedMatch")).toBe(false)
    const unassigned = gaps.find((gap) => gap.capabilityId === "unassignedDifferent")!
    expect(unassigned.countedAs).toBe("Configured with a different value but unassigned, counted missing.")
    expect(unassigned.policies[0]).toMatchObject({ assignment: "notAssigned" })
    const match = gaps.find((gap) => gap.capabilityId === "unassignedMatch")!
    expect(match.settings[0]).toMatchObject({ result: "matches" })
  })

  it("puts every counted item in the detail under its counted result, adding up to the card counts", () => {
    const run = isoLike()
    const detail = frameworkDetail(run, NOW)
    const groups = Object.fromEntries(groupCounted(detail.items).map((group) => [group.result, group.items.map((item) => item.id).sort()]))
    expect(Object.fromEntries(Object.entries(groups).map(([key, ids]) => [key, ids.length]))).toEqual(detail.score.counts)
    expect(groups.matching).toEqual(["assignedMatch", "mixed"])
    expect(groups.missing).toEqual(["assignedMissing", "unassignedDifferent", "unassignedMatch"])
    expect(groups.unknown).toEqual(["A.5.1", "unknownAssignment", "unreadable"])
    expect(groups.outsideScope).toEqual(["outside"])
    expect(detail.items.find((item) => item.id === "A.5.1")).toMatchObject({ kind: "reference", reason: "No configuration check exists for this requirement." })
    expect(countedItems(run)).toHaveLength(run.assessment.capabilities.length + 1)
    expect(latestScore(run, NOW).uncheckedReferences).toBe(1)
  })

  it("exports gaps with the same count and label as the card", () => {
    const run = isoLike()
    const score = frameworkScore({ frameworkId: "iso-27001", frameworkName: "ISO", status: "ok", runs: [run], olderRuns: [], error: null, notice: null }, NOW)
    const row = scoresCsv([score]).split("\r\n")[1]!
    expect(row).toContain(",4,")
    expect(row).toContain("Configured but unassigned, counted missing")
    expect(row).not.toContain("different value,")
  })
})

describe("required groups split across assigned policies", () => {
  it("counts the capability missing and keeps the assigned matches as evidence", () => {
    const run = makeRun({ runId: "split", tenantId: TENANT_A, caps: { split: ["matches", "matches"] } })
    const result = run.assessment.capabilities[0]!
    result.capability = { ...result.capability, requiredGroups: ["encryption", "recovery"] }
    const assignment = { state: "assigned" as const, targets: [], exclusions: [], filters: [], coverage: "unverified" as const }
    result.evidence = (["encryption", "recovery"] as const).map((group, index) => ({
      capabilityId: "split", policyId: `policy-split-${index}`, policyName: `Policy ${index}`, policyType: "settingsCatalog", source: "settingsCatalog" as const,
      settingId: `split.setting${index}`, observedValue: "true", verdict: "enforced" as const, assignment, kind: "configuration" as const, requirementGroup: group,
    }))
    expect(capabilityComparison(result)).toBe("missing")
    const [gap] = countedGaps(run)
    expect(gap).toMatchObject({ capabilityId: "split", result: "missing", countedAs: "No single assigned policy covers all required settings of this capability, counted missing." })
    expect(gap!.settings.map((setting) => setting.result)).toEqual(["matches", "matches"])
    expect(gap!.policies.map((policy) => [policy.policyId, policy.assignment])).toEqual([["policy-split-0", "assigned"], ["policy-split-1", "assigned"]])
  })
})

describe("partial collection", () => {
  const coverage = (family: string, status: CollectionCoverage["status"], errors: string[] = []): CollectionCoverage => ({ family, collectedPolicies: 0, recognizedPolicies: 0, unsupportedPolicies: 0, status, errors })

  it("treats families not read by design as complete evidence and read failures as partial", () => {
    const rows = [coverage("settingsCatalog", "complete"), coverage("scripts", "notCollected"), coverage("appConfigurations", "notCollected"), coverage("enrollmentConfigurations", "notCollected")]
    expect(collectionReadGaps(rows)).toEqual([])
    expect(collectionReadGaps([...rows, coverage("deviceConfigurations", "incomplete", ["403"])]).map((row) => row.family)).toEqual(["deviceConfigurations"])
    expect(collectionReadGaps([coverage("compliancePolicies", "unknown")])).toHaveLength(1)
  })

  it("gives the scores card and the framework page the same answer for one run", async () => {
    const run = makeRun({ runId: "r", tenantId: TENANT_A, frameworkId: "iso-27001" })
    run.assessment.collectionCoverage = [coverage("settingsCatalog", "complete"), coverage("scripts", "notCollected"), coverage("enrollmentConfigurations", "notCollected")]
    // The framework page reads collectionReadGaps; the card reads partialCollection.
    expect(partialCollection(run)).toEqual(collectionReadGaps(run.assessment.collectionCoverage).map((row) => `${row.family}: ${row.status}`))
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: fakeFrameworksApi({ [`${TENANT_A}:iso-27001`]: [run] }).api, now: () => NOW })
    const { body } = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    expect(body.frameworks.find((entry: any) => entry.frameworkId === "iso-27001").latest.incompleteCollection).toEqual([])
    run.assessment.collectionCoverage.push(coverage("deviceConfigurations", "incomplete", ["Forbidden"]))
    expect(partialCollection(run)).toEqual(["deviceConfigurations: incomplete"])
  })

  it("flags trend points with partial collection", () => {
    const partial = makeRun({ runId: "old", tenantId: TENANT_A, at: "2026-09-01T00:00:00Z", incomplete: true })
    const complete = makeRun({ runId: "new", tenantId: TENANT_A, at: "2026-09-20T00:00:00Z" })
    const score = frameworkScore({ frameworkId: "nist-csf", frameworkName: "NIST", status: "ok", runs: [complete, partial], olderRuns: [], error: null, notice: null }, NOW)
    expect(score.trend.map((point) => [point.runId, point.partial])).toEqual([["old", true], ["new", false]])
  })
})

describe("runs scored under older rules", () => {
  function api(history: NativeAssessment[], currentRunIds: string[]) {
    const base = fakeFrameworksApi({ [`${TENANT_A}:iso-27001`]: history }).api
    const wrapped: typeof base = async (path, tenant, body = {}) => {
      const response = await base(path, tenant, body)
      if (body.frameworkId !== "iso-27001") return response
      return Response.json({ ...(await response.json()), scoringChanged: true, currentRunIds })
    }
    return wrapped
  }

  it("shows a framework with only older-rule runs as scored under older rules, not as missing", async () => {
    const old = makeRun({ runId: "old", tenantId: TENANT_A, frameworkId: "iso-27001" })
    old.assessment.provenance.detectorVersion = 5
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: api([old], []), now: () => NOW })
    const { body } = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    const iso = body.frameworks.find((entry: any) => entry.frameworkId === "iso-27001")
    expect(iso).toMatchObject({ state: "history-only", latest: null })
    expect(iso.message).toBe("Scored under older rules. Compare again to score. An app update changed how capabilities are counted.")
    expect(iso.message).not.toMatch(/No saved comparison/)
    expect(iso.historyOnly).toEqual([{ runId: "old", assessedAt: "2026-09-29T10:00:00Z", reason: iso.message }])
    const detail = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "iso-27001", runId: "old" })
    expect(detail.status).toBe(404)
    expect(detail.body.error).toMatch(/Scored under older rules/)
  })

  it("gives a portfolio row of older-rule runs its assessed date and reason, never an unknown date", async () => {
    const old = makeRun({ runId: "old", tenantId: TENANT_A, frameworkId: "iso-27001" })
    old.assessment.provenance.detectorVersion = 5
    const deps = fakeDeps({ plans: { [TENANT_A]: "msp" }, api: api([old], []), now: () => NOW })
    const { body } = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "portfolio-summary", targetTenants: [] })
    const iso = body.tenants[0].frameworks.find((entry: any) => entry.frameworkId === "iso-27001")
    expect(iso).toMatchObject({ state: "history-only", score: null, coverage: null, assessedAt: "2026-09-29T10:00:00Z", message: "Scored under older rules. Compare again to score. An app update changed how capabilities are counted." })
  })

  it("keeps older-rule runs out of the trend but lists them with the reason, and names a mapping change", async () => {
    const current = makeRun({ runId: "current", tenantId: TENANT_A, frameworkId: "iso-27001", at: "2026-09-29T10:00:00Z" })
    const mapping = makeRun({ runId: "mapping", tenantId: TENANT_A, frameworkId: "iso-27001", at: "2026-09-01T10:00:00Z" })
    current.assessment.provenance.detectorVersion = mapping.assessment.provenance.detectorVersion = (await import("../src/shared/compliance/detector-version")).COMPLIANCE_DETECTOR_VERSION
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: api([current, mapping], ["current"]), now: () => NOW })
    const { body } = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    const iso = body.frameworks.find((entry: any) => entry.frameworkId === "iso-27001")
    expect(iso.state).toBe("scored")
    expect(iso.trend.map((point: any) => point.runId)).toEqual(["current"])
    expect(iso.historyOnly[0]).toMatchObject({ runId: "mapping", reason: "Scored under older rules. Compare again to score. An app update changed the framework mapping." })
  })

  it("opens the detail of the run the card shows, the newest by collection time", async () => {
    const older = makeRun({ runId: "older", tenantId: TENANT_A, frameworkId: "iso-27001", at: "2026-09-01T10:00:00Z" })
    const newer = makeRun({ runId: "newer", tenantId: TENANT_A, frameworkId: "iso-27001", at: "2026-09-29T10:00:00Z" })
    // Saved out of order: the first entry is not the newest.
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: fakeFrameworksApi({ [`${TENANT_A}:iso-27001`]: [older, newer] }).api, now: () => NOW })
    const summary = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    const detail = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "iso-27001" })
    expect(summary.body.frameworks.find((entry: any) => entry.frameworkId === "iso-27001").latest.identity.runId).toBe("newer")
    expect(detail.body.detail.identity.runId).toBe("newer")
  })
})
