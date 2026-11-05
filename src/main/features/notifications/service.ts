import { createHmac } from "node:crypto"
import { canonicalJson, SEVERITY_RANK, watcherStaleEvent, type NotificationEnvelope } from "../../../shared/notifications/envelope"
import { emailHtml, emailSubject, localText, teamsWorkflowsPayload } from "../../../shared/notifications/render"
import { AUDIT_EVENT_SELECT, changeDigest, filterAuditChanges, mapAuditEvent, type AuditChange, type AuditEventRaw, type ChangeService } from "../../../shared/notifications/audit"
import { ENTRA_AUDIT_FILTER, ENTRA_AUDIT_SELECT, mapEntraAuditEvent, type EntraAuditRaw } from "../../../shared/notifications/entra"
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
  WATCHER_CHECK_MINUTES,
  WATCHER_STALE_HOURS,
  type AuditWatchRecord,
  type ChannelRecord,
  type ConditionalAccessWatch,
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
  const watch = deps.records.list<AuditWatchRecord>(DOMAINS.notificationAuditWatch, tenantId)[0] ?? null
  if (!watch) return null
  // Records written by early branch builds carried recentIds strings and no continuation.
  const legacy = watch as Stored<AuditWatchRecord> & { recentIds?: string[] }
  if (!Array.isArray(watch.recent)) legacy.recent = (legacy.recentIds ?? []).map((id) => ({ id, at: watch.watermark ?? new Date(0).toISOString() }))
  if (legacy.continuation === undefined) legacy.continuation = null
  if (!watch.conditionalAccess) watch.conditionalAccess = defaultConditionalAccessWatch()
  return watch
}

function defaultSourceState(): SourceState {
  return { watermark: null, recent: [], continuation: null, lastPollAt: null, lastError: null }
}

export function defaultConditionalAccessWatch(): ConditionalAccessWatch {
  return { enabled: false, ...defaultSourceState() }
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
    recent: [],
    continuation: null,
    lastPollAt: null,
    lastError: null,
    conditionalAccess: defaultConditionalAccessWatch(),
  }
}

/** A change to the watch record; conditionalAccess merges field by field into the stored one. */
export type AuditWatchChange = Partial<Omit<AuditWatchRecord, "conditionalAccess">> & { conditionalAccess?: Partial<ConditionalAccessWatch> }

/**
 * Saves a change. Merges happen inside the record update against the stored value, so a poll
 * that finishes after the admin changed a setting only writes the fields it owns.
 */
export function saveAuditWatch(deps: FeatureDeps, tenantId: string, change: AuditWatchChange, meta: { actor: string | null; reason: string }): Stored<AuditWatchRecord> {
  const current = auditWatchOf(deps, tenantId)
  const describe = (value: AuditWatchRecord): AuditWatchRecord => ({
    ...value,
    status: value.enabled ? "enabled" : "disabled",
    summary: enabledServices(value).length ? `Polling ${enabledServices(value).map((service) => (service === "intune" ? "Intune" : "Conditional Access")).join(" and ")} audit events every ${value.intervalMinutes} minutes while signed in.` : "Watching audit events is off.",
  })
  const merge = (value: AuditWatchRecord): AuditWatchRecord => {
    const { conditionalAccess, ...rest } = change
    return { ...value, ...rest, conditionalAccess: { ...defaultConditionalAccessWatch(), ...(value.conditionalAccess ?? {}), ...(conditionalAccess ?? {}) } }
  }
  if (!current) return deps.records.create<AuditWatchRecord>(DOMAINS.notificationAuditWatch, tenantId, describe(merge(defaultAuditWatch())), meta)
  return deps.records.update<AuditWatchRecord>(DOMAINS.notificationAuditWatch, tenantId, current.id, (value) => describe(merge(value)), meta)!
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
export interface EmitResult {
  created: number
  channelIds: string[]
  /** Channels that hold this event after the call: created now, or already pending or sent. */
  coveredChannelIds: string[]
}

export async function emit(deps: FeatureDeps, tenantId: string, envelope: NotificationEnvelope, options: NotificationOptions & { channelIds?: string[]; deferFlush?: boolean } = {}): Promise<number> {
  return (await emitDetailed(deps, tenantId, envelope, options)).created
}

export async function emitDetailed(deps: FeatureDeps, tenantId: string, envelope: NotificationEnvelope, options: NotificationOptions & { channelIds?: string[]; deferFlush?: boolean } = {}): Promise<EmitResult> {
  const tenant = tenantId.toLowerCase()
  const channels = channelsOf(deps, tenant)
  const selected = options.channelIds ?? matchingChannelIds(rulesOf(deps, tenant), channels, envelope)
  const existing = outboxOf(deps, tenant)
  let created = 0
  const createdChannelIds: string[] = []
  const coveredChannelIds: string[] = []
  for (const channelId of selected) {
    const channel = channels.find((entry) => entry.id === channelId)
    if (!channel || !channel.enabled) continue
    // A pending or sent intent already covers this event; a failed one does not block a fresh emission.
    if (existing.some((entry) => entry.channelId === channelId && entry.eventId === envelope.eventId && entry.state !== "failed")) {
      coveredChannelIds.push(channelId)
      continue
    }
    coveredChannelIds.push(channelId)
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
    createdChannelIds.push(channelId)
  }
  if (created > 0) pruneOutbox(deps, tenant)
  if (!options.deferFlush) await flushOutbox(deps, tenant, options)
  return { created, channelIds: createdChannelIds, coveredChannelIds }
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
  let inaccessibleUsers = 0
  while (path && pages < 20) {
    pages++
    const response: { status: number; body: GraphItem } = await graph("GET", path)
    if (response.status !== 200) return { error: brief(graphError(response.body, response.status)) }
    const values = Array.isArray(response.body.value) ? (response.body.value as GraphItem[]) : []
    for (const member of values) {
      const hasIdentity = typeof member.mail === "string" || typeof member.userPrincipalName === "string" || typeof member.userType === "string"
      if ((member["@odata.type"] === "#microsoft.graph.user" || typeof member.userType === "string") && !hasIdentity) inaccessibleUsers++
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
  if (path) return { error: "This group is too large to resolve completely. Send to a distribution list address instead." }
  if (inaccessibleUsers > 0) {
    return { error: "Some group members came back without mail properties, so the recipient list would be incomplete. Group recipients need the delegated User.Read.All permission: add it to the app registration in Entra, grant admin consent and sign in again." }
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
const polling = new WeakMap<FeatureDeps, Set<string>>()

/** Why a poll read nothing: watching is off, an Azure watcher owns the tenant, or a poll is already running. */
export type PollSkipped = "off" | "external" | "busy"

export interface PollResult {
  enqueued: number
  changes: number
  error: string | null
  skipped?: PollSkipped
}

export async function pollAuditWatch(deps: FeatureDeps, tenantId: string, options: NotificationOptions = {}): Promise<PollResult> {
  const tenant = tenantId.toLowerCase()
  const active = polling.get(deps) ?? new Set<string>()
  polling.set(deps, active)
  if (active.has(tenant)) return { enqueued: 0, changes: 0, error: null, skipped: "busy" }
  active.add(tenant)
  try {
    return await pollAuditWatchOnce(deps, tenant, options)
  } finally {
    active.delete(tenant)
  }
}

/** Where one watched service keeps its position in its audit log. */
interface SourceState {
  watermark: string | null
  recent: Array<{ id: string; at: string }>
  continuation: string | null
  lastPollAt: string | null
  lastError: string | null
}

/** The watched services that are on, in a fixed order. */
export function enabledServices(watch: AuditWatchRecord): ChangeService[] {
  const services: ChangeService[] = []
  if (watch.enabled) services.push("intune")
  if (watch.conditionalAccess?.enabled) services.push("conditionalAccess")
  return services
}

function sourceStateOf(watch: AuditWatchRecord, service: ChangeService): SourceState {
  if (service === "intune") return { watermark: watch.watermark, recent: watch.recent, continuation: watch.continuation, lastPollAt: watch.lastPollAt, lastError: watch.lastError }
  return { ...defaultSourceState(), ...(watch.conditionalAccess ?? {}) }
}

/** The fields a poll owns for its service. Never enabled: that is the admin's setting. */
function sourcePatch(service: ChangeService, change: Partial<SourceState>): AuditWatchChange {
  return service === "intune" ? change : { conditionalAccess: change }
}

const SOURCES: Record<ChangeService, {
  freshPath: (since: string) => string
  map: (raw: Record<string, unknown>) => AuditChange | null
  /** A friendlier reason for the answers that mean a missing permission or role. */
  denied: string
}> = {
  intune: {
    freshPath: (since) => `deviceManagement/auditEvents?$select=${AUDIT_EVENT_SELECT}&$filter=${encodeURIComponent(`activityDateTime gt ${since} and activityOperationType ne 'Get' and activityOperationType ne 'Search'`)}&$orderby=activityDateTime&$top=200`,
    map: (raw) => mapAuditEvent(raw as AuditEventRaw),
    denied: "Microsoft Graph returned 403 for the Intune audit log. The app needs DeviceManagementApps.Read.All and your account an Intune role that can read it.",
  },
  conditionalAccess: {
    freshPath: (since) => `auditLogs/directoryAudits?$select=${ENTRA_AUDIT_SELECT}&$filter=${encodeURIComponent(`${ENTRA_AUDIT_FILTER} and activityDateTime gt ${since}`)}&$orderby=${encodeURIComponent("activityDateTime asc")}&$top=200`,
    map: (raw) => mapEntraAuditEvent(raw as EntraAuditRaw),
    denied: "Microsoft Graph returned 403 for the Entra audit log. Add delegated AuditLog.Read.All, use a role such as Security Reader, then sign in again.",
  },
}

async function pollAuditWatchOnce(deps: FeatureDeps, tenantId: string, options: NotificationOptions = {}): Promise<PollResult> {
  const tenant = tenantId.toLowerCase()
  const watch = auditWatchOf(deps, tenant)
  const services = watch ? enabledServices(watch) : []
  if (!watch || services.length === 0) return { enqueued: 0, changes: 0, error: null, skipped: "off" }
  if (watch.externalWatcher) return { enqueued: 0, changes: 0, error: null, skipped: "external" }
  let enqueued = 0
  let changes = 0
  const errors: string[] = []
  for (const service of services) {
    const result = await pollSource(deps, tenant, service, options)
    enqueued += result.enqueued
    changes += result.changes
    if (result.error) errors.push(services.length > 1 ? `${service === "intune" ? "Intune" : "Conditional Access"}: ${result.error}` : result.error)
  }
  if (enqueued > 0) await flushOutbox(deps, tenant, options)
  return { enqueued, changes, error: errors.length ? errors.join(" ") : null }
}

/**
 * One poll of one service: reads audit events page by page since its watermark minus the
 * overlap, dedupes by audit event id, and queues one digest for the new changes. Ingestion
 * (watermark) advances independently of delivery, which the outbox owns.
 */
async function pollSource(deps: FeatureDeps, tenant: string, service: ChangeService, options: NotificationOptions): Promise<{ enqueued: number; changes: number; error: string | null }> {
  const watch = auditWatchOf(deps, tenant)!
  const state = sourceStateOf(watch, service)
  const source = SOURCES[service]
  const now = deps.now()
  const since = state.watermark ? new Date(Date.parse(state.watermark) - AUDIT_OVERLAP_MS) : new Date(now.getTime() - 24 * 3_600_000)
  try {
    const graph = await deps.graph(tenant)
    const seen = new Set(state.recent.map((entry) => entry.id))
    const collected: AuditChange[] = []
    const seenNow: Array<{ id: string; at: string }> = []
    let newestSeenAt: string | null = null
    const freshPath = source.freshPath(since.toISOString())
    let path: string | null = state.continuation ?? freshPath
    let resumed = Boolean(state.continuation)
    let pages = 0
    // Events read on the page the poll stopped inside. That page is stored as the
    // continuation and read again from the top, so its events stay deduped whatever their age.
    let pageSeen: string[] = []
    let stoppedInPage = false
    // The cap counts newly collected events, never duplicates inside the overlap, so a
    // busy tenant cannot stall the poller re-reading the same first page forever.
    while (path && pages < 50 && collected.length < MAX_AUDIT_EVENTS_PER_POLL) {
      pages++
      const response: { status: number; body: GraphItem } = await graph("GET", path)
      if (response.status !== 200) {
        // A stored continuation can expire; restart once from the overlap query.
        if (resumed && response.status === 400) {
          resumed = false
          path = freshPath
          continue
        }
        if (response.status === 403) throw new Error(source.denied)
        throw new Error(graphError(response.body, response.status))
      }
      resumed = false
      pageSeen = []
      const values = Array.isArray(response.body.value) ? (response.body.value as Array<Record<string, unknown>>) : []
      for (const raw of values) {
        const change = source.map(raw)
        if (!change) continue
        seenNow.push({ id: change.auditId, at: change.at })
        pageSeen.push(change.auditId)
        if (!newestSeenAt || change.at > newestSeenAt) newestSeenAt = change.at
        if (!seen.has(change.auditId)) {
          seen.add(change.auditId)
          collected.push(change)
        }
        if (collected.length >= MAX_AUDIT_EVENTS_PER_POLL) break
      }
      if (collected.length >= MAX_AUDIT_EVENTS_PER_POLL) {
        stoppedInPage = true
        break
      }
      path = nextPath(response.body)
    }
    const profile = deps.tenant(tenant)
    // Categories are Intune audit categories; Conditional Access has none to pick.
    const filtered = filterAuditChanges(collected, { categories: service === "intune" ? watch.categories : [], ownAppId: profile?.clientId ?? null, ignoreOwnChanges: watch.ignoreOwnChanges })
    filtered.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    const gap = state.lastPollAt && now.getTime() - Date.parse(state.lastPollAt) > AUDIT_GAP_NOTICE_MS
    let enqueued = 0
    if (filtered.length) {
      const digest = changeDigest(service, {
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
    const newWatermark = newestSeenAt && (!state.watermark || newestSeenAt > state.watermark) ? newestSeenAt : state.watermark ?? now.toISOString()
    const pruneBefore = Date.parse(newWatermark) - AUDIT_OVERLAP_MS
    const keep = new Set(stoppedInPage ? pageSeen : [])
    const byId = new Map<string, { id: string; at: string }>()
    for (const entry of [...state.recent, ...seenNow]) if (Date.parse(entry.at) > pruneBefore || keep.has(entry.id)) byId.set(entry.id, entry)
    const recent = [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : 1)).slice(-MAX_RECENT_AUDIT_IDS)
    saveAuditWatch(deps, tenant, sourcePatch(service, {
      watermark: newWatermark,
      recent,
      continuation: path,
      lastPollAt: now.toISOString(),
      lastError: null,
    }), { actor: null, reason: `${service === "intune" ? "Intune" : "Conditional Access"} audit poll read ${seenNow.length} events, ${filtered.length} new changes` })
    return { enqueued, changes: filtered.length, error: null }
  } catch (error) {
    const message = brief(error instanceof Error ? error.message : String(error))
    saveAuditWatch(deps, tenant, sourcePatch(service, { lastPollAt: now.toISOString(), lastError: message }), { actor: null, reason: `${service === "intune" ? "Intune" : "Conditional Access"} audit poll failed: ${message}` })
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

/**
 * While an Azure watcher owns change alerts, reads its heartbeat and emits watcher.stale
 * when the last run is older than the threshold, or no heartbeat exists. One alert per
 * stale period: the key is the last run time. A read failure is recorded, never alerted,
 * because it says nothing about the watcher.
 */
export async function checkWatcher(deps: FeatureDeps, tenantId: string, options: NotificationOptions = {}): Promise<{ stale: boolean; enqueued: number; error: string | null }> {
  const tenant = tenantId.toLowerCase()
  const watch = auditWatchOf(deps, tenant)
  if (!watch?.externalWatcher || !deps.watcherHeartbeat) return { stale: false, enqueued: 0, error: null }
  const now = deps.now()
  let read: Awaited<ReturnType<NonNullable<FeatureDeps["watcherHeartbeat"]>>>
  try {
    read = await deps.watcherHeartbeat(tenant)
  } catch (error) {
    read = { status: "error", message: brief(error instanceof Error ? error.message : String(error)) }
  }
  if (read.status === "error") {
    saveAuditWatch(deps, tenant, { watcherCheck: { checkedAt: now.toISOString(), lastRunAt: watch.watcherCheck?.lastRunAt ?? null, stale: watch.watcherCheck?.stale ?? false, error: read.message } }, { actor: null, reason: `Azure watcher heartbeat could not be read: ${read.message}` })
    return { stale: false, enqueued: 0, error: read.message }
  }
  const lastRunAt = read.status === "ok" ? read.runAt : null
  const stale = !lastRunAt || now.getTime() - Date.parse(lastRunAt) > WATCHER_STALE_HOURS * 3_600_000
  let enqueued = 0
  if (stale) {
    const envelope = watcherStaleEvent({ tenantId: tenant, tenantName: deps.tenant(tenant)?.name ?? null, occurredAt: now.toISOString(), lastRunAt, thresholdHours: WATCHER_STALE_HOURS, lastError: read.status === "ok" ? read.lastError : null, source: "desktop" })
    enqueued = await emit(deps, tenant, envelope, options)
  }
  saveAuditWatch(deps, tenant, { watcherCheck: { checkedAt: now.toISOString(), lastRunAt, stale, error: null } }, { actor: null, reason: stale ? "Azure watcher heartbeat is stale" : "Azure watcher heartbeat is fresh" })
  return { stale, enqueued, error: null }
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
      if (!watch) continue
      if (watch.externalWatcher) {
        const checkedAt = watch.watcherCheck?.checkedAt
        const due = !checkedAt || deps.now().getTime() - Date.parse(checkedAt) >= WATCHER_CHECK_MINUTES * 60_000
        if (due && deps.actor(tenantId)) await checkWatcher(deps, tenantId, options).catch(() => undefined)
        continue
      }
      const services = enabledServices(watch)
      if (services.length === 0) continue
      if (!deps.actor(tenantId)) continue
      const interval = Math.max(5, watch.intervalMinutes) * 60_000
      const due = services.some((service) => {
        const lastPollAt = sourceStateOf(watch, service).lastPollAt
        return !lastPollAt || deps.now().getTime() - Date.parse(lastPollAt) >= interval
      })
      if (due) await pollAuditWatch(deps, tenantId, options).catch(() => undefined)
    }
  } finally {
    ticking.delete(deps)
  }
}
