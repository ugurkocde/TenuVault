/**
 * Mapping of Intune audit events (GET deviceManagement/auditEvents) to notification
 * change items, following the documented auditEvent resource: identity and operation
 * fields plus resource display names, types and ids. For updates, the names of the changed
 * settings are taken from the resource's modified properties; their values are compared in
 * memory by settings.ts and never kept or sent.
 */
import { buildEnvelope, type NotificationEnvelope, type NotificationItem, type NotificationItemChange } from "./envelope"
import { intuneChangedSettings, MAX_SETTING_NAMES } from "./settings"

export interface AuditEventRaw {
  id?: unknown
  displayName?: unknown
  componentName?: unknown
  activity?: unknown
  activityType?: unknown
  activityOperationType?: unknown
  activityResult?: unknown
  activityDateTime?: unknown
  category?: unknown
  actor?: unknown
  resources?: unknown
}

export type AuditChangeType = "created" | "updated" | "deleted" | "assigned" | "unassigned" | "changed"

export interface AuditChange {
  auditId: string
  at: string
  category: string
  changeType: AuditChangeType
  /** Policy or object display name when the audit event carries one. */
  resourceName: string | null
  /** Documented Graph resource type, for example Windows10GeneralConfiguration. */
  resourceType: string | null
  actorUpn: string | null
  actorAppId: string | null
  actorAppName: string | null
  activity: string
  /** The object id of the changed policy or object, when the audit event carries one. */
  resourceId?: string | null
  /** Names of the settings an update changed (never their values), up to 200 for matching; messages show 15. */
  settings?: string[]
  settingsMore?: number
}

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed && trimmed.toLowerCase() !== "<null>" ? trimmed : null
}

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

function resourcesOf(raw: AuditEventRaw): Array<Record<string, unknown>> {
  if (!Array.isArray(raw.resources)) return []
  return raw.resources.flatMap((entry) => {
    const entryRecord = record(entry)
    return entryRecord ? [entryRecord] : []
  })
}

function isReadOperation(raw: AuditEventRaw): boolean {
  const operation = (text(raw.activityOperationType) ?? "").toLowerCase()
  return operation === "get" || operation === "search"
}

function isAssignmentEvent(raw: AuditEventRaw, resources: Array<Record<string, unknown>>): boolean {
  const activity = `${text(raw.activityType) ?? ""} ${text(raw.activity) ?? ""} ${text(raw.displayName) ?? ""}`.toLowerCase()
  if (activity.includes("assignment")) return true
  return resources.some((resource) => {
    const type = `${text(resource.type) ?? ""} ${text(resource.auditResourceType) ?? ""}`.toLowerCase()
    return type.includes("assignment")
  })
}

function changeTypeOf(raw: AuditEventRaw, resources: Array<Record<string, unknown>>): AuditChangeType {
  const operation = (text(raw.activityOperationType) ?? "").toLowerCase()
  const activity = `${text(raw.activityType) ?? ""} ${text(raw.activity) ?? ""} ${text(raw.displayName) ?? ""}`.toLowerCase()
  if (isAssignmentEvent(raw, resources)) {
    if (operation.includes("delet") || operation.includes("remov") || /(^|\s)(delete|remove|unassign)/.test(activity)) return "unassigned"
    return "assigned"
  }
  for (const source of [operation, activity]) {
    if (source.includes("assign")) return "assigned"
    if (source.includes("creat") || source === "post") return "created"
    if (source.includes("delet") || source.includes("remov") || source === "delete") return "deleted"
    if (source.includes("updat") || source.includes("patch") || source.includes("edit") || source === "put") return "updated"
  }
  return "changed"
}

function resourceOf(resources: Array<Record<string, unknown>>): Record<string, unknown> | null {
  return resources.find((resource) => text(resource.displayName)) ?? resources[0] ?? null
}

/** Maps one raw audit event, or null when it lacked identity fields, did not succeed, or only read data. */
export function mapAuditEvent(raw: AuditEventRaw): AuditChange | null {
  const id = text(raw.id)
  const at = text(raw.activityDateTime)
  if (!id || !at || Number.isNaN(Date.parse(at))) return null
  if (isReadOperation(raw)) return null
  const result = (text(raw.activityResult) ?? "").toLowerCase()
  if (result.includes("fail") || result.includes("error")) return null
  const actor = record(raw.actor)
  const resources = resourcesOf(raw)
  const resource = resourceOf(resources)
  const resourceName = resource ? text(resource.displayName) : null
  const changeType = changeTypeOf(raw, resources)
  const changed = changeType === "updated" ? intuneChangedSettings(resource) : { names: [], more: 0 }
  const resourceId = resource ? text(resource.resourceId) : null
  return {
    auditId: id,
    at: new Date(at).toISOString(),
    category: text(raw.category) ?? "Unknown",
    changeType,
    resourceName: resourceName ? resourceName.slice(0, 200) : null,
    resourceType: (resource ? (text(resource.type) ?? text(resource.auditResourceType)) : null) ?? text(raw.componentName),
    actorUpn: actor ? text(actor.userPrincipalName) : null,
    actorAppId: actor ? text(actor.applicationId) : null,
    actorAppName: actor ? text(actor.applicationDisplayName) : null,
    // Live events carry the operation in activityType ("Patch DeviceCompliancePolicy") with
    // activity null and displayName a full sentence ("Update device compliance policy."),
    // so activityType is the label that reads like the fixture shape ("Patch ...Policy").
    activity: text(raw.activity) ?? text(raw.activityType) ?? text(raw.displayName) ?? "Change",
    resourceId: resourceId ? resourceId.slice(0, 200) : null,
    settings: changed.names,
    settingsMore: changed.more,
  }
}

export interface AuditFilterOptions {
  /** Categories to keep; empty keeps every category. Matched case-insensitively. */
  categories?: string[]
  /** The desktop app registration id; its changes are dropped when ignoreOwnAppId matches. */
  ownAppId?: string | null
  ignoreOwnChanges?: boolean
  /** Actor UPNs to always drop, case-insensitive. */
  deniedActors?: string[]
}

export function filterAuditChanges(changes: AuditChange[], options: AuditFilterOptions): AuditChange[] {
  const categories = new Set((options.categories ?? []).map((entry) => entry.toLowerCase()))
  const denied = new Set((options.deniedActors ?? []).map((entry) => entry.toLowerCase()))
  return changes.filter((change) => {
    if (categories.size && !categories.has(change.category.toLowerCase())) return false
    if (options.ignoreOwnChanges && options.ownAppId && change.actorAppId?.toLowerCase() === options.ownAppId.toLowerCase()) return false
    if (change.actorUpn && denied.has(change.actorUpn.toLowerCase())) return false
    if (change.actorAppName && denied.has(change.actorAppName.toLowerCase())) return false
    return true
  })
}

/** The structured fields of a change line; settings of collapsed changes are merged in order. */
export function itemChange(changes: AuditChange[]): NotificationItemChange {
  const first = changes[0]!
  const settings: string[] = []
  let more = 0
  for (const change of changes) {
    for (const name of change.settings ?? []) if (!settings.some((entry) => entry.toLowerCase() === name.toLowerCase())) settings.push(name)
    more = Math.max(more, change.settingsMore ?? 0)
  }
  return {
    auditId: first.auditId,
    changeType: first.changeType,
    category: first.category,
    ...(first.resourceId ? { resourceId: first.resourceId } : {}),
    ...(first.resourceName ? { resourceName: first.resourceName } : {}),
    ...(first.resourceType ? { resourceType: first.resourceType } : {}),
    ...(changes.length > 1 ? { count: changes.length } : {}),
    ...(settings.length ? { settings: settings.slice(0, MAX_SETTING_NAMES) } : {}),
    ...(more + Math.max(0, settings.length - MAX_SETTING_NAMES) > 0 ? { settingsMore: more + Math.max(0, settings.length - MAX_SETTING_NAMES) } : {}),
  }
}

/**
 * Collapses repeated updates to the same resource by the same actor into one line with
 * a count, keeps chronological order of first appearance, and caps the visible items.
 */
export function collapseAuditChanges(changes: AuditChange[], options: { includeActor: boolean; maxItems?: number }): { items: NotificationItem[]; moreCount: number; collapsed: number } {
  const max = options.maxItems ?? 20
  const groups = new Map<string, AuditChange[]>()
  for (const change of changes) {
    // The object id first: two policies that share a name stay two lines.
    const key = [change.changeType, change.resourceId ?? change.resourceName ?? change.resourceType ?? change.auditId, change.actorUpn ?? change.actorAppName ?? change.actorAppId ?? ""].join("|").toLowerCase()
    const existing = groups.get(key)
    if (existing) existing.push(change)
    else groups.set(key, [change])
  }
  const lines = [...groups.values()]
  const items = lines.slice(0, max).map((group) => {
    const change = group[0]!
    const count = group.length
    const target = change.resourceName ?? change.resourceType ?? change.category
    const title = `${capitalize(change.changeType)}: ${target}${count > 1 ? ` (${count} times)` : ""}`
    return {
      title,
      detail: change.resourceName && change.resourceType ? change.resourceType : change.activity,
      ...(options.includeActor && (change.actorUpn ?? change.actorAppName) ? { actor: (change.actorUpn ?? change.actorAppName) as string } : {}),
      at: change.at,
      change: itemChange(group),
    }
  })
  return { items, moreCount: Math.max(0, lines.length - items.length), collapsed: lines.length }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** The services change watching reads, with the event type and wording of their digests. */
export type ChangeService = "intune" | "conditionalAccess"

export const SERVICE_DIGEST: Record<ChangeService, { type: "intune.change" | "entra.change"; title: string; label: string }> = {
  intune: { type: "intune.change", title: "Intune changes", label: "Intune" },
  conditionalAccess: { type: "entra.change", title: "Conditional Access changes", label: "Conditional Access" },
}

export interface ChangeDigestInput {
  tenantId: string
  tenantName?: string | null
  changes: AuditChange[]
  includeActor: boolean
  source: "desktop" | "azure-watcher"
  gapNotice?: string | null
}

/** One digest envelope for a poll worth of audit changes. The natural key is the sorted audit ids. */
export function intuneChangeDigest(input: ChangeDigestInput): NotificationEnvelope {
  return changeDigest("intune", input)
}

/** The Conditional Access digest: same shape as Intune's, as event type entra.change. */
export function entraChangeDigest(input: ChangeDigestInput): NotificationEnvelope {
  return changeDigest("conditionalAccess", input)
}

export function changeDigest(service: ChangeService, input: ChangeDigestInput): NotificationEnvelope {
  const wording = SERVICE_DIGEST[service]
  const { items, moreCount, collapsed } = collapseAuditChanges(input.changes, { includeActor: input.includeActor })
  const newest = input.changes.reduce((max, change) => (change.at > max ? change.at : max), input.changes[0]?.at ?? new Date(0).toISOString())
  const tenantLabel = input.tenantName ?? "your tenant"
  const byType = new Map<AuditChangeType, number>()
  for (const change of input.changes) byType.set(change.changeType, (byType.get(change.changeType) ?? 0) + 1)
  const counts = [...byType.entries()].map(([type, count]) => `${count} ${type}`).join(", ")
  return buildEnvelope({
    type: wording.type,
    severity: input.changes.some((change) => change.changeType === "deleted" || change.changeType === "unassigned") ? "warning" : "info",
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    occurredAt: newest,
    naturalKey: input.changes.map((change) => change.auditId).sort().join(","),
    title: `${wording.title}: ${tenantLabel}`,
    summary: `${input.changes.length} ${input.changes.length === 1 ? "change" : "changes"} in ${wording.label} (${counts})${collapsed < input.changes.length ? `, shown as ${collapsed} lines` : ""}.${input.gapNotice ? ` ${input.gapNotice}` : ""}`,
    details: [{ label: "Changes", value: String(input.changes.length) }],
    items,
    moreCount,
    source: input.source,
  })
}

/** "updated" as written in a sentence. */
const CHANGE_VERB: Record<AuditChangeType, string> = { created: "created", updated: "updated", deleted: "deleted", assigned: "assigned", unassigned: "unassigned", changed: "changed" }

/** Joins setting names for a sentence: "A, B and 3 more". */
export function settingsSentence(names: string[], more: number): string {
  if (!names.length) return ""
  const shown = names.join(", ")
  return more > 0 ? `${shown} and ${more} more` : shown
}

export interface ChangeEventInput {
  tenantId: string
  tenantName?: string | null
  change: AuditChange
  includeActor: boolean
  source: "desktop" | "azure-watcher"
}

/**
 * One alert for one audited change, for alerts that send each change on its own. The natural
 * key is the audit id, so every alert that picks the same change sends the same event.
 */
export function changeEvent(service: ChangeService, input: ChangeEventInput): NotificationEnvelope {
  const wording = SERVICE_DIGEST[service]
  const { change } = input
  const target = change.resourceName ?? change.resourceType ?? change.category
  const verb = CHANGE_VERB[change.changeType]
  const tenantLabel = input.tenantName ?? "your tenant"
  const actor = input.includeActor ? (change.actorUpn ?? change.actorAppName) : null
  const allSettings = change.settings ?? []
  const settings = allSettings.slice(0, MAX_SETTING_NAMES)
  const more = (change.settingsMore ?? 0) + Math.max(0, allSettings.length - MAX_SETTING_NAMES)
  const kind = change.resourceName && change.resourceType ? ` (${change.resourceType})` : ""
  const details: Array<{ label: string; value: string }> = [{ label: "Change", value: capitalize(change.changeType) }]
  if (change.resourceType) details.push({ label: "Type", value: change.resourceType })
  if (service === "intune") details.push({ label: "Category", value: change.category })
  if (actor) details.push({ label: "By", value: actor })
  return buildEnvelope({
    type: wording.type,
    severity: change.changeType === "deleted" || change.changeType === "unassigned" ? "warning" : "info",
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    occurredAt: change.at,
    naturalKey: `change:${change.auditId}`,
    title: `${wording.label} change: ${target} ${verb}`,
    summary: `${target}${kind} was ${verb} in ${wording.label} for ${tenantLabel}${actor ? ` by ${actor}` : ""}.${settings.length ? ` Changed settings: ${settingsSentence(settings, more)}.` : ""}`,
    details,
    items: collapseAuditChanges([change], { includeActor: input.includeActor }).items,
    source: input.source,
  })
}

/** The $select allowlist for audit event reads, matching the documented auditEvent resource. */
export const AUDIT_EVENT_SELECT = "id,displayName,componentName,actor,activity,activityDateTime,activityType,activityOperationType,activityResult,category,resources"
