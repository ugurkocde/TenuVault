import { describe, expect, it } from "vitest"
import type { SyncStatusEntry, SyncTarget } from "../src/renderer/features/sync/api"
import { applyStage, discardable, excludedReason, failedItems, initials, intuneLink, linkPath, mayHaveWritten, outcomeCounts, policyStatus, progress, readiness, relativeTime, reviewRows, runOutcome, targetPhase } from "../src/renderer/features/sync/model"
import { stillReading } from "../src/renderer/features/sync/loading"

const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SOURCE_POLICY = "11111111-1111-4111-8111-111111111111"

function target(status: string | null, results: Record<string, { status: string; objectId?: string | null; message?: string | null }> = {}, operations = [{ key: "op-1", folder: "ConfigurationPolicies", name: "Defender" }]): SyncTarget {
  return {
    targetTenantId: TARGET, promotionId: "pr", error: null, rollbackChangeSet: null,
    promotion: { id: "pr", status: status === null ? "blocked" : "in-review", items: [] } as unknown as SyncTarget["promotion"],
    changeSet: status === null ? null : ({
      id: "cs", status, contentHash: "h", preChange: null, lastError: null,
      operations: operations.map((operation, index) => ({ ...operation, action: "create", targetId: null, source: { tenantId: "a", objectId: index === 0 ? SOURCE_POLICY : `${index}`, version: null, label: operation.name } })),
      results: Object.fromEntries(Object.entries(results).map(([key, result]) => [key, { objectId: null, message: null, readBack: null, attempts: 1, at: null, ...result }])),
    } as unknown as SyncTarget["changeSet"]),
  }
}

const entry = (state: SyncStatusEntry["state"]): SyncStatusEntry => ({ folder: "ConfigurationPolicies", sourceId: SOURCE_POLICY, sourceName: "Defender", targetPolicyId: "t", targetName: "Defender", linkedAt: "2026-11-01T00:00:00Z", state, changedIn: null, identical: null, error: null })

describe("Sync status chips", () => {
  it("names the state that needs attention first", () => {
    expect(policyStatus([])).toEqual({ label: "Not synced yet", tone: "neutral" })
    expect(policyStatus([{ tenantName: "Germany", entry: entry("in-sync") }]).label).toBe("In sync with Germany")
    expect(policyStatus([{ tenantName: "Germany", entry: entry("in-sync") }, { tenantName: "France", entry: entry("in-sync") }]).label).toBe("In sync with 2 tenants")
    expect(policyStatus([{ tenantName: "Germany", entry: entry("in-sync") }, { tenantName: "France", entry: entry("changed") }]).label).toBe("Changed since last sync")
    expect(policyStatus([{ tenantName: "Germany", entry: entry("changed") }, { tenantName: "France", entry: entry("missing-in-target") }]).label).toBe("Missing in target")
    expect(policyStatus([{ tenantName: "Germany", entry: entry("unknown") }]).label).toBe("Unknown")
  })
})

describe("Sync result states", () => {
  it("reads every state from the stored change set, and writing while this screen's request runs", () => {
    expect(targetPhase(target("approved"), true, null)).toBe("writing")
    expect(targetPhase(target("applying"), false, null)).toBe("writing")
    expect(targetPhase(target("applied", { "op-1": { status: "verified", objectId: "x" } }), false, null)).toBe("verified")
    expect(targetPhase(target("partial"), false, null)).toBe("partial")
    expect(targetPhase(target("uncertain"), false, null)).toBe("partial")
    expect(targetPhase(target("failed", { "op-1": { status: "failed", message: "403" } }), false, null)).toBe("failed")
    expect(targetPhase(target("failed", { "op-1": { status: "verified" }, "op-2": { status: "failed" } }, [{ key: "op-1", folder: "ConfigurationPolicies", name: "A" }, { key: "op-2", folder: "ConfigurationPolicies", name: "B" }]), false, null)).toBe("partial")
    expect(targetPhase(target("approved"), false, null)).toBe("failed")
    expect(targetPhase(target("in-review"), false, null)).toBe("excluded")
    expect(targetPhase(target("stale"), false, "Plan again.")).toBe("failed")
    expect(targetPhase(target(null), false, null)).toBe("excluded")
    const inSync = { ...target(null), promotion: null, skipped: [{ folder: "ConfigurationPolicies", sourceId: SOURCE_POLICY, sourceName: "Defender", reason: "already in sync" as const }] }
    expect(targetPhase(inSync, false, null)).toBe("in-sync")
    expect(readiness(inSync, undefined, "new", false)).toEqual({ state: "in-sync", reason: null })
    expect(progress(target("partial", { "op-1": { status: "verified" } }, [{ key: "op-1", folder: "ConfigurationPolicies", name: "A" }, { key: "op-2", folder: "ConfigurationPolicies", name: "B" }]))).toEqual({ done: 1, total: 2 })
    expect(failedItems(target("failed", { "op-1": { status: "failed", message: "Intune answered 403." } }).changeSet)).toEqual([{ name: "Defender", message: "Intune answered 403." }])
    expect(excludedReason(target("in-review"))).toBe("Reviewed but not approved.")
    expect(excludedReason(target(null))).toBe("Blocked by findings in the review.")
  })

  it("counts a write whose outcome is unknown as possibly written, for rollback availability", () => {
    const ops = [{ key: "op-1", folder: "ConfigurationPolicies", name: "A" }]
    expect(mayHaveWritten(target("failed", { "op-1": { status: "uncertain" } }, ops))).toBe(true)
    expect(mayHaveWritten(target("applying", { "op-1": { status: "writing" } }, ops))).toBe(true)
    expect(mayHaveWritten(target("partial", { "op-1": { status: "verified" } }, ops))).toBe(true)
    expect(mayHaveWritten(target("failed", { "op-1": { status: "failed", message: "403" } }, ops))).toBe(false)
    expect(mayHaveWritten(target(null))).toBe(false)
    expect(progress(target("failed", { "op-1": { status: "uncertain" } }, ops)).done).toBe(0)
  })

  it("keeps a target without backup storage out only when a backup is asked for", () => {
    const review = { preview: { changeSet: { blockers: [] } } as never, error: null }
    expect(readiness(target("in-review"), review, "new", false).state).toBe("excluded")
    expect(readiness(target("in-review"), review, "none", false).state).toBe("ready")
    expect(readiness(target("in-review"), review, "new", true).state).toBe("ready")
    expect(readiness(target("in-review"), undefined, "new", true).state).toBe("checking")
    expect(readiness(target("in-review"), { preview: null, error: "Could not read." }, "new", true)).toEqual({ state: "excluded", reason: "Could not read." })
  })
})

describe("Open Intune", () => {
  it("opens one written policy's page, or the list of its type, in the target tenant", () => {
    const one = target("applied", { "op-1": { status: "verified", objectId: "new-1" } }, [{ key: "op-1", folder: "CompliancePolicies", name: "Baseline" }])
    expect(intuneLink(one)).toEqual({ url: `https://intune.microsoft.com/#@${TARGET}/view/Microsoft_Intune_DeviceSettings/ConfigurationMenuBlade/~/properties/configurationId/new-1/policyType~/0/policyJourneyState~/1`, exact: true })
    // A Settings Catalog page needs the platform; without it the list opens.
    const catalog = target("applied", { "op-1": { status: "verified", objectId: "new-2" } })
    expect(intuneLink(catalog)).toEqual({ url: `https://intune.microsoft.com/#@${TARGET}/view/Microsoft_Intune_DeviceSettings/DevicesMenu/~/configuration`, exact: false })
    expect(intuneLink(catalog, { [SOURCE_POLICY]: "macOS" })?.url).toContain("/policyId/new-2/isAssigned~/false/technology/mdm/templateId//platformName/macOS")
    const several = target("applied", { "op-1": { status: "verified", objectId: "x" }, "op-2": { status: "verified", objectId: "y" } }, [{ key: "op-1", folder: "EndpointSecurityIntents", name: "A" }, { key: "op-2", folder: "EndpointSecurityIntents", name: "B" }])
    expect(intuneLink(several)).toEqual({ url: `https://intune.microsoft.com/#@${TARGET}/view/Microsoft_Intune_Workflows/SecurityManagementMenu/~/overview`, exact: false })
    expect(intuneLink(target(null))).toBeNull()
  })
})

describe("Flowchart geometry", () => {
  it("draws a cubic link that leaves and arrives level, with its midpoint between the ends", () => {
    expect(linkPath(0, 100, 200, 20)).toEqual({ d: "M0,100 C100,100 100,20 200,20", mid: { x: 100, y: 60 } })
    expect(initials("Contoso Lab")).toBe("CL")
    expect(initials("Fabrikam")).toBe("FA")
  })
})

const changed = (changedIn: SyncStatusEntry["changedIn"]): SyncStatusEntry => ({ ...entry("changed"), changedIn })

describe("Sync status chips name where a policy changed", () => {
  it("names the source, one target, several targets or both sides", () => {
    expect(policyStatus([{ tenantName: "Germany", entry: changed("source") }], [], "Contoso Lab").label).toBe("Changed in Contoso Lab")
    expect(policyStatus([{ tenantName: "Germany", entry: changed("target") }], [], "Contoso Lab").label).toBe("Changed in Germany")
    expect(policyStatus([{ tenantName: "Germany", entry: changed("target") }, { tenantName: "France", entry: changed("target") }], [], "Contoso Lab").label).toBe("Changed in 2 targets")
    expect(policyStatus([{ tenantName: "Germany", entry: changed("both") }], [], "Contoso Lab").label).toBe("Changed in both")
    expect(policyStatus([{ tenantName: "Germany", entry: changed("source") }, { tenantName: "France", entry: changed("target") }], [], "Contoso Lab").label).toBe("Changed in both")
    expect(policyStatus([{ tenantName: "Germany", entry: changed("target") }], [], "Contoso Lab").title).toContain("Germany: changed since the last sync (edited in this tenant)")
  })
})

describe("Sync review rows", () => {
  it("shows the same-name finding once, from the live preview, and keeps it when no preview was read", () => {
    const planned = target("in-review")
    planned.promotion = { id: "pr", status: "in-review", items: [{ folder: "ConfigurationPolicies", sourceId: SOURCE_POLICY, sourceName: "Defender", action: "create", blocked: false, findings: [{ code: "display-name-only", severity: "warning", message: "1 object(s) named \"Defender\" already exist in the destination. A name match is not a mapping." }] }] } as unknown as SyncTarget["promotion"]
    const preview = { changeSet: { operations: [{ key: "op-1", diff: [{ path: "x" }], diffTruncated: false, blockers: [], warnings: ["1 object(s) named \"Defender\" already exist; this creates another one."] }] } } as never
    const notes = reviewRows(planned, preview)[0]!.notes.map((note) => note.message)
    expect(notes).toEqual(["1 object(s) named \"Defender\" already exist; this creates another one."])
    expect(reviewRows(planned, null)[0]!.notes.map((note) => note.message)).toEqual(["1 object(s) named \"Defender\" already exist in the destination. A name match is not a mapping."])
  })
})

describe("Sync apply stages", () => {
  const ops = [{ key: "op-1", folder: "ConfigurationPolicies", name: "A" }, { key: "op-2", folder: "ConfigurationPolicies", name: "B" }, { key: "op-3", folder: "ConfigurationPolicies", name: "C" }]
  const stage = (status: string, extra: Record<string, unknown>, results: Record<string, { status: string }> = {}, backup?: "new" | "none", active = false) => {
    const entry = target(status, results, ops)
    Object.assign(entry.changeSet!, extra)
    if (backup) (entry.promotion as unknown as { sync: unknown }).sync = { runId: "r", backup }
    return applyStage(entry, active)
  }
  const capture = (backupFolder: string | null) => ({ preChange: { capturedAt: "t", backupFolder, captureId: "c", objects: [] } })

  it("derives each stage from the stored change set and target record", () => {
    // The approval request of this screen is running and the change set is still in review.
    expect(stage("in-review", {}, {}, undefined, true)).toMatchObject({ step: 0, label: "Approving" })
    expect(stage("approved", { attempts: 0 }, {}, "new", true)).toMatchObject({ step: 1, label: "Backing up", steps: ["Approve", "Back up", "Write and verify"] })
    expect(stage("applying", { attempts: 1, backupChoice: "new" }, {}, "new")).toMatchObject({ step: 1, label: "Backing up" })
    expect(stage("applying", { attempts: 1, backupChoice: "none" }, {}, "none")).toMatchObject({ step: 1, label: "Saving current versions", steps: ["Approve", "Save", "Write and verify"] })
    // Writing and verifying are one stage: an operation is stored as writing before its write
    // is sent, so only verified results count.
    expect(stage("applying", { attempts: 1, ...capture("b") }, {}, "new")).toMatchObject({ step: 2, label: "Writing and verifying 0 of 3" })
    expect(stage("applying", { attempts: 1, ...capture("b") }, { "op-1": { status: "verified" }, "op-2": { status: "writing" } }, "new")).toMatchObject({ step: 2, label: "Writing and verifying 1 of 3" })
    expect(stage("applying", { attempts: 1, ...capture(null) }, { "op-1": { status: "verified" }, "op-2": { status: "verified" }, "op-3": { status: "writing" } }, "none")).toMatchObject({ step: 2, label: "Writing and verifying 2 of 3" })
    // A failed result, also one an earlier attempt left on a retry, counts as nothing written.
    expect(stage("applying", { attempts: 2, ...capture("b") }, { "op-1": { status: "failed" }, "op-2": { status: "verified" } }, "new")).toMatchObject({ step: 2, label: "Writing and verifying 1 of 3" })
  })

  it("has no stage for a target that is not writing", () => {
    expect(stage("applied", { attempts: 1, ...capture("b") }, { "op-1": { status: "verified" } }, "new")).toBeNull()
    expect(stage("in-review", {})).toBeNull()
    expect(applyStage(target(null), true)).toBeNull()
  })
})

describe("Sync outcomes and recent runs", () => {
  it("counts created, updated, skipped and failed operations of a target", () => {
    const entry = target("partial", { "op-1": { status: "verified" }, "op-2": { status: "verified" }, "op-3": { status: "uncertain" } }, [{ key: "op-1", folder: "ConfigurationPolicies", name: "A" }, { key: "op-2", folder: "ConfigurationPolicies", name: "B" }, { key: "op-3", folder: "ConfigurationPolicies", name: "C" }])
    entry.changeSet!.operations[1]!.action = "update"
    entry.skipped = [{ folder: "ConfigurationPolicies", sourceId: "x", sourceName: "X", reason: "already in sync" }]
    expect(outcomeCounts(entry)).toEqual({ created: 1, updated: 1, skipped: 1, failed: 1 })
  })

  it("can discard only while no target was approved or applied", () => {
    const review = target("in-review")
    Object.assign(review.changeSet!, { attempts: 0, review: null })
    expect(discardable([review, target(null)])).toBe(true)
    const approved = target("approved")
    Object.assign(approved.changeSet!, { attempts: 0, review: { decision: "approved" } })
    expect(discardable([review, approved])).toBe(false)
    const bound = target("in-review")
    Object.assign(bound.changeSet!, { attempts: 0, review: null })
    ;(bound.promotion as unknown as { sync: unknown }).sync = { runId: "r", backup: "none" }
    expect(discardable([bound])).toBe(false)
  })

  it("reads a run's outcome, falling back for runs listed without one", () => {
    expect(runOutcome({ outcome: "rolled-back", applied: true })).toBe("rolled-back")
    expect(runOutcome({ applied: true })).toBe("applied")
    expect(runOutcome({ inSync: true })).toBe("in-sync")
    expect(runOutcome({})).toBe("not-applied")
  })

  it("says how long ago a run was planned", () => {
    const now = Date.parse("2026-11-09T12:00:00Z")
    expect(relativeTime("2026-11-09T11:59:40Z", now)).toBe("just now")
    expect(relativeTime("2026-11-09T11:55:00Z", now)).toBe("5 minutes ago")
    expect(relativeTime("2026-11-09T10:00:00Z", now)).toBe("2 hours ago")
    expect(relativeTime("2026-11-09T11:00:20Z", now)).toBe("1 hour ago")
    expect(relativeTime("2026-11-08T11:00:00Z", now)).toBe("yesterday")
    expect(relativeTime("2026-11-02T12:00:00Z", now)).toBe("last week")
    expect(relativeTime("not a date", now)).toBe("")
  })

  it("says a read is still running once it took 5 seconds", () => {
    expect(stillReading(4)).toBeNull()
    expect(stillReading(12)).toBe("Still reading, 12 s")
  })
})
