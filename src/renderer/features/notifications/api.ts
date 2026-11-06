import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"
import type { NotificationEnvelope, NotificationEventType, NotificationSeverity } from "../../../shared/notifications/envelope"
import type { CardLayout } from "../../../shared/notifications/layout"
import type { AlertConditions, AlertDelivery, WatcherAlerts } from "../../../shared/notifications/alerts"

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

/** A channel as the renderer may see it: host only, never the URL path or a secret value. */
export interface PublicChannel {
  id: string
  kind: ChannelKind
  title: string
  enabled: boolean
  urlHost: string | null
  headerName: string | null
  hasSecret: boolean
  signRequests: boolean
  recipients: EmailRecipient[]
  lastDelivery: DeliveryResult | null
}

export interface NotificationRule {
  id: string
  title: string
  enabled: boolean
  eventTypes: NotificationEventType[]
  minSeverity: NotificationSeverity
  channelIds: string[]
  mode: "immediate" | "digest"
  conditions: AlertConditions | null
  delivery: AlertDelivery
  summary?: string
}

export interface ConditionalAccessWatchView {
  enabled: boolean
  watermark: string | null
  lastPollAt: string | null
  lastError: string | null
}

export interface AuditWatch {
  conditionalAccess: ConditionalAccessWatchView
  watcherCheck?: { checkedAt: string; lastRunAt: string | null; stale: boolean; error: string | null }
  enabled: boolean
  intervalMinutes: number
  categories: string[]
  ignoreOwnChanges: boolean
  includeActor: boolean
  externalWatcher: boolean
  lastPollAt: string | null
  lastError: string | null
  watermark: string | null
}

export interface DeliveryView {
  id: string
  eventType: string
  title: string
  channelTitle: string
  state: "pending" | "sent" | "failed"
  attempts: number
  lastError: string | null
  at: string
}

export interface NotificationsStatus {
  channels: PublicChannel[]
  rules: NotificationRule[]
  auditWatch: AuditWatch | null
  deliveries: DeliveryView[]
  licensed: boolean
  runtimeNote: string
}

export interface GroupResult {
  id: string
  displayName: string | null
  mail: string | null
}

export interface AddChannelBody {
  kind: ChannelKind
  title?: string
  url?: string
  headerName?: string
  headerValue?: string
  signRequests?: boolean
  recipients?: EmailRecipient[]
}

export interface UpdateChannelBody {
  enabled?: boolean
  title?: string
  /** Replaces the stored URL; omit to keep it. */
  url?: string
  /** Removes the stored secret and turns signing off. */
  clearSecret?: boolean
  headerName?: string
  headerValue?: string
  signRequests?: boolean
  recipients?: EmailRecipient[]
}

export interface RuleBody {
  title?: string
  enabled?: boolean
  eventTypes?: NotificationEventType[]
  minSeverity?: NotificationSeverity
  channelIds?: string[]
  mode?: "immediate" | "digest"
  /** Null clears the conditions: the alert sends every change. */
  conditions?: AlertConditions | null
  delivery?: AlertDelivery
}

export interface AuditWatchBody {
  conditionalAccessEnabled?: boolean
  enabled?: boolean
  intervalMinutes?: number
  categories?: string[]
  ignoreOwnChanges?: boolean
  includeActor?: boolean
  externalWatcher?: boolean
}

const PATH = "/api/notifications" as const

export const notificationsApi = {
  status: (tenant: Tenant) => featureCall<NotificationsStatus>(PATH, tenant, "get-status"),
  addChannel: (tenant: Tenant, body: AddChannelBody) => featureCall<{ channel: PublicChannel }>(PATH, tenant, "add-channel", { ...body }),
  updateChannel: (tenant: Tenant, channelId: string, body: UpdateChannelBody) => featureCall<{ channel: PublicChannel }>(PATH, tenant, "update-channel", { channelId, ...body }),
  revokeChannel: (tenant: Tenant, channelId: string, options: { removeFromRules?: boolean } = {}) => featureCall<{ removed: string; rulesUpdated: number }>(PATH, tenant, "revoke-channel", { channelId, ...options }),
  /** Turning a channel off stays free on every plan; sets enabled false only. */
  revokeDisableChannel: (tenant: Tenant, channelId: string) => featureCall<{ channel: PublicChannel }>(PATH, tenant, "revoke-disable-channel", { channelId }),
  /** With a layout, the test card uses it instead of the saved one; nothing is saved. */
  testChannel: (tenant: Tenant, channelId: string, layout?: CardLayout) => featureCall<{ delivery: DeliveryResult; channel: PublicChannel }>(PATH, tenant, "test-channel", layout ? { channelId, layout } : { channelId }),
  getCardLayout: (tenant: Tenant) => featureCall<{ layout: CardLayout; updatedAt: string | null }>(PATH, tenant, "get-card-layout"),
  saveCardLayout: (tenant: Tenant, layout: CardLayout) => featureCall<{ layout: CardLayout; updatedAt: string | null }>(PATH, tenant, "save-card-layout", { layout }),
  /** Back to the standard card; free on every plan. */
  resetCardLayout: (tenant: Tenant) => featureCall<{ layout: CardLayout; updatedAt: null }>(PATH, tenant, "revoke-card-layout"),
  previewEvent: (tenant: Tenant, channelId?: string) => featureCall<{ body: string; envelope: NotificationEnvelope }>(PATH, tenant, "preview-event", channelId ? { channelId } : {}),
  addRule: (tenant: Tenant, body: RuleBody) => featureCall<{ rule: NotificationRule }>(PATH, tenant, "add-rule", { ...body }),
  updateRule: (tenant: Tenant, ruleId: string, body: RuleBody) => featureCall<{ rule: NotificationRule }>(PATH, tenant, "update-rule", { ruleId, ...body }),
  revokeRule: (tenant: Tenant, ruleId: string) => featureCall<{ removed: string }>(PATH, tenant, "revoke-rule", { ruleId }),
  /** Sends a made up change that passes the alert's conditions to its channels, marked as a test. */
  testRule: (tenant: Tenant, ruleId: string) => featureCall<{ results: Array<{ channelId: string; channelTitle: string; ok: boolean; error: string | null }>; envelope: NotificationEnvelope }>(PATH, tenant, "test-rule", { ruleId }),
  /** The alerts as the Azure watcher reads them, for setup -AlertRulesPath. */
  exportWatcherAlerts: (tenant: Tenant) => featureCall<{ document: WatcherAlerts; json: string; skipped: string[] }>(PATH, tenant, "export-watcher-alerts"),
  updateAuditWatch: (tenant: Tenant, body: AuditWatchBody) => featureCall<{ auditWatch: AuditWatch }>(PATH, tenant, "update-audit-watch", { ...body }),
  /** Turning change watching off stays free on every plan. */
  revokeAuditWatch: (tenant: Tenant) => featureCall<{ auditWatch: AuditWatch }>(PATH, tenant, "revoke-audit-watch"),
  runWatcherCheck: (tenant: Tenant) => featureCall<{ auditWatch: AuditWatch; stale: boolean; enqueued: number; error: string | null }>(PATH, tenant, "run-watcher-check"),
  runAuditWatch: (tenant: Tenant) => featureCall<{ auditWatch: AuditWatch | null; enqueued: number; changes: number; error: string | null; skipped: "off" | "external" | "busy" | null }>(PATH, tenant, "run-audit-watch"),
  listAuditCategories: (tenant: Tenant) => featureCall<{ categories: string[]; source: "graph" | "known" }>(PATH, tenant, "list-audit-categories"),
  listGroups: (tenant: Tenant, search: string) => featureCall<{ groups: GroupResult[] }>(PATH, tenant, "list-groups", { search }).then((result) => result.groups),
}

/** Category names whose split form reads badly. */
const CATEGORY_LABELS: Record<string, string> = {
  EBookManagement: "eBook management",
  EndpointPrivilegeMgmt: "Endpoint privilege management",
  OnPremiseAccess: "On-premises access",
}

/** "DeviceConfiguration" as "Device configuration" for display; the stored value stays the Graph name. */
export function categoryLabel(category: string): string {
  const special = CATEGORY_LABELS[category]
  if (special) return special
  const words = category.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ")
  return words.map((word, index) => (index === 0 || /^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase())).join(" ")
}

export function formatTime(value: string | null | undefined, fallback = "Never"): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : fallback
}

/** Plain labels for the event types a rule can match. */
export const EVENT_TYPE_LABELS: Record<NotificationEventType, string> = {
  "backup.failed": "Backup failed",
  "backup.warning": "Backup completed with warnings",
  "backup.succeeded": "Backup succeeded",
  "backup.missed": "Backup missed",
  "restore.completed": "Restore completed",
  "restore.partial": "Restore partially completed",
  "restore.failed": "Restore failed",
  "drift.detected": "Drift detected",
  "health.finding": "Health review finding",
  "intune.change": "Intune change (audit watch)",
  "entra.change": "Conditional Access change (audit watch)",
  "credential.expiring": "Backup Reader certificate expiring",
  "watcher.stale": "Watcher stale",
  test: "Test notification",
}

export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  local: "This computer",
  webhook: "Webhook",
  teams: "Teams",
  email: "Email",
}
