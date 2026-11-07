import { describe, expect, it } from "vitest"
import {
  armActionAllowed,
  graphRolesFor,
  handoverGate,
  watcherDeployPlanHash,
  watcherGrantSnippet,
  type WatcherDeployPlan,
  type WatcherHandoverEvidence,
} from "../src/shared/notifications/watcher-deploy"

const plan: WatcherDeployPlan = {
  subscriptionId: "22222222-2222-4222-8222-222222222222",
  resourceGroupName: "rg-tenuvault-backups",
  automationAccountName: "aa-tenuvault-notifications",
  storageAccountName: "tvbkp1234567890ab",
  location: "westeurope",
  alertEmail: "ops@contoso.test",
  noFailureAlert: false,
  destinationKinds: ["teams"],
  needsConditionalAccess: true,
  createIfMissing: true,
}

const ready: WatcherHandoverEvidence = {
  accountExists: true,
  identityTenantMatches: true,
  runbookPublished: true,
  runbookVersion: "1.2.0",
  scheduleLinked: true,
  failureAlertOk: true,
  destinationOk: true,
  needsConditionalAccess: true,
  watchConditionalAccess: true,
  alertsHash: "abc123",
  alertsWrittenAt: "2026-11-07T10:00:00.000Z",
  heartbeat: { runAt: "2026-11-07T10:02:00.000Z", lastError: null, alertsHash: "abc123" },
}

describe("watcher deployment plan", () => {
  it("hashes the same plan the same way regardless of key order", () => {
    const reordered = { ...plan, destinationKinds: ["teams"] } as WatcherDeployPlan
    expect(watcherDeployPlanHash(reordered)).toBe(watcherDeployPlanHash(plan))
    expect(watcherDeployPlanHash({ ...plan, location: "northeurope" })).not.toBe(watcherDeployPlanHash(plan))
  })

  it("matches ARM wildcards and lets notActions win", () => {
    const grants = [{ actions: ["Microsoft.Automation/*"], notActions: ["Microsoft.Automation/automationAccounts/jobs/write"], dataActions: [], notDataActions: [] }]
    expect(armActionAllowed(grants, "microsoft.automation/automationaccounts/read")).toBe(true)
    expect(armActionAllowed(grants, "Microsoft.Automation/automationAccounts/jobs/write")).toBe(false)
    expect(armActionAllowed(grants, "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write", true)).toBe(false)
    expect(armActionAllowed([{ actions: [], dataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write"] }], "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write", true)).toBe(true)
    // An exclusion in one role does not cancel another role granting the same action.
    expect(armActionAllowed([
      { actions: ["*"], notActions: ["Microsoft.Authorization/roleAssignments/write"] },
      { actions: ["Microsoft.Authorization/roleAssignments/write"], notActions: [] },
    ], "Microsoft.Authorization/roleAssignments/write")).toBe(true)
  })

  it("only asks for the Graph roles the alerts need", () => {
    expect(graphRolesFor({ conditionalAccess: false, mail: false })).toEqual(["DeviceManagementApps.Read.All"])
    expect(graphRolesFor({ conditionalAccess: true, mail: true })).toEqual(["DeviceManagementApps.Read.All", "AuditLog.Read.All", "Mail.Send"])
  })

  it("builds an admin snippet from GUIDs and the role allowlist only", () => {
    const snippet = watcherGrantSnippet("33333333-3333-4333-8333-333333333333", "11111111-1111-4111-8111-111111111111", ["DeviceManagementApps.Read.All", "AuditLog.Read.All"])
    expect(snippet).toContain("33333333-3333-4333-8333-333333333333")
    expect(snippet).toContain("DeviceManagementApps.Read.All")
    expect(snippet).toContain("https://graph.microsoft.com/beta/servicePrincipals")
    expect(snippet).not.toContain("graph.microsoft.com/v1.0")
    expect(snippet).not.toContain("Mail.Send")
    expect(() => watcherGrantSnippet("x'; Remove-Item", "11111111-1111-4111-8111-111111111111", ["DeviceManagementApps.Read.All"])).toThrow()
    expect(() => watcherGrantSnippet("33333333-3333-4333-8333-333333333333", "11111111-1111-4111-8111-111111111111", ["Directory.ReadWrite.All"])).toThrow()
  })
})

describe("watcher hand-over gate", () => {
  it("opens only for a clean run of the alerts just written", () => {
    expect(handoverGate(ready)).toEqual({ ok: true, missing: [] })
  })

  it.each([
    ["no account", { accountExists: false }, "account"],
    ["identity in another tenant", { identityTenantMatches: false }, "identity-tenant"],
    ["runbook not published", { runbookPublished: false }, "runbook"],
    ["old runbook", { runbookVersion: "1.1.0" }, "runbook-version"],
    ["no schedule link", { scheduleLinked: false }, "schedule"],
    ["no failure alert", { failureAlertOk: false }, "failure-alert"],
    ["destination not proven", { destinationOk: false }, "destination"],
    ["Conditional Access off in the watcher", { watchConditionalAccess: false }, "conditional-access"],
    ["heartbeat older than the alerts", { heartbeat: { runAt: "2026-11-07T09:59:00.000Z", lastError: null, alertsHash: "abc123" } }, "heartbeat-fresh"],
    ["heartbeat of other alerts", { heartbeat: { runAt: "2026-11-07T10:02:00.000Z", lastError: null, alertsHash: "other" } }, "heartbeat-alerts"],
    ["heartbeat with an error", { heartbeat: { runAt: "2026-11-07T10:02:00.000Z", lastError: "HTTP 403", alertsHash: "abc123" } }, "heartbeat-error"],
  ])("stays shut with %s", (_label, patch, missing) => {
    const gate = handoverGate({ ...ready, ...patch })
    expect(gate.ok).toBe(false)
    expect(gate.missing).toContain(missing)
  })

  it("only accepts the completed job this setup started as its proof", () => {
    const withJob = { ...ready, jobSubmittedAt: "2026-11-07T10:01:00.000Z", jobStatus: "Completed" }
    expect(handoverGate(withJob).ok).toBe(true)
    expect(handoverGate({ ...withJob, jobStatus: "Failed" }).missing).toContain("test-job")
    expect(handoverGate({ ...withJob, heartbeat: { runAt: "2026-11-07T10:00:30.000Z", lastError: null, alertsHash: "abc123" } }).missing).toContain("test-job-run")
  })

  it("does not need Conditional Access in the watcher when no alert reads it", () => {
    expect(handoverGate({ ...ready, needsConditionalAccess: false, watchConditionalAccess: false }).ok).toBe(true)
  })
})
