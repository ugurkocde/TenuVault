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

/** An address plain enough to put on a command an administrator will run. Anything else becomes the placeholder. */
const COMMAND_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

/**
 * Single-quotes a value for PowerShell when it is not made of plain word characters.
 * PowerShell treats the curly single quotes as string delimiters too, so every
 * quote-class character is doubled to the ASCII escape, and line breaks and control
 * characters are dropped: no value can end the literal and start a second command.
 * None of the values this carries (Azure names, ids, an email address) can honestly
 * contain a quote, so nothing real is changed by it.
 */
function psValue(value: string): string {
  if (/^[A-Za-z0-9._@+-]+$/.test(value)) return value
  // oxlint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, "").replace(/['\u2018-\u201b]/g, "''")
  return `'${cleaned}'`
}

/** The kind of destination the Azure watcher must be given to send where the desktop sends. */
export type WatcherSetupDestination = "teams" | "email" | "webhook"

/**
 * The watcher setup command with everything the app already knows filled in, for whoever
 * can create Azure resources. Secrets never go on it and the alerts themselves are
 * pushed from the app afterwards, but the watcher sends with its own destinations, so
 * for the chosen kind the command carries the matching setup parameter as a placeholder
 * to fill in: without it a fresh watcher would run and deliver nothing. Without a
 * failure-alert address that parameter is a placeholder too, because the script refuses
 * to run a watcher that could fail silently. An address that is not plainly an email
 * address is never put on the command at all.
 */
export function watcherSetupCommand(options: {
  tenantId: string
  storageAccount: string
  resourceGroup?: string
  location?: string
  subscriptionId?: string
  alertEmail?: string
  /** Where watcher mail goes. Separate from alertEmail, which only hears about watcher failures. */
  mailRecipient?: string
  includeConditionalAccess: boolean
  destination?: WatcherSetupDestination
}): string {
  const parts = [
    "./New-TenuVaultNotificationWatcher.ps1",
    `-TenantId ${psValue(options.tenantId)}`,
    `-StorageAccountName ${psValue(options.storageAccount)}`,
  ]
  if (options.resourceGroup) parts.push(`-ResourceGroupName ${psValue(options.resourceGroup)}`)
  if (options.location) parts.push(`-Location ${psValue(options.location)}`)
  if (options.subscriptionId) parts.push(`-SubscriptionId ${psValue(options.subscriptionId)}`)
  const alertEmail = options.alertEmail?.trim() ?? ""
  const mailRecipient = options.mailRecipient?.trim() ?? ""
  // Placeholders are quoted, so the value filled in between the quotes (a URL with &
  // in its query, say) stays one literal instead of starting a second command.
  parts.push(`-AlertEmail ${COMMAND_EMAIL.test(alertEmail) ? psValue(alertEmail) : "'<failure-alert-email>'"}`)
  if (options.destination === "teams") parts.push("-TeamsWebhookUrl '<teams-workflows-url>'")
  if (options.destination === "webhook") parts.push("-WebhookUrl '<webhook-url>'")
  if (options.destination === "email") parts.push("-IncludeMailSend", "-MailSender '<sender-mailbox>'", `-MailRecipients ${COMMAND_EMAIL.test(mailRecipient) ? psValue(mailRecipient) : "'<recipient-email>'"}`)
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
  // The grant confirmation decides a hand-over, so it must be said outright: a block
  // pasted short, or with the line damaged, is not a setup to hand alerts to.
  const granted = get("graphrolesgranted").toLowerCase()
  if (granted !== "true" && granted !== "false") return null
  if (!GUID.test(tenantId) || !/^[a-z0-9]{3,24}$/.test(storageAccount) || !automationAccount || !resourceGroup) return null
  return {
    tenantId: tenantId.toLowerCase(),
    storageAccount,
    automationAccount,
    resourceGroup,
    subscriptionId: GUID.test(get("subscriptionid")) ? get("subscriptionid").toLowerCase() : "",
    graphRolesGranted: granted === "true",
  }
}

/** The Alerts guide section about the Azure watcher. */
export const WATCHER_GUIDE_URL = "https://docs.tenuvault.com/notifications/#alerts-while-this-computer-is-off-the-azure-watcher"

const WATCHER_TEMPLATE_URL =
  "https://raw.githubusercontent.com/ugurkocde/TenuVault/main/resources/notifications/azuredeploy.json"

/**
 * The Deploy to Azure portal link for the watcher template. The portal opens the
 * template, nothing else: it cannot carry what was picked here, so the same tenant,
 * storage account and destination values are entered there once.
 */
export function deployWatcherToAzureUrl(): string {
  return `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(WATCHER_TEMPLATE_URL)}`
}
