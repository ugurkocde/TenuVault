import type { RouteModule } from "../../api/host"
import { allows } from "../../../shared/plans"
import { NOTIFICATION_EVENT_TYPES, testEvent } from "../../../shared/notifications/envelope"
import { changeEvent } from "../../../shared/notifications/audit"
import { describeConditions, hasConditions, isChangeEventType, parseConditions, parseDelivery, WATCHER_ALERTS_SCHEMA, watcherAlertsHash, type WatcherAlert, type WatcherAlerts, type WatcherDestination } from "../../../shared/notifications/alerts"
import { DEFAULT_CARD_LAYOUT, isDefaultLayout, parseCardLayout, styleIssues } from "../../../shared/notifications/layout"
import type { FeatureDeps } from "../deps"
import { normalizeBackupStatus } from "../../../portal/lib/backup-health"
import type { BackupSummary } from "../../../portal/components/backup/types"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { featureRoute, FeatureError, optionalText, text, type ActionHandler, type Body } from "../route"
import { validateHeader, validateWebhookUrl } from "../health-review/rules"
import {
  isChannelKind,
  isEventType,
  isSeverity,
  MAX_CHANNELS,
  MAX_RULES,
  MAX_WATCHER_ALERTS_LENGTH,
  WATCHER_ALERTS_FILE_RUNBOOK,
  parseRecipients,
  urlHost,
  type AuditWatchRecord,
  type CardLayoutRecord,
  type ChannelRecord,
  type RuleRecord,
  type WatcherAlertsSync,
} from "./model"
import {
  alertMatcher,
  auditWatchOf,
  brief,
  cardLayoutOf,
  channelsOf,
  layoutOf,
  checkWatcher,
  copyRulesToTenants,
  defaultAuditWatch,
  previewChangeAlert,
  retryDelivery,
  defaultConditionalAccessWatch,
  deliverToChannel,
  emit,
  outboxOf,
  pollAuditWatch,
  rulesOf,
  saveAuditWatch,
  tick,
  type AuditWatchChange,
} from "./service"

const TICK_MS = 60_000

/** Intune audit categories as returned by getAuditCategories (checked 2026-11-05), for when Graph cannot be asked. */
export const KNOWN_AUDIT_CATEGORIES = [
  "AdminTask", "Application", "AssignmentFilter", "Autopilot", "Compliance", "ConditionalAccess", "Deployment", "Device",
  "DeviceConfiguration", "DeviceIntent", "DeviceIntentSetting", "DeviceInventory", "DeviceSecurity", "DeviceSetupConfiguration",
  "EBookManagement", "Enrollment", "EndpointPrivilegeMgmt", "GroupPolicyAnalytics", "OnPremiseAccess", "Other", "RemoteHelp",
  "Role", "SoftwareUpdates",
] as const

export const RUNTIME_NOTE =
  "Desktop alerts and change watching run only while TenuVault is running on this computer and you are signed in to the tenant. For alerts while this computer is off, set up the Azure watcher runbook and copy your alerts to it. Undelivered notifications stay queued and retry on the next launch."

/** /api/notifications. Channels, rules, audit watching, test sends and delivery state per tenant. */
export function routes(deps: FeatureDeps): Record<string, RouteModule> {
  const handlers: Record<string, ActionHandler> = {
    "get-status": ({ tenantId, deps, plan }) => ({
      licensed: allows(plan, "notifications"),
      runtimeNote: RUNTIME_NOTE,
      channels: channelsOf(deps, tenantId).map(publicChannel),
      rules: rulesOf(deps, tenantId).map(publicRule),
      auditWatch: publicAuditWatch(auditWatchOf(deps, tenantId)),
      // Whether the Azure watcher runs these alerts: the hash its heartbeat reported, against now.
      watcherAlerts: watcherAlertsStatus(deps, tenantId),
      signedIn: Boolean(deps.actor(tenantId)),
      deliveries: outboxOf(deps, tenantId).slice(-50).reverse().map((entry) => ({
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
      // URLs and secrets are write only: an omitted or empty value keeps the stored one, so an
      // edit dialog never has to show them. clearSecret removes the secret explicitly.
      if ((channel.kind === "webhook" || channel.kind === "teams") && typeof body.url === "string" && body.url.trim()) {
        const checked = validateWebhookUrl(text(body, "url", 2000))
        if (!checked.ok) throw new FeatureError(checked.error)
        changes.url = checked.url
        changes.summary = summaryFor(channel.kind, checked.url)
        notes.push("URL replaced")
      }
      const clearSecret = bool(body, "clearSecret") === true
      if (channel.kind === "webhook" && (body.headerName !== undefined || optionalText(body, "headerValue", 2000) !== null || clearSecret)) {
        // Removing the secret also removes its header name: a name without a value is no header.
        const headerName = clearSecret ? null : body.headerName !== undefined ? optionalText(body, "headerName", 64) : channel.headerName
        const replaced = optionalText(body, "headerValue", 2000)
        const headerValue = clearSecret ? null : replaced ?? channel.headerValue
        const signing = clearSecret ? false : bool(body, "signRequests") ?? channel.signRequests
        if (signing && !headerValue) throw new FeatureError("Request signing needs a secret value.")
        if (headerName || headerValue) {
          const header = validateHeader(headerName, headerValue)
          if (!header.ok && !(signing && !headerName && headerValue)) throw new FeatureError(header.error)
        }
        changes.headerName = headerValue ? headerName : null
        changes.headerValue = headerValue
        if (clearSecret) changes.signRequests = false
        notes.push(clearSecret ? "secret removed" : replaced ? "secret replaced" : "header renamed")
      }
      const signRequests = clearSecret ? undefined : bool(body, "signRequests")
      if (signRequests !== undefined && channel.kind === "webhook") {
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

    // Turning a channel off stays free on every plan, like revoking it.
    "revoke-disable-channel": ({ tenantId, body, deps, actor }) => {
      const channel = requireChannel(deps, tenantId, body)
      const updated = deps.records.update<ChannelRecord>(DOMAINS.notificationChannels, tenantId, channel.id, (value) => ({ ...value, enabled: false, status: "disabled" as const }), { actor, reason: "Channel turned off" })
      return { channel: publicChannel(updated!) }
    },

    // Free like every revoke: removing a channel may also take it out of the rules that use it.
    // A rule left without channels is turned off, never deleted, so its choices are kept.
    "revoke-channel": ({ tenantId, body, deps, actor }) => {
      const channel = requireChannel(deps, tenantId, body)
      deps.records.remove(DOMAINS.notificationChannels, tenantId, channel.id)
      let rulesUpdated = 0
      if (bool(body, "removeFromRules") === true) {
        // Ids of channels removed earlier are dropped too, so "no channel left" means no live one.
        const live = new Set(channelsOf(deps, tenantId).map((entry) => entry.id))
        for (const rule of rulesOf(deps, tenantId).filter((candidate) => candidate.channelIds.includes(channel.id))) {
          deps.records.update<RuleRecord>(DOMAINS.notificationRules, tenantId, rule.id, (value) => {
            const channelIds = value.channelIds.filter((id) => live.has(id))
            const next: RuleRecord = { ...value, channelIds, ...(channelIds.length === 0 ? { enabled: false, status: "disabled" as const } : {}) }
            next.summary = ruleSummary(next)
            return next
          }, { actor, reason: `Channel ${channel.title} removed from the rule` })
          rulesUpdated++
        }
      }
      return { removed: channel.id, rulesUpdated }
    },

    "test-channel": async ({ tenantId, body, deps, actor }) => {
      const channel = requireChannel(deps, tenantId, body)
      const envelope = testEvent({ tenantId, tenantName: deps.tenant(tenantId)?.name ?? null, occurredAt: deps.now().toISOString(), channelTitle: channel.title, source: "desktop" })
      // The layout editor sends a test with the layout being edited, before it is saved.
      const layout = body.layout !== undefined ? parseCardLayout(body.layout) : undefined
      if (layout && styleIssues(layout.base).length) throw new FeatureError(styleIssues(layout.base)[0]!.message)
      const delivery = await deliverToChannel(deps, tenantId, channel, envelope, layout)
      const updated = deps.records.update<ChannelRecord>(DOMAINS.notificationChannels, tenantId, channel.id, (value) => ({ ...value, lastDelivery: delivery, deliveries: [...value.deliveries, delivery].slice(-20) }), { actor, reason: delivery.ok ? "Test delivery succeeded" : `Test delivery failed: ${delivery.error ?? "unknown error"}` })
      return { delivery, channel: publicChannel(updated!) }
    },

    "preview-event": ({ tenantId, body, deps }) => {
      const channel = typeof body.channelId === "string" ? requireChannel(deps, tenantId, body) : null
      const envelope = testEvent({ tenantId, tenantName: deps.tenant(tenantId)?.name ?? null, occurredAt: deps.now().toISOString(), channelTitle: channel?.title ?? "Preview", source: "desktop" })
      return { body: JSON.stringify(envelope, null, 2), envelope }
    },

    "add-rule": ({ tenantId, body, deps, actor }) => {
      if (rulesOf(deps, tenantId).length >= MAX_RULES) throw new FeatureError("Remove an alert before adding another.")
      const value: RuleRecord = {
        title: optionalText(body, "title", 120) ?? "Alert",
        status: "enabled",
        summary: "",
        enabled: bool(body, "enabled") ?? true,
        eventTypes: eventTypes(body.eventTypes),
        minSeverity: severity(body.minSeverity),
        channelIds: channelIds(deps, tenantId, body.channelIds),
        mode: body.mode === "digest" ? "digest" : "immediate",
        conditions: conditions(body.conditions),
        delivery: delivery(body.delivery),
      }
      value.summary = ruleSummary(value)
      value.status = value.enabled ? "enabled" : "disabled"
      const created = deps.records.create<RuleRecord>(DOMAINS.notificationRules, tenantId, value, { actor, reason: "Alert added" })
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
      if (body.conditions !== undefined) changes.conditions = conditions(body.conditions)
      if (body.delivery !== undefined) changes.delivery = delivery(body.delivery)
      const updated = deps.records.update<RuleRecord>(DOMAINS.notificationRules, tenantId, rule.id, (value) => {
        const next = { ...value, ...changes }
        next.summary = ruleSummary(next)
        return next
      }, { actor, reason: "Alert changed" })
      return { rule: publicRule(updated!) }
    },

    // A sample change sent to the alert's channels now, outside the outbox, marked as a test.
    "test-rule": async ({ tenantId, body, deps, actor }) => {
      const rule = requireRule(deps, tenantId, body)
      const channels = channelsOf(deps, tenantId).filter((channel) => rule.channelIds.includes(channel.id))
      if (channels.length === 0) throw new FeatureError("This alert sends to no channel. Edit it and pick one.")
      const envelope = sampleAlertEnvelope(deps, tenantId, rule)
      const results = []
      for (const channel of channels) {
        const delivery = await deliverToChannel(deps, tenantId, channel, envelope)
        deps.records.update<ChannelRecord>(DOMAINS.notificationChannels, tenantId, channel.id, (value) => ({ ...value, lastDelivery: delivery, deliveries: [...value.deliveries, delivery].slice(-20) }), { actor, reason: delivery.ok ? `Alert test for ${rule.title} delivered` : `Alert test for ${rule.title} failed: ${delivery.error ?? "unknown error"}` })
        results.push({ channelId: channel.id, channelTitle: channel.title, ok: delivery.ok, error: delivery.error })
      }
      return { results, envelope }
    },

    // Writes the alerts to the watcher's alerts.json, which it reads on its next run, so the
    // setup script does not run again. Also turns updating on every change on or off.
    "push-watcher-alerts": async ({ tenantId, body, deps, actor }) => {
      const auto = bool(body, "auto")
      if (auto !== undefined) saveWatcherSync(deps, tenantId, { auto }, actor, auto ? "Watcher alerts update on every change" : "Watcher alerts update only on request")
      if (bool(body, "write") === false) return { watcherAlerts: watcherAlertsStatus(deps, tenantId) }
      const result = await pushWatcherAlerts(deps, tenantId, actor)
      if (!result.ok) throw new FeatureError(result.error, result.status)
      return { ...result, watcherAlerts: watcherAlertsStatus(deps, tenantId) }
    },

    // The alerts as the Azure watcher reads them (setup -AlertRulesPath). Channels become kinds
    // of destinations, because the watcher has its own webhook, Teams URL and mail settings.
    "export-watcher-alerts": ({ tenantId, deps }) => {
      const { document, skipped } = watcherAlertsDocument(deps, tenantId)
      // Events the watcher produces that no copied alert takes stop reaching any destination.
      const uncovered = uncoveredWatcherEvents(document)
      return { document, json: JSON.stringify(document, null, 2), skipped, uncovered }
    },

    // Policy names from the newest backup and setting names seen in recent alerts, for the
    // pickers of the alert dialog. A failure to read backups leaves the list empty.
    "list-alert-suggestions": async ({ tenantId, deps }) => {
      const settings = new Set<string>()
      for (const entry of outboxOf(deps, tenantId)) for (const item of entry.envelope.items) for (const name of item.change?.settings ?? []) settings.add(name)
      for (const rule of rulesOf(deps, tenantId)) for (const name of parseConditions(rule.conditions)?.settingNames ?? []) settings.add(name)
      let policies: Array<{ name: string; type: string; service: "intune" | "conditionalAccess" }> = []
      let backup: { id: string; at: string | null } | null = null
      let error: string | null = null
      try {
        const listed = await deps.api("/api/list-backups", tenantId)
        if (!listed.ok) throw new Error(`The backup list answered HTTP ${listed.status}.`)
        const listing = (await listed.json().catch(() => ({}))) as { backups?: Array<BackupSummary & { timestamp?: string; createdAt?: string }> }
        // The newest complete backup, else the newest partial one; unavailable or running ones list nothing.
        const backups = (listing.backups ?? []).filter((entry) => typeof entry.id === "string")
        const chosen = backups.find((entry) => normalizeBackupStatus(entry) === "success") ?? backups.find((entry) => normalizeBackupStatus(entry) === "partial")
        if (chosen?.id) {
          backup = { id: chosen.id, at: chosen.timestamp ?? chosen.createdAt ?? null }
          const read = await deps.api("/api/list-backup-contents", tenantId, { backupId: chosen.id })
          if (!read.ok) throw new Error(`The backup contents answered HTTP ${read.status}.`)
          const contents = (await read.json().catch(() => ({}))) as { content?: { groups?: Array<{ folder?: string; label?: string; policies?: Array<{ displayName?: string }> }> } }
          const seen = new Set<string>()
          for (const group of contents.content?.groups ?? []) {
            const service = /conditionalaccess|namedlocation|authenticationstrength/i.test(group.folder ?? "") ? "conditionalAccess" : "intune"
            for (const policy of group.policies ?? []) {
              const name = (policy.displayName ?? "").trim()
              const key = `${service}|${name.toLowerCase()}`
              if (!name || seen.has(key)) continue
              seen.add(key)
              policies.push({ name: name.slice(0, 200), type: (group.label ?? group.folder ?? "").slice(0, 120), service })
            }
          }
          policies = policies.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 3000)
        }
      } catch (failure) {
        error = failure instanceof Error ? failure.message.slice(0, 200) : "The backups could not be read."
      }
      return { policies, settings: [...settings].sort((a, b) => a.localeCompare(b)).slice(0, 500), backup, error }
    },

    // What an alert, saved or still being edited, would have sent for the last days. Reads the
    // audit logs; nothing is queued, sent or remembered.
    "preview-rule": async ({ tenantId, body, deps }) => {
      const types = eventTypes(body.eventTypes)
      if (!types.some(isChangeEventType)) throw new FeatureError("A preview reads the audit logs, so the alert needs Intune change or Conditional Access change.")
      if (!deps.actor(tenantId)) throw new FeatureError("Sign in to this tenant to read its audit logs.")
      const days = Math.min(30, Math.max(1, Math.round(Number(body.days ?? 7)) || 7))
      return previewChangeAlert(deps, tenantId, { id: "preview", enabled: true, eventTypes: types, minSeverity: severity(body.minSeverity), conditions: conditions(body.conditions), delivery: delivery(body.delivery) }, days)
    },

    // One delivery with the event it carried, for the delivery view. Stored data only.
    "get-delivery": ({ tenantId, body, deps }) => {
      const entry = outboxOf(deps, tenantId).find((candidate) => candidate.id === text(body, "deliveryId", 100))
      if (!entry) throw new FeatureError("Delivery not found", 404)
      const channel = channelsOf(deps, tenantId).find((candidate) => candidate.id === entry.channelId)
      return { id: entry.id, state: entry.state, attempts: entry.attempts, lastError: entry.lastError, sentAt: entry.sentAt, channelTitle: entry.channelTitle, channelKind: channel?.kind ?? null, envelope: entry.envelope }
    },

    "retry-delivery": async ({ tenantId, body, deps, actor }) => {
      const retried = await retryDelivery(deps, tenantId, text(body, "deliveryId", 100), actor)
      if (!retried) throw new FeatureError("Only a failed delivery can be retried.", 409)
      return { state: retried.state, lastError: retried.lastError, attempts: retried.attempts }
    },

    // Copies alerts to other connected tenants of the license (MSP portfolio).
    "portfolio-copy-rules": ({ tenantId, body, deps, actor, targetTenants }) => {
      if (!Array.isArray(body.ruleIds) || body.ruleIds.length === 0 || body.ruleIds.some((id) => typeof id !== "string")) throw new FeatureError("Pick at least one alert to copy.")
      if (targetTenants.length === 0) throw new FeatureError("Pick at least one tenant to copy to.")
      const known = new Set(rulesOf(deps, tenantId).map((rule) => rule.id))
      const ruleIds = (body.ruleIds as string[]).filter((id) => known.has(id))
      if (ruleIds.length === 0) throw new FeatureError("The picked alerts no longer exist.")
      return { results: copyRulesToTenants(deps, tenantId, ruleIds, targetTenants, actor, ruleSummary).map((result) => ({ ...result, tenantName: deps.tenant(result.tenantId)?.name ?? result.tenantId })) }
    },


    "revoke-rule": ({ tenantId, body, deps }) => {
      const rule = requireRule(deps, tenantId, body)
      deps.records.remove(DOMAINS.notificationRules, tenantId, rule.id)
      return { removed: rule.id }
    },

    "update-audit-watch": ({ tenantId, body, deps, actor }) => {
      const change: AuditWatchChange = {}
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
      // Conditional Access keeps its own position in the Entra audit log, and like Intune
      // starts from now when it is turned on (keeping its dedupe ids for the overlap).
      const conditionalAccess = bool(body, "conditionalAccessEnabled")
      if (conditionalAccess !== undefined) {
        const previous = current?.conditionalAccess ?? defaultConditionalAccessWatch()
        change.conditionalAccess = conditionalAccess && !previous.enabled
          ? { ...previous, enabled: true, watermark: deps.now().toISOString(), continuation: null, lastPollAt: null, generation: (previous.generation ?? 0) + 1 }
          : { ...previous, enabled: conditionalAccess }
      }
      // Turning watching on starts from now. Catching up from an old watermark would replay
      // every change made while it was off, which is history, not news. A closed app with
      // watching left on still catches up in the poller, because enabled never flipped.
      // The dedupe ids stay: the first poll reads 30 minutes back, and changes delivered just
      // before watching was turned off must not be sent again. They age out on their own.
      if (enabled === true && !current?.enabled) {
        change.watermark = deps.now().toISOString()
        change.continuation = null
        change.lastPollAt = null
        change.generation = (current?.generation ?? 0) + 1
      }
      // A change of ownership between this computer and the Azure watcher overtakes any poll
      // still waiting on Graph, also when it is switched on and off again during that poll.
      // Positions are kept: only the generations move.
      if (externalWatcher !== undefined && externalWatcher !== Boolean(current?.externalWatcher)) {
        // A service turned on in this same save already got a new generation above.
        const intuneGeneration = current?.generation ?? 0
        if (change.generation === undefined) change.generation = intuneGeneration + 1
        const caBefore = current?.conditionalAccess?.generation ?? 0
        const ca = change.conditionalAccess ?? current?.conditionalAccess ?? defaultConditionalAccessWatch()
        if ((ca.generation ?? 0) === caBefore) change.conditionalAccess = { ...ca, generation: caBefore + 1 }
      }
      const reasons = [
        enabled === true && !current?.enabled ? "Intune change watching turned on" : enabled === false && current?.enabled ? "Intune change watching turned off" : null,
        conditionalAccess === true && !current?.conditionalAccess?.enabled ? "Conditional Access change watching turned on" : conditionalAccess === false && current?.conditionalAccess?.enabled ? "Conditional Access change watching turned off" : null,
      ].filter(Boolean)
      const saved = saveAuditWatch(deps, tenantId, change, { actor, reason: reasons.length ? reasons.join(", ") : "Change watching changed" })
      return { auditWatch: publicAuditWatch(saved) }
    },

    // Turning change watching off stays free on every plan.
    "revoke-audit-watch": ({ tenantId, deps, actor }) => {
      const current = auditWatchOf(deps, tenantId)
      const saved = saveAuditWatch(deps, tenantId, { enabled: false, conditionalAccess: { ...(current?.conditionalAccess ?? defaultConditionalAccessWatch()), enabled: false } }, { actor, reason: "Change watching turned off" })
      return { auditWatch: publicAuditWatch(saved) }
    },

    "run-watcher-check": async ({ tenantId, deps }) => {
      const result = await checkWatcher(deps, tenantId)
      return { auditWatch: publicAuditWatch(auditWatchOf(deps, tenantId)), ...result }
    },

    "run-audit-watch": async ({ tenantId, deps }) => {
      const result = await pollAuditWatch(deps, tenantId)
      return { auditWatch: publicAuditWatch(auditWatchOf(deps, tenantId)), enqueued: result.enqueued, changes: result.changes, error: result.error, skipped: result.skipped ?? null }
    },

    // The categories Intune itself reports, so the filter can only hold names that match.
    "list-audit-categories": async ({ tenantId, deps }) => {
      try {
        const graph = await deps.graph(tenantId)
        const response = await graph("GET", "deviceManagement/auditEvents/getAuditCategories")
        const values = (response.body as Record<string, unknown>)?.value
        if (response.status === 200 && Array.isArray(values)) {
          const names = values.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 120)
          if (names.length) return { categories: [...new Set(names)].sort((a, b) => a.localeCompare(b)), source: "graph" }
        }
      } catch {
        // Signed out or offline: the known list below still lets the filter be edited.
      }
      return { categories: [...KNOWN_AUDIT_CATEGORIES], source: "known" }
    },

    "get-card-layout": ({ tenantId, deps }) => {
      const stored = cardLayoutOf(deps, tenantId)
      return { layout: layoutOf(deps, tenantId), updatedAt: stored?.updatedAt ?? null, history: (stored?.history ?? []).slice(-10).map(({ at, actor, reason }) => ({ at, actor, reason })) }
    },

    "save-card-layout": ({ tenantId, body, deps, actor }) => {
      const layout = parseCardLayout(body.layout)
      for (const style of [layout.base, ...Object.values(layout.overrides)]) {
        const issues = styleIssues(style)
        if (issues.length) throw new FeatureError(issues[0]!.message)
      }
      const value: CardLayoutRecord = { title: "Teams card layout", status: "enabled", summary: isDefaultLayout(layout) ? "Default layout" : "Custom layout", layout }
      const current = cardLayoutOf(deps, tenantId)
      const saved = current
        ? deps.records.update<CardLayoutRecord>(DOMAINS.notificationCardLayout, tenantId, current.id, () => value, { actor, reason: "Teams card layout changed" })!
        : deps.records.create<CardLayoutRecord>(DOMAINS.notificationCardLayout, tenantId, value, { actor, reason: "Teams card layout saved" })
      return { layout: parseCardLayout(saved.layout), updatedAt: saved.updatedAt }
    },

    // Free like every revoke: going back to the default card needs no plan.
    "revoke-card-layout": ({ tenantId, deps }) => {
      const current = cardLayoutOf(deps, tenantId)
      if (current) deps.records.remove(DOMAINS.notificationCardLayout, tenantId, current.id)
      return { layout: DEFAULT_CARD_LAYOUT, updatedAt: null }
    },

    "list-groups": async ({ tenantId, body, deps }) => {
      const search = text(body, "search", 100).replace(/'/g, "''")
      const graph = await deps.graph(tenantId)
      const response = await graph("GET", `groups?$filter=${encodeURIComponent(`startswith(displayName,'${search}')`)}&$select=id,displayName,mail&$top=20`)
      if (response.status !== 200) throw new FeatureError("Groups could not be searched. Paste the group object ID instead.", 502)
      const values = Array.isArray((response.body as Record<string, unknown>).value) ? ((response.body as Record<string, unknown>).value as Array<Record<string, unknown>>) : []
      return { groups: values.map((group) => ({ id: group.id, displayName: group.displayName ?? null, mail: group.mail ?? null })) }
    },
  }
  // Changes to alerts or channels change what the watcher should run; with automatic updates on,
  // the new alerts go to it right after the change is saved.
  for (const action of WATCHER_SYNC_ACTIONS) handlers[action] = withWatcherSync(handlers[action]!)
  // Copied alerts change the target tenants, each checked for the same plan by the portfolio guard.
  const copyRules = handlers["portfolio-copy-rules"]!
  handlers["portfolio-copy-rules"] = async (context) => {
    const result = await copyRules(context)
    for (const target of context.targetTenants) await syncWatcherAlerts(context.deps, target, context.actor, true)
    return result
  }
  return featureRoute("/api/notifications", deps, handlers)
}

/** Actions after which the watcher's alerts can differ. */
const WATCHER_SYNC_ACTIONS = ["add-rule", "update-rule", "revoke-rule", "update-channel", "revoke-disable-channel", "revoke-channel"] as const

function withWatcherSync(handler: ActionHandler): ActionHandler {
  return async (context) => {
    const result = await handler(context)
    const sync = await syncWatcherAlerts(context.deps, context.tenantId, context.actor, allows(context.plan, "notifications"))
    return sync && result && typeof result === "object" ? { ...result, watcherSync: sync } : result
  }
}

export type WatcherPushResult =
  | { ok: true; hash: string; pushedAt: string; alerts: number; skipped: string[]; uncovered: string[] }
  | { ok: false; error: string; status: number }

/**
 * Writes the current alerts to the Azure watcher's alerts.json and records what was written.
 * Refused without an alert the watcher can send, because the watcher would then send every
 * event to every destination: that stays a choice made in its setup (-AlertRulesPath "").
 */
export function pushWatcherAlerts(deps: FeatureDeps, tenantId: string, actor: string | null): Promise<WatcherPushResult> {
  const key = tenantId.toLowerCase()
  const run = (pushQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => pushNow(deps, tenantId, actor))
  pushQueues.set(key, run)
  // The caller handles a failure of run; this cleanup must not raise it a second time.
  run.finally(() => { if (pushQueues.get(key) === run) pushQueues.delete(key) }).catch(() => undefined)
  return run
}

async function pushNow(deps: FeatureDeps, tenantId: string, actor: string | null): Promise<WatcherPushResult> {
  const fail = (error: string, status = 400): WatcherPushResult => {
    saveWatcherSync(deps, tenantId, { error, errorAt: deps.now().toISOString() }, actor, `Watcher alerts not updated: ${error}`)
    return { ok: false, error, status }
  }
  if (!auditWatchOf(deps, tenantId)?.externalWatcher) return { ok: false, error: "No Azure watcher owns change alerts for this tenant. Turn on \"An Azure watcher handles change alerts\" in the Watching tab first.", status: 409 }
  if (!deps.watcherAlertsWrite) return fail("This version of TenuVault cannot write to the watcher's storage.", 501)
  const { document, skipped } = watcherAlertsDocument(deps, tenantId)
  if (document.alerts.length === 0) return fail("No alert sends to a webhook, Teams or email channel, so there is nothing for the watcher to run. Add such a channel to an alert first.")
  const json = JSON.stringify(document, null, 2)
  if (json.length > MAX_WATCHER_ALERTS_LENGTH) return fail("The alerts are larger than 500 KB. Shorten their conditions.")
  let written: Awaited<ReturnType<NonNullable<FeatureDeps["watcherAlertsWrite"]>>>
  try {
    written = await deps.watcherAlertsWrite(tenantId, json)
  } catch (error) {
    written = { status: "error", message: brief(error instanceof Error ? error.message : String(error)) }
  }
  if (written.status !== "ok") return fail(written.message, 502)
  const hash = watcherAlertsHash(document)
  const pushedAt = deps.now().toISOString()
  saveWatcherSync(deps, tenantId, { pushedAt, pushedHash: hash, error: null, errorAt: null }, actor, `Watcher alerts updated: ${document.alerts.length} alert${document.alerts.length === 1 ? "" : "s"}`)
  return { ok: true, hash, pushedAt, alerts: document.alerts.length, skipped, uncovered: uncoveredWatcherEvents(document) }
}

/**
 * With automatic updates on, writes the alerts when they differ from what was written last.
 * Skipped while signed out of the tenant: a storage token would prompt for a sign-in in the
 * middle of a save. The next save, or Update watcher, catches up.
 */
export async function syncWatcherAlerts(deps: FeatureDeps, tenantId: string, actor: string | null, licensed: boolean): Promise<WatcherPushResult | null> {
  const watch = auditWatchOf(deps, tenantId)
  if (!licensed || !watch?.externalWatcher || !watch.watcherAlertsSync?.auto || !deps.actor(tenantId)) return null
  if (watcherAlertsHash(watcherAlertsDocument(deps, tenantId).document) === watch.watcherAlertsSync.pushedHash) return null
  return pushWatcherAlerts(deps, tenantId, actor)
}

/** Writes per tenant run one after another, so an older document never lands after a newer one. */
const pushQueues = new Map<string, Promise<unknown>>()

function saveWatcherSync(deps: FeatureDeps, tenantId: string, change: Partial<WatcherAlertsSync>, actor: string | null, reason: string) {
  const current = auditWatchOf(deps, tenantId)?.watcherAlertsSync
  const next: WatcherAlertsSync = { auto: false, pushedAt: null, pushedHash: null, error: null, errorAt: null, ...current, ...change }
  saveAuditWatch(deps, tenantId, { watcherAlertsSync: next }, { actor, reason })
}

/** Whether the Azure watcher runs these alerts: what its heartbeat reported, what was written to it, and now. */
function watcherAlertsStatus(deps: FeatureDeps, tenantId: string) {
  const watch = auditWatchOf(deps, tenantId)
  const sync = watch?.watcherAlertsSync
  const runbookVersion = watch?.watcherCheck?.runbookVersion ?? null
  return {
    current: watcherAlertsHash(watcherAlertsDocument(deps, tenantId).document),
    reported: watch?.watcherCheck?.alertsHash ?? null,
    source: watch?.watcherCheck?.alertsSource ?? null,
    runbookVersion,
    // Null while the heartbeat has not said which runbook runs.
    readsAlertsFile: runbookVersion === null ? null : versionAtLeast(runbookVersion, WATCHER_ALERTS_FILE_RUNBOOK),
    auto: sync?.auto ?? false,
    pushedAt: sync?.pushedAt ?? null,
    pushedHash: sync?.pushedHash ?? null,
    error: sync?.error ?? null,
    errorAt: sync?.errorAt ?? null,
  }
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(version), parts(minimum)]
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return true
}

function uncoveredWatcherEvents(document: WatcherAlerts): string[] {
  return WATCHER_EVENT_TYPES.filter((type) => !document.alerts.some((alert) => alert.eventTypes.includes(type)))
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
  const narrowed = describeConditions(parseConditions(rule.conditions))
  const each = parseDelivery(rule.delivery) === "each" && rule.eventTypes.some(isChangeEventType) ? " One alert per change." : ""
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
  return `${plural(rule.eventTypes.length, "event type")} at ${rule.minSeverity} or above to ${plural(rule.channelIds.length, "channel")}.${narrowed ? ` Changes: ${narrowed}.` : ""}${each}`
}

const WATCHER_DESTINATIONS: WatcherDestination[] = ["webhook", "teams", "mail"]

/** The enabled alerts as the Azure watcher reads them, and the alerts left out for having no remote channel. */
export function watcherAlertsDocument(deps: FeatureDeps, tenantId: string): { document: WatcherAlerts; skipped: string[] } {
  const channels = channelsOf(deps, tenantId)
  const alerts: WatcherAlert[] = []
  const skipped: string[] = []
  for (const rule of rulesOf(deps, tenantId)) {
    if (!rule.enabled) continue
    const destinations = [...new Set(channels.filter((channel) => channel.enabled && rule.channelIds.includes(channel.id)).flatMap((channel): WatcherDestination[] => (channel.kind === "email" ? ["mail"] : channel.kind === "teams" ? ["teams"] : channel.kind === "webhook" ? ["webhook"] : [])))]
    if (!destinations.length) { skipped.push(rule.title); continue }
    alerts.push({ id: rule.id, title: rule.title, eventTypes: rule.eventTypes.filter((type) => type !== "test"), minSeverity: rule.minSeverity, destinations: WATCHER_DESTINATIONS.filter((entry) => destinations.includes(entry)), delivery: parseDelivery(rule.delivery), conditions: parseConditions(rule.conditions) })
  }
  return { document: { schema: WATCHER_ALERTS_SCHEMA, alerts }, skipped }
}
/** The event types the Azure watcher produces. */
const WATCHER_EVENT_TYPES = ["intune.change", "entra.change", "backup.failed", "backup.warning", "backup.succeeded", "backup.missed"] as const

function conditions(value: unknown): RuleRecord["conditions"] {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) throw new FeatureError("conditions is invalid")
  const raw = value as Record<string, unknown>
  for (const key of ["changeTypes", "categories", "policyNames", "settingNames", "excludeActors"]) {
    const list = raw[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.length > 50 || list.some((entry) => typeof entry !== "string" || entry.length > 200)) throw new FeatureError(`conditions.${key} is invalid`)
  }
  if (raw.policyNameMatch !== undefined && raw.policyNameMatch !== null && raw.policyNameMatch !== "contains" && raw.policyNameMatch !== "exact") throw new FeatureError("conditions.policyNameMatch must be contains or exact")
  const parsed = parseConditions(value)
  return hasConditions(parsed) ? parsed : null
}

function delivery(value: unknown): RuleRecord["delivery"] {
  if (value === undefined || value === null) return "digest"
  if (value !== "digest" && value !== "each") throw new FeatureError("delivery must be digest or each")
  return value
}

/** A made up change that passes the alert's conditions, so a test shows what the alert sends. */
function sampleAlertEnvelope(deps: FeatureDeps, tenantId: string, rule: Stored<RuleRecord>) {
  const matcher = alertMatcher(rule)
  const service = rule.eventTypes.includes("entra.change") && !rule.eventTypes.includes("intune.change") ? "conditionalAccess" : "intune"
  const c = matcher.conditions
  const settingHint = c?.settingNames[0]
  const envelope = changeEvent(service, {
    tenantId,
    tenantName: deps.tenant(tenantId)?.name ?? null,
    includeActor: false,
    source: "desktop",
    change: {
      auditId: `test-${deps.now().toISOString()}`,
      at: deps.now().toISOString(),
      category: c?.categories[0] ?? (service === "intune" ? "Compliance" : "ConditionalAccess"),
      changeType: c?.changeTypes[0] ?? "updated",
      resourceName: c?.policyNames[0] ? (c.policyNameMatch === "exact" ? c.policyNames[0] : `${c.policyNames[0]} (sample)`) : service === "intune" ? "Sample compliance policy" : "Sample Conditional Access policy",
      resourceType: service === "intune" ? "Windows10CompliancePolicy" : "Conditional Access policy",
      resourceId: "00000000-0000-0000-0000-000000000000",
      actorUpn: null,
      actorAppId: null,
      actorAppName: null,
      activity: "Sample change",
      settings: settingHint ? [settingHint] : service === "intune" ? ["PasswordRequired", "OsMinimumVersion"] : ["conditions.users.excludeGroups"],
      settingsMore: 0,
    },
  })
  return { ...envelope, title: `Test: ${envelope.title}`, summary: `This is a test of the alert "${rule.title}" with a made up change. ${envelope.summary}`, test: true as const }
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
  if (!rule) throw new FeatureError("Alert not found", 404)
  return rule
}

/** A channel as the renderer may see it: an explicit field list, so stored fields stay private by default. */
export function publicChannel(channel: Stored<ChannelRecord>) {
  return {
    id: channel.id,
    tenantId: channel.tenantId,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    kind: channel.kind,
    title: channel.title,
    status: channel.status,
    summary: channel.summary,
    enabled: channel.enabled,
    urlHost: urlHost(channel.url),
    headerName: channel.headerName,
    hasSecret: Boolean(channel.headerValue),
    signRequests: channel.signRequests,
    recipients: channel.recipients,
    lastDelivery: channel.lastDelivery,
    deliveries: channel.deliveries,
    history: channel.history.map(({ at, actor, reason }) => ({ at, actor, reason })),
  }
}

export function publicRule(rule: Stored<RuleRecord>) {
  const { history, ...rest } = rule
  return { ...rest, conditions: parseConditions(rule.conditions), delivery: parseDelivery(rule.delivery), history: history.map(({ at, actor, reason }) => ({ at, actor, reason })) }
}

export function publicAuditWatch(watch: Stored<AuditWatchRecord> | null) {
  const value = watch ?? { ...defaultAuditWatch(), id: null, createdAt: null, updatedAt: null, history: [] }
  const { history, recent: _recent, conditionalAccess, ...rest } = value as Stored<AuditWatchRecord>
  const { recent: _caRecent, continuation: _caContinuation, ...ca } = conditionalAccess ?? defaultConditionalAccessWatch()
  return { ...rest, conditionalAccess: ca, history: (history ?? []).map(({ at, actor, reason }) => ({ at, actor, reason })) }
}

// The emit export is part of the module surface for producers in the main process.
export { emit }
