/**
 * Mapping of Intune audit events (GET deviceManagement/auditEvents) to notification
 * change items, following the documented auditEvent resource: identity and operation
 * fields plus resource display names and types. Modified property values inside
 * resources are never read.
 */
import { buildEnvelope, type NotificationEnvelope, type NotificationItem } from "./envelope"

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

export type AuditChangeType = "created" | "updated" | "deleted" | "assigned" | "changed"

export interface AuditChange {
  auditId: string
  at: string
  category: string
  changeType: AuditChangeType
  /** Policy or object display name when the audit event carries one. */
  resourceName: string | null
  /** Graph resource segment from requestUrl, for example deviceConfigurations. */
  resourceType: string | null
  actorUpn: string | null
  actorAppId: string | null
  activity: string
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null)

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

function changeTypeOf(raw: AuditEventRaw): AuditChangeType {
  const operation = (text(raw.activityOperationType) ?? "").toLowerCase()
  const activity = `${text(raw.activityType) ?? ""} ${text(raw.activity) ?? ""} ${text(raw.displayName) ?? ""}`.toLowerCase()
  for (const source of [operation, activity]) {
    if (source.includes("assign")) return "assigned"
    if (source.includes("creat") || source === "post") return "created"
    if (source.includes("delet") || source.includes("remov") || source === "delete") return "deleted"
    if (source.includes("updat") || source.includes("patch") || source.includes("edit") || source === "put") return "updated"
  }
  return "changed"
}

function resourceOf(raw: AuditEventRaw): Record<string, unknown> | null {
  if (!Array.isArray(raw.resources)) return null
  for (const entry of raw.resources) {
    const entryRecord = record(entry)
    if (entryRecord) return entryRecord
  }
  return null
}

/** Maps one raw audit event, or null when it lacked identity fields or did not succeed. */
export function mapAuditEvent(raw: AuditEventRaw): AuditChange | null {
  const id = text(raw.id)
  const at = text(raw.activityDateTime)
  if (!id || !at || Number.isNaN(Date.parse(at))) return null
  const result = (text(raw.activityResult) ?? "").toLowerCase()
  if (result.includes("fail") || result.includes("error")) return null
  const actor = record(raw.actor)
  const resource = resourceOf(raw)
  const resourceName = resource ? text(resource.displayName) : null
  return {
    auditId: id,
    at: new Date(at).toISOString(),
    category: text(raw.category) ?? "Unknown",
    changeType: changeTypeOf(raw),
    resourceName: resourceName ? resourceName.slice(0, 200) : null,
    resourceType: (resource ? (text(resource.type) ?? text(resource.auditResourceType)) : null) ?? text(raw.componentName),
    actorUpn: actor ? text(actor.userPrincipalName) : null,
    actorAppId: actor ? text(actor.applicationId) : null,
    activity: text(raw.activity) ?? text(raw.displayName) ?? "Change",
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
    return true
  })
}

/**
 * Collapses repeated updates to the same resource by the same actor into one line with
 * a count, keeps chronological order of first appearance, and caps the visible items.
 */
export function collapseAuditChanges(changes: AuditChange[], options: { includeActor: boolean; maxItems?: number }): { items: NotificationItem[]; moreCount: number; collapsed: number } {
  const max = options.maxItems ?? 20
  const groups = new Map<string, { change: AuditChange; count: number }>()
  for (const change of changes) {
    const key = [change.changeType, change.resourceName ?? change.resourceType ?? change.auditId, change.actorUpn ?? ""].join("|").toLowerCase()
    const existing = groups.get(key)
    if (existing) existing.count++
    else groups.set(key, { change, count: 1 })
  }
  const lines = [...groups.values()]
  const items = lines.slice(0, max).map(({ change, count }) => {
    const target = change.resourceName ?? change.resourceType ?? change.category
    const title = `${capitalize(change.changeType)}: ${target}${count > 1 ? ` (${count} times)` : ""}`
    return {
      title,
      detail: change.resourceName && change.resourceType ? change.resourceType : change.activity,
      ...(options.includeActor && change.actorUpn ? { actor: change.actorUpn } : {}),
      at: change.at,
    }
  })
  return { items, moreCount: Math.max(0, lines.length - items.length), collapsed: lines.length }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** One digest envelope for a poll worth of audit changes. The natural key is the sorted audit ids. */
export function intuneChangeDigest(input: {
  tenantId: string
  tenantName?: string | null
  changes: AuditChange[]
  includeActor: boolean
  source: "desktop" | "azure-watcher"
  gapNotice?: string | null
}): NotificationEnvelope {
  const { items, moreCount, collapsed } = collapseAuditChanges(input.changes, { includeActor: input.includeActor })
  const newest = input.changes.reduce((max, change) => (change.at > max ? change.at : max), input.changes[0]?.at ?? new Date(0).toISOString())
  const tenantLabel = input.tenantName ?? "your tenant"
  const byType = new Map<AuditChangeType, number>()
  for (const change of input.changes) byType.set(change.changeType, (byType.get(change.changeType) ?? 0) + 1)
  const counts = [...byType.entries()].map(([type, count]) => `${count} ${type}`).join(", ")
  return buildEnvelope({
    type: "intune.change",
    severity: input.changes.some((change) => change.changeType === "deleted") ? "warning" : "info",
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    occurredAt: newest,
    naturalKey: input.changes.map((change) => change.auditId).sort().join(","),
    title: `Intune changes: ${tenantLabel}`,
    summary: `${input.changes.length} ${input.changes.length === 1 ? "change" : "changes"} in Intune (${counts})${collapsed < input.changes.length ? `, shown as ${collapsed} lines` : ""}.${input.gapNotice ? ` ${input.gapNotice}` : ""}`,
    details: [{ label: "Changes", value: String(input.changes.length) }],
    items,
    moreCount,
    source: input.source,
  })
}

/** The $select allowlist for audit event reads, matching the documented auditEvent resource. */
export const AUDIT_EVENT_SELECT = "id,displayName,componentName,actor,activity,activityDateTime,activityType,activityOperationType,activityResult,category,resources"
