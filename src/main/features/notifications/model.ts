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
  /** Immediate sends per event; digest exists for intune.change, which is already one digest per poll. */
  mode: "immediate" | "digest"
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
}

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
