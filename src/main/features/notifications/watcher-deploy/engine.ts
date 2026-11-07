import { randomUUID } from "node:crypto"
import type { FeatureDeps } from "../../deps"
import { DOMAINS } from "../../domains"
import type { Stored } from "../../records"
import { armErrorMessage } from "../../../azure/arm"
import { allows } from "../../../../shared/plans"
import { isDefaultLayout } from "../../../../shared/notifications/layout"
import { canonicalJson, sha256Hex } from "../../../../shared/notifications/envelope"
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
const FINISHED_JOB_STATES = new Set(["Completed", "Failed", "Stopped", "Suspended", "Cancelled"])
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
    let lastState: WatcherDeployView["state"] | null = null
    try {
      while (!controller.signal.aborted && Date.now() - started < 45 * 60_000) {
        const view = await advanceWatcherDeploy(deps, tenantId, actor)
        lastState = view?.state ?? null
        if (!view || view.state !== "running") break
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000)
          controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
        })
      }
      // The runner has a lifetime, the setup does not: at the lifetime bound, persist a
      // resumable state instead of leaving "running" with nobody driving it. An exit for
      // any other reason must not overwrite a setup an admin has just resumed.
      const timedOut = Date.now() - started >= 45 * 60_000
      if (!controller.signal.aborted && timedOut) {
        const current = watcherDeployOf(deps, tenantId)
        if (current?.state === "running" && !current.cancelRequestedAt) {
          if (current.phase === "verify") {
            lastState = saveDeploy(deps, tenantId.toLowerCase(), current, {
              state: "blocked",
              blockedReason: "waiting-heartbeat",
              error: "No clean watcher run of these alerts has been seen yet. It will be checked again while TenuVault runs.",
              pendingHandover: true,
              nextAttemptAt: new Date(deps.now().getTime() + 30 * 60_000).toISOString(),
              steps: stepsWith(current, "verify", "blocked", null, "Waiting for a clean watcher run"),
            }, actor, "Watcher setup waiting for a scheduled run").state
          } else {
            lastState = saveDeploy(deps, tenantId.toLowerCase(), current, { state: "interrupted", error: "The setup has been running for 45 minutes and paused here. Continue it to check Azure again." }, actor, "Azure watcher setup paused").state
          }
        }
      }
    } finally {
      if (map.get(key)?.controller === controller) map.delete(key)
      const current = watcherDeployOf(deps, tenantId)
      if (!controller.signal.aborted && lastState !== "running" && current?.state === "running" && !current.cancelRequestedAt) {
        kickWatcherDeploy(deps, tenantId, actor)
      }
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
  if (!expectedPlanHash || expectedPlanHash !== preflight.planHash) {
    throw new WatcherDeployError("Check Azure first, review what it finds, then start again. The setup may have changed since it was checked.", 409)
  }
  const view = await withDeployLock(deps, tenant, async () => {
  const active = deps.records.list<WatcherDeployRecord>(DOMAINS.notificationWatcherDeploy, tenant)
    .filter((record) => ACTIVE_STATES.has(record.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (active) {
    refuseCancelPending(active)
    if (active.planHash !== preflight.planHash) {
      throw new WatcherDeployError("Another Azure watcher setup is still open for this tenant. Finish or cancel it first.", 409)
    }
    let updated = saveDeploy(deps, tenant, active, { ack, findings: preflight.findings, capabilities: preflight.capabilities, existing: preflight.existing }, actor, "Azure watcher setup reviewed again")
    if (updated.state === "blocked" || updated.state === "interrupted") {
      updated = saveDeploy(deps, tenant, updated, prepareResumePatch(updated), actor, "Azure watcher setup continued")
    }
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
    deploymentSubmittedAt: null,
    cancelRequestedAt: null,
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
  return publicWatcherDeploy(record, tenant)
  })
  if (view.state === "running") kickWatcherDeploy(deps, tenant, actor)
  return view
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

/** The latest persisted record says stop: a step that was away on a network call must not continue. */
function cancelRequested(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>): WatcherDeployView | null {
  const current = watcherDeployOf(deps, tenant, record.id) ?? record
  return current.cancelRequestedAt || current.state === "cancelled" ? publicWatcherDeploy(current, tenant) : null
}

function ageMs(deps: FeatureDeps, at: string | null): number {
  if (!at) return 0
  const parsed = Date.parse(at)
  return Number.isNaN(parsed) ? 0 : Math.max(0, deps.now().getTime() - parsed)
}

function refuseCancelPending(record: WatcherDeployRecord): void {
  if (!TERMINAL_STATES.has(record.state) && record.cancelRequestedAt) {
    throw new WatcherDeployError("This Azure watcher setup is being cancelled. Wait for it to stop before starting or continuing it.", 409)
  }
}

function prepareResumePatch(record: WatcherDeployRecord): Partial<WatcherDeployRecord> {
  const patch: Partial<WatcherDeployRecord> = { state: "running", blockedReason: null, error: null, nextAttemptAt: null, cancelRequestedAt: null }
  if (record.blockedReason === "roles-not-effective" || record.blockedReason === "test-failed" || record.blockedReason === "runbook-version") {
    patch.phase = "test-run"
    patch.automationJobId = null
    patch.jobSubmittedAt = null
    patch.jobStatus = null
    patch.pendingHandover = false
  } else if (record.phase === "hand-over") {
    // Fresh evidence first: a resumed setup never goes straight to ownership.
    patch.phase = "verify"
  } else if (record.phase === "deploy" && (record.deploymentState === "ValidationFailed" || record.deploymentState === "Failed" || record.deploymentState === "Canceled")) {
    // These states are only saved after Azure confirmed the deployment is over or never
    // accepted it, so the name may be dropped. Any other state is reconciled by polling.
    patch.phase = "discover"
    patch.deploymentName = null
    patch.deploymentState = null
    patch.deploymentSubmittedAt = null
    patch.copiedChannels = []
  } else if (record.state === "failed" && record.phase === "deploy" && !record.deploymentName) {
    patch.phase = "discover"
  } else if (record.phase === "test-run" && record.jobStatus === "SubmitFailed") {
    patch.automationJobId = null
    patch.jobSubmittedAt = null
    patch.jobStatus = null
  }
  const phase = patch.phase ?? record.phase
  patch.steps = stepsWith(record, phase, "pending")
  return patch
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
  const stopped = cancelRequested(deps, tenant, running)
  if (stopped) return stopped
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
  const createdNeedsAlerts = preflight.existing.found && withFindings.mode === "create" && Boolean(withFindings.deploymentName) && !withFindings.alertsHash
  const alertsCanPrecedeBlockers = preflight.findings
    .filter((finding) => finding.severity === "block")
    .every((finding) => ["failure-alert-missing", "schedule-missing", "runbook-missing", "conditional-access-off"].includes(finding.code))
  if (createdNeedsAlerts && alertsCanPrecedeBlockers) {
    const steps = stepsWith(withFindings, "discover", "done", `${preflight.existing.automationAccountName} in ${preflight.existing.resourceGroupName}`)
    return progress(deps, tenant, withFindings, actor, { phase: "alerts", steps }, "Partly created watcher gets its alerts first")
  }
  if (blocker) return block(deps, tenant, withFindings, actor, blocker.code, blocker.message)
  if (preflight.existing.found) {
    let steps = stepsWith(withFindings, "discover", "done", `${preflight.existing.automationAccountName} in ${preflight.existing.resourceGroupName}`)
    if (!withFindings.deploymentName) steps = stepsWith({ ...withFindings, steps }, "deploy", "skipped", "Already in Azure")
    // A watcher this setup created, fully or partly, gets its alerts before the Graph
    // role boundary: with no alerts file it would send every event to every destination.
    const justCreated = createdNeedsAlerts
    return progress(deps, tenant, withFindings, actor, {
      mode: withFindings.deploymentName ? withFindings.mode : "adopt",
      phase: justCreated ? "alerts" : "graph-roles",
      steps,
    }, "Existing watcher found")
  }
  return progress(deps, tenant, withFindings, actor, {
    mode: "create",
    phase: "deploy",
    steps: stepsWith(withFindings, "discover", "done", "No watcher yet"),
  }, "No watcher yet")
}

function channelFingerprint(channel: ReturnType<typeof channelsOf>[number]): string {
  return sha256Hex(canonicalJson({
    kind: channel.kind,
    url: channel.url,
    headerName: channel.headerName,
    headerValue: channel.headerValue,
    signRequests: channel.signRequests,
  }))
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
    const stopped = cancelRequested(deps, tenant, record)
    if (stopped) return stopped
    const properties = asRecord(asRecord(response.body).properties)
    const state = typeof properties.provisioningState === "string" ? properties.provisioningState : null
    if (response.status >= 300 && response.status !== 404) {
      if (ageMs(deps, record.deploymentSubmittedAt) > 45 * 60_000) return block(deps, tenant, record, actor, "deployment-read", `The watcher deployment could not be read: ${armErrorMessage(response.body, response.status)}`)
      return progress(deps, tenant, record, actor, { steps: stepsWith(record, "deploy", "running", "Checking the deployment in Azure") }, "Watcher deployment check will retry")
    }
    if (response.status === 404) {
      // Prepared means no PUT was issued yet. Submitting is ambiguous for a short bound:
      // after it, the account itself is the evidence, and an exact 404 there lets us retry.
      if (record.deploymentState !== "Prepared" && ageMs(deps, record.deploymentSubmittedAt) < 2 * 60_000) {
        return progress(deps, tenant, record, actor, { steps: stepsWith(record, "deploy", "running", "Azure is creating the watcher") }, "Watcher deployment starting")
      }
      const account = await arm(tenant, { method: "GET", path: `${accountBase(record)}?api-version=2023-11-01` })
      if (account.status === 200) {
        return progress(deps, tenant, record, actor, { deploymentState: "Missing", copiedChannels: [], phase: "discover", steps: stepsWith(record, "deploy", "done", "Partly created; checking what is there") }, "Deployment stopped after creating the account")
      }
      if (account.status !== 404) return block(deps, tenant, record, actor, "discovery-incomplete", `Automation account ${record.plan.automationAccountName} could not be read: ${armErrorMessage(account.body, account.status)}`)
      return progress(deps, tenant, record, actor, { deploymentName: null, deploymentState: null, deploymentSubmittedAt: null, copiedChannels: [], steps: stepsWith(record, "deploy", "running", "The earlier submission never reached Azure; trying again") }, "Watcher deployment will be submitted again")
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
    if (state === "Failed" || state === "Canceled") {
      const account = await arm(tenant, { method: "GET", path: `${accountBase(record)}?api-version=2023-11-01` })
      if (account.status === 200) {
        // A partly failed deployment proves nothing about its destination variables.
        return progress(deps, tenant, record, actor, { deploymentState: state, copiedChannels: [], phase: "discover", steps: stepsWith(record, "deploy", "done", "Partly created; checking what is there") }, "Deployment stopped after creating the account")
      }
      if (account.status !== 404) return block(deps, tenant, record, actor, "discovery-incomplete", `Automation account ${record.plan.automationAccountName} could not be read: ${armErrorMessage(account.body, account.status)}`)
      const saved = saveDeploy(deps, tenant, record, { deploymentName: null, deploymentState: state, deploymentSubmittedAt: null, copiedChannels: [] }, actor, "Watcher deployment failed")
      return fail(deps, tenant, saved, actor, armErrorMessage(response.body, response.status))
    }
    if (ageMs(deps, record.deploymentSubmittedAt) > 45 * 60_000) {
      return block(deps, tenant, record, actor, "deployment-timeout", "The watcher deployment has not finished in 45 minutes. Continue the setup to check it again; it will not be submitted twice.")
    }
    return progress(deps, tenant, record, actor, { deploymentState: state ?? record.deploymentState, steps: stepsWith(record, "deploy", "running", "Azure is creating the watcher") }, "Watcher deployment running")
  }

  // The last word before any create: only an exact 404 proves there is no watcher to overwrite.
  const existingAccount = await arm(tenant, { method: "GET", path: `${accountBase(record)}?api-version=2023-11-01` })
  const stoppedBeforeCreate = cancelRequested(deps, tenant, record)
  if (stoppedBeforeCreate) return stoppedBeforeCreate
  if (existingAccount.status === 200) {
    return progress(deps, tenant, record, actor, { phase: "discover", steps: stepsWith(record, "deploy", "running", "Already in Azure; checking it") }, "Watcher already exists")
  }
  if (existingAccount.status !== 404) {
    return block(deps, tenant, record, actor, "discovery-incomplete", `Automation account ${record.plan.automationAccountName} could not be read: ${armErrorMessage(existingAccount.body, existingAccount.status)} Nothing was created.`)
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
    copied.push({ channelId: channel.id, kind, fingerprint: channelFingerprint(channel) })
  }

  const name = `tenuvault-watcher-${record.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  const prepared = saveDeploy(deps, tenant, record, { deploymentName: name, deploymentState: "Prepared", deploymentSubmittedAt: null, copiedChannels: copied, steps: stepsWith(record, "deploy", "running", "Creating in Azure") }, actor, "Watcher deployment prepared")
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
  const stoppedAfterValidate = cancelRequested(deps, tenant, prepared)
  if (stoppedAfterValidate) return stoppedAfterValidate
  const validationError = asRecord(validated.body).error ?? asRecord(asRecord(validated.body).properties).error
  if (validated.status >= 300 || validationError) {
    const saved = saveDeploy(deps, tenant, prepared, { deploymentState: "ValidationFailed", copiedChannels: [] }, actor, "Watcher deployment validation failed")
    return fail(deps, tenant, saved, actor, armErrorMessage(validated.body, validated.status))
  }
  const submitted = saveDeploy(deps, tenant, prepared, { deploymentState: "Submitting", deploymentSubmittedAt: deps.now().toISOString() }, actor, "Watcher deployment submitting")
  let created: Awaited<ReturnType<typeof arm>>
  try {
    created = await arm(tenant, { method: "PUT", path: deploymentPath(record, name), body })
  } catch {
    // Submitting is already saved: a lost answer is reconciled by name, never submitted twice.
    return progress(deps, tenant, submitted, actor, { deploymentState: "Submitting" }, "Watcher deployment answer lost; polling it")
  }
  const stoppedAfterCreate = cancelRequested(deps, tenant, submitted)
  if (stoppedAfterCreate) return stoppedAfterCreate
  if (created.status >= 300) {
    if (created.status === 408 || created.status >= 500) {
      return progress(deps, tenant, submitted, actor, { deploymentState: "Submitting", steps: stepsWith(submitted, "deploy", "running", "Azure did not give a clear answer; checking the deployment") }, "Watcher deployment answer ambiguous; polling it")
    }
    const account = await arm(tenant, { method: "GET", path: `${accountBase(record)}?api-version=2023-11-01` })
    if (account.status === 200) {
      return progress(deps, tenant, submitted, actor, { deploymentState: "Failed", copiedChannels: [], phase: "discover", steps: stepsWith(submitted, "deploy", "done", "Partly created; checking what is there") }, "Deployment stopped after creating the account")
    }
    if (account.status !== 404) return block(deps, tenant, submitted, actor, "discovery-incomplete", `Automation account ${record.plan.automationAccountName} could not be read: ${armErrorMessage(account.body, account.status)}`)
    const saved = saveDeploy(deps, tenant, submitted, { deploymentName: null, deploymentState: "Failed", deploymentSubmittedAt: null, copiedChannels: [] }, actor, "Watcher deployment refused")
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
  const stopped = cancelRequested(deps, tenant, record)
  if (stopped) return stopped
  const checked = saveDeploy(deps, tenant, record, { graphRoles: roles, graphRoleStatus: check.status, missingGraphRoles: check.missing }, actor, "Graph roles checked")
  const nextAfterRoles = checked.alertsHash ? "test-run" as const : "alerts" as const
  if (check.status === "verified") {
    return progress(deps, tenant, checked, actor, { rolesVerifiedAt: deps.now().toISOString(), phase: nextAfterRoles, steps: stepsWith(checked, "graph-roles", "done", "Assigned") }, "Graph roles verified")
  }
  if (check.status === "missing") {
    if (checked.ack.grantRoles) {
      const attempted = checked.grantAttemptedAt ? Date.parse(checked.grantAttemptedAt) : 0
      if (attempted && deps.now().getTime() - attempted < 30_000) {
        return progress(deps, tenant, checked, actor, { steps: stepsWith(checked, "graph-roles", "running", "Waiting for Microsoft Graph to show the assignment") }, "Waiting for Graph role propagation")
      }
      const granted = await grantGraphRoles(deps, tenant, checked.principalId!, check.missing)
      const stoppedAfterGrant = cancelRequested(deps, tenant, checked)
      if (stoppedAfterGrant) return stoppedAfterGrant
      if (!granted.ok) return block(deps, tenant, checked, actor, "needs-admin", `${granted.detail} A Global Administrator can assign ${check.missing.join(", ")} with the commands below.`)
      const saved = saveDeploy(deps, tenant, checked, { grantAttemptedAt: deps.now().toISOString(), steps: stepsWith(checked, "graph-roles", "running", granted.detail) }, actor, "Graph roles assigned")
      return publicWatcherDeploy(saved, tenant)
    }
    return block(deps, tenant, checked, actor, "needs-admin", `A Global Administrator still has to assign ${check.missing.join(", ")} to the watcher identity.`)
  }
  if (checked.ack.rolesConfirmed) {
    return progress(deps, tenant, checked, actor, { phase: nextAfterRoles, steps: stepsWith(checked, "graph-roles", "done", "Confirmed by an administrator; the test run proves it") }, "Graph roles confirmed")
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
  const rolesDone = record.rolesVerifiedAt !== null || record.steps.find((step) => step.id === "graph-roles")?.status === "done"
  // A partly created watcher may reach here ahead of a known blocker solely so it does
  // not run without alerts. Once written, rediscover and surface that blocker instead
  // of granting roles or starting a doomed test run against stale evidence.
  const nextAfterAlerts = record.findings.some((finding) => finding.severity === "block")
    ? "discover" as const
    : rolesDone ? "test-run" as const : "graph-roles" as const
  if (record.alertsHash === currentHash && record.alertsWrittenAt) {
    return progress(deps, tenant, record, actor, { phase: nextAfterAlerts, steps: stepsWith(record, "alerts", "done", "Already with the watcher") }, "Watcher alerts already written")
  }
  const written = await writeWatcherAlerts(deps, tenant, actor, { requireOwnership: false })
  const stopped = cancelRequested(deps, tenant, record)
  if (stopped) return stopped
  if (!written.ok) return block(deps, tenant, record, actor, "alerts-write", written.error)
  return progress(deps, tenant, record, actor, {
    alertsHash: written.hash,
    alertsWrittenAt: written.pushedAt,
    automationJobId: null,
    jobSubmittedAt: null,
    jobStatus: null,
    phase: nextAfterAlerts,
    steps: stepsWith(record, "alerts", "done", `${written.alerts} alert${written.alerts === 1 ? "" : "s"} sent`),
  }, "Alerts written to the watcher")
}

async function advanceTestRun(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  if (!deps.arm) return fail(deps, tenant, record, actor, "This version of TenuVault cannot reach Azure Resource Manager.")
  const arm = deps.arm
  if (record.automationJobId) {
    const response = await arm(tenant, { method: "GET", path: `${accountBase(record)}/jobs/${enc(record.automationJobId)}?api-version=2023-11-01` })
    const stopped = cancelRequested(deps, tenant, record)
    if (stopped) return stopped
    if (response.status === 404) {
      if (ageMs(deps, record.jobSubmittedAt) < 2 * 60_000) {
        return progress(deps, tenant, record, actor, { steps: stepsWith(record, "test-run", "running", "Starting") }, "Watcher test run starting")
      }
      // The saved id was reconciled for two minutes and Azure has no such job: submit a new one.
      return progress(deps, tenant, record, actor, { automationJobId: null, jobSubmittedAt: null, jobStatus: null, steps: stepsWith(record, "test-run", "running", "The earlier submission never reached Azure; trying again") }, "Watcher test run will be submitted again")
    }
    if (response.status >= 300) return block(deps, tenant, record, actor, "test-run", armErrorMessage(response.body, response.status))
    const status = asRecord(asRecord(response.body).properties).status
    const jobStatus = typeof status === "string" ? status : "Running"
    if (FINISHED_JOB_STATES.has(jobStatus)) {
      return progress(deps, tenant, record, actor, { jobStatus, phase: "verify", steps: stepsWith(record, "test-run", jobStatus === "Completed" ? "done" : "blocked", jobStatus) }, `Watcher test run ${jobStatus.toLowerCase()}`)
    }
    if (ageMs(deps, record.jobSubmittedAt) > 20 * 60_000) {
      const saved = saveDeploy(deps, tenant, record, { jobStatus }, actor, "Watcher test run is taking too long")
      return block(deps, tenant, saved, actor, "test-timeout", "The test run has not finished in 20 minutes. Check again to see where it got to.")
    }
    return progress(deps, tenant, record, actor, { jobStatus, steps: stepsWith(record, "test-run", "running", jobStatus) }, "Watcher test run running")
  }
  if (record.capabilities.canStartJobs === false) {
    return progress(deps, tenant, record, actor, { phase: "verify", steps: stepsWith(record, "test-run", "skipped", "Waiting for the next scheduled run") }, "Waiting for a scheduled watcher run")
  }
  const jobId = randomUUID()
  const submitted = saveDeploy(deps, tenant, record, { automationJobId: jobId, jobSubmittedAt: deps.now().toISOString(), jobStatus: "Submitting", steps: stepsWith(record, "test-run", "running", "Starting") }, actor, "Watcher test run submitting")
  let response: Awaited<ReturnType<typeof arm>>
  try {
    response = await arm(tenant, { method: "PUT", path: `${accountBase(record)}/jobs/${enc(jobId)}?api-version=2023-11-01`, body: { properties: { runbook: { name: RUNBOOK }, parameters: {} } } })
  } catch {
    return progress(deps, tenant, submitted, actor, { jobStatus: "Submitting" }, "Watcher test run answer lost; polling it")
  }
  const stopped = cancelRequested(deps, tenant, submitted)
  if (stopped) return stopped
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
    if (response.status === 408 || response.status >= 500) {
      return progress(deps, tenant, submitted, actor, { jobStatus: "Submitting", steps: stepsWith(submitted, "test-run", "running", "Azure did not give a clear answer; checking the job") }, "Watcher test run answer ambiguous; polling it")
    }
    const saved = saveDeploy(deps, tenant, submitted, { jobStatus: "SubmitFailed" }, actor, "Watcher test run refused")
    return block(deps, tenant, saved, actor, "test-run", armErrorMessage(response.body, response.status))
  }
  const status = asRecord(asRecord(response.body).properties).status
  return progress(deps, tenant, submitted, actor, { jobStatus: typeof status === "string" ? status : "Running" }, "Watcher test run accepted")
}

function gateFor(deps: FeatureDeps, tenant: string, record: WatcherDeployRecord, existing: WatcherDeployRecord["existing"], heartbeat: { runAt: string | null; lastError: string | null; alertsHash: string | null; runbookVersion: string | null; identityPrincipalId?: string | null; jobId?: string | null } | null) {
  const channels = channelsOf(deps, tenant)
  const copiedKinds = new Set(record.copiedChannels
    .filter((entry) => {
      const channel = channels.find((candidate) => candidate.id === entry.channelId)
      if (!channel?.enabled || !channel.url) return false
      return entry.fingerprint ? channelFingerprint(channel) === entry.fingerprint : channel.updatedAt === entry.updatedAt
    })
    .map((entry) => entry.kind === "teams" ? "teams" : "webhook"))
  const destinationOk = record.plan.destinationKinds.every((kind) => copiedKinds.has(kind as "teams" | "webhook") || record.ack.destinationConfirmed)
  return handoverGate({
    accountExists: existing.found,
    principalId: existing.principalId ?? record.principalId,
    checkedAt: deps.now().toISOString(),
    identityTenantMatches: existing.identityTenantMatches,
    runbookPublished: existing.runbookPublished,
    runbookVersion: heartbeat?.runbookVersion ?? null,
    scheduleLinked: existing.scheduleLinked,
    failureAlertOk: existing.failureAlert === true || record.plan.noFailureAlert,
    destinationOk,
    needsConditionalAccess: record.plan.needsConditionalAccess,
    watchConditionalAccess: existing.watchConditionalAccess,
    alertsHash: record.alertsHash,
    alertsWrittenAt: record.alertsWrittenAt,
    ...(record.automationJobId ? { jobId: record.automationJobId, jobStatus: record.jobStatus, jobSubmittedAt: record.jobSubmittedAt } : {}),
    heartbeat: heartbeat ? { runAt: heartbeat.runAt, lastError: heartbeat.lastError, alertsHash: heartbeat.alertsHash, identityPrincipalId: heartbeat.identityPrincipalId ?? null, jobId: heartbeat.jobId ?? null } : null,
  })
}

async function readHeartbeat(deps: FeatureDeps, tenant: string) {
  if (!deps.watcherHeartbeat) return { status: "missing" as const }
  return deps.watcherHeartbeat(tenant).catch((error: unknown) => ({ status: "error" as const, message: brief(error instanceof Error ? error.message : String(error)) }))
}

function moveToScheduledVerification(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Stored<WatcherDeployRecord> {
  if (!record.automationJobId || !FINISHED_JOB_STATES.has(record.jobStatus ?? "")) return record
  return saveDeploy(deps, tenant, record, {
    automationJobId: null,
    jobSubmittedAt: null,
    jobStatus: null,
    steps: stepsWith(record, "test-run", record.jobStatus === "Completed" ? "done" : "blocked", "Waiting for a scheduled run"),
  }, actor, "Watcher setup moved to scheduled-run verification")
}

async function advanceVerify(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  const heartbeat = await readHeartbeat(deps, tenant)
  const stopped = cancelRequested(deps, tenant, record)
  if (stopped) return stopped
  if (heartbeat.status === "error") return block(deps, tenant, record, actor, "heartbeat-read", heartbeat.message, true)
  const gate = gateFor(deps, tenant, record, record.existing, heartbeat.status === "ok" ? { runAt: heartbeat.runAt, lastError: heartbeat.lastError, alertsHash: heartbeat.alertsHash ?? null, runbookVersion: heartbeat.runbookVersion ?? null, identityPrincipalId: heartbeat.identityPrincipalId ?? null, jobId: heartbeat.jobId ?? null } : null)
  const checked = saveDeploy(deps, tenant, record, { heartbeatRunAt: heartbeat.status === "ok" ? heartbeat.runAt : record.heartbeatRunAt }, actor, "Watcher run checked")
  if (gate.ok) {
    return progress(deps, tenant, checked, actor, { phase: "hand-over", pendingHandover: false, steps: stepsWith(checked, "verify", "done", "Clean run of these alerts") }, "Watcher run verified")
  }
  const lastError = heartbeat.status === "ok" ? heartbeat.lastError : null
  if (gate.missing.includes("destination")) {
    return block(deps, tenant, checked, actor, "needs-destination", "The watcher has not been shown a destination for every kind these alerts send to. Set its Teams, webhook or mail variables in Azure, then confirm here.")
  }
  if (gate.missing.includes("runbook-version") && heartbeat.status === "ok" && heartbeat.runbookVersion) {
    return block(deps, tenant, checked, actor, "runbook-version", `The watcher runbook is ${heartbeat.runbookVersion}; this setup cannot attribute its runs to the selected watcher and job. Run the current setup script once to upgrade it, then continue here.`)
  }
  if (lastError && /\b(401|403)\b|forbidden|unauthorized|insufficient privileges|authorization_requestdenied/i.test(lastError)) {
    const scheduled = moveToScheduledVerification(deps, tenant, checked, actor)
    return block(deps, tenant, scheduled, actor, "roles-not-effective", "The watcher still cannot read Microsoft Graph. New role assignments can take minutes (rarely hours) to reach a managed identity. Check again later; nothing has been handed over.", true)
  }
  const heartbeatOnly = gate.missing.every((entry) => entry.startsWith("heartbeat") || entry.startsWith("test-job") || entry === "runbook-version")
  if (heartbeatOnly) {
    const writtenAt = record.alertsWrittenAt ? Date.parse(record.alertsWrittenAt) : deps.now().getTime()
    const waited = deps.now().getTime() - writtenAt
    const jobFailed = record.jobStatus !== null && !["Completed", "Running", "Accepted", "Submitting"].includes(record.jobStatus)
    if (jobFailed && lastError) return block(deps, tenant, checked, actor, "test-failed", `The watcher run failed: ${brief(lastError)}`)
    if (waited > 70 * 60_000) {
      const scheduled = moveToScheduledVerification(deps, tenant, checked, actor)
      return block(deps, tenant, scheduled, actor, "waiting-heartbeat", "No clean watcher run of these alerts has been seen yet. It will be checked again while TenuVault runs.", true)
    }
    return progress(deps, tenant, checked, actor, { pendingHandover: true, steps: stepsWith(checked, "verify", "running", "Waiting for a clean run") }, "Waiting for a clean watcher run")
  }
  return block(deps, tenant, checked, actor, "verify", `The watcher is not ready to take over yet (${gate.missing.join(", ")}).`)
}

async function advanceHandOver(deps: FeatureDeps, tenant: string, record: Stored<WatcherDeployRecord>, actor: string | null): Promise<WatcherDeployView> {
  const currentHash = watcherAlertsHash(watcherAlertsDocument(deps, tenant).document)
  if (currentHash !== record.alertsHash) {
    return progress(deps, tenant, record, actor, { phase: "alerts", automationJobId: null, jobSubmittedAt: null, jobStatus: null, steps: stepsWith(record, "hand-over", "pending", "Alerts changed; sending them again") }, "Alerts changed during setup")
  }
  // Evidence from an earlier verification is not enough at the ownership boundary. Read
  // the account, schedule, failure alert and heartbeat again right before standing down.
  const preflight = await watcherPreflight(deps, tenant, { ...record.plan })
  const stoppedAfterCheck = cancelRequested(deps, tenant, record)
  if (stoppedAfterCheck) return stoppedAfterCheck
  const rechecked = saveDeploy(deps, tenant, record, {
    findings: preflight.findings,
    capabilities: preflight.capabilities,
    existing: preflight.existing,
    graphRoles: preflight.graphRoles,
    graphRoleStatus: preflight.graphRoleStatus,
    missingGraphRoles: preflight.missingGraphRoles,
    principalId: preflight.existing.principalId ?? record.principalId,
    heartbeatRunAt: preflight.existing.heartbeatRunAt,
    phase: "verify",
    steps: stepsWith(record, "hand-over", "pending", "Checking everything again before handing over"),
  }, actor, "Watcher rechecked before hand-over")
  if (preflight.planHash !== record.planHash) {
    return block(deps, tenant, rechecked, actor, "plan-changed", "The alerts or Azure target changed since this setup was confirmed. Review the check and start again.")
  }
  const blocker = preflight.findings.find((finding) => finding.severity === "block")
  if (blocker) return block(deps, tenant, rechecked, actor, blocker.code, blocker.message)
  const heartbeat = await readHeartbeat(deps, tenant)
  const stoppedAfterHeartbeat = cancelRequested(deps, tenant, rechecked)
  if (stoppedAfterHeartbeat) return stoppedAfterHeartbeat
  if (heartbeat.status === "error") return block(deps, tenant, rechecked, actor, "heartbeat-read", heartbeat.message, true)
  const gate = gateFor(deps, tenant, rechecked, preflight.existing, heartbeat.status === "ok" ? { runAt: heartbeat.runAt, lastError: heartbeat.lastError, alertsHash: heartbeat.alertsHash ?? null, runbookVersion: heartbeat.runbookVersion ?? null, identityPrincipalId: heartbeat.identityPrincipalId ?? null, jobId: heartbeat.jobId ?? null } : null)
  if (!gate.ok) {
    return progress(deps, tenant, rechecked, actor, { phase: "verify", pendingHandover: true, steps: stepsWith(rechecked, "verify", "running", "Waiting for a clean run") }, "Watcher evidence changed before hand-over")
  }
  const stoppedBeforeHandOver = cancelRequested(deps, tenant, rechecked)
  if (stoppedBeforeHandOver) return stoppedBeforeHandOver
  // No await between this last hash check and the ownership flip: an edit made while
  // Azure or the heartbeat was being read must be sent and proved, not handed over old.
  if (watcherAlertsHash(watcherAlertsDocument(deps, tenant).document) !== record.alertsHash) {
    return progress(deps, tenant, rechecked, actor, { phase: "alerts", automationJobId: null, jobSubmittedAt: null, jobStatus: null, steps: stepsWith(rechecked, "hand-over", "pending", "Alerts changed; sending them again") }, "Alerts changed during final hand-over check")
  }
  handOverToWatcher(deps, tenant, actor, heartbeat.status === "ok" ? { runAt: heartbeat.runAt, alertsHash: heartbeat.alertsHash ?? null, runbookVersion: heartbeat.runbookVersion ?? null, alertsSource: heartbeat.alertsSource ?? null } : undefined)
  const current = watcherDeployOf(deps, tenant, record.id) ?? rechecked
  const steps = current.steps.map((step) => step.status === "skipped" ? step : { ...step, status: "done" as const, error: null })
  const saved = saveDeploy(deps, tenant, current, { state: "complete", phase: "hand-over", pendingHandover: false, blockedReason: null, error: null, steps }, actor, "Azure watcher verified and handed over")
  return publicWatcherDeploy(saved, tenant)
}

/** One bounded step of the deployment. Safe to call again: every step reads state first. */
export async function advanceWatcherDeploy(deps: FeatureDeps, tenantId: string, actor: string | null, jobId?: string | null): Promise<WatcherDeployView | null> {
  const tenant = tenantId.toLowerCase()
  return withDeployLock(deps, tenant, async () => {
    const record = watcherDeployOf(deps, tenant, jobId)
    if (!record) return null
    if (record.state !== "running" || record.cancelRequestedAt) return publicWatcherDeploy(record, tenant)
    try {
      switch (record.phase) {
        case "discover": return await advanceDiscover(deps, tenant, record, actor)
        case "deploy": return await advanceDeploy(deps, tenant, record, actor)
        case "graph-roles": return await advanceGraphRoles(deps, tenant, record, actor)
        case "alerts": return await advanceAlerts(deps, tenant, record, actor)
        case "test-run": return await advanceTestRun(deps, tenant, record, actor)
        case "verify": return await advanceVerify(deps, tenant, record, actor)
        case "hand-over": return await advanceHandOver(deps, tenant, record, actor)
      }
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return publicWatcherDeploy(watcherDeployOf(deps, tenant, record.id) ?? record, tenant)
      const current = watcherDeployOf(deps, tenant, record.id) ?? record
      if (current.state !== "running" || current.cancelRequestedAt) return publicWatcherDeploy(current, tenant)
      return fail(deps, tenant, current, actor, brief(error instanceof Error ? error.message : String(error)))
    }
  })
}

export async function resumeWatcherDeploy(deps: FeatureDeps, tenantId: string, actor: string | null, jobId?: string | null): Promise<WatcherDeployView> {
  const tenant = tenantId.toLowerCase()
  const view = await withDeployLock(deps, tenant, async () => {
    const record = watcherDeployOf(deps, tenant, jobId)
    if (!record) throw new WatcherDeployError("No Azure watcher setup was found.", 404)
    if (TERMINAL_STATES.has(record.state)) return publicWatcherDeploy(record, tenant)
    refuseCancelPending(record)
    const saved = saveDeploy(deps, tenant, record, prepareResumePatch(record), actor, "Azure watcher setup continued")
    return publicWatcherDeploy(saved, tenant)
  })
  if (view.state === "running") kickWatcherDeploy(deps, tenant, actor)
  return view
}

export async function confirmWatcherDeploy(deps: FeatureDeps, tenantId: string, actor: string | null, jobId: string | null | undefined, confirmation: "roles" | "destination" | "grant"): Promise<WatcherDeployView> {
  const tenant = tenantId.toLowerCase()
  const view = await withDeployLock(deps, tenant, async () => {
    const record = watcherDeployOf(deps, tenant, jobId)
    if (!record) throw new WatcherDeployError("No Azure watcher setup was found.", 404)
    if (TERMINAL_STATES.has(record.state)) return publicWatcherDeploy(record, tenant)
    refuseCancelPending(record)
    const ack = {
      ...record.ack,
      ...(confirmation === "roles" ? { rolesConfirmed: true } : {}),
      ...(confirmation === "destination" ? { destinationConfirmed: true } : {}),
      ...(confirmation === "grant" ? { grantRoles: true } : {}),
    }
    const confirmed = saveDeploy(deps, tenant, record, { ack }, actor, confirmation === "roles" ? "Graph roles confirmed by an administrator" : confirmation === "destination" ? "Watcher destination confirmed" : "Graph role assignment approved")
    const saved = saveDeploy(deps, tenant, confirmed, prepareResumePatch(confirmed), actor, "Azure watcher setup continued")
    return publicWatcherDeploy(saved, tenant)
  })
  if (view.state === "running") kickWatcherDeploy(deps, tenant, actor)
  return view
}

export async function cancelWatcherDeploy(deps: FeatureDeps, tenantId: string, actor: string | null, jobId?: string | null): Promise<WatcherDeployView> {
  const tenant = tenantId.toLowerCase()
  const record = watcherDeployOf(deps, tenant, jobId)
  if (!record) throw new WatcherDeployError("No Azure watcher setup was found.", 404)
  if (TERMINAL_STATES.has(record.state)) return publicWatcherDeploy(record, tenant)
  // Intent first, outside the step lock: a step returning from a network call sees it
  // before it can progress, and the hand-over checks it immediately before flipping.
  saveDeploy(deps, tenant, record, { cancelRequestedAt: deps.now().toISOString() }, actor, "Azure watcher setup stop requested")
  runnerMap(deps).get(tenant)?.controller.abort()
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
      if (record.cancelRequestedAt && !TERMINAL_STATES.has(record.state)) {
        saveDeploy(deps, tenantId.toLowerCase(), record, { state: "cancelled", pendingHandover: false, blockedReason: null, nextAttemptAt: null, error: null }, null, "Azure watcher setup cancellation finished after restart. Nothing was handed over")
      } else if (record.state === "running") {
        saveDeploy(deps, tenantId.toLowerCase(), record, { state: "interrupted", error: "TenuVault closed during the setup. Nothing was handed over." }, null, "Azure watcher setup interrupted")
      }
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
    const tenant = tenantId.toLowerCase()
    const record = watcherDeployOf(deps, tenantId)
    if (!record || record.state !== "blocked" || !record.pendingHandover || record.phase !== "verify" || record.cancelRequestedAt) continue
    if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > deps.now().getTime()) continue
    const started = await withDeployLock(deps, tenant, async () => {
      const current = watcherDeployOf(deps, tenant, record.id)
      if (!current || current.updatedAt !== record.updatedAt || current.state !== "blocked" || !current.pendingHandover || current.phase !== "verify" || current.cancelRequestedAt) return false
      saveDeploy(deps, tenant, current, { state: "running", blockedReason: null, error: null }, null, "Checking the watcher again")
      return true
    })
    if (!started) continue
    await advanceWatcherDeploy(deps, tenantId, null, record.id).catch(() => undefined)
    let after = watcherDeployOf(deps, tenantId, record.id)
    if (after?.state === "running" && after.phase === "hand-over") {
      await advanceWatcherDeploy(deps, tenantId, null, record.id).catch(() => undefined)
      after = watcherDeployOf(deps, tenantId, record.id)
    }
    if (after?.state === "running" && !after.cancelRequestedAt) {
      const observed = after
      await withDeployLock(deps, tenant, async () => {
        const current = watcherDeployOf(deps, tenant, record.id)
        // An admin continuation between the periodic advances changes the record and
        // starts its own runner. Only the exact state this check produced may be parked.
        if (!current || current.updatedAt !== observed.updatedAt || current.state !== "running" || current.phase !== observed.phase || current.cancelRequestedAt) return
        if (current.phase === "verify") {
          saveDeploy(deps, tenant, current, {
            state: "blocked",
            blockedReason: "waiting-heartbeat",
            error: "No clean watcher run of these alerts has been seen yet. It will be checked again while TenuVault runs.",
            pendingHandover: true,
            nextAttemptAt: new Date(deps.now().getTime() + 30 * 60_000).toISOString(),
            steps: stepsWith(current, "verify", "blocked", null, "Waiting for a clean watcher run"),
          }, null, "Watcher setup waiting for a scheduled run")
        } else {
          saveDeploy(deps, tenant, current, {
            state: "interrupted",
            pendingHandover: false,
            nextAttemptAt: null,
            error: "The setup changed while it was being checked. Continue it to send and verify the current alerts.",
          }, null, "Azure watcher setup paused for changed alerts")
        }
      })
    }
  }
}
