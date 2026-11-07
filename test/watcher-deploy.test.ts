import { describe, expect, it, vi } from "vitest"
import { routes } from "../src/main/features/notifications"
import { DOMAINS } from "../src/main/features/domains"
import { advanceWatcherDeploy, markInterruptedWatcherDeploys, resumePendingWatcherHandovers, resumeWatcherDeploy } from "../src/main/features/notifications/watcher-deploy/engine"
import type { ArmRequest, ArmResponse } from "../src/main/azure/arm"
import { watcherAlertsHash } from "../src/shared/notifications/alerts"
import { auditWatchOf } from "../src/main/features/notifications/service"
import { call, fakeDeps, TENANT_A } from "./feature-helpers"

const PATH = "/api/notifications"
const SUBSCRIPTION = "22222222-2222-4222-8222-222222222222"
const PRINCIPAL = "33333333-3333-4333-8333-333333333333"
const GRAPH_SP = "44444444-4444-4444-8444-444444444444"
const NOW = new Date("2026-11-07T12:00:00.000Z")
const TEAMS_SECRET = "https://contoso.webhook.office.com/workflows/secret-sentinel"

type Heartbeat = { runAt: string; lastError: string | null; alertsHash: string | null; identityPrincipalId?: string | null; jobId?: string | null }

class FakeArm {
  calls: ArmRequest[] = []
  order: string[] = []
  accountExists: boolean
  tenantId = TENANT_A
  storageFirewall = false
  failureAlert = true
  failureAlertEnabled = true
  failureAlertOperator = "Include"
  failureAlertExtraCriterion = false
  failureAlertRunbookDimension: string | null = null
  scheduleLinked = true
  runbookVersion = "1.3.0"
  duplicateWatcher = false
  accountStatus = 200
  storagePaged = false
  deploymentOutcome = "Succeeded"
  deploymentMissing = false
  deploymentPutStatus: number | null = null
  jobStatus = "Completed"
  jobPutStatus: number | null = null
  lastJobId: string | null = null
  throwJobGet = false
  roles = true
  deploymentPuts = 0
  jobPuts = 0
  constructor(private readonly heartbeat: { current: Heartbeat | null; nextError: string | null }, options: { accountExists?: boolean } = {}) {
    this.accountExists = options.accountExists ?? true
  }

  call = async (_tenant: string, request: ArmRequest): Promise<ArmResponse> => {
    this.calls.push(request)
    const path = request.path
    const ok = (body: unknown, status = 200): ArmResponse => ({ status, body, retryAfterSeconds: null })
    if (path.startsWith(`/subscriptions/${SUBSCRIPTION}?`)) return ok({ subscriptionId: SUBSCRIPTION, tenantId: this.tenantId, state: "Enabled", subscriptionPolicies: { quotaId: "PayAsYouGo_2014-09-01" } })
    if (path.includes("/resourcegroups/rg-tenuvault-backups?") || path.includes("/resourceGroups/rg-tenuvault-backups?")) return ok({ name: "rg-tenuvault-backups", location: "westeurope" })
    if (path.includes("/providers/Microsoft.Storage/storageAccounts?")) {
      if (this.storagePaged && !path.includes("$skiptoken=page2")) {
        return ok({ value: [], nextLink: `https://management.azure.com/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Storage/storageAccounts?api-version=2023-05-01&$skiptoken=page2` })
      }
      return ok({ value: [{ id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-tenuvault-backups/providers/Microsoft.Storage/storageAccounts/tvbkp1234567890ab`, name: "tvbkp1234567890ab", location: "westeurope", properties: { publicNetworkAccess: "Enabled", networkAcls: { defaultAction: this.storageFirewall ? "Deny" : "Allow" } } }] })
    }
    if (path.includes("/providers/Microsoft.Authorization/permissions")) {
      return ok({ value: [this.roles ? { actions: ["*"], notActions: [], dataActions: ["*"], notDataActions: [] } : { actions: ["*/read"], notActions: [], dataActions: [], notDataActions: [] }] })
    }
    if (path.includes("/providers/Microsoft.Automation?") || path.includes("/providers/Microsoft.Insights?")) return ok({ registrationState: "Registered" })
    if (path.includes("/resources?")) return ok({ value: this.accountExists ? [{ id: this.accountId(), name: "aa-tenuvault-notifications", location: "westeurope", type: "Microsoft.Automation/automationAccounts" }, ...(this.duplicateWatcher ? [{ id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-other/providers/Microsoft.Automation/automationAccounts/aa-tenuvault-notifications`, name: "aa-tenuvault-notifications", location: "westeurope", type: "Microsoft.Automation/automationAccounts" }] : [])] : [] })
    if (path.includes("/deployments/") && path.endsWith("/validate?api-version=2022-09-01")) { this.order.push("validate"); return ok({ properties: { provisioningState: "Succeeded" } }) }
    if (path.includes("/deployments/")) {
      if (request.method === "PUT") {
        this.deploymentPuts++
        this.order.push("deploy")
        if (this.deploymentPutStatus !== null) return ok({ error: { message: "temporarily unavailable" } }, this.deploymentPutStatus)
        if (!this.deploymentMissing) this.accountExists = true
        return ok({ properties: { provisioningState: this.deploymentOutcome, outputs: { managedIdentityPrincipalId: { value: PRINCIPAL } }, ...(this.deploymentOutcome === "Failed" ? { error: { message: "a resource failed" } } : {}) } }, 201)
      }
      if (request.method === "POST" && path.includes("/cancel")) return ok({}, 204)
      if (this.deploymentMissing) return ok({ error: { message: "not found" } }, 404)
      return ok({ properties: { provisioningState: this.deploymentOutcome, outputs: { managedIdentityPrincipalId: { value: PRINCIPAL } }, ...(this.deploymentOutcome === "Failed" ? { error: { message: "a resource failed" } } : {}) } })
    }
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/jobs/")) {
      if (request.method === "GET" && this.throwJobGet) throw new Error("network down")
      if (request.method === "PUT") {
        this.jobPuts++
        this.order.push("job")
        this.lastJobId = decodeURIComponent(path.split("/jobs/")[1]?.split("?")[0] ?? "")
        if (this.heartbeat.current) this.heartbeat.current = { ...this.heartbeat.current, runAt: NOW.toISOString(), lastError: this.heartbeat.nextError, identityPrincipalId: this.runbookVersion === "1.3.0" ? PRINCIPAL : null, jobId: this.runbookVersion === "1.3.0" ? this.lastJobId : null }
        return ok({ properties: { status: this.jobStatus } }, this.jobPutStatus ?? 201)
      }
      return ok({ properties: { status: this.jobStatus } })
    }
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/variables")) {
      const value = (name: string, raw: string) => ({ name, properties: { value: raw, isEncrypted: false } })
      return ok({ value: [value("TenuVaultTenantId", JSON.stringify(TENANT_A)), value("TenuVaultStorageAccount", JSON.stringify("tvbkp1234567890ab")), value("TenuVaultWatchConditionalAccess", "true")] })
    }
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/runbooks/")) return this.accountExists ? ok({ properties: { state: "Published" } }) : ok({ error: { message: "not found" } }, 404)
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/jobSchedules")) return ok({ value: this.scheduleLinked ? [{ properties: { runbook: { name: "Invoke-TenuVaultNotificationCheck" }, schedule: { name: "TenuVaultNotificationCheck" } } }] : [] })
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/schedules")) return ok({ value: [{ name: "TenuVaultNotificationCheck", properties: { isEnabled: true, nextRun: "2026-11-07T12:15:00.000Z", expiryTime: "9999-12-31T00:00:00.000Z" } }] })
    if (path.includes("/automationAccounts/aa-tenuvault-notifications")) {
      if (this.accountStatus !== 200) return ok({ error: { message: "temporarily unavailable" } }, this.accountStatus)
      return this.accountExists ? ok({ id: this.accountId(), name: "aa-tenuvault-notifications", location: "westeurope", identity: { type: "SystemAssigned", principalId: PRINCIPAL, tenantId: TENANT_A } }) : ok({ error: { message: "not found" } }, 404)
    }
    if (path.includes("/microsoft.insights/actionGroups/")) return ok({ properties: { enabled: true, emailReceivers: [{ emailAddress: "ops@contoso.test", status: "Enabled" }] } })
    if (path.includes("/microsoft.insights/metricAlerts/")) return this.failureAlert ? ok({ name: "TenuVault watcher failed jobs", properties: { enabled: this.failureAlertEnabled, scopes: [this.accountId()], criteria: { allOf: [{ metricName: "TotalJob", metricNamespace: "Microsoft.Automation/automationAccounts", operator: "GreaterThan", threshold: 0, timeAggregation: "Total", criterionType: "StaticThresholdCriterion", dimensions: [{ name: "Status", operator: this.failureAlertOperator, values: ["Failed"] }, ...(this.failureAlertRunbookDimension ? [{ name: "Runbook", operator: "Include", values: [this.failureAlertRunbookDimension] }] : [])] }, ...(this.failureAlertExtraCriterion ? [{ metricName: "TotalJob", metricNamespace: "Microsoft.Automation/automationAccounts", operator: "GreaterThan", threshold: 999, timeAggregation: "Total", criterionType: "StaticThresholdCriterion", dimensions: [{ name: "Status", operator: "Include", values: ["Completed"] }] }] : [])] }, actions: [{ actionGroupId: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-tenuvault-backups/providers/microsoft.insights/actionGroups/ag-tenuvault-watcher` }] } }) : ok({ error: { message: "not found" } }, 404)
    return ok({ error: { message: `unhandled ${path}` } }, 404)
  }

  private accountId() {
    return `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-tenuvault-backups/providers/Microsoft.Automation/automationAccounts/aa-tenuvault-notifications`
  }
}

function graphUnknown() {
  return () => async () => ({ status: 403, body: { error: { code: "Authorization_RequestDenied", message: "insufficient privileges" } } }) as never
}

function graphVerified() {
  return () => async (_method: string, path: string) => {
    if (path.startsWith("servicePrincipals?")) return { status: 200, body: { value: [{ id: GRAPH_SP, appRoles: [{ id: "role-intune", value: "DeviceManagementApps.Read.All", allowedMemberTypes: ["Application"] }, { id: "role-audit", value: "AuditLog.Read.All", allowedMemberTypes: ["Application"] }] }] } } as never
    if (path.includes("/appRoleAssignments")) return { status: 200, body: { value: [{ resourceId: GRAPH_SP, appRoleId: "role-intune" }, { resourceId: GRAPH_SP, appRoleId: "role-audit" }] } } as never
    return { status: 404, body: {} } as never
  }
}

function graphGranting() {
  let assigned = false
  return () => async (method: string, path: string) => {
    if (path.startsWith("servicePrincipals?")) return { status: 200, body: { value: [{ id: GRAPH_SP, appRoles: [{ id: "role-intune", value: "DeviceManagementApps.Read.All", allowedMemberTypes: ["Application"] }, { id: "role-audit", value: "AuditLog.Read.All", allowedMemberTypes: ["Application"] }] }] } } as never
    if (method === "POST" && path.includes("/appRoleAssignments")) { assigned = true; return { status: 201, body: {} } as never }
    if (path.includes("/appRoleAssignments")) return { status: 200, body: { value: assigned ? [{ resourceId: GRAPH_SP, appRoleId: "role-intune" }, { resourceId: GRAPH_SP, appRoleId: "role-audit" }] : [] } } as never
    return { status: 404, body: {} } as never
  }
}

async function world(options: { accountExists?: boolean; graph?: unknown } = {}) {
  const heartbeat: { current: Heartbeat | null; nextError: string | null; readsAfterJob: number; failAfterReads: number | null } = { current: null, nextError: null, readsAfterJob: 0, failAfterReads: null }
  const nowState = { current: new Date(NOW) }
  const arm = new FakeArm(heartbeat, options)
  const deps = fakeDeps({
    plans: { [TENANT_A]: "pro" },
    now: () => nowState.current,
    tenant: () => ({ tenantId: TENANT_A, name: "Contoso", clientId: "99999999-9999-9999-9999-999999999999", storageAccountName: "tvbkp1234567890ab" }),
    graph: (options.graph ?? graphUnknown()) as never,
    arm: arm.call,
    watcherHeartbeat: async () => {
      if (arm.jobPuts > 0) {
        heartbeat.readsAfterJob++
        if (heartbeat.failAfterReads !== null && heartbeat.readsAfterJob > heartbeat.failAfterReads) {
          return { status: "ok", runAt: heartbeat.current?.runAt ?? NOW.toISOString(), lastError: "later failure", alertsHash: heartbeat.current?.alertsHash ?? null, runbookVersion: arm.runbookVersion, alertsSource: "storage", identityPrincipalId: heartbeat.current?.identityPrincipalId ?? (arm.runbookVersion === "1.3.0" ? PRINCIPAL : null), jobId: heartbeat.current?.jobId ?? (arm.runbookVersion === "1.3.0" ? arm.lastJobId : null) }
        }
      }
      return heartbeat.current ? { status: "ok", runAt: heartbeat.current.runAt, lastError: heartbeat.current.lastError, alertsHash: heartbeat.current.alertsHash, runbookVersion: arm.runbookVersion, alertsSource: "storage", identityPrincipalId: heartbeat.current?.identityPrincipalId ?? (arm.runbookVersion === "1.3.0" ? PRINCIPAL : null), jobId: heartbeat.current?.jobId ?? (arm.runbookVersion === "1.3.0" ? arm.lastJobId : null) } : { status: "missing" }
    },
    watcherAlertsWrite: async (_tenant, text) => {
      arm.order.push("alerts")
      heartbeat.current = { runAt: "2026-11-07T11:00:00.000Z", lastError: null, alertsHash: watcherAlertsHash(JSON.parse(text)) }
      return { status: "ok" }
    },
  })
  const api = routes(deps)
  const channel = (await call(api, PATH, { tenantId: TENANT_A, action: "add-channel", kind: "teams", url: TEAMS_SECRET })).body.channel
  await call(api, PATH, { tenantId: TENANT_A, action: "add-rule", title: "Changes", eventTypes: ["intune.change", "entra.change", "backup.failed"], channelIds: [channel.id] })
  await call(api, PATH, { tenantId: TENANT_A, action: "update-audit-watch", enabled: true, conditionalAccessEnabled: true })
  return { deps, api, arm, heartbeat, channel, nowState }
}

const planBody = {
  subscriptionId: SUBSCRIPTION,
  resourceGroupName: "rg-tenuvault-backups",
  automationAccountName: "aa-tenuvault-notifications",
  location: "westeurope",
  alertEmail: "ops@contoso.test",
  destinationKinds: ["teams"],
  needsConditionalAccess: true,
  createIfMissing: true,
}

async function startDeploy(w: Awaited<ReturnType<typeof world>>, ack: unknown, overrides: Record<string, unknown> = {}) {
  const plan = { ...planBody, ...overrides }
  const preflight = (await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...plan })).body
  return call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-start", ...plan, planHash: preflight.planHash, ack })
}

async function drive(w: Awaited<ReturnType<typeof world>>) {
  let view: any = null
  for (let attempt = 0; attempt < 30; attempt++) {
    view = await advanceWatcherDeploy(w.deps, TENANT_A, "Admin")
    if (!view || ["complete", "blocked", "failed", "cancelled"].includes(view.state)) break
  }
  return view
}

describe("watcher deployment preflight", () => {
  it("finds the existing watcher with reads only", async () => {
    const w = await world()
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(result.status).toBe(200)
    expect(result.body.existing).toMatchObject({ found: true, principalId: PRINCIPAL, scheduleLinked: true, failureAlert: true })
    expect(result.body.capabilities).toMatchObject({ canDeploy: true, canStartJobs: true })
    expect(result.body.planHash).toEqual(expect.any(String))
    expect(w.arm.calls.every((entry) => entry.method === "GET")).toBe(true)
  })

  it("blocks a subscription from another directory and a firewalled storage account", async () => {
    const w = await world()
    w.arm.tenantId = "99999999-9999-4999-8999-999999999999"
    w.arm.storageFirewall = true
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(result.body.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "block", code: "subscription-tenant" }),
      expect.objectContaining({ severity: "block", code: "storage-firewall" }),
    ]))
  })

  it("treats a transient account read as incomplete discovery, never as absence", async () => {
    const w = await world()
    w.arm.accountStatus = 503
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(result.body.existing.found).toBe(false)
    expect(result.body.findings).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", code: "discovery-incomplete" })]))
  })

  it("follows ARM list pages before judging storage", async () => {
    const w = await world()
    w.arm.storagePaged = true
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(result.body.findings.map((finding: { code: string }) => finding.code)).not.toContain("storage-missing")
    expect(result.body.findings.map((finding: { code: string }) => finding.code)).not.toContain("storage-read")
  })

  it("does not let a disabled failure alert satisfy the check", async () => {
    const w = await world()
    w.arm.failureAlertEnabled = false
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(result.body.existing.failureAlert).toBe(false)
    expect(result.body.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "failure-alert-missing" })]))
  })

  it("does not let a failure alert that excludes failed jobs satisfy the check", async () => {
    const w = await world()
    w.arm.failureAlertOperator = "Exclude"
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(result.body.existing.failureAlert).toBe(false)
    expect(result.body.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "failure-alert-missing" })]))
  })

  it("rejects failure alerts narrowed by another condition or another runbook", async () => {
    const extra = await world()
    extra.arm.failureAlertExtraCriterion = true
    const extraResult = await call(extra.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(extraResult.body.existing.failureAlert).toBe(false)

    const otherRunbook = await world()
    otherRunbook.arm.failureAlertRunbookDimension = "SomeOtherRunbook"
    const otherResult = await call(otherRunbook.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(otherResult.body.existing.failureAlert).toBe(false)

    const namedRunbook = await world()
    namedRunbook.arm.failureAlertRunbookDimension = "Invoke-TenuVaultNotificationCheck"
    const namedResult = await call(namedRunbook.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(namedResult.body.existing.failureAlert).toBe(true)
  })

  it("detects another watcher even when the named account exists", async () => {
    const w = await world()
    w.arm.duplicateWatcher = true
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    expect(result.body.existing.found).toBe(true)
    expect(result.body.findings).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", code: "multiple-watchers" })]))
  })

  it("ignores a stale heartbeat from a deleted watcher", async () => {
    const w = await world({ accountExists: false })
    w.deps.watcherHeartbeat = async () => ({ status: "ok", runAt: "2026-10-01T00:00:00.000Z", lastError: null, alertsHash: "old", runbookVersion: "1.0.0", alertsSource: "storage" })
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })
    const codes = result.body.findings.map((finding: { code: string }) => finding.code)
    expect(codes).not.toContain("unseen-watcher")
    expect(codes).not.toContain("runbook-version")
  })

  it("keeps watcher email creation on the script path", async () => {
    const w = await world({ accountExists: false })
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody, destinationKinds: ["mail"] })
    expect(result.body.findings).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", code: "mail-create" })]))
  })
})

describe("watcher deployment engine", () => {
  it("adopts after alerts, one test job and a clean heartbeat; never deploys over an existing watcher", async () => {
    const w = await world()
    const preflight = (await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-preflight", ...planBody })).body
    const started = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-start", ...planBody, planHash: preflight.planHash, ack: { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true } })
    expect(started.status).toBe(200)
    const view = await drive(w)
    expect(view).toMatchObject({ state: "complete", mode: "adopt" })
    expect(w.arm.deploymentPuts).toBe(0)
    expect(w.arm.order.indexOf("alerts")).toBeLessThan(w.arm.order.indexOf("job"))
    expect(auditWatchOf(w.deps, TENANT_A)).toMatchObject({ externalWatcher: true, watcherAlertsSync: { auto: true } })
  })

  it("stops at the Graph role boundary with a snippet and starts no job", async () => {
    const w = await world()
    const started = await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: false })
    const view = await drive(w)
    expect(view).toMatchObject({ state: "blocked", blockedReason: "needs-admin" })
    expect(view.grantSnippet).toContain(PRINCIPAL)
    expect(w.arm.jobPuts).toBe(0)
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
    expect(started.body.job.id).toEqual(expect.any(String))
  })

  it("does not hand over on a 403 heartbeat, then completes after an explicit recheck", async () => {
    const w = await world()
    w.heartbeat.nextError = "HTTP 403 from Microsoft Graph"
    await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    const blocked = await drive(w)
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "roles-not-effective" })
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
    w.heartbeat.nextError = null
    const resumed = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-resume", jobId: blocked.id })
    expect(resumed.status).toBe(200)
    const view = await drive(w)
    expect(view.state).toBe("complete")
    expect(w.arm.jobPuts).toBe(2)
  })

  it("creates once with the copied Teams secret only in the ARM request, never in records or views", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const w = await world({ accountExists: false, graph: graphVerified() })
      await startDeploy(w, { destinationConfirmed: false, copyDestinationKinds: ["teams"], grantRoles: false, rolesConfirmed: false }, { location: "West Europe" })
      const view = await drive(w)
      expect(view).toMatchObject({ state: "complete", mode: "create" })
      expect(w.arm.deploymentPuts).toBe(1)
      const deployment = w.arm.calls.find((entry) => entry.method === "PUT" && entry.path.includes("/deployments/"))!
      expect(JSON.stringify(deployment.body)).toContain("secret-sentinel")
      expect(JSON.stringify(view)).not.toContain("secret-sentinel")
      expect(JSON.stringify(w.deps.records.list(DOMAINS.notificationWatcherDeploy, TENANT_A))).not.toContain("secret-sentinel")
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-sentinel")
      // A later advance is a no-op: the first-deployment template is never submitted again.
      await advanceWatcherDeploy(w.deps, TENANT_A, "Admin")
      expect(w.arm.deploymentPuts).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("refuses to start without the confirmed plan hash", async () => {
    const w = await world()
    const result = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-start", ...planBody, ack: { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true } })
    expect(result.status).toBe(409)
    expect(w.deps.records.list(DOMAINS.notificationWatcherDeploy, TENANT_A)).toEqual([])
  })

  it("persists a thrown step error instead of leaving a runner-less running setup", async () => {
    const w = await world()
    w.arm.throwJobGet = true
    await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    const view = await drive(w)
    expect(view).toMatchObject({ state: "failed" })
    expect(view.error).toContain("network down")
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("rechecks the heartbeat immediately before hand-over", async () => {
    const w = await world()
    w.heartbeat.failAfterReads = 1
    await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    const view = await drive(w)
    expect(view.state).not.toBe("complete")
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("does not treat a partly failed deployment as destination evidence", async () => {
    const w = await world({ accountExists: false, graph: graphVerified() })
    w.arm.deploymentOutcome = "Failed"
    await startDeploy(w, { destinationConfirmed: false, copyDestinationKinds: ["teams"], grantRoles: false, rolesConfirmed: false })
    const view = await drive(w)
    expect(view).toMatchObject({ state: "blocked", blockedReason: "needs-destination" })
    expect(w.arm.deploymentPuts).toBe(1)
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("bounds a deployment that never appears and submits another only after an exact absence check", async () => {
    const w = await world({ accountExists: false, graph: graphVerified() })
    w.arm.deploymentMissing = true
    await startDeploy(w, { destinationConfirmed: false, copyDestinationKinds: ["teams"], grantRoles: false, rolesConfirmed: false })
    await advanceWatcherDeploy(w.deps, TENANT_A, "Admin")
    await advanceWatcherDeploy(w.deps, TENANT_A, "Admin")
    w.nowState.current = new Date(NOW.getTime() + 3 * 60_000)
    await drive(w)
    expect(w.arm.deploymentPuts).toBeGreaterThanOrEqual(2)
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("grants only the missing Graph roles when the admin approved it", async () => {
    const w = await world({ graph: graphGranting() })
    await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: true, rolesConfirmed: false })
    const view = await drive(w)
    expect(view).toMatchObject({ state: "complete", graphRoleStatus: "verified" })
  })

  it("marks a running setup interrupted at startup and resumes it", async () => {
    const w = await world()
    const started = await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: false })
    await drive(w)
    const record = w.deps.records.list(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]!
    w.deps.records.update(DOMAINS.notificationWatcherDeploy, TENANT_A, record.id, (value: any) => ({ ...value, state: "running", status: "running" }), { actor: "test", reason: "test restart" })
    markInterruptedWatcherDeploys(w.deps)
    expect(w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0].state).toBe("interrupted")
    const resumed = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-resume", jobId: started.body.job.id })
    expect(resumed.status).toBe(200)
    expect((await drive(w))).toMatchObject({ state: "blocked", blockedReason: "needs-admin" })
  })

  it("completes a pending hand-over from a later clean scheduled heartbeat without another job", async () => {
    const w = await world()
    w.heartbeat.nextError = "HTTP 403 from Microsoft Graph"
    await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    const blocked = await drive(w)
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "roles-not-effective" })
    const jobs = w.arm.jobPuts
    w.heartbeat.current = { ...w.heartbeat.current!, lastError: null }
    const record = w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]!
    w.deps.records.update(DOMAINS.notificationWatcherDeploy, TENANT_A, record.id, (value: any) => ({ ...value, nextAttemptAt: "2026-11-07T11:00:00.000Z" }), { actor: "test", reason: "test retry due" })
    await resumePendingWatcherHandovers(w.deps)
    expect(w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0].state).toBe("complete")
    expect(w.arm.jobPuts).toBe(jobs)
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(true)
  })

  it("moves from a failed Graph test job to scheduled-run verification", async () => {
    const w = await world()
    w.arm.jobStatus = "Failed"
    w.heartbeat.nextError = "HTTP 403 from Microsoft Graph"
    await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    const blocked = await drive(w)
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "roles-not-effective" })
    const jobs = w.arm.jobPuts
    w.heartbeat.current = { ...w.heartbeat.current!, lastError: null, identityPrincipalId: PRINCIPAL, jobId: "66666666-6666-4666-8666-666666666666" }
    const record = w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]!
    w.deps.records.update(DOMAINS.notificationWatcherDeploy, TENANT_A, record.id, (value: any) => ({ ...value, nextAttemptAt: "2026-11-07T11:00:00.000Z" }), { actor: "test", reason: "test retry due" })
    await resumePendingWatcherHandovers(w.deps)
    expect(w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0].state).toBe("complete")
    expect(w.arm.jobPuts).toBe(jobs)
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(true)
  })

  it("writes alerts for a partly created watcher before the Graph boundary", async () => {
    const w = await world({ accountExists: false })
    w.arm.deploymentOutcome = "Failed"
    await startDeploy(w, { destinationConfirmed: false, copyDestinationKinds: ["teams"], grantRoles: false, rolesConfirmed: false })
    const view = await drive(w)
    expect(view).toMatchObject({ state: "blocked", blockedReason: "needs-admin" })
    expect(w.arm.order).toContain("alerts")
    expect(view.alertsHash).toEqual(expect.any(String))
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("keeps copied-destination evidence across a desktop delivery record update", async () => {
    const w = await world({ accountExists: false, graph: graphVerified() })
    await startDeploy(w, { destinationConfirmed: false, copyDestinationKinds: ["teams"], grantRoles: false, rolesConfirmed: false })
    for (let attempt = 0; attempt < 10 && w.arm.deploymentPuts === 0; attempt++) await advanceWatcherDeploy(w.deps, TENANT_A, "Admin")
    expect(w.arm.deploymentPuts).toBe(1)
    w.nowState.current = new Date(NOW.getTime() + 1000)
    const delivery = { at: w.nowState.current.toISOString(), ok: true, attempts: 1, status: 202, error: null, test: false }
    w.deps.records.update(DOMAINS.notificationChannels, TENANT_A, w.channel.id, (value: any) => ({ ...value, lastDelivery: delivery, deliveries: [delivery] }), { actor: "test", reason: "test delivery" })
    expect(w.deps.records.list<any>(DOMAINS.notificationChannels, TENANT_A)[0].updatedAt).toBe(w.nowState.current.toISOString())
    w.nowState.current = new Date(NOW)
    const view = await drive(w)
    expect(view.state).toBe("complete")
    expect(JSON.stringify(w.deps.records.list(DOMAINS.notificationWatcherDeploy, TENANT_A))).not.toContain("secret-sentinel")
  })

  it("reconciles ambiguous 5xx deployment and job submissions instead of submitting twice", async () => {
    const create = await world({ accountExists: false, graph: graphVerified() })
    create.arm.deploymentPutStatus = 503
    await startDeploy(create, { destinationConfirmed: false, copyDestinationKinds: ["teams"], grantRoles: false, rolesConfirmed: false })
    let deploymentView: any = null
    for (let attempt = 0; attempt < 10 && create.arm.deploymentPuts === 0; attempt++) deploymentView = await advanceWatcherDeploy(create.deps, TENANT_A, "Admin")
    expect(deploymentView.state).toBe("running")
    expect(create.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0].deploymentName).toEqual(expect.any(String))
    expect(create.arm.deploymentPuts).toBe(1)

    const adopt = await world()
    adopt.arm.jobPutStatus = 503
    await startDeploy(adopt, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    let jobView: any = null
    for (let attempt = 0; attempt < 15 && adopt.arm.jobPuts === 0; attempt++) jobView = await advanceWatcherDeploy(adopt.deps, TENANT_A, "Admin")
    expect(jobView.state).toBe("running")
    expect(jobView.automationJobId).toEqual(expect.any(String))
    adopt.arm.jobPutStatus = null
    expect((await drive(adopt)).state).toBe("complete")
    expect(adopt.arm.jobPuts).toBe(1)
  })

  it("leaves no runner-less running setup when pending continuation returns to alerts", async () => {
    const w = await world()
    w.heartbeat.nextError = "HTTP 403 from Microsoft Graph"
    await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    await drive(w)
    w.heartbeat.current = { ...w.heartbeat.current!, lastError: null, identityPrincipalId: PRINCIPAL, jobId: "66666666-6666-4666-8666-666666666666" }
    await call(w.api, PATH, { tenantId: TENANT_A, action: "add-rule", title: "Backup failures", eventTypes: ["backup.failed"], channelIds: [w.channel.id] })
    const record = w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]!
    w.deps.records.update(DOMAINS.notificationWatcherDeploy, TENANT_A, record.id, (value: any) => ({ ...value, nextAttemptAt: "2026-11-07T11:00:00.000Z" }), { actor: "test", reason: "test retry due" })
    await resumePendingWatcherHandovers(w.deps)
    expect(w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]).toMatchObject({ state: "interrupted", phase: "alerts" })
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("does not let resume, confirm or start clear a pending cancellation", async () => {
    const w = await world()
    const started = await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: false })
    await drive(w)
    const record = w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]!
    w.deps.records.update(DOMAINS.notificationWatcherDeploy, TENANT_A, record.id, (value: any) => ({ ...value, cancelRequestedAt: NOW.toISOString() }), { actor: "test", reason: "test cancel pending" })
    expect((await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-resume", jobId: started.body.job.id })).status).toBe(409)
    expect((await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-confirm", jobId: started.body.job.id, confirmation: "roles" })).status).toBe(409)
    expect((await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })).status).toBe(409)
    expect(w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0].cancelRequestedAt).toBe(NOW.toISOString())
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("stops a partly created watcher at its real blocker after writing alerts, then checks Azure again on continue", async () => {
    const w = await world({ accountExists: false, graph: graphGranting() })
    w.arm.deploymentOutcome = "Failed"
    w.arm.scheduleLinked = false
    const started = await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: ["teams"], grantRoles: true, rolesConfirmed: false })
    const blocked = await drive(w)
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "schedule-missing" })
    expect(w.arm.order).toContain("alerts")
    expect(w.arm.jobPuts).toBe(0)
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)

    w.arm.scheduleLinked = true
    const resumed = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-resume", jobId: started.body.job.id })
    expect(resumed.status).toBe(200)
    expect((await drive(w)).state).toBe("complete")
    expect(w.arm.jobPuts).toBe(1)
  })

  it("does not hand over alerts changed during the final Azure and heartbeat reads", async () => {
    const w = await world()
    await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    let record: any = null
    for (let attempt = 0; attempt < 20; attempt++) {
      await advanceWatcherDeploy(w.deps, TENANT_A, "Admin")
      record = w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]
      if (record.phase === "hand-over") break
    }
    expect(record.phase).toBe("hand-over")
    const originalHeartbeat = w.deps.watcherHeartbeat!
    let changed = false
    w.deps.watcherHeartbeat = async (tenantId) => {
      const result = await originalHeartbeat(tenantId)
      if (!changed) {
        changed = true
        await call(w.api, PATH, { tenantId: TENANT_A, action: "add-rule", title: "Changed during hand-over", eventTypes: ["backup.failed"], channelIds: [w.channel.id] })
      }
      return result
    }
    const raced = await advanceWatcherDeploy(w.deps, TENANT_A, "Admin")
    expect(raced?.state).toBe("running")
    expect(w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0].phase).toBe("alerts")
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("starts a fresh test job after an old runbook is upgraded", async () => {
    const w = await world()
    w.arm.runbookVersion = "1.2.0"
    const started = await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    const blocked = await drive(w)
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "runbook-version" })
    expect(w.arm.jobPuts).toBe(1)
    w.arm.runbookVersion = "1.3.0"
    const resumed = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-resume", jobId: started.body.job.id })
    expect(resumed.status).toBe(200)
    expect((await drive(w)).state).toBe("complete")
    expect(w.arm.jobPuts).toBe(2)
  })

  it("finalizes a cancellation that was interrupted by the app closing", async () => {
    const w = await world()
    await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: false })
    await drive(w)
    const record = w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]!
    w.deps.records.update(DOMAINS.notificationWatcherDeploy, TENANT_A, record.id, (value: any) => ({ ...value, state: "running", status: "running", cancelRequestedAt: NOW.toISOString() }), { actor: "test", reason: "test interrupted cancellation" })
    markInterruptedWatcherDeploys(w.deps)
    expect(w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0].state).toBe("cancelled")
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("does not park an admin continuation that lands during the periodic check", async () => {
    const w = await world()
    w.heartbeat.nextError = "HTTP 403 from Microsoft Graph"
    const started = await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    const blocked = await drive(w)
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "roles-not-effective" })
    w.heartbeat.current = { ...w.heartbeat.current!, lastError: null, alertsHash: "other-alerts", identityPrincipalId: PRINCIPAL, jobId: "66666666-6666-4666-8666-666666666666" }
    const record = w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]!
    w.deps.records.update(DOMAINS.notificationWatcherDeploy, TENANT_A, record.id, (value: any) => ({ ...value, nextAttemptAt: "2026-11-07T11:00:00.000Z" }), { actor: "test", reason: "test retry due" })
    const originalHeartbeat = w.deps.watcherHeartbeat!
    let resumePromise: Promise<any> | null = null
    w.deps.watcherHeartbeat = async (tenantId) => {
      const result = await originalHeartbeat(tenantId)
      resumePromise ??= resumeWatcherDeploy(w.deps, TENANT_A, "Admin", started.body.job.id)
      return result
    }
    await resumePendingWatcherHandovers(w.deps)
    expect(resumePromise).not.toBeNull()
    expect((await resumePromise!).state).toBe("running")
    expect(w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0].state).toBe("running")
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })

  it("rechecks Azure after a blocker found during final hand-over", async () => {
    const w = await world()
    const started = await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true })
    let record: any = null
    for (let attempt = 0; attempt < 20; attempt++) {
      await advanceWatcherDeploy(w.deps, TENANT_A, "Admin")
      record = w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0]
      if (record.phase === "hand-over") break
    }
    expect(record.phase).toBe("hand-over")
    w.arm.scheduleLinked = false
    const blocked = await advanceWatcherDeploy(w.deps, TENANT_A, "Admin")
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "schedule-missing" })
    expect(w.deps.records.list<any>(DOMAINS.notificationWatcherDeploy, TENANT_A)[0].phase).toBe("discover")
    w.arm.scheduleLinked = true
    const resumed = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-resume", jobId: started.body.job.id })
    expect(resumed.status).toBe(200)
    expect((await drive(w)).state).toBe("complete")
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(true)
  })

  it("cancels a setup without handing over", async () => {
    const w = await world()
    const started = await startDeploy(w, { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: false })
    await drive(w)
    const cancelled = await call(w.api, PATH, { tenantId: TENANT_A, action: "revoke-watcher-deploy", jobId: started.body.job.id })
    expect(cancelled.body.job.state).toBe("cancelled")
    expect(auditWatchOf(w.deps, TENANT_A)?.externalWatcher).toBe(false)
  })
})
