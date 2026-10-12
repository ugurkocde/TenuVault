import { allows, PlanRequired, type Plan } from "../../shared/plans"
import { featureRouteFeatures, type FeatureRoutePath } from "../../shared/feature-routes"
import { isGuid } from "../../shared/security"
import type { RouteModule } from "../api/host"
import type { NextRequest } from "../api/next-server-shim"
import type { FeatureDeps } from "./deps"
import { TenantWriteConflict } from "./write-lock"

/** An error with the HTTP status the route answers with. */
export class FeatureError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = "FeatureError"
  }
}

export type Body = Record<string, unknown>

export interface ActionContext {
  tenantId: string
  body: Body
  plan: Plan
  deps: FeatureDeps
  /** Other tenants a portfolio action reads, each already checked for its plan. */
  targetTenants: string[]
  /** The signed-in admin, for record attribution. */
  actor: string | null
}

export type ActionHandler = (context: ActionContext) => Promise<unknown> | unknown

/**
 * One roadmap route: `POST { tenantId, action, ... }` dispatched to a handler per action.
 *
 * planGuard already checked the plan; this checks it again with the tenant's actual
 * entitlement, so a direct call or a guard bypass never reaches a paid handler. Portfolio
 * actions name their other tenants in `targetTenants`; each must be connected and licensed
 * for the same features, and handlers only read those tenants.
 */
export function featureRoute(path: FeatureRoutePath, deps: FeatureDeps, handlers: Record<string, ActionHandler>): Record<string, RouteModule> {
  return {
    [path]: {
      POST: async (request: NextRequest) => {
        const body = (await request.json().catch(() => null)) as Body | null
        if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid request" }, { status: 400 })
        const { tenantId, action } = body
        if (!isGuid(tenantId)) return Response.json({ error: "Select a tenant first." }, { status: 400 })
        if (typeof action !== "string" || !Object.prototype.hasOwnProperty.call(handlers, action)) {
          return Response.json({ error: "Unknown action" }, { status: 400 })
        }
        try {
          const features = featureRouteFeatures(path, action)
          const plan = await deps.plan(tenantId)
          const missing = features.find((feature) => !allows(plan, feature))
          if (missing) throw new PlanRequired(missing)
          const targetTenants = await checkTargets(deps, tenantId, body.targetTenants, features)
          const result = await handlers[action]!({
            tenantId: tenantId.toLowerCase(),
            body,
            plan,
            deps,
            targetTenants,
            actor: deps.actor(tenantId)?.name ?? null,
          })
          return Response.json(result ?? { ok: true })
        } catch (error) {
          if (error instanceof PlanRequired) return Response.json({ error: error.message, upgrade: error.feature }, { status: 402 })
          if (error instanceof FeatureError || error instanceof TenantWriteConflict) return Response.json({ error: error.message }, { status: error.status })
          throw error
        }
      },
    },
  }
}

async function checkTargets(deps: FeatureDeps, tenantId: string, value: unknown, features: ReturnType<typeof featureRouteFeatures>): Promise<string[]> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 500) throw new FeatureError("Invalid target tenants")
  const connected = new Set(deps.tenants().map((id) => id.toLowerCase()))
  const targets: string[] = []
  for (const entry of value) {
    const id = (entry as { tenantId?: unknown })?.tenantId
    if (!isGuid(id)) throw new FeatureError("Invalid target tenant")
    const lower = id.toLowerCase()
    if (lower === tenantId.toLowerCase() || targets.includes(lower)) continue
    if (!connected.has(lower)) throw new FeatureError("A target tenant is not connected to this app.", 403)
    const plan = await deps.plan(lower)
    const missing = features.find((feature) => !allows(plan, feature))
    if (missing) throw new PlanRequired(missing)
    targets.push(lower)
  }
  return targets
}

/** A required string field, trimmed and bounded. */
export function text(body: Body, key: string, max = 2000): string {
  const value = body[key]
  if (typeof value !== "string" || !value.trim()) throw new FeatureError(`${key} is required`)
  if (value.length > max) throw new FeatureError(`${key} is too long`)
  return value.trim()
}

/** An optional string field, trimmed and bounded. */
export function optionalText(body: Body, key: string, max = 2000): string | null {
  const value = body[key]
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || value.length > max) throw new FeatureError(`${key} is invalid`)
  return value.trim()
}
