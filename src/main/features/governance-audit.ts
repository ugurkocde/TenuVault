import { AuditEventType, AuditResult, AuditSeverity, type CreateAuditLogInput } from "../../portal/lib/audit/types"
import type { FeatureDeps } from "./deps"

/**
 * Records one governance decision in the tenant's audit log: a change set approval or
 * rejection, a hygiene review, a customization, or a standard publish or adoption.
 * Decisions are recorded the same way as change set applies (one entry, attributed to
 * the signed-in admin, queued by the audit route for retry). Recording never changes
 * the outcome of the decision itself: a failed write is logged and the record stands.
 * `link` is stored in the details so the Audit Log page can open the deciding screen.
 */
export async function recordGovernanceAudit(
  deps: FeatureDeps,
  tenantId: string,
  actor: string | null,
  entry: { eventType: AuditEventType; action: string; resourceId: string; resourceName: string; link: string; details?: Record<string, unknown> },
): Promise<void> {
  try {
    const tenant = tenantId.toLowerCase()
    const account = deps.actor(tenant)
    const logEntry: CreateAuditLogInput = {
      eventType: entry.eventType,
      action: entry.action,
      resource: { type: "configuration", id: entry.resourceId, name: entry.resourceName },
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.INFO,
      details: { source: "desktop-governance", link: entry.link, recordId: entry.resourceId, ...entry.details },
    }
    const logged = await deps.api("/api/audit/log", tenant, {
      user: { id: account?.id ?? "unknown", email: account?.id ?? "unknown", name: account?.name ?? actor ?? "Unknown user" },
      logEntry,
    })
    if (!logged.ok) throw new Error(`Audit write failed (${logged.status})`)
  } catch (error) {
    console.error("[audit] Failed to record governance decision:", error)
  }
}
