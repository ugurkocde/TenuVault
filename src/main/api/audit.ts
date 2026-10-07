import { AuditEventType, AuditResult, AuditSeverity, type CreateAuditLogInput } from "~/lib/audit/types"
import type { SignedInAccount } from "../../shared/ipc"
import { CANCELLED_HEADER } from "../../portal/lib/drift/scan-hooks"
import { DELEGATED_CLIENT_SECRET, INTERNAL_API_ORIGIN, localStorageAccountName } from "../../shared/constants"

/** Which API calls are audited, and how they are described. */
export const API_AUDIT_MAP: Record<string, { eventType: AuditEventType; action: string; resourceType: string }> = {
  "POST:/api/backup/start": { eventType: AuditEventType.BACKUP_STARTED, action: "Start backup", resourceType: "backup" },
  "POST:/api/download-backup": { eventType: AuditEventType.BACKUP_DOWNLOADED, action: "Download backup", resourceType: "backup" },
  "POST:/api/detect-drifts": { eventType: AuditEventType.POLICY_DRIFT_DETECTED, action: "Detect drifts", resourceType: "policy" },
}

interface AuditBody {
  tenantId?: string
  appId?: string
  clientSecret?: string
  storageAccountName?: string
  id?: string
  scheduleId?: string
  policyId?: string
  name?: string
  tenantName?: string
  policyName?: string
}

/**
 * Records audit log entries for API calls, attributed to the admin signed in to the
 * tenant. Entries are written to the tenant's backup storage by /api/audit/log.
 */
export function createAuditRecorder(
  dispatch: (request: Request) => Promise<Response>,
  accountFor: (tenantId: string) => SignedInAccount | null,
) {
  return (request: Request, requestBody: string, response: Response): void => {
    const path = new URL(request.url).pathname
    if (path.startsWith("/api/audit")) return
    if (path === "/api/frameworks") {
      void recordFrameworkCreation(requestBody, response.clone(), dispatch, accountFor)
        .catch((error: unknown) => console.error("[audit] Failed to record baseline creation:", error))
      return
    }
    if (path === "/api/oib") {
      void recordOib(requestBody, response.clone(), dispatch, accountFor)
        .catch((error: unknown) => console.error("[audit] Failed to record OpenIntuneBaseline change:", error))
      return
    }

    if (["/api/restore-backup", "/api/revert-policy"].includes(path) && request.method === "POST") {
      void recordRestore(requestBody, response.clone(), dispatch, accountFor, path === "/api/revert-policy")
        .catch((error: unknown) => console.error("[audit] Failed to record restore:", error))
      return
    }

    const config = Object.entries(API_AUDIT_MAP).find(([key]) => {
      const [method, configPath] = key.split(":")
      return method === request.method && configPath !== undefined && path.startsWith(configPath)
    })?.[1]
    if (!config) return
    // A drift scan the admin cancelled neither succeeded nor failed.
    if (response.headers.get(CANCELLED_HEADER)) return

    let body: AuditBody
    try {
      body = JSON.parse(requestBody) as AuditBody
    } catch {
      return
    }
    if (!body.tenantId || !body.appId || !body.clientSecret || !body.storageAccountName) return

    const account = accountFor(body.tenantId)
    const ok = response.status >= 200 && response.status < 300
    const logEntry: CreateAuditLogInput = {
      eventType: config.eventType,
      action: config.action,
      resource: {
        type: config.resourceType as CreateAuditLogInput["resource"]["type"],
        id: body.id ?? body.scheduleId ?? body.policyId ?? body.tenantId,
        name: body.name ?? body.tenantName ?? body.policyName ?? "Unknown",
      },
      result: ok ? AuditResult.SUCCESS : AuditResult.FAILURE,
      severity: ok ? AuditSeverity.INFO : AuditSeverity.ERROR,
      details: { method: request.method, path, statusCode: response.status, source: "desktop" },
    }

    void dispatch(
      new Request(`${INTERNAL_API_ORIGIN}/api/audit/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: body.tenantId,
          appId: body.appId,
          clientSecret: body.clientSecret,
          storageAccountName: body.storageAccountName,
          user: {
            id: account?.username ?? "unknown",
            email: account?.username ?? "unknown",
            name: account?.name ?? account?.username ?? "Unknown user",
          },
          logEntry,
        }),
      }),
    ).catch((error: unknown) => console.error("[audit] Failed to write audit entry:", error))
  }
}

/** Restore runs synchronously and can partially fail despite returning HTTP 200. */
async function recordRestore(bodyText: string, response: Response, dispatch: (request: Request) => Promise<Response>, accountFor: (id: string) => SignedInAccount | null, policyCopy = false) {
  const body = JSON.parse(bodyText) as AuditBody & { backupId?: string; originalName?: string; action?: string; mode?: string }
  if (!body.tenantId || !body.appId || !body.clientSecret || !body.storageAccountName) return
  const data = await response.json().catch(() => ({})) as {
    success?: boolean; jobId?: string; policyId?: string; status?: string; error?: string; partial?: boolean
    details?: { restoredCount: number; partialCount?: number; failedCount: number; duration: number; results: { path: string; success: boolean; policyId?: string; error?: string }[] }
  }
  const ok = response.ok && data.success === true
  // Some copies were created, so the restore completed with failures rather than failing outright.
  const partial = !ok && (data.partial === true || (response.ok && ((data.details?.restoredCount ?? 0) > 0 || (data.details?.partialCount ?? 0) > 0)))
  const account = accountFor(body.tenantId)
  const logEntry: CreateAuditLogInput = {
    eventType: policyCopy ? (body.action === "revert" ? AuditEventType.POLICY_REVERTED : AuditEventType.POLICY_RESTORED) : ok || partial ? AuditEventType.RESTORE_COMPLETED : AuditEventType.RESTORE_FAILED,
    action: policyCopy
      ? body.action === "revert" ? "Revert policy to the backed-up version in place" : "Restore policy as an unassigned copy"
      : body.mode === "replace" ? "Restore backup in place" : "Restore backup as policy copies",
    resource: { type: policyCopy ? "policy" : "backup", id: data.policyId ?? data.jobId ?? body.policyId ?? body.backupId ?? body.tenantId, name: body.originalName ?? body.backupId ?? "Restore backup" },
    result: ok ? AuditResult.SUCCESS : partial ? AuditResult.PARTIAL : AuditResult.FAILURE,
    severity: ok ? AuditSeverity.INFO : partial ? AuditSeverity.WARNING : AuditSeverity.ERROR,
    details: { source: "desktop", statusCode: response.status, status: data.status, backupId: body.backupId, ...data.details,
      error: data.error ? { code: "RESTORE_FAILED", message: data.error } : undefined },
  }
  const logged = await dispatch(new Request(`${INTERNAL_API_ORIGIN}/api/audit/log`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      tenantId: body.tenantId, appId: body.appId, clientSecret: body.clientSecret, storageAccountName: body.storageAccountName,
      user: { id: account?.username ?? "unknown", email: account?.username ?? "unknown", name: account?.name ?? "Unknown user" }, logEntry,
    }),
  }))
  if (!logged.ok) throw new Error(`Audit write failed (${logged.status})`)
}

async function recordFrameworkCreation(bodyText: string, response: Response, dispatch: (request: Request) => Promise<Response>, accountFor: (id: string) => SignedInAccount | null) {
  const body = JSON.parse(bodyText) as { action?: string; tenantId?: string; appId?: string; runId?: string; storageAccountName?: string }
  if (body.action !== "create" || !body.tenantId || !body.appId) return
  const data = await response.json() as { success?: boolean; results?: { id?: string; name: string; error?: string }[]; error?: string }
  const account = accountFor(body.tenantId)
  const entries = data.results?.length ? data.results : [{ name: "Baseline creation", error: data.error || "No creation result returned." }]
  for (const result of entries) {
    const ok = response.ok && !!result.id && !result.error
    const logEntry: CreateAuditLogInput = {
      eventType: AuditEventType.POLICY_CREATED, action: "Create unassigned baseline policy",
      resource: { type: "policy", id: result.id ?? body.runId ?? body.tenantId, name: result.name },
      result: ok ? AuditResult.SUCCESS : AuditResult.FAILURE, severity: ok ? AuditSeverity.INFO : AuditSeverity.ERROR,
      details: { source: "desktop-frameworks", runId: body.runId, assigned: false, error: result.error ? { code: "BASELINE_CREATION_FAILED", message: result.error } : undefined },
    }
    const logged = await dispatch(new Request(`${INTERNAL_API_ORIGIN}/api/audit/log`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        tenantId: body.tenantId, appId: body.appId, clientSecret: DELEGATED_CLIENT_SECRET,
        storageAccountName: localStorageAccountName(body.tenantId),
        user: { id: account?.username ?? "unknown", email: account?.username ?? "unknown", name: account?.name ?? "Unknown user" }, logEntry,
      }),
    }))
    if (!logged.ok) throw new Error(`Audit write failed (${logged.status})`)
  }
}

/** One entry per OpenIntuneBaseline deployment, drift fix or undo, with the counts, rather than one per policy. */
async function recordOib(
  bodyText: string,
  response: Response,
  dispatch: (request: Request) => Promise<Response>,
  accountFor: (id: string) => SignedInAccount | null,
) {
  const body = JSON.parse(bodyText) as { action?: string; tenantId?: string; appId?: string; runId?: string; storageAccountName?: string }
  if (!["oib-deploy", "oib-fix", "oib-undo"].includes(body.action ?? "") || !body.tenantId || !body.appId) return
  const data = await response.json().catch(() => ({})) as {
    runId?: string; reference?: string; backupFolder?: string; pilotGroupId?: string; error?: string
    created?: unknown[]; updated?: unknown[]; failed?: unknown[]; skipped?: unknown[]; results?: { done: boolean }[]
  }
  const undo = body.action === "oib-undo"
  const failed = undo ? (data.results ?? []).filter((r) => !r.done).length : (data.failed?.length ?? 0)
  const ok = response.ok && failed === 0
  const account = accountFor(body.tenantId)
  const action = undo ? "Undo OpenIntuneBaseline run" : body.action === "oib-fix" ? "Reset OpenIntuneBaseline policy drift" : "Deploy OpenIntuneBaseline policies"
  const logEntry: CreateAuditLogInput = {
    eventType: undo ? AuditEventType.POLICY_REVERTED : body.action === "oib-fix" ? AuditEventType.POLICY_RESTORED : AuditEventType.POLICY_CREATED,
    action,
    resource: { type: "policy", id: data.runId ?? body.runId ?? body.tenantId, name: data.reference ?? "OpenIntuneBaseline" },
    result: ok ? AuditResult.SUCCESS : response.ok ? AuditResult.PARTIAL : AuditResult.FAILURE,
    severity: ok ? AuditSeverity.INFO : response.ok ? AuditSeverity.WARNING : AuditSeverity.ERROR,
    details: {
      source: "desktop-oib",
      ...(undo
        ? { undone: (data.results ?? []).filter((r) => r.done).length, notUndone: failed }
        : { created: data.created?.length ?? 0, updated: data.updated?.length ?? 0, skipped: data.skipped?.length ?? 0, failed, backupFolder: data.backupFolder, assignedToPilotGroup: Boolean(data.pilotGroupId) }),
      error: data.error ? { code: "OIB_FAILED", message: data.error } : undefined,
    },
  }
  const logged = await dispatch(new Request(`${INTERNAL_API_ORIGIN}/api/audit/log`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      tenantId: body.tenantId, appId: body.appId, clientSecret: DELEGATED_CLIENT_SECRET,
      storageAccountName: body.storageAccountName ?? localStorageAccountName(body.tenantId),
      user: { id: account?.username ?? "unknown", email: account?.username ?? "unknown", name: account?.name ?? "Unknown user" }, logEntry,
    }),
  }))
  if (!logged.ok) throw new Error(`Audit write failed (${logged.status})`)
}
