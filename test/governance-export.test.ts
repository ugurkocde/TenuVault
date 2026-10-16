import { describe, expect, it } from "vitest"
import type { FrameworkScore } from "../src/renderer/features/scores/api"
import type { Finding as HygieneFinding } from "../src/renderer/features/hygiene/api"
import type { Finding as HealthFinding } from "../src/renderer/features/health-review/api"
import type { AdoptionState } from "../src/renderer/features/standards/api"
import { governanceExportName, healthCsv, healthJson, hygieneCsv, hygieneJson, scoresCsv, scoresJson, standardsCsv, standardsJson } from "../src/renderer/features/shared/governance-export"

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefgh12345678.signaturepart"

const scored: FrameworkScore = {
  frameworkId: "cis",
  frameworkName: "CIS Benchmark",
  state: "scored",
  message: null,
  trend: [],
  incompatible: [],
  historyOnly: [],
  latest: {
    versionDetail: null,
    unit: "capability",
    uncheckedReferences: 0,
    identity: { runId: "run-1", frameworkId: "cis", frameworkName: "CIS Benchmark", frameworkVersion: "2.0", rulesetVersion: "map-3", rulesetSha256: "sha-rules", snapshotSha256: "sha-snap", profile: "Level 1", platforms: ["windows", "tenant"], assessedAt: "2026-10-01T02:00:00Z" },
    freshness: { assessedAt: "2026-10-01T02:00:00Z", ageDays: 4, stale: false },
    score: { counts: { matching: 8, different: 1, missing: 1, unknown: 2, outsideScope: 3 }, evaluated: 10, assessed: 12, score: 80, coverage: 83.3, state: "scored", reason: null },
    incompleteCollection: ["conditionalAccess: partial"],
    gapCount: 1,
    topGaps: [{
      key: "cap-1", capabilityId: "cap-1", capabilityName: "Block legacy authentication", platform: "tenant", capabilityStatus: "partialConfiguration", result: "different", countedAs: "An assigned policy sets a different value.", mixed: false,
      settings: [], settingIds: [], policies: [], controls: [{ id: "1.1", title: "Legacy auth", evidenceStrength: "direct" }], unknownChecks: 0, limitations: [],
      ranking: { level: "high", score: 80, reasons: ["High priority."] },
    }],
  },
}

const notAssessed: FrameworkScore = { frameworkId: "iso", frameworkName: "ISO 27001", state: "not-assessed", message: "No saved comparison.", latest: null, trend: [], incompatible: [], historyOnly: [] }

const hygieneFinding: HygieneFinding = {
  id: "f1", title: "Duplicate setting, conflicting values", summary: "Two policies set the same setting.", status: "open", ruleId: "duplicate",
  classification: "definite", severity: "high", explanation: `Bearer ${JWT} must not leak`, policies: [{ folder: "ConfigurationPolicies", id: "p1", name: "Policy, One" }],
  settings: [{ definitionId: "setting_x", values: [{ policyId: "p1", display: "On", valueSha256: "deadbeef" }] }],
  details: {}, evidenceSha256: "evidencehash", backupId: "backup-1", collectedAt: "2026-10-02T00:00:00Z", firstSeenAt: "2026-10-02T00:00:00Z", lastSeenAt: "2026-10-03T00:00:00Z",
  review: null,
}

const healthFinding: HealthFinding = {
  id: "h1", key: "backup-stale", family: "backup", check: "backup-freshness", severity: "critical", state: "open",
  title: "Backup is stale", reason: "No complete backup in 30 hours.", observedAt: "2026-10-03T00:00:00Z", evidenceAt: "2026-10-03T00:00:00Z",
  firstSeenAt: "2026-10-02T00:00:00Z", lastSeenAt: "2026-10-03T00:00:00Z", resolvedAt: null, occurrence: 2, owner: "Admin Team",
  acknowledgedAt: null, acknowledgedBy: null, link: "/portal/backup", history: [],
}

const adoption: AdoptionState = {
  id: "a1", tenantId: "t1", standardKey: "baseline-win", title: "Windows baseline", status: "adopted", adoptedVersion: 2, configuredVersion: 3,
  latestVersion: 3, pendingUpgrade: true, deviations: 4, unknownPolicies: 1, assessedAt: "2026-10-04T00:00:00Z", freshness: "stale",
}

const ruleName = (id: string) => (id === "duplicate" ? "Duplicate policies" : id)

describe("governance export names", () => {
  it("names files after the tab, tenant and export day like the drift export", () => {
    expect(governanceExportName("scores", "Contoso Ltd.", "2026-10-13T10:00:00Z")).toBe("scores-contoso-ltd-2026-10-13")
    expect(governanceExportName("hygiene", null, "2026-10-13T10:00:00Z")).toBe("hygiene-2026-10-13")
  })
})

describe("scores export", () => {
  it("writes one CSV row per framework with the counts the card shows", () => {
    const lines = scoresCsv([scored, notAssessed]).split("\r\n")
    expect(lines[0]).toBe("Framework,Version,Profile,Mapping,State,Score (%),Coverage (%),Matching,Different,Missing,Unknown,Outside scope,Gaps,Assessed,Age (days),Stale,Partial collection,Scope,Top gaps,Message")
    expect(lines[1]).toContain("CIS Benchmark,2.0,Level 1,map-3,scored,80,83.3,8,1,1,2,3,1,2026-10-01T02:00:00Z,4,no,conditionalAccess: partial")
    expect(lines[1]).toContain("Block legacy authentication (An assigned policy sets a different value; high)")
    expect(lines[2]).toContain("ISO 27001")
    expect(lines[2]).toContain("not-assessed")
    expect(lines[2]).toContain("No saved comparison.")
    expect(lines).toHaveLength(3)
  })

  it("keeps scores JSON structured and free of snapshot hashes", () => {
    const json = JSON.parse(scoresJson([scored], "Contoso", "2026-10-13T10:00:00Z"))
    expect(json).toMatchObject({ exportedAt: "2026-10-13T10:00:00Z", tenant: "Contoso" })
    expect(json.frameworks[0]).toMatchObject({ framework: "CIS Benchmark", score: 80, coverage: 83.3, gaps: 1 })
    expect(JSON.stringify(json)).not.toContain("sha-rules")
    expect(JSON.stringify(json)).not.toContain("sha-snap")
  })
})

describe("hygiene export", () => {
  it("exports only the findings passed in, with the rule name and labels the list shows", () => {
    const csv = hygieneCsv([hygieneFinding], ruleName)
    const lines = csv.split("\r\n")
    expect(lines[0]).toBe("Finding,Rule,Classification,Severity,Status,Policies,Collected,First seen,Last seen,Finding ID")
    expect(lines[1]).toContain("Duplicate setting, conflicting values")
    // The policy name contains a comma, so the cell is quoted as one field.
    expect(lines[1]).toContain('"Policy, One (ConfigurationPolicies)"')
    expect(lines[1]).toContain("Duplicate policies,Definite,high,Open")
    expect(csv).not.toContain("valueSha256")
    expect(csv).not.toContain("deadbeef")
    expect(csv).not.toContain(JWT)
  })

  it("does not export explanations, evidence hashes or settings in JSON", () => {
    const json = JSON.parse(hygieneJson([hygieneFinding], ruleName, "Contoso", "2026-10-13T10:00:00Z"))
    expect(json.findings[0]).toMatchObject({ finding: "Duplicate setting, conflicting values", rule: "Duplicate policies", status: "Open" })
    const text = JSON.stringify(json)
    expect(text).not.toContain("evidencehash")
    expect(text).not.toContain("deadbeef")
    expect(text).not.toContain(JWT)
    expect(text).not.toContain("must not leak")
  })
})

describe("health export", () => {
  it("exports the finding fields the list shows", () => {
    const lines = healthCsv([healthFinding]).split("\r\n")
    expect(lines[0]).toBe("Finding,Check,Severity,State,Reason,Owner,Acknowledged by,Acknowledged at,Occurrences,First seen,Last checked,Evidence read,Resolved at,Finding ID")
    expect(lines[1]).toContain("Backup is stale,backup-freshness,critical,open,No complete backup in 30 hours.,Admin Team")
    const json = JSON.parse(healthJson([healthFinding], "Contoso", "2026-10-13T10:00:00Z"))
    expect(json.findings[0]).toMatchObject({ finding: "Backup is stale", occurrences: 2, owner: "Admin Team", resolvedAt: null })
    expect(JSON.stringify(json)).not.toContain("/portal/backup")
  })
})

describe("standards export", () => {
  it("exports adoption states without parameters or overlay values", () => {
    const lines = standardsCsv([adoption]).split("\r\n")
    expect(lines[0]).toBe("Standard,Standard key,Status,Adopted version,Configured version,Latest version,Upgrade pending,Deviations,Unknown policies,Assessed,Freshness")
    expect(lines[1]).toBe("Windows baseline,baseline-win,adopted,2,3,3,yes,4,1,2026-10-04T00:00:00Z,stale")
    const json = JSON.parse(standardsJson([adoption], "Contoso", "2026-10-13T10:00:00Z"))
    expect(json.adoptions[0]).toMatchObject({ standard: "Windows baseline", adoptedVersion: 2, upgradePending: true, deviations: 4 })
    expect(JSON.stringify(json)).not.toContain("parameters")
    expect(JSON.stringify(json)).not.toContain("overlay")
  })
})

describe("empty exports", () => {
  it("produce a header-only CSV and an empty list in JSON", () => {
    expect(scoresCsv([])).toContain("Framework,Version")
    expect(scoresCsv([]).split("\r\n")).toHaveLength(1)
    expect(hygieneCsv([], ruleName).split("\r\n")).toHaveLength(1)
    expect(healthCsv([]).split("\r\n")).toHaveLength(1)
    expect(standardsCsv([]).split("\r\n")).toHaveLength(1)
    expect(JSON.parse(scoresJson([], null, "2026-10-13T10:00:00Z")).frameworks).toEqual([])
    expect(JSON.parse(hygieneJson([], ruleName, null, "2026-10-13T10:00:00Z")).findings).toEqual([])
    expect(JSON.parse(healthJson([], null, "2026-10-13T10:00:00Z")).findings).toEqual([])
    expect(JSON.parse(standardsJson([], null, "2026-10-13T10:00:00Z")).adoptions).toEqual([])
  })

  it("neutralizes formula-like cells and redacts token-like text", () => {
    const csv = hygieneCsv([{ ...hygieneFinding, title: "=cmd|calc" }], ruleName)
    expect(csv).toContain("'=cmd|calc")
    const json = hygieneJson([{ ...hygieneFinding, title: `note Bearer ${JWT}` }], ruleName, null, "2026-10-13T10:00:00Z")
    expect(json).not.toContain(JWT)
  })
})
