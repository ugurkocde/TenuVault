import type { ApprovalDependencies } from "./service"
import { AuditResult, AuditSeverity, AuditEventType } from "../../portal/lib/audit/types"
import { DELEGATED_CLIENT_SECRET, INTERNAL_API_ORIGIN } from "../../shared/constants"

export function approvalAudit(client: (tenant: string) => string, dispatch: (request: Request) => Promise<Response>): ApprovalDependencies["audit"] {
  return async event => {
    const { tenant, account, actor, action, ...details } = event
    const response = await dispatch(new Request(`${INTERNAL_API_ORIGIN}/api/audit/log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: tenant, storageAccountName: account, appId: client(tenant), clientSecret: DELEGATED_CLIENT_SECRET,
        user: { id: actor.oid, email: "", name: actor.label },
        logEntry: {
          eventType: AuditEventType.CONFIG_UPDATED, action,
          resource: { type: "tenant-write-approval", id: event.requestId ?? tenant, name: "Tenant write approval" },
          result: AuditResult.SUCCESS, severity: AuditSeverity.INFO, details,
        },
      }),
    }))
    if (!response.ok) throw new Error("The tenant write approval audit receipt could not be saved.")
  }
}
