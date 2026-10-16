import type { BackupEngine, BackupJob } from "../backup/engine"
import { normalizeScope, type BackupScope } from "../../shared/intune/scope"
import type { RouteModule } from "./host"
import type { NextRequest } from "./next-server-shim"

interface BackupBody {
  tenantId?: string
  appId?: string
  storageAccountName?: string
  jobId?: string
  scope?: BackupScope
  /** Bulk runs name every other tenant they touch; the plan guard checks each one. This route still starts one job. */
  bulk?: boolean
  targetTenants?: Array<{ tenantId?: string }>
}

/**
 * Backups run in the app with the signed-in admin's token:
 *   POST /api/backup/start   { tenantId, appId, storageAccountName, scope? } -> { jobId }
 *   POST /api/backup/status  { jobId } -> progress in the shape the progress UI expects
 *
 * Without a scope, the tenant's saved scope applies.
 */
export function backupRoutes(engine: BackupEngine, scopeFor: (tenantId: string) => BackupScope = () => ({ excluded: [] })): Record<string, RouteModule> {
  return {
    "/api/backup/start": {
      POST: async (request: NextRequest) => {
        const body = (await request.json().catch(() => ({}))) as BackupBody
        if (!body.tenantId || !body.appId || !body.storageAccountName) {
          return Response.json({ error: "Choose where to store backups for this tenant first." }, { status: 400 })
        }
        const scope = body.scope ? normalizeScope(body.scope) : scopeFor(body.tenantId)
        const job = engine.start({ tenantId: body.tenantId, clientId: body.appId, storageAccountName: body.storageAccountName, scope, trigger: "manual" })
        return Response.json({ success: true, jobId: job.id, status: job.status, message: "Backup started" })
      },
    },
    "/api/backup/status": {
      POST: async (request: NextRequest) => {
        const body = (await request.json().catch(() => ({}))) as BackupBody
        const job = body.jobId ? engine.get(body.jobId) : undefined
        if (!job) return Response.json({ error: "This backup job is no longer available." }, { status: 404 })
        return Response.json(jobStatus(job))
      },
    },
  }
}

/** Job progress as the backup progress UI expects it. */
export function jobStatus(job: BackupJob) {
  return {
    success: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    startTime: job.startTime,
    endTime: job.endTime,
    exception: job.exception,
    backupFolder: job.backupFolder,
    output: job.log.join("\n"),
    // A stopped job keeps finishing (recording itself as failed) until its end time is set.
    isComplete: job.status !== "Running" && job.endTime !== undefined,
    isSuccessful: job.status === "Completed",
  }
}

/**
 * The shared routes report token failures as "Failed to authenticate with Azure" and put
 * the identity platform's response in `details`. Surface the actual reason (for example
 * that the admin must sign in again) as the error message the pages display.
 */
export async function surfaceTokenErrors(response: Response): Promise<Response> {
  if (response.status !== 401 && response.status !== 403) return response
  if (!response.headers.get("content-type")?.includes("json")) return response
  const body = (await response.clone().json().catch(() => null)) as { error?: string; details?: unknown } | null
  if (!body || typeof body.details !== "string") return response
  const description = (() => {
    try {
      return (JSON.parse(body.details) as { error_description?: string }).error_description
    } catch {
      return undefined
    }
  })()
  if (!description) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return Response.json({ ...body, error: description }, { status: response.status, headers })
}
