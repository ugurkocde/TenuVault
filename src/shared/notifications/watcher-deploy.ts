/**
 * The in-app Azure watcher deployment: the plan an admin confirms, the evidence that has to
 * hold before change alerts may move from this computer to the watcher, and the one admin
 * boundary no app can click away (assigning Microsoft Graph application roles). Pure and
 * shared, so the wizard, the main-process engine and the tests judge a watcher the same way.
 * A plan never carries a secret: destination values stay in the channel records in main.
 */
import { WATCHER_STALE_HOURS, type WatcherDestination } from "./alerts"
import { canonicalJson, sha256Hex } from "./envelope"

export type WatcherDeployMode = "adopt" | "create"
export type WatcherDeployState = "running" | "blocked" | "failed" | "cancelled" | "complete" | "interrupted"
export type WatcherDeployStepId = "discover" | "deploy" | "graph-roles" | "alerts" | "test-run" | "verify" | "hand-over"
export type WatcherDeployStepStatus = "pending" | "running" | "done" | "blocked" | "failed" | "skipped"

export interface WatcherDeployStep {
  id: WatcherDeployStepId
  label: string
  status: WatcherDeployStepStatus
  detail: string | null
  error: string | null
}

export const WATCHER_DEPLOY_STEPS: Array<{ id: WatcherDeployStepId; label: string }> = [
  { id: "discover", label: "Check Azure" },
  { id: "deploy", label: "Create the watcher" },
  { id: "graph-roles", label: "Microsoft Graph roles" },
  { id: "alerts", label: "Send the alerts" },
  { id: "test-run", label: "Run the watcher once" },
  { id: "verify", label: "Check the run" },
  { id: "hand-over", label: "Hand over" },
]

export interface WatcherDeployPlanInput {
  subscriptionId?: string
  resourceGroupName?: string
  automationAccountName?: string
  location?: string
  alertEmail?: string
  noFailureAlert?: boolean
  destinationKinds?: WatcherDestination[]
  needsConditionalAccess?: boolean
  createIfMissing?: boolean
}

export interface WatcherDeployPlan {
  subscriptionId: string
  resourceGroupName: string
  automationAccountName: string
  storageAccountName: string
  location: string
  alertEmail: string
  noFailureAlert: boolean
  destinationKinds: WatcherDestination[]
  needsConditionalAccess: boolean
  createIfMissing: boolean
}

export interface WatcherDeployAck {
  /** The watcher already has a destination of every kind these alerts send to (mail: verified). */
  destinationConfirmed: boolean
  /** Kinds whose desktop destination value may be copied into a watcher this deployment creates. */
  copyDestinationKinds: WatcherDestination[]
  /** Assign the Graph roles from this sign-in when Microsoft Graph allows it. */
  grantRoles: boolean
  /** A Global Administrator says the roles are assigned, for when this app cannot read them. */
  rolesConfirmed: boolean
}

export const EMPTY_WATCHER_DEPLOY_ACK: WatcherDeployAck = {
  destinationConfirmed: false,
  copyDestinationKinds: [],
  grantRoles: false,
  rolesConfirmed: false,
}

export interface WatcherFinding {
  severity: "block" | "warn" | "info"
  code: string
  message: string
}

export interface WatcherDeployCapabilities {
  canRead: boolean | null
  canDeploy: boolean | null
  canAssignRoles: boolean | null
  canStartJobs: boolean | null
  canWriteAlertsFile: boolean | null
}

export const UNKNOWN_CAPABILITIES: WatcherDeployCapabilities = {
  canRead: null,
  canDeploy: null,
  canAssignRoles: null,
  canStartJobs: null,
  canWriteAlertsFile: null,
}

export interface ExistingWatcher {
  found: boolean
  automationAccountName: string | null
  resourceGroupName: string | null
  location: string | null
  principalId: string | null
  identityTenantMatches: boolean | null
  runbookPublished: boolean | null
  scheduleLinked: boolean | null
  failureAlert: boolean | null
  watchConditionalAccess: boolean | null
  heartbeatRunAt: string | null
}

export const NO_WATCHER: ExistingWatcher = {
  found: false,
  automationAccountName: null,
  resourceGroupName: null,
  location: null,
  principalId: null,
  identityTenantMatches: null,
  runbookPublished: null,
  scheduleLinked: null,
  failureAlert: null,
  watchConditionalAccess: null,
  heartbeatRunAt: null,
}

export type WatcherGraphRoleStatus = "verified" | "missing" | "unknown" | "not-applicable"

export interface WatcherPreflight {
  plan: WatcherDeployPlan
  planHash: string
  findings: WatcherFinding[]
  capabilities: WatcherDeployCapabilities
  existing: ExistingWatcher
  graphRoles: string[]
  graphRoleStatus: WatcherGraphRoleStatus
  missingGraphRoles: string[]
  alertsHash: string
}

export interface WatcherDeployView {
  id: string
  mode: WatcherDeployMode
  state: WatcherDeployState
  plan: WatcherDeployPlan
  planHash: string
  ack: WatcherDeployAck
  findings: WatcherFinding[]
  capabilities: WatcherDeployCapabilities
  existing: ExistingWatcher
  steps: WatcherDeployStep[]
  graphRoles: string[]
  graphRoleStatus: WatcherGraphRoleStatus
  principalId: string | null
  grantSnippet: string | null
  blockedReason: string | null
  error: string | null
  alertsHash: string | null
  automationJobId: string | null
  createdAt: string
  updatedAt: string
}

const DESTINATION_ORDER: WatcherDestination[] = ["webhook", "teams", "mail"]

/** The plan identity the admin confirmed. A different target, region or destination set is a different setup. */
export function watcherDeployPlanHash(plan: WatcherDeployPlan): string {
  return sha256Hex(canonicalJson({
    ...plan,
    subscriptionId: plan.subscriptionId.toLowerCase(),
    resourceGroupName: plan.resourceGroupName.toLowerCase(),
    automationAccountName: plan.automationAccountName.toLowerCase(),
    storageAccountName: plan.storageAccountName.toLowerCase(),
    location: plan.location.toLowerCase().replace(/\s+/g, ""),
    alertEmail: plan.alertEmail.toLowerCase(),
    destinationKinds: DESTINATION_ORDER.filter((kind) => plan.destinationKinds.includes(kind)),
  }))
}

export interface ArmPermissionGrant {
  actions?: string[]
  notActions?: string[]
  dataActions?: string[]
  notDataActions?: string[]
}

function armPatternMatches(pattern: string, action: string): boolean {
  const escaped = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(action.toLowerCase())
}

/**
 * Whether the effective Azure permissions allow one action. Wildcards match as ARM spells
 * them. Exclusions apply inside the role that carries them, then role results are unioned:
 * Contributor excluding an action does not cancel User Access Administrator granting it.
 * Advisory only: deny assignments and ABAC conditions do not appear in the permissions
 * list, so callers still treat an ARM refusal as the answer.
 */
export function armActionAllowed(grants: readonly ArmPermissionGrant[], action: string, dataAction = false): boolean {
  return grants.some((grant) => {
    const allowed = dataAction ? grant.dataActions ?? [] : grant.actions ?? []
    const denied = dataAction ? grant.notDataActions ?? [] : grant.notActions ?? []
    return allowed.some((pattern) => armPatternMatches(pattern, action)) && !denied.some((pattern) => armPatternMatches(pattern, action))
  })
}

export const WATCHER_GRAPH_ROLES = ["DeviceManagementApps.Read.All", "AuditLog.Read.All", "Mail.Send"] as const

/** The Microsoft Graph application roles the watcher identity needs for these alerts, nothing more. */
export function graphRolesFor(needs: { conditionalAccess: boolean; mail: boolean }): string[] {
  return [
    "DeviceManagementApps.Read.All",
    ...(needs.conditionalAccess ? ["AuditLog.Read.All"] : []),
    ...(needs.mail ? ["Mail.Send"] : []),
  ]
}

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

/**
 * The one command block for a Global Administrator when this app cannot assign the roles
 * itself. Both ids must be GUIDs and every role must be on the watcher allowlist, so no
 * value that reaches this string can break out of its quotes.
 */
export function watcherGrantSnippet(principalId: string, tenantId: string, roles: readonly string[]): string {
  if (!GUID.test(principalId) || !GUID.test(tenantId)) throw new Error("The watcher identity is not known yet.")
  const wanted = [...new Set(roles)]
  if (wanted.length === 0 || wanted.some((role) => !(WATCHER_GRAPH_ROLES as readonly string[]).includes(role))) {
    throw new Error("Only the watcher Graph roles can be assigned this way.")
  }
  const roleList = wanted.map((role) => `"${role}"`).join(", ")
  return [
    "# Run once as a Global Administrator or Privileged Role Administrator.",
    "if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) { Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force -AllowClobber }",
    "Import-Module Microsoft.Graph.Authentication",
    `Connect-MgGraph -Scopes "AppRoleAssignment.ReadWrite.All", "Application.Read.All" -TenantId "${tenantId.toLowerCase()}" -NoWelcome`,
    `$principalId = "${principalId.toLowerCase()}"`,
    `$wanted = @(${roleList})`,
    "$graphSp = @((Invoke-MgGraphRequest -Method Get -Uri \"https://graph.microsoft.com/beta/servicePrincipals?%24filter=appId%20eq%20'00000003-0000-0000-c000-000000000000'\").value) | Select-Object -First 1",
    "$uri = \"https://graph.microsoft.com/beta/servicePrincipals/$principalId/appRoleAssignments\"",
    "$existing = @((Invoke-MgGraphRequest -Method Get -Uri $uri).value)",
    "foreach ($name in $wanted) {",
    "  $role = @($graphSp.appRoles) | Where-Object { $_.value -eq $name -and @($_.allowedMemberTypes) -contains \"Application\" } | Select-Object -First 1",
    "  if (-not $role) { throw \"Graph application role $name was not found.\" }",
    "  if (@($existing | Where-Object { $_.appRoleId -eq $role.id -and $_.resourceId -eq $graphSp.id }).Count -eq 0) {",
    "    $body = @{ principalId = $principalId; resourceId = $graphSp.id; appRoleId = $role.id } | ConvertTo-Json -Compress",
    "    Invoke-MgGraphRequest -Method Post -Uri $uri -Body $body -ContentType \"application/json\" | Out-Null",
    "    Write-Host \"Assigned $name\"",
    "  } else { Write-Host \"Already assigned: $name\" }",
    "}",
  ].join("\n")
}

export interface WatcherHandoverEvidence {
  accountExists: boolean
  /** The selected account's identity; a heartbeat from any other identity is not its proof. */
  principalId?: string | null
  /** When this evidence was read, so a clean heartbeat cannot stay proof forever. */
  checkedAt?: string | null
  identityTenantMatches: boolean | null
  runbookPublished: boolean | null
  runbookVersion: string | null
  scheduleLinked: boolean | null
  failureAlertOk: boolean
  destinationOk: boolean
  needsConditionalAccess: boolean
  watchConditionalAccess: boolean | null
  alertsHash: string | null
  alertsWrittenAt: string | null
  /** Set when this setup started a job: only that job, completed, can supply the proof. */
  jobId?: string | null
  jobStatus?: string | null
  jobSubmittedAt?: string | null
  heartbeat: { runAt: string | null; lastError: string | null; alertsHash: string | null; identityPrincipalId?: string | null; jobId?: string | null } | null
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(version), parts(minimum)]
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return true
}

/**
 * Everything that must be true before this computer stands down for the watcher. The
 * heartbeat is the functional proof: a current run by the selected identity after the
 * alerts were written, running exactly those alerts, with no error, means Graph reads
 * and storage writes work. What a heartbeat
 * cannot say (which destinations exist) stays with the destination evidence the caller
 * gathered: a copied destination on create, or the admin's confirmation on adopt.
 */
export function handoverGate(evidence: WatcherHandoverEvidence): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  if (!evidence.accountExists) missing.push("account")
  if (evidence.identityTenantMatches !== true) missing.push("identity-tenant")
  if (evidence.runbookPublished !== true) missing.push("runbook")
  if (!evidence.runbookVersion || !versionAtLeast(evidence.runbookVersion, "1.3.0")) missing.push("runbook-version")
  if (evidence.scheduleLinked !== true) missing.push("schedule")
  if (!evidence.failureAlertOk) missing.push("failure-alert")
  if (!evidence.destinationOk) missing.push("destination")
  if (evidence.needsConditionalAccess && evidence.watchConditionalAccess !== true) missing.push("conditional-access")
  const heartbeat = evidence.heartbeat
  const runAt = heartbeat?.runAt ? Date.parse(heartbeat.runAt) : Number.NaN
  const writtenAt = evidence.alertsWrittenAt ? Date.parse(evidence.alertsWrittenAt) : Number.NaN
  if (evidence.jobSubmittedAt) {
    const submittedAt = Date.parse(evidence.jobSubmittedAt)
    if (evidence.jobStatus !== "Completed") missing.push("test-job")
    if (!Number.isFinite(runAt) || !Number.isFinite(submittedAt) || runAt < submittedAt || (evidence.jobId && heartbeat?.jobId?.toLowerCase() !== evidence.jobId.toLowerCase())) missing.push("test-job-run")
  }
  if (!Number.isFinite(runAt) || !Number.isFinite(writtenAt) || runAt < writtenAt) missing.push("heartbeat-fresh")
  if (evidence.principalId && heartbeat?.identityPrincipalId?.toLowerCase() !== evidence.principalId.toLowerCase()) missing.push("heartbeat-identity")
  if (evidence.checkedAt && Number.isFinite(runAt)) {
    const checkedAt = Date.parse(evidence.checkedAt)
    if (!Number.isFinite(checkedAt) || runAt > checkedAt + 5 * 60_000 || checkedAt - runAt > WATCHER_STALE_HOURS * 3_600_000) missing.push("heartbeat-stale")
  }
  if (!evidence.alertsHash || !heartbeat || heartbeat.alertsHash !== evidence.alertsHash) missing.push("heartbeat-alerts")
  if (!heartbeat || heartbeat.lastError) missing.push("heartbeat-error")
  return { ok: missing.length === 0, missing }
}
