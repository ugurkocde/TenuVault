/**
 * The guided Alerts setup: the recommended alerts a first setup turns on, whether a tenant
 * counts as set up at all, and the Azure watcher hand-off (the setup command the wizard
 * fills in and the block the setup script prints for pasting back). Pure and shared, so
 * the wizard, the status card and the tests all judge "set up" the same way. Nothing here
 * creates Azure resources: like cloud backups, an Azure administrator runs the command
 * and the app records the result.
 */
import type { AlertConditions, AlertDelivery } from "./alerts"
import { EMPTY_CONDITIONS } from "./alerts"
import type { NotificationEventType, NotificationSeverity } from "./envelope"

/** What a first setup can turn on, in plain-language groups instead of raw event types. */
export interface SetupChoices {
  /** Failed, partial and missed backups, and failed or partial restores. */
  backups: boolean
  /** Policies deleted or unassigned, in Intune and Conditional Access. */
  riskyChanges: boolean
  /** Every Conditional Access policy, named location and authentication strength change. */
  conditionalAccess: boolean
}

export const DEFAULT_SETUP_CHOICES: SetupChoices = { backups: true, riskyChanges: true, conditionalAccess: true }

/** One alert the setup creates. Channel ids are filled in by the wizard. */
export interface SetupAlert {
  title: string
  eventTypes: NotificationEventType[]
  minSeverity: NotificationSeverity
  delivery: AlertDelivery
  conditions: AlertConditions | null
}

/**
 * The alerts for the picked groups. Successful backups stay out on purpose: most tenants
 * find them noise within a week. Titles are stable, so re-running the setup recognizes
 * the alerts it already made instead of adding them again.
 */
export function buildSetupAlerts(choices: SetupChoices): SetupAlert[] {
  const alerts: SetupAlert[] = []
  if (choices.backups) {
    alerts.push({
      title: "Backup and restore problems",
      eventTypes: ["backup.failed", "backup.warning", "backup.missed", "restore.failed", "restore.partial"],
      minSeverity: "info",
      delivery: "digest",
      conditions: null,
    })
  }
  if (choices.riskyChanges) {
    alerts.push({
      title: "Deletions and removed assignments",
      eventTypes: ["intune.change", "entra.change"],
      minSeverity: "info",
      delivery: "each",
      conditions: { ...EMPTY_CONDITIONS, changeTypes: ["deleted", "unassigned"] },
    })
  }
  if (choices.conditionalAccess) {
    alerts.push({
      title: "Conditional Access changes",
      eventTypes: ["entra.change"],
      minSeverity: "info",
      delivery: "each",
      conditions: null,
    })
  }
  return alerts
}

/** Which audit logs the picked groups need change watching for. */
export function setupWatchNeeds(choices: SetupChoices): { intune: boolean; conditionalAccess: boolean } {
  return { intune: choices.riskyChanges, conditionalAccess: choices.riskyChanges || choices.conditionalAccess }
}

export type SetupMissing = "destination" | "alert" | "intune-watching" | "conditional-access-watching"

export interface SetupState {
  /** An enabled channel exists. */
  hasDestination: boolean
  /** An enabled alert sends to an enabled channel, so alerts can actually leave the app. */
  hasWorkingAlert: boolean
  /**
   * Per service a working alert listens to: watched (on this computer or by the Azure
   * watcher), not watched, or null when no working alert needs that service.
   */
  watching: { intune: boolean | null; conditionalAccess: boolean | null }
  azureWatcher: boolean
  missing: SetupMissing[]
  complete: boolean
}

interface SetupChannelLike {
  id: string
  enabled: boolean
}
interface SetupRuleLike {
  enabled: boolean
  channelIds: readonly string[]
  eventTypes: readonly string[]
}
interface SetupWatchLike {
  enabled: boolean
  conditionalAccess?: { enabled: boolean } | null
  externalWatcher: boolean
}

/**
 * Whether alerts are set up well enough to send, judged from what is stored. A channel
 * or an alert on its own is not a setup: an enabled alert must reach an enabled channel,
 * and the services its change alerts listen to must be watched by someone.
 */
export function setupState(input: { channels: readonly SetupChannelLike[]; rules: readonly SetupRuleLike[]; auditWatch: SetupWatchLike | null }): SetupState {
  const enabledChannels = new Set(input.channels.filter((channel) => channel.enabled).map((channel) => channel.id))
  const working = input.rules.filter((rule) => rule.enabled && rule.channelIds.some((id) => enabledChannels.has(id)))
  const azureWatcher = Boolean(input.auditWatch?.externalWatcher)
  const needs = (type: string) => working.some((rule) => rule.eventTypes.includes(type))
  const watching = {
    intune: needs("intune.change") ? azureWatcher || Boolean(input.auditWatch?.enabled) : null,
    conditionalAccess: needs("entra.change") ? azureWatcher || Boolean(input.auditWatch?.conditionalAccess?.enabled) : null,
  }
  const missing: SetupMissing[] = []
  if (enabledChannels.size === 0) missing.push("destination")
  if (working.length === 0) missing.push("alert")
  if (watching.intune === false) missing.push("intune-watching")
  if (watching.conditionalAccess === false) missing.push("conditional-access-watching")
  return {
    hasDestination: enabledChannels.size > 0,
    hasWorkingAlert: working.length > 0,
    watching,
    azureWatcher,
    missing,
    complete: missing.length === 0,
  }
}

/** Single-quotes a value for PowerShell when it is not made of plain word characters. */
function psValue(value: string): string {
  return /^[A-Za-z0-9._@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`
}

/**
 * The watcher setup command with everything the app already knows filled in, for whoever
 * can create Azure resources. Secrets never go on it: no Teams or webhook URL, no mail
 * sender. The watcher's own destinations are set by its setup parameters or variables,
 * and the alerts themselves are pushed from the app afterwards. Without a failure-alert
 * address the command carries a placeholder to replace, because the script refuses to
 * run a watcher that could fail silently.
 */
export function watcherSetupCommand(options: {
  tenantId: string
  storageAccount: string
  resourceGroup?: string
  location?: string
  subscriptionId?: string
  alertEmail?: string
  includeConditionalAccess: boolean
}): string {
  const parts = [
    "./New-TenuVaultNotificationWatcher.ps1",
    `-TenantId ${psValue(options.tenantId)}`,
    `-StorageAccountName ${psValue(options.storageAccount)}`,
  ]
  if (options.resourceGroup) parts.push(`-ResourceGroupName ${psValue(options.resourceGroup)}`)
  if (options.location) parts.push(`-Location ${psValue(options.location)}`)
  if (options.subscriptionId) parts.push(`-SubscriptionId ${psValue(options.subscriptionId)}`)
  parts.push(`-AlertEmail ${options.alertEmail?.trim() ? psValue(options.alertEmail.trim()) : "<failure-alert-email>"}`)
  parts.push("-GrantGraphRoles")
  if (options.includeConditionalAccess) parts.push("-IncludeConditionalAccess")
  return parts.join(" ")
}

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

/** What a finished watcher setup reports back, parsed from the block it prints. */
export interface WatcherSetup {
  tenantId: string
  storageAccount: string
  automationAccount: string
  resourceGroup: string
  subscriptionId: string
  /** False while a Global Administrator still has to assign the Graph roles. */
  graphRolesGranted: boolean
}

/**
 * Parses the setup block printed by New-TenuVaultNotificationWatcher.ps1. Returns null
 * when the pasted text cannot be a watcher setup, so the wizard can say so instead of
 * handing change alerts to a watcher that may not exist.
 */
export function parseWatcherSetup(text: string): WatcherSetup | null {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+?)\s*$/.exec(line)
    if (match) fields.set(match[1]!.toLowerCase(), match[2]!.replace(/^"|"$/g, ""))
  }
  const get = (name: string) => fields.get(name) ?? ""
  const tenantId = get("tenantid")
  const storageAccount = get("storageaccount")
  const automationAccount = get("automationaccount")
  const resourceGroup = get("resourcegroup")
  if (!GUID.test(tenantId) || !/^[a-z0-9]{3,24}$/.test(storageAccount) || !automationAccount || !resourceGroup) return null
  return {
    tenantId: tenantId.toLowerCase(),
    storageAccount,
    automationAccount,
    resourceGroup,
    subscriptionId: GUID.test(get("subscriptionid")) ? get("subscriptionid").toLowerCase() : "",
    graphRolesGranted: get("graphrolesgranted").toLowerCase() !== "false",
  }
}

/** The Alerts guide section about the Azure watcher. */
export const WATCHER_GUIDE_URL = "https://docs.tenuvault.com/notifications/#alerts-while-this-computer-is-off-the-azure-watcher"
