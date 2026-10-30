import { describe, expect, it } from "vitest"
import { buildDeviations, summarizeGovernance } from "../src/renderer/features/governance/model"
import { evidencePackJson, GOVERNANCE_EVIDENCE_NOTICE } from "../src/renderer/features/shared/governance-export"
import { appendJsonEntry, settingIdsOf } from "../src/renderer/features/standards/StandardsLibrary"

const now = new Date("2026-10-30T12:00:00Z")

describe("accepted deviations register", () => {
  it("unifies customizations, hygiene reviews and standard exceptions, expired first", () => {
    const entries = buildDeviations({
      now,
      customizations: [{ id: "c1", title: "Camera on kiosks", settingKey: "vendor_camera", policyName: "Kiosk", value: "allowed", reason: "Scanning", owner: "Sam", status: "active", expiresAt: null, updatedAt: "2026-10-01T00:00:00Z" }] as never,
      findings: [
        { id: "f1", title: "Duplicate profile", status: "acknowledged", policies: [{ folder: "ConfigurationPolicies", id: "p1", name: "Base" }], settings: [{ definitionId: "vendor_x", values: [] }], review: { action: "acknowledged", by: "Lee", at: "2026-10-02T00:00:00Z", note: "Known overlap" }, collectedAt: "2026-10-01T00:00:00Z" },
        { id: "f2", title: "Still open", status: "open", policies: [], settings: [], review: null, collectedAt: "2026-10-01T00:00:00Z" },
      ] as never,
      adoptions: [{ id: "a1", title: "Golden Windows", overlay: { settings: [], removals: [], exceptions: [{ policyKey: "pol1", settingDefinitionId: "vendor_y", reason: "Legacy app", approver: "Pat", expiresAt: "2026-10-01T00:00:00Z", status: "approved" }, { policyKey: "pol1", settingDefinitionId: "vendor_z", reason: "Revoked one", approver: "Pat", expiresAt: "2027-01-01T00:00:00Z", status: "revoked" }] } }] as never,
    })
    expect(entries.map((entry) => entry.kind)).toEqual(["standard-exception", "customization", "hygiene-review"])
    expect(entries[0]).toMatchObject({ title: "Golden Windows: vendor_y", owner: "Pat", expired: true, expiresAt: "2026-10-01T00:00:00Z" })
    expect(entries.find((entry) => entry.id === "hygiene:f1")).toMatchObject({ owner: "Lee", reason: "Known overlap", settingKey: "vendor_x" })
  })

  it("summarizes posture without inventing numbers for missing evidence", () => {
    const summary = summarizeGovernance({
      frameworks: [{ frameworkId: "fw", frameworkName: "FW", state: "assessed", message: null, latest: { score: { score: 80, coverage: 90, counts: { unknown: 2 } }, gapCount: 3, freshness: { assessedAt: "2026-10-01T00:00:00Z", stale: true, ageDays: 29 } } }] as never,
      findings: [{ status: "open", classification: "definite" }, { status: "open", classification: "possible" }, { status: "acknowledged", classification: "definite" }] as never,
      scans: [{ collectedAt: "2026-10-29T00:00:00Z", backupId: "b1" }] as never,
      customizations: [{ status: "active" }, { status: "retired" }] as never,
      adoptions: [{ state: { pendingUpgrade: true, deviations: 2, assessedAt: "2026-10-20T00:00:00Z" } }] as never,
    })
    expect(summary).toMatchObject({ openDefinite: 1, openPossible: 1, activeCustomizations: 1, pendingUpgrades: 1, standardDeviations: 2, staleScores: 1 })
    expect(summary.latestScore).toMatchObject({ frameworkName: "FW", score: 80, coverage: 90 })
    expect(summary.latestScanAt).toBe("2026-10-29T00:00:00Z")
    const missing = summarizeGovernance({ frameworks: [], findings: [], scans: [], customizations: [], adoptions: [{ state: { pendingUpgrade: false, deviations: null, assessedAt: null } }] as never })
    expect(missing.latestScore).toBeNull()
    expect(missing.latestScanAt).toBeNull()
    expect(missing.unassessedAdoptions).toBe(1)
    expect(missing.standardDeviations).toBe(0)
  })

  it("builds an evidence pack with the notice, tenant and freshness per section", () => {
    const pack = JSON.parse(evidencePackJson({ tenant: "Contoso", exportedAt: "2026-10-30T12:00:00Z", frameworks: [], findings: [], ruleName: (id) => id, adoptions: [], customizations: [], deviations: [], freshness: { scoresAssessedAt: "2026-10-01T00:00:00Z", hygieneCollectedAt: null, standardsAssessedAt: null } }))
    expect(pack.notice).toBe(GOVERNANCE_EVIDENCE_NOTICE)
    expect(pack.tenant).toBe("Contoso")
    expect(pack.freshness.scoresAssessedAt).toBe("2026-10-01T00:00:00Z")
    expect(pack.deviations).toEqual([])
    const withValue = JSON.parse(evidencePackJson({ tenant: "Contoso", exportedAt: "2026-10-30T12:00:00Z", frameworks: [], findings: [], ruleName: (id) => id, adoptions: [], customizations: [{ title: "WiFi", settingKey: "wifi_psk", policyName: null, value: "hunter2", reason: "r", owner: "Sam", status: "active", version: 1 } as never], deviations: [], freshness: { scoresAssessedAt: null, hygieneCollectedAt: null, standardsAssessedAt: null } }))
    expect(JSON.stringify(withValue)).not.toContain("hunter2")
    expect(withValue.customizations[0]).toMatchObject({ hasValue: true })
  })
})

describe("golden standard structured builders", () => {
  it("appends entries to the JSON fields and refuses non-array JSON", () => {
    expect(JSON.parse(appendJsonEntry("", { name: "p1" }, "Parameters"))).toEqual([{ name: "p1" }])
    expect(JSON.parse(appendJsonEntry('[{"name":"p1"}]', { name: "p2" }, "Parameters"))).toHaveLength(2)
    expect(() => appendJsonEntry('{"name":"p1"}', { name: "p2" }, "Parameters")).toThrow("must be a JSON array")
    expect(() => appendJsonEntry("nope", { name: "p2" }, "Parameters")).toThrow("not valid JSON")
  })

  it("suggests setting IDs from pasted policy exports and nothing for invalid JSON", () => {
    const policies = JSON.stringify([{ settings: [{ settingInstance: { settingDefinitionId: "vendor_b" } }, { settingDefinitionId: "vendor_a" }] }])
    expect(settingIdsOf(policies)).toEqual(["vendor_a", "vendor_b"])
    expect(settingIdsOf("not json")).toEqual([])
  })
})
