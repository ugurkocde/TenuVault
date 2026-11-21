import type { ApprovalDependencies } from "./service"
import { AuditResult, AuditSeverity, AuditEventType } from "../../portal/lib/audit/types"
import { DELEGATED_CLIENT_SECRET, INTERNAL_API_ORIGIN } from "../../shared/constants"
import { AuditStorageService } from "../../portal/lib/audit/storage"
import { queueEvent } from "../../portal/lib/audit/outbox"
import type { AuditLogEntry } from "../../portal/lib/audit/types"

export function approvalAudit(client: (tenant: string) => string, dispatch: (request: Request) => Promise<Response>,
  storageToken: (tenant: string, clientId: string) => Promise<string>): ApprovalDependencies["audit"] {
  return async event => {
    const { tenant, account, actor, action, receipt, ...details } = event
    const user = { id: actor.oid, email: "", name: actor.label, tenantId: tenant }
    const logEntry = {
      eventType: AuditEventType.CONFIG_UPDATED, action,
      resource: { type: "configuration" as const, id: event.requestId ?? tenant, name: "Tenant write approval" },
      result: AuditResult.SUCCESS, severity: AuditSeverity.INFO, details,
    }
    if (receipt) {
      const entry: AuditLogEntry = {
        ...logEntry, id: receipt.id, timestamp: new Date(receipt.at).toISOString(), user,
        context: { ipAddress: "unknown", userAgent: "TenuVault Desktop" },
      }
      queueEvent(account, entry)
      const accessToken = await storageToken(tenant, client(tenant))
      await new AuditStorageService({ storageAccountName: account, accessToken }).writeLog(entry)
      return
    }
    const response = await dispatch(new Request(`${INTERNAL_API_ORIGIN}/api/audit/log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: tenant, storageAccountName: account, appId: client(tenant), clientSecret: DELEGATED_CLIENT_SECRET,
        user, logEntry,
      }),
    }))
    if (!response.ok) throw new Error("The tenant write approval audit receipt could not be saved.")
  }
}
