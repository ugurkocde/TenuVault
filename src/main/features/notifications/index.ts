import type { RouteModule } from "../../api/host"
import { allows } from "../../../shared/plans"
import { NOTIFICATION_EVENT_TYPES, testEvent } from "../../../shared/notifications/envelope"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { featureRoute, FeatureError, optionalText, text, type Body } from "../route"
import { validateHeader, validateWebhookUrl } from "../health-review/rules"
import {
  isChannelKind,
  isEventType,
  isSeverity,
  MAX_CHANNELS,
  MAX_RULES,
  parseRecipients,
  urlHost,
  type AuditWatchRecord,
  type ChannelRecord,
  type RuleRecord,
} from "./model"
import {
  auditWatchOf,
  channelsOf,
  defaultAuditWatch,
  deliverToChannel,
  emit,
  outboxOf,
  pollAuditWatch,
  rulesOf,
  saveAuditWatch,
  tick,
} from "./service"

const TICK_MS = 60_000

export const RUNTIME_NOTE =
  "Desktop notifications and Intune change watching run only while TenuVault is running on this computer and you are signed in to the tenant. For alerts while this computer is off, set up the Azure watcher runbook. Undelivered notifications stay queued and retry on the next launch."

/** /api/notifications. Channels, rules, audit watching, test sends and delivery state per tenant. */
export function routes(deps: FeatureDeps): Record<string, RouteModule> {
  return featureRoute("/api/notifications", deps, {
    "get-status": ({ tenantId, deps, plan }) => ({
      licensed: allows(plan, "notifications"),
      runtimeNote: RUNTIME_NOTE,
      channels: channelsOf(deps, tenantId).map(publicChannel),
      rules: rulesOf(deps, tenantId).map(publicRule),
      auditWatch: publicAuditWatch(auditWatchOf(deps, tenantId)),
      deliveries: outboxOf(deps, tenantId).slice(-30).reverse().map((entry) => ({
        id: entry.id,
        eventId: entry.eventId,
        eventType: entry.envelope.type,
        title: entry.envelope.title,
        channelTitle: entry.channelTitle,
        state: entry.state,
        attempts: entry.attempts,
        lastError: entry.lastError,
        at: entry.sentAt ?? entry.createdAt,
      })),
    }),

    "add-channel": ({ tenantId, body, deps, actor }) => {
      const channels = channelsOf(deps, tenantId)
      if (channels.length >= MAX_CHANNELS) throw new FeatureError("Remove a channel before adding another.")
      if (!isChannelKind(body.kind)) throw new FeatureError("kind must be local, webhook, teams or email")
      const kind = body.kind
      if (kind === "local" && channels.some((channel) => channel.kind === "local")) throw new FeatureError("Local notifications are already set up for this tenant.", 409)
      let url: string | null = null
      let headerName: string | null = null
      let headerValue: string | null = null
      if (kind === "webhook" || kind === "teams") {
        const checked = validateWebhookUrl(text(body, "url", 2000))
        if (!checked.ok) throw new FeatureError(checked.error)
        url = checked.url
      }
      if (kind === "webhook") {
        headerName = optionalText(body, "headerName", 64)
        headerValue = optionalText(body, "headerValue", 2000)
        const signing = bool(body, "signRequests") ?? false
        if (signing && !headerValue) throw new FeatureError("Request signing needs a secret value.")
        const header = validateHeader(headerName, headerValue)
        if (!header.ok && !(signing && !headerName && headerValue)) throw new FeatureError(header.error)
      }
      let recipients: ChannelRecord["recipients"] = []
      if (kind === "email") {
        const parsed = parseRecipients(body.recipients)
        if (!parsed.ok) throw new FeatureError(parsed.error)
        recipients = parsed.recipients
      }
      const fallbackTitle = kind === "local" ? "This computer" : kind === "email" ? "Email" : kind === "teams" ? "Teams channel" : new URL(url!).hostname
      const value: ChannelRecord = {
        kind,
        title: optionalText(body, "title", 120) ?? fallbackTitle,
        status: "enabled",
        summary: summaryFor(kind, url),
        enabled: true,
        url,
        headerName,
        headerValue,
        signRequests: kind === "webhook" ? bool(body, "signRequests") ?? false : false,
        recipients,
        lastDelivery: null,
        deliveries: [],
      }
      const created = deps.records.create<ChannelRecord>(DOMAINS.notificationChannels, tenantId, value, { actor, reason: `Notification channel added (${kind})` })
      return { channel: publicChannel(created) }
    },

    "update-channel": ({ tenantId, body, deps, actor }) => {
      const channel = requireChannel(deps, tenantId, body)
      const changes: Partial<ChannelRecord> = {}
      const notes: string[] = []
      const enabled = bool(body, "enabled")
      if (enabled !== undefined) { changes.enabled = enabled; changes.status = enabled ? "enabled" : "disabled"; notes.push(enabled ? "enabled" : "disabled") }
      const title = optionalText(body, "title", 120)
      if (title) { changes.title = title; notes.push("renamed") }
      if (channel.kind === "webhook" && (body.headerName !== undefined || body.headerValue !== undefined)) {
        const headerName = optionalText(body, "headerName", 64)
        const headerValue = optionalText(body, "headerValue", 2000)
        const header = validateHeader(headerName, headerValue)
        const signing = bool(body, "signRequests") ?? channel.signRequests
        if (!header.ok && !(signing && !headerName && headerValue)) throw new FeatureError(header.error)
        changes.headerName = headerName
        changes.headerValue = headerValue
        notes.push(headerValue ? "secret replaced" : "secret removed")
      }
      const signRequests = bool(body, "signRequests")
      if (signRequests !== undefined) {
        const secret = changes.headerValue !== undefined ? changes.headerValue : channel.headerValue
        if (signRequests && !secret) throw new FeatureError("Request signing needs a secret value.")
        changes.signRequests = signRequests
        notes.push(signRequests ? "signing on" : "signing off")
      }
      if (channel.kind === "email" && body.recipients !== undefined) {
        const parsed = parseRecipients(body.recipients)
        if (!parsed.ok) throw new FeatureError(parsed.error)
        changes.recipients = parsed.recipients
        notes.push("recipients changed")
      }
      const updated = deps.records.update<ChannelRecord>(DOMAINS.notificationChannels, tenantId, channel.id, (value) => ({ ...value, ...changes }), { actor, reason: notes.length ? `Channel ${notes.join(", ")}` : "Channel saved" })
      return { channel: publicChannel(updated!) }
    },

    "revoke-channel": ({ tenantId, body, deps }) => {
      const channel = requireChannel(deps, tenantId, body)
      deps.records.remove(DOMAINS.notificationChannels, tenantId, channel.id)
      return { removed: channel.id }
    },

    "test-channel": async ({ tenantId, body, deps, actor }) => {
      const channel = requireChannel(deps, tenantId, body)
      const envelope = testEvent({ tenantId, tenantName: deps.tenant(tenantId)?.name ?? null, occurredAt: deps.now().toISOString(), channelTitle: channel.title, source: "desktop" })
      const delivery = await deliverToChannel(deps, tenantId, channel, envelope)
      const updated = deps.records.update<ChannelRecord>(DOMAINS.notificationChannels, tenantId, channel.id, (value) => ({ ...value, lastDelivery: delivery, deliveries: [...value.deliveries, delivery].slice(-20) }), { actor, reason: delivery.ok ? "Test delivery succeeded" : `Test delivery failed: ${delivery.error ?? "unknown error"}` })
      return { delivery, channel: publicChannel(updated!) }
    },

    "preview-event": ({ tenantId, body, deps }) => {
      const channel = typeof body.channelId === "string" ? requireChannel(deps, tenantId, body) : null
      const envelope = testEvent({ tenantId, tenantName: deps.tenant(tenantId)?.name ?? null, occurredAt: deps.now().toISOString(), channelTitle: channel?.title ?? "Preview", source: "desktop" })
      return { body: JSON.stringify(envelope, null, 2), envelope }
    },

    "add-rule": ({ tenantId, body, deps, actor }) => {
      if (rulesOf(deps, tenantId).length >= MAX_RULES) throw new FeatureError("Remove a rule before adding another.")
      const value: RuleRecord = {
        title: optionalText(body, "title", 120) ?? "Notification rule",
        status: "enabled",
        summary: "",
        enabled: bool(body, "enabled") ?? true,
        eventTypes: eventTypes(body.eventTypes),
        minSeverity: severity(body.minSeverity),
        channelIds: channelIds(deps, tenantId, body.channelIds),
        mode: body.mode === "digest" ? "digest" : "immediate",
      }
      value.summary = ruleSummary(value)
      value.status = value.enabled ? "enabled" : "disabled"
      const created = deps.records.create<RuleRecord>(DOMAINS.notificationRules, tenantId, value, { actor, reason: "Notification rule added" })
      return { rule: publicRule(created) }
    },

    "update-rule": ({ tenantId, body, deps, actor }) => {
      const rule = requireRule(deps, tenantId, body)
      const changes: Partial<RuleRecord> = {}
      const enabled = bool(body, "enabled")
      if (enabled !== undefined) { changes.enabled = enabled; changes.status = enabled ? "enabled" : "disabled" }
      const title = optionalText(body, "title", 120)
      if (title) changes.title = title
      if (body.eventTypes !== undefined) changes.eventTypes = eventTypes(body.eventTypes)
      if (body.minSeverity !== undefined) changes.minSeverity = severity(body.minSeverity)
      if (body.channelIds !== undefined) changes.channelIds = channelIds(deps, tenantId, body.channelIds)
      if (body.mode !== undefined) changes.mode = body.mode === "digest" ? "digest" : "immediate"
      const updated = deps.records.update<RuleRecord>(DOMAINS.notificationRules, tenantId, rule.id, (value) => {
        const next = { ...value, ...changes }
        next.summary = ruleSummary(next)
        return next
      }, { actor, reason: "Notification rule changed" })
      return { rule: publicRule(updated!) }
    },

    "revoke-rule": ({ tenantId, body, deps }) => {
      const rule = requireRule(deps, tenantId, body)
      deps.records.remove(DOMAINS.notificationRules, tenantId, rule.id)
      return { removed: rule.id }
    },

    "update-audit-watch": ({ tenantId, body, deps, actor }) => {
      const change: Partial<AuditWatchRecord> = {}
      const enabled = bool(body, "enabled")
      if (enabled !== undefined) change.enabled = enabled
      if (body.intervalMinutes !== undefined) {
        const minutes = Number(body.intervalMinutes)
        if (!Number.isFinite(minutes)) throw new FeatureError("intervalMinutes is invalid")
        change.intervalMinutes = Math.min(24 * 60, Math.max(5, Math.round(minutes)))
      }
      if (body.categories !== undefined) {
        if (!Array.isArray(body.categories) || body.categories.length > 50 || body.categories.some((entry) => typeof entry !== "string" || entry.length > 120)) throw new FeatureError("categories is invalid")
        change.categories = (body.categories as string[]).map((entry) => entry.trim()).filter(Boolean)
      }
      const ignoreOwnChanges = bool(body, "ignoreOwnChanges")
      if (ignoreOwnChanges !== undefined) change.ignoreOwnChanges = ignoreOwnChanges
      const includeActor = bool(body, "includeActor")
      if (includeActor !== undefined) change.includeActor = includeActor
      const externalWatcher = bool(body, "externalWatcher")
      if (externalWatcher !== undefined) change.externalWatcher = externalWatcher
      const current = auditWatchOf(deps, tenantId)
      if (enabled === true && !current?.watermark) change.watermark = deps.now().toISOString()
      const saved = saveAuditWatch(deps, tenantId, change, { actor, reason: enabled === false ? "Intune change watching turned off" : enabled === true ? "Intune change watching turned on" : "Intune change watching changed" })
      return { auditWatch: publicAuditWatch(saved) }
    },

    "run-audit-watch": async ({ tenantId, deps }) => {
      const result = await pollAuditWatch(deps, tenantId)
      return { auditWatch: publicAuditWatch(auditWatchOf(deps, tenantId)), enqueued: result.enqueued, changes: result.changes, error: result.error }
    },

    "list-groups": async ({ tenantId, body, deps }) => {
      const search = text(body, "search", 100).replace(/'/g, "''")
      const graph = await deps.graph(tenantId)
      const response = await graph("GET", `groups?$filter=${encodeURIComponent(`startswith(displayName,'${search}')`)}&$select=id,displayName,mail&$top=20`)
      if (response.status !== 200) throw new FeatureError("Groups could not be searched. Paste the group object ID instead.", 502)
      const values = Array.isArray((response.body as Record<string, unknown>).value) ? ((response.body as Record<string, unknown>).value as Array<Record<string, unknown>>) : []
      return { groups: values.map((group) => ({ id: group.id, displayName: group.displayName ?? null, mail: group.mail ?? null })) }
    },
  })
}

/** Background work while the app runs: outbox retries and due audit polls every minute. */
export function start(deps: FeatureDeps): () => void {
  const timer = setInterval(() => void tick(deps).catch(() => undefined), TICK_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

function summaryFor(kind: ChannelRecord["kind"], url: string | null): string {
  if (kind === "local") return "System notifications on this computer."
  if (kind === "email") return "Email through Microsoft Graph."
  if (kind === "teams") return "Adaptive Card to a Teams Workflows webhook."
  return `POST to ${urlHost(url) ?? "a webhook"}.`
}

function ruleSummary(rule: RuleRecord): string {
  return `${rule.eventTypes.length} event types at ${rule.minSeverity} or above to ${rule.channelIds.length} channels.`
}

function eventTypes(value: unknown): RuleRecord["eventTypes"] {
  if (!Array.isArray(value) || value.length === 0) throw new FeatureError("Pick at least one event type.")
  const types = value.filter(isEventType)
  if (types.length !== value.length) throw new FeatureError(`eventTypes must be among: ${NOTIFICATION_EVENT_TYPES.join(", ")}`)
  return [...new Set(types)]
}

function severity(value: unknown): RuleRecord["minSeverity"] {
  if (value === undefined) return "info"
  if (!isSeverity(value)) throw new FeatureError("minSeverity must be info, warning or critical")
  return value
}

function channelIds(deps: FeatureDeps, tenantId: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new FeatureError("Pick at least one channel.")
  const known = new Set(channelsOf(deps, tenantId).map((channel) => channel.id))
  const ids = value.map((entry) => (typeof entry === "string" ? entry : ""))
  if (ids.some((id) => !known.has(id))) throw new FeatureError("A selected channel no longer exists.")
  return [...new Set(ids)]
}

function bool(body: Body, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new FeatureError(`${key} must be true or false`)
  return value
}

function requireChannel(deps: FeatureDeps, tenantId: string, body: Body): Stored<ChannelRecord> {
  const channel = deps.records.get<ChannelRecord>(DOMAINS.notificationChannels, tenantId, text(body, "channelId", 100))
  if (!channel) throw new FeatureError("Channel not found", 404)
  return channel
}

function requireRule(deps: FeatureDeps, tenantId: string, body: Body): Stored<RuleRecord> {
  const rule = deps.records.get<RuleRecord>(DOMAINS.notificationRules, tenantId, text(body, "ruleId", 100))
  if (!rule) throw new FeatureError("Rule not found", 404)
  return rule
}

/** A channel as the renderer may see it: no URL path, no secret value, no history snapshots. */
export function publicChannel(channel: Stored<ChannelRecord>) {
  const { history, headerValue, url, ...rest } = channel
  return {
    ...rest,
    urlHost: urlHost(url),
    hasSecret: Boolean(headerValue),
    history: history.map(({ at, actor, reason }) => ({ at, actor, reason })),
  }
}

export function publicRule(rule: Stored<RuleRecord>) {
  const { history, ...rest } = rule
  return { ...rest, history: history.map(({ at, actor, reason }) => ({ at, actor, reason })) }
}

export function publicAuditWatch(watch: Stored<AuditWatchRecord> | null) {
  const value = watch ?? { ...defaultAuditWatch(), id: null, createdAt: null, updatedAt: null, history: [] }
  const { history, recentIds: _recentIds, ...rest } = value as Stored<AuditWatchRecord>
  return { ...rest, history: (history ?? []).map(({ at, actor, reason }) => ({ at, actor, reason })) }
}

// The emit export is part of the module surface for producers in the main process.
export { emit }
