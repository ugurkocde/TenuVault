import { describe, expect, it } from "vitest"
import type { SyncStatusEntry, SyncTarget } from "../src/renderer/features/sync/api"
import { excludedReason, failedItems, initials, intuneLink, linkPath, mayHaveWritten, policyStatus, progress, readiness, targetPhase } from "../src/renderer/features/sync/model"

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
