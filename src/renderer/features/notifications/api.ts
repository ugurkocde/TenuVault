import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"
import type { NotificationEnvelope, NotificationEventType, NotificationSeverity } from "../../../shared/notifications/envelope"

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
}

export interface AuditWatch {
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
}

export interface AuditWatchBody {
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
  revokeChannel: (tenant: Tenant, channelId: string) => featureCall<{ removed: string }>(PATH, tenant, "revoke-channel", { channelId }),
  testChannel: (tenant: Tenant, channelId: string) => featureCall<{ delivery: DeliveryResult; channel: PublicChannel }>(PATH, tenant, "test-channel", { channelId }),
  previewEvent: (tenant: Tenant, channelId?: string) => featureCall<{ body: string; envelope: NotificationEnvelope }>(PATH, tenant, "preview-event", channelId ? { channelId } : {}),
  addRule: (tenant: Tenant, body: RuleBody) => featureCall<{ rule: NotificationRule }>(PATH, tenant, "add-rule", { ...body }),
  updateRule: (tenant: Tenant, ruleId: string, body: RuleBody) => featureCall<{ rule: NotificationRule }>(PATH, tenant, "update-rule", { ruleId, ...body }),
  revokeRule: (tenant: Tenant, ruleId: string) => featureCall<{ removed: string }>(PATH, tenant, "revoke-rule", { ruleId }),
  updateAuditWatch: (tenant: Tenant, body: AuditWatchBody) => featureCall<{ auditWatch: AuditWatch }>(PATH, tenant, "update-audit-watch", { ...body }),
  runAuditWatch: (tenant: Tenant) => featureCall<{ auditWatch: AuditWatch | null; enqueued: number; changes: number; error: string | null }>(PATH, tenant, "run-audit-watch"),
  listGroups: (tenant: Tenant, search: string) => featureCall<{ groups: GroupResult[] }>(PATH, tenant, "list-groups", { search }).then((result) => result.groups),
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
  "watcher.stale": "Watcher stale",
  test: "Test notification",
}

export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  local: "This computer",
  webhook: "Webhook",
  teams: "Teams",
  email: "Email",
}
