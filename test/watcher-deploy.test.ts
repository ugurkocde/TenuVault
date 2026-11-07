import { describe, expect, it, vi } from "vitest"
import { routes } from "../src/main/features/notifications"
import { DOMAINS } from "../src/main/features/domains"
import { advanceWatcherDeploy } from "../src/main/features/notifications/watcher-deploy/engine"
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

type Heartbeat = { runAt: string; lastError: string | null; alertsHash: string | null }

class FakeArm {
  calls: ArmRequest[] = []
  order: string[] = []
  accountExists: boolean
  tenantId = TENANT_A
  storageFirewall = false
  failureAlert = true
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
      return ok({ value: [{ id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-tenuvault-backups/providers/Microsoft.Storage/storageAccounts/tvbkp1234567890ab`, name: "tvbkp1234567890ab", location: "westeurope", properties: { publicNetworkAccess: "Enabled", networkAcls: { defaultAction: this.storageFirewall ? "Deny" : "Allow" } } }] })
    }
    if (path.includes("/providers/Microsoft.Authorization/permissions")) {
      return ok({ value: [this.roles ? { actions: ["*"], notActions: [], dataActions: ["*"], notDataActions: [] } : { actions: ["*/read"], notActions: [], dataActions: [], notDataActions: [] }] })
    }
    if (path.includes("/providers/Microsoft.Automation?") || path.includes("/providers/Microsoft.Insights?")) return ok({ registrationState: "Registered" })
    if (path.includes("/resources?")) return ok({ value: this.accountExists ? [{ id: this.accountId(), name: "aa-tenuvault-notifications", location: "westeurope", type: "Microsoft.Automation/automationAccounts" }] : [] })
    if (path.includes("/deployments/") && path.endsWith("/validate?api-version=2022-09-01")) { this.order.push("validate"); return ok({ properties: { provisioningState: "Succeeded" } }) }
    if (path.includes("/deployments/")) {
      if (request.method === "PUT") {
        this.deploymentPuts++
        this.order.push("deploy")
        this.accountExists = true
        return ok({ properties: { provisioningState: "Succeeded", outputs: { managedIdentityPrincipalId: { value: PRINCIPAL } } } }, 201)
      }
      if (request.method === "POST" && path.includes("/cancel")) return ok({}, 204)
      return ok({ properties: { provisioningState: "Succeeded", outputs: { managedIdentityPrincipalId: { value: PRINCIPAL } } } })
    }
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/jobs/")) {
      if (request.method === "PUT") {
        this.jobPuts++
        this.order.push("job")
        if (this.heartbeat.current) this.heartbeat.current = { ...this.heartbeat.current, runAt: NOW.toISOString(), lastError: this.heartbeat.nextError }
        return ok({ properties: { status: "Completed" } }, 201)
      }
      return ok({ properties: { status: "Completed" } })
    }
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/variables")) {
      const value = (name: string, raw: string) => ({ name, properties: { value: raw, isEncrypted: false } })
      return ok({ value: [value("TenuVaultTenantId", JSON.stringify(TENANT_A)), value("TenuVaultStorageAccount", JSON.stringify("tvbkp1234567890ab")), value("TenuVaultWatchConditionalAccess", "true")] })
    }
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/runbooks/")) return this.accountExists ? ok({ properties: { state: "Published" } }) : ok({ error: { message: "not found" } }, 404)
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/jobSchedules")) return ok({ value: [{ properties: { runbook: { name: "Invoke-TenuVaultNotificationCheck" }, schedule: { name: "TenuVaultNotificationCheck" } } }] })
    if (path.includes("/automationAccounts/aa-tenuvault-notifications/schedules")) return ok({ value: [{ name: "TenuVaultNotificationCheck", properties: { isEnabled: true, nextRun: "2026-11-07T12:15:00.000Z", expiryTime: "9999-12-31T00:00:00.000Z" } }] })
    if (path.includes("/automationAccounts/aa-tenuvault-notifications")) {
      return this.accountExists ? ok({ id: this.accountId(), name: "aa-tenuvault-notifications", location: "westeurope", identity: { type: "SystemAssigned", principalId: PRINCIPAL, tenantId: TENANT_A } }) : ok({ error: { message: "not found" } }, 404)
    }
    if (path.includes("/microsoft.insights/metricAlerts/")) return this.failureAlert ? ok({ name: "TenuVault watcher failed jobs" }) : ok({ error: { message: "not found" } }, 404)
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

async function world(options: { accountExists?: boolean; graph?: unknown } = {}) {
  const heartbeat: { current: Heartbeat | null; nextError: string | null } = { current: null, nextError: null }
  const arm = new FakeArm(heartbeat, options)
  const deps = fakeDeps({
    plans: { [TENANT_A]: "pro" },
    now: () => NOW,
    tenant: () => ({ tenantId: TENANT_A, name: "Contoso", clientId: "99999999-9999-9999-9999-999999999999", storageAccountName: "tvbkp1234567890ab" }),
    graph: (options.graph ?? graphUnknown()) as never,
    arm: arm.call,
    watcherHeartbeat: async () => heartbeat.current ? { status: "ok", runAt: heartbeat.current.runAt, lastError: heartbeat.current.lastError, alertsHash: heartbeat.current.alertsHash, runbookVersion: "1.2.0", alertsSource: "storage" } : { status: "missing" },
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
  return { deps, api, arm, heartbeat, channel }
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
    const started = await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-start", ...planBody, ack: { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: false } })
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
    await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-start", ...planBody, ack: { destinationConfirmed: true, copyDestinationKinds: [], grantRoles: false, rolesConfirmed: true } })
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
      await call(w.api, PATH, { tenantId: TENANT_A, action: "watcher-deploy-start", ...planBody, ack: { destinationConfirmed: false, copyDestinationKinds: ["teams"], grantRoles: false, rolesConfirmed: false } })
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
})
