/**
 * Mapping of Intune audit events (GET deviceManagement/auditEvents) to notification
 * change items. Only allowlisted fields are read: id, activity, activityDateTime,
 * category, httpVerb, initiatedByUpn, initiatedByAppId and requestUrl, plus resource
 * display names when present. Request bodies and audit property values are never read.
 */
import { buildEnvelope, type NotificationEnvelope, type NotificationItem } from "./envelope"

export interface AuditEventRaw {
  id?: unknown
  activity?: unknown
  activityDateTime?: unknown
  category?: unknown
  httpVerb?: unknown
  initiatedByUpn?: unknown
  initiatedByAppId?: unknown
  requestUrl?: unknown
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

function changeTypeOf(raw: AuditEventRaw): AuditChangeType {
  const activity = (text(raw.activity) ?? "").toLowerCase()
  if (activity.includes("assign")) return "assigned"
  const verb = (text(raw.httpVerb) ?? "").toUpperCase()
  if (verb === "POST") return "created"
  if (verb === "PUT" || verb === "PATCH") return "updated"
  if (verb === "DELETE") return "deleted"
  if (activity.includes("creat")) return "created"
  if (activity.includes("delet") || activity.includes("remov")) return "deleted"
  if (activity.includes("updat") || activity.includes("edit") || activity.includes("patch")) return "updated"
  return "changed"
}

function resourceTypeOf(raw: AuditEventRaw): string | null {
  const url = text(raw.requestUrl)
  if (!url) return null
  const path = url.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/(beta|v1\.0)\//i, "/")
  const segments = path.split("/").filter(Boolean)
  const at = segments.findIndex((segment) => segment.toLowerCase() === "devicemanagement")
  const segment = at >= 0 ? segments[at + 1] : segments[0]
  return segment ? decodeURIComponent(segment).slice(0, 120) : null
}

function resourceNameOf(raw: AuditEventRaw): string | null {
  if (!Array.isArray(raw.resources)) return null
  for (const entry of raw.resources) {
    if (entry && typeof entry === "object") {
      const name = text((entry as Record<string, unknown>).displayName)
      if (name) return name.slice(0, 200)
    }
  }
  return null
}

/** Maps one raw audit event, or null when it lacks the fields a digest needs. */
export function mapAuditEvent(raw: AuditEventRaw): AuditChange | null {
  const id = text(raw.id)
  const at = text(raw.activityDateTime)
  if (!id || !at || Number.isNaN(Date.parse(at))) return null
  return {
    auditId: id,
    at: new Date(at).toISOString(),
    category: text(raw.category) ?? "Unknown",
    changeType: changeTypeOf(raw),
    resourceName: resourceNameOf(raw),
    resourceType: resourceTypeOf(raw),
    actorUpn: text(raw.initiatedByUpn),
    actorAppId: text(raw.initiatedByAppId),
    activity: text(raw.activity) ?? "Change",
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

/** The $select allowlist for audit event reads. Request bodies are excluded on purpose. */
export const AUDIT_EVENT_SELECT = "id,activity,activityDateTime,category,httpVerb,initiatedByUpn,initiatedByAppId,requestUrl,resources"
