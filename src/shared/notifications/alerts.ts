/**
 * Alerts: the rules that pick which events reach which channels. Every alert has event types
 * and a minimum severity. Alerts on Intune or Conditional Access changes can also narrow the
 * changes they send (by change type, Intune category, policy name, changed setting or actor)
 * and send one summary per check or one alert per change.
 *
 * planChangeAlerts is the single place that turns one poll worth of changes into envelopes
 * per alert. The desktop app and the Azure watcher (Get-TvChangeAlertPlan in the runbook)
 * both use it, so an alert sends the same events whoever watches the tenant.
 */
import { changeDigest, changeEvent, SERVICE_DIGEST, type AuditChange, type AuditChangeType, type ChangeService } from "./audit"
import { canonicalJson, SEVERITY_RANK, sha256Hex, type NotificationEnvelope, type NotificationEventType, type NotificationSeverity } from "./envelope"

export const CHANGE_TYPES: AuditChangeType[] = ["created", "updated", "deleted", "assigned", "unassigned", "changed"]

/** One summary per check, or one alert per change. */
export type AlertDelivery = "digest" | "each"

/** An alert sends at most this many single-change alerts per check; the rest go in one summary. */
export const MAX_EACH_PER_CHECK = 20

export interface AlertConditions {
  /** Change types to send; empty sends every type. */
  changeTypes: AuditChangeType[]
  /** Intune audit categories; empty sends every category. Conditional Access changes have none and always pass. */
  categories: string[]
  /** Policy names; a change passes when its name contains one, ignoring case. Empty passes every name. */
  policyNames: string[]
  /**
   * "exact": a change passes only when its policy name is one of policyNames, ignoring case and
   * surrounding spaces. Absent means contains, so alerts saved before this field keep their meaning
   * and their watcher hash.
   */
  policyNameMatch?: "exact"
  /** Parts of setting names; a change passes when one of its changed settings contains one. Empty passes every change. */
  settingNames: string[]
  /** Admins or apps (UPN or app name, exact, ignoring case) whose changes are never sent. */
  excludeActors: string[]
}

export const EMPTY_CONDITIONS: AlertConditions = { changeTypes: [], categories: [], policyNames: [], settingNames: [], excludeActors: [] }

/** The parts of an alert that matching reads. Desktop records and watcher rules both have them. */
export interface AlertMatcher {
  id: string
  enabled: boolean
  eventTypes: readonly string[]
  minSeverity: NotificationSeverity
  conditions?: AlertConditions | null
  delivery?: AlertDelivery | null
}

const CHANGE_EVENT_TYPES = new Set<string>(["intune.change", "entra.change"])

/** Whether an event type is a change event, the only kind conditions and per-change delivery apply to. */
export function isChangeEventType(type: string): boolean {
  return CHANGE_EVENT_TYPES.has(type)
}

const MAX_CONDITION_ENTRIES = 50
const MAX_CONDITION_TEXT = 200

function textList(value: unknown, max = MAX_CONDITION_ENTRIES): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") continue
    // oxlint-disable-next-line no-control-regex
    const cleaned = entry.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_CONDITION_TEXT)
    if (cleaned && !out.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) out.push(cleaned)
    if (out.length >= max) break
  }
  return out
}

/**
 * Reads stored or received conditions leniently: unknown fields are dropped, invalid
 * entries are skipped. Null when nothing narrows, so an alert without conditions stays plain.
 */
export function parseConditions(value: unknown): AlertConditions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const conditions: AlertConditions = {
    changeTypes: Array.isArray(raw.changeTypes) ? CHANGE_TYPES.filter((type) => (raw.changeTypes as unknown[]).includes(type)) : [],
    categories: textList(raw.categories),
    policyNames: textList(raw.policyNames),
    settingNames: textList(raw.settingNames),
    excludeActors: textList(raw.excludeActors),
  }
  // Only stored when it narrows something, so a plain alert and its watcher copy stay unchanged.
  if (raw.policyNameMatch === "exact" && conditions.policyNames.length) conditions.policyNameMatch = "exact"
  return hasConditions(conditions) ? conditions : null
}

export function hasConditions(conditions: AlertConditions | null | undefined): boolean {
  if (!conditions) return false
  return conditions.changeTypes.length + conditions.categories.length + conditions.policyNames.length + conditions.settingNames.length + conditions.excludeActors.length > 0
}

export function parseDelivery(value: unknown): AlertDelivery {
  return value === "each" ? "each" : "digest"
}

const contains = (haystack: string | null | undefined, needles: string[]) => {
  if (!haystack) return false
  const lower = haystack.toLowerCase()
  return needles.some((needle) => lower.includes(needle.toLowerCase()))
}

/** Spaces, tabs and no-break spaces around a name, which audit records sometimes keep. The runbook strips the same set. */
const EDGE_SPACE = /^[ \t\u00a0]+|[ \t\u00a0]+$/g

/** Whether a name equals one of the names, ignoring case and surrounding spaces. */
const equalsAny = (haystack: string | null | undefined, names: string[]) => {
  if (!haystack) return false
  const lower = haystack.replace(EDGE_SPACE, "").toLowerCase()
  return names.some((name) => name.replace(EDGE_SPACE, "").toLowerCase() === lower)
}

/** Whether one change passes an alert's conditions. */
export function changeMatches(conditions: AlertConditions | null | undefined, change: AuditChange, service: ChangeService): boolean {
  if (!conditions) return true
  if (conditions.changeTypes.length && !conditions.changeTypes.includes(change.changeType)) return false
  if (service === "intune" && conditions.categories.length && !conditions.categories.some((category) => category.toLowerCase() === change.category.toLowerCase())) return false
  if (conditions.policyNames.length && !(conditions.policyNameMatch === "exact" ? equalsAny : contains)(change.resourceName, conditions.policyNames)) return false
  if (conditions.settingNames.length && !(change.settings ?? []).some((name) => contains(name, conditions.settingNames))) return false
  if (conditions.excludeActors.length) {
    const actors = [change.actorUpn, change.actorAppName].filter((entry): entry is string => Boolean(entry)).map((entry) => entry.toLowerCase())
    if (conditions.excludeActors.some((excluded) => actors.includes(excluded.toLowerCase()))) return false
  }
  return true
}

/** Whether an alert takes an event of this type and severity at all. */
export function alertTakes(alert: AlertMatcher, type: NotificationEventType | string, severity: NotificationSeverity): boolean {
  return alert.enabled && alert.eventTypes.includes(type) && SEVERITY_RANK[severity] >= SEVERITY_RANK[alert.minSeverity]
}

export interface PlannedAlert {
  envelope: NotificationEnvelope
  /** The alerts that send this envelope, in the order they were given. */
  alertIds: string[]
}

export interface ChangePlanContext {
  tenantId: string
  tenantName?: string | null
  includeActor: boolean
  source: "desktop" | "azure-watcher"
  gapNotice?: string | null
}

/**
 * The envelopes one poll of one service sends, and which alerts send each. An alert sends
 * the changes that pass its conditions, as one summary or, with per-change delivery, one
 * alert per change (the first MAX_EACH_PER_CHECK, the rest in one summary). Alerts that pick
 * the same changes produce the same envelope, so a channel two alerts share gets it once.
 * An alert without conditions gets the full summary, as before alerts had conditions.
 */
export function planChangeAlerts(service: ChangeService, changes: AuditChange[], alerts: AlertMatcher[], context: ChangePlanContext): PlannedAlert[] {
  const type = SERVICE_DIGEST[service].type
  const planned = new Map<string, PlannedAlert>()
  const add = (envelope: NotificationEnvelope, alert: AlertMatcher) => {
    if (!alertTakes(alert, envelope.type, envelope.severity)) return
    const existing = planned.get(envelope.eventId)
    if (existing) {
      if (!existing.alertIds.includes(alert.id)) existing.alertIds.push(alert.id)
    } else {
      planned.set(envelope.eventId, { envelope, alertIds: [alert.id] })
    }
  }
  const digestOf = (selected: AuditChange[]) => changeDigest(service, { tenantId: context.tenantId, tenantName: context.tenantName, changes: selected, includeActor: context.includeActor, source: context.source, gapNotice: context.gapNotice })
  for (const alert of alerts) {
    if (!alert.enabled || !alert.eventTypes.includes(type)) continue
    const selected = changes.filter((change) => changeMatches(alert.conditions, change, service))
    if (!selected.length) continue
    if (parseDelivery(alert.delivery) === "each") {
      for (const change of selected.slice(0, MAX_EACH_PER_CHECK)) {
        add(changeEvent(service, { tenantId: context.tenantId, tenantName: context.tenantName, change, includeActor: context.includeActor, source: context.source }), alert)
      }
      const rest = selected.slice(MAX_EACH_PER_CHECK)
      if (rest.length) add(digestOf(rest), alert)
    } else {
      add(digestOf(selected), alert)
    }
  }
  return [...planned.values()]
}

/** A plain-language line for an alert's conditions, or null when it has none. */
export function describeConditions(conditions: AlertConditions | null | undefined): string | null {
  if (!hasConditions(conditions)) return null
  const parts: string[] = []
  const c = conditions!
  if (c.changeTypes.length) parts.push(`${c.changeTypes.join(", ")} only`)
  if (c.categories.length) parts.push(`categories ${c.categories.join(", ")}`)
  if (c.policyNames.length) parts.push(`${c.policyNameMatch === "exact" ? "policies named" : "policy names containing"} ${c.policyNames.map((name) => `"${name}"`).join(" or ")}`)
  if (c.settingNames.length) parts.push(`changed settings containing ${c.settingNames.map((name) => `"${name}"`).join(" or ")}`)
  if (c.excludeActors.length) parts.push(`not by ${c.excludeActors.join(", ")}`)
  return parts.join("; ")
}

/** The Azure watcher's copy of the alerts: kinds of destinations instead of desktop channel ids. */
export const WATCHER_ALERTS_SCHEMA = "tenuvault.watcher-alerts/v1"
export type WatcherDestination = "webhook" | "teams" | "mail"

export interface WatcherAlert {
  id: string
  title: string
  eventTypes: string[]
  minSeverity: NotificationSeverity
  destinations: WatcherDestination[]
  delivery: AlertDelivery
  conditions: AlertConditions | null
}

export interface WatcherAlerts {
  schema: typeof WATCHER_ALERTS_SCHEMA
  alerts: WatcherAlert[]
}

/**
 * The identity of a set of watcher alerts: SHA-256 of its canonical JSON, or "none" without
 * alerts. The runbook writes the same value (Get-TvWatcherAlertsHash) into its heartbeat, so
 * the desktop can tell whether the watcher runs the alerts it has now.
 */
export function watcherAlertsHash(document: WatcherAlerts | null): string {
  if (!document || document.alerts.length === 0) return "none"
  return sha256Hex(canonicalJson(document))
}
