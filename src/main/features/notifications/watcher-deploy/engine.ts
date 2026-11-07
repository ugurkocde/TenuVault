import { randomUUID } from "node:crypto"
import type { FeatureDeps } from "../../deps"
import { DOMAINS } from "../../domains"
import type { Stored } from "../../records"
import { armErrorMessage } from "../../../azure/arm"
import { allows } from "../../../../shared/plans"
import { isDefaultLayout } from "../../../../shared/notifications/layout"
import { watcherAlertsHash } from "../../../../shared/notifications/alerts"
import {
  graphRolesFor,
  handoverGate,
  watcherGrantSnippet,
  WATCHER_DEPLOY_STEPS,
  type WatcherDeployAck,
  type WatcherDeployPlanInput,
  type WatcherDeployStep,
  type WatcherDeployStepId,
  type WatcherDeployView,
} from "../../../../shared/notifications/watcher-deploy"
import {
  auditWatchOf,
  brief,
  channelsOf,
  handOverToWatcher,
  layoutOf,
  rulesOf,
  watcherAlertsDocument,
  writeWatcherAlerts,
} from "../service"
import type { WatcherDeployRecord } from "../model"
import { watcherPreflight } from "./preflight"
import { checkGraphRoles, grantGraphRoles } from "./graph-roles"
import { scheduleStartTime, watcherDeploymentBody, watcherScheduleInterval } from "./template"

export class WatcherDeployError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = "WatcherDeployError"
  }
}

const RUNBOOK = "Invoke-TenuVaultNotificationCheck"
const ACTIVE_STATES = new Set(["running", "blocked", "interrupted"])
const TERMINAL_STATES = new Set(["complete", "cancelled"])
const enc = encodeURIComponent

type Record_ = Record<string, unknown>
const asRecord = (value: unknown): Record_ => (value && typeof value === "object" && !Array.isArray(value) ? value as Record_ : {})

export function watcherDeployOf(deps: FeatureDeps, tenantId: string, jobId?: string | null): Stored<WatcherDeployRecord> | null {
  const records = deps.records.list<WatcherDeployRecord>(DOMAINS.notificationWatcherDeploy, tenantId)
  if (jobId) return records.find((record) => record.id === jobId) ?? null
  return [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
}

function stepsWith(record: WatcherDeployRecord, id: WatcherDeployStepId, status: WatcherDeployStep["status"], detail: string | null = null, error: string | null = null): WatcherDeployStep[] {
  return record.steps.map((step) => step.id === id ? { ...step, status, detail, error } : step)
}

function freshSteps(): WatcherDeployStep[] {
  return WATCHER_DEPLOY_STEPS.map((step) => ({ ...step, status: "pending", detail: null, error: null }))
}

function saveDeploy(deps: FeatureDeps, tenantId: string, record: Stored<WatcherDeployRecord>, patch: Partial<WatcherDeployRecord>, actor: string | null, reason: string): Stored<WatcherDeployRecord> {
  const state = patch.state ?? record.state
  const summary = state === "complete"
    ? "The verified Azure watcher runs these alerts."
    : state === "blocked"
      ? patch.error ?? record.error ?? "Waiting for an admin step."
      : state === "failed"
        ? patch.error ?? record.error ?? "The Azure watcher setup failed."
        : state === "cancelled"
          ? "Cancelled. Nothing was handed over."
          : "Setting up the Azure watcher."
  return deps.records.update<WatcherDeployRecord>(DOMAINS.notificationWatcherDeploy, tenantId, record.id, (value) => ({ ...value, ...patch, status: state, summary }), { actor, reason })!
}

export function publicWatcherDeploy(record: Stored<WatcherDeployRecord>, tenantId: string): WatcherDeployView {
  let grantSnippet: string | null = null
  if (record.principalId) {
    try { grantSnippet = watcherGrantSnippet(record.principalId, tenantId, record.graphRoles) } catch { grantSnippet = null }
  }
  return {
    id: record.id,
    mode: record.mode,
    state: record.state,
    plan: record.plan,
    planHash: record.planHash,
    ack: record.ack,
    findings: record.findings,
    capabilities: record.capabilities,
    existing: record.existing,
    steps: record.steps,
    graphRoles: record.graphRoles,
    graphRoleStatus: record.graphRoleStatus,
    principalId: record.principalId,
    grantSnippet,
    blockedReason: record.blockedReason,
    error: record.error,
    alertsHash: record.alertsHash,
    automationJobId: record.automationJobId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

const locks = new WeakMap<FeatureDeps, Map<string, Promise<unknown>>>()

async function withDeployLock<T>(deps: FeatureDeps, tenantId: string, run: () => Promise<T>): Promise<T> {
  let perTenant = locks.get(deps)
  if (!perTenant) { perTenant = new Map(); locks.set(deps, perTenant) }
  const key = tenantId.toLowerCase()
  const previous = perTenant.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  perTenant.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await run()
  } finally {
    release()
    if (perTenant.get(key) === current) perTenant.delete(key)
  }
}

interface Runner { controller: AbortController; promise: Promise<void> }
const runners = new WeakMap<FeatureDeps, Map<string, Runner>>()

function runnerMap(deps: FeatureDeps): Map<string, Runner> {
  let map = runners.get(deps)
  if (!map) { map = new Map(); runners.set(deps, map) }
  return map
}

/** Starts the background runner for a tenant's deployment, once. */
export function kickWatcherDeploy(deps: FeatureDeps, tenantId: string, actor: string | null): void {
  const key = tenantId.toLowerCase()
  const map = runnerMap(deps)
  if (map.has(key)) return
  const controller = new AbortController()
  const promise = (async () => {
    const started = Date.now()
    try {
      while (!controller.signal.aborted && Date.now() - started < 45 * 60_000) {
        const view = await advanceWatcherDeploy(deps, tenantId, actor)
        if (!view || view.state !== "running") break
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000)
          controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
        })
      }
    } finally {
      if (map.get(key)?.controller === controller) map.delete(key)
    }
  })()
  map.set(key, { controller, promise })
  void promise.catch(() => undefined)
}

export async function startWatcherDeploy(
  deps: FeatureDeps,
  tenantId: string,
  actor: string | null,
  input: WatcherDeployPlanInput,
  ack: WatcherDeployAck,
  expectedPlanHash?: string | null,
): Promise<WatcherDeployView> {
  const tenant = tenantId.toLowerCase()
  const preflight = await watcherPreflight(deps, tenant, input)
  if (expectedPlanHash && expectedPlanHash !== preflight.planHash) {
    throw new WatcherDeployError("The Azure setup changed since it was checked. Review the new check, then start again.", 409)
  }
  const active = deps.records.list<WatcherDeployRecord>(DOMAINS.notificationWatcherDeploy, tenant)
    .filter((record) => ACTIVE_STATES.has(record.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (active) {
    if (active.planHash !== preflight.planHash) {
      throw new WatcherDeployError("Another Azure watcher setup is still open for this tenant. Finish or cancel it first.", 409)
    }
    const updated = saveDeploy(deps, tenant, active, { ack, findings: preflight.findings, capabilities: preflight.capabilities, existing: preflight.existing }, actor, "Azure watcher setup reviewed again")
    if (updated.state === "blocked" || updated.state === "interrupted") return resumeWatcherDeploy(deps, tenant, actor, updated.id)
    kickWatcherDeploy(deps, tenant, actor)
    return publicWatcherDeploy(updated, tenant)
  }
  const now = deps.now().toISOString()
  const record = deps.records.create<WatcherDeployRecord>(DOMAINS.notificationWatcherDeploy, tenant, {
    title: "Azure watcher setup",
    status: "running",
    summary: "Setting up the Azure watcher.",
    mode: preflight.existing.found ? "adopt" : "create",
    state: "running",
    phase: "discover",
    plan: preflight.plan,
    planHash: preflight.planHash,
    ack,
    findings: preflight.findings,
    capabilities: preflight.capabilities,
    existing: preflight.existing,
    steps: freshSteps(),
    graphRoles: preflight.graphRoles,
    graphRoleStatus: preflight.graphRoleStatus,
    missingGraphRoles: preflight.missingGraphRoles,
    rolesVerifiedAt: preflight.graphRoleStatus === "verified" ? now : null,
    grantAttemptedAt: null,
    deploymentName: null,
    deploymentState: null,
    copiedChannels: [],
    principalId: preflight.existing.principalId,
    alertsHash: null,
    alertsWrittenAt: null,
    automationJobId: null,
    jobSubmittedAt: null,
    jobStatus: null,
    heartbeatRunAt: preflight.existing.heartbeatRunAt,
    blockedReason: null,
    error: null,
    nextAttemptAt: null,
    pendingHandover: false,
    startedAt: now,
  }, { actor, reason: "Azure watcher setup started" })
  kickWatcherDeploy(deps, tenant, actor)
  return publicWatcherDeploy(record, tenant)
}

function block(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null, reason: string, message: string, pendingHandover = false): WatcherDeployView {
  const saved = saveDeploy(deps, tenant, record, {
    state: "blocked",
    blockedReason: reason,
    error: message,
    pendingHandover,
    nextAttemptAt: pendingHandover ? new Date(deps.now().getTime() + 30 * 60_000).toISOString() : null,
    steps: stepsWith(record, record.phase, "blocked", null, message),
  }, actor, `Azure watcher setup waiting: ${message}`)
  return publicWatcherDeploy(saved, tenant)
}

function fail(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null, message: string): WatcherDeployView {
  const saved = saveDeploy(deps, tenant, record, {
    state: "failed",
    blockedReason: null,
    error: message,
    pendingHandover: false,
    nextAttemptAt: null,
    steps: stepsWith(record, record.phase, "failed", null, message),
  }, actor, `Azure watcher setup failed: ${message}`)
  return publicWatcherDeploy(saved, tenant)
}

function progress(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null, patch: Partial<WatcherDeployRecord>, reason: string): WatcherDeployView {
  return publicWatcherDeploy(saveDeploy(deps, tenant, record, { state: "running", blockedReason: null, error: null, ...patch }, actor, reason), tenant)
}

function accountBase(record: WatcherDeployRecord): string {
  const plan = record.plan
  return `/subscriptions/${enc(plan.subscriptionId)}/resourceGroups/${enc(plan.resourceGroupName)}/providers/Microsoft.Automation/automationAccounts/${enc(plan.automationAccountName)}`
}

function deploymentPath(record: WatcherDeployRecord, name: string): string {
  return `/subscriptions/${enc(record.plan.subscriptionId)}/resourceGroups/${enc(record.plan.resourceGroupName)}/providers/Microsoft.Resources/deployments/${enc(name)}?api-version=2022-09-01`
}

async function advanceDiscover(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  const running = saveDeploy(deps, tenant, record, { steps: stepsWith(record, "discover", "running") }, actor, "Checking Azure")
  const preflight = await watcherPreflight(deps, tenant, { ...running.plan })
  const withFindings = saveDeploy(deps, tenant, running, {
    findings: preflight.findings,
    capabilities: preflight.capabilities,
    existing: preflight.existing,
    graphRoles: preflight.graphRoles,
    graphRoleStatus: preflight.graphRoleStatus,
    missingGraphRoles: preflight.missingGraphRoles,
    principalId: preflight.existing.principalId ?? running.principalId,
    heartbeatRunAt: preflight.existing.heartbeatRunAt,
  }, actor, "Azure checked")
  if (preflight.planHash !== running.planHash) {
    return block(deps, tenant, withFindings, actor, "plan-changed", "The alerts or Azure target changed since this setup was confirmed. Review the check and start again.")
  }
  const blocker = preflight.findings.find((finding) => finding.severity === "block")
  if (blocker) return block(deps, tenant, withFindings, actor, blocker.code, blocker.message)
  if (preflight.existing.found) {
    return progress(deps, tenant, withFindings, actor, {
      mode: withFindings.deploymentName ? withFindings.mode : "adopt",
      phase: "graph-roles",
      steps: stepsWith({ ...withFindings, steps: stepsWith(withFindings, "discover", "done", `${preflight.existing.automationAccountName} in ${preflight.existing.resourceGroupName}`) }, "deploy", "skipped", "Already in Azure"),
    }, "Existing watcher found")
  }
  return progress(deps, tenant, withFindings, actor, {
    mode: "create",
    phase: "deploy",
    steps: stepsWith(withFindings, "discover", "done", "No watcher yet"),
  }, "No watcher yet")
}

function usedChannels(deps: FeatureDeps, tenant: string, kind: "teams" | "webhook") {
  const used = new Set(rulesOf(deps, tenant).filter((rule) => rule.enabled).flatMap((rule) => rule.channelIds))
  return channelsOf(deps, tenant).filter((channel) => channel.enabled && channel.kind === kind && used.has(channel.id))
}

async function advanceDeploy(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  if (!deps.arm) return fail(deps, tenant, record, actor, "This version of TenuVault cannot reach Azure Resource Manager.")
  const arm = deps.arm
  if (record.deploymentName) {
    const response = await arm(tenant, { method: "GET", path: deploymentPath(record, record.deploymentName) })
    const properties = asRecord(asRecord(response.body).properties)
    const state = typeof properties.provisioningState === "string" ? properties.provisioningState : null
    if (response.status === 404 || state === "Running" || state === "Accepted" || state === "Creating" || !state) {
      return progress(deps, tenant, record, actor, { deploymentState: state ?? "Accepted", steps: stepsWith(record, "deploy", "running", "Azure is creating the watcher") }, "Watcher deployment running")
    }
    if (state === "Succeeded") {
      const outputs = asRecord(properties.outputs)
      const principal = asRecord(outputs.managedIdentityPrincipalId).value
      return progress(deps, tenant, record, actor, {
        deploymentState: state,
        principalId: typeof principal === "string" ? principal : record.principalId,
        phase: "discover",
        steps: stepsWith(record, "deploy", "done", "Created in Azure"),
      }, "Watcher created")
    }
    const account = await arm(tenant, { method: "GET", path: `${accountBase(record)}?api-version=2023-11-01` })
    if (account.status === 200) {
      return progress(deps, tenant, record, actor, { deploymentState: state, phase: "discover", steps: stepsWith(record, "deploy", "done", "Partly created; checking what is there") }, "Deployment stopped after creating the account")
    }
    const saved = saveDeploy(deps, tenant, record, { deploymentState: state }, actor, "Watcher deployment failed")
    return fail(deps, tenant, saved, actor, armErrorMessage(response.body, response.status))
  }

  // Destination values live only in this call. The record keeps which channel was copied.
  let teamsWebhookUrl = ""
  let webhookUrl = ""
  let webhookSecret = ""
  const copied: WatcherDeployRecord["copiedChannels"] = []
  for (const kind of ["teams", "webhook"] as const) {
    if (!record.ack.copyDestinationKinds.includes(kind) || !record.plan.destinationKinds.includes(kind)) continue
    const found = usedChannels(deps, tenant, kind)
    if (found.length !== 1) return block(deps, tenant, record, actor, "copy-destination", `Pick exactly one ${kind} channel for these alerts, then continue.`)
    const channel = found[0]!
    if (!channel.url) return block(deps, tenant, record, actor, "copy-destination", `The ${kind} channel has no URL to copy.`)
    if (kind === "teams") teamsWebhookUrl = channel.url
    if (kind === "webhook") {
      if (channel.headerName) return block(deps, tenant, record, actor, "copy-destination", "That webhook sends a fixed secret header, which the watcher cannot copy. Switch it to request signing, or set the watcher webhook up in Azure and confirm it here.")
      webhookUrl = channel.url
      webhookSecret = channel.signRequests ? channel.headerValue ?? "" : ""
      if (channel.headerValue && !channel.signRequests) return block(deps, tenant, record, actor, "copy-destination", "That webhook secret is neither a header nor a signing key here, so there is nothing safe to copy.")
    }
    copied.push({ channelId: channel.id, kind, updatedAt: channel.updatedAt })
  }

  const name = `tenuvault-watcher-${record.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  const submitted = saveDeploy(deps, tenant, record, { deploymentName: name, deploymentState: "Accepted", copiedChannels: copied, steps: stepsWith(record, "deploy", "running", "Creating in Azure") }, actor, "Watcher deployment submitted")
  const watch = auditWatchOf(deps, tenant)
  const layout = layoutOf(deps, tenant)
  // A first run well ahead gives the role and test steps room to finish before a schedule fires.
  const body = watcherDeploymentBody(record.plan, {
    tenantName: deps.tenant(tenant)?.name ?? "",
    scheduleStartTime: scheduleStartTime(deps.now(), 65),
    scheduleIntervalMinutes: watcherScheduleInterval(watch?.intervalMinutes ?? 60),
    includeActor: watch?.includeActor ?? false,
    teamsWebhookUrl,
    webhookUrl,
    webhookSecret,
    teamsCardLayout: isDefaultLayout(layout) ? "" : JSON.stringify(layout),
  })
  const validated = await arm(tenant, { method: "POST", path: deploymentPath(record, name).replace("?api-version=", "/validate?api-version="), body })
  const validationError = asRecord(validated.body).error ?? asRecord(asRecord(validated.body).properties).error
  if (validated.status >= 300 || validationError) return fail(deps, tenant, submitted, actor, armErrorMessage(validated.body, validated.status))
  let created: Awaited<ReturnType<typeof arm>>
  try {
    created = await arm(tenant, { method: "PUT", path: deploymentPath(record, name), body })
  } catch {
    // The name is already saved: a lost answer is polled, never submitted twice.
    return progress(deps, tenant, submitted, actor, { deploymentState: "Accepted" }, "Watcher deployment answer lost; polling it")
  }
  if (created.status >= 300) {
    const saved = saveDeploy(deps, tenant, submitted, { deploymentState: "Failed" }, actor, "Watcher deployment refused")
    return fail(deps, tenant, saved, actor, armErrorMessage(created.body, created.status))
  }
  const state = asRecord(asRecord(created.body).properties).provisioningState
  return progress(deps, tenant, submitted, actor, { deploymentState: typeof state === "string" ? state : "Running" }, "Watcher deployment accepted")
}

async function advanceGraphRoles(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  if (!record.principalId) {
    return progress(deps, tenant, record, actor, { phase: "discover", steps: stepsWith(record, "graph-roles", "pending") }, "Watcher identity not known yet")
  }
  const roles = graphRolesFor({ conditionalAccess: record.plan.needsConditionalAccess, mail: record.plan.destinationKinds.includes("mail") })
  const check = await checkGraphRoles(deps, tenant, record.principalId, roles)
  const checked = saveDeploy(deps, tenant, record, { graphRoles: roles, graphRoleStatus: check.status, missingGraphRoles: check.missing }, actor, "Graph roles checked")
  if (check.status === "verified") {
    return progress(deps, tenant, checked, actor, { rolesVerifiedAt: deps.now().toISOString(), phase: "alerts", steps: stepsWith(checked, "graph-roles", "done", "Assigned") }, "Graph roles verified")
  }
  if (check.status === "missing") {
    if (checked.ack.grantRoles) {
      const attempted = checked.grantAttemptedAt ? Date.parse(checked.grantAttemptedAt) : 0
      if (attempted && deps.now().getTime() - attempted < 30_000) {
        return progress(deps, tenant, checked, actor, { steps: stepsWith(checked, "graph-roles", "running", "Waiting for Microsoft Graph to show the assignment") }, "Waiting for Graph role propagation")
      }
      const granted = await grantGraphRoles(deps, tenant, checked.principalId!, check.missing)
      if (!granted.ok) return block(deps, tenant, checked, actor, "needs-admin", `${granted.detail} A Global Administrator can assign ${check.missing.join(", ")} with the commands below.`)
      const saved = saveDeploy(deps, tenant, checked, { grantAttemptedAt: deps.now().toISOString(), steps: stepsWith(checked, "graph-roles", "running", granted.detail) }, actor, "Graph roles assigned")
      return publicWatcherDeploy(saved, tenant)
    }
    return block(deps, tenant, checked, actor, "needs-admin", `A Global Administrator still has to assign ${check.missing.join(", ")} to the watcher identity.`)
  }
  if (checked.ack.rolesConfirmed) {
    return progress(deps, tenant, checked, actor, { phase: "alerts", steps: stepsWith(checked, "graph-roles", "done", "Confirmed by an administrator; the test run proves it") }, "Graph roles confirmed")
  }
  return block(deps, tenant, checked, actor, "needs-admin", `${check.detail ?? "The Graph roles could not be checked."} A Global Administrator can assign ${roles.join(", ")} with the commands below, then confirm here.`)
}

async function advanceAlerts(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  const { document } = watcherAlertsDocument(deps, tenant)
  const kinds = [...new Set(document.alerts.flatMap((alert) => alert.destinations))]
  const sameKinds = kinds.length === record.plan.destinationKinds.length && kinds.every((kind) => record.plan.destinationKinds.includes(kind))
  const needsCa = document.alerts.some((alert) => alert.eventTypes.includes("entra.change"))
  if (!sameKinds || needsCa !== record.plan.needsConditionalAccess) {
    return block(deps, tenant, record, actor, "plan-changed", "The alerts changed since this setup was confirmed. Review the check and start again.")
  }
  const currentHash = watcherAlertsHash(document)
  if (record.alertsHash === currentHash && record.alertsWrittenAt) {
    return progress(deps, tenant, record, actor, { phase: "test-run", steps: stepsWith(record, "alerts", "done", "Already with the watcher") }, "Watcher alerts already written")
  }
  const written = await writeWatcherAlerts(deps, tenant, actor, { requireOwnership: false })
  if (!written.ok) return block(deps, tenant, record, actor, "alerts-write", written.error)
  return progress(deps, tenant, record, actor, {
    alertsHash: written.hash,
    alertsWrittenAt: written.pushedAt,
    automationJobId: null,
    jobSubmittedAt: null,
    jobStatus: null,
    phase: "test-run",
    steps: stepsWith(record, "alerts", "done", `${written.alerts} alert${written.alerts === 1 ? "" : "s"} sent`),
  }, "Alerts written to the watcher")
}

async function advanceTestRun(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  if (!deps.arm) return fail(deps, tenant, record, actor, "This version of TenuVault cannot reach Azure Resource Manager.")
  const arm = deps.arm
  if (record.automationJobId) {
    const response = await arm(tenant, { method: "GET", path: `${accountBase(record)}/jobs/${enc(record.automationJobId)}?api-version=2023-11-01` })
    if (response.status === 404) return progress(deps, tenant, record, actor, { steps: stepsWith(record, "test-run", "running", "Starting") }, "Watcher test run starting")
    if (response.status >= 300) return block(deps, tenant, record, actor, "test-run", armErrorMessage(response.body, response.status))
    const status = asRecord(asRecord(response.body).properties).status
    const jobStatus = typeof status === "string" ? status : "Running"
    if (["Completed", "Failed", "Stopped", "Suspended", "Cancelled"].includes(jobStatus)) {
      return progress(deps, tenant, record, actor, { jobStatus, phase: "verify", steps: stepsWith(record, "test-run", jobStatus === "Completed" ? "done" : "blocked", jobStatus) }, `Watcher test run ${jobStatus.toLowerCase()}`)
    }
    const submitted = record.jobSubmittedAt ? Date.parse(record.jobSubmittedAt) : deps.now().getTime()
    if (deps.now().getTime() - submitted > 20 * 60_000) {
      const saved = saveDeploy(deps, tenant, record, { jobStatus }, actor, "Watcher test run is taking too long")
      return block(deps, tenant, saved, actor, "test-timeout", "The test run has not finished in 20 minutes. Check again to see where it got to.")
    }
    return progress(deps, tenant, record, actor, { jobStatus, steps: stepsWith(record, "test-run", "running", jobStatus) }, "Watcher test run running")
  }
  if (record.capabilities.canStartJobs === false) {
    return progress(deps, tenant, record, actor, { phase: "verify", steps: stepsWith(record, "test-run", "skipped", "Waiting for the next scheduled run") }, "Waiting for a scheduled watcher run")
  }
  const jobId = randomUUID()
  const submitted = saveDeploy(deps, tenant, record, { automationJobId: jobId, jobSubmittedAt: deps.now().toISOString(), jobStatus: "Accepted", steps: stepsWith(record, "test-run", "running", "Starting") }, actor, "Watcher test run submitted")
  const response = await arm(tenant, { method: "PUT", path: `${accountBase(record)}/jobs/${enc(jobId)}?api-version=2023-11-01`, body: { properties: { runbook: { name: RUNBOOK }, parameters: {} } } })
  if (response.status === 401 || response.status === 403) {
    return progress(deps, tenant, submitted, actor, {
      automationJobId: null,
      jobSubmittedAt: null,
      jobStatus: null,
      capabilities: { ...submitted.capabilities, canStartJobs: false },
      phase: "verify",
      steps: stepsWith(submitted, "test-run", "skipped", "This sign-in cannot start a job; waiting for the schedule"),
    }, "Waiting for a scheduled watcher run")
  }
  if (response.status >= 300) {
    const saved = saveDeploy(deps, tenant, submitted, { jobStatus: "SubmitFailed" }, actor, "Watcher test run refused")
    return block(deps, tenant, saved, actor, "test-run", armErrorMessage(response.body, response.status))
  }
  const status = asRecord(asRecord(response.body).properties).status
  return progress(deps, tenant, submitted, actor, { jobStatus: typeof status === "string" ? status : "Running" }, "Watcher test run accepted")
}

async function readHeartbeat(deps: FeatureDeps, tenant: string) {
  if (!deps.watcherHeartbeat) return { status: "missing" as const }
  return deps.watcherHeartbeat(tenant).catch((error: unknown) => ({ status: "error" as const, message: brief(error instanceof Error ? error.message : String(error)) }))
}

async function advanceVerify(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  const heartbeat = await readHeartbeat(deps, tenant)
  if (heartbeat.status === "error") return block(deps, tenant, record, actor, "heartbeat-read", heartbeat.message, true)
  const copiedKinds = new Set(record.copiedChannels.map((entry) => entry.kind === "teams" ? "teams" : "webhook"))
  const destinationOk = record.plan.destinationKinds.every((kind) => copiedKinds.has(kind as "teams" | "webhook") || record.ack.destinationConfirmed)
  const gate = handoverGate({
    accountExists: record.existing.found,
    identityTenantMatches: record.existing.identityTenantMatches,
    runbookPublished: record.existing.runbookPublished,
    runbookVersion: heartbeat.status === "ok" ? heartbeat.runbookVersion ?? null : null,
    scheduleLinked: record.existing.scheduleLinked,
    failureAlertOk: record.existing.failureAlert === true || record.plan.noFailureAlert,
    destinationOk,
    needsConditionalAccess: record.plan.needsConditionalAccess,
    watchConditionalAccess: record.existing.watchConditionalAccess,
    alertsHash: record.alertsHash,
    alertsWrittenAt: record.alertsWrittenAt,
    heartbeat: heartbeat.status === "ok" ? { runAt: heartbeat.runAt, lastError: heartbeat.lastError, alertsHash: heartbeat.alertsHash ?? null } : null,
  })
  const checked = saveDeploy(deps, tenant, record, { heartbeatRunAt: heartbeat.status === "ok" ? heartbeat.runAt : record.heartbeatRunAt }, actor, "Watcher run checked")
  if (gate.ok) {
    return progress(deps, tenant, checked, actor, { phase: "hand-over", pendingHandover: false, steps: stepsWith(checked, "verify", "done", "Clean run of these alerts") }, "Watcher run verified")
  }
  const lastError = heartbeat.status === "ok" ? heartbeat.lastError : null
  if (gate.missing.includes("destination")) {
    return block(deps, tenant, checked, actor, "needs-destination", "The watcher has not been shown a destination for every kind these alerts send to. Set its Teams, webhook or mail variables in Azure, then confirm here.")
  }
  if (lastError && /\b(401|403)\b|forbidden|unauthorized|insufficient privileges|authorization_requestdenied/i.test(lastError)) {
    return block(deps, tenant, checked, actor, "roles-not-effective", "The watcher still cannot read Microsoft Graph. New role assignments can take minutes (rarely hours) to reach a managed identity. Check again later; nothing has been handed over.", true)
  }
  const heartbeatOnly = gate.missing.every((entry) => entry.startsWith("heartbeat") || entry === "runbook-version")
  if (heartbeatOnly) {
    const writtenAt = record.alertsWrittenAt ? Date.parse(record.alertsWrittenAt) : deps.now().getTime()
    const waited = deps.now().getTime() - writtenAt
    const jobFailed = record.jobStatus !== null && record.jobStatus !== "Completed" && record.jobStatus !== "Running" && record.jobStatus !== "Accepted"
    if (jobFailed && lastError) return block(deps, tenant, checked, actor, "test-failed", `The watcher run failed: ${brief(lastError)}`)
    if (waited > 70 * 60_000) return block(deps, tenant, checked, actor, "waiting-heartbeat", "No clean watcher run of these alerts has been seen yet. It will be checked again while TenuVault runs.", true)
    return progress(deps, tenant, checked, actor, { pendingHandover: true, steps: stepsWith(checked, "verify", "running", "Waiting for a clean run") }, "Waiting for a clean watcher run")
  }
  return block(deps, tenant, checked, actor, "verify", `The watcher is not ready to take over yet (${gate.missing.join(", ")}).`)
}

async function advanceHandOver(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  const currentHash = watcherAlertsHash(watcherAlertsDocument(deps, tenant).document)
  if (currentHash !== record.alertsHash) {
    return progress(deps, tenant, record, actor, { phase: "alerts", automationJobId: null, jobStatus: null, steps: stepsWith(record, "hand-over", "pending", "Alerts changed; sending them again") }, "Alerts changed during setup")
  }
  const heartbeat = await readHeartbeat(deps, tenant)
  handOverToWatcher(deps, tenant, actor, heartbeat.status === "ok" ? { runAt: heartbeat.runAt, alertsHash: heartbeat.alertsHash ?? null, runbookVersion: heartbeat.runbookVersion ?? null, alertsSource: heartbeat.alertsSource ?? null } : undefined)
  const steps = record.steps.map((step) => step.status === "skipped" ? step : { ...step, status: "done" as const, error: null })
  const saved = saveDeploy(deps, tenant, record, { state: "complete", pendingHandover: false, blockedReason: null, error: null, steps }, actor, "Azure watcher verified and handed over")
  return publicWatcherDeploy(saved, tenant)
}

/** One bounded step of the deployment. Safe to call again: every step reads state first. */
export async function advanceWatcherDeploy(deps: FeatureDeps, tenantId: string, actor: string | null, jobId?: string | null): Promise<WatcherDeployView | null> {
  const tenant = tenantId.toLowerCase()
  return withDeployLock(deps, tenant, async () => {
    const record = watcherDeployOf(deps, tenant, jobId)
    if (!record) return null
    if (record.state !== "running") return publicWatcherDeploy(record, tenant)
    try {
      switch (record.phase) {
        case "discover": return advanceDiscover(deps, tenant, record, actor)
        case "deploy": return advanceDeploy(deps, tenant, record, actor)
        case "graph-roles": return advanceGraphRoles(deps, tenant, record, actor)
        case "alerts": return advanceAlerts(deps, tenant, record, actor)
        case "test-run": return advanceTestRun(deps, tenant, record, actor)
        case "verify": return advanceVerify(deps, tenant, record, actor)
        case "hand-over": return advanceHandOver(deps, tenant, record, actor)
      }
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return publicWatcherDeploy(watcherDeployOf(deps, tenant, record.id) ?? record, tenant)
      const current = watcherDeployOf(deps, tenant, record.id) ?? record
      if (current.state !== "running") return publicWatcherDeploy(current, tenant)
      return fail(deps, tenant, current, actor, brief(error instanceof Error ? error.message : String(error)))
    }
  })
}

export function resumeWatcherDeploy(deps: FeatureDeps, tenantId: string, actor: string | null, jobId?: string | null): WatcherDeployView {
  const tenant = tenantId.toLowerCase()
  const record = watcherDeployOf(deps, tenant, jobId)
  if (!record) throw new WatcherDeployError("No Azure watcher setup was found.", 404)
  if (TERMINAL_STATES.has(record.state)) return publicWatcherDeploy(record, tenant)
  const patch: Partial<WatcherDeployRecord> = { state: "running", blockedReason: null, error: null, nextAttemptAt: null }
  if (record.blockedReason === "roles-not-effective" || record.blockedReason === "test-failed") {
    patch.phase = "test-run"
    patch.automationJobId = null
    patch.jobSubmittedAt = null
    patch.jobStatus = null
    patch.pendingHandover = false
  } else if (record.state === "failed" && record.phase === "deploy") {
    patch.phase = "discover"
    patch.deploymentName = null
    patch.deploymentState = null
  } else if (record.phase === "deploy" && (record.deploymentState === "Failed" || record.deploymentState === "Canceled")) {
    patch.phase = "discover"
    patch.deploymentName = null
    patch.deploymentState = null
  } else if (record.phase === "test-run" && record.jobStatus === "SubmitFailed") {
    patch.automationJobId = null
    patch.jobSubmittedAt = null
    patch.jobStatus = null
  }
  const phase = patch.phase ?? record.phase
  patch.steps = stepsWith(record, phase, "pending")
  const saved = saveDeploy(deps, tenant, record, patch, actor, "Azure watcher setup continued")
  kickWatcherDeploy(deps, tenant, actor)
  return publicWatcherDeploy(saved, tenant)
}

export function confirmWatcherDeploy(deps: FeatureDeps, tenantId: string, actor: string | null, jobId: string | null | undefined, confirmation: "roles" | "destination" | "grant"): WatcherDeployView {
  const tenant = tenantId.toLowerCase()
  const record = watcherDeployOf(deps, tenant, jobId)
  if (!record) throw new WatcherDeployError("No Azure watcher setup was found.", 404)
  const ack = {
    ...record.ack,
    ...(confirmation === "roles" ? { rolesConfirmed: true } : {}),
    ...(confirmation === "destination" ? { destinationConfirmed: true } : {}),
    ...(confirmation === "grant" ? { grantRoles: true } : {}),
  }
  saveDeploy(deps, tenant, record, { ack }, actor, confirmation === "roles" ? "Graph roles confirmed by an administrator" : confirmation === "destination" ? "Watcher destination confirmed" : "Graph role assignment approved")
  return resumeWatcherDeploy(deps, tenant, actor, record.id)
}

export async function cancelWatcherDeploy(deps: FeatureDeps, tenantId: string, actor: string | null, jobId?: string | null): Promise<WatcherDeployView> {
  const tenant = tenantId.toLowerCase()
  const record = watcherDeployOf(deps, tenant, jobId)
  if (!record) throw new WatcherDeployError("No Azure watcher setup was found.", 404)
  runnerMap(deps).get(tenant)?.controller.abort()
  if (TERMINAL_STATES.has(record.state)) return publicWatcherDeploy(record, tenant)
  if (deps.arm && record.deploymentName && record.phase === "deploy" && record.deploymentState !== "Succeeded") {
    await deps.arm(tenant, { method: "POST", path: deploymentPath(record, record.deploymentName).replace("?api-version=", "/cancel?api-version=") }).catch(() => undefined)
  }
  // Under the same lock as a step, so a step finishing now cannot write running over this.
  return withDeployLock(deps, tenant, async () => {
    const current = watcherDeployOf(deps, tenant, record.id) ?? record
    if (TERMINAL_STATES.has(current.state)) return publicWatcherDeploy(current, tenant)
    const saved = saveDeploy(deps, tenant, current, { state: "cancelled", pendingHandover: false, blockedReason: null }, actor, "Azure watcher setup cancelled. Nothing was handed over")
    return publicWatcherDeploy(saved, tenant)
  })
}

/** A restart never resumes Azure writes on its own: running setups wait for the admin. */
export function markInterruptedWatcherDeploys(deps: FeatureDeps): void {
  for (const tenantId of deps.tenants()) {
    for (const record of deps.records.list<WatcherDeployRecord>(DOMAINS.notificationWatcherDeploy, tenantId)) {
      if (record.state === "running") saveDeploy(deps, tenantId.toLowerCase(), record, { state: "interrupted", error: "TenuVault closed during the setup. Nothing was handed over." }, null, "Azure watcher setup interrupted")
    }
  }
}

/**
 * The one automatic continuation: a setup that only waits for a clean scheduled run reads
 * the heartbeat again and hands over when it passes. It starts no job and writes nothing
 * in Azure, so a role that propagates overnight finishes on its own without spamming runs.
 */
export async function resumePendingWatcherHandovers(deps: FeatureDeps): Promise<void> {
  for (const tenantId of deps.tenants()) {
    if (!deps.actor(tenantId)) continue
    try {
      if (!allows(await deps.plan(tenantId), "notifications")) continue
    } catch { continue }
    const record = watcherDeployOf(deps, tenantId)
    if (!record || record.state !== "blocked" || !record.pendingHandover || record.phase !== "verify") continue
    if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > deps.now().getTime()) continue
    saveDeploy(deps, tenantId.toLowerCase(), record, { state: "running", blockedReason: null, error: null }, null, "Checking the watcher again")
    await advanceWatcherDeploy(deps, tenantId, null, record.id).catch(() => undefined)
    const after = watcherDeployOf(deps, tenantId, record.id)
    if (after?.state === "running" && after.phase === "hand-over") await advanceWatcherDeploy(deps, tenantId, null, record.id).catch(() => undefined)
  }
}
