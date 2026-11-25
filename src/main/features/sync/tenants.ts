import { allows, PlanRequired } from "../../../shared/plans"
import { isGuid } from "../../../shared/security"
import type { FeatureDeps } from "../deps"
import { FeatureError } from "../route"

/** Most target tenants of one Sync run. */
export const MAX_SYNC_TARGETS = 25

/** The tenant IDs a request names in `targetTenants: [{ tenantId }]`, as sent, for requireSyncTenants. */
export function targetIds(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new FeatureError("Choose at least one target tenant.")
  return value.map((entry) => (entry as { tenantId?: unknown } | null)?.tenantId)
}

/**
 * Every tenant of a Sync action needs a plan with Sync. A single target can pair with any
 * entitled Pro or MSP source, including trials. A run with multiple targets needs MSP on
 * every involved tenant.
 * Checked on every gated action, also when a run's target is acted on alone.
 */
export async function requireSyncTenants(deps: FeatureDeps, sourceTenantId: unknown, targetTenantIds: unknown[]): Promise<{ source: string; targets: string[] }> {
  if (!isGuid(sourceTenantId)) throw new FeatureError("Choose the source tenant.")
  const source = sourceTenantId.toLowerCase()
  if (!targetTenantIds.length) throw new FeatureError("Choose at least one target tenant.")
  if (targetTenantIds.length > MAX_SYNC_TARGETS) throw new FeatureError(`Choose at most ${MAX_SYNC_TARGETS} target tenants.`)
  const targets: string[] = []
  for (const id of targetTenantIds) {
    if (!isGuid(id)) throw new FeatureError("Invalid target tenant")
    const lower = id.toLowerCase()
    if (lower === source) throw new FeatureError("A target tenant must differ from the source tenant.")
    if (targets.includes(lower)) throw new FeatureError("A target tenant is selected twice.")
    targets.push(lower)
  }
  const connected = new Set(deps.tenants().map((id) => id.toLowerCase()))
  if (!targets.every((id) => connected.has(id))) throw new FeatureError("A target tenant is not connected to this app.", 403)
  const plans = await Promise.all([source, ...targets].map((id) => deps.plan(id)))
  if (plans.some((plan) => !allows(plan, "sync"))) throw new PlanRequired("sync")
  if (targets.length === 1) {
    if (!deps.proPair(source, targets[0]!)) throw new PlanRequired("sync")
  } else if (!plans.every((plan) => allows(plan, "bulkActions"))) {
    throw new PlanRequired("bulkActions")
  }
  return { source, targets }
}
