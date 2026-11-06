import type { CardLayout } from "../../../shared/notifications/layout"
import type { AlertConditions, AlertDelivery } from "../../../shared/notifications/alerts"
import { NOTIFICATION_EVENT_TYPES, type NotificationEnvelope, type NotificationEventType, type NotificationSeverity } from "../../../shared/notifications/envelope"

/** Stored notification records. Secret values live only in these records and never reach the renderer. */

export type ChannelKind = "local" | "webhook" | "teams" | "email"

export type EmailRecipient =
  | { type: "address"; address: string }
  | { type: "group"; groupId: string; displayName?: string | null }

export interface DeliveryResult {
  at: string
  ok: boolean
  attempts: number
  status: number | null
  error: string | null
  test: boolean
}

export interface ChannelRecord {
  kind: ChannelKind
  title: string
  status: "enabled" | "disabled"
  summary: string
  enabled: boolean
  /** Webhook or Teams Workflows URL. Write only from the renderer; views expose the host only. */
  url: string | null
  /** Optional static secret header name for generic webhooks. */
  headerName: string | null
  /** Static header value, also used as the HMAC signing secret when signRequests is on. */
  headerValue: string | null
  signRequests: boolean
  recipients: EmailRecipient[]
  lastDelivery: DeliveryResult | null
  deliveries: DeliveryResult[]
}

export interface RuleRecord {
  title: string
  status: "enabled" | "disabled"
  summary: string
  enabled: boolean
  eventTypes: NotificationEventType[]
  minSeverity: NotificationSeverity
  channelIds: string[]
  /** Kept for records written before alerts had delivery; delivery below decides. */
  mode: "immediate" | "digest"
  /**
   * For change events only: which changes the alert sends. Missing or null sends every change,
   * like rules did before conditions existed.
   */
  conditions?: AlertConditions | null
  /** For change events only: one summary per check (the default) or one alert per change. */
  delivery?: AlertDelivery
}

export type OutboxState = "pending" | "sent" | "failed"

/**
 * One delivery intent per channel and event. Persisted before the send is attempted and
 * marked sent only after the destination acknowledged, so delivery is at least once:
 * a crash between send and mark can repeat one delivery, and receivers can dedupe on
 * the envelope eventId, also sent as a header on webhooks.
 */
export interface OutboxRecord {
  channelId: string
  channelTitle: string
  eventId: string
  envelope: NotificationEnvelope
  state: OutboxState
  attempts: number
  nextAttemptAt: string
  lastError: string | null
  lastStatus: number | null
  sentAt: string | null
}

/** Conditional Access change watching: its own position in the Entra audit log. */
export interface ConditionalAccessWatch {
  enabled: boolean
  /** Raised each time watching is turned on; a poll that started earlier discards its result. */
  generation?: number
  watermark: string | null
  recent: Array<{ id: string; at: string }>
  continuation: string | null
  lastPollAt: string | null
  lastError: string | null
}

/** The tenant's Teams card layout, one record per tenant. */
export interface CardLayoutRecord {
  title: string
  status: "enabled" | "disabled"
  summary: string
  layout: CardLayout
}

export interface AuditWatchRecord {
  title: string
  status: "enabled" | "disabled"
  summary: string
  enabled: boolean
  intervalMinutes: number
  categories: string[]
  ignoreOwnChanges: boolean
  includeActor: boolean
  /** Set when an Azure watcher owns change alerts for this tenant; desktop polling then stands down. */
  externalWatcher: boolean
  watermark: string | null
  /**
   * Audit events already ingested, with their timestamps. Pruned relative to the
   * watermark minus the overlap window, so dedupe always covers the full overlap
   * instead of evicting by count and resurrecting old events as new.
   */
  recent: Array<{ id: string; at: string }>
  /** Next page to resume when a poll stopped on its page or volume cap mid-window. */
  continuation: string | null
  lastPollAt: string | null
  lastError: string | null
  /** Raised each time Intune watching is turned on; a poll that started earlier discards its result. */
  generation?: number
  /** Settings above (interval, own changes, actor, external watcher) apply to both services. */
  conditionalAccess?: ConditionalAccessWatch
  /** Last heartbeat check of the Azure watcher, made while externalWatcher is on. */
  watcherCheck?: { checkedAt: string; lastRunAt: string | null; stale: boolean; error: string | null; alertsHash?: string | null; runbookVersion?: string | null; alertsSource?: string | null }
  /** The alerts this computer last wrote to the Azure watcher's alerts.json, and whether it does so on every change. */
  watcherAlertsSync?: WatcherAlertsSync
}

export interface WatcherAlertsSync {
  /** Write the alerts again whenever an alert or channel changes. */
  auto: boolean
  pushedAt: string | null
  /** watcherAlertsHash of what was written; the heartbeat reports the same value once the watcher runs them. */
  pushedHash: string | null
  /** Why the last write failed, until one succeeds. */
  error: string | null
  errorAt: string | null
}

/** The first runbook version that reads alerts.json, so alerts update without a setup rerun. */
export const WATCHER_ALERTS_FILE_RUNBOOK = "1.2.0"
/** The largest alerts.json written, as the setup script allows for its alerts file. */
export const MAX_WATCHER_ALERTS_LENGTH = 500_000

/** The Azure watcher counts as stale when its heartbeat is older than this. Setup schedules it hourly by default, or every 15 to 30 minutes. */
export { WATCHER_STALE_HOURS } from "../../../shared/notifications/alerts"
/** How often the desktop reads the watcher heartbeat. */
export const WATCHER_CHECK_MINUTES = 30

export const MAX_CHANNELS = 10
export const MAX_RULES = 25
export const MAX_DELIVERY_LOG = 20
export const MAX_OUTBOX_KEPT = 300
export const MAX_RECENT_AUDIT_IDS = 25000
export const MAX_RECIPIENTS = 200

export const SEVERITIES: NotificationSeverity[] = ["info", "warning", "critical"]

export function isSeverity(value: unknown): value is NotificationSeverity {
  return typeof value === "string" && (SEVERITIES as string[]).includes(value)
}

export function isEventType(value: unknown): value is NotificationEventType {
  return typeof value === "string" && (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value)
}

export function isChannelKind(value: unknown): value is ChannelKind {
  return value === "local" || value === "webhook" || value === "teams" || value === "email"
}

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/
const EMAIL_DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

/** Practical address check: dotted local parts and multi label domains are normal mail. */
export function isValidEmailAddress(address: string): boolean {
  if (address.length === 0 || address.length > 320) return false
  const at = address.split("@")
  if (at.length !== 2) return false
  const [local, domain] = at as [string, string]
  if (local.length === 0 || local.length > 64 || !EMAIL_LOCAL.test(local)) return false
  const labels = domain.split(".")
  if (labels.length < 2 || labels.some((label) => !EMAIL_DOMAIN_LABEL.test(label))) return false
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]!)
}
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

/** Parses and bounds the recipient list of an email channel. Returns an error message or the list. */
export function parseRecipients(value: unknown): { ok: true; recipients: EmailRecipient[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: "Add at least one email recipient." }
  if (value.length > 50) return { ok: false, error: "Too many recipient entries. Use a distribution list address instead." }
  const recipients: EmailRecipient[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "A recipient entry is invalid." }
    const record = entry as Record<string, unknown>
    if (record.type === "address") {
      const address = typeof record.address === "string" ? record.address.trim() : ""
      if (!isValidEmailAddress(address)) return { ok: false, error: `"${address.slice(0, 60)}" is not a valid email address.` }
      recipients.push({ type: "address", address })
    } else if (record.type === "group") {
      const groupId = typeof record.groupId === "string" ? record.groupId.trim() : ""
      if (!GUID.test(groupId)) return { ok: false, error: "A group recipient needs the Entra group object ID (a GUID)." }
      const displayName = typeof record.displayName === "string" && record.displayName.trim() ? record.displayName.trim().slice(0, 200) : null
      recipients.push({ type: "group", groupId: groupId.toLowerCase(), displayName })
    } else {
      return { ok: false, error: "A recipient entry is invalid." }
    }
  }
  return { ok: true, recipients }
}

export function urlHost(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
