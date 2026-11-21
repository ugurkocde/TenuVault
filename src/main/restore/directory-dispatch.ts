import type { DirectoryRestoreService, DirectoryOptions } from "./directory-service"
import type { IdentityRestoreRequest } from "./dispatch"
let service: DirectoryRestoreService | undefined
export function setDirectoryRestoreService(value: DirectoryRestoreService) { service = value }
export function directoryRestoreOperation<T>(tenant: string, id: string, work: (signal: AbortSignal) => Promise<T>) {
  if (!service) throw new Error("A signed-in desktop connection is required.")
  return service.operation(tenant, id, work)
}
export async function directoryRestoreRequest(tenant: string, request: IdentityRestoreRequest, body: { action: string; options: DirectoryOptions; fingerprint?: string; approvals?: Record<string, string[]> }, read: (path: string) => Promise<unknown>, signal?: AbortSignal) {
  if (!service) throw new Error("A signed-in desktop connection is required.")
  if (body.action === "preview") return service.prepare(tenant, request, body.options, read)
  if (!request.runId) throw new Error("Review this directory object first.")
  if (body.action === "reconcile" || body.action === "discard") return service.saved(tenant, request.runId, body.action)
  if (body.action === "resume") return service.resume(tenant, request)
  if (body.action === "cancel") return service.cancel(tenant, request.runId)
  if (body.action !== "restore" || typeof body.fingerprint !== "string" || !body.approvals || Object.values(body.approvals).some(value => !Array.isArray(value) || value.some(kind => typeof kind !== "string"))) throw new Error("Approve each directory row separately.")
  return service.execute(tenant, request, body.fingerprint, body.approvals, signal)
}
