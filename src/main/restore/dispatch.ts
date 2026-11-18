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
