/**
 * Mapping of Entra audit events (GET auditLogs/directoryAudits) for Conditional Access
 * policies, named locations and authentication strengths to notification change items.
 *
 * Graph returns targetResources with modifiedProperties (the full policy JSON before and
 * after) and initiatedBy.user.ipAddress even under $select. Neither is ever read: only
 * ids, times, the activity name, the operation, the result, target display names and the
 * actor's UPN and app are.
 */
import type { AuditChange, AuditChangeType } from "./audit"

export interface EntraAuditRaw {
  id?: unknown
  activityDateTime?: unknown
  activityDisplayName?: unknown
  category?: unknown
  operationType?: unknown
  result?: unknown
  loggedByService?: unknown
  initiatedBy?: unknown
  targetResources?: unknown
}

/** Top level fields only; Graph still returns nested modifiedProperties, which are ignored. */
export const ENTRA_AUDIT_SELECT = "id,activityDateTime,activityDisplayName,category,operationType,result,loggedByService,initiatedBy,targetResources"

/**
 * Conditional Access policies and named locations are logged by the Conditional Access
 * service; authentication strengths by Authentication Methods, which also logs every user's
 * security info registration, so those are narrowed to their activity names on the server.
 */
export const ENTRA_AUDIT_FILTER = "(loggedByService eq 'Conditional Access' or startswith(activityDisplayName,'Authentication Strength'))"

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/** The object kind an activity changed, as shown in a digest line. */
export function entraResourceType(activity: string): string {
  const lower = activity.toLowerCase()
  if (lower.includes("named location")) return "Named location"
  if (lower.startsWith("authentication strength")) return "Authentication strength"
  if (lower.includes("conditional access policy")) return "Conditional Access policy"
  return "Conditional Access"
}

function changeTypeOf(operation: string, activity: string): AuditChangeType {
  const lower = activity.toLowerCase()
  // Combination settings belong to a strength: changing one changes the strength.
  if (lower.startsWith("authentication strength combination configuration")) return "updated"
  const op = operation.toLowerCase()
  if (op === "add" || op === "create") return "created"
  if (op === "delete") return "deleted"
  if (op === "update") return "updated"
  if (lower.startsWith("add ") || lower.endsWith(" create")) return "created"
  if (lower.startsWith("delete ") || lower.endsWith(" delete")) return "deleted"
  if (lower.startsWith("update ") || lower.endsWith(" update")) return "updated"
  return "changed"
}

/** Maps one raw directory audit event, or null when it lacked identity, did not succeed, or is out of scope. */
export function mapEntraAuditEvent(raw: EntraAuditRaw): AuditChange | null {
  const id = text(raw.id)
  const at = text(raw.activityDateTime)
  if (!id || !at || Number.isNaN(Date.parse(at))) return null
  // clientError and failure attempts changed nothing.
  if ((text(raw.result) ?? "").toLowerCase() !== "success") return null
  const activity = text(raw.activityDisplayName) ?? "Change"
  const service = text(raw.loggedByService) ?? ""
  if (service !== "Conditional Access" && !activity.toLowerCase().startsWith("authentication strength")) return null
  const resourceType = entraResourceType(activity)
  // Authentication strength events name only a generic "Authentication Strength Policy";
  // the strength's own name sits in modifiedProperties, which is never read.
  const targets = Array.isArray(raw.targetResources) ? raw.targetResources.map(record).filter((entry): entry is Record<string, unknown> => entry !== null) : []
  const named = resourceType === "Authentication strength" ? null : targets.map((target) => text(target.displayName)).find((name) => name !== null) ?? null
  const initiatedBy = record(raw.initiatedBy)
  const user = record(initiatedBy?.user)
  const app = record(initiatedBy?.app)
  return {
    auditId: id,
    at: new Date(at).toISOString(),
    category: "ConditionalAccess",
    changeType: changeTypeOf(text(raw.operationType) ?? "", activity),
    resourceName: named ? named.slice(0, 200) : null,
    resourceType,
    actorUpn: user ? text(user.userPrincipalName) : null,
    actorAppId: app ? text(app.appId) : null,
    actorAppName: app ? text(app.displayName) : null,
    activity,
    resourceIds: targets.flatMap((target) => text(target.id) ?? []).slice(0, 20),
  }
}
