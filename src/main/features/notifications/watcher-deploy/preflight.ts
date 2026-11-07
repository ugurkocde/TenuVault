import type { FeatureDeps } from "../../deps"
import { armErrorMessage, type ArmResponse } from "../../../azure/arm"
import {
  armActionAllowed,
  graphRolesFor,
  NO_WATCHER,
  UNKNOWN_CAPABILITIES,
  watcherDeployPlanHash,
  type ExistingWatcher,
  type WatcherDeployCapabilities,
  type WatcherDeployPlan,
  type WatcherDeployPlanInput,
  type WatcherFinding,
  type WatcherPreflight,
} from "../../../../shared/notifications/watcher-deploy"
import type { WatcherDestination } from "../../../../shared/notifications/alerts"
import { watcherAlertsHash } from "../../../../shared/notifications/alerts"
import { channelsOf, rulesOf, watcherAlertsDocument, brief } from "../service"
import { isValidEmailAddress, WATCHER_STALE_HOURS } from "../model"
import { checkGraphRoles } from "./graph-roles"

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const STORAGE_NAME = /^[a-z0-9]{3,24}$/
const RUNBOOK = "Invoke-TenuVaultNotificationCheck"
const DESTINATION_ORDER: WatcherDestination[] = ["webhook", "teams", "mail"]

type Record_ = Record<string, unknown>

const asRecord = (value: unknown): Record_ => (value && typeof value === "object" && !Array.isArray(value) ? value as Record_ : {})
const asList = (value: unknown): Record_[] => (Array.isArray(asRecord(value).value) ? (asRecord(value).value as unknown[]).filter((entry): entry is Record_ => Boolean(entry) && typeof entry === "object") : [])
const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null)
const enc = encodeURIComponent

function orderKinds(kinds: Iterable<WatcherDestination>): WatcherDestination[] {
  const set = new Set(kinds)
  return DESTINATION_ORDER.filter((kind) => set.has(kind))
}

/** The plan as confirmed, filled from the tenant's saved Azure placement. Storage always comes from the tenant profile. */
export function normalizeWatcherDeployPlan(deps: FeatureDeps, tenantId: string, input: WatcherDeployPlanInput): WatcherDeployPlan {
  const profile = deps.tenant(tenantId)
  const { document } = watcherAlertsDocument(deps, tenantId)
  const documentKinds = document.alerts.flatMap((alert) => alert.destinations)
  const documentCa = document.alerts.some((alert) => alert.eventTypes.includes("entra.change"))
  return {
    subscriptionId: (input.subscriptionId || profile?.subscriptionId || "").trim().toLowerCase(),
    resourceGroupName: (input.resourceGroupName || profile?.resourceGroupName || "").trim(),
    automationAccountName: (input.automationAccountName || profile?.automationAccountName || "aa-tenuvault-notifications").trim(),
    storageAccountName: (profile?.storageAccountName ?? "").trim().toLowerCase(),
    location: (input.location || profile?.location || "").trim().toLowerCase().replace(/\s+/g, ""),
    alertEmail: (input.alertEmail ?? "").trim().toLowerCase(),
    noFailureAlert: input.noFailureAlert === true,
    destinationKinds: orderKinds([...documentKinds, ...(input.destinationKinds ?? [])]),
    needsConditionalAccess: documentCa || input.needsConditionalAccess === true,
    createIfMissing: input.createIfMissing === true,
  }
}

function localFindings(deps: FeatureDeps, tenantId: string, plan: WatcherDeployPlan): WatcherFinding[] {
  const findings: WatcherFinding[] = []
  const profile = deps.tenant(tenantId)
  if (!profile) findings.push({ severity: "block", code: "tenant", message: "Sign in to this tenant first." })
  if (!STORAGE_NAME.test(plan.storageAccountName)) {
    findings.push({ severity: "block", code: "storage-local", message: "This tenant has no Azure backup storage account for a watcher to read. Choose one in Settings, Storage first." })
  }
  if (!GUID.test(plan.subscriptionId)) findings.push({ severity: "block", code: "missing-subscription", message: "The subscription that holds the backup storage account is not known. Add it above." })
  if (!/^[-\w._()]{1,90}$/.test(plan.resourceGroupName) || plan.resourceGroupName.endsWith(".")) findings.push({ severity: "block", code: "missing-resource-group", message: "The resource group of the watcher is not known. Add it above." })
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,79}$/.test(plan.automationAccountName)) findings.push({ severity: "block", code: "automation-name", message: "That is not an Automation account name." })

  const { document } = watcherAlertsDocument(deps, tenantId)
  if (document.alerts.length === 0 && plan.destinationKinds.length === 0) {
    findings.push({ severity: "block", code: "no-alerts", message: "No alert sends to a Teams, email or webhook channel, so a watcher would have nothing to run." })
  }
  // The watcher has one destination per kind; two desktop channels of a kind would collapse into it.
  const channels = channelsOf(deps, tenantId).filter((channel) => channel.enabled)
  const used = new Set(rulesOf(deps, tenantId).filter((rule) => rule.enabled).flatMap((rule) => rule.channelIds))
  for (const kind of ["teams", "webhook", "email"] as const) {
    const count = channels.filter((channel) => channel.kind === kind && used.has(channel.id)).length
    if (count > 1) findings.push({ severity: "block", code: "multiple-destinations", message: `More than one ${kind === "email" ? "email" : kind} channel sends these alerts. The watcher has one ${kind === "email" ? "mail" : kind} destination, so keep the alerts it should run on one channel of that kind.` })
  }
  if (channels.some((channel) => channel.kind === "webhook" && used.has(channel.id) && channel.headerName)) {
    findings.push({ severity: "warn", code: "webhook-header", message: "A webhook channel here sends a fixed secret header. The watcher cannot copy that; it signs with HMAC instead, or sends to its own webhook set up in Azure." })
  }
  return findings
}

async function armGet(deps: FeatureDeps, tenantId: string, path: string): Promise<ArmResponse> {
  return deps.arm!(tenantId, { method: "GET", path })
}

interface ArmList {
  items: Record_[]
  status: number
  body: unknown
  incomplete: boolean
}

/**
 * Every page of an ARM list, or an honest incomplete result. A nextLink is only followed
 * back into management.azure.com as a path, so a response cannot aim the token elsewhere.
 * Discovery must know when it has not seen everything: a truncated list is not absence.
 */
async function armGetListAll(deps: FeatureDeps, tenantId: string, firstPath: string): Promise<ArmList> {
  const items: Record_[] = []
  const seen = new Set<string>()
  let path: string | null = firstPath
  let last: ArmResponse = { status: 0, body: null, retryAfterSeconds: null }
  for (let page = 0; path && page < 50; page++) {
    if (seen.has(path)) return { items, status: last.status, body: last.body, incomplete: true }
    seen.add(path)
    last = await armGet(deps, tenantId, path)
    if (last.status !== 200) return { items, status: last.status, body: last.body, incomplete: true }
    items.push(...asList(last.body))
    const next = asRecord(last.body).nextLink
    if (next === undefined || next === null || next === "") return { items, status: 200, body: last.body, incomplete: false }
    if (typeof next !== "string") return { items, status: 200, body: last.body, incomplete: true }
    try {
      const url = new URL(next)
      if (url.origin !== "https://management.azure.com") return { items, status: 200, body: last.body, incomplete: true }
      path = `${url.pathname}${url.search}`
    } catch {
      return { items, status: 200, body: last.body, incomplete: true }
    }
  }
  return { items, status: last.status, body: last.body, incomplete: true }
}

function parseVariableValue(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value !== "string") return null
  const raw = value.trim()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === "string") return parsed
    if (typeof parsed === "boolean") return parsed ? "true" : "false"
  } catch {
    // Plain values are stored as they are.
  }
  return raw.replace(/^"|"$/g, "")
}

function resourceGroupOf(id: unknown): string | null {
  return typeof id === "string" ? /\/resourceGroups\/([^/]+)/i.exec(id)?.[1] ?? null : null
}

interface Inspected {
  existing: ExistingWatcher
  variables: Map<string, string | null>
  status: number
  /** Why discovery could not classify this account, when it could not. */
  incomplete: string | null
}

async function variablesFor(deps: FeatureDeps, tenantId: string, base: string): Promise<{ variables: Map<string, string | null>; incomplete: boolean }> {
  const list = await armGetListAll(deps, tenantId, `${base}/variables?api-version=2023-11-01`)
  const variables = new Map<string, string | null>()
  for (const entry of list.items) {
    if (typeof entry.name === "string") variables.set(entry.name, parseVariableValue(asRecord(entry.properties).value))
  }
  return { variables, incomplete: list.incomplete }
}

/**
 * Whether the fixed-name metric alert really watches this account's failed jobs and can
 * notify someone. Existence alone is not enough: a disabled alert, one scoped to another
 * account, or an action group with no enabled receiver all fail silently when it matters.
 */
async function failureAlertFor(deps: FeatureDeps, tenantId: string, subscriptionId: string, resourceGroup: string, accountId: unknown): Promise<boolean | null> {
  const response = await armGet(deps, tenantId, `/subscriptions/${enc(subscriptionId)}/resourceGroups/${enc(resourceGroup)}/providers/microsoft.insights/metricAlerts/${enc("TenuVault watcher failed jobs")}?api-version=2018-03-01`)
  if (response.status === 404) return false
  if (response.status !== 200) return null
  const properties = asRecord(asRecord(response.body).properties)
  if (properties.enabled !== true) return false
  const scopes = Array.isArray(properties.scopes) ? properties.scopes : []
  if (typeof accountId !== "string" || !scopes.some((scope) => typeof scope === "string" && scope.toLowerCase() === accountId.toLowerCase())) return false
  const criteria = asRecord(properties.criteria)
  const allOf = Array.isArray(criteria.allOf) ? criteria.allOf.filter((entry): entry is Record_ => Boolean(entry) && typeof entry === "object") : []
  const failedJobs = allOf.some((criterion) => {
    if (criterion.metricName !== "TotalJob" || criterion.metricNamespace !== "Microsoft.Automation/automationAccounts") return false
    if (criterion.timeAggregation !== "Total" || (criterion.criterionType !== undefined && criterion.criterionType !== "StaticThresholdCriterion")) return false
    const threshold = typeof criterion.threshold === "number" ? criterion.threshold : Number.NaN
    const firesOnOneFailure = criterion.operator === "GreaterThan"
      ? threshold >= 0 && threshold < 1
      : criterion.operator === "GreaterThanOrEqual" && threshold > 0 && threshold <= 1
    if (!firesOnOneFailure) return false
    const dimensions = Array.isArray(criterion.dimensions) ? criterion.dimensions.filter((entry): entry is Record_ => Boolean(entry) && typeof entry === "object") : []
    return dimensions.some((dimension) => dimension.name === "Status" && dimension.operator === "Include" && Array.isArray(dimension.values) && dimension.values.includes("Failed"))
  })
  if (!failedJobs) return false
  const actions = Array.isArray(properties.actions) ? properties.actions.filter((entry): entry is Record_ => Boolean(entry) && typeof entry === "object") : []
  let unknown = false
  for (const action of actions.slice(0, 3)) {
    const groupId = action.actionGroupId
    if (typeof groupId !== "string" || !groupId.startsWith("/subscriptions/")) { unknown = true; continue }
    const group = await armGet(deps, tenantId, `${groupId}?api-version=2023-01-01`)
    if (group.status !== 200) { unknown = true; continue }
    const groupProperties = asRecord(asRecord(group.body).properties)
    if (groupProperties.enabled !== true) continue
    const receivers = ["emailReceivers", "smsReceivers", "webhookReceivers", "azureAppPushReceivers", "voiceReceivers"]
      .flatMap((key) => (Array.isArray(groupProperties[key]) ? groupProperties[key] as unknown[] : []))
      .filter((entry): entry is Record_ => Boolean(entry) && typeof entry === "object")
    if (receivers.some((receiver) => receiver.status === "Enabled" || receiver.status === undefined)) return true
  }
  return unknown ? null : false
}

async function inspectAccount(deps: FeatureDeps, tenantId: string, subscriptionId: string, resourceGroup: string, accountName: string): Promise<Inspected> {
  const base = `/subscriptions/${enc(subscriptionId)}/resourceGroups/${enc(resourceGroup)}/providers/Microsoft.Automation/automationAccounts/${enc(accountName)}`
  const account = await armGet(deps, tenantId, `${base}?api-version=2023-11-01`)
  if (account.status !== 200) {
    return {
      existing: NO_WATCHER,
      variables: new Map(),
      status: account.status,
      incomplete: account.status === 404 ? null : `Automation account ${accountName} could not be read: ${armErrorMessage(account.body, account.status)}`,
    }
  }
  const body = asRecord(account.body)
  const identity = asRecord(body.identity)
  const [variablesResult, runbookResponse, schedulesList, linksList, failureAlert] = await Promise.all([
    variablesFor(deps, tenantId, base),
    armGet(deps, tenantId, `${base}/runbooks/${enc(RUNBOOK)}?api-version=2023-11-01`),
    armGetListAll(deps, tenantId, `${base}/schedules?api-version=2023-11-01`),
    armGetListAll(deps, tenantId, `${base}/jobSchedules?api-version=2023-11-01`),
    failureAlertFor(deps, tenantId, subscriptionId, resourceGroup, body.id),
  ])
  const variables = variablesResult.variables
  const schedules = new Map(schedulesList.items.map((entry) => [String(entry.name ?? ""), asRecord(entry.properties)]))
  const now = deps.now().getTime()
  const scheduleLinked = linksList.incomplete || schedulesList.incomplete
    ? null
    : linksList.items.some((link) => {
        const properties = asRecord(link.properties)
        const runbook = asRecord(properties.runbook)
        const schedule = asRecord(properties.schedule)
        if (runbook.name !== RUNBOOK || typeof schedule.name !== "string") return false
        const found = schedules.get(schedule.name)
        if (!found || found.isEnabled === false) return false
        const next = typeof found.nextRun === "string" ? Date.parse(found.nextRun) : NaN
        const expiry = typeof found.expiryTime === "string" ? Date.parse(found.expiryTime) : NaN
        return (Number.isNaN(next) || next > now) && (Number.isNaN(expiry) || expiry > now)
      })
  const ca = variables.get("TenuVaultWatchConditionalAccess")
  return {
    status: 200,
    variables,
    incomplete: variablesResult.incomplete ? `The variables of Automation account ${accountName} could not be read completely.` : null,
    existing: {
      found: true,
      automationAccountName: textOf(body.name) ?? accountName,
      resourceGroupName: resourceGroupOf(body.id) ?? resourceGroup,
      location: textOf(body.location)?.toLowerCase().replace(/\s+/g, "") ?? null,
      principalId: textOf(identity.principalId),
      identityTenantMatches: typeof identity.tenantId === "string" ? identity.tenantId.toLowerCase() === tenantId.toLowerCase() : null,
      runbookPublished: runbookResponse.status === 200 ? asRecord(asRecord(runbookResponse.body).properties).state === "Published" : runbookResponse.status === 404 ? false : null,
      scheduleLinked,
      failureAlert,
      watchConditionalAccess: ca === undefined || ca === null ? null : ca.toLowerCase() === "true",
      heartbeatRunAt: null,
    },
  }
}

/**
 * Everything that can be known before any Azure write: the subscription really belongs to
 * this tenant, the storage account is reachable by a cloud runbook, what this sign-in may
 * do, and whether a watcher for this tenant and storage account already exists.
 */
export async function watcherPreflight(deps: FeatureDeps, tenantId: string, input: WatcherDeployPlanInput): Promise<WatcherPreflight> {
  const tenant = tenantId.toLowerCase()
  const plan = normalizeWatcherDeployPlan(deps, tenant, input)
  const findings = localFindings(deps, tenant, plan)
  const graphRoles = graphRolesFor({ conditionalAccess: plan.needsConditionalAccess, mail: plan.destinationKinds.includes("mail") })
  const alertsHash = watcherAlertsHash(watcherAlertsDocument(deps, tenant).document)
  const finish = (existing: ExistingWatcher, capabilities: WatcherDeployCapabilities, graphRoleStatus: WatcherPreflight["graphRoleStatus"], missingGraphRoles: string[]): WatcherPreflight => ({
    plan,
    planHash: watcherDeployPlanHash(plan),
    findings,
    capabilities,
    existing,
    graphRoles,
    graphRoleStatus,
    missingGraphRoles,
    alertsHash,
  })
  if (!deps.arm) {
    findings.push({ severity: "block", code: "arm-unavailable", message: "This version of TenuVault cannot reach Azure Resource Manager." })
    return finish(NO_WATCHER, UNKNOWN_CAPABILITIES, "not-applicable", [])
  }
  if (!GUID.test(plan.subscriptionId) || !plan.resourceGroupName) return finish(NO_WATCHER, UNKNOWN_CAPABILITIES, "not-applicable", [])

  let capabilities: WatcherDeployCapabilities = { ...UNKNOWN_CAPABILITIES }
  let existing = NO_WATCHER
  let variables = new Map<string, string | null>()
  try {
    const subscription = await armGet(deps, tenant, `/subscriptions/${enc(plan.subscriptionId)}?api-version=2022-12-01`)
    if (subscription.status === 401 || subscription.status === 403) {
      findings.push({ severity: "block", code: "arm-sign-in", message: "This sign-in cannot read that subscription in Azure. Sign in again, or use an account with at least Reader on it." })
      return finish(existing, { ...capabilities, canRead: false }, "not-applicable", [])
    }
    if (subscription.status !== 200) {
      findings.push({ severity: "block", code: "subscription", message: armErrorMessage(subscription.body, subscription.status) })
      return finish(existing, capabilities, "not-applicable", [])
    }
    const subscriptionBody = asRecord(subscription.body)
    if (typeof subscriptionBody.tenantId === "string" && subscriptionBody.tenantId.toLowerCase() !== tenant) {
      findings.push({ severity: "block", code: "subscription-tenant", message: "That subscription belongs to another directory, so its watcher identity could never read this tenant. Pick a subscription of this tenant." })
    }
    if (typeof subscriptionBody.state === "string" && subscriptionBody.state !== "Enabled") {
      findings.push({ severity: "block", code: "subscription-state", message: `That subscription is ${subscriptionBody.state}, so Azure will not create or run a watcher in it.` })
    }
    const quotaId = textOf(asRecord(subscriptionBody.subscriptionPolicies).quotaId) ?? ""

    const [group, storageList, permissions, automationProvider, insightsProvider] = await Promise.all([
      armGet(deps, tenant, `/subscriptions/${enc(plan.subscriptionId)}/resourcegroups/${enc(plan.resourceGroupName)}?api-version=2022-09-01`),
      armGetListAll(deps, tenant, `/subscriptions/${enc(plan.subscriptionId)}/providers/Microsoft.Storage/storageAccounts?api-version=2023-05-01`),
      armGetListAll(deps, tenant, `/subscriptions/${enc(plan.subscriptionId)}/resourceGroups/${enc(plan.resourceGroupName)}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`),
      armGet(deps, tenant, `/subscriptions/${enc(plan.subscriptionId)}/providers/Microsoft.Automation?api-version=2022-09-01`),
      armGet(deps, tenant, `/subscriptions/${enc(plan.subscriptionId)}/providers/Microsoft.Insights?api-version=2022-09-01`),
    ])
    if (group.status === 200 && !plan.location) plan.location = textOf(asRecord(group.body).location)?.toLowerCase().replace(/\s+/g, "") ?? ""
    if (group.status === 404) findings.push({ severity: "block", code: "resource-group", message: "That resource group was not found in the subscription." })

    const grants = permissions.items
    if (!permissions.incomplete && grants.length) {
      capabilities = {
        canRead: armActionAllowed(grants, "Microsoft.Automation/automationAccounts/read"),
        canDeploy: armActionAllowed(grants, "Microsoft.Resources/deployments/write") && armActionAllowed(grants, "Microsoft.Automation/automationAccounts/write"),
        canAssignRoles: armActionAllowed(grants, "Microsoft.Authorization/roleAssignments/write"),
        canStartJobs: armActionAllowed(grants, "Microsoft.Automation/automationAccounts/jobs/write"),
        canWriteAlertsFile: null,
      }
    }

    let storageGroup: string | null = null
    const storage = storageList.items.find((entry) => String(entry.name ?? "").toLowerCase() === plan.storageAccountName)
    if (storageList.incomplete) {
      findings.push({ severity: "block", code: "storage-read", message: `The storage accounts in that subscription could not be listed completely: ${armErrorMessage(storageList.body, storageList.status)}` })
    } else if (!storage) {
      findings.push({ severity: "block", code: "storage-missing", message: `Storage account ${plan.storageAccountName} is not in that subscription, so it is not the subscription this tenant's backups use.` })
    }
    if (storage) {
      storageGroup = resourceGroupOf(storage.id)
      const properties = asRecord(storage.properties)
      const acls = asRecord(properties.networkAcls)
      if (properties.publicNetworkAccess === "Disabled" || acls.defaultAction === "Deny") {
        findings.push({ severity: "block", code: "storage-firewall", message: "The backup storage account is behind a firewall. An Azure Automation cloud runbook cannot reach it, so this watcher cannot run there." })
      }
      if (typeof storage.id === "string") {
        const storagePermissions = await armGetListAll(deps, tenant, `${storage.id}/blobServices/default/containers/tenuvault-notification-state/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`)
        const storageGrants = storagePermissions.items
        if (!storagePermissions.incomplete && storageGrants.length) {
          capabilities.canWriteAlertsFile = armActionAllowed(storageGrants, "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write", true)
          if (!capabilities.canWriteAlertsFile) {
            findings.push({ severity: "block", code: "storage-write", message: "This sign-in cannot write the watcher's alerts file or read its heartbeat. It needs Storage Blob Data Contributor on the backup storage account, as the storage setup grants." })
          }
        }
      }
    }

    for (const [name, response] of [["Microsoft.Automation", automationProvider], ["Microsoft.Insights", insightsProvider]] as const) {
      if (response.status === 200 && asRecord(response.body).registrationState !== "Registered") {
        findings.push({ severity: "warn", code: "provider", message: `The ${name} resource provider is not registered in this subscription yet. A first deployment can fail until an owner registers it.` })
      }
    }

    let inspected = await inspectAccount(deps, tenant, plan.subscriptionId, plan.resourceGroupName, plan.automationAccountName)
    if (inspected.incomplete) findings.push({ severity: "block", code: "discovery-incomplete", message: `${inspected.incomplete} TenuVault cannot tell whether a watcher is already there, so it will not create or hand over to one.` })
    let automationAccounts: Record_[] = []
    if (!inspected.incomplete) {
      const list = await armGetListAll(deps, tenant, `/subscriptions/${enc(plan.subscriptionId)}/resources?$filter=${enc("resourceType eq 'Microsoft.Automation/automationAccounts'")}&api-version=2021-04-01`)
      automationAccounts = list.items
      if (list.incomplete) {
        findings.push({ severity: "block", code: "discovery-incomplete", message: `The Automation accounts in that subscription could not be listed completely: ${armErrorMessage(list.body, list.status)} TenuVault cannot tell whether a watcher is already there, so it will not create or hand over to one.` })
      } else {
        const matches: Inspected[] = []
        let candidateIncomplete = false
        for (const candidate of automationAccounts) {
          const candidateGroup = resourceGroupOf(candidate.id)
          const candidateName = textOf(candidate.name)
          if (!candidateGroup || !candidateName || (candidateGroup.toLowerCase() === plan.resourceGroupName.toLowerCase() && candidateName.toLowerCase() === plan.automationAccountName.toLowerCase())) continue
          const candidateBase = `/subscriptions/${enc(plan.subscriptionId)}/resourceGroups/${enc(candidateGroup)}/providers/Microsoft.Automation/automationAccounts/${enc(candidateName)}`
          const candidateVariables = await variablesFor(deps, tenant, candidateBase)
          if (candidateVariables.incomplete) { candidateIncomplete = true; continue }
          const candidateTenant = candidateVariables.variables.get("TenuVaultTenantId")
          const candidateStorage = candidateVariables.variables.get("TenuVaultStorageAccount")
          if (candidateTenant?.toLowerCase() !== tenant || candidateStorage?.toLowerCase() !== plan.storageAccountName) continue
          const checked = await inspectAccount(deps, tenant, plan.subscriptionId, candidateGroup, candidateName)
          if (checked.incomplete) candidateIncomplete = true
          else if (checked.existing.found) matches.push(checked)
        }
        if (candidateIncomplete) {
          findings.push({ severity: "block", code: "discovery-incomplete", message: "Some Automation accounts in that subscription could not be checked completely. TenuVault cannot tell whether one of them already watches this tenant, so it will not create or hand over to one." })
        }
        if (matches[0]) {
          if (inspected.existing.found || matches.length > 1) findings.push({ severity: "block", code: "multiple-watchers", message: "More than one watcher points at this tenant and storage account. Remove or disable all but one, so a clean run from another watcher cannot be mistaken for this one's proof." })
          if (!inspected.existing.found) inspected = matches[0]
        }
      }
    }
    existing = inspected.existing
    variables = inspected.variables
    if (existing.found) {
      plan.resourceGroupName = existing.resourceGroupName ?? plan.resourceGroupName
      plan.automationAccountName = existing.automationAccountName ?? plan.automationAccountName
      if (existing.location) plan.location = existing.location
      const variableTenant = variables.get("TenuVaultTenantId")
      const variableStorage = variables.get("TenuVaultStorageAccount")
      if (variableTenant && variableTenant.toLowerCase() !== tenant) findings.push({ severity: "block", code: "watcher-tenant", message: "That Automation account already watches another tenant. Pick another Automation account name." })
      if (variableStorage && variableStorage.toLowerCase() !== plan.storageAccountName) findings.push({ severity: "block", code: "watcher-storage", message: `That watcher reads storage account ${variableStorage}, not this tenant's ${plan.storageAccountName}.` })
      if (existing.identityTenantMatches === false) findings.push({ severity: "block", code: "identity-tenant", message: "The watcher identity belongs to another directory and can never read this tenant." })
      if (existing.runbookPublished === false) findings.push({ severity: "block", code: "runbook-missing", message: "The watcher runbook is not published in that Automation account. Run the setup script once, then check again." })
      if (existing.scheduleLinked === false) findings.push({ severity: "block", code: "schedule-missing", message: "The watcher runbook is not linked to an enabled schedule, so it would not run while this computer is off." })
      if (existing.failureAlert === false && !plan.noFailureAlert) findings.push({ severity: "block", code: "failure-alert-missing", message: "No Azure Monitor failure alert watches this watcher, so it could fail silently. Set one up, or tick that you accept that below." })
      if (plan.needsConditionalAccess && existing.watchConditionalAccess === false) findings.push({ severity: "block", code: "conditional-access-off", message: "These alerts read Conditional Access changes, but the watcher was set up without them. Run its setup with Conditional Access included, then check again." })
    } else {
      if (!plan.createIfMissing) {
        findings.push({ severity: "block", code: "watcher-missing", message: "No watcher was found for this tenant and storage account. Create it from here, or with Deploy to Azure or the setup script under Advanced." })
      } else {
        if (!plan.noFailureAlert && !isValidEmailAddress(plan.alertEmail)) findings.push({ severity: "block", code: "failure-alert-email", message: "Add the address Azure Monitor should mail when a watcher run fails, or tick that you accept a watcher that can fail silently." })
        if (plan.destinationKinds.includes("mail")) findings.push({ severity: "block", code: "mail-create", message: "Watcher email still needs the setup script: it grants Mail.Send, and the Exchange restriction and one-time verification stay manual. Create it there, then verify it from here." })
        if (storageGroup && storageGroup.toLowerCase() !== plan.resourceGroupName.toLowerCase()) findings.push({ severity: "block", code: "storage-resource-group", message: "Creating from here needs the watcher in the storage account's resource group. Use that resource group, or the setup script for a different one." })
        if (capabilities.canDeploy === false || capabilities.canAssignRoles === false) findings.push({ severity: "block", code: "azure-permissions", message: "This sign-in cannot create the watcher or its storage roles in that resource group. It needs Contributor plus role assignment rights there (Owner covers both), or an owner creates it under Advanced." })
        const inRegion = automationAccounts.filter((entry) => String(entry.location ?? "").toLowerCase() === plan.location).length
        if (inRegion >= 2 && /trial|msdn|free|sponsor|student|devtest/i.test(quotaId)) {
          findings.push({ severity: "warn", code: "automation-quota", message: `This subscription already has ${inRegion} Automation accounts in ${plan.location}. Trial and MSDN subscriptions cap them per region, so creating another there may fail; another region usually works.` })
        }
      }
    }

    const heartbeat = deps.watcherHeartbeat ? await deps.watcherHeartbeat(tenant).catch(() => ({ status: "error" as const, message: "The watcher heartbeat could not be read." })) : { status: "missing" as const }
    if (heartbeat.status === "ok") {
      existing = { ...existing, heartbeatRunAt: heartbeat.runAt }
      const heartbeatAge = heartbeat.runAt ? deps.now().getTime() - Date.parse(heartbeat.runAt) : Number.POSITIVE_INFINITY
      const recentHeartbeat = Number.isFinite(heartbeatAge) && heartbeatAge <= WATCHER_STALE_HOURS * 3_600_000
      const version = heartbeat.runbookVersion?.split(".").map((part) => Number.parseInt(part, 10) || 0) ?? []
      if (recentHeartbeat && heartbeat.runbookVersion && (version[0]! < 1 || (version[0] === 1 && (version[1] ?? 0) < 3))) {
        findings.push({ severity: "block", code: "runbook-version", message: `The watcher runbook is ${heartbeat.runbookVersion}; this setup cannot attribute its runs to the selected watcher and job. Run the current setup script once to upgrade it, then check again.` })
      }
      if (recentHeartbeat && !existing.found) findings.push({ severity: "block", code: "unseen-watcher", message: "A watcher already runs against this storage account, but this sign-in cannot see its Automation account. Use an account that can, so a second watcher is not created." })
    } else if (heartbeat.status === "error") {
      findings.push({ severity: "warn", code: "heartbeat", message: heartbeat.message })
    }
  } catch (error) {
    findings.push({ severity: "block", code: "arm-sign-in", message: brief(error instanceof Error ? error.message : String(error)) })
    return finish(existing, capabilities, "not-applicable", [])
  }

  let graphRoleStatus: WatcherPreflight["graphRoleStatus"] = "not-applicable"
  let missingGraphRoles: string[] = []
  if (existing.found && existing.principalId) {
    const check = await checkGraphRoles(deps, tenant, existing.principalId, graphRoles)
    graphRoleStatus = check.status
    missingGraphRoles = check.missing
    if (check.status === "missing") findings.push({ severity: "warn", code: "graph-roles-missing", message: `The watcher identity is missing ${check.missing.join(", ")}. It cannot read changes until a Global Administrator assigns ${check.missing.length === 1 ? "it" : "them"}.` })
    if (check.status === "unknown" && check.detail) findings.push({ severity: "warn", code: "graph-roles-unknown", message: check.detail })
  }
  return finish(existing, capabilities, graphRoleStatus, missingGraphRoles)
}
