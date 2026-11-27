import type { AuditChange, AuditChangeType } from "./audit"
import { buildEnvelope, sha256Hex, type EnvelopeInput, type NotificationItem } from "./envelope"

export const MASS_CHANGE_EVENT = "intune.massChange"
export const MASS_CHANGE_RUNBOOK_VERSION = "1.6.0"
export const MASS_CHANGE_TYPES = ["updated", "assigned", "unassigned", "changed", "created"] as const
export const MAX_MASS_CHANGE_THRESHOLD = 1_000_000
export type MassChangeType = typeof MASS_CHANGE_TYPES[number]

export interface MassChangeThresholds {
  deleted: number | null
  changed: number | null
  changeTypes: MassChangeType[]
}

export const DEFAULT_MASS_CHANGE: MassChangeThresholds = {
  deleted: 5, changed: 20, changeTypes: ["updated", "assigned", "unassigned", "changed"],
}

export function needsMassChange(rules: readonly { enabled: boolean; eventTypes: readonly string[] }[]): boolean {
  return rules.some((rule) => rule.enabled && rule.eventTypes.includes(MASS_CHANGE_EVENT))
}

export function parseMassChange(value: unknown): MassChangeThresholds | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const threshold = (entry: unknown) => typeof entry === "number" && Number.isInteger(entry) && entry > 0 && entry <= MAX_MASS_CHANGE_THRESHOLD ? entry : null
  const deleted = threshold(raw.deleted)
  const changed = threshold(raw.changed)
  const types = Array.isArray(raw.changeTypes) ? raw.changeTypes : []
  const changeTypes = MASS_CHANGE_TYPES.filter((type) => types.includes(type))
  if ((changed !== null && !changeTypes.length) || (deleted === null && changed === null)) return null
  return { deleted, changed, changeTypes }
}

export interface MassChangeCount {
  count: number
  items: NotificationItem[]
}

export function massChangeEnvelope(
  context: Pick<EnvelopeInput, "tenantId" | "tenantName" | "occurredAt" | "source">,
  naturalKey: string,
  origin: "audit" | "backup",
  deleted: MassChangeCount,
  changed: MassChangeCount,
) {
  const items = [...deleted.items.slice(0, 5), ...changed.items.slice(0, 5)]
  return buildEnvelope({
    ...context,
    type: MASS_CHANGE_EVENT,
    severity: "critical",
    naturalKey,
    title: `Mass Intune policy change: ${context.tenantName ?? "your tenant"}`,
    summary: `${origin === "audit" ? "One Intune audit check" : "One backup comparison"} found ${deleted.count} deleted and ${changed.count} changed policies.`,
    details: [{ label: "Deleted policies", value: String(deleted.count) }, { label: "Changed policies", value: String(changed.count) }],
    items,
    moreCount: deleted.count + changed.count - items.length,
  })
}

export function reachesMassChangeThreshold(thresholds: MassChangeThresholds, deleted: number, changed: number): boolean {
  return (thresholds.deleted !== null && deleted >= thresholds.deleted) || (thresholds.changed !== null && changed >= thresholds.changed)
}

/** Recognizes the policy and profile types recorded in audit events and backup comparisons. */
export function isIntunePolicyType(type: string): boolean {
  return /polic(?:y|ies)|configuration|intent|(?:update|enrollment|deployment|template) ?profiles?|security baselines|administrative templates|managedAppProtection/i.test(type)
    && !/conditional ?access|unknown policy/i.test(type)
}

function policyKey(change: AuditChange): string | null {
  if (!isIntunePolicyType(change.resourceType ?? "")) return null
  if (change.resourceId) return change.resourceId.toLowerCase()
  return change.resourceName ? `${change.resourceType}|${change.resourceName}`.toLowerCase() : null
}

function countAuditPolicies(changes: AuditChange[], types: readonly AuditChangeType[], includeActor: boolean, excluded?: ReadonlyMap<string, AuditChange>) {
  const policies = new Map<string, AuditChange>()
  const auditIds: string[] = []
  // Keep the latest event for each policy and show the most recently affected policies first.
  for (const change of changes) {
    if (!types.includes(change.changeType)) continue
    const key = policyKey(change)
    if (!key || excluded?.has(key)) continue
    auditIds.push(change.auditId)
    if (!policies.has(key)) policies.set(key, change)
  }
  return {
    count: policies.size,
    policies,
    auditIds,
    items: [...policies.values()].slice(0, 5).map((change) => ({
      title: change.resourceName ?? change.resourceType ?? "Intune policy",
      detail: change.changeType,
      actor: includeActor ? change.actorUpn ?? change.actorAppName ?? undefined : undefined,
      at: change.at,
    })),
  }
}

function auditMassChangeKey(auditIds: string[], changedIds: string[]): string {
  return `audit:${sha256Hex([...new Set(auditIds)].sort().join("|"))}:${sha256Hex([...new Set(changedIds)].sort().join("|"))}`
}

export function auditMassChangeEnvelope(
  changes: AuditChange[],
  thresholds: MassChangeThresholds,
  context: Pick<EnvelopeInput, "tenantId" | "tenantName" | "source"> & { includeActor: boolean },
) {
  if (!changes.length) return null
  const newestFirst = [...changes].sort((a, b) => {
    const byTime = Date.parse(b.at) - Date.parse(a.at)
    if (byTime || a.auditId === b.auditId) return byTime
    return a.auditId < b.auditId ? -1 : 1
  })
  const deletions = countAuditPolicies(newestFirst, ["deleted"], context.includeActor)
  const deleted = thresholds.deleted === null ? { count: 0, items: [], auditIds: [] } : deletions
  const changed = countAuditPolicies(newestFirst, thresholds.changed === null ? [] : thresholds.changeTypes, context.includeActor, deletions.policies)
  if (!reachesMassChangeThreshold(thresholds, deleted.count, changed.count)) return null
  const key = auditMassChangeKey(deleted.auditIds, changed.auditIds)
  return massChangeEnvelope({ ...context, occurredAt: newestFirst[0]!.at }, key, "audit", deleted, changed)
}

export type BackupMassChange = Record<"deleted" | "updated" | "created", MassChangeCount>

export function backupMassChangeEnvelope(
  comparison: BackupMassChange,
  thresholds: MassChangeThresholds,
  context: Pick<EnvelopeInput, "tenantId" | "tenantName" | "occurredAt" | "source">,
  backup: string,
) {
  const deleted = thresholds.deleted === null ? { count: 0, items: [] } : comparison.deleted
  const types = (["updated", "created"] as const).filter((type) => thresholds.changed !== null && thresholds.changeTypes.includes(type))
  const changed = {
    count: types.reduce((total, type) => total + comparison[type].count, 0),
    items: types.flatMap((type) => comparison[type].items),
  }
  if (!reachesMassChangeThreshold(thresholds, deleted.count, changed.count)) return null
  return massChangeEnvelope(context, `backup:${backup}:${deleted.count}:${types.join(",")}`, "backup", deleted, changed)
}
