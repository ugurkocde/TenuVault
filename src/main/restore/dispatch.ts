import type { GraphCall, RestoreOutcome } from "../../portal/lib/policies/graph-restore"
import type { Item } from "../../shared/intune/registry"
import type { RestoreOrigin } from "../../shared/intune/restore-guards"

export interface IdentityRestoreRequest { path: string; snapshot: Item; origin: RestoreOrigin; runId?: string }
const tenants = new WeakMap<GraphCall, string>()
let handler: ((tenant: string, request: IdentityRestoreRequest) => Promise<RestoreOutcome>) | undefined
/** Only main-process callers can bind an authenticated Graph connection to this dispatch. */
export function bindRestoreConnection(graph: GraphCall, tenant?: string): GraphCall {
  if (tenant) tenants.set(graph, tenant)
  return graph
}
export function setIdentityRestoreDispatch(value: NonNullable<typeof handler>): void { handler = value }
export async function dispatchIdentityRestore(graph: GraphCall, request: IdentityRestoreRequest): Promise<RestoreOutcome> {
  const tenant = tenants.get(graph)
  if (!tenant || !handler) return { success: false, path: request.path, retryable: false, error: "A signed-in desktop connection and reviewed restore preview are required." }
  return handler(tenant, request)
}

import type { IdentityRestoreService } from "./service"
let previews: Pick<IdentityRestoreService, "prepare" | "review" | "confirm"> | undefined
export function setIdentityRestorePreviews(service: NonNullable<typeof previews>): void { previews = service }
/** Receives a snapshot read from the owned backup by the route, never a renderer payload. */
export async function previewIdentityRestore(graph: GraphCall, request: IdentityRestoreRequest, operation: "create" | "update", allowRemoval = false) {
  const tenant = tenants.get(graph)
  if (!tenant || !previews) throw new Error("A signed-in desktop connection is required.")
  const run = await previews.prepare(tenant, request, operation, operation === "update" ? String(request.snapshot.id) : undefined, allowRemoval)
  return { runId: run.id, ...await previews.review(tenant, run.id) }
}
export async function confirmIdentityRestore(graph: GraphCall, request: IdentityRestoreRequest, fingerprint: string) {
  const tenant = tenants.get(graph)
  if (!tenant || !previews || !request.runId) throw new Error("Review this restore first.")
  await previews.confirm(tenant, request.runId, fingerprint)
  return dispatchIdentityRestore(graph, request)
}
