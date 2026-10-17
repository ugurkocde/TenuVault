import { createHmac } from "node:crypto"
import { canonicalJson, SEVERITY_RANK, type NotificationEnvelope } from "../../../shared/notifications/envelope"
import { emailHtml, emailSubject, localText, teamsWorkflowsPayload } from "../../../shared/notifications/render"
import { AUDIT_EVENT_SELECT, filterAuditChanges, intuneChangeDigest, mapAuditEvent, type AuditChange, type AuditEventRaw } from "../../../shared/notifications/audit"
import { allows } from "../../../shared/plans"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { retryable } from "../health-review/rules"
import {
  MAX_DELIVERY_LOG,
  MAX_OUTBOX_KEPT,
  MAX_RECENT_AUDIT_IDS,
  MAX_RECIPIENTS,
  type AuditWatchRecord,
  type ChannelRecord,
  type DeliveryResult,
  type OutboxRecord,
  type RuleRecord,
} from "./model"

const DELIVERY_TIMEOUT_MS = 10_000
const MAX_ATTEMPTS = 5
const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000]
const MAX_AUDIT_EVENTS_PER_POLL = 500
const AUDIT_OVERLAP_MS = 30 * 60_000
const AUDIT_GAP_NOTICE_MS = 48 * 3_600_000

export interface NotificationOptions {
  sleep?: (ms: number) => Promise<void>
}

function brief(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 200)
}

export function channelsOf(deps: FeatureDeps, tenantId: string): Stored<ChannelRecord>[] {
  return deps.records.list<ChannelRecord>(DOMAINS.notificationChannels, tenantId)
}

export function rulesOf(deps: FeatureDeps, tenantId: string): Stored<RuleRecord>[] {
  return deps.records.list<RuleRecord>(DOMAINS.notificationRules, tenantId)
}

export function outboxOf(deps: FeatureDeps, tenantId: string): Stored<OutboxRecord>[] {
  return deps.records.list<OutboxRecord>(DOMAINS.notificationOutbox, tenantId)
}

export function auditWatchOf(deps: FeatureDeps, tenantId: string): Stored<AuditWatchRecord> | null {
  return deps.records.list<AuditWatchRecord>(DOMAINS.notificationAuditWatch, tenantId)[0] ?? null
}

export function defaultAuditWatch(): AuditWatchRecord {
  return {
    title: "Intune change watching",
    status: "disabled",
    summary: "Watching Intune audit events is off.",
    enabled: false,
    intervalMinutes: 15,
    categories: [],
    ignoreOwnChanges: true,
    includeActor: false,
    externalWatcher: false,
    watermark: null,
    recentIds: [],
    lastPollAt: null,
    lastError: null,
  }
}

export function saveAuditWatch(deps: FeatureDeps, tenantId: string, change: Partial<AuditWatchRecord>, meta: { actor: string | null; reason: string }): Stored<AuditWatchRecord> {
  const current = auditWatchOf(deps, tenantId)
  const describe = (value: AuditWatchRecord): AuditWatchRecord => ({
    ...value,
    status: value.enabled ? "enabled" : "disabled",
    summary: value.enabled ? `Polling Intune audit events every ${value.intervalMinutes} minutes while signed in.` : "Watching Intune audit events is off.",
  })
  if (!current) return deps.records.create<AuditWatchRecord>(DOMAINS.notificationAuditWatch, tenantId, describe({ ...defaultAuditWatch(), ...change }), meta)
  return deps.records.update<AuditWatchRecord>(DOMAINS.notificationAuditWatch, tenantId, current.id, (value) => describe({ ...value, ...change }), meta)!
}

/** Rules that select an event for a channel: enabled rule and channel, type listed, severity at or above the minimum. */
export function matchingChannelIds(rules: RuleRecord[], channels: Array<ChannelRecord & { id: string }>, envelope: NotificationEnvelope): string[] {
  const enabledChannels = new Set(channels.filter((channel) => channel.enabled).map((channel) => channel.id))
  const selected = new Set<string>()
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!rule.eventTypes.includes(envelope.type)) continue
    if (SEVERITY_RANK[envelope.severity] < SEVERITY_RANK[rule.minSeverity]) continue
    for (const channelId of rule.channelIds) if (enabledChannels.has(channelId)) selected.add(channelId)
  }
  return [...selected]
}

/**
 * Emits one event: matches rules, persists one outbox intent per selected channel
 * (skipping channels that already hold this event), then flushes due deliveries.
 * Returns how many intents were created.
 */
export async function emit(deps: FeatureDeps, tenantId: string, envelope: NotificationEnvelope, options: NotificationOptions & { channelIds?: string[]; deferFlush?: boolean } = {}): Promise<number> {
  const tenant = tenantId.toLowerCase()
  const channels = channelsOf(deps, tenant)
  const selected = options.channelIds ?? matchingChannelIds(rulesOf(deps, tenant), channels, envelope)
  const existing = outboxOf(deps, tenant)
  let created = 0
  for (const channelId of selected) {
    const channel = channels.find((entry) => entry.id === channelId)
    if (!channel || !channel.enabled) continue
    // A pending or sent intent already covers this event; a failed one does not block a fresh emission.
    if (existing.some((entry) => entry.channelId === channelId && entry.eventId === envelope.eventId && entry.state !== "failed")) continue
    deps.records.create<OutboxRecord>(DOMAINS.notificationOutbox, tenant, {
      channelId,
      channelTitle: channel.title,
      eventId: envelope.eventId,
      envelope,
      state: "pending",
      attempts: 0,
      nextAttemptAt: deps.now().toISOString(),
      lastError: null,
      lastStatus: null,
      sentAt: null,
    }, { actor: null, reason: `Queued ${envelope.type} for ${channel.title}` })
    created++
  }
  if (created > 0) pruneOutbox(deps, tenant)
  if (!options.deferFlush) await flushOutbox(deps, tenant, options)
  return created
}

function pruneOutbox(deps: FeatureDeps, tenantId: string): void {
  const entries = outboxOf(deps, tenantId)
  if (entries.length <= MAX_OUTBOX_KEPT) return
  const removable = entries.filter((entry) => entry.state !== "pending")
  for (const entry of removable.slice(0, entries.length - MAX_OUTBOX_KEPT)) deps.records.remove(DOMAINS.notificationOutbox, tenantId, entry.id)
}

const flushing = new WeakMap<FeatureDeps, Set<string>>()

/** Attempts every due pending intent of a tenant, oldest first. Failures reschedule with backoff. */
export async function flushOutbox(deps: FeatureDeps, tenantId: string, _options: NotificationOptions = {}): Promise<{ sent: number; failed: number }> {
  const tenant = tenantId.toLowerCase()
  const active = flushing.get(deps) ?? new Set<string>()
  flushing.set(deps, active)
  if (active.has(tenant)) return { sent: 0, failed: 0 }
  active.add(tenant)
  let sent = 0
  let failed = 0
  try {
    const now = deps.now()
    const due = outboxOf(deps, tenant).filter((entry) => entry.state === "pending" && Date.parse(entry.nextAttemptAt) <= now.getTime())
    for (const entry of due) {
      const channel = channelsOf(deps, tenant).find((candidate) => candidate.id === entry.channelId)
      if (!channel) {
        deps.records.update<OutboxRecord>(DOMAINS.notificationOutbox, tenant, entry.id, (value) => ({ ...value, state: "failed", lastError: "The channel was removed." }), { actor: null, reason: "Channel removed before delivery" })
        failed++
        continue
      }
      if (!channel.enabled) continue
      // Graph backed channels pause while signed out instead of burning their attempts.
      if (channel.kind === "email" && !deps.actor(tenant)) continue
      const result = await deliverToChannel(deps, tenant, channel, entry.envelope)
      recordChannelDelivery(deps, tenant, channel.id, result)
      const attempts = entry.attempts + Math.max(1, result.attempts)
      if (result.ok) {
        deps.records.update<OutboxRecord>(DOMAINS.notificationOutbox, tenant, entry.id, (value) => ({ ...value, state: "sent", attempts, lastError: null, lastStatus: result.status, sentAt: deps.now().toISOString() }), { actor: null, reason: `Delivered to ${channel.title}` })
        sent++
      } else if (attempts >= MAX_ATTEMPTS || !retryable(result.status)) {
        deps.records.update<OutboxRecord>(DOMAINS.notificationOutbox, tenant, entry.id, (value) => ({ ...value, state: "failed", attempts, lastError: result.error, lastStatus: result.status }), { actor: null, reason: `Delivery to ${channel.title} gave up: ${result.error ?? "unknown error"}` })
        failed++
      } else {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]!
        deps.records.update<OutboxRecord>(DOMAINS.notificationOutbox, tenant, entry.id, (value) => ({ ...value, attempts, lastError: result.error, lastStatus: result.status, nextAttemptAt: new Date(deps.now().getTime() + backoff).toISOString() }), { actor: null, reason: `Delivery to ${channel.title} will retry: ${result.error ?? "unknown error"}` })
        failed++
      }
    }
  } finally {
    active.delete(tenant)
  }
  return { sent, failed }
}

function recordChannelDelivery(deps: FeatureDeps, tenantId: string, channelId: string, delivery: DeliveryResult): void {
  deps.records.update<ChannelRecord>(DOMAINS.notificationChannels, tenantId, channelId, (value) => ({
    ...value,
    lastDelivery: delivery,
    deliveries: [...value.deliveries, delivery].slice(-MAX_DELIVERY_LOG),
  }), { actor: null, reason: delivery.ok ? "Delivery succeeded" : `Delivery failed: ${delivery.error ?? "unknown error"}` })
}

/** HMAC signature for a webhook body: hex SHA-256 over the unix timestamp, a dot, and the raw body. */
export function signBody(secret: string, timestampSeconds: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex")
}

/** Delivers one envelope to one channel, single attempt. Retries live in the outbox, not here. */
export async function deliverToChannel(deps: FeatureDeps, tenantId: string, channel: ChannelRecord, envelope: NotificationEnvelope): Promise<DeliveryResult> {
  const at = deps.now().toISOString()
  const base = { at, test: envelope.test === true }
  try {
    if (channel.kind === "local") {
      const text = localText(envelope)
      deps.notify(text.title, text.body)
      return { ...base, ok: true, attempts: 1, status: null, error: null }
    }
    if (channel.kind === "email") return await deliverEmail(deps, tenantId, channel, envelope, base)
    if (!channel.url || !channel.url.startsWith("https://")) return { ...base, ok: false, attempts: 0, status: null, error: "The channel has no valid https URL." }
    const body = channel.kind === "teams" ? JSON.stringify(teamsWorkflowsPayload(envelope)) : canonicalJson(envelope)
    const headers: Record<string, string> = { "content-type": "application/json", "x-tenuvault-event-id": envelope.eventId }
    if (channel.kind === "webhook" && channel.headerName && channel.headerValue) headers[channel.headerName] = channel.headerValue
    if (channel.kind === "webhook" && channel.signRequests && channel.headerValue) {
      const timestamp = Math.floor(deps.now().getTime() / 1000)
      headers["x-tenuvault-timestamp"] = String(timestamp)
      headers["x-tenuvault-signature"] = signBody(channel.headerValue, timestamp, body)
    }
    const response = await deps.externalFetch(channel.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
    if (response.ok) return { ...base, ok: true, attempts: 1, status: response.status, error: null }
    return { ...base, ok: false, attempts: 1, status: response.status, error: `The destination answered HTTP ${response.status}.` }
  } catch (error) {
    return { ...base, ok: false, attempts: 1, status: null, error: brief(error instanceof Error ? error.message : String(error)) || "The destination could not be reached." }
  }
}

type GraphItem = Record<string, unknown>

async function deliverEmail(deps: FeatureDeps, tenantId: string, channel: ChannelRecord, envelope: NotificationEnvelope, base: { at: string; test: boolean }): Promise<DeliveryResult> {
  const graph = await deps.graph(tenantId)
  const recipients = await resolveRecipients(graph, channel)
  if ("error" in recipients) return { ...base, ok: false, attempts: 1, status: null, error: recipients.error }
  const message = {
    subject: emailSubject(envelope),
    body: { contentType: "HTML", content: emailHtml(envelope) },
    toRecipients: recipients.addresses.map((address) => ({ emailAddress: { address } })),
  }
  const response = await graph("POST", "me/sendMail", { message, saveToSentItems: false } as unknown as Parameters<typeof graph>[2])
  if (response.status >= 200 && response.status < 300) return { ...base, ok: true, attempts: 1, status: response.status, error: null }
  return { ...base, ok: false, attempts: 1, status: response.status, error: brief(graphError(response.body as GraphItem, response.status)) }
}

function graphError(body: GraphItem, status: number): string {
  const error = body?.error as GraphItem | undefined
  const message = typeof error?.message === "string" ? error.message : ""
  return message ? `Microsoft Graph returned ${status}: ${message}` : `Microsoft Graph returned ${status}`
}

/**
 * Resolves channel recipients to addresses. Explicit and list addresses pass through;
 * picked groups expand through transitive members, guests excluded, capped.
 */
export async function resolveRecipients(graph: Awaited<ReturnType<FeatureDeps["graph"]>>, channel: ChannelRecord): Promise<{ addresses: string[] } | { error: string }> {
  const addresses = new Set<string>()
  for (const recipient of channel.recipients) {
    if (recipient.type === "address") {
      addresses.add(recipient.address)
      continue
    }
    const members = await listGroupMembers(graph, recipient.groupId)
    if ("error" in members) return members
    for (const address of members.addresses) addresses.add(address)
    if (addresses.size > MAX_RECIPIENTS) return { error: `The recipient groups resolve to more than ${MAX_RECIPIENTS} people. Send to a distribution list address instead.` }
  }
  if (addresses.size === 0) return { error: "No recipient addresses could be resolved." }
  return { addresses: [...addresses] }
}

async function listGroupMembers(graph: Awaited<ReturnType<FeatureDeps["graph"]>>, groupId: string): Promise<{ addresses: string[] } | { error: string }> {
  const addresses: string[] = []
  let path: string | null = `groups/${groupId}/transitiveMembers?$select=mail,userPrincipalName,userType&$top=200`
  let pages = 0
  while (path && pages < 20) {
    pages++
    const response: { status: number; body: GraphItem } = await graph("GET", path)
    if (response.status !== 200) return { error: brief(graphError(response.body, response.status)) }
    const values = Array.isArray(response.body.value) ? (response.body.value as GraphItem[]) : []
    for (const member of values) {
      // Transitive members include nested groups; only user objects are mailboxes we may add.
      const kind = member["@odata.type"]
      const isUser = kind === "#microsoft.graph.user" || (kind === undefined && typeof member.userType === "string")
      if (!isUser) continue
      if (typeof member.userType === "string" && member.userType.toLowerCase() === "guest") continue
      const mail = typeof member.mail === "string" ? member.mail : typeof member.userPrincipalName === "string" && member.userPrincipalName.includes("@") ? member.userPrincipalName : null
      if (mail) addresses.push(mail)
      if (addresses.length > MAX_RECIPIENTS) return { error: `A recipient group has more than ${MAX_RECIPIENTS} mailboxes. Send to a distribution list address instead.` }
    }
    path = nextPath(response.body)
  }
  return { addresses }
}

function nextPath(body: GraphItem): string | null {
  const next = body["@odata.nextLink"]
  if (typeof next !== "string") return null
  return next.replace(/^https:\/\/graph\.microsoft\.com\/(beta|v1\.0)\//, "")
}

/**
 * One audit watch poll: reads audit events page by page since the watermark minus the
 * overlap, dedupes by audit event id, and emits one digest for the new changes.
 * Ingestion (watermark) advances independently of delivery, which the outbox owns.
 */
export async function pollAuditWatch(deps: FeatureDeps, tenantId: string, options: NotificationOptions = {}): Promise<{ enqueued: number; changes: number; error: string | null }> {
  const tenant = tenantId.toLowerCase()
  const watch = auditWatchOf(deps, tenant)
  if (!watch || !watch.enabled || watch.externalWatcher) return { enqueued: 0, changes: 0, error: null }
  const now = deps.now()
  const since = watch.watermark ? new Date(Date.parse(watch.watermark) - AUDIT_OVERLAP_MS) : new Date(now.getTime() - 24 * 3_600_000)
  try {
    const graph = await deps.graph(tenant)
    const seen = new Set(watch.recentIds)
    const collected: AuditChange[] = []
    const seenNow: string[] = []
    let newestSeenAt: string | null = null
    let path: string | null =
      `deviceManagement/auditEvents?$select=${AUDIT_EVENT_SELECT}&$filter=${encodeURIComponent(`activityDateTime gt ${since.toISOString()}`)}&$orderby=activityDateTime&$top=200`
    let pages = 0
    // The cap counts newly collected events, never duplicates inside the overlap, so a
    // busy tenant cannot stall the poller re-reading the same first page forever.
    while (path && pages < 50 && collected.length < MAX_AUDIT_EVENTS_PER_POLL) {
      pages++
      const response: { status: number; body: GraphItem } = await graph("GET", path)
      if (response.status !== 200) throw new Error(graphError(response.body, response.status))
      const values = Array.isArray(response.body.value) ? (response.body.value as AuditEventRaw[]) : []
      for (const raw of values) {
        const change = mapAuditEvent(raw)
        if (!change) continue
        seenNow.push(change.auditId)
        if (!newestSeenAt || change.at > newestSeenAt) newestSeenAt = change.at
        if (!seen.has(change.auditId)) collected.push(change)
        if (collected.length >= MAX_AUDIT_EVENTS_PER_POLL) break
      }
      if (collected.length >= MAX_AUDIT_EVENTS_PER_POLL) break
      path = nextPath(response.body)
    }
    const profile = deps.tenant(tenant)
    const filtered = filterAuditChanges(collected, { categories: watch.categories, ownAppId: profile?.clientId ?? null, ignoreOwnChanges: watch.ignoreOwnChanges })
    filtered.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    const gap = watch.lastPollAt && now.getTime() - Date.parse(watch.lastPollAt) > AUDIT_GAP_NOTICE_MS
    let enqueued = 0
    if (filtered.length) {
      const digest = intuneChangeDigest({
        tenantId: tenant,
        tenantName: profile?.name ?? null,
        changes: filtered,
        includeActor: watch.includeActor,
        source: "desktop",
        gapNotice: gap ? "Change watching was off for a while; older changes may be missing from this digest." : null,
      })
      // Intents first, dedupe state second, delivery last: a crash between them rebuilds
      // the same digest with the same eventId, which the outbox then dedupes.
      enqueued = await emit(deps, tenant, digest, { ...options, deferFlush: true })
    }
    const recentIds = [...watch.recentIds, ...seenNow].filter((id, index, all) => all.indexOf(id) === index).slice(-MAX_RECENT_AUDIT_IDS)
    saveAuditWatch(deps, tenant, {
      watermark: newestSeenAt && (!watch.watermark || newestSeenAt > watch.watermark) ? newestSeenAt : watch.watermark ?? now.toISOString(),
      recentIds,
      lastPollAt: now.toISOString(),
      lastError: null,
    }, { actor: null, reason: `Audit poll read ${seenNow.length} events, ${filtered.length} new changes` })
    if (enqueued > 0) await flushOutbox(deps, tenant, options)
    return { enqueued, changes: filtered.length, error: null }
  } catch (error) {
    const message = brief(error instanceof Error ? error.message : String(error))
    saveAuditWatch(deps, tenant, { lastPollAt: now.toISOString(), lastError: message }, { actor: null, reason: `Audit poll failed: ${message}` })
    return { enqueued: 0, changes: 0, error: message }
  }
}

async function licensed(deps: FeatureDeps, tenantId: string): Promise<boolean> {
  try {
    return allows(await deps.plan(tenantId), "notifications")
  } catch {
    return false
  }
}

const ticking = new WeakSet<FeatureDeps>()

/** One background pass: retry due outbox entries and poll due audit watches per tenant. */
export async function tick(deps: FeatureDeps, options: NotificationOptions = {}): Promise<void> {
  if (ticking.has(deps)) return
  ticking.add(deps)
  try {
    for (const tenantId of deps.tenants()) {
      if (!(await licensed(deps, tenantId))) continue
      await flushOutbox(deps, tenantId, options).catch(() => undefined)
      const watch = auditWatchOf(deps, tenantId)
      if (!watch?.enabled || watch.externalWatcher) continue
      if (!deps.actor(tenantId)) continue
      const due = !watch.lastPollAt || deps.now().getTime() - Date.parse(watch.lastPollAt) >= Math.max(5, watch.intervalMinutes) * 60_000
      if (due) await pollAuditWatch(deps, tenantId, options).catch(() => undefined)
    }
  } finally {
    ticking.delete(deps)
  }
}
